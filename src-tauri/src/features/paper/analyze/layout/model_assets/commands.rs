//! Tauri commands for layout ONNX model status.
//!
//! The download itself runs as a JobCenter `ModelDownload` job (Host runner in
//! the parent module); enqueue via `job_model_download_enqueue`.

use super::{status, LayoutModelStatus};
use crate::core::error::ApiResult;

#[tauri::command]
#[specta::specta]
pub fn layout_model_status() -> ApiResult<LayoutModelStatus> {
    ApiResult::ok(status())
}
