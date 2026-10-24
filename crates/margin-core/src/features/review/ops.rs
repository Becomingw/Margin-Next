//! Review operations: comments, edits, checkpoints, export.
//!
//! Every mutation loads `review.json`, applies the change, recomputes anchor
//! statuses against the current manuscript, and writes the state back
//! atomically. Events are appended for every action so the round history is
//! reconstructible without the renderer.

use super::anchor;
use super::diff::{diff_lines, DiffHunk};
use super::model::*;
use super::store;
use crate::error::AppError;
use std::fs;
use std::path::Path;

fn now() -> String {
    crate::time::now_rfc3339_millis()
}

fn event(kind: &str) -> ReviewEvent {
    ReviewEvent {
        id: new_id("e"),
        kind: kind.into(),
        created_at: now(),
        actor: "author".into(),
        agent: None,
        comment_id: None,
        reply_id: None,
        before: None,
        after: None,
        prefix: None,
        suffix: None,
        revision_id: None,
        reason: None,
    }
}

/// Recompute every comment's anchor status against `manuscript`.
/// Returns true when anything changed.
///
/// PDF-anchored comments are skipped: their anchor is a page number, not a
/// span of the manuscript.
pub fn reanchor_all(state: &mut ReviewState, manuscript: &str) -> bool {
    let mut changed = false;
    let source = anchor::Source::parse(manuscript);
    for comment in &mut state.comments {
        if comment.source == CommentSource::Pdf {
            continue;
        }
        let next = anchor::locate_in(
            &source,
            comment.block_id.as_deref(),
            &comment.quote,
            &comment.prefix,
            &comment.suffix,
        );
        if comment.anchor != next {
            comment.anchor = next;
            changed = true;
        }
    }
    changed
}

/// Record a disk change discovered on open or a watcher echo. Older units
/// without a hash establish their first observation without inventing history.
/// If the previous text is unavailable, the event records the change but does
/// not claim to know its exact before/after span.
pub fn reconcile_external_change(
    state: &mut ReviewState,
    manuscript: &str,
    previous: Option<&str>,
) -> bool {
    let hash = store::sha256_hex(manuscript);
    let old_hash = state.manuscript_hash.as_deref();
    let changed = old_hash.is_some_and(|old| old != hash)
        || (old_hash.is_none() && previous.is_some_and(|text| text != manuscript));
    if changed {
        let spans = previous
            .filter(|text| old_hash.is_none_or(|old| store::sha256_hex(text) == old))
            .map(|text| edit_spans(text, manuscript))
            .unwrap_or_default();
        if spans.is_empty() {
            state.events.push(event("external-change"));
        }
        for span in spans {
            let mut e = event("external-change");
            e.before = Some(span.before);
            e.after = Some(span.after);
            e.prefix = Some(span.prefix);
            e.suffix = Some(span.suffix);
            state.events.push(e);
        }
    }
    state.manuscript_hash = Some(hash);
    changed
}

pub fn add_comment(
    vault: &Path,
    id: &str,
    input: &ReviewCommentInput,
) -> Result<ReviewState, AppError> {
    add_comment_as(vault, id, input, "author", None)
}

pub fn add_comment_as(
    vault: &Path,
    id: &str,
    input: &ReviewCommentInput,
    actor: &str,
    agent: Option<&str>,
) -> Result<ReviewState, AppError> {
    if input.quote.trim().is_empty() || input.body.trim().is_empty() {
        return Err(AppError::message("quote and comment are required"));
    }
    if input.source == CommentSource::Pdf {
        match input.page {
            Some(page) if page >= 1 => {}
            _ => {
                return Err(AppError::message(
                    "a PDF comment needs a 1-based page number",
                ))
            }
        }
    }
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let _lock = store::lock_unit(&dir);
    let mut state = store::load_state(&dir)?;
    let stamp = now();
    // PDF comments are anchored to a page, so they stay attached until the
    // comment itself is deleted.
    let mut quote = input.quote.clone();
    let mut prefix = input.prefix.clone();
    let mut suffix = input.suffix.clone();
    let anchor = match input.source {
        CommentSource::Pdf => AnchorStatus::Attached,
        CommentSource::Manuscript => {
            let source = anchor::Source::parse(&store::read_manuscript(&dir)?);
            // Agents quote Markdown source; store the text the editor shows,
            // which is what it highlights.
            if let Some(shown) = anchor::rendered_quote(&source, &quote, &prefix, &suffix) {
                (quote, prefix, suffix) = shown;
            }
            anchor::locate_in(&source, input.block_id.as_deref(), &quote, &prefix, &suffix)
        }
    };
    let comment = ReviewComment {
        id: new_id("c"),
        block_id: input.block_id.clone(),
        quote,
        source: input.source,
        page: input.page,
        prefix,
        suffix,
        heading: input.heading.clone(),
        body: input.body.trim().to_string(),
        actor: actor.to_string(),
        agent: agent.map(str::to_string),
        edited_by: None,
        status: CommentStatus::Open,
        anchor,
        created_at: stamp.clone(),
        updated_at: stamp,
        replies: Vec::new(),
    };
    let mut e = event("comment-created");
    e.actor = actor.to_string();
    e.agent = agent.map(str::to_string);
    e.comment_id = Some(comment.id.clone());
    state.comments.push(comment);
    state.events.push(e);
    store::save_state(&dir, &mut state)?;
    Ok(state)
}

