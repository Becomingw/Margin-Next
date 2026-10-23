use crate::core::error::{map_err, ApiResult, AppError};
use edda_core::features::paper::code;
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn paper_code_inspect(vault_path: String, path: String) -> ApiResult<code::PaperCode> {
    crate::core::blocking::run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| code::inspect(&vault, &path))
        {
            Ok(value) => ApiResult::ok(value),
            Err(error) => map_err(error),
        }
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn paper_code_import(
    app: AppHandle,
    vault_path: String,
    path: String,
    url: String,
) -> ApiResult<code::CodeSnapshot> {
    let result = async {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let root = vault.clone();
        let rel = path.clone();
        let (id, _) = tokio::task::spawn_blocking(move || code::paper_directory(&root, &rel))
            .await
            .map_err(|e| AppError::message(e.to_string()))??;
        let downloaded = code::download(&url).await?;
        let root = vault.clone();
        let rel = path.clone();
        let snapshot = app
            .state::<crate::features::jobs::JobCenter>()
            .run_filesystem_change(&vault, Some(&path), move || {
                let _lock = edda_core::features::vault::agent_config::lock(&root)?;
                code::install(&root, &rel, &id, downloaded)
            })
            .await?;
        let host = crate::features::host_hooks::wrap(&app);
        edda_core::features::lifecycle::emit_paper_assets_ready(
            Some(&host),
            &vault,
            path.rsplit('/').next().unwrap_or(&path),
        );
        Ok::<_, AppError>(snapshot)
    }
    .await;
    match result {
        Ok(value) => ApiResult::ok(value),
        Err(error) => {
            log::warn!(target: "edda::paper_code", "paper_code_import failed paper={path}: {error}");
            map_err(error)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn paper_code_files(
    vault_path: String,
    path: String,
    snapshot_id: String,
) -> ApiResult<Vec<String>> {
    crate::core::blocking::run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| code::files(&vault, &path, &snapshot_id))
        {
            Ok(value) => ApiResult::ok(value),
            Err(error) => map_err(error),
        }
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn paper_code_read(
    vault_path: String,
    path: String,
    snapshot_id: String,
    file: String,
) -> ApiResult<String> {
    crate::core::blocking::run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| code::read_file(&vault, &path, &snapshot_id, &file))
        {
            Ok(value) => ApiResult::ok(value),
            Err(error) => map_err(error),
        }
    })
    .await
}
