//! PP-DocLayoutV3 ONNX model — XDG cache, background download, ModelScope first.

pub mod commands;

use crate::core::error::AppError;
use crate::core::paths::app_models_dir;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::http::{header, Response, StatusCode};
use tauri::AppHandle;
use tokio::sync::Mutex;

const TARGET: &str = "edda::layout::model_assets";
/// Canonical on-disk name (either full or FP16 export).
pub const LAYOUT_MODEL_FILE: &str = "pp-doclayoutv3.onnx";
/// Reject truncated / HTML error pages.
const MIN_MODEL_BYTES: u64 = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const PROGRESS_PHASE: &str = "layout-model";

/// Prefer 魔搭 (ModelScope) for CN networks; fall back to EmbedPDF’s HF FP16.
const MODEL_SOURCES: &[ModelSource] = &[
    ModelSource {
        id: "modelscope",
        url: "https://www.modelscope.cn/models/greatv/oar-ocr/resolve/master/pp-doclayoutv3.onnx",
    },
    ModelSource {
        id: "huggingface",
        url: "https://huggingface.co/datasets/embedpdf/embed-pdf-viewer/resolve/main/models/PP-DocLayoutV3-ONNX/model_fp16.onnx",
    },
];

struct ModelSource {
    id: &'static str,
    url: &'static str,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LayoutModelStatus {
    pub ready: bool,
    pub path: String,
    pub size_bytes: u64,
    pub source: Option<String>,
    /// Relative path segment for the `edda-model` URI scheme.
    pub file_name: String,
}

/// Byte progress for the projected JobCenter row (`job:progress`, task id =
/// job id).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    task_id: String,
    phase: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    progress: Option<u8>,
    current_count: Option<usize>,
    total_count: Option<usize>,
}

#[derive(Clone, Copy)]
struct ProgressCtx<'a> {
    app: Option<&'a AppHandle>,
    task_id: Option<&'a str>,
}

impl ProgressCtx<'_> {
    fn check_cancelled(&self) -> Result<(), AppError> {
        if self
            .task_id
            .is_some_and(crate::features::jobs::is_task_cancelled)
        {
            return Err(AppError::message("background task cancelled"));
        }
        Ok(())
    }

    fn emit_bytes(&self, downloaded: u64, total: Option<u64>) {
        let (Some(app), Some(task_id)) = (self.app, self.task_id) else {
            return;
        };
        let progress = total.and_then(|t| {
            downloaded
                .saturating_mul(100)
                .checked_div(t)
                .map(|p| p.min(100) as u8)
        });
        crate::features::jobs::emit_job_progress(
            app,
            &ProgressEvent {
                task_id: task_id.to_string(),
                phase: PROGRESS_PHASE.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                progress,
                current_count: None,
                total_count: None,
            },
        );
    }
}

fn download_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

async fn acquire_download_lock() -> tokio::sync::MutexGuard<'static, ()> {
    download_lock().lock().await
}

pub fn layout_model_path() -> PathBuf {
    app_models_dir().join(LAYOUT_MODEL_FILE)
}

fn source_marker_path(model: &Path) -> PathBuf {
    model.with_extension("onnx.source")
}

fn read_source_marker(model: &Path) -> Option<String> {
    fs::read_to_string(source_marker_path(model))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn model_ready(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(meta) => meta.is_file() && meta.len() >= MIN_MODEL_BYTES,
        Err(_) => false,
    }
}

