use super::agent::Principal;
use super::{
    conflict, event, now,
    storage::{self, View},
};
use crate::{
    error::AppError,
    features::review::{anchor, model::*, store},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use similar::{ChangeTag, DiffTag, TextDiff};
use std::path::Path;

#[derive(Debug)]
struct Edit {
    start: usize,
    end: usize,
    new_start: usize,
    new_end: usize,
}

fn edits(old: &str, new: &str) -> Vec<Edit> {
    // Inbound proposals may rewrite an entire document. Bound diff search so
    // revocation is not trapped behind an adversarial quadratic alignment;
    // similar falls back to coarser, still lossless replacement operations.
    let diff = TextDiff::configure()
        .timeout(std::time::Duration::from_millis(250))
        .diff_chars(old, new);
    let old_chars: Vec<usize> = old
        .char_indices()
        .map(|(i, _)| i)
        .chain([old.len()])
        .collect();
    let new_chars: Vec<usize> = new
        .char_indices()
        .map(|(i, _)| i)
        .chain([new.len()])
        .collect();
    let mut result: Vec<Edit> = Vec::new();
    for op in diff.ops() {
        let (tag, a, b) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        let e = Edit {
            start: old_chars[a.start],
            end: old_chars[a.end],
            new_start: new_chars[b.start],
            new_end: new_chars[b.end],
        };
        if let Some(prev) = result
            .last_mut()
            .filter(|p| p.end == e.start && p.new_end == e.new_start)
        {
            prev.end = e.end;
            prev.new_end = e.new_end;
        } else {
            result.push(e);
        }
    }
    result
}

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, AppError> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::message(format!("missing {key}")))
}
fn optional<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn proposal(
    conn: &Connection,
    base: &str,
    target: &str,
    actor: &str,
    agent: Option<&str>,
    status: &str,
) -> Result<String, AppError> {
    let id = new_id("proposal");
    conn.execute(
        "INSERT INTO proposals VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, base, target, actor, agent, status, now()],
    )?;
    let old = storage::body(conn, base)?;
    let new = storage::body(conn, target)?;
    for e in edits(&old, &new) {
        conn.execute(
            "INSERT INTO suggestions VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                new_id("suggestion"),
                id,
                e.start as i64,
                e.end as i64,
                &old[e.start..e.end],
                &new[e.new_start..e.new_end]
            ],
        )?;
    }
    Ok(id)
}

pub(super) fn comparison(
    conn: &Connection,
    baseline: &str,
    head: &str,
) -> Result<String, AppError> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT proposal FROM comparisons WHERE baseline=?1 AND head=?2",
            params![baseline, head],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = proposal(conn, baseline, head, "comparison", None, "applied")?;
    conn.execute(
        "INSERT INTO comparisons VALUES (?1,?2,?3)",
        params![baseline, head, id],
    )?;
    Ok(id)
}

fn reanchor(view: &mut View, old: &str) {
    let a = anchor::Source::parse(old);
    let b = anchor::Source::parse(&view.manuscript);
    for c in &mut view.state.comments {
        if c.source == CommentSource::Pdf || c.status == CommentStatus::Deleted {
            continue;
        }
        if let Some((quote, prefix, suffix)) =
            anchor::follow_rewrite(&a, &b, &c.quote, &c.prefix, &c.suffix)
        {
            c.quote = quote;
            c.prefix = prefix;
            c.suffix = suffix;
        }
        c.anchor = anchor::locate_in(&b, c.block_id.as_deref(), &c.quote, &c.prefix, &c.suffix);
    }
}

fn set_head(
    conn: &Connection,
    view: &mut View,
    target: &str,
    actor: &str,
    agent: Option<&str>,
) -> Result<(), AppError> {
    let old = std::mem::replace(&mut view.manuscript, storage::body(conn, target)?);
    view.head_id = target.into();
    for span in edits(&old, &view.manuscript) {
        let mut e = event("edit");
        e.actor = actor.into();
        e.agent = agent.map(str::to_owned);
        e.before = Some(old[span.start..span.end].into());
        e.after = Some(view.manuscript[span.new_start..span.new_end].into());
        e.prefix = Some(
            view.manuscript[..span.new_start]
                .chars()
                .rev()
                .take(24)
                .collect::<String>()
                .chars()
                .rev()
                .collect(),
        );
        e.suffix = Some(view.manuscript[span.new_end..].chars().take(24).collect());
        e.revision_id = Some(target.into());
        storage::append(conn, view, e)?;
    }
    reanchor(view, &old);
    view.state.manuscript_hash = Some(store::sha256_hex(&view.manuscript));
    Ok(())
}