pub fn update_comment(
    vault: &Path,
    id: &str,
    comment_id: &str,
    action: CommentAction,
    body: Option<&str>,
    expected_updated_at: Option<&str>,
) -> Result<ReviewState, AppError> {
    update_comment_as(
        vault,
        id,
        comment_id,
        action,
        body,
        expected_updated_at,
        "author",
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn update_comment_as(
    vault: &Path,
    id: &str,
    comment_id: &str,
    action: CommentAction,
    body: Option<&str>,
    expected_updated_at: Option<&str>,
    actor: &str,
    agent: Option<&str>,
) -> Result<ReviewState, AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let _lock = store::lock_unit(&dir);
    let mut state = store::load_state(&dir)?;
    let comment = state
        .comments
        .iter_mut()
        .find(|c| c.id == comment_id)
        .ok_or_else(|| AppError::message("comment not found"))?;
    // Several Agents can review one manuscript. Each may reply to any
    // comment, but only the Agent that wrote a comment may change it; the
    // author keeps full control in the app.
    if actor == "agent" && action != CommentAction::Reply {
        if let (Some(owner), true) = (comment.agent.as_deref(), comment.actor == "agent") {
            if Some(owner) != agent {
                return Err(AppError::domain(
                    "comment_owned_by_other_agent",
                    format!("This comment was written by {owner}; reply to it instead."),
                ));
            }
        }
    }
    // A reply only appends, so it cannot clobber a concurrent change; other
    // Agents replying in the same thread must not make it stale.
    if let Some(expected) = expected_updated_at.filter(|_| action != CommentAction::Reply) {
        if expected != comment.updated_at {
            return Err(AppError::domain(
                "stale_comment",
                "The comment changed; reload it before editing.",
            ));
        }
    }
    match action {
        CommentAction::Reply => {
            if comment.status == CommentStatus::Deleted {
                return Err(AppError::message("restore the comment before replying"));
            }
            let body = body
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .ok_or_else(|| AppError::message("reply must not be empty"))?;
            comment.replies.push(CommentReply {
                id: new_id("m"),
                body: body.to_string(),
                created_at: now(),
                actor: actor.to_string(),
                agent: agent.map(str::to_string),
                edited_at: None,
            });
        }
        CommentAction::Edit => {
            let body = body
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .ok_or_else(|| AppError::message("comment must not be empty"))?;
            comment.body = body.to_string();
            comment.edited_by = (actor != comment.actor).then(|| actor.to_string());
        }
        CommentAction::Resolve => comment.status = CommentStatus::Resolved,
        CommentAction::Reopen => comment.status = CommentStatus::Open,
        CommentAction::Delete => comment.status = CommentStatus::Deleted,
        CommentAction::Restore => comment.status = CommentStatus::Open,
    }
    comment.updated_at = now();
    let kind = match action {
        CommentAction::Reply => "comment-reply",
        CommentAction::Edit => "comment-edit",
        CommentAction::Resolve => "comment-resolve",
        CommentAction::Reopen => "comment-reopen",
        CommentAction::Delete => "comment-delete",
        CommentAction::Restore => "comment-restore",
    };
    let mut e = event(kind);
    e.actor = actor.to_string();
    e.agent = agent.map(str::to_string);
    e.comment_id = Some(comment_id.to_string());
    state.events.push(e);
    store::save_state(&dir, &mut state)?;
    Ok(state)
}

/// Edit (`Edit`) or delete (`Delete`) one reply. Editing is for its writer
/// only: the author their own replies, each Agent its own (older unnamed
/// Agent replies stay open to any Agent, as comments do). Deleting follows
/// the same rule for Agents, while the author may delete any reply. A deleted
/// reply is removed from the thread; the event keeps only who removed it.
#[allow(clippy::too_many_arguments)]
pub fn update_reply_as(
    vault: &Path,
    id: &str,
    comment_id: &str,
    reply_id: &str,
    action: CommentAction,
    body: Option<&str>,
    actor: &str,
    agent: Option<&str>,
) -> Result<ReviewState, AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let _lock = store::lock_unit(&dir);
    let mut state = store::load_state(&dir)?;
    let comment = state
        .comments
        .iter_mut()
        .find(|c| c.id == comment_id)
        .ok_or_else(|| AppError::message("comment not found"))?;
    if comment.status == CommentStatus::Deleted {
        return Err(AppError::message(
            "restore the comment before changing its replies",
        ));
    }
    let index = comment
        .replies
        .iter()
        .position(|r| r.id == reply_id)
        .ok_or_else(|| AppError::message("reply not found"))?;
    let reply = &mut comment.replies[index];
    let own = reply.actor == actor
        && (actor != "agent" || reply.agent.is_none() || reply.agent.as_deref() == agent);
    let author_deletes = actor == "author" && action == CommentAction::Delete;
    if !own && !author_deletes {
        let writer = reply.agent.as_deref().unwrap_or(&reply.actor).to_string();
        return Err(AppError::domain(
            "reply_owned_by_other",
            format!("This reply was written by {writer}; only its writer can change it."),
        ));
    }
    let mut e = match action {
        CommentAction::Edit => {
            let body = body
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .ok_or_else(|| AppError::message("reply must not be empty"))?;
            let mut e = event("reply-edit");
            e.before = Some(std::mem::replace(&mut reply.body, body.to_string()));
            e.after = Some(body.to_string());
            reply.edited_at = Some(now());
            e
        }
        CommentAction::Delete => {
            comment.replies.remove(index);
            event("reply-delete")
        }
        _ => return Err(AppError::message("a reply can only be edited or deleted")),
    };
    comment.updated_at = now();
    e.actor = actor.to_string();
    e.agent = agent.map(str::to_string);
    e.comment_id = Some(comment_id.to_string());
    e.reply_id = Some(reply_id.to_string());
    state.events.push(e);
    store::save_state(&dir, &mut state)?;
    Ok(state)
}

/// Common prefix/suffix span between two texts, on char boundaries.
/// Returns the differing `(before, after)` slices; `None` when identical.
fn changed_span(before: &str, after: &str) -> Option<(String, String)> {
    if before == after {
        return None;
    }
    let b: Vec<char> = before.chars().collect();
    let a: Vec<char> = after.chars().collect();
    let mut start = 0;
    while start < b.len() && start < a.len() && b[start] == a[start] {
        start += 1;
    }
    let mut end_b = b.len();
    let mut end_a = a.len();
    while end_b > start && end_a > start && b[end_b - 1] == a[end_a - 1] {
        end_b -= 1;
        end_a -= 1;
    }
    Some((
        b[start..end_b].iter().collect(),
        a[start..end_a].iter().collect(),
    ))
}

/// One contiguous change of a save, with the text around it on its line
/// (as an Agent's replacement records it) to find it again.
struct EditSpan {
    before: String,
    after: String,
    prefix: String,
    suffix: String,
}

/// Characters of same-line context kept on each side of an edit.
const EDIT_CONTEXT_CHARS: usize = 24;

