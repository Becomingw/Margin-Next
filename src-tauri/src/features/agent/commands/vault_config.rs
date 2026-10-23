//! Settings/Skill-manager operations on the current Vault's Agent files.
use crate::core::error::{ApiResult, AppError};
use crate::features::agent::service::emit_registry_changed;
use edda_core::features::vault::agent_config::{self, InstructionsFile, ManagedSkill};
use edda_core::features::vault::trash::TrashResult;
use tauri::AppHandle;

async fn run_config<T: serde::Serialize + Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> ApiResult<T> {
    crate::core::blocking::run_blocking(move || match work() {
        Ok(value) => ApiResult::ok(value),
        Err(error) => crate::core::error::map_err(error),
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_vault_skills(vault_path: String) -> ApiResult<Vec<ManagedSkill>> {
    run_config(move || {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        agent_config::list_skills(&vault)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_remove_vault_skill(
    app: AppHandle,
    vault_path: String,
    id: String,
) -> ApiResult<TrashResult> {
    run_config(move || {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        if edda_core::features::vault::presets::is_preset_skill(&id)
            && !crate::features::vault::presets::developer_mode(&app)
        {
            return Err(AppError::domain(
                "preset_skill",
                "System preset skills can only be removed in developer mode",
            ));
        }
        let result = agent_config::remove_skill(&vault, &id)?;
        emit_registry_changed(&app);
        Ok(result)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_restore_vault_skill(
    app: AppHandle,
    vault_path: String,
    id: String,
    batch_id: Option<String>,
) -> ApiResult<()> {
    run_config(move || {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        match batch_id {
            Some(batch) => agent_config::undo_remove_skill(&vault, &id, &batch)?,
            None => agent_config::restore_bundled_skill(&vault, &id)?,
        }
        emit_registry_changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_import_local_skill(
    app: AppHandle,
    vault_path: String,
    source_path: String,
) -> ApiResult<edda_core::features::paper::import::skill::SkillImportResult> {
    run_config(move || {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let result = edda_core::features::paper::import::skill::install_local_skill(
            &vault,
            std::path::Path::new(&source_path),
        )?;
        emit_registry_changed(&app);
        Ok(result)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_vault_instructions(vault_path: Option<String>) -> ApiResult<InstructionsFile> {
    run_config(move || {
        let vault = vault_path
            .as_deref()
            .map(crate::core::fs::resolve_vault)
            .transpose()?;
        agent_config::read_instructions(vault.as_deref())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_save_vault_instructions(
    app: AppHandle,
    vault_path: String,
    content: String,
    expected_revision: Option<String>,
    confirmed: bool,
) -> ApiResult<InstructionsFile> {
    run_config(move || -> Result<_, AppError> {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let result = agent_config::save_instructions(
            &vault,
            &content,
            expected_revision.as_deref(),
            confirmed,
        )?;
        emit_registry_changed(&app);
        Ok(result)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_discover_vault_skill(
    vault_path: String,
    source: String,
) -> ApiResult<edda_core::features::paper::import::skill::SkillDiscovery> {
    let result = async {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let source =
            edda_core::features::paper::scholar_api::identifiers::extract_skill_source(&source)
                .ok_or_else(|| {
                    AppError::message(
                        "Use a GitHub/skills.sh Skill URL or an npx skills add command",
                    )
                })?;
        edda_core::features::paper::import::skill::discover_skill_source(
            &vault, &source, None, None,
        )
        .await
    }
    .await;
    match result {
        Ok(value) => ApiResult::ok(value),
        Err(error) => crate::core::error::map_err(error),
    }
}
