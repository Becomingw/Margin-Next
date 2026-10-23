//! Host-provided workspace tools, attached through the agent's native ACP MCP
//! support. The integration owns transport; the agent feature owns its lifetime.

use crate::core::error::AppError;
use crate::features::agent::plugins::AgentPlugins;
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::session::handlers::TurnRegistry;
use agent_client_protocol::schema::v1::{
    AgentCapabilities, McpServer, RequestPermissionRequest, ToolKind,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

pub(crate) trait WorkspaceTools: Send + Sync {
    fn server(&self) -> McpServer;
    fn stop(&self);
}

#[async_trait::async_trait]
pub(crate) trait WorkspaceToolsProvider: Send + Sync {
    /// `agent` is the Agent's name in Edda; review writes over this
    /// connection are signed with it whatever its MCP client reports.
    async fn open(
        &self,
        app: AgentEventEmitter,
        vault: PathBuf,
        turns: TurnRegistry,
        agent: &str,
    ) -> Result<Arc<dyn WorkspaceTools>, AppError>;
}

/// MCP servers attached to one agent connection: Edda's workspace server (when
/// available) plus the user's enabled plugins.
#[derive(Clone, Default)]
pub(crate) struct WorkspaceConnection {
    tools: Option<Arc<dyn WorkspaceTools>>,
    plugins: Vec<McpServer>,
}

impl WorkspaceConnection {
    /// Whether Edda's own workspace tools are connected (plugins don't count).
    pub(crate) fn has_workspace(&self) -> bool {
        self.tools.is_some()
    }

    pub(crate) fn tools(&self) -> Option<&Arc<dyn WorkspaceTools>> {
        self.tools.as_ref()
    }
}

/// Some native adapters (notably Grok's use_tool wrapper) request permission
/// even for MCP readOnlyHint tools. Only auto-allow our exact read operations.
pub(crate) fn is_readonly_request(request: &RequestPermissionRequest) -> bool {
    let fields = &request.tool_call.fields;
    if !matches!(
        fields.kind.as_ref(),
        None | Some(ToolKind::Other | ToolKind::Read | ToolKind::Search)
    ) {
        return false;
    }
    if fields
        .raw_input
        .as_ref()
        .and_then(|input| input.get("command"))
        .is_some()
    {
        return false;
    }
    let name = fields
        .raw_input
        .as_ref()
        .and_then(|input| input.get("tool_name"))
        .and_then(serde_json::Value::as_str)
        .or(fields.title.as_deref())
        .unwrap_or("");
    let operation = [
        "edda-workspace__",
        "mcp__edda-workspace__",
        "edda-workspace/",
    ]
    .iter()
    .find_map(|prefix| name.strip_prefix(prefix));
    matches!(
        operation,
        Some(
            "workspace_context"
                | "settings_describe"
                | "settings_get"
                | "paper_context"
                | "paper_list"
                | "paper_get"
                | "paper_notes_get"
                | "layout_list"
                | "layout_get"
                | "paper_read_source"
                | "paper_sources"
                | "tag_list"
                | "mark_list"
                | "mark_get"
                | "task_list"
                | "task_get"
                | "pool_example"
                | "pool_list"
                | "workspace_diagnose"
                | "wiki_diagnose"
                | "export_bibliography"
                | "translate_text"
                | "browse_tabs"
                | "browse_page"
                | "browse_adapter_list"
                | "browse_adapter_read"
                | "browse_adapter_history"
                | "browse_check"
        )
    )
}

pub(crate) fn prompt_context(prompt: String, connected: bool, raw_command: bool) -> String {
    if raw_command {
        return prompt;
    }
    let capability = if connected {
        "Edda workspace MCP tools are connected. Use their schemas directly for library operations, reading marks, reviews, recommendations and background tasks; use native file/search tools for source text. workspace_context reports version/capabilities; settings_describe/settings_get provide a safe read-only settings subset. Do not read or edit settings.json directly. No setup or command discovery is needed."
    } else {
        "Edda workspace MCP is unavailable in this connection. Native file/search tools may still be used. Explain missing business capabilities when relevant; do not install or invoke the retired Edda business CLI or modify its databases manually."
    };
    format!("{capability}\n\n{prompt}")
}

pub(crate) fn servers(connection: &WorkspaceConnection) -> Vec<McpServer> {
    connection
        .tools
        .iter()
        .map(|tools| tools.server())
        .chain(connection.plugins.iter().cloned())
        .collect()
}

pub(crate) async fn connect(
    app: &AgentEventEmitter,
    cwd: &Path,
    capabilities: &AgentCapabilities,
    turns: TurnRegistry,
    local: bool,
    agent: &str,
) -> WorkspaceConnection {
    if !local {
        log::info!(target: "edda::agent", "workspace_mcp unavailable reason=remote_workspace");
        // Plugin commands and URLs are configured for this machine.
        return WorkspaceConnection::default();
    }
    let plugins = app
        .app_handle()
        .try_state::<AgentPlugins>()
        .map(|plugins| plugins.servers(capabilities))
        .unwrap_or_default();
    let tools = open_workspace_tools(app, cwd, capabilities, turns, agent).await;
    WorkspaceConnection { tools, plugins }
}

async fn open_workspace_tools(
    app: &AgentEventEmitter,
    cwd: &Path,
    capabilities: &AgentCapabilities,
    turns: TurnRegistry,
    agent: &str,
) -> Option<Arc<dyn WorkspaceTools>> {
    if !capabilities.mcp_capabilities.http {
        log::info!(target: "edda::agent", "workspace_mcp unavailable reason=agent_http_unsupported");
        return None;
    }
    if !cwd
        .join(edda_core::vault_private_rel!("catalog.sqlite"))
        .is_file()
    {
        log::info!(target: "edda::agent", "workspace_mcp unavailable reason=not_local_vault");
        return None;
    }
    let provider = app
        .app_handle()
        .try_state::<Arc<dyn WorkspaceToolsProvider>>()?
        .inner()
        .clone();
    match provider
        .open(app.clone(), cwd.to_path_buf(), turns, agent)
        .await
    {
        Ok(tools) => {
            log::info!(target: "edda::agent", "workspace_mcp ready name=edda-workspace");
            Some(tools)
        }
        Err(error) => {
            log::warn!(target: "edda::agent", "workspace tools unavailable: {error}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_commands_are_not_rewritten_by_workspace_context() {
        assert_eq!(prompt_context("/compact".into(), true, true), "/compact");
        assert!(prompt_context("Question".into(), false, false).contains("MCP is unavailable"));
        let prompt = prompt_context("Question".into(), true, false);
        assert!(prompt.contains("MCP tools are connected"));
        assert!(prompt.ends_with("Question"));
    }

    #[test]
    fn permission_exception_only_covers_exact_workspace_reads() {
        let request = |name: &str, kind: &str| {
            serde_json::from_value::<RequestPermissionRequest>(serde_json::json!({
                "sessionId":"s", "toolCall":{"toolCallId":"t", "title":name, "kind":kind,
                "rawInput":{"variant":"UseTool", "tool_name":name, "tool_input":{}}}, "options":[]
            }))
            .unwrap()
        };
        assert!(is_readonly_request(&request(
            "edda-workspace__paper_list",
            "other"
        )));
        assert!(is_readonly_request(&request(
            "mcp__edda-workspace__paper_context",
            "read"
        )));
        assert!(!is_readonly_request(&request(
            "edda-workspace__paper_list",
            "execute"
        )));
        assert!(!is_readonly_request(&request(
            "edda-workspace__paper_tag_add",
            "other"
        )));
        assert!(!is_readonly_request(&request(
            "other-server__paper_list",
            "other"
        )));
    }
}