/// The separate changes between two versions of a manuscript. One save can
/// touch several places; recorded as one span from the first change to the
/// last, an edit at the top and one at the bottom stored the whole document
/// twice. Lines are matched first (shared start and end directly, the rest
/// by longest common subsequence), then each run of changed lines is trimmed
/// to the characters that differ, as [`changed_span`] does for one change.
fn edit_spans(before: &str, after: &str) -> Vec<EditSpan> {
    if before == after {
        return Vec::new();
    }
    let old: Vec<&str> = before.split_inclusive('\n').collect();
    let new: Vec<&str> = after.split_inclusive('\n').collect();
    let mut head = 0;
    while head < old.len() && head < new.len() && old[head] == new[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < old.len() - head
        && tail < new.len() - head
        && old[old.len() - 1 - tail] == new[new.len() - 1 - tail]
    {
        tail += 1;
    }
    let (old_mid, new_mid) = (&old[head..old.len() - tail], &new[head..new.len() - tail]);
    // Runs of changed lines, as (old range, new range) within the middle.
    let mut runs: Vec<(std::ops::Range<usize>, std::ops::Range<usize>)> = Vec::new();
    if old_mid.len().saturating_mul(new_mid.len()) > 4_000_000 {
        runs.push((0..old_mid.len(), 0..new_mid.len()));
    } else {
        let cols = new_mid.len() + 1;
        let mut table = vec![0u32; (old_mid.len() + 1) * cols];
        for i in (0..old_mid.len()).rev() {
            for j in (0..new_mid.len()).rev() {
                table[i * cols + j] = if old_mid[i] == new_mid[j] {
                    table[(i + 1) * cols + j + 1] + 1
                } else {
                    table[(i + 1) * cols + j].max(table[i * cols + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        let mut run: Option<(usize, usize)> = None;
        while i < old_mid.len() || j < new_mid.len() {
            if i < old_mid.len() && j < new_mid.len() && old_mid[i] == new_mid[j] {
                if let Some((oi, nj)) = run.take() {
                    runs.push((oi..i, nj..j));
                }
                i += 1;
                j += 1;
                continue;
            }
            run.get_or_insert((i, j));
            if j >= new_mid.len()
                || (i < old_mid.len() && table[(i + 1) * cols + j] >= table[i * cols + j + 1])
            {
                i += 1;
            } else {
                j += 1;
            }
        }
        if let Some((oi, nj)) = run {
            runs.push((oi..old_mid.len(), nj..new_mid.len()));
        }
    }
    let new_offset = |line: usize| -> usize { new[..head + line].iter().map(|l| l.len()).sum() };
    runs.into_iter()
        .filter_map(|(o, n)| {
            let old_text = old_mid[o].concat();
            let new_text = new_mid[n.clone()].concat();
            let (removed, added) = changed_span(&old_text, &new_text)?;
            let shared: usize = old_text
                .chars()
                .zip(new_text.chars())
                .take_while(|(a, b)| a == b)
                .map(|(c, _)| c.len_utf8())
                .sum();
            let start = new_offset(n.start) + shared;
            let end = start + added.len();
            let line_start = after[..start].rfind('\n').map_or(0, |i| i + 1);
            let line_end = after[end..].find('\n').map_or(after.len(), |i| end + i);
            let left: Vec<char> = after[line_start..start].chars().collect();
            Some(EditSpan {
                before: removed,
                after: added,
                prefix: left[left.len().saturating_sub(EDIT_CONTEXT_CHARS)..]
                    .iter()
                    .collect(),
                suffix: after[end..line_end]
                    .chars()
                    .take(EDIT_CONTEXT_CHARS)
                    .collect(),
            })
        })
        .collect()
}

/// Record one manuscript save. `prev_text` is the caller's last confirmed
/// manuscript (the Host caches it per unit); `None` seeds the cache without
/// an event (first open).When `kind == "untracked"`, the baseline snapshot is
/// also advanced to the new manuscript (Word behaviour when Track Changes is OFF).
/// Returns `(state, recorded)`.
pub fn record_edit(
    vault: &Path,
    id: &str,
    prev_text: Option<&str>,
    kind: &str,
) -> Result<(ReviewState, bool), AppError> {
    record_edit_with_anchors(vault, id, prev_text, kind, &[])
}

/// [`record_edit`] for an author save that also moved comment ranges: the
/// editor tracks each comment's range through the author's typing, as Word
/// does, so comments whose text was edited stay on it instead of turning
/// outdated. Anchors apply to the author's own edits only.
pub fn record_edit_with_anchors(
    vault: &Path,
    id: &str,
    prev_text: Option<&str>,
    kind: &str,
    anchors: &[CommentAnchor],
) -> Result<(ReviewState, bool), AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let _lock = store::lock_unit(&dir);
    record_edit_in(&dir, prev_text, kind, anchors)
}

/// Save the author's manuscript and record the edit in one step, under the
/// unit's lock: an Agent's replacement cannot land between the write and the
/// record, and a manuscript that changed on disk since `expected` (what the
/// editor last saved or loaded) is not overwritten. `prev_text` is the
/// Host's last confirmed manuscript, as for [`record_edit`].
pub fn save_manuscript(
    vault: &Path,
    id: &str,
    text: &str,
    expected: &str,
    prev_text: Option<&str>,
    anchors: &[CommentAnchor],
) -> Result<(ReviewState, bool), AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let _lock = store::lock_unit(&dir);
    let path = store::manuscript_path(&dir);
    // The editor's copy was decoded without a byte-order mark.
    let changed = fs::read_to_string(&path)
        .is_ok_and(|disk| disk.strip_prefix('\u{feff}').unwrap_or(&disk) != expected);
    if changed {
        return Err(AppError::domain(
            "manuscript_changed",
            "The manuscript changed on disk since it was last saved",
        ));
    }
    store::write_unit_file(&path, text)?;
    record_edit_in(&dir, prev_text, "edit", anchors)
}

fn record_edit_in(
    dir: &Path,
    prev_text: Option<&str>,
    kind: &str,
    anchors: &[CommentAnchor],
) -> Result<(ReviewState, bool), AppError> {
    let mut state = store::load_state(dir)?;
    let manuscript = store::read_manuscript(dir)?;
    let moved = kind == "edit" && apply_comment_anchors(&mut state, anchors);
    let Some(prev) = prev_text else {
        let recorded = reconcile_external_change(&mut state, &manuscript, None);
        reanchor_all(&mut state, &manuscript);
        store::save_state(dir, &mut state)?;
        return Ok((state, recorded));
    };
    if state
        .manuscript_hash
        .as_deref()
        .is_some_and(|hash| hash != store::sha256_hex(prev))
    {
        let recorded = reconcile_external_change(&mut state, &manuscript, None);
        reanchor_all(&mut state, &manuscript);
        store::save_state(dir, &mut state)?;
        return Ok((state, recorded));
    }
    let spans = edit_spans(prev, &manuscript);
    if spans.is_empty() {
        if moved {
            reanchor_all(&mut state, &manuscript);
        }
        if state.manuscript_hash.is_none() || moved {
            state.manuscript_hash = Some(store::sha256_hex(&manuscript));
            store::save_state(dir, &mut state)?;
        }
        return Ok((state, false));
    }
    if kind == "untracked" {
        if let Some(rev) = state
            .revisions
            .iter_mut()
            .find(|r| r.id == state.baseline_id)
        {
            store::write_unit_file(&dir.join(&rev.file), &manuscript)?;
            rev.hash = store::sha256_hex(&manuscript);
        }
        state.baseline_text = manuscript.clone();
    } else {
        for span in spans {
            let mut e = event(if kind == "external" {
                "external-change"
            } else {
                "edit"
            });
            e.before = Some(span.before);
            e.after = Some(span.after);
            e.prefix = Some(span.prefix);
            e.suffix = Some(span.suffix);
            state.events.push(e);
        }
    }
    state.manuscript_hash = Some(store::sha256_hex(&manuscript));
    reanchor_all(&mut state, &manuscript);
    store::save_state(dir, &mut state)?;
    Ok((state, true))
}

/// Point comments at the text the editor tracked for them. Returns true when
/// any comment changed.
fn apply_comment_anchors(state: &mut ReviewState, anchors: &[CommentAnchor]) -> bool {
    let mut changed = false;
    for anchor in anchors {
        let quote = anchor.quote.trim();
        if quote.is_empty() {
            continue;
        }
        let Some(comment) = state.comments.iter_mut().find(|c| {
            c.id == anchor.comment_id
                && c.source == CommentSource::Manuscript
                && c.status != CommentStatus::Deleted
        }) else {
            continue;
        };
        if comment.quote != quote
            || comment.prefix != anchor.prefix
            || comment.suffix != anchor.suffix
        {
            comment.quote = quote.to_string();
            comment.prefix = anchor.prefix.clone();
            comment.suffix = anchor.suffix.clone();
            changed = true;
        }
    }
    changed
}

/// Apply one Agent-authored exact-text replacement. The caller must provide
/// the manuscript hash it read; no baseline/checkpoint is touched.
pub fn replace_manuscript_as_agent(
    vault: &Path,
    id: &str,
    expected_hash: &str,
    before: &str,
    after: &str,
    agent: Option<&str>,
) -> Result<(ReviewState, String), AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let _lock = store::lock_unit(&dir);
    let mut state = store::load_state(&dir)?;
    let manuscript = store::read_manuscript(&dir)?;
    if store::sha256_hex(&manuscript) != expected_hash {
        return Err(AppError::domain(
            "stale_manuscript",
            "Manuscript changed; read it again before editing.",
        ));
    }
    if before.is_empty() || before == after {
        return Err(AppError::message(
            "provide a nonempty, changed exact text span",
        ));
    }
    let Some(at) = manuscript.find(before) else {
        return Err(AppError::message(
            "text to replace was not found in the manuscript",
        ));
    };
    let next_char = before.chars().next().expect("nonempty text").len_utf8();
    if manuscript[at + next_char..].contains(before) {
        return Err(AppError::message(
            "text to replace is ambiguous; include more context",
        ));
    }
    let mut next = manuscript.clone();
    next.replace_range(at..at + before.len(), after);
    store::write_unit_file(&store::manuscript_path(&dir), &next)?;
    let mut e = event("edit");
    e.actor = "agent".into();
    e.agent = agent.map(str::to_string);
    let (removed, added) = changed_span(before, after).expect("different replacement text");
    let shared_prefix: usize = before
        .chars()
        .zip(after.chars())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum();
    let start = at + shared_prefix;
    let left = &next[next[..start].rfind('\n').map_or(0, |i| i + 1)..start];
    let right_end = next[start + added.len()..]
        .find('\n')
        .map_or(next.len(), |i| start + added.len() + i);
    let right = &next[start + added.len()..right_end];
    e.before = Some(removed);
    e.after = Some(added);
    e.prefix = Some(
        left.chars()
            .rev()
            .take(24)
            .collect::<String>()
            .chars()
            .rev()
            .collect(),
    );
    e.suffix = Some(right.chars().take(24).collect());
    state.events.push(e);
    state.manuscript_hash = Some(store::sha256_hex(&next));
    // Comments on the rewritten text move onto its replacement, as in Word,
    // so the author can check them against the revision instead of finding
    // them outdated.
    let (old_source, new_source) = (
        anchor::Source::parse(&manuscript),
        anchor::Source::parse(&next),
    );
    for comment in &mut state.comments {
        if comment.source == CommentSource::Pdf || comment.status == CommentStatus::Deleted {
            continue;
        }
        if let Some((quote, prefix, suffix)) = anchor::follow_rewrite(
            &old_source,
            &new_source,
            &comment.quote,
            &comment.prefix,
            &comment.suffix,
        ) {
            comment.quote = quote;
            comment.prefix = prefix;
            comment.suffix = suffix;
        }
    }
    reanchor_all(&mut state, &next);
    store::save_state(&dir, &mut state)?;
    Ok((state, next))
}

/// Accept or reject one or all tracked changes by updating the baseline
/// snapshot and/or the live manuscript.
pub fn apply_tracked_change(
    vault: &Path,
    id: &str,
    next_baseline: &str,
    next_manuscript: Option<&str>,
    reason: Option<&str>,
) -> Result<(ReviewState, String), AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let _lock = store::lock_unit(&dir);
    let mut state = store::load_state(&dir)?;
    if let Some(md) = next_manuscript {
        store::write_unit_file(&store::manuscript_path(&dir), md)?;
    }
    let manuscript = match next_manuscript {
        Some(md) => md.to_string(),
        None => store::read_manuscript(&dir)?,
    };
    if let Some(rev) = state
        .revisions
        .iter_mut()
        .find(|r| r.id == state.baseline_id)
    {
        store::write_unit_file(&dir.join(&rev.file), next_baseline)?;
        rev.hash = store::sha256_hex(next_baseline);
    }
    state.baseline_text = next_baseline.to_string();
    let mut e = event("checkpoint");
    e.revision_id = Some(state.baseline_id.clone());
    e.reason = reason.map(str::to_string);
    state.events.push(e);
    state.manuscript_hash = Some(store::sha256_hex(&manuscript));
    reanchor_all(&mut state, &manuscript);
    store::save_state(&dir, &mut state)?;
    Ok((state, manuscript))
}

/// Close the current round: snapshot the manuscript as a new revision and
/// move the baseline to it. History stays in `revisions/` + events.
pub fn checkpoint(vault: &Path, id: &str, reason: Option<&str>) -> Result<ReviewState, AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let _lock = store::lock_unit(&dir);
    let mut state = store::load_state(&dir)?;
    let manuscript = store::read_manuscript(&dir)?;
    reconcile_external_change(&mut state, &manuscript, None);
    let rev_id = new_id("rev");
    let file = format!("{REVISIONS_DIR}/{rev_id}.md");
    store::write_unit_file(&dir.join(&file), &manuscript)?;
    let rev = Revision {
        id: rev_id.clone(),
        parent_id: Some(state.baseline_id.clone()),
        hash: store::sha256_hex(&manuscript),
        created_at: now(),
        reason: reason.unwrap_or_default().trim().to_string(),
        file,
    };
    state.revisions.push(rev);
    state.baseline_id = rev_id.clone();
    state.manuscript_hash = Some(store::sha256_hex(&manuscript));
    state.baseline_text = manuscript;
    let mut e = event("checkpoint");
    e.revision_id = Some(rev_id);
    e.reason = reason.map(str::to_string);
    state.events.push(e);
    store::save_state(&dir, &mut state)?;
    Ok(state)
}

/// Line diff between the round baseline snapshot and the current manuscript.
pub fn diff_baseline(vault: &Path, id: &str) -> Result<(Vec<DiffHunk>, String), AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let state = store::load_state(&dir)?;
    let baseline = state
        .revisions
        .iter()
        .find(|r| r.id == state.baseline_id)
        .ok_or_else(|| AppError::message("baseline revision missing"))?;
    let old = fs::read_to_string(dir.join(&baseline.file))?;
    let new = store::read_manuscript(&dir)?;
    Ok((diff_lines(&old, &new), baseline.created_at.clone()))
}

