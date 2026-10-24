//! Narrow desktop adapter; all mutations use the transactional command envelope.
use super::MarginRoots;
use crate::core::{
    blocking::run_blocking,
    error::{map_err, ApiResult},
};
use margin_core::{
    error::AppError,
    features::{
        margin as service,
        review::{diff::diff_lines, ReviewUnitSummary},
    },
};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginDiffResult {
    pub hunks: Vec<margin_core::features::review::DiffHunk>,
    pub baseline_at: String,
}

fn root(roots: &MarginRoots, path: &str) -> Result<PathBuf, AppError> {
    let root = std::fs::canonicalize(Path::new(path))?;
    if !roots
        .0
        .lock()
        .map_err(|_| AppError::message("workspace lock poisoned"))?
        .contains(&root)
    {
        return Err(AppError::message("workspace has not been opened"));
    }
    Ok(root)
}
fn api<T: serde::Serialize>(r: Result<T, AppError>) -> ApiResult<T> {
    match r {
        Ok(v) => ApiResult::ok(v),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
pub async fn margin_ai_start(
    roots: tauri::State<'_, MarginRoots>,
    ai: tauri::State<'_, super::ai::Controller>,
    vault_path: String,
    review_id: String,
    label: String,
) -> Result<super::ai::Status, String> {
    let root = root(&roots, &vault_path).map_err(|e| e.to_string())?;
    ai.start(root, review_id, label).await
}
#[tauri::command]
pub async fn margin_ai_stop(
    ai: tauri::State<'_, super::ai::Controller>,
) -> Result<super::ai::Status, String> {
    ai.stop().await
}
#[tauri::command]
pub async fn margin_ai_status(
    ai: tauri::State<'_, super::ai::Controller>,
) -> Result<super::ai::Status, String> {
    Ok(ai.status().await)
}
#[tauri::command]
pub async fn margin_proposal_detail(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
    proposal_id: String,
) -> Result<ApiResult<Value>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || {
        api(root.and_then(|r| service::proposal_detail(&r, &review_id, &proposal_id)))
    })
    .await)
}

#[tauri::command]
pub async fn margin_create(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    title: String,
) -> Result<ApiResult<ReviewUnitSummary>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || api(root.and_then(|r| service::create(&r, &title)))).await)
}
#[tauri::command]
pub async fn margin_import(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    file_paths: Vec<String>,
) -> Result<ApiResult<Vec<ReviewUnitSummary>>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || api(root.and_then(|r| service::import_files(&r, &file_paths)))).await)
}
#[tauri::command]
pub async fn margin_list(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
) -> Result<ApiResult<Vec<ReviewUnitSummary>>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || api(root.and_then(|r| service::list(&r)))).await)
}
#[tauri::command]
pub async fn margin_open(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
) -> Result<ApiResult<service::View>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || api(root.and_then(|r| service::open(&r, &review_id)))).await)
}
#[tauri::command]
pub async fn margin_stamp(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
) -> Result<ApiResult<String>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || {
        api(root
            .and_then(|r| service::sequence(&r, &review_id))
            .map(|v| v.to_string()))
    })
    .await)
}
#[tauri::command]
pub async fn margin_command(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
    command_id: String,
    request: Value,
) -> Result<ApiResult<service::View>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || {
        api(root.and_then(|r| service::execute(&r, &review_id, &command_id, request)))
    })
    .await)
}
#[tauri::command]
pub async fn margin_updates(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
    after: i64,
    limit: Option<usize>,
) -> Result<ApiResult<Value>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || {
        api(root.and_then(|r| service::updates(&r, &review_id, after, limit.unwrap_or(100))))
    })
    .await)
}
#[tauri::command]
pub async fn margin_revision(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
    revision_id: String,
) -> Result<ApiResult<String>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || {
        api(root.and_then(|r| service::read_revision(&r, &review_id, &revision_id)))
    })
    .await)
}
#[tauri::command]
pub async fn margin_suggestions(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
    proposal_id: String,
    after: usize,
    limit: Option<usize>,
) -> Result<ApiResult<Value>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || {
        api(root.and_then(|r| {
            service::suggestions(&r, &review_id, &proposal_id, after, limit.unwrap_or(100))
        }))
    })
    .await)
}
#[tauri::command]
pub async fn margin_diff(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
) -> Result<ApiResult<MarginDiffResult>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || {
        api(root
            .and_then(|r| service::open(&r, &review_id))
            .map(|v| MarginDiffResult {
                hunks: diff_lines(&v.state.baseline_text, &v.manuscript),
                baseline_at: v.state.created_at,
            }))
    })
    .await)
}
#[tauri::command]
pub async fn margin_export(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
    dest_dir: String,
) -> Result<ApiResult<String>, String> {
    let root = root(&roots, &vault_path);
    Ok(run_blocking(move || {
        api(root.and_then(|r| service::export(&r, &review_id, Path::new(&dest_dir))))
    })
    .await)
}
#[tauri::command]
pub async fn margin_parse_pdf(
    roots: tauri::State<'_, MarginRoots>,
    vault_path: String,
    review_id: String,
) -> Result<ApiResult<service::View>, String> {
    let root = match root(&roots, &vault_path) {
        Ok(r) => r,
        Err(e) => return Ok(map_err(e)),
    };
    let id = review_id.clone();
    let r = root.clone();
    let view = match tokio::task::spawn_blocking(move || service::open(&r, &id))
        .await
        .map_err(|e| e.to_string())?
    {
        Ok(v) => v,
        Err(e) => return Ok(map_err(e)),
    };
    let pdf = match view.state.pdf_file.as_ref() {
        Some(p) => p,
        None => return Ok(map_err(AppError::message("no PDF in document"))),
    };
    let dir = root.join(".margin").join("documents").join(&review_id);
    // Parser writes a derived artifact only, never a live manuscript.
    let result = margin_core::features::paper::analyze::parse::parse_pdf_to_dir(
        &dir.join(pdf),
        &dir,
        "parsed.md",
        None,
    )
    .await;
    let markdown = match result {
        Ok(md) => md,
        Err(e) => return Ok(map_err(e)),
    };
    Ok(run_blocking(move || {
        api(service::execute(
            &root,
            &review_id,
            &margin_core::features::review::model::new_id("parse"),
            serde_json::json!({"kind":"parsed-pdf","expectedStamp":view.stamp,"markdown":markdown}),
        ))
    })
    .await)
}