fn require_stamp(v: &View, request: &Value) -> Result<(), AppError> {
    if optional(request, "expectedStamp") != Some(v.stamp.as_str()) {
        return Err(conflict());
    }
    Ok(())
}

/// Validate a contiguous selection of the authoritative baseline->head diff.
/// It may contain several character runs (a word replacement), but cannot
/// invent content, move text, or silently include a change from another head.
fn validate_selection(old: &str, new: &str, requested: &str) -> Result<Value, AppError> {
    if requested == old {
        return Err(AppError::message("empty revision decision"));
    }
    let prefix = old
        .chars()
        .zip(requested.chars())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum::<usize>();
    let suffix = old[prefix..]
        .chars()
        .rev()
        .zip(requested[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum::<usize>();
    let end = old.len() - suffix;
    let replacement = &requested[prefix..requested.len() - suffix];
    // A valid partial resolution lies on a shortest insert/delete path from
    // old to new. This admits alternate alignments of repeated text/newlines
    // (a single arbitrary LCS would reject legitimate word-level decisions),
    // but never admits fabricated content or extra edits off that path.
    let valid = requested == new
        || [false, true].into_iter().any(|words| {
            let distance = |a: &str, b: &str| {
                let diff = if words {
                    TextDiff::from_words(a, b)
                } else {
                    TextDiff::from_chars(a, b)
                };
                diff.iter_all_changes()
                    .filter(|c| c.tag() != ChangeTag::Equal)
                    .map(|c| c.value().chars().count())
                    .sum::<usize>()
            };
            distance(old, requested) + distance(requested, new) == distance(old, new)
        });
    if !valid {
        return Err(AppError::domain(
            "invalid_decision",
            "Decision is not a selection of the current revisions",
        ));
    }
    Ok(json!({"start":prefix,"end":end,"before":&old[prefix..end],"after":replacement}))
}

fn decide(conn: &Connection, v: &mut View, r: &Value) -> Result<(), AppError> {
    require_stamp(v, r)?;
    let kind = text(r, "reason")?;
    let baseline = text(r, "nextBaseline")?;
    let manuscript = optional(r, "nextManuscript")
        .unwrap_or(&v.manuscript)
        .to_owned();
    let old_head = v.head_id.clone();
    let old_baseline = v.state.baseline_id.clone();
    let mut selection = match kind {
        "accept-change" if manuscript == v.manuscript => {
            validate_selection(&v.state.baseline_text, &v.manuscript, baseline)?
        }
        "reject-change" if baseline == v.state.baseline_text => {
            validate_selection(&v.manuscript, &v.state.baseline_text, &manuscript)?
        }
        "accept-all" if baseline == v.manuscript && manuscript == v.manuscript => {
            json!({"all":true})
        }
        "reject-all"
            if baseline == v.state.baseline_text && manuscript == v.state.baseline_text =>
        {
            json!({"all":true})
        }
        _ => {
            return Err(AppError::domain(
                "invalid_decision",
                "Invalid review decision",
            ))
        }
    };
    if let Some(ids) = r.get("suggestionIds") {
        selection["suggestionIds"] = ids.clone();
    }
    // A decision is itself an immutable, version-bound proposal/selection.
    let proposal_id = comparison(conn, &old_baseline, &old_head)?;
    if baseline != v.state.baseline_text {
        let next = storage::revision(conn, baseline, Some(&old_baseline), kind)?;
        v.state.baseline_id = next;
        v.state.baseline_text = baseline.into();
    }
    if manuscript != v.manuscript {
        let next = storage::revision(conn, &manuscript, Some(&old_head), kind)?;
        // Rejecting does not generate fresh authored suggestions.
        let old = std::mem::replace(&mut v.manuscript, manuscript);
        v.head_id = next;
        reanchor(v, &old);
    }
    let mut e = event("decision");
    e.reason = Some(kind.into());
    e.revision_id = Some(v.state.baseline_id.clone());
    storage::append(conn, v, e)?;
    let decision_id = new_id("decision");
    conn.execute(
        "INSERT INTO decisions VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            decision_id,
            proposal_id,
            old_head,
            old_baseline,
            v.head_id,
            v.state.baseline_id,
            kind,
            v.sequence,
            selection.to_string()
        ],
    )?;
    v.command_result = Some(json!({"decisionId":decision_id,"comparisonId":proposal_id}));
    if kind == "accept-all" {
        conn.execute("UPDATE document SET round_start=?1", [v.sequence])?;
    }
    Ok(())
}

fn resolve_suggestions(conn: &Connection, v: &mut View, r: &Value) -> Result<(), AppError> {
    require_stamp(v, r)?;
    let comparison_id = text(r, "comparisonId")?;
    let (base, head): (String, String) = conn.query_row(
        "SELECT baseline,head FROM comparisons WHERE proposal=?1",
        [comparison_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if base != v.state.baseline_id || head != v.head_id {
        return Err(conflict());
    }
    let selected: Vec<String> = serde_json::from_value(
        r.get("suggestionIds")
            .cloned()
            .ok_or_else(|| AppError::message("suggestion ids required"))?,
    )?;
    if selected.is_empty()
        || selected
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != selected.len()
    {
        return Err(AppError::message("unique suggestion ids required"));
    }
    let accept = match text(r, "action")? {
        "accept" => true,
        "reject" => false,
        _ => return Err(AppError::message("invalid suggestion action")),
    };
    let all=conn.prepare("SELECT id,start,end,before_text,after_text FROM suggestions WHERE proposal=?1 ORDER BY rowid")?
        .query_map([comparison_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,usize>(1)?,r.get::<_,usize>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?.collect::<Result<Vec<_>,_>>()?;
    let mut delta = 0isize;
    let mut patches = Vec::new();
    for (id, start, end, before, after) in all {
        let new_start = (start as isize + delta) as usize;
        if selected.contains(&id) {
            patches.push(if accept {
                (start, end, before.clone(), after.clone())
            } else {
                (
                    new_start,
                    new_start + after.len(),
                    after.clone(),
                    before.clone(),
                )
            });
        }
        delta += after.len() as isize - before.len() as isize;
    }
    if patches.len() != selected.len() {
        return Err(AppError::message("suggestion not in current comparison"));
    }
    let mut next = if accept {
        v.state.baseline_text.clone()
    } else {
        v.manuscript.clone()
    };
    for (start, end, before, after) in patches.into_iter().rev() {
        if next.get(start..end) != Some(before.as_str()) {
            return Err(conflict());
        }
        next.replace_range(start..end, &after);
    }
    decide(
        conn,
        v,
        &json!({"expectedStamp":v.stamp,"reason":if accept {"accept-change"}else{"reject-change"},"nextBaseline":if accept {next.clone()}else{v.state.baseline_text.clone()},"nextManuscript":if accept {v.manuscript.clone()}else{next},"suggestionIds":selected}),
    )
}

fn comments(
    conn: &Connection,
    v: &mut View,
    r: &Value,
    principal: &Principal,
) -> Result<(), AppError> {
    let mut e = event("comment-created");
    e.actor = principal.actor().into();
    e.agent = principal.label().map(str::to_owned);
    if text(r, "kind")? == "comment-add" {
        if optional(r, "expectedHead") != Some(v.head_id.as_str()) {
            return Err(conflict());
        }
        let input: ReviewCommentInput = serde_json::from_value(
            r.get("input")
                .cloned()
                .ok_or_else(|| AppError::message("missing input"))?,
        )?;
        if input.body.trim().is_empty() || input.quote.trim().is_empty() {
            return Err(AppError::message("comment and quote must not be empty"));
        }
        if input.source == CommentSource::Pdf
            && (!v.state.has_pdf || input.page.is_none_or(|p| p == 0))
        {
            return Err(AppError::message("invalid PDF comment page"));
        }
        let id = new_id("thread");
        let stamp = now();
        let status = if input.source == CommentSource::Pdf {
            AnchorStatus::Attached
        } else {
            anchor::locate_in(
                &anchor::Source::parse(&v.manuscript),
                input.block_id.as_deref(),
                &input.quote,
                &input.prefix,
                &input.suffix,
            )
        };
        v.state.comments.push(ReviewComment {
            id: id.clone(),
            block_id: input.block_id,
            quote: input.quote,
            source: input.source,
            page: input.page,
            prefix: input.prefix,
            suffix: input.suffix,
            heading: input.heading,
            body: input.body.trim().into(),
            actor: principal.actor().into(),
            agent: principal.label().map(str::to_owned),
            edited_by: None,
            status: CommentStatus::Open,
            anchor: status,
            created_at: stamp.clone(),
            updated_at: stamp,
            replies: vec![],
        });
        principal.assign(conn, &id)?;
        v.command_result = Some(json!({"commentId":id}));
        e.comment_id = Some(id);
        e.after = Some(serde_json::to_string(
            v.state.comments.last().expect("inserted thread"),
        )?);
    } else {
        let id = text(r, "commentId")?;
        let c = v
            .state
            .comments
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::message("comment not found"))?;
        e.before = Some(serde_json::to_string(c)?);
        if matches!(principal, Principal::Reviewer(_)) && c.status != CommentStatus::Open {
            return Err(AppError::domain(
                "thread_closed",
                "This thread is closed; re-read its status before continuing",
            ));
        }
        let action = text(r, "action")?;
        if action != "reply" && optional(r, "expectedUpdatedAt") != Some(c.updated_at.as_str()) {
            return Err(AppError::domain(
                "stale_comment",
                "Comment changed; reload before editing",
            ));
        }
        let body = || {
            text(r, "body").and_then(|s| {
                if s.trim().is_empty() {
                    Err(AppError::message("empty comment"))
                } else {
                    Ok(s.trim())
                }
            })
        };
        if let Some(reply_id) = optional(r, "replyId") {
            if c.status == CommentStatus::Deleted {
                return Err(AppError::message("restore the thread first"));
            }
            let index = c
                .replies
                .iter()
                .position(|x| x.id == reply_id)
                .ok_or_else(|| AppError::message("reply not found"))?;
            let own =
                principal.owns(conn, reply_id)? && c.replies[index].actor == principal.actor();
            match action {
                "edit" if own => {
                    c.replies[index].body = body()?.into();
                    c.replies[index].edited_at = Some(now());
                }
                "delete" if own || matches!(principal, Principal::Author) => {
                    c.replies.remove(index);
                }
                _ => return Err(AppError::message("invalid reply action")),
            }
            e.kind = format!("reply-{action}");
            e.reply_id = Some(reply_id.into());
        } else {
            if matches!(principal, Principal::Reviewer(_))
                && action != "reply"
                && (!principal.owns(conn, id)? || !["edit", "delete"].contains(&action))
            {
                return Err(AppError::domain(
                    "reviewer_forbidden",
                    "Reply to this thread; only its owner may edit or delete it",
                ));
            }
            match action {
                "reply" if c.status != CommentStatus::Deleted => {
                    let reply_id = new_id("reply");
                    principal.assign(conn, &reply_id)?;
                    v.command_result = Some(json!({"commentId":id,"replyId":reply_id}));
                    c.replies.push(CommentReply {
                        id: reply_id,
                        body: body()?.into(),
                        created_at: now(),
                        actor: principal.actor().into(),
                        agent: principal.label().map(str::to_owned),
                        edited_at: None,
                    });
                }
                "edit" => {
                    c.body = body()?.into();
                    c.edited_by = (c.actor != principal.actor()).then(|| principal.actor().into());
                }
                "resolve" => c.status = CommentStatus::Resolved,
                "reopen" | "restore" => c.status = CommentStatus::Open,
                "delete" => c.status = CommentStatus::Deleted,
                _ => return Err(AppError::message("invalid comment action")),
            }
            e.kind = format!("comment-{action}");
        }
        // Strictly monotonic even for consecutive mutations in one millisecond.
        let prev = chrono::DateTime::parse_from_rfc3339(&c.updated_at)
            .ok()
            .map(|t| t.timestamp_millis())
            .unwrap_or(0);
        let millis = chrono::Utc::now().timestamp_millis().max(prev + 1);
        c.updated_at = chrono::DateTime::from_timestamp_millis(millis)
            .expect("valid current time")
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        e.comment_id = Some(id.into());
        e.after = Some(serde_json::to_string(c)?);
    }
    storage::append(conn, v, e)
}

/// The receipt, revision, review decision, thread anchors and sequence commit
/// together. Replaying a command returns its original durable acknowledgement.
pub fn execute(root: &Path, id: &str, command_id: &str, request: Value) -> Result<View, AppError> {
    execute_inner(root, id, command_id, request, None)
}

pub fn execute_as_agent(
    root: &Path,
    id: &str,
    reviewer_id: &str,
    command_id: &str,
    request: Value,
) -> Result<View, AppError> {
    if !["propose", "comment-add", "comment-update"].contains(&text(&request, "kind")?) {
        return Err(AppError::domain("reviewer_forbidden","AI may propose changes and participate in threads, but cannot change the manuscript or resolve revisions"));
    }
    execute_inner(root, id, command_id, request, Some(reviewer_id))
}

fn execute_inner(
    root: &Path,
    id: &str,
    command_id: &str,
    request: Value,
    reviewer_id: Option<&str>,
) -> Result<View, AppError> {
    if command_id.is_empty() || command_id.len() > 200 {
        return Err(AppError::message("command id required"));
    }
    let hash = store::sha256_hex(
        &reviewer_id.map_or_else(|| request.to_string(), |id| format!("{id}\n{request}")),
    );
    let mut conn = storage::connect(root, id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let principal = match reviewer_id {
        Some(id) => super::agent::load(&tx, id)?,
        None => Principal::Author,
    };
    let receipt: Option<(String, String)> = tx
        .query_row(
            "SELECT request_hash,response FROM receipts WHERE command_id=?1",
            [command_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((old, response)) = receipt {
        if old != hash {
            return Err(AppError::domain(
                "command_reused",
                "Command id reused with different content",
            ));
        }
        let receipt: Value = serde_json::from_str(&response)?;
        let mut current = storage::load(&tx)?;
        current.acknowledged_sequence = receipt["sequence"]
            .as_i64()
            .ok_or_else(|| AppError::message("invalid command receipt"))?;
        current.acknowledged_head = receipt["head"]
            .as_str()
            .ok_or_else(|| AppError::message("invalid command receipt"))?
            .into();
        current.command_result = receipt.get("result").cloned().filter(|v| !v.is_null());
        tx.commit()?;
        return Ok(current);
    }
    let mut v = storage::load(&tx)?;
    match text(&request, "kind")? {
        "save" => {
            if optional(&request, "expectedHead") != Some(v.head_id.as_str())
                || text(&request, "lastSaved")? != v.manuscript
            {
                return Err(conflict());
            }
            let next = text(&request, "markdown")?;
            if next != v.manuscript {
                let target = storage::revision(&tx, next, Some(&v.head_id), "author-save")?;
                proposal(&tx, &v.head_id, &target, "author", None, "applied")?;
                set_head(&tx, &mut v, &target, "author", None)?;
            }
            if let Some(anchors) = request.get("anchors").filter(|v| !v.is_null()) {
                let previous = serde_json::to_string(&v.state.comments)?;
                let anchors: Vec<CommentAnchor> = serde_json::from_value(anchors.clone())?;
                for a in anchors {
                    if let Some(c) = v.state.comments.iter_mut().find(|c| {
                        c.id == a.comment_id
                            && c.source == CommentSource::Manuscript
                            && c.status != CommentStatus::Deleted
                    }) {
                        if !a.quote.trim().is_empty() {
                            c.quote = a.quote;
                            c.prefix = a.prefix;
                            c.suffix = a.suffix;
                            c.anchor = anchor::locate_in(
                                &anchor::Source::parse(&v.manuscript),
                                c.block_id.as_deref(),
                                &c.quote,
                                &c.prefix,
                                &c.suffix,
                            );
                        }
                    }
                }
                if previous != serde_json::to_string(&v.state.comments)? {
                    storage::append(&tx, &mut v, event("anchors-moved"))?;
                }
            }
        }
        "decide" => decide(&tx, &mut v, &request)?,
        "resolve-suggestions" => resolve_suggestions(&tx, &mut v, &request)?,
        "propose" => {
            let base = text(&request, "baseRevision")?;
            if storage::body(&tx, base)? == text(&request, "markdown")? {
                return Err(AppError::domain(
                    "empty_proposal",
                    "Proposal must change the base revision",
                ));
            }
            // May deliberately target an older immutable revision. It is not applied.
            let target =
                storage::revision(&tx, text(&request, "markdown")?, Some(base), "proposal")?;
            let agent = principal.label().or_else(|| optional(&request, "agent"));
            let p = proposal(&tx, base, &target, "agent", agent, "pending")?;
            principal.assign(&tx, &p)?;
            v.command_result = Some(json!({"proposalId":p}));
            let mut e = event("proposal-created");
            e.actor = "agent".into();
            e.agent = agent.map(str::to_owned);
            e.revision_id = Some(target);
            storage::append(&tx, &mut v, e)?;
        }
        "apply-proposal" | "dismiss-proposal" => {
            require_stamp(&v, &request)?;
            let p = text(&request, "proposalId")?;
            let (base, target, status, agent): (String, String, String, Option<String>) = tx
                .query_row(
                    "SELECT base,target,status,agent FROM proposals WHERE id=?1",
                    [p],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
            if status != "pending" {
                return Err(AppError::message("proposal already resolved"));
            }
            let apply = text(&request, "kind")? == "apply-proposal";
            if apply {
                if base != v.head_id {
                    return Err(conflict());
                }
                set_head(&tx, &mut v, &target, "agent", agent.as_deref())?;
            }
            tx.execute(
                "UPDATE proposals SET status=?1 WHERE id=?2",
                params![if apply { "applied" } else { "dismissed" }, p],
            )?;
            let mut e = event(if apply {
                "proposal-applied"
            } else {
                "proposal-dismissed"
            });
            e.reason = Some(p.into());
            storage::append(&tx, &mut v, e)?;
        }
        "rename" => {
            require_stamp(&v, &request)?;
            let title = text(&request, "title")?.trim();
            if title.is_empty() {
                return Err(AppError::message("empty title"));
            }
            v.state.title = title.into();
            storage::append(&tx, &mut v, event("renamed"))?;
        }
        "comment-add" | "comment-update" => comments(&tx, &mut v, &request, &principal)?,
        "observe" => {} // No external file edits can silently become authoritative.
        "parsed-pdf" => {
            require_stamp(&v, &request)?;
            let initial = !v.state.body_parsed;
            let target = storage::revision(
                &tx,
                text(&request, "markdown")?,
                Some(&v.head_id),
                "pdf-parse",
            )?;
            set_head(&tx, &mut v, &target, "author", None)?;
            v.state.body_parsed = true;
            if initial {
                v.state.baseline_id = v.head_id.clone();
                v.state.baseline_text = v.manuscript.clone();
            }
            storage::append(&tx, &mut v, event("pdf-parsed"))?;
            if initial {
                tx.execute("UPDATE document SET round_start=?1", [v.sequence])?;
            }
        }
        _ => return Err(AppError::message("unsupported Margin command")),
    }
    storage::persist(&tx, &v)?;
    // Reload inside the transaction so the acknowledgement includes new snapshots.
    let mut result = storage::load(&tx)?;
    result.command_result = v.command_result;
    // Store an O(1) acknowledgement, not another complete copy of the growing
    // document/history after every save. Revisions already preserve the text.
    let receipt =
        json!({"sequence":result.sequence,"head":result.head_id,"result":result.command_result});
    tx.execute(
        "INSERT INTO receipts VALUES (?1,?2,?3)",
        params![command_id, hash, receipt.to_string()],
    )?;
    tx.commit()?;
    Ok(result)
}

pub fn updates(root: &Path, id: &str, after: i64, limit: usize) -> Result<Value, AppError> {
    let mut conn = storage::connect(root, id)?;
    let tx = conn.transaction()?;
    let seq: i64 = tx.query_row("SELECT sequence FROM document", [], |r| r.get(0))?;
    if after < 0 || after > seq {
        return Err(AppError::message("invalid update cursor"));
    }
    let rows = tx
        .prepare(
            "SELECT sequence,payload FROM events WHERE sequence>?1 ORDER BY sequence LIMIT ?2",
        )?
        .query_map(params![after, limit.clamp(1, 200) as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let cursor = rows.last().map_or(after, |r| r.0);
    let events = rows
        .into_iter()
        .map(|(s, p)| Ok(json!({"sequence":s,"event":serde_json::from_str::<Value>(&p)?})))
        .collect::<Result<Vec<_>, AppError>>()?;
    let proposals=tx.prepare("SELECT id,base,target,actor,agent,status FROM proposals WHERE status='pending' ORDER BY rowid")?
        .query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"baseRevision":r.get::<_,String>(1)?,"targetRevision":r.get::<_,String>(2)?,"actor":r.get::<_,String>(3)?,"agent":r.get::<_,Option<String>>(4)?,"status":r.get::<_,String>(5)?})))?.collect::<Result<Vec<_>,_>>()?;
    let (baseline, head): (String, String) =
        tx.query_row("SELECT baseline,head FROM document", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    let comparison: Option<String> = tx
        .query_row(
            "SELECT proposal FROM comparisons WHERE baseline=?1 AND head=?2",
            params![baseline, head],
            |r| r.get(0),
        )
        .optional()?;
    let result = json!({"cursor":cursor,"sequence":seq,"hasMore":cursor<seq,"events":events,"proposals":proposals,"comparisonId":comparison});
    tx.commit()?;
    Ok(result)
}

/// Inspect a proposal without applying it or returning unbounded preview text.
pub fn proposal_detail(root: &Path, id: &str, proposal_id: &str) -> Result<Value, AppError> {
    let mut conn = storage::connect(root, id)?;
    let tx = conn.transaction()?;
    let (base, target, status, agent): (String, String, String, Option<String>) = tx.query_row(
        "SELECT base,target,status,agent FROM proposals WHERE id=?1",
        [proposal_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let (head, seq): (String, i64) =
        tx.query_row("SELECT head,sequence FROM document", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    let old = storage::body(&tx, &base)?;
    let new = storage::body(&tx, &target)?;
    let mut preview = String::new();
    for h in crate::features::review::diff::diff_lines(&old, &new) {
        preview.push_str(&format!("@@ -{} +{} @@\n", h.old_start, h.new_start));
        for line in h.lines {
            preview.push_str(match line.kind.as_str() {
                "add" => "+",
                "del" => "-",
                _ => " ",
            });
            preview.push_str(&line.text);
            preview.push('\n');
            if preview.len() > 64000 {
                break;
            }
        }
        if preview.len() > 64000 {
            break;
        }
    }
    let truncated = preview.chars().count() > 16000;
    let preview = preview.chars().take(16000).collect::<String>();
    let result = json!({"id":proposal_id,"baseRevision":base,"targetRevision":target,"status":status,"agent":agent,"sequence":seq,"baseMatchesHead":base==head,"preview":preview,"truncated":truncated});
    tx.commit()?;
    Ok(result)
}

/// Stable suggestions are paged independently of the visual editor's diff IDs.
pub fn suggestions(
    root: &Path,
    id: &str,
    proposal_id: &str,
    after: usize,
    limit: usize,
) -> Result<Value, AppError> {
    let conn = storage::connect(root, id)?;
    let rows=conn.prepare("SELECT id,start,end,before_text,after_text FROM suggestions WHERE proposal=?1 ORDER BY rowid LIMIT ?2 OFFSET ?3")?
        .query_map(params![proposal_id,limit.clamp(1,200) as i64,after as i64],|r|Ok(json!({"id":r.get::<_,String>(0)?,"start":r.get::<_,i64>(1)?,"end":r.get::<_,i64>(2)?,"before":r.get::<_,String>(3)?,"after":r.get::<_,String>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(json!({"proposalId":proposal_id,"cursor":after+rows.len(),"suggestions":rows}))
}
