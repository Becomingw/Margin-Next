//! IPC for carrying WebView state across the product rename; the migration
//! itself lives in `edda_core::app_rename`.

use crate::core::blocking::run_blocking;
use crate::core::error::ApiResult;
use crate::core::log_util::OpTimer;
use edda_core::app_rename::{self, WebStateEntry};

/// Bridge build: persist Web Storage for the renamed build. No-op once renamed.
#[tauri::command]
#[specta::specta]
pub async fn app_webstate_export(entries: Vec<WebStateEntry>) -> ApiResult<()> {
    run_blocking(move || {
        let op = OpTimer::start_with("app_webstate_export", format!("entries={}", entries.len()));
        op.finish_result(app_rename::export_webstate(&entries))
    })
    .await
}

/// Renamed build: Web Storage the bridge build exported, returned at most once.
#[tauri::command]
#[specta::specta]
pub async fn app_webstate_import_former() -> ApiResult<Option<Vec<WebStateEntry>>> {
    run_blocking(|| {
        let op = OpTimer::start("app_webstate_import_former");
        op.finish_result(app_rename::take_former_webstate())
    })
    .await
}
