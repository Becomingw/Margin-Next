//! Review workspace data model (`reviews/<id>/`).
//!
//! A review unit is an in-progress manuscript under review — the counterpart
//! of `papers/<id>/`, which holds finished literature. Review units never
//! join the catalog, never fetch remote metadata, and never convert into
//! papers. The manuscript is the plain Markdown source of truth; all review
//! state (comments, revisions, events) lives in `review.json` beside it.
//!
//! Anchors are block-id + quote pairs, not source offsets: the Plate editor
//! round-trip does not preserve byte positions, so a comment pins to an
//! Obsidian-style `^block-id` (inserted on demand) plus the exact selected
//! quote and its context for relocation when the text drifts.

use serde::{Deserialize, Serialize};

pub const REVIEW_FORMAT: &str = "edda-review";
pub const REVIEW_VERSION: u32 = 1;
pub const REVIEWS_ROOT: &str = "reviews";
pub const MANUSCRIPT_FILE: &str = "manuscript.md";
pub const STATE_FILE: &str = "review.json";
pub const REVISIONS_DIR: &str = "revisions";
pub const EXPORT_REVIEW_MD: &str = "REVIEW.md";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewState {
    pub format: String,
    pub version: u32,
    /// Stable unit id; equals the `reviews/<id>/` folder name.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default)]
    pub has_pdf: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_file: Option<String>,
    /// True once `manuscript.md` holds the full body (imported Markdown or parsed PDF).
    #[serde(default)]
    pub body_parsed: bool,
    pub created_at: String,
    /// Revision the current round compares against ("Original" baseline).
    pub baseline_id: String,
    /// Hash of the last manuscript content observed by review operations.
    /// Allows reopening a review to detect edits made directly on disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manuscript_hash: Option<String>,
    /// Snapshot text of `baseline_id`, read from `revisions/` on load so the
    /// editor can render Word-style inline Track Changes. Not saved in
    /// `review.json` (older files hold a copy, used when the snapshot is
    /// missing).
    #[serde(default)]
    pub baseline_text: String,
    #[serde(default)]
    pub revisions: Vec<Revision>,
    #[serde(default)]
    pub comments: Vec<ReviewComment>,
    #[serde(default)]
    pub events: Vec<ReviewEvent>,
    /// `review.json`'s size and modification time as this state was read or
    /// written, taken under the unit's lock. Not stored in the file.
    #[serde(skip)]
    pub stamp: String,
}

/// The review as the app's panel receives it (`review_open` and every write
/// command). Only this round's events are sent: the panel shows this round's
/// changes, while the whole history runs to hundreds of kilobytes and is
/// paged through by `review_edit_history`. The baseline text is sent only
/// when the panel may not have it.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewView {
    #[serde(flatten)]
    pub state: ReviewState,
    /// Every Agent that wrote in this review, in order of first appearance,
    /// so their colours stay put from round to round.
    pub agents: Vec<String>,
    /// Whether `baselineText` holds the baseline. When false the panel keeps
    /// the text it has for the same baseline revision hash.
    pub baseline_included: bool,
    /// See [`ReviewState::stamp`]: the panel skips reloading while
    /// `review.json` still has it (its own write echoing through the watcher).
    pub stamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub parent_id: Option<String>,
    /// SHA-256 of the snapshot file bytes.
    pub hash: String,
    pub created_at: String,
    /// Author-supplied round note; empty when not given.
    #[serde(default)]
    pub reason: String,
    /// Snapshot path relative to the unit dir, e.g. `revisions/rev-ab12cd.md`.
    pub file: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CommentStatus {
    Open,
    Resolved,
    Deleted,
}

impl CommentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AnchorStatus {
    /// Quote found inside its block (or block-less and unique).
    Attached,
    /// Quote found, but no longer inside its recorded block.
    Modified,
    /// Quote absent from the manuscript.
    Deleted,
    /// Quote occurs multiple times and context cannot disambiguate.
    Unlocated,
}

impl AnchorStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attached => "attached",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
            Self::Unlocated => "unlocated",
        }
    }
}

