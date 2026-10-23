//! Single-turn ACP run orchestration (prompt → session → stream → complete).

use crate::core::error::AppError;
use crate::features::agent::acp::client::{
    acp_err, acp_terminals, cancelled_payload, client_initialize_request, simplified_agent_cwd,
    timed_acp_initialize, timed_acp_request, to_acp_agent, wait_for_cancellation,
};
use crate::features::agent::acp::interaction::PermissionPolicy;
use crate::features::agent::acp::terminal::AcpTerminalManager;
use crate::features::agent::acp::updates::{
    collaboration_from_config_options, effort_from_config_options, emit_rich_session_update,
    emit_session_config_options, fast_mode_value_to_set, is_fast_option, is_pi_startup_banner,
    models_from_config_options, stream_from_update,
};
use crate::features::agent::models::{
    AgentDescriptor, AgentFailedEvent, AgentResultPayload, AgentStatusEvent, AgentStreamEvent,
    AgentStreamKind, AgentTemplate, PromptImage,
};
use crate::features::agent::prompt::envelope::build_prompt;
use crate::features::agent::prompt::skills::{
    load_skill_instructions_with, skill_activation_prefix, skill_mention_style,
};
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::runtime::gates::{AskUserGate, ElicitationGate, PermissionGate};
use crate::features::agent::runtime::stream::{StreamCoalescer, STREAM_COALESCE_WINDOW};
use crate::features::agent::session::config::RunPreferences;
use crate::features::agent::session::handlers::{
    clear_turn, edda_turn_builder, install_turn, new_registry, ActiveTurn, TurnRegistry,
};
use crate::features::agent::session::pool::{pool_key, AgentWarmPool, PooledSlot};
use crate::features::agent::workspace_tools::{self, WorkspaceConnection};
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ImageContent, LoadSessionRequest, NewSessionRequest,
    PromptRequest, ResumeSessionRequest, SessionConfigId, SessionConfigOptionValue, SessionId,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::{Agent, ConnectionTo};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use uuid::Uuid;

/// Input for one `run_once` turn. Collapses the previous 24 positional params.
/// Clone so a failed pooled attempt can fall back to the cold path unchanged.
#[derive(Clone)]
pub struct RunOnceParams {
    pub app: AgentEventEmitter,
    pub desc: AgentDescriptor,
    pub session_id: String,
    pub message_id: String,
    pub prompt: String,
    pub is_acp_command: bool,
    pub images: Vec<PromptImage>,
    pub workflow: Option<String>,
    pub target: Option<String>,
    pub vault_path: Option<String>,
    pub preferred_model_id: Option<String>,
    pub preferred_collaboration_mode_id: Option<String>,
    pub preferred_reasoning_effort: Option<String>,
    pub prefer_highest_reasoning_effort: bool,
    pub fast_mode: Option<bool>,
    pub skill_ids: Vec<String>,
    pub permission_policy: PermissionPolicy,
    pub permission_gate: PermissionGate,
    pub elicitation_gate: ElicitationGate,
    pub ask_user_gate: AskUserGate,
    pub response_language: Option<String>,
    pub personal_prompt: Option<String>,
    pub cancellation: watch::Receiver<bool>,
    pub remote: Option<Arc<dyn crate::features::agent::remote_host::RemoteAgentLaunch>>,
    pub resume_session_id: Option<String>,
    /// Pool of warm connections consulted before the cold spawn chain.
    pub warm_pool: Option<Arc<AgentWarmPool>>,
}

/// Prompt/cwd prepared before any ACP I/O.
#[derive(Clone)]
struct RunTurnPrep {
    full_prompt: String,
    prompt_images: Vec<PromptImage>,
    cwd: PathBuf,
}

/// Everything the connection turn needs beyond the shared state.
struct RunTurnInput {
    full_prompt: String,
    prompt_images: Vec<PromptImage>,
    cwd: PathBuf,
    /// Provider session id to continue (resume/load) instead of `session/new`.
    resume_session_id: Option<String>,
    preferences: RunPreferences,
    local_workspace: bool,
}

/// Session established by the connect phase of a turn.
struct ConnectedSession {
    acp_session_id: SessionId,
    config_options: Vec<agent_client_protocol::schema::v1::SessionConfigOption>,
    /// Resolved provider resume id when continuing an earlier session
    /// (drives the history-replay buffer clear before the prompt).
    resume_id: Option<String>,
    workspace_tools: WorkspaceConnection,
}

/// Outcome of a cancellable phase of the run turn.
enum TurnPhase<T> {
    /// The phase completed; the turn continues with this value.
    Ready(T),
    /// The run was cancelled; `agent:completed` was already emitted.
    Cancelled(AgentResultPayload),
}

/// Error from the prompt phase tagged by whether the `PromptRequest` was
/// already dispatched: only pre-prompt failures let the pooled path hand off
/// to the cold retry; post-prompt failures are terminal.
struct PromptPhaseError {
    pre_prompt: bool,
    error: agent_client_protocol::Error,
}

impl PromptPhaseError {
    fn pre_prompt(error: agent_client_protocol::Error) -> Self {
        Self {
            pre_prompt: true,
            error,
        }
    }

    fn prompt_request(error: agent_client_protocol::Error) -> Self {
        // ACP 1.3 reports this from PendingRepliesRegistrar::subscribe BEFORE
        // enqueueing the request. Other transport failures may follow delivery
        // and must not cause an automatic replay of tool-using prompts.
        let unsent = error.code == agent_client_protocol::Error::internal_error().code
            && error.data.as_ref().and_then(serde_json::Value::as_str)
                == Some("failed to send outgoing request `session/prompt`: connection is no longer running");
        Self {
            pre_prompt: unsent,
            error: acp_err(format!("prompt: {error}")),
        }
    }
}