/// A diff hunk and who wrote it (see [`hunk_writers`]).
pub type AttributedHunk = (DiffHunk, Vec<String>);

/// The baseline-to-current diff with writers per hunk, and the baseline time.
pub fn attributed_diff(vault: &Path, id: &str) -> Result<(Vec<AttributedHunk>, String), AppError> {
    let (hunks, baseline_created_at) = diff_baseline(vault, id)?;
    let state = store::load_state(&store::checked_unit_dir_pub(vault, id)?)?;
    let round = round_events(&state);
    let hunks = hunks
        .into_iter()
        .map(|hunk| {
            let writers = hunk_writers(&hunk, round);
            (hunk, writers)
        })
        .collect();
    Ok((hunks, baseline_created_at))
}

/// Events since the current round's baseline checkpoint.
/// What the app's panel receives for `state`: this round's events only, the
/// Agents of the whole history, and the baseline text unless the panel
/// already has the baseline revision with hash `known_baseline`.
pub fn view(mut state: ReviewState, known_baseline: Option<&str>) -> ReviewView {
    let mut agents: Vec<String> = Vec::new();
    for event in &state.events {
        if let Some(agent) = event.agent.as_ref().filter(|_| event.actor == "agent") {
            if !agents.contains(agent) {
                agents.push(agent.clone());
            }
        }
    }
    let baseline_hash = state
        .revisions
        .iter()
        .find(|r| r.id == state.baseline_id)
        .map(|r| r.hash.as_str());
    let baseline_included = known_baseline.is_none() || known_baseline != baseline_hash;
    if !baseline_included {
        state.baseline_text = String::new();
    }
    let start = state.events.len() - round_events(&state).len();
    state.events.drain(..start);
    let stamp = state.stamp.clone();
    ReviewView {
        state,
        agents,
        baseline_included,
        stamp,
    }
}

pub fn round_events(state: &ReviewState) -> &[ReviewEvent] {
    let start = state
        .events
        .iter()
        .position(|e| {
            e.kind == "checkpoint" && e.revision_id.as_deref() == Some(&state.baseline_id)
        })
        .map_or(0, |i| i + 1);
    &state.events[start..]
}

/// `span` with the last / first few characters of the edit's saved context.
fn within_context(text: &str, span: &str, event: &ReviewEvent) -> bool {
    const EDGE: usize = 8;
    let prefix = event.prefix.as_deref().unwrap_or("");
    let suffix = event.suffix.as_deref().unwrap_or("");
    if span.is_empty() || (prefix.is_empty() && suffix.is_empty()) {
        return false;
    }
    let tail: String = {
        let chars: Vec<char> = prefix.chars().collect();
        chars[chars.len().saturating_sub(EDGE)..].iter().collect()
    };
    let head: String = suffix.chars().take(EDGE).collect();
    let needle = format!("{}{span}{}", tail.trim_start(), head.trim_end());
    text.contains(needle.trim())
}

/// Whether `text` contains the edited span `span` as written text, not as an
/// accidental fragment: the span needs two letters or digits, and a Latin word
/// at either end of it must not continue in `text` ("tion." is not found in
/// "attention.").
fn contains_span(text: &str, span: &str) -> bool {
    if span.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
        return false;
    }
    let latin = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
    let first = span.chars().next();
    let last = span.chars().last();
    text.match_indices(span).any(|(at, _)| {
        let prev = text[..at].chars().next_back();
        let next = text[at + span.len()..].chars().next();
        let cuts_word = (latin(first) && latin(prev)) || (latin(last) && latin(next));
        !cuts_word
    })
}

/// Who wrote each changed line of a hunk: `(old line, new line, writers)`,
/// with the new line number for added lines and the old one for removed
/// lines. Same matching as [`hunk_writers`], per line.
pub fn line_writers(
    hunk: &DiffHunk,
    events: &[ReviewEvent],
) -> Vec<(Option<u32>, Option<u32>, Vec<String>)> {
    let mut out = Vec::new();
    let (mut old, mut new) = (hunk.old_start, hunk.new_start);
    for line in &hunk.lines {
        let single = DiffHunk {
            old_start: old,
            new_start: new,
            lines: vec![line.clone()],
        };
        match line.kind.as_str() {
            "add" => {
                let writers = hunk_writers(&single, events);
                if !writers.is_empty() {
                    out.push((None, Some(new), writers));
                }
                new += 1;
            }
            "del" => {
                let writers = hunk_writers(&single, events);
                if !writers.is_empty() {
                    out.push((Some(old), None, writers));
                }
                old += 1;
            }
            _ => {
                old += 1;
                new += 1;
            }
        }
    }
    out
}

