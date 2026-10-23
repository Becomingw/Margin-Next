//! Run heavy blocking work off the IPC/main thread.
//!
//! Synchronous `#[tauri::command]` handlers execute on the main thread; on
//! Windows the main thread also pumps the UI message loop, so a slow sync
//! command freezes the whole window. Heavy-IO commands therefore become
//! `async fn` and push their blocking body onto the async runtime's blocking
//! pool via [`run_blocking`].
//!
//! Tauri's async runtime is tokio-backed and every caller runs inside it, so
//! [`tokio::task::spawn_blocking`] targets the same blocking pool the desktop
//! shell would use — without this crate depending on tauri.

use crate::error::{map_err, ApiResult, AppError};
use serde::Serialize;

/// Execute a blocking closure on the blocking thread pool and return its
/// `ApiResult`. A join failure (panic/cancel) is surfaced as an API error.
pub async fn run_blocking<T, F>(f: F) -> ApiResult<T>
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> ApiResult<T> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => result,
        Err(e) => map_err(AppError::message(format!("blocking task failed: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of `run_blocking`: the closure must not run on the
    /// thread that awaits it (on Windows that would be the UI message pump).
    #[tokio::test]
    async fn run_blocking_moves_work_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let result = run_blocking(move || {
            let worker = std::thread::current();
            eprintln!(
                "run_blocking worker thread: id={:?} name={:?} (caller id={caller:?})",
                worker.id(),
                worker.name()
            );
            ApiResult::ok(worker.id() != caller)
        })
        .await;
        assert!(result.ok, "blocking closure result is surfaced");
        assert_eq!(
            result.data,
            Some(true),
            "closure must run on a blocking-pool thread, not the caller"
        );
    }

    #[tokio::test]
    async fn run_blocking_surfaces_panics_as_api_errors() {
        let result: ApiResult<()> = run_blocking(|| panic!("boom")).await;
        assert!(!result.ok);
        assert!(result
            .error
            .as_ref()
            .is_some_and(|e| e.message.contains("blocking task failed")));
    }
}