/// Which surface a comment is anchored to. `pdf` comments carry a page number
/// instead of a block id and are never relocated against the manuscript.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CommentSource {
    #[default]
    Manuscript,
    Pdf,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommentReply {
    pub id: String,
    pub body: String,
    pub created_at: String,
    /// Local author label, not an authenticated identity.
    pub actor: String,
    /// Name of the Agent that wrote this, as its MCP connection reported it
    /// (e.g. "Claude Code", "Codex"); absent for the author and older records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Last time its writer edited the body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    /// Trailing `^block-id` of the anchored block; inserted on demand.
    pub block_id: Option<String>,
    /// Exact selected text (never rewritten once created).
    pub quote: String,
    /// Anchoring surface: manuscript block, or a PDF page.
    #[serde(default)]
    pub source: CommentSource,
    /// 1-based PDF page for `source = "pdf"` comments.
    #[serde(default)]
    pub page: Option<u32>,
    /// Text before the quote inside the block (relocation context).
    #[serde(default)]
    pub prefix: String,
    /// Text after the quote inside the block.
    #[serde(default)]
    pub suffix: String,
    /// Nearest heading above the anchor, for display.
    #[serde(default)]
    pub heading: String,
    pub body: String,
    /// Local author label; old comments predate attribution.
    #[serde(default = "default_author")]
    pub actor: String,
    /// Name of the Agent that wrote this, as its MCP connection reported it
    /// (e.g. "Claude Code", "Codex"); absent for the author and older records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Most recent body editor, if different from the original author.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_by: Option<String>,
    pub status: CommentStatus,
    pub anchor: AnchorStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub replies: Vec<CommentReply>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvent {
    pub id: String,
    /// `created` | `edit` | `external-change` | `comment-created` |
    /// `comment-reply` | `comment-edit` | `comment-resolve` |
    /// `comment-reopen` | `comment-delete` | `comment-restore` |
    /// `reply-edit` | `reply-delete` | `checkpoint`
    pub kind: String,
    pub created_at: String,
    /// Local author label.
    pub actor: String,
    /// Name of the Agent that wrote this, as its MCP connection reported it
    /// (e.g. "Claude Code", "Codex"); absent for the author and older records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_id: Option<String>,
    /// `reply-edit` / `reply-delete`: the reply within `comment_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_id: Option<String>,
    /// `edit` / `external-change` / `reply-edit`: replaced text and
    /// replacement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    /// Local context around an Agent-authored changed span, used to resolve
    /// repeated text without confusing it with the author's changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    /// `checkpoint`: the new baseline revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn default_author() -> String {
    "author".into()
}

/// Where a comment points after the author's edits, as the editor tracked
/// its range through them (Word-style): the text now in that range and its
/// context, saved together with the edit that moved it.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommentAnchor {
    pub comment_id: String,
    pub quote: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
}

/// Comment creation payload from the renderer.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommentInput {
    #[serde(default)]
    pub block_id: Option<String>,
    pub quote: String,
    #[serde(default)]
    pub source: CommentSource,
    /// 1-based page; required when `source` is `pdf`.
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(default)]
    pub heading: String,
    pub body: String,
}

/// Comment lifecycle actions for `review_comment_update`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CommentAction {
    Reply,
    Edit,
    Resolve,
    Reopen,
    Delete,
    Restore,
}

/// `reviews/<id>/` row for the file tree, library table, and openers.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewUnitSummary {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    /// Absolute unit dir.
    pub path: String,
    /// Absolute `manuscript.md` path (the primary tab target).
    pub manuscript_path: String,
    /// Absolute PDF path when a source PDF is present.
    pub pdf_path: Option<String>,
    pub has_pdf: bool,
    pub body_parsed: bool,
    pub open_count: u32,
    pub resolved_count: u32,
    pub created_at: String,
    /// Last event time, or creation time when empty.
    pub updated_at: String,
}

impl ReviewState {
    pub fn open_count(&self) -> u32 {
        self.comments
            .iter()
            .filter(|c| c.status == CommentStatus::Open && c.anchor != AnchorStatus::Deleted)
            .count() as u32
    }

    pub fn resolved_count(&self) -> u32 {
        self.comments
            .iter()
            .filter(|c| c.status == CommentStatus::Resolved)
            .count() as u32
    }

    pub fn updated_at(&self) -> String {
        self.events
            .last()
            .map(|e| e.created_at.clone())
            .unwrap_or_else(|| self.created_at.clone())
    }

