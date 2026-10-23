//! Review workspace MCP tools (`review_*`).
//!
//! Reviews hold in-progress manuscripts, not published literature. These
//! tools are named distinctly from the `paper_*` family so an
//! agent never confuses "critique this draft" with "read that paper".

use super::tools::{tool_err, EddaMcp};
use crate::core::error::AppError;
use crate::features::review::ReviewEditCache;
#[cfg(test)]
use edda_core::features::review::CommentStatus;
use edda_core::features::review::{self, CommentAction};
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::CallToolResult;
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{tool, tool_router};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewIdArgs {
    /// Review id (the `reviews/<id>/` folder name), or a path inside it.
    #[serde(rename = "ref")]
    pub r#ref: String,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChangesArgs {
    /// Review id or path inside `reviews/<id>/`.
    #[serde(rename = "ref")]
    pub r#ref: String,
    /// Character offset into the baseline-to-current diff (default 0).
    pub offset: Option<usize>,
    /// Maximum characters to return (default/max 16000).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEditHistoryArgs {
    #[serde(rename = "ref")]
    pub r#ref: String,
    /// Number of edit events to skip (oldest first).
    pub offset: Option<usize>,
    /// Maximum edit events returned (default 20, max 100).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCreateArgs {
    pub title: String,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRenameArgs {
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub title: String,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewImportArgs {
    /// Explicit local file paths (PDF, Markdown, TeX or text).
    pub file_paths: Vec<String>,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommentAddArgs {
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub quote: String,
    pub body: String,
    /// `manuscript` (default) or `pdf`.
    pub source: Option<String>,
    pub page: Option<u32>,
    pub block_id: Option<String>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub heading: Option<String>,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommentUpdateArgs {
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub comment_id: String,
    /// `reply`, `edit`, `resolve`, `reopen`, `delete` or `restore`.
    pub action: String,
    pub body: Option<String>,
    pub expected_updated_at: Option<String>,
    /// A reply in this comment's thread: `edit` changes its body, `delete`
    /// removes it. Only replies this connection wrote.
    pub reply_id: Option<String>,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReplaceArgs {
    #[serde(rename = "ref")]
    pub r#ref: String,
    /// SHA-256 hash returned by review_manuscript. Required to reject stale edits.
    pub expected_hash: String,
    /// Unique, exact excerpt of manuscript Markdown to replace.
    pub before: String,
    pub after: String,
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewExportArgs {
    #[serde(rename = "ref")]
    pub r#ref: String,
    /// Existing output directory; will create a new `<id>-review` child.
    pub dest_dir: String,
}

/// Unified-style hunks; a hunk whose writers are known ends its header with
/// `by Codex, author`.
fn format_changes(hunks: &[review::ops::AttributedHunk]) -> String {
    let mut out = String::new();
    for (hunk, writers) in hunks {
        out.push_str(&format!("@@ -{} +{} @@", hunk.old_start, hunk.new_start));
        if !writers.is_empty() {
            out.push_str(&format!(" by {}", writers.join(", ")));
        }
        out.push('\n');
        for line in &hunk.lines {
            let prefix = match line.kind.as_str() {
                "add" => "+",
                "del" => "-",
                _ => " ",
            };
            out.push_str(prefix);
            out.push_str(&line.text);
            out.push('\n');
        }
    }
    out
}

fn resolve_unit(vault: &std::path::Path, reference: &str) -> Result<String, AppError> {
    let trimmed = reference.trim().trim_matches('/');
    // Accept a bare id or any `reviews/<id>/...` path ending in the unit.
    let id = match trimmed.rsplit_once('/') {
        Some((path, _name)) if trimmed.starts_with("reviews/") || path.ends_with("reviews") => {
            trimmed
                .trim_start_matches("reviews/")
                .split('/')
                .next()
                .unwrap_or(trimmed)
        }
        _ => trimmed,
    };
    let dir = review::checked_unit_dir_pub(vault, id)?;
    if !review::state_path(&dir).exists() {
        return Err(AppError::message(format!("review not found: {id}")));
    }
    Ok(id.to_string())
}

/// Who a connection writes as. Several Agents can review one manuscript; this
/// is how their comments, replies and edits are told apart.
#[derive(Debug, serde::Serialize)]
struct Caller {
    agent: String,
    /// Fixed in the MCP address (`/mcp?agent=Codex`), which the user or Edda
    /// sets once per connection, rather than the client's self-reported name.
    fixed: bool,
}

/// The `agent` parameter of an MCP address query, cleaned.
fn agent_from_query(query: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "agent")
        .map(|(_, name)| review::clean_agent_name(&name))
        .filter(|name| !name.is_empty())
}

/// The calling Agent: the name fixed in the address it connected to, else
/// the name its MCP client reported.
fn caller_agent(ctx: &RequestContext<RoleServer>) -> Option<Caller> {
    let fixed = ctx
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.uri.query())
        .and_then(agent_from_query);
    if let Some(agent) = fixed {
        return Some(Caller { agent, fixed: true });
    }
    let info = ctx.peer.peer_info()?;
    let client = &info.client_info;
    let reported = client
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&client.name);
    Some(Caller {
        agent: review::agent_display_name(reported),
        fixed: false,
    })
}

fn comment_row(comment: &review::model::ReviewComment) -> Value {
    json!({
        "id": comment.id,
        "status": comment.status.as_str(),
        "anchor": comment.anchor.as_str(),
        "outdated": comment.source == review::model::CommentSource::Manuscript
            && comment.anchor == review::AnchorStatus::Deleted,
        "source": comment.source,
        "page": comment.page,
        "blockId": comment.block_id,
        "quote": comment.quote,
        "prefix": comment.prefix,
        "suffix": comment.suffix,
        "heading": comment.heading,
        "comment": comment.body,
        "actor": comment.actor,
        "agent": comment.agent,
        "editedBy": comment.edited_by,
        "replies": comment.replies.len(),
        "replyThread": comment.replies.iter().map(|reply| json!({
            "id": reply.id,
            "body": reply.body,
            "actor": reply.actor,
            "agent": reply.agent,
            "createdAt": reply.created_at,
            "editedAt": reply.edited_at,
        })).collect::<Vec<_>>(),
        "createdAt": comment.created_at,
        "updatedAt": comment.updated_at,
    })
}

fn load(vault: &std::path::Path, id: &str) -> Result<(review::ReviewState, String), AppError> {
    let dir = review::reviews_root(vault).join(id);
    let mut state = review::load_state(&dir)?;
    let manuscript = std::fs::read_to_string(review::manuscript_path(&dir))?;
    review::ops::reanchor_all(&mut state, &manuscript);
    Ok((state, manuscript))
}

#[tool_router(router = review_router)]
impl EddaMcp {
    /// List review workspaces with their open comment counts.
    #[tool(
        description = "List manuscripts under review in this vault (reviews/). Each entry carries the unit id, title and open/resolved comment counts. Reviews are drafts, not papers.",
        annotations(read_only_hint = true)
    )]
    async fn review_list(&self) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let units = review::list_units(&vault).map_err(tool_err)?;
        Ok(Json(json!({
            "reviews": units.iter().map(|u| json!({
                "id": u.id,
                "title": u.title,
                "openCount": u.open_count,
                "resolvedCount": u.resolved_count,
                "updatedAt": u.updated_at,
            })).collect::<Vec<_>>(),
        })))
    }

    /// Read one review: title, counts, comments and current baseline.
    #[tool(
        description = "Read one review workspace by id. Returns the unit title, comment counts, round baseline revision and every comment with its reply thread. Comments and replies carry actor (author or agent) and, for Agents, the agent name; `you` is the name this connection writes as (`fixed` when set in the MCP address with ?agent=), so other Agents' comments can be told apart. Use review_changes for edits since the baseline, and review_manuscript for the current text.",
        annotations(read_only_hint = true)
    )]
    async fn review_read(
        &self,
        Parameters(args): Parameters<ReviewIdArgs>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.read_review(&args.r#ref, caller_agent(&ctx))
    }
    /// The edits since the current round baseline, for agent review.
    #[tool(
        description = "Read manuscript edits since the current review baseline as a line diff (minus = old, plus = current). Each hunk header names who wrote it when known (`@@ -14 +14 @@ by Codex, author`: Agent names, AI for unnamed Agent writes, author), and `writers` lists the writers of each changed line (newLine for added, oldLine for removed lines). Page through the diff using character offset/limit; the current manuscript is available via review_manuscript. Read-only: no revisions are accepted or rejected.",
        annotations(read_only_hint = true)
    )]
    async fn review_changes(
        &self,
        Parameters(args): Parameters<ReviewChangesArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let (hunks, baseline_created_at) =
            review::ops::attributed_diff(&vault, &id).map_err(tool_err)?;
        let diff = format_changes(&hunks);
        // Per changed line, so neighbouring edits by different writers that
        // the diff merged into one hunk can still be told apart.
        let state =
            review::load_state(&review::checked_unit_dir_pub(&vault, &id).map_err(tool_err)?)
                .map_err(tool_err)?;
        let round = review::ops::round_events(&state);
        let lines: Vec<Value> = hunks
            .iter()
            .flat_map(|(hunk, _)| review::ops::line_writers(hunk, round))
            .map(|(old, new, by)| json!({ "oldLine": old, "newLine": new, "by": by }))
            .collect();
        let total_chars = diff.chars().count();
        let offset = args.offset.unwrap_or(0).min(total_chars);
        let limit = args.limit.unwrap_or(16_000).clamp(1, 16_000);
        let page: String = diff.chars().skip(offset).take(limit).collect();
        Ok(Json(json!({
            "id": id,
            "baselineCreatedAt": baseline_created_at,
            "diff": page,
            "writers": lines,
            "offset": offset,
            "totalChars": total_chars,
            "nextOffset": (offset + limit < total_chars).then_some(offset + limit),
        })))
    }

    #[tool(
        description = "Read paginated manuscript edit events with actor ('author' or 'agent'), the agent name for Agent edits, changed before/after spans and timestamps. Use with review_changes for provenance; this never confirms revisions.",
        annotations(read_only_hint = true)
    )]
    async fn review_edit_history(
        &self,
        Parameters(args): Parameters<ReviewEditHistoryArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let dir = review::checked_unit_dir_pub(&vault, &id).map_err(tool_err)?;
        let state = review::load_state(&dir).map_err(tool_err)?;
        let edits: Vec<_> = state
            .events
            .iter()
            .filter(|e| e.kind == "edit" || e.kind == "external-change")
            .collect();
        let offset = args.offset.unwrap_or(0).min(edits.len());
        let limit = args.limit.unwrap_or(20).clamp(1, 100);
        let page = edits
            .iter()
            .skip(offset)
            .take(limit)
            .map(|e| {
                json!({
                    "id": e.id,
                    "kind": e.kind,
                    "actor": e.actor,
                    "agent": e.agent,
                    "createdAt": e.created_at,
                    "before": e.before,
                    "after": e.after,
                    "prefix": e.prefix,
                    "suffix": e.suffix,
                })
            })
            .collect::<Vec<_>>();
        Ok(Json(json!({
            "id": id,
            "edits": page,
            "offset": offset,
            "total": edits.len(),
            "nextOffset": (offset + limit < edits.len()).then_some(offset + limit),
        })))
    }

    /// The manuscript source of one review.
    #[tool(
        description = "Read the current manuscript Markdown of a review workspace. Returns the exact source; the review's comments live in review.json, not in the text.",
        annotations(read_only_hint = true)
    )]
    async fn review_manuscript(
        &self,
        Parameters(args): Parameters<ReviewIdArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let dir = review::reviews_root(&vault).join(&id);
        let manuscript = std::fs::read_to_string(review::manuscript_path(&dir))
            .map_err(|e| tool_err(AppError::message(format!("cannot read manuscript: {e}"))))?;
        Ok(Json(
            json!({ "id": id, "manuscript": manuscript, "hash": review::store::sha256_hex(&manuscript) }),
        ))
    }

    #[tool(
        description = "Create a new review manuscript in this vault. Does not confirm any revisions."
    )]
    async fn review_create(
        &self,
        Parameters(args): Parameters<ReviewCreateArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let root = vault.clone();
        let unit = self
            .mutate(&vault, None, move || {
                review::create_unit(&root, &args.title)
            })
            .await
            .map_err(tool_err)?;
        Ok(Json(
            json!({ "id": unit.id, "title": unit.title, "path": unit.path }),
        ))
    }

    #[tool(
        description = "Import explicitly specified local PDF, Markdown, TeX or text manuscripts into reviews/."
    )]
    async fn review_import(
        &self,
        Parameters(args): Parameters<ReviewImportArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let root = vault.clone();
        let units = self
            .mutate(&vault, None, move || {
                review::import_files(&root, &args.file_paths)
            })
            .await
            .map_err(tool_err)?;
        Ok(Json(json!({ "reviews": units.iter().map(|unit| json!({
            "id": unit.id, "title": unit.title, "hasPdf": unit.has_pdf,
            "bodyParsed": unit.body_parsed
        })).collect::<Vec<_>>() })))
    }

    #[tool(
        description = "Parse an unparsed imported PDF into manuscript.md and initialize its baseline. Cannot re-parse an existing manuscript or confirm revisions."
    )]
    async fn review_parse_pdf(
        &self,
        Parameters(args): Parameters<ReviewIdArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let root = vault.clone();
        let name = id.clone();
        let cache = self
            .running_app()
            .map_err(tool_err)?
            .state::<ReviewEditCache>()
            .inner()
            .clone();
        let state = self
            .mutate(&vault, None, move || {
                let dir = review::checked_unit_dir_pub(&root, &name)?;
                let state = review::load_state(&dir)?;
                if state.body_parsed {
                    return Err(AppError::message(
                        "manuscript already parsed; only the author can re-parse it",
                    ));
                }
                if review::read_manuscript(&dir)? != state.baseline_text
                    || state
                        .events
                        .iter()
                        .any(|event| event.kind == "edit" || event.kind == "external-change")
                {
                    return Err(AppError::message(
                        "manuscript has edits; PDF parsing would overwrite them",
                    ));
                }
                let pdf = review::find_unit_pdf_name(&dir, state.pdf_file.as_deref())
                    .ok_or_else(|| AppError::message("no PDF file in this review unit"))?;
                let markdown = tauri::async_runtime::block_on(
                    edda_core::features::paper::analyze::parse::parse_pdf_to_dir(
                        &dir.join(pdf),
                        &dir,
                        review::MANUSCRIPT_FILE,
                        None,
                    ),
                )?;
                let state = review::apply_parsed_pdf_body(&root, &name, &markdown)?;
                cache.set(&root.to_string_lossy(), &name, markdown);
                Ok(state)
            })
            .await
            .map_err(tool_err)?;
        Ok(Json(
            json!({ "id": state.id, "bodyParsed": state.body_parsed }),
        ))
    }

    #[tool(
        description = "Rename one review unit's display title without moving its manuscript or confirming revisions."
    )]
    async fn review_rename(
        &self,
        Parameters(args): Parameters<ReviewRenameArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let root = vault.clone();
        let unit = self
            .mutate(&vault, None, move || {
                review::rename_unit(&root, &id, &args.title)
            })
            .await
            .map_err(tool_err)?;
        Ok(Json(json!({ "id": unit.id, "title": unit.title })))
    }

    #[tool(
        description = "Add an AI-authored review comment to an exact manuscript quote or a PDF page, recorded under this connection's agent name. This is a comment, not a manuscript revision."
    )]
    async fn review_comment_add(
        &self,
        Parameters(args): Parameters<ReviewCommentAddArgs>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<Json<Value>, CallToolResult> {
        let agent = caller_agent(&ctx).map(|caller| caller.agent);
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let source = match args.source.as_deref().unwrap_or("manuscript") {
            "manuscript" => review::model::CommentSource::Manuscript,
            "pdf" => review::model::CommentSource::Pdf,
            _ => {
                return Err(tool_err(AppError::message(
                    "source must be manuscript or pdf",
                )))
            }
        };
        let input = review::ReviewCommentInput {
            block_id: args.block_id,
            quote: args.quote,
            source,
            page: args.page,
            prefix: args.prefix.unwrap_or_default(),
            suffix: args.suffix.unwrap_or_default(),
            heading: args.heading.unwrap_or_default(),
            body: args.body,
        };
        let root = vault.clone();
        let state = self
            .mutate(&vault, None, move || {
                review::ops::add_comment_as(&root, &id, &input, "agent", agent.as_deref())
            })
            .await
            .map_err(tool_err)?;
        let comment = state.comments.last().expect("comment was added");
        Ok(Json(
            json!({ "id": state.id, "comment": comment_row(comment) }),
        ))
    }

    #[tool(
        description = "Reply, edit, resolve, reopen, delete or restore a review comment as AI. Any Agent may reply to any comment; edit, resolve, reopen, delete and restore of a comment written by another Agent are refused (reply instead). With replyId, `edit` changes and `delete` removes one of your own replies; other writers' replies are refused. Does not confirm manuscript revisions."
    )]
    async fn review_comment_update(
        &self,
        Parameters(args): Parameters<ReviewCommentUpdateArgs>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<Json<Value>, CallToolResult> {
        let agent = caller_agent(&ctx).map(|caller| caller.agent);
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let action = match args.action.as_str() {
            "reply" => CommentAction::Reply,
            "edit" => CommentAction::Edit,
            "resolve" => CommentAction::Resolve,
            "reopen" => CommentAction::Reopen,
            "delete" => CommentAction::Delete,
            "restore" => CommentAction::Restore,
            _ => return Err(tool_err(AppError::message("invalid comment action"))),
        };
        let root = vault.clone();
        let comment_id = args.comment_id;
        let target_id = comment_id.clone();
        let name = id.clone();
        let state = self
            .mutate(&vault, None, move || match args.reply_id.as_deref() {
                Some(reply_id) => review::ops::update_reply_as(
                    &root,
                    &name,
                    &target_id,
                    reply_id,
                    action,
                    args.body.as_deref(),
                    "agent",
                    agent.as_deref(),
                ),
                None => review::ops::update_comment_as(
                    &root,
                    &name,
                    &target_id,
                    action,
                    args.body.as_deref(),
                    args.expected_updated_at.as_deref(),
                    "agent",
                    agent.as_deref(),
                ),
            })
            .await
            .map_err(tool_err)?;
        let comment = state
            .comments
            .iter()
            .find(|c| c.id == comment_id)
            .expect("comment was updated");
        Ok(Json(
            json!({ "id": state.id, "comment": comment_row(comment) }),
        ))
    }

    #[tool(
        description = "Replace one unique, exact excerpt of the current manuscript with AI-authored text. Requires the hash from review_manuscript; refuses stale or ambiguous replacements. Records an AI revision under this connection's agent name without changing the review baseline. Comments on the replaced text move onto the replacement and stay open."
    )]
    async fn review_manuscript_replace(
        &self,
        Parameters(args): Parameters<ReviewReplaceArgs>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<Json<Value>, CallToolResult> {
        let agent = caller_agent(&ctx).map(|caller| caller.agent);
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let root = vault.clone();
        let name = id.clone();
        let cache = self
            .running_app()
            .map_err(tool_err)?
            .state::<ReviewEditCache>()
            .inner()
            .clone();
        let (state, manuscript) = self
            .mutate(&vault, None, move || {
                let result = review::ops::replace_manuscript_as_agent(
                    &root,
                    &name,
                    &args.expected_hash,
                    &args.before,
                    &args.after,
                    agent.as_deref(),
                )?;
                cache.set(&root.to_string_lossy(), &name, result.1.clone());
                Ok(result)
            })
            .await
            .map_err(tool_err)?;
        Ok(Json(
            json!({ "id": state.id, "hash": review::store::sha256_hex(&manuscript), "baselineId": state.baseline_id }),
        ))
    }

    #[tool(
        description = "Export an independent review directory with manuscript, comments, events and revision snapshots. Read-only with respect to this vault."
    )]
    async fn review_export(
        &self,
        Parameters(args): Parameters<ReviewExportArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let id = resolve_unit(&vault, &args.r#ref).map_err(tool_err)?;
        let dest = std::path::PathBuf::from(args.dest_dir.trim());
        if !dest.is_dir() {
            return Err(tool_err(AppError::message("choose an existing folder")));
        }
        let root = vault.clone();
        let path =
            tauri::async_runtime::spawn_blocking(move || review::ops::export(&root, &id, &dest))
                .await
                .map_err(|e| {
                    tool_err(AppError::message(format!("review export join failed: {e}")))
                })?
                .map_err(tool_err)?;
        Ok(Json(json!({ "path": path })))
    }
}

