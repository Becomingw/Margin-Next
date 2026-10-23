use crate::core::error::{map_err, ApiResult, AppError};
use edda_core::features::paper::{
    discovery::pool,
    import::pool::{promote, PoolPromotion},
};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub async fn paper_pool_read(location: String) -> ApiResult<pool::PoolSnapshot> {
    match pool::read(&location).await {
        Ok(value) => ApiResult::ok(value),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
#[specta::specta]
pub fn paper_pool_example() -> String {
    serde_json::to_string_pretty(&pool::example()).expect("static pool example")
}

#[tauri::command]
#[specta::specta]
pub async fn paper_pool_promote(
    app: AppHandle,
    location: String,
    key: String,
    vault_path: String,
) -> ApiResult<PoolPromotion> {
    let result = async {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let snapshot = pool::read(&location).await?;
        let paper = snapshot
            .papers
            .iter()
            .find(|paper| paper.key == key)
            .cloned()
            .ok_or_else(|| {
                AppError::domain(
                    "pool_candidate_changed",
                    "Recommendation changed or was removed; refresh the pool",
                )
            })?;
        let mode = crate::features::paper::import::note_mode_from_app(&app);
        let root = vault.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _lock = edda_core::features::vault::agent_config::lock(&root)?;
            tauri::async_runtime::block_on(promote(&root, &paper, mode))
        })
        .await
        .map_err(|e| AppError::message(e.to_string()))??;
        let host = crate::features::host_hooks::wrap(&app);
        edda_core::features::lifecycle::emit_paper_imported(Some(&host), &vault, &result.id);
        Ok::<_, AppError>(result)
    }
    .await;
    match result {
        Ok(value) => ApiResult::ok(value),
        Err(error) => map_err(error),
    }
}