    pub fn summary(
        &self,
        path: String,
        manuscript_path: String,
        pdf_path: Option<String>,
    ) -> ReviewUnitSummary {
        ReviewUnitSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            authors: self.authors.clone(),
            year: self.year,
            path,
            manuscript_path,
            has_pdf: self.has_pdf || pdf_path.is_some(),
            pdf_path,
            body_parsed: self.body_parsed,
            open_count: self.open_count(),
            resolved_count: self.resolved_count(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at(),
        }
    }
}

pub fn new_id(prefix: &str) -> String {
    let raw = uuid::Uuid::new_v4().simple().to_string();
    format!("{prefix}-{}", &raw[..8])
}

/// `name` without invisible characters and with single spaces, at most 40
/// characters. Clients have reported names with zero-width characters inside
/// ("gemi\u{200b}ni"), which defeat matching and split one Agent in two.
pub fn clean_agent_name(name: &str) -> String {
    let visible: String = name
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    c,
                    '\u{00AD}'
                        | '\u{200B}'..='\u{200F}'
                        | '\u{202A}'..='\u{202E}'
                        | '\u{2060}'..='\u{2064}'
                        | '\u{2066}'..='\u{2069}'
                        | '\u{FEFF}'
                )
        })
        .collect();
    let spaced = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    spaced.chars().take(40).collect()
}

/// Readable name for the Agent behind an MCP connection, from the `name` /
/// `title` its client reported (`claude-code` → "Claude Code",
/// `codex-mcp-client` → "Codex"). Unknown clients keep their own label with
/// transport suffixes removed; bare SDK defaults such as `rmcp` name no one
/// and read "Agent". A name fixed in the MCP address wins over all of this.
/// Names are labels, not authenticated identities.
pub fn agent_display_name(reported: &str) -> String {
    let raw = clean_agent_name(reported);
    let raw = raw.as_str();
    let key = raw.to_ascii_lowercase();
    const GENERIC: [&str; 7] = [
        "rmcp",
        "mcp",
        "mcp-client",
        "mcp client",
        "client",
        "unknown",
        "agent",
    ];
    if GENERIC.contains(&key.as_str()) {
        return "Agent".to_string();
    }
    const KNOWN: [(&str, &str); 13] = [
        ("claude-code", "Claude Code"),
        ("claude code", "Claude Code"),
        ("claude", "Claude"),
        ("codex", "Codex"),
        ("antigravity", "Antigravity"),
        ("gemini-cli", "Gemini CLI"),
        ("gemini cli", "Gemini CLI"),
        ("gemini", "Gemini"),
        ("cursor", "Cursor"),
        ("opencode", "OpenCode"),
        ("qoder", "Qoder"),
        ("kimi", "Kimi Code"),
        ("grok", "Grok"),
    ];
    if let Some((_, name)) = KNOWN.iter().find(|(needle, _)| key.contains(needle)) {
        return (*name).to_string();
    }
    let trimmed = ["-mcp-client", "_mcp_client", "-client", " mcp client"]
        .iter()
        .find_map(|suffix| {
            key.ends_with(suffix)
                .then(|| raw[..raw.len() - suffix.len()].trim())
        })
        .unwrap_or(raw);
    if trimmed.is_empty() {
        "Agent".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod agent_name_tests {
    use super::{agent_display_name, clean_agent_name};

    #[test]
    fn names_known_and_unknown_clients() {
        assert_eq!(agent_display_name("claude-code"), "Claude Code");
        assert_eq!(agent_display_name("claude-ai"), "Claude");
        assert_eq!(agent_display_name("codex-mcp-client"), "Codex");
        assert_eq!(agent_display_name("Antigravity"), "Antigravity");
        assert_eq!(agent_display_name("my-reviewer-client"), "my-reviewer");
        assert_eq!(agent_display_name("  "), "Agent");
        assert_eq!(agent_display_name("gemi\u{200b}ni 4"), "Gemini");
        assert_eq!(agent_display_name("gemi\u{200b}ni4"), "Gemini");
        assert_eq!(agent_display_name("gemini-cli-mcp-client"), "Gemini CLI");
        assert_eq!(agent_display_name("rmcp"), "Agent");
        assert_eq!(clean_agent_name(" Gemini\u{200b} 3  Pro "), "Gemini 3 Pro");
        // Already normalized names stay as they are.
        for name in ["Claude Code", "Codex", "Gemini", "Kimi Code", "my-reviewer"] {
            assert_eq!(agent_display_name(name), name);
        }
    }
}
