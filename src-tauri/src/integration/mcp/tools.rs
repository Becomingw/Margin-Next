//! MCP tools + ServerHandler.

use super::icons;
use super::layout;
use super::notes::{self, WriteMode};
use super::paper;
use super::resources::{
    self, INVARIANTS_NAME, INVARIANTS_URI, SKILL_NAME, SKILL_URI, VAULT_NAME, VAULT_URI,
};
use super::McpController;
use crate::core::error::AppError;
use crate::features::agent::acp::interaction::PermissionPolicy;
use crate::features::agent::session::handlers::{snapshot_turn, TurnRegistry};
use crate::features::paper::catalog::{self, papers};
use crate::features::paper::import::{self, LookupImportArgs, NoteShellMode};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, ListResourcesResult, PaginatedRequestParams,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource,
    ResourceContents, ServerCapabilities, ServerInfo,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Manager;

#[derive(Clone)]
pub struct EddaMcp {
    pub ctrl: Arc<McpController>,
    pub(super) turns: Option<TurnRegistry>,
    tool_router: ToolRouter<Self>,
}

impl EddaMcp {
    pub fn new(ctrl: Arc<McpController>) -> Self {
        let tool_router = Self::tool_router();
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        let tool_router = tool_router + Self::research_tools() + Self::browse_tools();
        let mut tool_router = tool_router
            + super::review::review_tools()
            + super::settings::tools()
            + super::diagnostics::tools();
        // Json<Value> generates an unconstrained schema, which is not an MCP
        // outputSchema (its root must describe an object). Output schemas are
        // optional even with structuredContent: omit unknown contracts rather
        // than inventing properties, and preserve typed tool schemas verbatim.
        for route in tool_router.map.values_mut() {
            if route.attr.output_schema.as_ref().is_some_and(|schema| {
                schema
                    .keys()
                    .all(|key| matches!(key.as_str(), "$schema" | "title" | "description"))
            }) {
                route.attr.output_schema = None;
            }
        }
        Self {
            ctrl,
            turns: None,
            tool_router,
        }
    }

    pub(crate) fn with_turns(ctrl: Arc<McpController>, turns: Option<TurnRegistry>) -> Self {
        let mut server = Self::new(ctrl);
        server.turns = turns;
        server
    }

    /// Connections Edda opened for its own agents (not the external port).
    pub(super) fn in_app(&self) -> bool {
        self.turns.is_some()
    }

    pub(super) fn vault_for_tool(&self, write: bool) -> Result<std::path::PathBuf, AppError> {
        if write {
            self.authorize_mutation()?;
        }
        self.ctrl.local_vault()
    }

    pub(super) fn authorize_mutation(&self) -> Result<(), AppError> {
        if let Some(turns) = &self.turns {
            let policy = snapshot_turn(turns).map(|turn| turn.permission_policy);
            authorize_workspace_tool(policy, true)?;
        }
        Ok(())
    }
}

fn authorize_workspace_tool(policy: Option<PermissionPolicy>, write: bool) -> Result<(), AppError> {
    // Authenticated read access is also useful while a native agent initializes
    // its workspace. Mutations always require an active, writable turn.
    if !write {
        return Ok(());
    }
    match policy {
        None => Err(AppError::message(
            "This workspace connection has no active task",
        )),
        Some(PermissionPolicy::Restricted) if write => Err(AppError::message(
            "Workspace changes are disabled by the current permission mode",
        )),
        // Ask-mode approvals are handled by the native agent through ACP, just
        // like its file/shell tools; do not add a second approval ceremony.
        Some(_) => Ok(()),
    }
}