/// Emit `agent:failed` for a run that could not start or complete.
fn emit_run_failed(app: &AgentEventEmitter, session_id: &str, error: &impl std::fmt::Display) {
    log::warn!(target: "edda::agent", "agent run failed session_id={session_id}: {error}");
    let _ = app.emit(
        "agent:failed",
        AgentFailedEvent {
            session_id: session_id.to_string(),
            error: error.to_string(),
        },
    );
}

/// Prompt-assembly phase: resolve skill instructions, template the prompt, and
/// pick the working directory. Emits `agent:failed` and errors when a selected
/// local skill cannot be loaded.
async fn prepare_run_turn(params: &RunOnceParams) -> Result<RunTurnPrep, AppError> {
    let skill_style = skill_mention_style(&params.desc.template);
    let skill_instructions = if params.is_acp_command {
        String::new()
    } else {
        // Skills: local vault path, or remote work_root after materializing SKILL.md from SFTP.
        let skill_vault = if let Some(ref r) = params.remote {
            if let Err(e) = r.materialize_skills().await {
                log::warn!(target: "edda::agent", "materialize remote skills: {e}");
            }
            Some(r.work_root().to_string_lossy().into_owned())
        } else {
            params.vault_path.clone()
        };
        // Outside developer mode presets are sent as shipped.
        let shipped_presets =
            !crate::features::vault::presets::developer_mode(params.app.app_handle());
        match load_skill_instructions_with(
            &params.skill_ids,
            skill_vault.as_deref(),
            skill_style,
            shipped_presets,
        ) {
            Ok(instructions) => instructions,
            Err(error) => {
                emit_run_failed(&params.app, &params.session_id, &error);
                return Err(error);
            }
        }
    };
    let full_prompt = if params.is_acp_command {
        params.prompt.clone()
    } else {
        let user_prompt = if params.prompt.trim().is_empty() && !params.images.is_empty() {
            // Shared fallback for visual crops and general composer attachments.
            "Please analyze the attached image(s).".to_string()
        } else {
            params.prompt.clone()
        };
        // Composer-selected instructions are inline; native commands bypass this branch.
        let activation = skill_activation_prefix(&params.skill_ids, skill_style);
        let user_prompt = format!("{activation}{user_prompt}");
        format!(
            "{}{}",
            build_prompt(
                params.workflow.as_deref(),
                &user_prompt,
                params.target.as_deref(),
                skill_style,
                &params.skill_ids,
                params.response_language.as_deref(),
                params.personal_prompt.as_deref(),
            ),
            skill_instructions
        )
    };
    log::info!(
        target: "edda::agent",
        "agent_prompt_prepared session_id={} workflow={:?} skills={:?} injected_chars={} native_skill_hint={}",
        params.session_id,
        params.workflow.as_deref().unwrap_or("free"),
        if params.is_acp_command { &[] } else { params.skill_ids.as_slice() },
        skill_instructions.chars().count(),
        !params.is_acp_command && !skill_activation_prefix(&params.skill_ids, skill_style).is_empty(),
    );
    let prompt_images = params.images.clone();
    let cwd = simplified_agent_cwd(&if let Some(ref r) = params.remote {
        r.agent_cwd()
    } else {
        params
            .vault_path
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    });
    Ok(RunTurnPrep {
        full_prompt,
        prompt_images,
        cwd,
    })
}

/// Shared state for one `run_once` turn, cloned into the ACP notification /
/// permission / elicitation handlers and the connection turn future.
#[derive(Clone)]
pub(crate) struct RunOnceContext {
    pub(crate) app: AgentEventEmitter,
    pub(crate) session_id: String,
    pub(crate) workflow: Option<String>,
    pub(crate) task_target: Option<String>,
    diagnostic_preferences: serde_json::Value,
    message_id: String,
    agent_id: String,
    /// The Agent's name in Edda, which signs its review writes.
    agent_name: String,
    is_acp_command: bool,
    workspace_tools_connected: Arc<AtomicBool>,
    /// pi-acp forwards a CLI startup banner that must be dropped from the stream.
    is_pi: bool,
    /// dsh keeps sessions in-process and never advertises resume/load, so a
    /// requested continue degrades to a fresh session — always stream live.
    dsh_fresh_sessions: bool,
    content_buf: Arc<Mutex<String>>,
    thought_buf: Arc<Mutex<String>>,
    coalescer: StreamCoalescer,
    /// session/load (and some resume paths) replay history as SessionNotification.
    /// Until we open the gate, drop stream/tool/plan so turn N does not re-paint
    /// turn N-1 into the new streaming bubble (Grok multi-turn).
    live_stream: Arc<AtomicBool>,
    stop_reason: Arc<Mutex<Option<String>>>,
    /// Terminal capability: headless command execution on behalf of the agent.
    terminals: Arc<tokio::sync::Mutex<AcpTerminalManager>>,
}

impl RunOnceContext {
    pub(crate) fn diagnostics(&self) -> serde_json::Value {
        serde_json::json!({"sessionId":self.session_id,"agentId":self.agent_id,
            "workflow":self.workflow,"taskTarget":self.task_target,
            "requestedPreferences":self.diagnostic_preferences,
            "workspaceToolsConnected":self.workspace_tools_connected.load(Ordering::SeqCst),
            "note":"Requested preferences are not proof of the model actually used by the provider."})
    }

