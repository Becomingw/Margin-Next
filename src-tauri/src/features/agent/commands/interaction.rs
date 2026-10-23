//! Permission / elicitation / ask-user response Tauri commands.
//!
//! Thin shells over `features::agent::service`; the request/response types
//! live in `models` so the desktop bridge can share them.

use crate::core::error::ApiResult;
use crate::features::agent::models::{
    AskUserResponseRequest, ElicitationResponseRequest, PermissionResponded,
    PermissionResponseRequest,
};
use crate::features::agent::runtime::gates::{AskUserGate, ElicitationGate, PermissionGate};
use crate::features::agent::service;
use tauri::State;

/// Answer a pending ACP permission request (ask mode). `option_id = None` cancels.
#[tauri::command]
#[specta::specta]
pub fn agent_respond_permission(
    gate: State<'_, PermissionGate>,
    request: PermissionResponseRequest,
) -> ApiResult<PermissionResponded> {
    ApiResult::ok(service::respond_permission(gate.inner(), request))
}

/// Answer a pending ACP form elicitation (`elicitation/create`).
#[tauri::command]
#[specta::specta]
pub fn agent_respond_elicitation(
    gate: State<'_, ElicitationGate>,
    request: ElicitationResponseRequest,
) -> ApiResult<PermissionResponded> {
    ApiResult::ok(service::respond_elicitation(gate.inner(), request))
}

/// Answer a pending Grok `_x.ai/ask_user_question` extension request.
#[tauri::command]
#[specta::specta]
pub fn agent_respond_ask_user(
    gate: State<'_, AskUserGate>,
    request: AskUserResponseRequest,
) -> ApiResult<PermissionResponded> {
    ApiResult::ok(service::respond_ask_user(gate.inner(), request))
}
