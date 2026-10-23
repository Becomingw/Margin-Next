//! Explicit Library actions. Ordinary metadata creation never fetches assets.
use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::jobs::{emit_job_changed, JobCenter, JobLane, StartOutcome};
use crate::features::paper::catalog::{
    papers::{PaperMetaPatch, PaperRecord},
    CapsCache,
};
use edda_core::features::{paper::import::manage, vault::flat_papers};
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn paper_create_manual(
    app: AppHandle,
    vault_path: String,
    patch: PaperMetaPatch,
) -> ApiResult<PaperRecord> {
    let result = async {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let mode = crate::features::paper::import::note_mode_from_app(&app);
        let record = manage::create_manual(&vault, &patch, mode).await?;
        let host = crate::features::host_hooks::wrap(&app);
        edda_core::features::lifecycle::emit_paper_imported(Some(&host), &vault, &record.id);
        Ok::<_, AppError>(record)
    }
    .await;
    match result {
        Ok(value) => ApiResult::ok(value),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn paper_attach_pdf(
    app: AppHandle,
    vault_path: String,
    path: String,
    source_path: String,
    replace: bool,
) -> ApiResult<manage::AttachPdfResult> {
    let result = async {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let center = app.state::<JobCenter>().inner().clone();
        let root = vault.clone();
        let rel = path.clone();
        let dirty = app
            .state::<crate::features::vault::doctor::DoctorDirtyPathsState>()
            .get(&vault_path)
            .map_err(AppError::message)?;
        if replace
            && dirty
                .iter()
                .any(|p| p.replace('\\', "/").contains(&format!("{path}/")))
        {
            return Err(AppError::domain(
                "unsaved_changes",
                "Save open paper documents before replacing the PDF",
            ));
        }
        let output = center
            .run_filesystem_change(&vault, Some(&path), move || {
                let _guard = edda_core::features::vault::agent_config::lock(&root)?;
                manage::attach_pdf(&root, &rel, std::path::Path::new(&source_path), replace)
            })
            .await?;
        app.state::<CapsCache>().invalidate(&vault, &path);
        let job = center
            .enqueue_parse_body(&vault, &path, JobLane::Normal, replace, None)
            .await;
        emit_job_changed(&app, job.clone());
        if let StartOutcome::Started(started) = center.try_start(&job.id).await {
            center.spawn_runner(&app, started);
        }
        let backend = app
            .state::<crate::features::system::settings::AppSettingsStore>()
            .layout_backend();
        center.apply_layout_backend(&backend).await;
        let job = center
            .enqueue_layout_analyze(&vault, &path, JobLane::Normal, replace)
            .await;
        emit_job_changed(&app, job.clone());
        if let StartOutcome::Started(started) = center.try_start(&job.id).await {
            center.spawn_runner(&app, started);
        }
        let host = crate::features::host_hooks::wrap(&app);
        edda_core::features::lifecycle::emit_paper_assets_ready(
            Some(&host),
            &vault,
            path.rsplit('/').next().unwrap_or(&path),
        );
        crate::features::paper::analyze::refs::spawn_parse_after_import(Some(&app), &vault, &path);
        Ok::<_, AppError>(output)
    }
    .await;
    match result {
        Ok(value) => ApiResult::ok(value),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn paper_flatten(
    app: AppHandle,
    vault_path: String,
) -> ApiResult<Vec<flat_papers::PaperPathMigration>> {
    let result = async {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let root = vault.clone();
        let dirty = app
            .state::<crate::features::vault::doctor::DoctorDirtyPathsState>()
            .get(&vault_path)
            .map_err(AppError::message)?;
        let index = app
            .state::<crate::features::vault::rename::WikiIndexState>()
            .handle();
        app.state::<JobCenter>()
            .run_filesystem_change(&vault, None, move || {
                let mut index = index.lock().map_err(|e| AppError::message(e.to_string()))?;
                flat_papers::flatten(&root, &mut index, &dirty)
            })
            .await
    }
    .await;
    match result {
        Ok(value) => {
            app.state::<CapsCache>().clear();
            ApiResult::ok(value)
        }
        Err(e) => map_err(e),
    }
}
