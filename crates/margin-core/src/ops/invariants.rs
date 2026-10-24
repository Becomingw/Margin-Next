/// Transport-neutral rules, also published as an MCP resource.
pub fn agent_invariants_markdown() -> &'static str {
    r#"# Edda workspace operations

The application must be running with a local Vault open. Use the connected
MCP tool schemas as the operation contract; no executable setup is needed.

## Progressive disclosure

Use supplied quotations directly when sufficient. Otherwise, paper_context
returns known source paths, paper_read_source returns bounded text slices,
and paper_list provides a compact library index. Use native file/search tools
for source text when available. Read larger sources only as needed.

## Operations

- Metadata, tags, imports, reading marks and library changes use workspace tools.
- paper_task_start returns a job ID for downloads, parsing and layout analysis.
  task_get / task_list expose progress and errors; task_cancel cancels a job.
- pool_submit delivers recommendations to the configured pool for user review.
- Do not write SQLite, annotations.json or layout-index.json by hand.
- Only change notes, marks or read status for the user's requested action.
- Resolve marks from verbatim quotes or existing layout region IDs. Never invent coordinates.
- Preserve user-written notes and valid links. Use workspace_diagnose / wiki_diagnose when needed.
- A connection is scoped to its Vault. Unsupported operations must be reported,
  not emulated by guessing commands or bypassing the application's data rules.

The resource edda://vault describes the currently connected workspace.
"#
}