pub fn status() -> LayoutModelStatus {
    let path = layout_model_path();
    let ready = model_ready(&path);
    let size_bytes = if ready {
        fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    LayoutModelStatus {
        ready,
        path: path.display().to_string(),
        size_bytes,
        source: if ready {
            read_source_marker(&path)
        } else {
            None
        },
        file_name: LAYOUT_MODEL_FILE.to_string(),
    }
}

/// Ensure the layout model exists under XDG cache.
///
/// Process-wide lock so concurrent jobs / analyze paths do not double-download.
/// Tries ModelScope first, then HuggingFace. `task_id` is the JobCenter job id:
/// byte progress is emitted as `job:progress` under it and cancellation is
/// polled through the JobCenter task-id registry.
pub async fn ensure(
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<LayoutModelStatus, AppError> {
    let progress = ProgressCtx { app, task_id };
    progress.check_cancelled()?;

    let path = layout_model_path();
    if model_ready(&path) {
        return Ok(status());
    }

    let _guard = acquire_download_lock().await;
    progress.check_cancelled()?;

    // Re-check after lock (another waiter may have finished).
    if model_ready(&path) {
        return Ok(status());
    }

    let dir = app_models_dir();
    fs::create_dir_all(&dir)?;

    let partial = dir.join(format!("{LAYOUT_MODEL_FILE}.partial"));
    let mut last_err = String::new();

    for source in MODEL_SOURCES {
        progress.check_cancelled()?;
        log::info!(
            target: TARGET,
            "downloading layout model from {} ({})",
            source.id,
            source.url
        );
        progress.emit_bytes(0, None);

        match download_to_file(source.url, &partial, progress).await {
            Ok(bytes) => {
                if bytes < MIN_MODEL_BYTES {
                    let _ = fs::remove_file(&partial);
                    last_err = format!(
                        "{}: response too small ({bytes} bytes, need ≥ {MIN_MODEL_BYTES})",
                        source.id
                    );
                    log::warn!(target: TARGET, "{last_err}");
                    continue;
                }
                // Atomic replace.
                if path.exists() {
                    let _ = fs::remove_file(&path);
                }
                fs::rename(&partial, &path).or_else(|_| {
                    // Cross-device rename fallback.
                    fs::copy(&partial, &path)?;
                    fs::remove_file(&partial)?;
                    Ok::<(), std::io::Error>(())
                })?;
                let _ = fs::write(source_marker_path(&path), source.id);
                log::info!(
                    target: TARGET,
                    "layout model ready path={} source={} size={bytes}",
                    path.display(),
                    source.id
                );
                progress.emit_bytes(bytes, Some(bytes));
                return Ok(status());
            }
            Err(e) => {
                let _ = fs::remove_file(&partial);
                if e.to_string().contains("background task cancelled") {
                    return Err(e);
                }
                last_err = format!("{}: {e}", source.id);
                log::warn!(target: TARGET, "layout model source failed: {last_err}");
            }
        }
    }

    let msg =
        format!("failed to download layout model (tried ModelScope, HuggingFace): {last_err}");
    Err(AppError::message(msg))
}

async fn download_to_file(
    url: &str,
    dest: &Path,
    progress: ProgressCtx<'_>,
) -> Result<u64, AppError> {
    progress.check_cancelled()?;
    let client =
        crate::core::http::client_with(DOWNLOAD_TIMEOUT, 10, crate::core::http::USER_AGENT)?;

    let mut res = client
        .get(url)
        .header("Accept", "application/octet-stream,*/*")
        .send()
        .await
        .map_err(|e| AppError::message(format!("download: {e}")))?;

    progress.check_cancelled()?;
    if !res.status().is_success() {
        return Err(AppError::message(format!("HTTP {}", res.status())));
    }

    let total = res.content_length();
    // Stream to disk to avoid holding ~130 MB twice.
    let mut file = fs::File::create(dest)?;
    let mut written = 0_u64;
    let mut last_emit = 0_u64;
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| AppError::message(format!("download body: {e}")))?
    {
        progress.check_cancelled()?;
        file.write_all(&chunk)?;
        written += chunk.len() as u64;
        // Throttle UI events (~256 KiB).
        if written.saturating_sub(last_emit) >= 256 * 1024 || total == Some(written) {
            progress.emit_bytes(written, total);
            last_emit = written;
        }
    }
    file.flush()?;
    progress.emit_bytes(written, total.or(Some(written)));
    Ok(written)
}

/// Register the `ModelDownload` runner with the JobCenter (app assembly).
pub fn register_job_runners(center: &crate::features::jobs::JobCenter) {
    center.register_runner(
        crate::features::jobs::JobKind::ModelDownload,
        std::sync::Arc::new(model_download_runner),
    );
}

/// Runner for [`JobKind::ModelDownload`]: download the ONNX model into the XDG
/// cache. Byte progress flows via `job:progress` (task id = job id)
/// to the projected "download" row; the terminal report carries the
/// `{source} · {bytes}` detail the legacy panel row showed on completion.
fn model_download_runner(
    center: crate::features::jobs::JobCenter,
    app: AppHandle,
    started: crate::features::jobs::StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    use crate::features::jobs::{emit_job_changed, JobState, RunOutcome};
    center.run_job(app, started, |center, app, started| async move {
        let job_id = started.snapshot.id.clone();
        match ensure(Some(&app), Some(&job_id)).await {
            Ok(model_status) => {
                let bytes = model_status.size_bytes;
                let detail = match &model_status.source {
                    Some(source) => format!("{source} · {bytes} bytes"),
                    None => format!("{bytes} bytes"),
                };
                // Terminal job_report keeps the detail as phase; `run_job`'s
                // finish() then no-ops on the already-settled job.
                if let Some(snapshot) = center
                    .job_report(
                        &job_id,
                        Some(100.0),
                        Some(detail),
                        None,
                        Some(JobState::Succeeded),
                    )
                    .await
                {
                    emit_job_changed(&app, snapshot);
                }
                RunOutcome::Succeeded
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("background task cancelled") {
                    RunOutcome::Cancelled
                } else {
                    RunOutcome::Failed(Some(msg))
                }
            }
        }
    })
}

/// App startup: enqueue the `ModelDownload` job when the model is missing.
/// Concurrent triggers (startup, analyze path, frontend prefetch) dedupe into
/// one active job through the JobCenter fingerprint.
pub fn spawn_background_download(app: AppHandle) {
    use crate::features::jobs::{emit_job_changed, JobLane, StartOutcome};
    use tauri::Manager;
    if model_ready(&layout_model_path()) {
        log::info!(
            target: TARGET,
            "layout model already present, skip startup download"
        );
        return;
    }
    tauri::async_runtime::spawn(async move {
        let center = app.state::<crate::features::jobs::JobCenter>().handle();
        let snapshot = center.enqueue_model_download(JobLane::Normal, false).await;
        log::info!(target: TARGET, "startup layout model download job={}", snapshot.id);
        emit_job_changed(&app, snapshot.clone());
        match center.try_start(&snapshot.id).await {
            StartOutcome::Started(started) => center.run_started(&app, started).await,
            StartOutcome::Skipped(skipped) => emit_job_changed(&app, skipped),
            StartOutcome::Waiting => {}
        }
    });
}

fn http_response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .expect("valid layout model response")
}

