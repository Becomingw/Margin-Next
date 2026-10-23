use crate::core::error::{map_err, ApiResult};
use crate::features::system::network::{diagnose_network, NetworkDoctorReport};

#[tauri::command]
#[specta::specta]
pub async fn doctor_check_network() -> Result<ApiResult<NetworkDoctorReport>, String> {
    Ok(match diagnose_network().await {
        Ok(report) => ApiResult::ok(report),
        Err(error) => map_err(error),
    })
}
