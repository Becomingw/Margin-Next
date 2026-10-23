//! System preset skills on the desktop: outside developer mode, a vault's
//! bundled skills are put back to the shipped version when the vault opens
//! and whenever their files change. See docs/development/developer-mode.md.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use edda_core::features::vault::presets::{self, PresetRestore};
use tauri::{AppHandle, Emitter, Manager};

use crate::core::error::{map_err, ApiResult, AppError};

pub const RESTORED_EVENT: &str = "vault:presets-restored";

pub fn developer_mode(app: &AppHandle) -> bool {
    app.try_state::<crate::features::system::settings::AppSettingsStore>()
        .and_then(|store| store.get().ok())
        .is_some_and(|state| state.settings.developer_mode)
}

/// A preset skill folder: `<vault>/.agents/skills/<preset>/…`.
pub fn is_preset_path(vault: &Path, path: &Path) -> bool {
    path.strip_prefix(vault.join(".agents").join("skills"))
        .ok()
        .and_then(|rel| rel.components().next())
        .and_then(|first| first.as_os_str().to_str())
        .is_some_and(presets::is_preset_skill)
}

/// Put presets back unless developer mode is on (vault open).
pub fn enforce(app: &AppHandle, vault: &Path) -> Result<PresetRestore, AppError> {
    if developer_mode(app) {
        return Ok(PresetRestore::default());
    }
    presets::enforce_presets(vault, None)
}

/// `.agents/skills/<preset>` appears in `text` (a path or a shell command).
fn mentions_preset(text: &str) -> bool {
    let text = text.replace('\\', "/");
    text.match_indices(".agents/skills/").any(|(at, needle)| {
        let rest = &text[at + needle.len()..];
        let id: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        presets::is_preset_skill(&id)
    })
}

/// An agent permission request that could change a preset skill: anything
/// but reading/searching whose paths or input name a preset folder.
pub fn request_touches_preset(
    request: &agent_client_protocol::schema::v1::RequestPermissionRequest,
) -> bool {
    use agent_client_protocol::schema::v1::ToolKind;
    let fields = &request.tool_call.fields;
    if matches!(
        fields.kind.as_ref(),
        Some(ToolKind::Read | ToolKind::Search | ToolKind::Think | ToolKind::Fetch)
    ) {
        return false;
    }
    let in_paths = fields
        .locations
        .iter()
        .flatten()
        .any(|location| mentions_preset(&location.path.to_string_lossy()));
    in_paths
        || fields
            .raw_input
            .as_ref()
            .is_some_and(|input| mentions_preset(&input.to_string()))
}

static SCHEDULED: AtomicBool = AtomicBool::new(false);

/// Watcher hook: a preset's files changed. Restores them shortly after (one
/// pass per burst of events) and tells the app which ones.
pub fn on_files_changed(app: &AppHandle, vault_root: &str, paths: &[String]) {
    let vault = PathBuf::from(vault_root);
    if !paths.iter().any(|p| is_preset_path(&vault, Path::new(p))) || developer_mode(app) {
        return;
    }
    if SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(800)).await;
        SCHEDULED.store(false, Ordering::SeqCst);
        if developer_mode(&app) {
            return;
        }
        let result =
            tauri::async_runtime::spawn_blocking(move || presets::enforce_presets(&vault, None))
                .await;
        match result {
            Ok(Ok(report)) if !report.restored.is_empty() => {
                let _ = app.emit(RESTORED_EVENT, report);
            }
            Ok(Err(e)) => log::warn!(target: "edda::presets", "restore failed: {e}"),
            _ => {}
        }
    });
}

/// Presets whose files differ from the shipped version (to confirm before
/// developer mode turns off).
#[tauri::command]
#[specta::specta]
pub async fn preset_skills_modified(vault_path: String) -> ApiResult<Vec<String>> {
    match crate::core::fs::resolve_vault(&vault_path) {
        Ok(vault) => ApiResult::ok(presets::modified_presets(&vault)),
        Err(e) => map_err(e),
    }
}

/// Put presets back to the shipped version, copying modified ones to
/// `<config>/dev-backups/<time>/<vault>/` first (developer mode turned off).
#[tauri::command]
#[specta::specta]
pub async fn preset_skills_restore(vault_path: String) -> ApiResult<PresetRestore> {
    crate::core::blocking::run_blocking(move || {
        let restore = || -> Result<PresetRestore, AppError> {
            let vault = crate::core::fs::resolve_vault(&vault_path)?;
            let name = vault
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "vault".into());
            let backup = crate::core::paths::app_config_dir()
                .join("dev-backups")
                .join(chrono::Local::now().format("%Y%m%d-%H%M%S").to_string())
                .join(name);
            presets::enforce_presets(&vault, Some(&backup))
        };
        match restore() {
            Ok(report) => ApiResult::ok(report),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_folders_are_recognized_in_paths_and_commands() {
        assert!(mentions_preset("/v/.agents/skills/paper-qa/SKILL.md"));
        assert!(mentions_preset("rm -rf .agents/skills/site-import"));
        assert!(mentions_preset(
            "C:\\v\\.agents\\skills\\paper-reader\\SKILL.md"
        ));
        assert!(!mentions_preset("/v/.agents/skills/my-skill/SKILL.md"));
        assert!(!mentions_preset(
            "/v/.agents/skills/paper-qa-custom/SKILL.md"
        ));
        assert!(is_preset_path(
            Path::new("/v"),
            Path::new("/v/.agents/skills/paper-qa/x.md")
        ));
        assert!(!is_preset_path(Path::new("/v"), Path::new("/v/notes/x.md")));
    }
}
