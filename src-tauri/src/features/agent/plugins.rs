//! User-configured MCP servers ("plugins") handed to every local agent session
//! next to Edda's own workspace server. The settings schema owns the list; the
//! app assembly mirrors it here so this feature never reads settings directly.

use agent_client_protocol::schema::v1::{
    AgentCapabilities, EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerStdio,
};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq)]
pub enum McpPluginTransport {
    Http {
        url: String,
        headers: Vec<(String, String)>,
    },
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct McpPlugin {
    pub name: String,
    pub transport: McpPluginTransport,
}

/// Enabled plugins as of the latest settings change.
#[derive(Default)]
pub struct AgentPlugins {
    inner: Mutex<Vec<McpPlugin>>,
}

impl AgentPlugins {
    pub fn set(&self, plugins: Vec<McpPlugin>) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = plugins;
        }
    }

    /// ACP servers for a new session. Every agent must accept stdio servers;
    /// HTTP ones are only sent when the agent advertises HTTP MCP support.
    pub(crate) fn servers(&self, capabilities: &AgentCapabilities) -> Vec<McpServer> {
        let Ok(guard) = self.inner.lock() else {
            return Vec::new();
        };
        guard
            .iter()
            .filter_map(|plugin| match &plugin.transport {
                McpPluginTransport::Http { url, headers } => {
                    capabilities.mcp_capabilities.http.then(|| {
                        McpServer::Http(
                            McpServerHttp::new(&plugin.name, url).headers(
                                headers
                                    .iter()
                                    .map(|(name, value)| HttpHeader::new(name, value))
                                    .collect(),
                            ),
                        )
                    })
                }
                McpPluginTransport::Stdio { command, args, env } => Some(McpServer::Stdio(
                    McpServerStdio::new(&plugin.name, command)
                        .args(args.clone())
                        .env(
                            env.iter()
                                .map(|(name, value)| EnvVariable::new(name, value))
                                .collect(),
                        ),
                )),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_plugins_need_the_agent_http_capability() {
        let plugins = AgentPlugins::default();
        plugins.set(vec![
            McpPlugin {
                name: "web".into(),
                transport: McpPluginTransport::Http {
                    url: "https://example.com/mcp".into(),
                    headers: vec![("Authorization".into(), "Bearer x".into())],
                },
            },
            McpPlugin {
                name: "local".into(),
                transport: McpPluginTransport::Stdio {
                    command: "npx".into(),
                    args: vec!["-y".into(), "server".into()],
                    env: vec![],
                },
            },
        ]);
        let mut capabilities = AgentCapabilities::default();
        assert_eq!(plugins.servers(&capabilities).len(), 1);
        capabilities.mcp_capabilities.http = true;
        assert_eq!(plugins.servers(&capabilities).len(), 2);
    }
}