/// Who wrote a hunk: Agent names (or "AI" for unnamed Agent writes) and
/// "author", in the order of their edits, for every edit of this round whose
/// written text is still among the hunk's added lines, or whose removed text
/// is among its removed lines. A best-effort label from saved edit spans, not
/// a line-by-line blame.
pub fn hunk_writers(hunk: &DiffHunk, events: &[ReviewEvent]) -> Vec<String> {
    let joined = |kind: &str| {
        hunk.lines
            .iter()
            .filter(|line| line.kind == kind)
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let added = joined("add");
    let removed = joined("del");
    let mut writers: Vec<String> = Vec::new();
    for event in events
        .iter()
        .filter(|e| e.kind == "edit" || e.kind == "external-change")
    {
        let after = event.after.as_deref().unwrap_or("").trim();
        let before = event.before.as_deref().unwrap_or("").trim();
        // Saved context makes a span specific (and covers characters the
        // edit shares with the old text, "model|s"); otherwise the span must
        // stand on its own.
        let (lines, span) = if after.is_empty() {
            (&removed, before)
        } else {
            (&added, after)
        };
        let wrote = within_context(lines, span, event) || contains_span(lines, span);
        if !wrote {
            continue;
        }
        let name = match (event.actor.as_str(), event.agent.as_deref()) {
            ("agent", Some(agent)) => agent.to_string(),
            ("agent", None) => "AI".to_string(),
            _ => "author".to_string(),
        };
        if !writers.contains(&name) {
            writers.push(name);
        }
    }
    writers
}

/// Export a portable review directory: manuscript, `REVIEW.md`, state and
/// snapshots. Plain files — no zip, no catalog row.
pub fn export(vault: &Path, id: &str, dest_dir: &Path) -> Result<String, AppError> {
    let dir = store::checked_unit_dir_pub(vault, id)?;
    let state = store::load_state(&dir)?;
    let manuscript = store::read_manuscript(&dir)?;
    let out = dest_dir.join(format!("{}-review", state.id));
    if out.exists() {
        return Err(AppError::message("export destination already exists"));
    }
    fs::create_dir_all(out.join(REVISIONS_DIR))?;
    fs::write(out.join(MANUSCRIPT_FILE), &manuscript)?;
    fs::write(out.join(STATE_FILE), serde_json::to_vec_pretty(&state)?)?;
    fs::write(
        out.join(EXPORT_REVIEW_MD),
        super::review_md::render(&state, &manuscript),
    )?;
    for rev in &state.revisions {
        let src = dir.join(&rev.file);
        if src.exists() {
            fs::copy(&src, out.join(&rev.file))?;
        }
    }
    Ok(out.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::review::store::create_unit;

    fn setup() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let unit = create_unit(dir.path(), "Draft").expect("create");
        (dir, unit.id)
    }

    fn write_manuscript(vault: &Path, id: &str, text: &str) {
        let dir = vault.join("reviews").join(id);
        fs::write(dir.join(MANUSCRIPT_FILE), text).expect("write");
    }

    #[test]
    fn agent_replacement_tracks_origin_without_advancing_baseline() {
        let (dir, id) = setup();
        let original = "# Draft\n\nold result.\n";
        write_manuscript(dir.path(), &id, original);
        let state = checkpoint(dir.path(), &id, None).unwrap();
        let hash = store::sha256_hex(original);
        let (updated, manuscript) =
            replace_manuscript_as_agent(dir.path(), &id, &hash, "old result", "new result", None)
                .unwrap();
        assert_eq!(updated.baseline_id, state.baseline_id);
        assert_eq!(updated.baseline_text, original);
        assert_eq!(manuscript, "# Draft\n\nnew result.\n");
        let edit = updated.events.last().unwrap();
        assert_eq!(edit.actor, "agent");
        assert_eq!(edit.before.as_deref(), Some("old"));
        assert_eq!(edit.after.as_deref(), Some("new"));
        assert!(replace_manuscript_as_agent(dir.path(), &id, &hash, "new", "other", None).is_err());
        assert!(replace_manuscript_as_agent(
            dir.path(),
            &id,
            &store::sha256_hex(&manuscript),
            "result",
            "other",
            None
        )
        .is_ok());
    }

    #[test]
    fn comments_follow_an_agent_rewrite_of_their_text() {
        let (dir, id) = setup();
        let original = "# Draft\n\nOur method cuts memory by 40% everywhere.\n";
        write_manuscript(dir.path(), &id, original);
        add_comment(
            dir.path(),
            &id,
            &comment_input("cuts memory by 40%", "Which baseline?"),
        )
        .unwrap();
        let (state, _) = replace_manuscript_as_agent(
            dir.path(),
            &id,
            &store::sha256_hex(original),
            "cuts memory by 40% everywhere",
            "cuts peak memory by 38% versus dense attention",
            Some("Gemini"),
        )
        .unwrap();
        let comment = &state.comments[0];
        assert_eq!(
            comment.quote,
            "cuts peak memory by 38% versus dense attention"
        );
        assert_eq!(comment.anchor, AnchorStatus::Attached);
    }

    #[test]
    fn author_saves_carry_the_comment_ranges_the_editor_moved() {
        let (dir, id) = setup();
        let v1 = "# Draft\n\nOur method cuts memory by 40% everywhere.\n";
        write_manuscript(dir.path(), &id, v1);
        record_edit(dir.path(), &id, None, "edit").unwrap();
        let state =
            add_comment(dir.path(), &id, &comment_input("cuts memory by 40%", "x")).unwrap();
        let moved = CommentAnchor {
            comment_id: state.comments[0].id.clone(),
            quote: "cuts peak memory by 38%".into(),
            prefix: "Our method ".into(),
            suffix: " everywhere.".into(),
        };
        let v2 = "# Draft\n\nOur method cuts peak memory by 38% everywhere.\n";
        write_manuscript(dir.path(), &id, v2);
        let (state, _) = record_edit_with_anchors(
            dir.path(),
            &id,
            Some(v1),
            "edit",
            std::slice::from_ref(&moved),
        )
        .unwrap();
        assert_eq!(state.comments[0].quote, "cuts peak memory by 38%");
        assert_eq!(state.comments[0].anchor, AnchorStatus::Attached);
        // Watcher reloads never move comments.
        let (state, _) = record_edit_with_anchors(
            dir.path(),
            &id,
            Some(v2),
            "external",
            &[CommentAnchor {
                quote: "Our".into(),
                ..moved
            }],
        )
        .unwrap();
        assert_eq!(state.comments[0].quote, "cuts peak memory by 38%");
    }

    #[test]
    fn agent_comment_and_reply_keep_attribution() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# Draft\n\nClaim here.\n");
        let state = add_comment_as(
            dir.path(),
            &id,
            &comment_input("Claim", "Cite evidence"),
            "agent",
            None,
        )
        .unwrap();
        assert_eq!(state.comments[0].actor, "agent");
        let state = update_comment_as(
            dir.path(),
            &id,
            &state.comments[0].id,
            CommentAction::Reply,
            Some("Another source"),
            None,
            "agent",
            None,
        )
        .unwrap();
        assert_eq!(state.comments[0].replies[0].actor, "agent");
        let mut legacy = serde_json::to_value(&state.comments[0]).unwrap();
        legacy.as_object_mut().unwrap().remove("actor");
        let old_comment: ReviewComment = serde_json::from_value(legacy).unwrap();
        assert_eq!(old_comment.actor, "author");

        let authored = add_comment(dir.path(), &id, &comment_input("here", "Original")).unwrap();
        let human_id = &authored.comments.last().unwrap().id;
        let edited = update_comment_as(
            dir.path(),
            &id,
            human_id,
            CommentAction::Edit,
            Some("Revised by AI"),
            None,
            "agent",
            None,
        )
        .unwrap();
        let comment = edited.comments.last().unwrap();
        assert_eq!(comment.actor, "author");
        assert_eq!(comment.edited_by.as_deref(), Some("agent"));
    }

    #[test]
    fn agents_reply_to_each_other_but_only_change_their_own_comments() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# Draft\n\nClaim here.\n");
        let state = add_comment_as(
            dir.path(),
            &id,
            &comment_input("Claim", "Cite evidence"),
            "agent",
            Some("Codex"),
        )
        .unwrap();
        let codex = state.comments[0].id.clone();
        assert_eq!(state.comments[0].agent.as_deref(), Some("Codex"));
        let update = |action, body, agent| {
            update_comment_as(dir.path(), &id, &codex, action, body, None, "agent", agent)
        };
        // Timestamps are in milliseconds; make the reply visibly newer.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let replied = update(CommentAction::Reply, Some("Agreed"), Some("Claude Code")).unwrap();
        assert_eq!(
            replied.comments[0].replies[0].agent.as_deref(),
            Some("Claude Code")
        );
        // Replying from a read taken before another Agent's reply still works.
        let stale = state.comments[0].updated_at.as_str();
        let late = update_comment_as(
            dir.path(),
            &id,
            &codex,
            CommentAction::Reply,
            Some("Me too"),
            Some(stale),
            "agent",
            Some("Antigravity"),
        )
        .unwrap();
        assert_eq!(late.comments[0].replies.len(), 2);
        for action in [
            CommentAction::Edit,
            CommentAction::Resolve,
            CommentAction::Delete,
        ] {
            let err = update(action, Some("x"), Some("Claude Code")).unwrap_err();
            assert!(err.to_string().contains("Codex"));
        }
        assert!(update(CommentAction::Resolve, None, Some("Codex")).is_ok());
        // The author still decides for every comment.
        assert!(update_comment(dir.path(), &id, &codex, CommentAction::Reopen, None, None).is_ok());
    }

    #[test]
    fn replies_are_edited_by_their_writer_and_deleted_by_it_or_the_author() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# Draft\n\nClaim here.\n");
        let state = add_comment(dir.path(), &id, &comment_input("Claim", "Cite evidence")).unwrap();
        let cid = state.comments[0].id.clone();
        let reply = |body, actor, agent| {
            update_comment_as(
                dir.path(),
                &id,
                &cid,
                CommentAction::Reply,
                Some(body),
                None,
                actor,
                agent,
            )
            .unwrap()
            .comments[0]
                .replies
                .last()
                .unwrap()
                .id
                .clone()
        };
        let mine = reply("Will do", "author", None);
        let codex = reply("Table 2 has it", "agent", Some("Codex"));
        let claude = reply("Agreed", "agent", Some("Claude Code"));
        let change = |reply_id: &str, action, body, actor, agent| {
            update_reply_as(dir.path(), &id, &cid, reply_id, action, body, actor, agent)
        };
        let ids = |state: ReviewState| -> Vec<String> {
            state.comments[0]
                .replies
                .iter()
                .map(|r| r.id.clone())
                .collect()
        };

        let edited = change(
            &mine,
            CommentAction::Edit,
            Some("Will do today"),
            "author",
            None,
        )
        .unwrap();
        let r = &edited.comments[0].replies[0];
        assert_eq!(r.body, "Will do today");
        assert!(r.edited_at.is_some());
        let e = edited.events.last().unwrap();
        assert_eq!(
            (e.kind.as_str(), e.reply_id.as_deref()),
            ("reply-edit", Some(mine.as_str()))
        );

        // Only the writer edits; Agents delete only their own replies.
        assert!(change(&codex, CommentAction::Edit, Some("x"), "author", None).is_err());
        let err = change(
            &codex,
            CommentAction::Delete,
            None,
            "agent",
            Some("Claude Code"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("Codex"));
        assert!(change(&mine, CommentAction::Delete, None, "agent", Some("Codex")).is_err());
        assert!(change(&codex, CommentAction::Resolve, None, "agent", Some("Codex")).is_err());

        let state = change(&codex, CommentAction::Delete, None, "agent", Some("Codex")).unwrap();
        assert_eq!(ids(state), [mine.clone(), claude.clone()]);
        // The author may delete anyone's reply.
        let state = change(&claude, CommentAction::Delete, None, "author", None).unwrap();
        let e = state.events.last().unwrap();
        assert_eq!(
            (e.kind.as_str(), e.before.as_deref()),
            ("reply-delete", None)
        );
        assert_eq!(ids(state), [mine]);
        assert!(change(&codex, CommentAction::Delete, None, "agent", Some("Codex")).is_err());
    }

    #[test]
    fn edited_spans_match_whole_words_only() {
        assert!(!contains_span("dense attention.", "tion."));
        assert!(!contains_span("a. b.", "."));
        assert!(contains_span("cutting memory by up to 40%", "by up to 40%"));
        assert!(contains_span("（巨大的成长）", "巨大"));
        assert!(!contains_span("the 1.3B models", "1.3B model"));
    }

    #[test]
    fn diff_hunks_name_the_agents_and_author_that_wrote_them() {
        let (dir, id) = setup();
        let original = "# Draft\n\nFirst claim.\n\nSecond claim.\n";
        write_manuscript(dir.path(), &id, original);
        checkpoint(dir.path(), &id, None).unwrap();
        let (_, text) = replace_manuscript_as_agent(
            dir.path(),
            &id,
            &store::sha256_hex(original),
            "First claim.",
            "First claim, with evidence.",
            Some("Codex"),
        )
        .unwrap();
        replace_manuscript_as_agent(
            dir.path(),
            &id,
            &store::sha256_hex(&text),
            "Second claim.",
            "Second claim, revised.",
            Some("Claude Code"),
        )
        .unwrap();
        let (hunks, _) = attributed_diff(dir.path(), &id).unwrap();
        let state = store::load_state(&store::reviews_root(dir.path()).join(&id)).unwrap();
        let by_line: Vec<_> = hunks
            .iter()
            .flat_map(|(hunk, _)| line_writers(hunk, round_events(&state)))
            .filter(|(_, new, _)| new.is_some())
            .map(|(_, _, by)| by)
            .collect();
        assert_eq!(by_line, vec![vec!["Codex"], vec!["Claude Code"]]);
        let writers: Vec<_> = hunks.into_iter().flat_map(|(_, w)| w).collect();
        assert_eq!(writers, vec!["Codex", "Claude Code"]);
    }

    #[test]
    fn agent_replacement_refuses_overlapping_ambiguous_matches() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# aaa\n");
        let hash = store::sha256_hex("# aaa\n");
        assert!(replace_manuscript_as_agent(dir.path(), &id, &hash, "aa", "bb", None).is_err());
        assert_eq!(
            store::read_manuscript(&store::reviews_root(dir.path()).join(id)).unwrap(),
            "# aaa\n"
        );
    }

    fn comment_input(quote: &str, body: &str) -> ReviewCommentInput {
        ReviewCommentInput {
            block_id: None,
            quote: quote.into(),
            source: CommentSource::Manuscript,
            page: None,
            prefix: String::new(),
            suffix: String::new(),
            heading: String::new(),
            body: body.into(),
        }
    }

    #[test]
    fn add_and_update_comment_lifecycle() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# Draft\n\nalpha beta gamma.\n");
        let state = add_comment(dir.path(), &id, &comment_input("alpha beta", "tighten")).unwrap();
        assert_eq!(state.comments.len(), 1);
        let c = &state.comments[0];
        assert_eq!(c.anchor, AnchorStatus::Attached);
        assert_eq!(c.status, CommentStatus::Open);

        let state = update_comment(
            dir.path(),
            &id,
            &c.id,
            CommentAction::Reply,
            Some("done in pass 2"),
            Some(&c.updated_at),
        )
        .unwrap();
        assert_eq!(state.comments[0].replies.len(), 1);

        let stale = update_comment(
            dir.path(),
            &id,
            &c.id,
            CommentAction::Resolve,
            None,
            Some("1999-01-01T00:00:00.000Z"),
        );
        assert!(stale.is_err(), "stale expectedUpdatedAt must conflict");

        let state =
            update_comment(dir.path(), &id, &c.id, CommentAction::Resolve, None, None).unwrap();
        assert_eq!(state.comments[0].status, CommentStatus::Resolved);
        let state =
            update_comment(dir.path(), &id, &c.id, CommentAction::Delete, None, None).unwrap();
        assert_eq!(state.comments[0].status, CommentStatus::Deleted);
        let state =
            update_comment(dir.path(), &id, &c.id, CommentAction::Restore, None, None).unwrap();
        assert_eq!(state.comments[0].status, CommentStatus::Open);
        // created + reply + resolve + delete + restore events
        assert!(state.events.len() >= 5);
    }

    #[test]
    fn record_edit_appends_event_and_reanchors() {
        let (dir, id) = setup();
        let v1 = "# Draft\n\nalpha beta gamma.\n";
        write_manuscript(dir.path(), &id, v1);
        let state = add_comment(dir.path(), &id, &comment_input("alpha beta", "x")).unwrap();
        let cid = state.comments[0].id.clone();

        // No cache, but the saved hash detects the direct file edit.
        let (state, recorded) = record_edit(dir.path(), &id, None, "edit").unwrap();
        assert!(recorded);
        assert_eq!(state.events.last().unwrap().kind, "external-change");

        // Remove the quoted text → anchor becomes deleted, event recorded.
        let v2 = "# Draft\n\ngamma only.\n";
        write_manuscript(dir.path(), &id, v2);
        let (state, recorded) = record_edit(dir.path(), &id, Some(v1), "edit").unwrap();
        assert!(recorded);
        let c = state.comments.iter().find(|c| c.id == cid).unwrap();
        assert_eq!(c.anchor, AnchorStatus::Deleted);
        let last = state.events.last().unwrap();
        assert_eq!(last.kind, "edit");
        assert_eq!(last.before.as_deref(), Some("alpha beta gamma"));
        assert_eq!(last.after.as_deref(), Some("gamma only"));

        // Identical text is a no-op (self-save echo guard).
        let (_, recorded) = record_edit(dir.path(), &id, Some(v2), "edit").unwrap();
        assert!(!recorded);
    }

    #[test]
    fn external_revert_marks_comment_outdated_and_records_history_on_reopen() {
        let (dir, id) = setup();
        let original = "# Draft\n\nThe original claim.\n";
        write_manuscript(dir.path(), &id, original);
        let baseline = checkpoint(dir.path(), &id, None).unwrap();
        let (edited, changed) = replace_manuscript_as_agent(
            dir.path(),
            &id,
            &store::sha256_hex(original),
            "original claim",
            "revised claim",
            None,
        )
        .unwrap();
        let state = add_comment_as(
            dir.path(),
            &id,
            &comment_input("revised claim", "Please check this wording"),
            "agent",
            None,
        )
        .unwrap();
        assert_eq!(state.open_count(), 1);

        // Restore the baseline by copying the file, outside the review API.
        let unit_dir = store::reviews_root(dir.path()).join(&id);
        fs::copy(
            unit_dir.join(&baseline.revisions.last().unwrap().file),
            store::manuscript_path(&unit_dir),
        )
        .unwrap();
        let events_before_open = store::load_state(&unit_dir).unwrap().events.len();
        assert_eq!(store::list_units(dir.path()).unwrap()[0].open_count, 0);
        assert_eq!(
            store::load_state(&unit_dir).unwrap().events.len(),
            events_before_open
        );
        let (state, manuscript) = store::open_unit(dir.path(), &id).unwrap();
        assert_eq!(manuscript, original);
        assert_eq!(state.baseline_id, baseline.baseline_id);
        assert_eq!(state.comments[0].status, CommentStatus::Open);
        assert_eq!(state.comments[0].anchor, AnchorStatus::Deleted);
        assert_eq!(state.open_count(), 0);
        let last = state.events.last().unwrap();
        assert_eq!(last.kind, "external-change");
        assert!(
            last.before.is_none(),
            "no prior text available after restart"
        );
        let event_count = state.events.len();
        assert_eq!(
            store::open_unit(dir.path(), &id).unwrap().0.events.len(),
            event_count
        );
        let (_, watcher_echo) = record_edit(dir.path(), &id, Some(original), "external").unwrap();
        assert!(!watcher_echo);

        // Restoring the Agent's text reattaches the comment without resolving
        // or fabricating a second comment-lifecycle event.
        write_manuscript(dir.path(), &id, &changed);
        let (state, _) = store::open_unit_with_previous(dir.path(), &id, Some(original)).unwrap();
        assert_eq!(state.comments[0].anchor, AnchorStatus::Attached);
        assert_eq!(state.open_count(), 1);
        assert_eq!(state.events.last().unwrap().kind, "external-change");
        assert_eq!(
            state.events.last().unwrap().before.as_deref(),
            Some("original")
        );
        assert_eq!(
            state.events.last().unwrap().after.as_deref(),
            Some("revised")
        );
        assert_eq!(state.manuscript_hash, edited.manuscript_hash);
    }

    #[test]
    fn legacy_review_without_hash_reanchors_without_fabricating_old_edits() {
        let (dir, id) = setup();
        let unit_dir = store::reviews_root(dir.path()).join(&id);
        let mut state = store::load_state(&unit_dir).unwrap();
        state.manuscript_hash = None;
        let event_count = state.events.len();
        store::save_state(&unit_dir, &mut state).unwrap();
        write_manuscript(dir.path(), &id, "# Draft\n\nExternal text.\n");

        let (opened, _) = store::open_unit(dir.path(), &id).unwrap();
        assert_eq!(opened.events.len(), event_count);
        assert_eq!(
            opened.manuscript_hash,
            Some(store::sha256_hex("# Draft\n\nExternal text.\n"))
        );
    }

    #[test]
    fn checkpoint_moves_baseline_and_diff_compares() {
        let (dir, id) = setup();
        let v1 = "# Draft\n\nalpha beta gamma.\n";
        write_manuscript(dir.path(), &id, v1);
        let (state, _) = record_edit(dir.path(), &id, None, "edit").unwrap();
        let initial_baseline = state.baseline_id.clone();

        let v2 = "# Draft\n\nalpha beta delta.\n";
        write_manuscript(dir.path(), &id, v2);
        let (hunks, _) = diff_baseline(dir.path(), &id).unwrap();
        assert!(!hunks.is_empty(), "baseline is the scaffold text");

        let state = checkpoint(dir.path(), &id, Some("round 1")).unwrap();
        assert_ne!(state.baseline_id, initial_baseline);
        assert_eq!(state.revisions.len(), 2);
        assert_eq!(
            state.revisions[1].parent_id.as_deref(),
            Some(initial_baseline.as_str())
        );

        let (hunks, _) = diff_baseline(dir.path(), &id).unwrap();
        assert!(hunks.is_empty(), "fresh baseline means no changes");
    }

    #[test]
    fn export_writes_portable_dir() {
        let (dir, id) = setup();
        let dest = dir.path().join("out");
        fs::create_dir_all(&dest).unwrap();
        let out = export(dir.path(), &id, &dest).expect("export");
        let out = Path::new(&out);
        assert!(out.join(MANUSCRIPT_FILE).exists());
        assert!(out.join(STATE_FILE).exists());
        assert!(out.join(EXPORT_REVIEW_MD).exists());
        // Second export to the same place must refuse to overwrite.
        assert!(export(dir.path(), &id, &dest).is_err());
    }

    #[test]
    fn pdf_comments_skip_manuscript_reanchoring() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# Draft\n\nalpha beta gamma.\n");
        let mut input = comment_input("alpha beta", "see figure");
        input.source = CommentSource::Pdf;
        input.page = Some(3);
        input.block_id = None;
        let state = add_comment(dir.path(), &id, &input).unwrap();
        let cid = state.comments[0].id.clone();
        assert_eq!(state.comments[0].page, Some(3));
        assert_eq!(state.comments[0].anchor, AnchorStatus::Attached);

        // Rewrite the manuscript: the PDF comment must not become `deleted`.
        write_manuscript(dir.path(), &id, "# Draft\n\ntotally other text.\n");
        let (_, recorded) = record_edit(dir.path(), &id, None, "edit").unwrap();
        assert!(recorded);
        let state = store::load_state(&dir.path().join("reviews").join(&id)).unwrap();
        let comment = state.comments.iter().find(|c| c.id == cid).unwrap();
        assert_eq!(comment.anchor, AnchorStatus::Attached);
    }

    #[test]
    fn pdf_comment_requires_a_page() {
        let (dir, id) = setup();
        let mut input = comment_input("alpha beta", "x");
        input.source = CommentSource::Pdf;
        assert!(add_comment(dir.path(), &id, &input).is_err());
    }

    #[test]
    fn changed_span_is_char_based() {
        let (b, a) = changed_span("front 中间 back", "front 中坚 back").unwrap();
        assert_eq!(b, "间");
        assert_eq!(a, "坚");
        assert!(changed_span("same", "same").is_none());
    }

    /// A save that changed the top and the bottom records two small edits,
    /// not one span holding everything between them.
    #[test]
    fn edit_spans_split_separate_changes() {
        let middle = "unchanged paragraph.\n\n".repeat(200);
        let before = format!("# Title\n\nThe first claim.\n\n{middle}The last claim.\n");
        let after =
            format!("# Title\n\nThe first bold claim.\n\n{middle}The last claim, revised.\n");
        let spans = edit_spans(&before, &after);
        assert_eq!(spans.len(), 2);
        assert_eq!(
            (spans[0].before.as_str(), spans[0].after.as_str()),
            ("", "bold ")
        );
        assert_eq!(spans[0].prefix, "The first ");
        assert_eq!(spans[0].suffix, "claim.");
        assert_eq!(
            (spans[1].before.as_str(), spans[1].after.as_str()),
            ("", ", revised")
        );
        assert_eq!(spans[1].prefix, "The last claim");
        // One change: the same span as before, now with its context.
        let one = edit_spans("front 中间 back\n", "front 中坚 back\n");
        assert_eq!(one.len(), 1);
        assert_eq!(
            (one[0].before.as_str(), one[0].after.as_str()),
            ("间", "坚")
        );
        assert!(edit_spans("same", "same").is_empty());
    }

    /// Agents commenting over MCP while the author's saves are recorded: every
    /// write survives, and readers never see a partial `review.json`.
    #[test]
    fn concurrent_writers_keep_every_change() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# Draft\n\nshared quote here.\n");
        let vault = dir.path();
        // Take in the manuscript written above, so each save below is an edit.
        store::open_unit(vault, &id).unwrap();
        std::thread::scope(|scope| {
            for writer in 0..3 {
                let id = &id;
                scope.spawn(move || {
                    for i in 0..15 {
                        let body = format!("writer {writer} #{i}");
                        add_comment_as(
                            vault,
                            id,
                            &comment_input("shared quote", &body),
                            "agent",
                            None,
                        )
                        .expect("comment");
                    }
                });
            }
            let id = &id;
            scope.spawn(move || {
                for i in 0..15 {
                    let unit = store::checked_unit_dir_pub(vault, id).unwrap();
                    let prev = store::read_manuscript(&unit).unwrap();
                    let next = format!("{prev}line {i}\n");
                    fs::write(unit.join(MANUSCRIPT_FILE), &next).unwrap();
                    record_edit(vault, id, Some(&prev), "edit").expect("record edit");
                }
            });
        });
        let unit = store::checked_unit_dir_pub(vault, &id).unwrap();
        let state = store::load_state(&unit).unwrap();
        assert_eq!(state.comments.len(), 45);
        assert_eq!(state.events.iter().filter(|e| e.kind == "edit").count(), 15);
    }

    /// The author's save refuses to overwrite a manuscript that changed on
    /// disk (an Agent's replacement) since the editor last saw it.
    #[test]
    fn save_manuscript_records_and_refuses_stale_text() {
        let (dir, id) = setup();
        let unit = store::checked_unit_dir_pub(dir.path(), &id).unwrap();
        let (_, first) = store::open_unit(dir.path(), &id).unwrap();
        let next = format!("{first}\nA new line.\n");
        let (state, recorded) =
            save_manuscript(dir.path(), &id, &next, &first, Some(&first), &[]).unwrap();
        assert!(recorded);
        assert_eq!(state.events.last().unwrap().kind, "edit");
        assert_eq!(store::read_manuscript(&unit).unwrap(), next);

        let stale = save_manuscript(dir.path(), &id, "lost", &first, Some(&next), &[]);
        assert!(stale.is_err());
        assert_eq!(store::read_manuscript(&unit).unwrap(), next);
    }

    /// The panel's view: this round's events, the Agents of every round, the
    /// baseline text only when asked for a baseline the panel lacks, and the
    /// stamp of the file as saved.
    #[test]
    fn view_sends_this_round_and_the_agents_of_all_rounds() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# Draft\n\nquoted words.\n");
        add_comment_as(
            dir.path(),
            &id,
            &comment_input("quoted words", "old"),
            "agent",
            Some("Codex"),
        )
        .unwrap();
        checkpoint(dir.path(), &id, None).unwrap();
        let state = add_comment_as(
            dir.path(),
            &id,
            &comment_input("quoted words", "new"),
            "agent",
            Some("Gemini"),
        )
        .unwrap();
        let unit = store::checked_unit_dir_pub(dir.path(), &id).unwrap();
        assert_eq!(state.stamp, store::file_stamp(&store::state_path(&unit)));
        let baseline = state
            .revisions
            .iter()
            .find(|r| r.id == state.baseline_id)
            .unwrap()
            .hash
            .clone();

        let full = view(state.clone(), None);
        assert_eq!(full.agents, ["Codex", "Gemini"]);
        assert_eq!(
            full.state.events.len(),
            1,
            "only the comment after the checkpoint"
        );
        assert!(full.baseline_included && !full.state.baseline_text.is_empty());

        let known = view(state, Some(&baseline));
        assert!(!known.baseline_included && known.state.baseline_text.is_empty());
    }

    /// A damaged `review.json` (a sync conflict, a crash) falls back to the
    /// state before the last save, and the next save writes it whole again.
    #[test]
    fn damaged_state_recovers_from_backup() {
        let (dir, id) = setup();
        write_manuscript(dir.path(), &id, "# Draft\n\nsome quote.\n");
        add_comment_as(
            dir.path(),
            &id,
            &comment_input("some quote", "first"),
            "author",
            None,
        )
        .unwrap();
        add_comment_as(
            dir.path(),
            &id,
            &comment_input("some quote", "second"),
            "author",
            None,
        )
        .unwrap();
        let unit = store::checked_unit_dir_pub(dir.path(), &id).unwrap();
        fs::write(store::state_path(&unit), "{\"format\": \"edda-rev").unwrap();

        let recovered = store::load_state(&unit).unwrap();
        assert_eq!(
            recovered.comments.len(),
            1,
            "the state before the last save"
        );
        add_comment_as(
            dir.path(),
            &id,
            &comment_input("some quote", "third"),
            "author",
            None,
        )
        .unwrap();
        let raw = fs::read_to_string(store::state_path(&unit)).unwrap();
        assert!(serde_json::from_str::<ReviewState>(&raw).is_ok());
        // The damaged file never replaced the good backup.
        let backup = fs::read_to_string(store::backup_path(&unit)).unwrap();
        assert!(serde_json::from_str::<ReviewState>(&backup).is_ok());
    }
}