pub(super) fn tool_err(err: AppError) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(
        serde_json::json!({
            "code": err.code(),
            "message": err.to_string(),
        })
        .to_string(),
    )])
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperListArgs {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    tag: Vec<String>,
    #[serde(default)]
    unread: bool,
    #[serde(default)]
    limit: Option<u32>,
    /// Extra fields on top of id/path/title (e.g. year, tags, authors, isRead).
    #[serde(default)]
    fields: Vec<String>,
    /// Emit the previous full metadata row shape.
    #[serde(default)]
    full: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperRefArgs {
    /// Paper id or vault-relative folder path (`papers/…`).
    r#ref: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperSetReadArgs {
    /// Paper id or vault-relative folder path (`papers/…`).
    r#ref: String,
    /// Default true.
    #[serde(default = "default_true")]
    is_read: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LayoutListArgs {
    r#ref: String,
    /// Filter kinds: figure|image|chart|table|algorithm|formula (OR).
    #[serde(default)]
    kind: Vec<String>,
    #[serde(default)]
    min_score: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LayoutGetArgs {
    r#ref: String,
    /// Region id from layout_list (e.g. figure-3).
    id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ImportIdArgs {
    /// arXiv id, DOI, or URL.
    text: String,
    /// Vault-relative parent under `papers/` (default: current Library scope).
    #[serde(default)]
    parent: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct NotesWriteArgs {
    r#ref: String,
    content: String,
    /// `replace` (default) or `append`.
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TagArgs {
    r#ref: String,
    tags: Vec<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ImportIdOut {
    paper_dir: String,
    path: String,
    id: String,
    title: String,
    used_translator: bool,
    translator_base_url: String,
    pdf: bool,
    tex: bool,
    paper_md: bool,
    asset_messages: Vec<String>,
}

impl From<import::LookupImportResult> for ImportIdOut {
    fn from(r: import::LookupImportResult) -> Self {
        Self {
            paper_dir: r.paper_dir,
            path: r.path,
            id: r.id,
            title: r.title,
            used_translator: r.used_translator,
            translator_base_url: r.translator_base_url,
            pdf: r.pdf,
            tex: r.tex,
            paper_md: r.paper_md,
            asset_messages: r.asset_messages,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct NotesGetOut {
    /// Vault-relative paper folder.
    r#ref: String,
    id: String,
    content: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct NotesWriteOut {
    r#ref: String,
    id: String,
    mode: String,
}

fn clamp_limit(raw: Option<u32>) -> usize {
    raw.unwrap_or(50).clamp(1, 200) as usize
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspaceContextOut {
    version: String,
    capabilities: WorkspaceCapabilities,
    vault: String,
    papers: usize,
    unread: usize,
    workflow: Option<String>,
    task_target: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCapabilities {
    review: bool,
    tasks: bool,
    browse: bool,
    settings_read: bool,
    settings_write: bool,
    baseline_confirmation: bool,
}

#[tool_router]
impl EddaMcp {
    #[tool(
        description = "Inspect this conversation's research workspace and task target when the supplied context is insufficient. Returns counts, not the whole library. No need to call this before every question.",
        annotations(read_only_hint = true)
    )]
    async fn workspace_context(&self) -> Result<Json<WorkspaceContextOut>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let rows = papers::list_all(&vault).map_err(tool_err)?;
        let turn = self.turns.as_ref().and_then(snapshot_turn);
        Ok(Json(WorkspaceContextOut {
            version: env!("CARGO_PKG_VERSION").into(),
            capabilities: WorkspaceCapabilities {
                review: self.tool_router.has_route("review_read"),
                tasks: self.ctrl.app_handle().is_some() && self.tool_router.has_route("task_get"),
                browse: self.in_app()
                    && self.ctrl.app_handle().is_some()
                    && self.tool_router.has_route("browse_tabs"),
                settings_read: self.ctrl.app_handle().is_some(),
                settings_write: self.ctrl.app_handle().is_some(),
                baseline_confirmation: false,
            },
            vault: vault.to_string_lossy().into_owned(),
            papers: rows.len(),
            unread: rows.iter().filter(|row| !row.is_read).count(),
            workflow: turn.as_ref().and_then(|turn| turn.ctx.workflow.clone()),
            task_target: turn.and_then(|turn| turn.ctx.task_target.clone()),
        }))
    }

    #[tool(
        description = "Get a paper's metadata and existing local source paths (PDF, parsed body, notes, TeX directory). Use the returned paths with your native file/search tools; this does not parse, download or read the full paper.",
        annotations(read_only_hint = true)
    )]
    async fn paper_context(
        &self,
        Parameters(args): Parameters<PaperRefArgs>,
    ) -> Result<Json<paper::PaperContextOut>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        paper::paper_context(&vault, &args.r#ref)
            .map(Json)
            .map_err(tool_err)
    }

    #[tool(
        description = "List papers in the open vault. Default rows are only id/path/title (token-cheap). Pass fields (year, tags, authors, isRead, …) or full=true for more. Abstract is only on paper_get.",
        annotations(read_only_hint = true)
    )]
    async fn paper_list(
        &self,
        Parameters(args): Parameters<PaperListArgs>,
    ) -> Result<Json<paper::PaperListOut>, CallToolResult> {
        let vault = match self.vault_for_tool(false) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match paper::list_papers(
            &vault,
            args.query.as_deref(),
            &args.tag,
            args.unread,
            clamp_limit(args.limit),
            &args.fields,
            args.full,
        ) {
            Ok(items) => Ok(Json(paper::PaperListOut { items })),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Get one paper's full catalog metadata by id or vault-relative path.",
        annotations(read_only_hint = true)
    )]
    async fn paper_get(
        &self,
        Parameters(args): Parameters<PaperRefArgs>,
    ) -> Result<Json<paper::PaperGetOut>, CallToolResult> {
        let vault = match self.vault_for_tool(false) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match paper::get_paper(&vault, &args.r#ref) {
            Ok(row) => Ok(Json(row)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(description = "Import a paper into the vault by arXiv id, DOI, or URL (magic wand).")]
    async fn import_id(
        &self,
        Parameters(args): Parameters<ImportIdArgs>,
    ) -> Result<Json<ImportIdOut>, CallToolResult> {
        let vault = match self.vault_for_tool(true) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let parent = args
            .parent
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.ctrl.parent_dir());
        let parent = match import::normalize_parent_dir(&parent) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        let import_args = LookupImportArgs {
            vault_path: vault.to_string_lossy().to_string(),
            parent_dir: parent,
            text: args.text,
            translator_base_url: self.ctrl.translator_url(),
            task_id: None,
        };
        let note_mode = NoteShellMode::parse(&self.ctrl.paper_note_mode());
        let result = if let Some(app) = self.ctrl.app_handle() {
            let cache = app.try_state::<catalog::CapsCache>();
            let host_app = crate::features::host_hooks::wrap(&app);
            import::import_by_identifier_with_progress(
                import_args,
                Some(&host_app),
                cache.as_ref().map(|s| s.inner()),
                note_mode,
            )
            .await
        } else {
            import::import_by_identifier_with_progress(import_args, None, None, note_mode).await
        };
        match result {
            Ok(r) => Ok(Json(ImportIdOut::from(r))),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Read NOTES.md for a paper (id or vault-relative path). Empty string if the file does not exist.",
        annotations(read_only_hint = true)
    )]
    async fn paper_notes_get(
        &self,
        Parameters(args): Parameters<PaperRefArgs>,
    ) -> Result<Json<NotesGetOut>, CallToolResult> {
        let vault = match self.vault_for_tool(false) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let paper = match paper::resolve_paper(&vault, &args.r#ref) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        match notes::read_notes(&vault, &paper.path) {
            Ok(text) => Ok(Json(NotesGetOut {
                r#ref: paper.path,
                id: paper.id,
                content: text,
            })),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Write NOTES.md for a paper. mode=replace (default) keeps existing YAML frontmatter unless content includes its own; mode=append adds to the body."
    )]
    async fn paper_notes_write(
        &self,
        Parameters(args): Parameters<NotesWriteArgs>,
    ) -> Result<Json<NotesWriteOut>, CallToolResult> {
        let vault = match self.vault_for_tool(true) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let paper = match paper::resolve_paper(&vault, &args.r#ref) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        let mode = match args.mode.as_deref().map(str::trim).unwrap_or("replace") {
            "" | "replace" => WriteMode::Replace,
            "append" => WriteMode::Append,
            other => {
                return Err(tool_err(AppError::message(format!(
                    "mode must be replace or append, got {other}"
                ))));
            }
        };
        match notes::write_notes(&vault, &paper.path, &paper.id, &args.content, mode) {
            Ok(()) => Ok(Json(NotesWriteOut {
                r#ref: paper.path,
                id: paper.id,
                mode: match mode {
                    WriteMode::Replace => "replace".into(),
                    WriteMode::Append => "append".into(),
                },
            })),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(description = "Add tags to a paper. Names may use a color suffix like topic:blue.")]
    async fn paper_tag_add(
        &self,
        Parameters(args): Parameters<TagArgs>,
    ) -> Result<Json<paper::PaperGetOut>, CallToolResult> {
        let vault = match self.vault_for_tool(true) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let paper = match paper::resolve_paper(&vault, &args.r#ref) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        let parsed: Result<Vec<_>, _> =
            args.tags.iter().map(|t| paper::parse_tag_spec(t)).collect();
        let parsed = match parsed {
            Ok(t) => t,
            Err(e) => return Err(tool_err(e)),
        };
        match papers::add_tags(&vault, &paper.path, &parsed) {
            Ok(row) => Ok(Json(paper::PaperGetOut::from_record(&row))),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(description = "Remove tags from a paper (case-insensitive names).")]
    async fn paper_tag_rm(
        &self,
        Parameters(args): Parameters<TagArgs>,
    ) -> Result<Json<paper::PaperGetOut>, CallToolResult> {
        let vault = match self.vault_for_tool(true) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let paper = match paper::resolve_paper(&vault, &args.r#ref) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        let names: Vec<String> = args
            .tags
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        match papers::remove_tags(&vault, &paper.path, &names) {
            Ok(row) => Ok(Json(paper::PaperGetOut::from_record(&row))),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Set catalog is_read for a paper (does not run paper-reader). Default isRead=true."
    )]
    async fn paper_set_read(
        &self,
        Parameters(args): Parameters<PaperSetReadArgs>,
    ) -> Result<Json<paper::PaperGetOut>, CallToolResult> {
        let vault = match self.vault_for_tool(true) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match paper::set_read(&vault, &args.r#ref, args.is_read) {
            Ok(row) => Ok(Json(row)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "List sidebar layout regions (figures/tables/algorithms/formulas) from layout-index.json. Requires desktop layout analysis first.",
        annotations(read_only_hint = true)
    )]
    async fn layout_list(
        &self,
        Parameters(args): Parameters<LayoutListArgs>,
    ) -> Result<Json<layout::LayoutListOut>, CallToolResult> {
        let vault = match self.vault_for_tool(false) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match layout::list(&vault, &args.r#ref, &args.kind, args.min_score) {
            Ok(out) => Ok(Json(out)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Get one layout region by id (e.g. figure-3) from layout-index.json.",
        annotations(read_only_hint = true)
    )]
    async fn layout_get(
        &self,
        Parameters(args): Parameters<LayoutGetArgs>,
    ) -> Result<Json<layout::LayoutGetOut>, CallToolResult> {
        let vault = match self.vault_for_tool(false) {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match layout::get(&vault, &args.r#ref, &args.id) {
            Ok(out) => Ok(Json(out)),
            Err(e) => Err(tool_err(e)),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for EddaMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_instructions(concat!(
            "Edda research vault MCP (local vault; App must be open). ",
            "Use these workspace tools directly when needed; there is no setup or skill-loading prerequisite. ",
            "Use supplied quotations directly for translation and self-contained questions. ",
            "paper_context returns existing sources for your native file/search tools. ",
            "paper_list defaults to id/path/title only — pass fields or full when needed. ",
            "ref is a paper id or vault-relative path. Notes writes only touch NOTES.md. ",
            "Preserve user-written NOTES; replace their content only when the user requested replacement. ",
            "Answer the user's task naturally; do not narrate routine tool or skill selection. ",
            "Use paper_task_start/task_get for long operations, mark tools for annotations, and pool tools for recommendations. ",
            "Unsupported capabilities must be reported; never install a business CLI or modify application databases manually."
             , " workspace_context reports this version and available capabilities. For product/configuration/diagnostic questions, use product_reference and environment_inspect, settings_describe/settings_get/settings_set, and logs_list/logs_read. Settings writes are validated conditional patches with undo; query actual status after applying. Logs cover all retained application archives with pagination. Never read settings.json for credentials or edit it directly."
        ))
        .with_server_info(
            Implementation::new("edda", env!("CARGO_PKG_VERSION"))
                .with_title("Edda")
                .with_website_url("https://github.com/Becomingw/Edda")
                .with_icons(icons::server_icons()),
        )
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let icons = icons::server_icons();
        Ok(ListResourcesResult::with_all_items(vec![
            Resource::new(VAULT_URI, VAULT_NAME)
                .with_title("Current vault")
                .with_mime_type("text/markdown")
                .with_icons(icons.clone()),
            Resource::new(INVARIANTS_URI, INVARIANTS_NAME)
                .with_title("Agent invariants")
                .with_mime_type("text/markdown")
                .with_icons(icons.clone()),
            Resource::new(SKILL_URI, SKILL_NAME)
                .with_title("Workspace operation guidance")
                .with_mime_type("text/markdown")
                .with_icons(icons),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let Some((markdown, _mime)) = resources::read(&request.uri, &self.ctrl) else {
            return Err(McpError::resource_not_found(
                format!("unknown resource {}", request.uri),
                None,
            ));
        };
        Ok(
            ReadResourceResult::new(vec![ResourceContents::text(markdown, request.uri.clone())])
                .into(),
        )
    }
}

#[cfg(test)]
mod schema_tests {
    use super::EddaMcp;
    use crate::integration::mcp::McpController;
    use rmcp::ServerHandler;

    #[test]
    fn every_advertised_output_schema_has_an_object_root() {
        let mcp = EddaMcp::new(std::sync::Arc::new(McpController::new()));
        let tools = mcp.tool_router.list_all();
        assert!(tools.iter().any(|tool| tool.name == "review_manuscript"));
        for tool in &tools {
            if let Some(schema) = &tool.output_schema {
                assert_eq!(
                    schema.get("type").and_then(|v| v.as_str()),
                    Some("object"),
                    "{}",
                    tool.name
                );
            }
        }
        assert!(mcp
            .tool_router
            .get("review_manuscript")
            .unwrap()
            .output_schema
            .is_none());
        assert_eq!(
            mcp.tool_router.get("import_id").unwrap().output_schema,
            EddaMcp::import_id_tool_attr().output_schema,
        );
    }

    #[test]
    fn private_workspace_writes_need_an_active_writable_turn() {
        use super::{authorize_workspace_tool, PermissionPolicy};
        assert!(authorize_workspace_tool(None, false).is_ok());
        assert!(authorize_workspace_tool(None, true).is_err());
        assert!(authorize_workspace_tool(Some(PermissionPolicy::Restricted), true).is_err());
        assert!(authorize_workspace_tool(Some(PermissionPolicy::Ask), true).is_ok());
        assert!(authorize_workspace_tool(Some(PermissionPolicy::Auto), true).is_ok());
    }

    #[test]
    fn workspace_read_tools_advertise_native_read_only_hints() {
        for tool in [
            EddaMcp::workspace_context_tool_attr(),
            EddaMcp::paper_context_tool_attr(),
            EddaMcp::paper_list_tool_attr(),
        ] {
            assert_eq!(
                tool.annotations.and_then(|hints| hints.read_only_hint),
                Some(true)
            );
            assert!(tool.output_schema.is_some());
        }
    }

    #[test]
    fn import_id_advertises_output_schema() {
        let tool = EddaMcp::import_id_tool_attr();
        let schema = tool
            .output_schema
            .expect("import_id should advertise outputSchema");
        let props = schema
            .get("properties")
            .and_then(|v| v.as_object())
            .expect("object properties");
        for key in ["path", "id", "title", "pdf", "tex", "paperMd"] {
            assert!(props.contains_key(key), "missing {key} in {props:?}");
        }
    }

    #[test]
    fn server_info_includes_embedded_icons() {
        let mcp = EddaMcp::new(std::sync::Arc::new(McpController::new()));
        let info = mcp.get_info();
        let icons = info.server_info.icons.as_ref().expect("serverInfo.icons");
        assert!(!icons.is_empty());
        assert!(icons[0].src.starts_with("data:image/png;base64,"));
        assert_eq!(info.server_info.title.as_deref(), Some("Edda"));
    }
}