    fn new(params: &RunOnceParams, cwd: std::path::PathBuf) -> Self {
        let dsh_fresh_sessions = matches!(params.desc.template, AgentTemplate::Dsh);
        // Merge token-storm chunks into ~25 emits/s (Windows webview jank source).
        // Payload shape is unchanged: same event, longer `chunk`, lower rate.
        let coalescer = StreamCoalescer::new(STREAM_COALESCE_WINDOW, {
            let app = params.app.clone();
            let session_id = params.session_id.clone();
            move |chunk, kind| {
                let _ = app.emit(
                    "agent:stream",
                    AgentStreamEvent {
                        session_id: session_id.clone(),
                        chunk,
                        kind,
                    },
                );
            }
        });
        Self {
            app: params.app.clone(),
            session_id: params.session_id.clone(),
            workflow: params.workflow.clone(),
            task_target: params.target.clone(),
            diagnostic_preferences: serde_json::json!({"modelId":params.preferred_model_id,"reasoningEffort":params.preferred_reasoning_effort,"collaborationModeId":params.preferred_collaboration_mode_id,"fastMode":params.fast_mode}),
            message_id: params.message_id.clone(),
            agent_id: params.desc.id.clone(),
            agent_name: params.desc.name.clone(),
            is_acp_command: params.is_acp_command,
            workspace_tools_connected: Arc::new(AtomicBool::new(false)),
            is_pi: matches!(params.desc.template, AgentTemplate::Pi),
            dsh_fresh_sessions,
            content_buf: Arc::new(Mutex::new(String::new())),
            thought_buf: Arc::new(Mutex::new(String::new())),
            coalescer,
            live_stream: Arc::new(AtomicBool::new(
                params.resume_session_id.is_none() || dsh_fresh_sessions,
            )),
            stop_reason: Arc::new(Mutex::new(None)),
            terminals: acp_terminals(Some(cwd)),
        }
    }

    /// Pooled-path constructor: share the terminal manager (and cwd default)
    /// of the warm connection the run is about to reuse, so terminal requests
    /// from the agent route to the manager this run's UI can observe.
    pub(crate) fn with_terminals(
        params: &RunOnceParams,
        cwd: std::path::PathBuf,
        terminals: Arc<tokio::sync::Mutex<AcpTerminalManager>>,
    ) -> Self {
        let mut ctx = Self::new(params, cwd);
        ctx.terminals = terminals;
        ctx
    }

    pub(crate) fn has_workspace_tools(&self) -> bool {
        self.workspace_tools_connected.load(Ordering::Acquire)
    }

    /// Relay one `SessionNotification`: buffer + coalesce stream chunks, and
    /// forward rich updates (tool/plan/usage/config/commands) to the webview.
    pub(crate) fn relay_session_notification(&self, notification: &SessionNotification) {
        if !self.live_stream.load(Ordering::SeqCst) {
            // Still allow usage / command / config during load settle.
            match &notification.update {
                SessionUpdate::AvailableCommandsUpdate(_)
                | SessionUpdate::ConfigOptionUpdate(_)
                | SessionUpdate::UsageUpdate(_)
                | SessionUpdate::SessionInfoUpdate(_) => {
                    emit_rich_session_update(
                        &self.app,
                        &self.session_id,
                        &self.agent_id,
                        notification,
                    );
                }
                _ => {}
            }
            return;
        }
        if let Some((chunk, kind)) = stream_from_update(&notification.update) {
            let drop_banner = self.is_pi
                && matches!(kind, AgentStreamKind::Message)
                && is_pi_startup_banner(&chunk)
                && self
                    .content_buf
                    .lock()
                    .is_ok_and(|buffer| buffer.is_empty());
            if !drop_banner {
                match kind {
                    AgentStreamKind::Message => {
                        if let Ok(mut buf) = self.content_buf.lock() {
                            buf.push_str(&chunk);
                        }
                    }
                    AgentStreamKind::Thought => {
                        if let Ok(mut buf) = self.thought_buf.lock() {
                            buf.push_str(&chunk);
                        }
                    }
                }
                self.coalescer.push(&chunk, kind);
            }
        } else {
            // Non-chunk update (tool/plan/…): flush buffered text first
            // so the transcript order stays text → tool/plan.
            self.coalescer.flush();
        }
        emit_rich_session_update(&self.app, &self.session_id, &self.agent_id, notification);
    }

    /// Flush buffered stream text, then emit `agent:completed` (ordered after text).
    fn emit_completed(&self, payload: AgentResultPayload) -> AgentResultPayload {
        self.coalescer.flush();
        let _ = self.app.emit("agent:completed", payload.clone());
        payload
    }

    /// Build the cancelled payload, flush, and emit `agent:completed`.
    fn cancel_completed(&self, provider_session_id: Option<String>) -> AgentResultPayload {
        let payload = cancelled_payload(
            self.session_id.clone(),
            self.message_id.clone(),
            provider_session_id,
            &self.content_buf,
            &self.thought_buf,
        );
        self.emit_completed(payload)
    }