/// Custom URI scheme: serve the on-disk ONNX to onnxruntime-web via `fetch`.
pub fn handle_model_uri(
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let path = request.uri().path().trim_start_matches('/');
    // Only the layout model for now.
    if path != LAYOUT_MODEL_FILE && path != format!("models/{LAYOUT_MODEL_FILE}") {
        responder.respond(http_response(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"unknown model".to_vec(),
        ));
        return;
    }

    let file_path = layout_model_path();
    if !model_ready(&file_path) {
        responder.respond(http_response(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"model not ready".to_vec(),
        ));
        return;
    }

    match fs::read(&file_path) {
        Ok(bytes) => {
            responder.respond(http_response(
                StatusCode::OK,
                "application/octet-stream",
                bytes,
            ));
        }
        Err(e) => {
            log::warn!(target: TARGET, "read model failed: {e}");
            responder.respond(http_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain",
                b"read failed".to_vec(),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_path_under_models_dir() {
        let p = layout_model_path();
        assert_eq!(
            p.file_name().and_then(|s| s.to_str()),
            Some(LAYOUT_MODEL_FILE)
        );
        assert!(
            p.parent()
                .map(|d| d.ends_with("models") || d.ends_with("edda/models"))
                .unwrap_or(false)
                || p.to_string_lossy().contains("models")
        );
    }

    #[test]
    fn sources_prefer_modelscope() {
        assert_eq!(MODEL_SOURCES[0].id, "modelscope");
        assert!(MODEL_SOURCES[0].url.contains("modelscope.cn"));
        assert_eq!(MODEL_SOURCES[1].id, "huggingface");
    }
}