impl EddaMcp {
    /// `review_read` for a caller that writes as `you`.
    #[allow(clippy::result_large_err)]
    fn read_review(
        &self,
        reference: &str,
        you: Option<Caller>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let id = resolve_unit(&vault, reference).map_err(tool_err)?;
        let (state, _manuscript) = load(&vault, &id).map_err(tool_err)?;
        Ok(Json(json!({
            "id": state.id,
            "title": state.title,
            "you": you.map(|caller| {
                let hint = (!caller.fixed).then_some(
                    "Your name comes from what your MCP client reports. Ask the user to add ?agent=<YourName> to the Edda MCP address so all your work is signed with one fixed name.",
                );
                json!({ "agent": caller.agent, "fixed": caller.fixed, "hint": hint })
            }),
            "baselineId": state.baseline_id,
            "rounds": state.revisions.len().saturating_sub(1),
            "open": state.open_count(),
            "resolved": state.resolved_count(),
            "comments": state.comments.iter().map(comment_row).collect::<Vec<_>>(),
        })))
    }
}

pub fn review_tools() -> rmcp::handler::server::router::tool::ToolRouter<EddaMcp> {
    EddaMcp::review_router()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_fixed_in_the_mcp_address_is_kept_as_written() {
        assert_eq!(
            agent_from_query("agent=Gemini%203%20Pro").as_deref(),
            Some("Gemini 3 Pro")
        );
        assert_eq!(
            agent_from_query("x=1&agent=Codex").as_deref(),
            Some("Codex")
        );
        assert_eq!(agent_from_query("agent=%20%E2%80%8B"), None);
        assert_eq!(agent_from_query("other=1"), None);
    }

    #[test]
    fn resolves_bare_id_and_path_forms() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = dir.path();
        review::create_unit(vault, "CVPR Sub").expect("create");
        assert_eq!(resolve_unit(vault, "cvpr-sub").unwrap(), "cvpr-sub");
        assert_eq!(
            resolve_unit(vault, "reviews/cvpr-sub/manuscript.md").unwrap(),
            "cvpr-sub"
        );
        assert!(resolve_unit(vault, "nope").is_err());
    }

    #[test]
    fn formats_changes_for_agent_without_changing_the_manuscript() {
        let dir = tempfile::tempdir().expect("tempdir");
        let unit = review::create_unit(dir.path(), "Draft").expect("create");
        let manuscript = review::manuscript_path(&review::reviews_root(dir.path()).join(&unit.id));
        std::fs::write(&manuscript, "before\n").unwrap();
        review::ops::checkpoint(dir.path(), &unit.id, None).unwrap();
        std::fs::write(&manuscript, "after\n").unwrap();
        let (hunks, _) = review::ops::attributed_diff(dir.path(), &unit.id).unwrap();
        let diff = format_changes(&hunks);
        assert!(diff.contains("-before\n"));
        assert!(diff.contains("+after\n"));
        assert_eq!(std::fs::read_to_string(&manuscript).unwrap(), "after\n");
    }

    #[test]
    fn includes_reply_text_for_agent_context() {
        let dir = tempfile::tempdir().expect("tempdir");
        let unit = review::create_unit(dir.path(), "Draft").expect("create");
        let manuscript = review::manuscript_path(&review::reviews_root(dir.path()).join(&unit.id));
        std::fs::write(&manuscript, "Needs work\n").unwrap();
        let state = review::ops::add_comment(
            dir.path(),
            &unit.id,
            &review::ReviewCommentInput {
                block_id: None,
                quote: "Needs work".into(),
                source: review::model::CommentSource::Manuscript,
                page: None,
                prefix: String::new(),
                suffix: String::new(),
                heading: String::new(),
                body: "Check claim".into(),
            },
        )
        .unwrap();
        let state = review::ops::update_comment(
            dir.path(),
            &unit.id,
            &state.comments[0].id,
            review::CommentAction::Reply,
            Some("Evidence added"),
            None,
        )
        .unwrap();
        let row = comment_row(&state.comments[0]);
        assert_eq!(row["replies"], 1);
        assert_eq!(row["replyThread"][0]["body"], "Evidence added");
    }

    #[test]
    fn agent_writes_are_exposed_but_baseline_confirmation_is_not() {
        for name in [
            "review_create",
            "review_import",
            "review_parse_pdf",
            "review_rename",
            "review_comment_add",
            "review_comment_update",
            "review_manuscript_replace",
            "review_export",
        ] {
            assert!(
                review_tools().get(name).is_some(),
                "missing MCP review tool {name}"
            );
        }
        for name in ["review_checkpoint", "review_apply_change", "review_accept"] {
            assert!(
                review_tools().get(name).is_none(),
                "agent cannot confirm revisions"
            );
        }
    }

    #[tokio::test]
    async fn revision_and_comment_round_trip_in_isolated_vault() {
        let vault = tempfile::tempdir().unwrap();
        let unit = review::create_unit(vault.path(), "Draft").unwrap();
        let dir = review::reviews_root(vault.path()).join(&unit.id);
        let original = "# Draft\n\n研究表明，旧结论缺乏依据。\n\n请补充论证。\n";
        std::fs::write(review::manuscript_path(&dir), original).unwrap();
        let baseline = review::ops::checkpoint(vault.path(), &unit.id, None).unwrap();
        let human_comment = review::ops::add_comment(
            vault.path(),
            &unit.id,
            &review::ReviewCommentInput {
                block_id: None,
                quote: "请补充论证".into(),
                source: review::model::CommentSource::Manuscript,
                page: None,
                prefix: String::new(),
                suffix: String::new(),
                heading: String::new(),
                body: "解释结论依据".into(),
            },
        )
        .unwrap();
        let human_id = human_comment.comments[0].id.clone();
        let (edited, next) = review::ops::replace_manuscript_as_agent(
            vault.path(),
            &unit.id,
            &review::store::sha256_hex(original),
            "旧结论",
            "新结论",
            None,
        )
        .unwrap();
        assert_eq!(edited.baseline_id, baseline.baseline_id);
        assert!(next.contains("新结论"));
        assert_eq!(
            edited.comments[0].anchor,
            review::model::AnchorStatus::Attached
        );
        assert!(review::ops::replace_manuscript_as_agent(
            vault.path(),
            &unit.id,
            &review::store::sha256_hex(original),
            "新结论",
            "另一结论",
            None
        )
        .is_err());

        let agent_comment = review::ops::add_comment_as(
            vault.path(),
            &unit.id,
            &review::ReviewCommentInput {
                block_id: None,
                quote: "新结论".into(),
                source: review::model::CommentSource::Manuscript,
                page: None,
                prefix: String::new(),
                suffix: String::new(),
                heading: String::new(),
                body: "请补证据".into(),
            },
            "agent",
            None,
        )
        .unwrap();
        let comment = &agent_comment.comments[1];
        assert_eq!(comment.actor, "agent");
        assert_eq!(comment.anchor, review::model::AnchorStatus::Attached);
        let resolved = review::ops::update_comment_as(
            vault.path(),
            &unit.id,
            &comment.id,
            CommentAction::Resolve,
            None,
            None,
            "agent",
            None,
        )
        .unwrap();
        let reopened = review::ops::update_comment_as(
            vault.path(),
            &unit.id,
            &comment.id,
            CommentAction::Reopen,
            None,
            None,
            "agent",
            None,
        )
        .unwrap();
        assert_eq!(resolved.comments[1].status, CommentStatus::Resolved);
        assert_eq!(reopened.comments[1].status, CommentStatus::Open);
        let replied = review::ops::update_comment_as(
            vault.path(),
            &unit.id,
            &human_id,
            CommentAction::Reply,
            Some("找到两篇相关文献"),
            None,
            "agent",
            None,
        )
        .unwrap();
        assert_eq!(replied.comments[0].actor, "author");
        assert_eq!(replied.comments[0].replies[0].actor, "agent");

        let ctrl = std::sync::Arc::new(super::super::McpController::new());
        ctrl.set_vault(Some(vault.path().to_string_lossy().into_owned()));
        let mcp = EddaMcp::new(ctrl);
        let args = || {
            Parameters(ReviewIdArgs {
                r#ref: unit.id.clone(),
            })
        };
        let Json(manuscript) = mcp.review_manuscript(args()).await.unwrap();
        assert_eq!(manuscript["manuscript"], next);
        assert_eq!(manuscript["hash"], review::store::sha256_hex(&next));
        let Json(changes) = mcp
            .review_changes(Parameters(ReviewChangesArgs {
                r#ref: unit.id.clone(),
                offset: None,
                limit: None,
            }))
            .await
            .unwrap();
        assert!(changes["diff"]
            .as_str()
            .unwrap()
            .contains("-研究表明，旧结论缺乏依据。"));
        assert!(changes["diff"]
            .as_str()
            .unwrap()
            .contains("+研究表明，新结论缺乏依据。"));
        let Json(history) = mcp
            .review_edit_history(Parameters(ReviewEditHistoryArgs {
                r#ref: unit.id.clone(),
                offset: None,
                limit: None,
            }))
            .await
            .unwrap();
        assert_eq!(history["edits"][0]["kind"], "external-change");
        assert_eq!(history["edits"][1]["actor"], "agent");
        let Json(review) = mcp.read_review(&args().0.r#ref, None).unwrap();
        assert_eq!(review["comments"][0]["actor"], "author");
        assert_eq!(review["comments"][1]["actor"], "agent");
        assert_eq!(
            review["comments"][0]["replyThread"][0]["body"],
            "找到两篇相关文献"
        );
        assert_eq!(review["baselineId"], baseline.baseline_id);

        // A direct on-disk revert is visible to MCP readers even before the
        // desktop review is reopened and the external event is persisted.
        std::fs::copy(
            dir.join(&baseline.revisions.last().unwrap().file),
            review::manuscript_path(&dir),
        )
        .unwrap();
        let Json(reverted) = mcp.read_review(&args().0.r#ref, None).unwrap();
        assert_eq!(reverted["open"], 1); // human comment still applies
        assert_eq!(reverted["comments"][1]["status"], "open");
        assert_eq!(reverted["comments"][1]["anchor"], "deleted");
        assert_eq!(reverted["comments"][1]["outdated"], true);
    }
}