    /// Build the ACP client (stream + permission/elicitation/ask-user handlers),
    /// connect to the agent process, and run one prompt turn on the connection.
    async fn run(
        &self,
        acp: agent_client_protocol::AcpAgent,
        params: RunOnceParams,
        prep: RunTurnPrep,
    ) -> Result<AgentResultPayload, agent_client_protocol::Error> {
        let RunOnceParams {
            permission_policy,
            permission_gate,
            elicitation_gate,
            ask_user_gate,
            cancellation,
            resume_session_id,
            preferred_model_id,
            preferred_collaboration_mode_id,
            preferred_reasoning_effort,
            prefer_highest_reasoning_effort,
            fast_mode,
            remote,
            ..
        } = params;
        let turn = RunTurnInput {
            full_prompt: prep.full_prompt,
            prompt_images: prep.prompt_images,
            cwd: prep.cwd,
            resume_session_id,
            local_workspace: remote.is_none(),
            preferences: RunPreferences {
                model_id: preferred_model_id,
                collaboration_mode_id: preferred_collaboration_mode_id,
                reasoning_effort: preferred_reasoning_effort,
                prefer_highest_reasoning_effort,
                fast_mode,
            },
        };

        // Cold path: the turn registry is pre-filled for the whole connection
        // lifetime, so the shared handlers behave exactly like the previous
        // inline closures. Idle hooks are unused (no pool owns this socket).
        let registry = new_registry();
        let _replaced = install_turn(
            &registry,
            ActiveTurn {
                ctx: self.clone(),
                permission_policy,
                permission_gate,
                elicitation_gate,
                ask_user_gate,
                activity: None,
            },
        );
        edda_turn_builder!(self.terminals.clone(), registry.clone(), None)
            .connect_with(acp, {
                let state = self.clone();
                move |connection: ConnectionTo<Agent>| async move {
                    state
                        .run_turn(connection, cancellation, turn, registry)
                        .await
                }
            })
            .await
    }

    /// Run one prompt turn on an established connection:
    /// initialize → open/resume session → apply preferences → prompt → finalize.
    async fn run_turn(
        &self,
        connection: ConnectionTo<Agent>,
        mut cancellation: watch::Receiver<bool>,
        turn: RunTurnInput,
        registry: TurnRegistry,
    ) -> Result<AgentResultPayload, agent_client_protocol::Error> {
        let RunTurnInput {
            full_prompt,
            prompt_images,
            cwd,
            resume_session_id,
            preferences,
            local_workspace,
        } = turn;

        let session = match self
            .connect_session(
                &connection,
                &mut cancellation,
                resume_session_id,
                &cwd,
                registry,
                local_workspace,
            )
            .await?
        {
            TurnPhase::Ready(session) => session,
            TurnPhase::Cancelled(payload) => return Ok(payload),
        };
        self.prompt_phase(
            &connection,
            &mut cancellation,
            session,
            &preferences,
            full_prompt,
            prompt_images,
        )
        .await
        .map_err(|e| e.error)
    }

    /// Prompt phase shared by the cold and pooled paths: apply preferences,
    /// emit `agent:status` (waiting-model), dispatch the prompt, finalize.
    /// Errors carry a pre/post-prompt marker so the pooled path can choose
    /// between a cold handoff and a terminal `agent:failed`.
    #[allow(clippy::too_many_arguments)]
    async fn prompt_phase(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        session: ConnectedSession,
        preferences: &RunPreferences,
        full_prompt: String,
        prompt_images: Vec<PromptImage>,
    ) -> Result<AgentResultPayload, PromptPhaseError> {
        self.workspace_tools_connected
            .store(session.workspace_tools.has_workspace(), Ordering::Release);
        let config_options = match self
            .apply_session_preferences(
                connection,
                cancellation,
                &session.acp_session_id,
                session.config_options,
                preferences,
            )
            .await
        {
            Ok(TurnPhase::Ready(options)) => options,
            Ok(TurnPhase::Cancelled(payload)) => return Ok(payload),
            Err(error) => return Err(PromptPhaseError::pre_prompt(error)),
        };
        emit_session_config_options(&self.app, &self.session_id, &self.agent_id, &config_options);

        if *cancellation.borrow() {
            let _ = connection
                .send_notification(CancelNotification::new(session.acp_session_id.clone()));
            return Ok(self.cancel_completed(Some(session.acp_session_id.to_string())));
        }

        // After session/load|resume, drop any history-replay chunks that
        // arrived before this turn's prompt so completed.content and the
        // UI stream only reflect the new answer.
        if session.resume_id.is_some() {
            if let Ok(mut buf) = self.content_buf.lock() {
                buf.clear();
            }
            if let Ok(mut buf) = self.thought_buf.lock() {
                buf.clear();
            }
        }
        self.live_stream.store(true, Ordering::SeqCst);

        let full_prompt = workspace_tools::prompt_context(
            full_prompt,
            session.workspace_tools.has_workspace(),
            self.is_acp_command || self.workflow.as_deref() == Some("translate"),
        );
        let mut content_blocks: Vec<ContentBlock> =
            vec![ContentBlock::Text(TextContent::new(full_prompt))];
        for img in &prompt_images {
            if img.data.trim().is_empty() || img.mime_type.trim().is_empty() {
                continue;
            }
            content_blocks.push(ContentBlock::Image(ImageContent::new(
                img.data.clone(),
                img.mime_type.clone(),
            )));
        }

        let session_id = session.acp_session_id.clone();
        let op = crate::core::log_util::OpTimer::start_with("agent_prompt", format!(
            "session_id={} provider_session_id={} agent_id={} requested_model={:?} reasoning={:?} workspace_mcp={}",
            self.session_id, session_id, self.agent_id, preferences.model_id,
            preferences.reasoning_effort, session.workspace_tools.has_workspace(),
        ));
        // Status: the prompt is on the wire; the next signal is model output.
        let _ = self.app.emit(
            "agent:status",
            AgentStatusEvent::waiting_model(self.session_id.as_str()),
        );
        let prompt_response = tokio::select! {
            response = connection
                .send_request(PromptRequest::new(session_id.clone(), content_blocks.clone()))
                .block_task() => response.map_err(PromptPhaseError::prompt_request),
            () = wait_for_cancellation(cancellation) => {
                let _ = connection
                    .send_notification(CancelNotification::new(session_id.clone()));
                op.finish_ok_extra("cancelled=true");
                return Ok(self.cancel_completed(Some(session_id.to_string())));
            }
        };
        let prompt_response = match prompt_response {
            Ok(response) => response,
            Err(error) => {
                op.finish_err_msg("agent_prompt", &error.error);
                return Err(error);
            }
        };
        op.finish_ok_extra(format!("stop_reason={:?}", prompt_response.stop_reason));

        if let Ok(mut s) = self.stop_reason.lock() {
            *s = Some(format!("{:?}", prompt_response.stop_reason));
        }

        Ok(self.finalize(&session_id))
    }

