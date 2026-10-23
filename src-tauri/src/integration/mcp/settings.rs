//! Application settings tools backed by the same store and reactions as Settings UI.
use super::tools::{tool_err, EddaMcp};
use crate::core::error::AppError;
use crate::features::system::settings::{access, AppSettingsStore};
use rmcp::{
    handler::server::wrapper::{Json, Parameters},
    model::CallToolResult,
    tool, tool_router,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::Manager;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SettingsReadArgs {
    /// Dotted field paths or sections; omitted/empty returns all settings, redacted.
    #[serde(default)]
    fields: Vec<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsPatchArgs {
    /// Exact writable dotted leaf paths from settings_describe, not a full snapshot.
    changes: Map<String, Value>,
    /// Last observed value for EVERY changed path. Conflicts fail without writing.
    expected: Map<String, Value>,
    /// Validate and preview the inverse patch without persisting.
    #[serde(default)]
    dry_run: bool,
}

#[tool_router(router = settings_tools)]
impl EddaMcp {
    #[tool(
        description = "Describe ALL settings of this running Edda version: schema, writable leaf paths, constraints, hot-apply timing and read-only boundaries. Credentials are never returned. Query before changing configuration.",
        annotations(read_only_hint = true)
    )]
    async fn settings_describe(&self) -> Result<Json<Value>, CallToolResult> {
        Ok(Json(access::describe()))
    }

    #[tool(
        description = "Read current Edda settings by dotted field paths or sections, or all settings when omitted. Credentials, prompt bodies and plugin env/headers/args are redacted; URLs omit credentials/query. Use values as settings_set.expected. Never read settings.json directly.",
        annotations(read_only_hint = true)
    )]
    async fn settings_get(
        &self,
        Parameters(args): Parameters<SettingsReadArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        let app = self
            .ctrl
            .app_handle()
            .ok_or_else(|| tool_err(AppError::message("Desktop settings unavailable")))?;
        let store = app
            .try_state::<AppSettingsStore>()
            .ok_or_else(|| tool_err(AppError::message("Desktop settings unavailable")))?;
        let settings = store.get().map_err(tool_err)?;
        Ok(Json(
            json!({"version": env!("CARGO_PKG_VERSION"), "values": access::read(&settings.settings, &args.fields).map_err(tool_err)?}),
        ))
    }

    #[tool(
        description = "Apply a validated atomic batch of Edda settings changes for the user's task or requested self-maintenance. Requires expected previous values for conflict detection; dryRun previews. Uses the application store, broadcasts live updates, preserves unrelated settings and secrets, and returns a conditional undo patch. Inspect environment/logs after changing parameters; never claim performance improvement without measuring. Does not grant permissions or modify application code.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn settings_set(
        &self,
        Parameters(args): Parameters<SettingsPatchArgs>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.authorize_mutation().map_err(tool_err)?;
        let app = self
            .ctrl
            .app_handle()
            .ok_or_else(|| tool_err(AppError::message("Desktop settings unavailable")))?;
        access::patch(app, args.changes, args.expected, args.dry_run)
            .await
            .map(Json)
            .map_err(tool_err)
    }
}

pub(super) fn tools() -> rmcp::handler::server::router::tool::ToolRouter<EddaMcp> {
    EddaMcp::settings_tools()
}
