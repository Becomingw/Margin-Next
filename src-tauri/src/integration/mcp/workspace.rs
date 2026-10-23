//! Private, immutable-vault MCP endpoint for one ACP connection. No user MCP
//! configuration or fixed port is needed; the owning connection retires it.

use super::{server, McpController};
use crate::core::error::AppError;
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::session::handlers::TurnRegistry;
use crate::features::agent::workspace_tools::{WorkspaceTools, WorkspaceToolsProvider};
use crate::features::system::settings::AppSettingsStore;
use agent_client_protocol::schema::v1::{HttpHeader, McpServer, McpServerHttp};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::sync::oneshot;

pub(crate) struct WorkspaceMcpProvider;

struct WorkspaceMcp {
    server: McpServer,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl WorkspaceTools for WorkspaceMcp {
    fn server(&self) -> McpServer {
        self.server.clone()
    }
    fn stop(&self) {
        if let Some(shutdown) = self
            .shutdown
            .lock()
            .ok()
            .and_then(|mut sender| sender.take())
        {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for WorkspaceMcp {
    fn drop(&mut self) {
        self.stop();
    }
}

#[async_trait::async_trait]
impl WorkspaceToolsProvider for WorkspaceMcpProvider {
    async fn open(
        &self,
        app: AgentEventEmitter,
        vault: PathBuf,
        turns: TurnRegistry,
        agent: &str,
    ) -> Result<Arc<dyn WorkspaceTools>, AppError> {
        let ctrl = Arc::new(McpController::new());
        ctrl.set_vault(Some(vault.to_string_lossy().into_owned()));
        ctrl.set_app_handle(app.app_handle().clone());
        if let Some(settings) = app
            .app_handle()
            .try_state::<AppSettingsStore>()
            .and_then(|store| store.get().ok())
        {
            ctrl.set_translator_url(Some(settings.settings.translator_base_url));
            ctrl.set_paper_note_mode(settings.settings.paper_note_mode);
        }
        start(ctrl, turns, agent).await
    }
}

async fn start(
    ctrl: Arc<McpController>,
    turns: TurnRegistry,
    agent: &str,
) -> Result<Arc<dyn WorkspaceTools>, AppError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let bearer = format!("Bearer {token}");
    let descriptor = McpServer::Http(
        // The Agent's name rides in the address, so its review writes are
        // signed with it even when its MCP client reports a library default.
        McpServerHttp::new(
            "edda-workspace",
            format!(
                "http://127.0.0.1:{port}/mcp?agent={}",
                urlencoding::encode(agent)
            ),
        )
        .headers(vec![HttpHeader::new("Authorization", bearer.clone())]),
    );
    let (shutdown, stopped) = oneshot::channel();
    // Do not capture the lease here: dropping it must close the listener.
    tauri::async_runtime::spawn(async move {
        if let Err(error) = server::serve_workspace(listener, stopped, ctrl, turns, bearer).await {
            log::warn!(target: "edda::agent", "workspace MCP stopped: {error}");
        }
    });
    Ok(Arc::new(WorkspaceMcp {
        server: descriptor,
        shutdown: Mutex::new(Some(shutdown)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::agent::session::handlers::new_registry;
    use crate::features::paper::catalog::papers::{self, PaperRecord};
    use crate::features::vault;
    use serde_json::{json, Value};

    async fn request(
        client: &reqwest::Client,
        url: &str,
        bearer: &str,
        session: Option<&str>,
        body: Value,
    ) -> reqwest::Response {
        let mut request = client
            .post(url)
            .header("Authorization", bearer)
            .header("Accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        request.send().await.unwrap()
    }

    fn decoded(body: &str) -> Value {
        serde_json::from_str(body).unwrap_or_else(|_| {
            body.lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .find_map(|data| serde_json::from_str(data).ok())
                .expect("MCP JSON/SSE result")
        })
    }

    #[tokio::test]
    async fn workspace_endpoint_is_authenticated_bound_and_retired() {
        let root = tempfile::tempdir().unwrap();
        vault::create_vault(root.path(), "en").unwrap();
        papers::upsert_paper(
            root.path(),
            &PaperRecord::local_pdf("demo".into(), "Local workspace paper".into())
                .at_path("papers/demo"),
        )
        .unwrap();
        std::fs::create_dir_all(root.path().join("papers/demo")).unwrap();
        std::fs::write(root.path().join("papers/demo/PAPER.md"), "Existing source").unwrap();
        let ctrl = Arc::new(McpController::new());
        ctrl.set_vault(Some(root.path().to_string_lossy().into_owned()));
        let tools = start(Arc::clone(&ctrl), new_registry(), "Gemini CLI")
            .await
            .unwrap();
        let McpServer::Http(server) = tools.server() else {
            panic!("HTTP bridge")
        };
        assert!(server.url.ends_with("/mcp?agent=Gemini%20CLI"));
        let bearer = &server.headers[0].value;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        assert_eq!(
            client.post(&server.url).send().await.unwrap().status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        let init = request(&client, &server.url, bearer, None, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})).await;
        assert!(init.status().is_success());
        let session = init
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let _ = init.text().await.unwrap();
        let other = tempfile::tempdir().unwrap();
        vault::create_vault(other.path(), "en").unwrap();
        ctrl.set_vault(Some(other.path().to_string_lossy().into_owned()));
        // The initialized connection keeps the original workspace despite a
        // controller change (the external listener uses this same factory).
        request(
            &client,
            &server.url,
            bearer,
            session.as_deref(),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
        let result = request(&client, &server.url, bearer, session.as_deref(), json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"paper_context","arguments":{"ref":"demo"}}})).await;
        let result = decoded(&result.text().await.unwrap());
        assert_eq!(
            result["result"]["structuredContent"]["paper"]["title"],
            "Local workspace paper"
        );
        assert_eq!(
            result["result"]["structuredContent"]["body"],
            "papers/demo/PAPER.md"
        );
        // The connection writes as the name in its address, not as its
        // client's own ("test").
        let unit = edda_core::features::review::create_unit(root.path(), "Draft").unwrap();
        let read = request(&client, &server.url, bearer, session.as_deref(), json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"review_read","arguments":{"ref":unit.id}}})).await;
        let read = decoded(&read.text().await.unwrap());
        assert_eq!(
            read["result"]["structuredContent"]["you"]["agent"],
            "Gemini CLI"
        );
        assert_eq!(read["result"]["structuredContent"]["you"]["fixed"], true);
        let listed = request(
            &client,
            &server.url,
            bearer,
            session.as_deref(),
            json!({"jsonrpc":"2.0","id":20,"method":"tools/list","params":{}}),
        )
        .await;
        let listed = decoded(&listed.text().await.unwrap());
        let described = request(&client, &server.url, bearer, session.as_deref(), json!({"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"settings_describe","arguments":{}}})).await;
        let described = decoded(&described.text().await.unwrap());
        assert_eq!(described["result"]["structuredContent"]["writable"], true);
        assert_eq!(
            described["result"]["structuredContent"]["schema"]["properties"]["mcpEnabled"]["type"],
            "boolean"
        );
        let names = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        for name in [
            "settings_describe",
            "settings_get",
            "settings_set",
            "environment_inspect",
            "environment_check",
            "product_reference",
            "logs_list",
            "logs_read",
            "paper_task_start",
            "task_get",
            "mark_create",
            "pool_submit",
            "wiki_diagnose",
            "export_bibliography",
        ] {
            assert!(names.contains(&name), "missing tool {name}");
        }
        for tool in listed["result"]["tools"].as_array().unwrap() {
            if let Some(schema) = tool.get("outputSchema") {
                assert_eq!(
                    schema["type"], "object",
                    "invalid output schema: {}",
                    tool["name"]
                );
            }
        }
        let source = request(&client, &server.url, bearer, session.as_deref(), json!({"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"paper_read_source","arguments":{"ref":"demo","path":"PAPER.md","offset":0,"limit":8}}})).await;
        let source = decoded(&source.text().await.unwrap());
        assert_eq!(source["result"]["structuredContent"]["text"], "Existing");
        assert_eq!(source["result"]["structuredContent"]["nextOffset"], 8);
        let traversal = request(&client, &server.url, bearer, session.as_deref(), json!({"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"paper_read_source","arguments":{"ref":"demo","path":"../../AGENTS.md"}}})).await;
        assert_eq!(
            decoded(&traversal.text().await.unwrap())["result"]["isError"],
            true
        );
        let denied = request(&client, &server.url, bearer, session.as_deref(), json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"paper_set_read","arguments":{"ref":"demo"}}})).await;
        assert_eq!(
            decoded(&denied.text().await.unwrap())["result"]["isError"],
            true
        );
        assert!(
            !papers::get_by_path(root.path(), "papers/demo")
                .unwrap()
                .unwrap()
                .is_read
        );
        tools.stop();
        // Verify listener retirement, not HTTP response completion. A GET
        // accepted just before shutdown can wait for graceful draining/SSE
        // even after the listening socket has closed (especially on Windows).
        let port = reqwest::Url::parse(&server.url).unwrap().port().unwrap();
        let address = format!("127.0.0.1:{port}");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match tokio::net::TcpStream::connect(&address).await {
                    Ok(stream) => drop(stream),
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => break,
                    Err(error) => panic!("unexpected retirement probe error: {error}"),
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("retired endpoint must stop accepting requests");
    }

    #[tokio::test]
    #[ignore = "live native Grok test; set EDDA_GROK_WORKSPACE_SMOKE=1"]
    async fn live_grok_uses_workspace_tools_without_cli_setup() {
        assert!(std::env::var_os("EDDA_GROK_WORKSPACE_SMOKE").is_some());
        use agent_client_protocol::schema::v1::{
            ContentBlock, InitializeRequest, McpServerStdio, NewSessionRequest, PromptRequest,
            RequestPermissionRequest, SessionNotification, TextContent,
        };
        use agent_client_protocol::{AcpAgent, Client};
        let root = tempfile::tempdir().unwrap();
        vault::create_vault(root.path(), "en").unwrap();
        papers::upsert_paper(
            root.path(),
            &PaperRecord::local_pdf("demo".into(), "Workspace integration smoke paper".into())
                .at_path("papers/demo"),
        )
        .unwrap();
        let ctrl = Arc::new(McpController::new());
        ctrl.set_vault(Some(root.path().to_string_lossy().into_owned()));
        let tools = start(ctrl, new_registry(), "Codex").await.unwrap();
        let updates = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured = updates.clone();
        let observed = updates.clone();
        let quote_start = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let quote_marker = quote_start.clone();
        let agent = AcpAgent::new(McpServer::Stdio(
            McpServerStdio::new("Grok smoke", which::which("grok").unwrap()).args(vec![
                "--cwd".into(),
                root.path().to_string_lossy().into_owned(),
                "--permission-mode".into(),
                "plan".into(),
                "--no-subagents".into(),
                "agent".into(),
                "stdio".into(),
            ]),
        ));
        let cwd = root.path().to_path_buf();
        let cwd_for_qa = cwd.to_string_lossy().into_owned();
        let server = tools.server();
        tokio::time::timeout(
            std::time::Duration::from_secs(120),
            Client
                .builder()
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        let response =
                            crate::features::agent::acp::interaction::permission_response(
                                &request,
                                crate::features::agent::workspace_tools::is_readonly_request(
                                    &request,
                                ),
                            );
                        let _ = responder.respond(response);
                        Ok(())
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_notification(
                    async move |notification: SessionNotification, _cx| {
                        captured
                            .lock()
                            .unwrap()
                            .push(serde_json::to_string(&notification).unwrap());
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .connect_with(
                    agent,
                    move |connection: agent_client_protocol::ConnectionTo<
                        agent_client_protocol::Agent,
                    >| async move {
                        let init = connection
                            .send_request(InitializeRequest::new(
                                agent_client_protocol::schema::ProtocolVersion::V1,
                            ))
                            .block_task()
                            .await?;
                        assert!(
                            init.agent_capabilities.mcp_capabilities.http,
                            "native HTTP MCP support"
                        );
                        let session = connection
                            .send_request(NewSessionRequest::new(cwd).mcp_servers(vec![server]))
                            .block_task()
                            .await?;
                        let prompt = crate::features::agent::workspace_tools::prompt_context(
                            "User request:\n文献库里目前有哪些论文？请只列出标题。".into(),
                            true,
                            false,
                        );
                        let prompt_session = session.session_id.clone();
                        let result = tokio::time::timeout(
                            std::time::Duration::from_secs(90),
                            connection
                                .send_request(PromptRequest::new(
                            session.session_id.clone(),
                                    vec![ContentBlock::Text(TextContent::new(prompt))],
                                ))
                                .block_task(),
                        )
                        .await;
                    match result {
                            Ok(result) => {
                                result?;
                    }
                            Err(_) => {
                                let _ = connection.send_notification(
                                    agent_client_protocol::schema::v1::CancelNotification::new(
                                        prompt_session,
                                    ),
                                );
                                return Err(agent_client_protocol::Error::internal_error()
                                     .data("workspace smoke prompt timed out"));
                            }
                        }
                        quote_marker.store(observed.lock().unwrap().len(), std::sync::atomic::Ordering::SeqCst);
                        let ids = ["paper-qa".to_string()];
                        let style = crate::features::agent::prompt::skills::SkillMentionStyle::InjectedOnly;
                        let instructions = crate::features::agent::prompt::skills::load_skill_instructions(&ids, Some(cwd_for_qa.as_str()), style).unwrap();
                        let question = "翻译这段原文：\n\nSelected text from papers/demo (page 1):\n> These features work across tasks without fine-tuning.";
                        let prompt = format!("{}{}", crate::features::agent::prompt::envelope::build_prompt(Some("qa"), question, Some("papers/demo"), style, &ids, None, None), instructions);
                        connection.send_request(PromptRequest::new(session.session_id, vec![ContentBlock::Text(TextContent::new(crate::features::agent::workspace_tools::prompt_context(prompt, true, false)))])).block_task().await?;
                        Ok(())
                    },
                ),
        )
        .await
        .unwrap()
        .unwrap();
        let events = updates.lock().unwrap();
        let joined = events.join("\n");
        assert!(
            joined.contains("paper_list"),
            "native agent should use the workspace catalog tool"
        );
        assert!(joined.contains("Workspace integration smoke paper"));
        let parsed: Vec<Value> = events
            .iter()
            .map(|event| serde_json::from_str(event).unwrap())
            .collect();
        let quote_events = &parsed[quote_start.load(std::sync::atomic::Ordering::SeqCst)..];
        assert!(
            !quote_events
                .iter()
                .any(|event| event["update"]["sessionUpdate"] == "tool_call"),
            "self-contained translation must not start a tool/skill lookup"
        );
        let answer: String = parsed
            .iter()
            .filter(|event| event["update"]["sessionUpdate"] == "agent_message_chunk")
            .filter_map(|event| event["update"]["content"]["text"].as_str())
            .collect();
        let calls = parsed
            .iter()
            .filter(|event| event["update"]["sessionUpdate"] == "tool_call")
            .map(|event| event["update"]["rawInput"].to_string())
            .collect::<Vec<_>>()
            .join("\n");
        for setup in [
            "which edda",
            "command -v edda",
            "edda --version",
            "edda describe",
            "agentero-cli/SKILL.md",
        ] {
            assert!(!calls.contains(setup), "unnecessary setup: {setup}");
        }
        assert!(answer.contains("Workspace integration smoke paper"));
        println!(
            "Native Grok used paper_list and returned the catalog title ({} updates).",
            events.len()
        );
        println!("Answer: {answer}");
        tools.stop();
    }
}