    /// Connect phase: `initialize`, then open a session via `session/resume`,
    /// `session/load`, or `session/new` (capability-aware).
    async fn connect_session(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        resume_session_id: Option<String>,
        cwd: &Path,
        registry: TurnRegistry,
        local_workspace: bool,
    ) -> Result<TurnPhase<ConnectedSession>, agent_client_protocol::Error> {
        let init = tokio::select! {
            result = timed_acp_initialize(
                connection
                    .send_request(client_initialize_request())
                    .block_task(),
            ) => result?,
            () = wait_for_cancellation(&mut *cancellation) => {
                return Ok(TurnPhase::Cancelled(self.cancel_completed(None)));
            }
        };

        // Capability-aware continue (Grok advertises loadSession but not
        // session/resume — calling resume yields Method not found).
        let can_resume = init
            .agent_capabilities
            .session_capabilities
            .resume
            .is_some();
        let can_load = init.agent_capabilities.load_session;
        let workspace_tools = workspace_tools::connect(
            &self.app,
            cwd,
            &init.agent_capabilities,
            registry,
            local_workspace,
            &self.agent_name,
        )
        .await;

        // dsh never advertises session/resume or session/load (sessions
        // die with the process), so continue degrades to a fresh session
        // instead of erroring out.
        let resume_id = if let Some(rid) = &resume_session_id {
            if can_resume || can_load {
                resume_session_id
            } else if self.dsh_fresh_sessions {
                log::debug!(
                    target: "edda::agent",
                    "dsh cannot resume {rid}: starting a fresh session"
                );
                None
            } else {
                return Err(acp_err(format!(
                    "Agent does not support continuing session {rid} \
                     (no session/resume or session/load capability)"
                )));
            }
        } else {
            None
        };

        let (acp_session_id, config_options) = if let Some(ref rid) = resume_id {
            let session = match self
                .open_resume_on(
                    connection,
                    cancellation,
                    rid,
                    cwd,
                    can_resume,
                    workspace_tools.clone(),
                )
                .await?
            {
                TurnPhase::Ready(session) => session,
                TurnPhase::Cancelled(payload) => return Ok(TurnPhase::Cancelled(payload)),
            };
            (session.acp_session_id, session.config_options)
        } else {
            let new_session = tokio::select! {
                result = timed_acp_request(
                    "new_session",
                    connection
                        .send_request(NewSessionRequest::new(cwd.to_path_buf()).mcp_servers(workspace_tools::servers(&workspace_tools)))
                        .block_task(),
                ) => result?,
                () = wait_for_cancellation(&mut *cancellation) => {
                    return Ok(TurnPhase::Cancelled(self.cancel_completed(None)));
                }
            };
            (
                new_session.session_id,
                new_session.config_options.unwrap_or_default(),
            )
        };

        Ok(TurnPhase::Ready(ConnectedSession {
            acp_session_id,
            config_options,
            resume_id,
            workspace_tools,
        }))
    }

    /// Continue `rid` on an established connection: `session/resume` when
    /// advertised, else `session/load` (Grok-style agents). Shared by the
    /// cold connect phase and the pooled run path.
    async fn open_resume_on(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        rid: &str,
        cwd: &Path,
        can_resume: bool,
        workspace_tools: WorkspaceConnection,
    ) -> Result<TurnPhase<ConnectedSession>, agent_client_protocol::Error> {
        if can_resume {
            let resp = tokio::select! {
                result = timed_acp_request(
                    "session/resume",
                    connection
                        .send_request(ResumeSessionRequest::new(
                            SessionId::new(rid),
                            cwd.to_path_buf(),
                        ).mcp_servers(workspace_tools::servers(&workspace_tools)))
                        .block_task(),
                ) => result?,
                () = wait_for_cancellation(&mut *cancellation) => {
                    return Ok(TurnPhase::Cancelled(self.cancel_completed(Some(rid.to_string()))));
                }
            };
            Ok(TurnPhase::Ready(ConnectedSession {
                acp_session_id: SessionId::new(rid),
                config_options: resp.config_options.unwrap_or_default(),
                resume_id: Some(rid.to_string()),
                workspace_tools,
            }))
        } else {
            // Called only when can_resume || can_load. Grok and similar:
            // continue across process restarts via session/load (requires
            // mcpServers; schema defaults to []).
            let resp = tokio::select! {
                result = timed_acp_request(
                    "session/load",
                    connection
                        .send_request(
                            LoadSessionRequest::new(SessionId::new(rid), cwd.to_path_buf())
                                .mcp_servers(workspace_tools::servers(&workspace_tools)),
                        )
                        .block_task(),
                ) => result?,
                () = wait_for_cancellation(&mut *cancellation) => {
                    return Ok(TurnPhase::Cancelled(self.cancel_completed(Some(rid.to_string()))));
                }
            };
            Ok(TurnPhase::Ready(ConnectedSession {
                acp_session_id: SessionId::new(rid),
                config_options: resp.config_options.unwrap_or_default(),
                resume_id: Some(rid.to_string()),
                workspace_tools,
            }))
        }
    }

