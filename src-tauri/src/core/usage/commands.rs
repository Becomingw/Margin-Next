//! Tauri commands for the device-local activity log.
//!
//! All commands are async and run their SQLite work in `run_blocking` so the
//! main thread (Windows UI message pump) is never blocked.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};
use crate::core::usage::{
    clear_default, list_default, record_default, summarize_default, ListFilter, UsageEvent,
    UsageKindCount, UsageRecord,
};
use serde::Deserialize;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecordArgs {
    pub events: Vec<UsageRecord>,
}

#[tauri::command]
#[specta::specta]
pub async fn activity_record_events(args: ActivityRecordArgs) -> Result<ApiResult<usize>, String> {
    Ok(run_blocking(move || match record_default(&args.events) {
        Ok(n) => ApiResult::ok(n),
        Err(e) => map_err(e),
    })
    .await)
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageListArgs {
    #[serde(default)]
    pub vault: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[tauri::command]
#[specta::specta]
pub async fn usage_list(args: UsageListArgs) -> ApiResult<Vec<UsageEvent>> {
    run_blocking(move || {
        let filter = ListFilter {
            vault: args.vault,
            kind: args.kind,
            path_prefix: args.path,
            since: args.since,
            limit: args.limit.unwrap_or(100),
        };
        match list_default(&filter) {
            Ok(rows) => ApiResult::ok(rows),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryArgs {
    #[serde(default)]
    pub vault: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn usage_summary(args: UsageSummaryArgs) -> ApiResult<Vec<UsageKindCount>> {
    run_blocking(
        move || match summarize_default(args.vault.as_deref(), args.since.as_deref()) {
            Ok(rows) => ApiResult::ok(rows),
            Err(e) => map_err(e),
        },
    )
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageClearArgs {
    #[serde(default)]
    pub vault: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn usage_clear(args: UsageClearArgs) -> ApiResult<u64> {
    run_blocking(move || match clear_default(args.vault.as_deref()) {
        Ok(n) => ApiResult::ok(n),
        Err(e) => map_err(e),
    })
    .await
}
