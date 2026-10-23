//! Structured research operations. No shell, executable discovery, or CLI grammar.
use super::{
    paper,
    tools::{tool_err, EddaMcp},
};
use crate::core::error::AppError;
use crate::features::jobs::{commands::start_or_hold, emit_job_changed, JobCenter, JobLane};
use edda_core::features::{catalog::papers, paper::discovery::pool, pdf::marks::service as marks};
use rmcp::{
    handler::server::wrapper::{Json, Parameters},
    model::CallToolResult,
    tool, tool_router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::Manager;

type Output = Result<Json<Value>, CallToolResult>;
fn read_source(
    vault: &Path,
    paper: &str,
    path: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, AppError> {
    let (dir, _) = edda_core::fs::resolve_paper_dir(vault, paper)?;
    let normalized = path.replace('\\', "/");
    let relative = edda_core::fs::sanitize_vault_rel(
        normalized
            .strip_prefix(&format!("{paper}/"))
            .unwrap_or(&normalized),
    )
    .map_err(AppError::message)?;
    let path = dir.join(&relative).canonicalize()?;
    if !path.starts_with(dir.canonicalize()?) {
        return Err(AppError::message("source path escapes paper"));
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["md", "markdown", "tex", "ltx", "txt", "bib", "json", "csv"].contains(&extension.as_str())
    {
        return Err(AppError::message("source must be a text file"));
    }
    let mut file = std::fs::File::open(path)?;
    if file.metadata()?.len() > 2 * 1024 * 1024 {
        return Err(AppError::message(
            "source exceeds 2 MiB; use native file tools",
        ));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    (&mut file)
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(AppError::message("source exceeds 2 MiB"));
    }
    let content = String::from_utf8(bytes).map_err(|e| AppError::message(e.to_string()))?;
    let total = content.chars().count();
    let text = content
        .chars()
        .skip(offset)
        .take(limit.clamp(1, 16000))
        .collect::<String>();
    let next = offset.saturating_add(text.chars().count());
    Ok(
        json!({"paperPath":paper,"path":relative,"offset":offset,"text":text,"nextOffset":(next<total).then_some(next)}),
    )
}
// The MCP SDK's wire error type is required by tool handlers.
#[allow(clippy::result_large_err)]
fn output<T: Serialize>(result: Result<T, AppError>) -> Output {
    result
        .and_then(|value| serde_json::to_value(value).map_err(AppError::from))
        .map(Json)
        .map_err(tool_err)
}

#[derive(Deserialize, schemars::JsonSchema)]
struct Reference {
    r#ref: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct SourceRead {
    r#ref: String,
    /// Paper-relative Markdown, TeX, text, bibliography or JSON file.
    path: String,
    /// Character offset, default zero.
    #[serde(default)]
    offset: usize,
    /// Maximum characters (capped at 16000).
    limit: Option<usize>,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct MarkId {
    r#ref: String,
    id: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct MarkList {
    r#ref: String,
    #[serde(default)]
    offset: usize,
    /// Defaults to 50, at most 200.
    limit: Option<usize>,
}

fn mark_summary(item: Value) -> Value {
    let mark = &item["mark"];
    let annotation = &mark["annotation"];
    let page = annotation["pageIndex"]
        .as_u64()
        .map(|page| page.saturating_add(1))
        .or_else(|| mark["page"].as_u64())
        .or_else(|| mark["anchor"]["page"].as_u64());
    let quote = annotation["custom"]["quote"]
        .as_str()
        .or_else(|| mark["quote"].as_str())
        .or_else(|| mark["anchor"]["quote"].as_str())
        .map(|text| text.chars().take(240).collect::<String>());
    json!({"id":item["id"],"kind":item["kind"],"page":page,"quote":quote})
}
#[derive(Deserialize, schemars::JsonSchema)]
struct MarkCreate {
    r#ref: String,
    options: marks::CreateMark,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct MarkUpdate {
    r#ref: String,
    id: String,
    comment: Option<String>,
    color: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct Tags {
    r#ref: String,
    tags: Vec<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct BibImport {
    content: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct BibExport {
    format: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct WikiScope {
    source: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
enum RepairKind {
    Aliases,
    VisualMarks,
    CatalogDuplicates,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct Repair {
    kind: RepairKind,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct MovePaper {
    r#ref: String,
    parent: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct PoolAdd {
    /// Versioned recommendation document; obtain its shape from pool_example.
    document: Value,
    /// Fill missing recommendation source names.
    by: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
enum PaperTaskKind {
    Download,
    ParseBody,
    ParseReferences,
    AnalyzeLayout,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct PaperTask {
    r#ref: String,
    kind: PaperTaskKind,
    #[serde(default)]
    force: bool,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct TaskId {
    id: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
struct Translation {
    text: String,
    #[serde(default = "target_zh")]
    to: String,
    #[serde(default = "source_auto")]
    from: String,
    provider: Option<String>,
}
fn target_zh() -> String {
    "zh-CN".into()
}
fn source_auto() -> String {
    "auto".into()
}

impl EddaMcp {
    pub(super) fn research_tools() -> rmcp::handler::server::router::tool::ToolRouter<Self> {
        Self::research_router()
    }
    fn paper_scope(
        &self,
        reference: &str,
        write: bool,
    ) -> Result<(PathBuf, papers::PaperRecord), AppError> {
        let vault = self.vault_for_tool(write)?;
        let paper = paper::resolve_paper(&vault, reference)?;
        edda_core::fs::resolve_paper_dir(&vault, &paper.path)?;
        Ok((vault, paper))
    }
    pub(super) fn running_app(&self) -> Result<tauri::AppHandle, AppError> {
        self.ctrl
            .app_handle()
            .ok_or_else(|| AppError::message("This operation requires the running application"))
    }
    fn pool_location(&self) -> String {
        self.ctrl
            .app_handle()
            .and_then(|app| {
                app.try_state::<crate::features::system::settings::AppSettingsStore>()
                    .and_then(|state| state.get().ok())
                    .map(|state| state.settings.paper_pool_location)
            })
            .unwrap_or_default()
    }
    pub(super) async fn mutate<T: Send + 'static>(
        &self,
        vault: &Path,
        paper: Option<&str>,
        operation: impl FnOnce() -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        let app = self.running_app()?;
        let center = app.state::<JobCenter>().inner().clone();
        center.run_filesystem_change(vault, paper, operation).await
    }
}

#[tool_router(router = research_router)]
impl EddaMcp {
    #[tool(
        description = "List existing text sources inside one paper for clients without native directory tools. Bounded scan; excludes code snapshots and symlinks.",
        annotations(read_only_hint = true)
    )]
    async fn paper_sources(
        &self,
        Parameters(args): Parameters<Reference>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, false).map_err(tool_err)?;
        let (dir, _) = edda_core::fs::resolve_paper_dir(&vault, &paper.path).map_err(tool_err)?;
        output(
            tauri::async_runtime::spawn_blocking(move || {
                let mut pending = vec![dir.clone()];
                let mut files = Vec::new();
                let mut seen = 0;
                while let Some(folder) = pending.pop() {
                    for entry in std::fs::read_dir(folder)? {
                        let entry = entry?;
                        seen += 1;
                        if seen > 2000 || files.len() >= 200 {
                            return Ok(
                                json!({"paperPath":paper.path,"files":files,"truncated":true}),
                            );
                        }
                        let kind = entry.file_type()?;
                        let path = entry.path();
                        if kind.is_dir()
                            && entry.file_name() != "code"
                            && !entry.file_name().to_string_lossy().starts_with('.')
                        {
                            pending.push(path);
                        } else if kind.is_file()
                            && path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                                ["md", "markdown", "tex", "ltx", "txt", "bib"]
                                    .contains(&e.to_ascii_lowercase().as_str())
                            })
                        {
                            files.push(
                                path.strip_prefix(&dir)
                                    .unwrap()
                                    .to_string_lossy()
                                    .replace('\\', "/"),
                            );
                        }
                    }
                }
                files.sort();
                Ok(json!({"paperPath":paper.path,"files":files,"truncated":false}))
            })
            .await
            .map_err(|e| tool_err(AppError::message(e.to_string())))?,
        )
    }
    #[tool(
        description = "Read a bounded slice of an existing paper source file. Useful for external clients without access to local files. Paths are relative to this paper; use paper_context for known source paths.",
        annotations(read_only_hint = true)
    )]
    async fn paper_read_source(
        &self,
        Parameters(args): Parameters<SourceRead>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, false).map_err(tool_err)?;
        output(read_source(
            &vault,
            &paper.path,
            &args.path,
            args.offset,
            args.limit.unwrap_or(8000),
        ))
    }
    #[tool(
        description = "Start a paper download, body parse, reference parse or layout analysis. Returns a task ID immediately; use task_get only when progress/results are needed."
    )]
    async fn paper_task_start(
        &self,
        Parameters(args): Parameters<PaperTask>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, true).map_err(tool_err)?;
        let app = self.running_app().map_err(tool_err)?;
        let center = app.state::<JobCenter>().inner().clone();
        let snapshot = match args.kind {
            PaperTaskKind::Download => {
                center
                    .enqueue_download_assets(&vault, &paper.path, JobLane::Normal, args.force)
                    .await
            }
            PaperTaskKind::ParseBody => {
                center
                    .enqueue_parse_body(&vault, &paper.path, JobLane::Normal, args.force, None)
                    .await
            }
            PaperTaskKind::ParseReferences => {
                center
                    .enqueue_parse_refs(&vault, &paper.path, JobLane::Normal, args.force)
                    .await
            }
            PaperTaskKind::AnalyzeLayout => {
                center
                    .enqueue_layout_analyze(&vault, &paper.path, JobLane::Normal, args.force)
                    .await
            }
        };
        output(Ok(start_or_hold(&app, &center, snapshot).await))
    }

    #[tool(
        description = "List tasks belonging to this workspace, including progress and errors.",
        annotations(read_only_hint = true)
    )]
    async fn task_list(&self) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let app = self.running_app().map_err(tool_err)?;
        let jobs = app.state::<JobCenter>().list(Some(&vault), None).await;
        output(Ok(json!({"items":jobs})))
    }

    #[tool(
        description = "Inspect one task in this workspace. On success, read its paper_context/layout/marks for the resulting resources.",
        annotations(read_only_hint = true)
    )]
    async fn task_get(
        &self,
        Parameters(args): Parameters<TaskId>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let app = self.running_app().map_err(tool_err)?;
        let job = app
            .state::<JobCenter>()
            .snapshot(&args.id)
            .await
            .filter(|j| Path::new(&j.vault_path) == vault)
            .ok_or_else(|| {
                tool_err(AppError::domain(
                    "task_not_found",
                    "Task not found in this workspace",
                ))
            })?;
        output(Ok(job))
    }

    #[tool(description = "Cancel a task belonging to this workspace.")]
    async fn task_cancel(
        &self,
        Parameters(args): Parameters<TaskId>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let app = self.running_app().map_err(tool_err)?;
        let center = app.state::<JobCenter>().inner().clone();
        if center
            .snapshot(&args.id)
            .await
            .is_none_or(|j| Path::new(&j.vault_path) != vault)
        {
            return Err(tool_err(AppError::domain(
                "task_not_found",
                "Task not found in this workspace",
            )));
        }
        let cancelled = center.cancel(&args.id).await;
        if let Some(snapshot) = center.snapshot(&args.id).await {
            emit_job_changed(&app, snapshot);
        }
        output(Ok(json!({"id":args.id,"cancelled":cancelled})))
    }

    #[tool(
        description = "List compact reading-mark summaries (id/kind/page/quote), with offset/limit pagination. Use mark_get for full content.",
        annotations(read_only_hint = true)
    )]
    async fn mark_list(
        &self,
        Parameters(args): Parameters<MarkList>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, false).map_err(tool_err)?;
        output(
            marks::list(&vault, &paper.path)
                .map(|items| {
                    let total=items.len();
                    let items=items.into_iter().skip(args.offset).take(args.limit.unwrap_or(50).clamp(1,200)).map(mark_summary).collect::<Vec<_>>();
                    let next=args.offset.saturating_add(items.len());
                    json!({"paperPath":paper.path,"items":items,"total":total,"nextOffset":(next<total).then_some(next)})
                }),
        )
    }
    #[tool(
        description = "Get a stored reading mark by ID.",
        annotations(read_only_hint = true)
    )]
    async fn mark_get(
        &self,
        Parameters(args): Parameters<MarkId>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, false).map_err(tool_err)?;
        output(marks::get(&vault, &paper.path, &args.id))
    }
    #[tool(
        description = "Create an explicitly requested highlight, question mark or translation mark. Geometry is resolved from an exact PDF quote or existing layout region; never provide invented coordinates."
    )]
    async fn mark_create(
        &self,
        Parameters(args): Parameters<MarkCreate>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, true).map_err(tool_err)?;
        let root = vault.clone();
        let path = paper.path.clone();
        output(
            self.mutate(&vault, Some(&paper.path), move || {
                tauri::async_runtime::block_on(marks::create(&root, &path, args.options))
            })
            .await,
        )
    }
    #[tool(description = "Update an existing reading mark's comment or highlight color.")]
    async fn mark_update(
        &self,
        Parameters(args): Parameters<MarkUpdate>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, true).map_err(tool_err)?;
        let root = vault.clone();
        let path = paper.path.clone();
        output(
            self.mutate(&vault, Some(&paper.path), move || {
                marks::update(
                    &root,
                    &path,
                    &args.id,
                    args.comment.as_deref(),
                    args.color.as_deref(),
                )
            })
            .await,
        )
    }
    #[tool(
        description = "Delete one reading mark only when the user requested its removal.",
        annotations(destructive_hint = true)
    )]
    async fn mark_delete(
        &self,
        Parameters(args): Parameters<MarkId>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, true).map_err(tool_err)?;
        let root = vault.clone();
        let path = paper.path.clone();
        output(
            self.mutate(&vault, Some(&paper.path), move || {
                marks::delete(&root, &path, &args.id)?;
                Ok(json!({"id":args.id,"deleted":true}))
            })
            .await,
        )
    }

    #[tool(
        description = "List the library's user tags and counts.",
        annotations(read_only_hint = true)
    )]
    async fn tag_list(&self) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let rows = papers::list_all(&vault).map_err(tool_err)?;
        let mut tags = std::collections::BTreeMap::<String, usize>::new();
        for row in rows {
            for tag in row.tags {
                if !papers::is_internal_tag_name(&tag.name) {
                    *tags.entry(tag.name).or_default() += 1;
                }
            }
        }
        output(Ok(json!({"tags":tags})))
    }
    #[tool(description = "Replace a paper's user tags; an empty array clears user tags.")]
    async fn paper_tag_set(
        &self,
        Parameters(args): Parameters<Tags>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, true).map_err(tool_err)?;
        let mut tags = args
            .tags
            .iter()
            .map(|tag| paper::parse_tag_spec(tag))
            .collect::<Result<Vec<_>, _>>()
            .map_err(tool_err)?;
        if tags
            .iter()
            .any(|tag| papers::is_internal_tag_name(&tag.name))
        {
            return Err(tool_err(AppError::message(
                "internal tags cannot be set by this tool",
            )));
        }
        tags.extend(
            paper
                .tags
                .iter()
                .filter(|tag| papers::is_internal_tag_name(&tag.name))
                .cloned(),
        );
        output(
            papers::set_tags(&vault, &paper.path, &tags)
                .map(|row| paper::PaperGetOut::from_record(&row)),
        )
    }
    #[tool(
        description = "Move a paper to the recycle bin. Does not permanently delete it.",
        annotations(destructive_hint = true)
    )]
    async fn paper_trash(
        &self,
        Parameters(args): Parameters<Reference>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, true).map_err(tool_err)?;
        let root = vault.clone();
        let path = paper.path.clone();
        output(
            self.mutate(&vault, Some(&paper.path), move || {
                edda_core::features::vault::trash::trash_paths(&root, &[path])
            })
            .await,
        )
    }

    #[tool(
        description = "Import supplied BibTeX, BibLaTeX or RIS text using the configured Translator."
    )]
    async fn import_bibliography(
        &self,
        Parameters(args): Parameters<BibImport>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let app = self.running_app().map_err(tool_err)?;
        let host = crate::features::host_hooks::wrap(&app);
        output(
            edda_core::features::zotero::import_catalog(
                edda_core::features::import::PaperImportArgs {
                    vault_path: vault.to_string_lossy().into_owned(),
                    parent_dir: Some("papers".into()),
                    content: args.content,
                    translator_base_url: self.ctrl.translator_url(),
                },
                Some(&host),
            )
            .await,
        )
    }
    #[tool(
        description = "Export the library as bibliography text (bibtex by default). Returns content for the caller to save.",
        annotations(read_only_hint = true)
    )]
    async fn export_bibliography(
        &self,
        Parameters(args): Parameters<BibExport>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        output(
            edda_core::features::zotero::export_catalog(
                edda_core::features::zotero::PaperExportArgs {
                    vault_path: vault.to_string_lossy().into_owned(),
                    format: args.format,
                    translator_base_url: self.ctrl.translator_url(),
                },
            )
            .await,
        )
    }

    #[tool(
        description = "Get the versioned recommendation document example.",
        annotations(read_only_hint = true)
    )]
    async fn pool_example(&self) -> Result<Json<Value>, CallToolResult> {
        self.vault_for_tool(false).map_err(tool_err)?;
        output(Ok(pool::example()))
    }
    #[tool(
        description = "Read recommendations from the paper-pool location configured in the application.",
        annotations(read_only_hint = true)
    )]
    async fn pool_list(&self) -> Result<Json<Value>, CallToolResult> {
        self.vault_for_tool(false).map_err(tool_err)?;
        output(pool::read(&self.pool_location()).await)
    }
    #[tool(
        description = "Submit verified paper recommendations to the configured paper pool for user review. Does not import into the library; a read-only HTTP source cannot accept submissions."
    )]
    async fn pool_submit(
        &self,
        Parameters(args): Parameters<PoolAdd>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.vault_for_tool(true).map_err(tool_err)?;
        let bytes = serde_json::to_vec(&args.document).map_err(|e| tool_err(e.into()))?;
        output(pool::add(&self.pool_location(), &bytes, args.by.as_deref()))
    }

    #[tool(
        description = "Diagnose the open workspace's catalog, aliases and reading-mark formats. Returns findings without changing files.",
        annotations(read_only_hint = true)
    )]
    async fn workspace_diagnose(&self) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        output(edda_core::features::doctor::diagnose(&vault))
    }
    #[tool(
        description = "Check Markdown links within the workspace or an optional Vault-relative source path.",
        annotations(read_only_hint = true)
    )]
    async fn wiki_diagnose(
        &self,
        Parameters(args): Parameters<WikiScope>,
    ) -> Result<Json<Value>, CallToolResult> {
        let vault = self.vault_for_tool(false).map_err(tool_err)?;
        let scope = args
            .source
            .as_deref()
            .map(edda_core::fs::sanitize_vault_rel)
            .transpose()
            .map_err(|e| tool_err(AppError::message(e)))?;
        output(
            tauri::async_runtime::spawn_blocking(move || {
                let mut index = edda_core::features::wiki::index::WikiIndex::default();
                let path = vault.to_string_lossy();
                index.rebuild(&path).map_err(AppError::message)?;
                Ok(index.check_links(&path, scope.as_deref()))
            })
            .await
            .map_err(|e| tool_err(AppError::message(e.to_string())))?,
        )
    }
    #[tool(
        description = "Apply one explicitly requested class of conservative repairs: missing aliases, legacy visual marks, or duplicate catalog rows. Open unsaved documents are protected."
    )]
    async fn workspace_repair(
        &self,
        Parameters(args): Parameters<Repair>,
    ) -> Result<Json<Value>, CallToolResult> {
        use edda_core::features::doctor;
        let vault = self.vault_for_tool(true).map_err(tool_err)?;
        let app = self.running_app().map_err(tool_err)?;
        let dirty = app
            .state::<crate::features::vault::doctor::DoctorDirtyPathsState>()
            .get(&vault.to_string_lossy())
            .map_err(|e| tool_err(AppError::message(e)))?;
        let root = vault.clone();
        output(
            self.mutate(&vault, None, move || {
                let report = doctor::diagnose(&root)?;
                match args.kind {
                    RepairKind::Aliases => {
                        let changes = report
                            .aliases
                            .candidates
                            .into_iter()
                            .filter(|c| c.fixable)
                            .map(|c| doctor::AliasRepairChange {
                                path: c.path,
                                title_alias: c.title_alias,
                                short_alias: c.short_alias,
                                expected_hash: c.expected_hash,
                            })
                            .collect::<Vec<_>>();
                        serde_json::to_value(
                            doctor::apply_alias_repairs(&root, &changes, &dirty)
                                .map_err(|e| AppError::message(e.message))?,
                        )
                        .map_err(AppError::from)
                    }
                    RepairKind::VisualMarks => {
                        let changes = report
                            .visual_marks
                            .candidates
                            .into_iter()
                            .filter(|c| c.fixable)
                            .map(|c| doctor::VisualMarkRepairChange { path: c.path })
                            .collect::<Vec<_>>();
                        serde_json::to_value(doctor::apply_visual_mark_repairs(
                            &root, &changes, &dirty,
                        )?)
                        .map_err(AppError::from)
                    }
                    RepairKind::CatalogDuplicates => {
                        serde_json::to_value(doctor::apply_catalog_duplicate_repairs(&root)?)
                            .map_err(AppError::from)
                    }
                }
            })
            .await,
        )
    }
    #[tool(
        description = "Move a paper to an allowed papers parent using the application's link-aware transaction. Flat paper storage rules still apply."
    )]
    async fn paper_move(
        &self,
        Parameters(args): Parameters<MovePaper>,
    ) -> Result<Json<Value>, CallToolResult> {
        let (vault, paper) = self.paper_scope(&args.r#ref, true).map_err(tool_err)?;
        let app = self.running_app().map_err(tool_err)?;
        let dirty = app
            .state::<crate::features::vault::doctor::DoctorDirtyPathsState>()
            .get(&vault.to_string_lossy())
            .map_err(|e| tool_err(AppError::message(e)))?;
        let index = app
            .state::<crate::features::vault::rename::WikiIndexState>()
            .handle();
        output(
            crate::features::paper::catalog::commands::paper_move_service(
                crate::features::paper::catalog::commands::PaperMoveArgs {
                    vault_path: vault.to_string_lossy().into_owned(),
                    from_rel: paper.path,
                    dest_parent_rel: args.parent,
                    dirty_paths: dirty,
                },
                index,
            )
            .await,
        )
    }
    #[tool(
        description = "Translate supplied text using the free translation providers. Does not create marks or notes.",
        annotations(read_only_hint = true)
    )]
    async fn translate_text(
        &self,
        Parameters(args): Parameters<Translation>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.vault_for_tool(false).map_err(tool_err)?;
        if args.text.len() > 64 * 1024 {
            return Err(tool_err(AppError::message("translation text is too large")));
        }
        use edda_core::features::translate::{translate_text, TranslateTextArgs, FREE_PROVIDERS};
        let provider = args.provider.as_deref().unwrap_or("tencenttransmart");
        if !FREE_PROVIDERS.contains(&provider) {
            return Err(tool_err(AppError::message(
                "Choose a supported free translation provider",
            )));
        }
        output(
            translate_text(TranslateTextArgs {
                text: args.text,
                source_lang: args.from,
                target_lang: args.to,
                provider: provider.into(),
                api_key: None,
                base_url: None,
                region: None,
                model: None,
                timeout_ms: None,
            })
            .await,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_index_does_not_dump_saved_conversations() {
        let summary = mark_summary(json!({"id":"a","kind":"ask","mark":{
            "anchor":{"page":3,"quote":"字".repeat(1000)},
            "messages":[{"content":"long conversation".repeat(1000)}]
        }}));
        assert_eq!(summary["page"], 3);
        assert_eq!(summary["quote"].as_str().unwrap().chars().count(), 240);
        assert!(summary.get("mark").is_none());
        assert!(summary.to_string().len() < 1000);
    }

    #[tokio::test]
    async fn tag_replacement_preserves_sync_tags_and_rejects_internal_input() {
        let temp = tempfile::tempdir().unwrap();
        edda_core::features::vault::create_vault(temp.path(), "en").unwrap();
        std::fs::create_dir_all(temp.path().join("papers/demo")).unwrap();
        papers::upsert_paper(
            temp.path(),
            &papers::PaperRecord::local_pdf("demo".into(), "Demo".into()).at_path("papers/demo"),
        )
        .unwrap();
        papers::set_tags(
            temp.path(),
            "papers/demo",
            &[
                papers::PaperTag::new("@zotero:item"),
                papers::PaperTag::new("old"),
            ],
        )
        .unwrap();
        let ctrl = std::sync::Arc::new(super::super::McpController::new());
        ctrl.set_vault(Some(temp.path().to_string_lossy().into_owned()));
        let server = EddaMcp::new(ctrl);
        server
            .paper_tag_set(Parameters(Tags {
                r#ref: "demo".into(),
                tags: vec!["new".into()],
            }))
            .await
            .unwrap();
        let tags = papers::get_by_path(temp.path(), "papers/demo")
            .unwrap()
            .unwrap()
            .tags;
        assert!(tags.iter().any(|t| t.name == "@zotero:item"));
        assert!(tags.iter().any(|t| t.name == "new"));
        assert!(!tags.iter().any(|t| t.name == "old"));
        assert!(server
            .paper_tag_set(Parameters(Tags {
                r#ref: "demo".into(),
                tags: vec!["@zotero:override".into()]
            }))
            .await
            .is_err());
    }

    #[test]
    fn source_reads_paginate_unicode_and_accept_returned_vault_paths() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("papers/demo")).unwrap();
        std::fs::write(temp.path().join("papers/demo/PAPER.md"), "甲乙😀丙").unwrap();
        let result = read_source(temp.path(), "papers/demo", "papers/demo/PAPER.md", 1, 2).unwrap();
        assert_eq!(result["text"], "乙😀");
        assert_eq!(result["nextOffset"], 3);
        assert!(read_source(temp.path(), "papers/demo", "../../outside.md", 0, 10).is_err());
    }
}