    /// Apply the user's model / collaboration / effort / fast-mode preferences
    /// via `set_config_option`, refreshing `config_options` after each write.
    async fn apply_session_preferences(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        acp_session_id: &SessionId,
        mut config_options: Vec<agent_client_protocol::schema::v1::SessionConfigOption>,
        prefs: &RunPreferences,
    ) -> Result<
        TurnPhase<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>,
        agent_client_protocol::Error,
    > {
        macro_rules! return_cancelled {
            () => {
                return Ok(TurnPhase::Cancelled(
                    self.cancel_completed(Some(acp_session_id.to_string())),
                ))
            };
        }
        if let Some(ev) =
            models_from_config_options(&self.session_id, &self.agent_id, &config_options)
        {
            // Model changes can affect supported effort and service tiers, so retain the
            // complete response before resolving the remaining preferences.
            // Also attempt custom / third-party model ids not in the advertised catalog
            // (gateway models, cc-switch, free-form provider ids).
            if let Some(pref) = prefs.model_id.clone() {
                if pref != ev.current_id {
                    let listed = ev.models.iter().any(|m| m.id == pref);
                    let response = tokio::select! {
                        result = timed_acp_request(
                            "set model",
                            connection
                                .send_request(SetSessionConfigOptionRequest::new(
                                    acp_session_id.clone(),
                                    SessionConfigId::new(ev.config_id.as_str()),
                                    SessionConfigOptionValue::value_id(pref.clone()),
                                ))
                                .block_task(),
                        ) => result,
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    match response {
                        Ok(response) => {
                            config_options = response.config_options;
                        }
                        Err(e) => {
                            log::debug!(
                                target: "edda::agent",
                                "agent={} set model failed (listed={}): pref={} err={}",
                                self.agent_id,
                                listed,
                                pref,
                                e
                            );
                        }
                    }
                }
            }
        }
        if let Some(pref) = prefs.collaboration_mode_id.clone() {
            if let Some(ev) =
                collaboration_from_config_options(&self.session_id, &self.agent_id, &config_options)
            {
                if pref != ev.current_id && ev.modes.iter().any(|mode| mode.id == pref) {
                    let response = tokio::select! {
                        result = timed_acp_request(
                            "set collaboration mode",
                            connection
                                .send_request(SetSessionConfigOptionRequest::new(
                                    acp_session_id.clone(),
                                    SessionConfigId::new(ev.config_id.as_str()),
                                    SessionConfigOptionValue::value_id(pref),
                                ))
                                .block_task(),
                        ) => result.ok(),
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    if let Some(response) = response {
                        config_options = response.config_options;
                    }
                }
            }
        }
        if let Some(ev) =
            effort_from_config_options(&self.session_id, &self.agent_id, &config_options)
        {
            if let Some(pref) = prefs.resolve_reasoning_effort(&ev.efforts) {
                if pref != ev.current_id && ev.efforts.iter().any(|effort| effort.id == pref) {
                    let response = tokio::select! {
                        result = timed_acp_request(
                            "set effort",
                            connection
                                .send_request(SetSessionConfigOptionRequest::new(
                                    acp_session_id.clone(),
                                    SessionConfigId::new(ev.config_id.as_str()),
                                    SessionConfigOptionValue::value_id(pref),
                                ))
                                .block_task(),
                        ) => result.ok(),
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    if let Some(response) = response {
                        config_options = response.config_options;
                    }
                }
            }
        }
        if let Some(enabled) = prefs.fast_mode {
            if let Some(opt) = config_options.iter().find(|opt| is_fast_option(opt)) {
                if let Some(value) = fast_mode_value_to_set(opt, enabled) {
                    let response = tokio::select! {
                        result = timed_acp_request(
                            "set fast mode",
                            connection
                                .send_request(SetSessionConfigOptionRequest::new(
                                    acp_session_id.clone(),
                                    opt.id.clone(),
                                    value,
                                ))
                                .block_task(),
                        ) => result.ok(),
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    if let Some(response) = response {
                        config_options = response.config_options;
                    }
                }
            }
        }
        Ok(TurnPhase::Ready(config_options))
    }

    /// Finalize phase: snapshot the streamed buffers into the result payload and
    /// emit `agent:completed`.
    fn finalize(&self, acp_session_id: &SessionId) -> AgentResultPayload {
        let content = self
            .content_buf
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let reasoning = self
            .thought_buf
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let sources = Vec::new();
        let payload = AgentResultPayload {
            session_id: self.session_id.clone(),
            message_id: self.message_id.clone(),
            content,
            reasoning: if reasoning.is_empty() {
                None
            } else {
                Some(reasoning)
            },
            sources,
            stop_reason: self.stop_reason.lock().ok().and_then(|g| g.clone()),
            provider_session_id: Some(acp_session_id.to_string()),
        };
        self.emit_completed(payload)
    }
}

/// dsh keeps sessions in-process and never advertises resume/load, so pooling
/// would change its "continue degrades to a fresh session" semantics; every
/// other template can reuse a warm connection.
fn poolable_template(template: &AgentTemplate) -> bool {
    !matches!(template, AgentTemplate::Dsh)
}

fn pooled_session_requires_new(resume_id: Option<&str>, used: bool) -> bool {
    resume_id.is_none() && used
}

/// Terminal outcome of a pooled run: `Done` finishes the run (result or
/// post-prompt error → `agent:failed` upstream); `Handoff` marks a pre-prompt
/// failure that should fall back to the cold path.
enum PooledOutcome {
    Done(Result<AgentResultPayload, agent_client_protocol::Error>),
    Handoff,
}

/// Run one turn on a pooled warm connection: install the turn into the slot's
/// registry, resolve the session (slot's own, or resume/load on the same
/// connection), then reuse the shared prompt phase. Every exit path clears
/// the registry — a stale turn would route later notifications to a dead
/// emitter. Ok/cancel release the slot back to the pool (the connection
/// survives to serve the next turn); errors evict it.
async fn run_on_pooled(
    pool: &Arc<AgentWarmPool>,
    mut slot: PooledSlot,
    params: &RunOnceParams,
    prep: &RunTurnPrep,
) -> PooledOutcome {
    let registry = slot.registry.clone();
    let mut cancellation = params.cancellation.clone();
    let state = RunOnceContext::with_terminals(params, prep.cwd.clone(), slot.terminals.clone());

    let prev = install_turn(
        &registry,
        ActiveTurn {
            ctx: state.clone(),
            permission_policy: params.permission_policy,
            permission_gate: params.permission_gate.clone(),
            elicitation_gate: params.elicitation_gate.clone(),
            ask_user_gate: params.ask_user_gate.clone(),
            activity: Some(slot.activity.clone()),
        },
    );
    if prev.is_some() {
        log::warn!(
            target: "edda::agent",
            "agent={} pooled turn registry was not empty; replacing",
            params.desc.id
        );
    }
    // The keepalive may have retired the slot between take() and install_turn().
    if !slot.is_alive() {
        clear_turn(&registry);
        pool.evict(&slot);
        return PooledOutcome::Handoff;
    }
    slot.bump();

    // Reuse the transport, not a previous conversation: only a never-used warm
    // session may serve a new draft without session/new.
    let session = match params.resume_session_id.as_deref() {
        None if pooled_session_requires_new(None, slot.used.load(Ordering::SeqCst)) => {
            let response = tokio::select! {
                response = timed_acp_request("new_session", slot.connection.send_request(NewSessionRequest::new(prep.cwd.clone()).mcp_servers(workspace_tools::servers(&slot.workspace_tools))).block_task()) => response,
                () = wait_for_cancellation(&mut cancellation) => {
                    clear_turn(&registry);
                    pool.release(slot);
                    return PooledOutcome::Done(Ok(state.cancel_completed(None)));
                }
            };
            match response {
                Ok(response) => ConnectedSession {
                    acp_session_id: response.session_id,
                    config_options: response.config_options.unwrap_or_default(),
                    resume_id: None,
                    workspace_tools: slot.workspace_tools.clone(),
                },
                Err(_) => {
                    clear_turn(&registry);
                    pool.evict(&slot);
                    return PooledOutcome::Handoff;
                }
            }
        }
        Some(rid) if rid != slot.acp_session_id.to_string() => {
            if !slot.can_resume && !slot.can_load {
                // Neither continue capability: hand off so the cold path raises
                // the user-facing "agent does not support continuing" error.
                // The connection itself is healthy — release, don't evict.
                clear_turn(&registry);
                pool.release(slot);
                return PooledOutcome::Handoff;
            }
            match state
                .open_resume_on(
                    &slot.connection,
                    &mut cancellation,
                    rid,
                    &prep.cwd,
                    slot.can_resume,
                    slot.workspace_tools.clone(),
                )
                .await
            {
                Ok(TurnPhase::Ready(session)) => session,
                Ok(TurnPhase::Cancelled(payload)) => {
                    clear_turn(&registry);
                    slot.mark_used();
                    pool.release(slot);
                    return PooledOutcome::Done(Ok(payload));
                }
                Err(error) => {
                    // Pre-prompt failure on a warm socket: the connection is
                    // suspect — evict and let the cold path retry cleanly.
                    log::debug!(
                        target: "edda::agent",
                        "agent={} pooled session/load failed: {error}",
                        params.desc.id
                    );
                    clear_turn(&registry);
                    pool.evict(&slot);
                    return PooledOutcome::Handoff;
                }
            }
        }
        _ => ConnectedSession {
            acp_session_id: slot.acp_session_id.clone(),
            config_options: slot.config_options.clone(),
            resume_id: None,
            workspace_tools: slot.workspace_tools.clone(),
        },
    };
    let used_session_id = session.acp_session_id.clone();
    slot.mark_used();

    let preferences = RunPreferences {
        model_id: params.preferred_model_id.clone(),
        collaboration_mode_id: params.preferred_collaboration_mode_id.clone(),
        reasoning_effort: params.preferred_reasoning_effort.clone(),
        prefer_highest_reasoning_effort: params.prefer_highest_reasoning_effort,
        fast_mode: params.fast_mode,
    };
    let result = state
        .prompt_phase(
            &slot.connection,
            &mut cancellation,
            session,
            &preferences,
            prep.full_prompt.clone(),
            prep.prompt_images.clone(),
        )
        .await;

    clear_turn(&registry);
    match result {
        Ok(payload) => {
            // Record the session that actually served the turn so the next
            // turn's provider session id matches the slot.
            slot.acp_session_id = used_session_id;
            pool.release(slot);
            PooledOutcome::Done(Ok(payload))
        }
        Err(e) => {
            pool.evict(&slot);
            if e.pre_prompt {
                PooledOutcome::Handoff
            } else {
                // Flush any buffered stream text before the failure lands.
                state.coalescer.flush();
                PooledOutcome::Done(Err(e.error))
            }
        }
    }
}

/// One-shot prompt: spawn → initialize → session → prompt → stream events → completed/failed.
/// A healthy pooled warm connection short-circuits the spawn chain.
pub async fn run_once(params: RunOnceParams) -> Result<AgentResultPayload, AppError> {
    // Phase 1 — prompt: skill instructions + template envelope + cwd.
    let prep = prepare_run_turn(&params).await?;

    // Phase 1.5 — pooled warm connection: skip spawn → initialize →
    // session/new entirely when a healthy slot matches this run.
    if let Some(pool) = params.warm_pool.clone() {
        if poolable_template(&params.desc.template) {
            let key = pool_key(&params.desc, prep.cwd.clone(), params.remote.as_ref());
            if let Some(slot) = pool.take(&key).await {
                match run_on_pooled(&pool, slot, &params, &prep).await {
                    PooledOutcome::Done(result) => {
                        return match result {
                            Ok(payload) => Ok(payload),
                            Err(e) => {
                                let msg = e.to_string();
                                emit_run_failed(&params.app, &params.session_id, &msg);
                                Err(AppError::domain("acp", format!("acp: {msg}")))
                            }
                        };
                    }
                    PooledOutcome::Handoff => {
                        log::warn!(
                            target: "edda::agent",
                            "agent={} pooled connection failed pre-prompt; retrying cold",
                            params.desc.id
                        );
                    }
                }
            }
        }
    }

    // Phase 2 — spawn the ACP agent process (local, or SSH wrapper for remote).
    let acp = match to_acp_agent(&params.desc, Some(&prep.cwd), params.remote.as_deref()) {
        Ok(agent) => agent,
        Err(error) => {
            emit_run_failed(&params.app, &params.session_id, &error);
            return Err(error);
        }
    };

    // Phase 3 — connect, stream one turn, and finalize.
    let state = RunOnceContext::new(&params, prep.cwd.clone());
    let run_result = state.run(acp, params, prep).await;

    match run_result {
        Ok(payload) => Ok(payload),
        Err(e) => {
            let msg = e.to_string();
            state.coalescer.flush();
            emit_run_failed(&state.app, &state.session_id, &msg);
            Err(AppError::domain("acp", format!("acp: {msg}")))
        }
    }
}

pub fn new_ids() -> (String, String) {
    (Uuid::new_v4().to_string(), Uuid::new_v4().to_string())
}

#[cfg(test)]
mod cancelled_payload_tests {
    use crate::features::agent::acp::client::cancelled_payload;
    use std::sync::{Arc, Mutex};

    #[test]
    fn preserves_provider_session_id_after_cancel() {
        let content = Arc::new(Mutex::new("partial answer".to_string()));
        let thought = Arc::new(Mutex::new(String::new()));
        let payload = cancelled_payload(
            "runtime-session".to_string(),
            "message".to_string(),
            Some("provider-session".to_string()),
            &content,
            &thought,
        );

        assert_eq!(payload.stop_reason.as_deref(), Some("cancelled"));
        assert_eq!(
            payload.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(payload.content, "partial answer");
    }
}

#[cfg(test)]
mod prompt_delivery_tests {
    use super::*;
    use agent_client_protocol::{Client, ConnectTo, Error};
    use std::time::Duration;

    #[test]
    fn fresh_draft_never_inherits_a_used_provider_session() {
        assert!(pooled_session_requires_new(None, true));
        assert!(!pooled_session_requires_new(None, false));
        assert!(!pooled_session_requires_new(Some("paper-a"), true));
    }

    /// Transport stays open; returning the foreground (as idle teardown does)
    /// stops the driver without setting its incoming EOF flag.
    struct PendingTransport(tokio::sync::oneshot::Sender<()>);

    impl ConnectTo<Client> for PendingTransport {
        async fn connect_to(self, client: impl ConnectTo<Agent>) -> Result<(), Error> {
            let _ = self.0.send(());
            let result = std::future::pending::<Result<(), Error>>().await;
            drop(client);
            result
        }
    }

    #[tokio::test]
    async fn stopped_sdk_driver_is_not_eof_but_its_unsent_prompt_can_retry() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let connection = tokio::time::timeout(
            Duration::from_secs(2),
            Client.builder().connect_with(
                PendingTransport(started),
                move |connection| async move {
                    ready.await.map_err(|_| Error::internal_error())?;
                    Ok(connection)
                },
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            !connection.is_incoming_closed(),
            "the old pool check misses driver shutdown"
        );
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            connection
                .send_request(PromptRequest::new(
                    SessionId::new("test-session"),
                    vec![ContentBlock::Text(TextContent::new("Summarize this paper"))],
                ))
                .block_task(),
        )
        .await
        .unwrap()
        .unwrap_err();
        let failure = PromptPhaseError::prompt_request(error);
        assert!(
            failure.pre_prompt,
            "definitely unsent prompt should use the cold handoff"
        );
    }

    #[test]
    fn ambiguous_or_provider_prompt_errors_are_never_replayed() {
        for message in [
            "incoming transport closed",
            "prompt response timed out",
            "failed to send outgoing request `session/new`: connection is no longer running",
            "upstream: failed to send outgoing request `session/prompt`: connection is no longer running",
        ] {
            assert!(!PromptPhaseError::prompt_request(Error::internal_error().data(message)).pre_prompt, "{message}");
        }
        assert!(
            !PromptPhaseError::prompt_request(Error::invalid_params().data(
                "failed to send outgoing request `session/prompt`: connection is no longer running"
            ))
            .pre_prompt
        );
    }
}
