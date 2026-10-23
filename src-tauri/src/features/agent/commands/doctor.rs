use crate::core::error::{map_err, ApiResult};
use crate::features::agent::doctor::{diagnose_host, HostDoctorReport};
use crate::features::agent::AgentRegistry;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn doctor_check_host(
    registry: State<'_, AgentRegistry>,
) -> Result<ApiResult<HostDoctorReport>, String> {
    Ok(match diagnose_host(registry.inner()).await {
        Ok(report) => ApiResult::ok(report),
        Err(error) => map_err(error),
    })
}
