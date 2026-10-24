//! Vault-owned Agent configuration. Removed skills are not silently reseeded;
//! instruction edits use revision checks and preserve customized files.

use crate::error::AppError;
use crate::frontmatter::{frontmatter_block, scalar_field};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::path::Path;

const STATE: &str = crate::vault_private_rel!("agent-config.json");
/// Bundled skills that no longer ship: the business CLI, and the workspace
/// skill under the former product name (now `edda-workspace`).
pub const RETIRED_SKILLS: &[&str] = &["agentero-cli", "agentero-workspace"];
const MAX_INSTRUCTIONS_BYTES: usize = 128 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigState {
    #[serde(default)]
    pub removed_skills: BTreeSet<String>,
    #[serde(default)]
    pub agents_template_hash: Option<String>,
    /// Vault-relative bundled skill file → hash of the content Edda last wrote.
    /// A file whose current hash differs was edited by the user and is not
    /// overwritten by later template upgrades.
    #[serde(default)]
    pub bundled_skill_hashes: BTreeMap<String, String>,
    /// Presets have been enforced once on this vault (earlier customizations
    /// were kept as `<id>-custom`); see `presets::enforce_presets`.
    #[serde(default)]
    pub presets_locked: bool,
}

/// Cross-process lock: GUI, CLI seeding and installation share the same guard.
pub fn lock(vault: &Path) -> Result<File, AppError> {
    fs::create_dir_all(vault.join(crate::paths::APP_DOT_DIR))?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(vault.join(crate::vault_private_rel!("agent-config.lock")))?;
    file.lock()?;
    Ok(file)
}

pub(crate) fn read_state(vault: &Path) -> Result<ConfigState, AppError> {
    match fs::read(vault.join(STATE)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ConfigState::default()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn save_state(vault: &Path, state: &ConfigState) -> Result<(), AppError> {
    reject_symlink(&vault.join(STATE))?;
    crate::fs::json_store(&vault.join(STATE), state)
}

/// Preserve old instructions outside the active skill search roots. Never delete
/// user edits, and never silently fall back to a global copy of a retired skill.
pub(crate) fn retire_skills(vault: &Path) -> Result<(), AppError> {
    let mut state = read_state(vault)?;
    let mut changed = false;
    for &skill in RETIRED_SKILLS {
        archive_skill(vault, skill)?;
        changed |= state.removed_skills.insert(skill.into());
    }
    if changed {
        save_state(vault, &state)?;
    }
    Ok(())
}

fn archive_skill(vault: &Path, skill: &str) -> Result<(), AppError> {
    let source = vault.join(".agents/skills").join(skill);
    let owned_parent = source
        .parent()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| {
            vault
                .canonicalize()
                .is_ok_and(|root| path.starts_with(root))
        });
    if owned_parent && source.symlink_metadata().is_ok() {
        reject_symlink(&vault.join(crate::vault_private_rel!("retired-skills")))?;
        let archive = vault
            .join(crate::vault_private_rel!("retired-skills"))
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&archive)?;
        fs::rename(&source, archive.join(skill))?;
    }
    Ok(())
}

pub fn removed_skills(vault: &Path) -> Result<BTreeSet<String>, AppError> {
    Ok(read_state(vault)?.removed_skills)
}

/// Restoring the actual folder from the recycle bin also restores availability.
pub fn skill_is_removed(vault: &Path, id: &str) -> bool {
    match read_state(vault) {
        Ok(state) => {
            state.removed_skills.contains(id)
                && !vault
                    .join(".agents/skills")
                    .join(id)
                    .join("SKILL.md")
                    .is_file()
        }
        Err(_) => true,
    }
}

/// Caller holds the configuration lock while completing an installation.
pub fn clear_removed_skill(vault: &Path, id: &str) -> Result<(), AppError> {
    let mut state = read_state(vault)?;
    if state.removed_skills.remove(id) {
        save_state(vault, &state)?;
    }
    Ok(())
}

/// Hashes of bundled skill files as Edda last wrote them (see `ConfigState`).
pub(crate) fn bundled_skill_hashes(vault: &Path) -> Result<BTreeMap<String, String>, AppError> {
    Ok(read_state(vault)?.bundled_skill_hashes)
}

/// Caller holds the configuration lock.
pub(crate) fn save_bundled_skill_hashes(
    vault: &Path,
    hashes: BTreeMap<String, String>,
) -> Result<(), AppError> {
    let mut state = read_state(vault)?;
    if state.bundled_skill_hashes != hashes {
        state.bundled_skill_hashes = hashes;
        save_state(vault, &state)?;
    }
    Ok(())
}

pub(crate) fn hash(content: &[u8]) -> String {
    hex::encode(Sha256::digest(content))
}

/// Only files whose last generated bytes are still intact may auto-upgrade.
pub(crate) fn initialize_instructions(
    vault: &Path,
    created: &mut Vec<String>,
    updated: &mut Vec<String>,
) -> Result<(), AppError> {
    let mut state = read_state(vault)?;
    let path = vault.join("AGENTS.md");
    let current = match fs::read(&path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let template = super::AGENTS_MD_TEMPLATE.as_bytes();
    let pristine = current
        .as_ref()
        .is_some_and(|bytes| state.agents_template_hash.as_deref() == Some(hash(bytes).as_str()));
    if current.is_none() || (pristine && current.as_deref() != Some(template)) {
        reject_symlink(&path)?;
        crate::fs::atomic_write(&path, template)?;
        state.agents_template_hash = Some(hash(template));
        save_state(vault, &state)?;
        if current.is_none() {
            created.push("AGENTS.md".into());
        } else {
            updated.push("AGENTS.md".into());
        }
    } else if current.as_deref() == Some(template) && state.agents_template_hash.is_none() {
        state.agents_template_hash = Some(hash(template));
        save_state(vault, &state)?;
    }
    Ok(())
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstructionsFile {
    pub content: String,
    pub default_content: String,
    pub revision: Option<String>,
}

pub fn read_instructions(vault: Option<&Path>) -> Result<InstructionsFile, AppError> {
    let bytes = if let Some(vault) = vault {
        match fs::read(vault.join("AGENTS.md")) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        }
    } else {
        None
    };
    if bytes
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_INSTRUCTIONS_BYTES)
    {
        return Err(AppError::message("AGENTS.md exceeds 128 KiB"));
    }
    let revision = bytes.as_ref().map(|bytes| hash(bytes));
    let content = bytes
        .map(String::from_utf8)
        .transpose()
        .map_err(|e| AppError::message(e.to_string()))?
        .unwrap_or_else(|| super::AGENTS_MD_TEMPLATE.into());
    Ok(InstructionsFile {
        content,
        default_content: super::AGENTS_MD_TEMPLATE.into(),
        revision,
    })
}

pub fn save_instructions(
    vault: &Path,
    content: &str,
    expected_revision: Option<&str>,
    confirmed: bool,
) -> Result<InstructionsFile, AppError> {
    if !confirmed {
        return Err(AppError::domain(
            "confirmation_required",
            "Confirm the instruction changes before saving",
        ));
    }
    if content.len() > MAX_INSTRUCTIONS_BYTES {
        return Err(AppError::message("AGENTS.md exceeds 128 KiB"));
    }
    let _guard = lock(vault)?;
    let path = vault.join("AGENTS.md");
    reject_symlink(&path)?;
    if read_instructions(Some(vault))?.revision.as_deref() != expected_revision {
        return Err(AppError::domain(
            "agent_config_conflict",
            "AGENTS.md changed on disk; reload before saving",
        ));
    }
    let mut state = read_state(vault)?;
    state.agents_template_hash =
        (content == super::AGENTS_MD_TEMPLATE).then(|| hash(content.as_bytes()));
    save_state(vault, &state)?;
    crate::fs::atomic_write(&path, content.as_bytes())?;
    read_instructions(Some(vault))
}

fn reject_symlink(path: &Path) -> Result<(), AppError> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::message(
            "Linked Agent configuration cannot be changed here",
        ));
    }
    Ok(())
}

pub fn skill_directory(vault: &Path, id: &str) -> Result<std::path::PathBuf, AppError> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', '\0']) {
        return Err(AppError::message("invalid skill id"));
    }
    let agents = vault.join(".agents");
    let root = agents.join("skills");
    reject_symlink(&agents)?;
    reject_symlink(&root)?;
    let dir = root.join(id);
    reject_symlink(&dir)?;
    Ok(dir)
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub installed: bool,
    pub valid: bool,
    pub bundled: bool,
    /// A bundled (system preset) skill whose files differ from the shipped ones.
    pub modified: bool,
    pub source: Option<String>,
}

fn metadata(
    id: &str,
    content: &str,
    installed: bool,
    bundled: bool,
    source: Option<String>,
) -> ManagedSkill {
    let fm = frontmatter_block(content).unwrap_or("");
    ManagedSkill {
        id: id.into(),
        name: scalar_field(fm, "name").unwrap_or_else(|| id.into()),
        description: scalar_field(fm, "description")
            .unwrap_or_default()
            .chars()
            .take(1024)
            .collect(),
        installed,
        valid: true,
        bundled,
        modified: false,
        source,
    }
}

pub fn list_skills(vault: &Path) -> Result<Vec<ManagedSkill>, AppError> {
    let mut items = BTreeMap::new();
    for (path, content) in super::bundled_skill_files() {
        if let Some(id) = path
            .strip_prefix(".agents/skills/")
            .and_then(|p| p.strip_suffix("/SKILL.md"))
            .filter(|id| !id.contains('/'))
        {
            items.insert(id.to_string(), metadata(id, content, false, true, None));
        }
    }
    let root = vault.join(".agents/skills");
    let entries = match fs::read_dir(&root) {
        Ok(entries) => Some(entries),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    for entry in entries.into_iter().flatten() {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let path = skill_directory(vault, &id)?.join("SKILL.md");
        let content = fs::metadata(&path)
            .ok()
            .filter(|meta| meta.len() <= 64 * 1024)
            .and_then(|_| fs::read_to_string(path).ok())
            .filter(|text| !text.trim().is_empty());
        let bundled = items.contains_key(&id);
        let source = fs::read(crate::app_rename::migrate_file_name(
            &entry.path(),
            crate::features::paper::import::skill::SKILL_PROVENANCE_FILE,
        ))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("source")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        });
        let mut item = metadata(&id, content.as_deref().unwrap_or(""), true, bundled, source);
        item.valid = content.is_some();
        item.modified = bundled
            && super::presets::preset_state(vault, &id) == super::presets::PresetState::Modified;
        items.insert(id, item);
    }
    Ok(items.into_values().collect())
}

pub fn remove_skill(vault: &Path, id: &str) -> Result<super::trash::TrashResult, AppError> {
    let _guard = lock(vault)?;
    let dir = skill_directory(vault, id)?;
    if !dir.is_dir() {
        return Err(AppError::message("skill not found"));
    }
    let mut state = read_state(vault)?;
    let inserted = state.removed_skills.insert(id.into());
    save_state(vault, &state)?;
    let result = super::trash::trash_paths(vault, &[format!(".agents/skills/{id}")]);
    if !result.as_ref().is_ok_and(|result| result.count > 0) {
        if inserted {
            state.removed_skills.remove(id);
            save_state(vault, &state)?;
        }
        return Err(AppError::message(
            "could not move the skill to the recycle bin",
        ));
    }
    result
}

pub fn restore_bundled_skill(vault: &Path, id: &str) -> Result<(), AppError> {
    let _guard = lock(vault)?;
    install_bundled_skill(vault, id)
}

/// Write a bundled skill's files as shipped. Caller holds the lock; the
/// folder must not exist.
pub(crate) fn install_bundled_skill(vault: &Path, id: &str) -> Result<(), AppError> {
    let prefix = format!(".agents/skills/{id}/");
    let files: Vec<_> = super::bundled_skill_files()
        .iter()
        .filter(|(path, _)| path.starts_with(&prefix))
        .collect();
    if files.is_empty() {
        return Err(AppError::message("unknown bundled skill"));
    }
    stage_skill(vault, id, |stage| {
        for (path, content) in files {
            let target = stage.join(path.strip_prefix(&prefix).expect("skill prefix"));
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            crate::fs::atomic_write(&target, content.as_bytes())?;
        }
        Ok(())
    })
}

/// Publish a complete Skill at once. Caller holds the configuration lock.
pub(crate) fn stage_skill(
    vault: &Path,
    id: &str,
    write: impl FnOnce(&Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let target = skill_directory(vault, id)?;
    if target.exists() {
        return Err(AppError::message("skill already installed"));
    }
    let stage = vault
        .join(crate::paths::APP_DOT_DIR)
        .join(format!("skill-stage-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::create_dir_all(&stage)?;
        write(&stage)?;
        fs::create_dir_all(target.parent().expect("skill parent"))?;
        fs::rename(&stage, target)?;
        clear_removed_skill(vault, id)
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(stage);
    }
    result
}

pub fn undo_remove_skill(vault: &Path, id: &str, batch: &str) -> Result<(), AppError> {
    let _guard = lock(vault)?;
    skill_directory(vault, id)?;
    let relative = format!(".agents/skills/{id}");
    let item = super::trash::list_trash(vault)?
        .into_iter()
        .find(|entry| entry.batch_id == batch && entry.rel == relative)
        .ok_or_else(|| AppError::message("removed skill was not found in the recycle bin"))?;
    super::trash::restore_item(vault, batch, &item.stored)?;
    clear_removed_skill(vault, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_survives_reopen_and_undo_preserves_custom_files() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path();
        super::super::ensure_vault(vault, "en").unwrap();
        let skill = skill_directory(vault, "paper-qa").unwrap();
        fs::write(skill.join("SKILL.md"), "# My custom QA").unwrap();
        fs::write(skill.join("extra.txt"), "keep me").unwrap();
        let removed = remove_skill(vault, "paper-qa").unwrap();
        super::super::ensure_vault(vault, "en").unwrap();
        assert!(skill_is_removed(vault, "paper-qa"));
        assert!(!skill.exists());
        undo_remove_skill(vault, "paper-qa", &removed.batch_id).unwrap();
        assert_eq!(
            fs::read_to_string(skill.join("SKILL.md")).unwrap(),
            "# My custom QA"
        );
        assert_eq!(
            fs::read_to_string(skill.join("extra.txt")).unwrap(),
            "keep me"
        );
        assert!(!skill_is_removed(vault, "paper-qa"));
        assert!(!removed_skills(vault).unwrap().contains("paper-qa"));
        remove_skill(vault, "paper-qa").unwrap();
        restore_bundled_skill(vault, "paper-qa").unwrap();
        assert_eq!(
            fs::read_to_string(skill.join("SKILL.md")).unwrap(),
            super::super::PAPER_QA_SKILL
        );
    }

    #[test]
    fn instructions_require_confirmation_and_reject_stale_revisions() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path();
        let original = read_instructions(Some(vault)).unwrap();
        assert!(original.revision.is_none());
        assert!(save_instructions(vault, "draft", None, false).is_err());
        assert!(!vault.join("AGENTS.md").exists());
        let saved = save_instructions(vault, "custom", None, true).unwrap();
        fs::write(vault.join("AGENTS.md"), "external edit").unwrap();
        assert!(save_instructions(vault, "stale draft", saved.revision.as_deref(), true).is_err());
        assert_eq!(
            fs::read_to_string(vault.join("AGENTS.md")).unwrap(),
            "external edit"
        );
        let latest = read_instructions(Some(vault)).unwrap();
        save_instructions(vault, "merged", latest.revision.as_deref(), true).unwrap();
        super::super::ensure_vault(vault, "en").unwrap();
        assert_eq!(
            fs::read_to_string(vault.join("AGENTS.md")).unwrap(),
            "merged"
        );
    }

    #[test]
    fn only_hash_tracked_pristine_instructions_are_upgraded() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path();
        fs::write(vault.join("AGENTS.md"), "old instructions").unwrap();
        super::super::ensure_vault(vault, "en").unwrap();
        assert_eq!(
            fs::read_to_string(vault.join("AGENTS.md")).unwrap(),
            "old instructions"
        );
        let mut state = read_state(vault).unwrap();
        state.agents_template_hash = Some(hash(b"old instructions"));
        save_state(vault, &state).unwrap();
        let result = super::super::ensure_vault(vault, "en").unwrap();
        assert!(result.updated.contains(&"AGENTS.md".into()));
        assert_eq!(
            fs::read_to_string(vault.join("AGENTS.md")).unwrap(),
            super::super::AGENTS_MD_TEMPLATE
        );
        fs::write(vault.join("AGENTS.md"), "user changed generated file").unwrap();
        super::super::ensure_vault(vault, "en").unwrap();
        assert_eq!(
            fs::read_to_string(vault.join("AGENTS.md")).unwrap(),
            "user changed generated file"
        );
    }

    #[test]
    fn failed_install_is_not_published_and_incomplete_directories_remain_removable() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path();
        let guard = lock(vault).unwrap();
        let result = stage_skill(vault, "custom", |stage| {
            fs::write(stage.join("SKILL.md"), "partial")?;
            Err(AppError::message("copy failed"))
        });
        assert!(result.is_err());
        assert!(!vault.join(".agents/skills/custom").exists());
        assert!(fs::read_dir(vault.join(crate::paths::APP_DOT_DIR))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("skill-stage-")));
        drop(guard);
        fs::create_dir_all(vault.join(".agents/skills/custom")).unwrap();
        let items = list_skills(vault).unwrap();
        let item = items.iter().find(|item| item.id == "custom").unwrap();
        assert!(item.installed && !item.valid);
        remove_skill(vault, "custom").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linked_instructions_and_traversal_are_not_modified() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let outside = temp.path().join("outside.md");
        fs::write(&outside, "outside").unwrap();
        std::os::unix::fs::symlink(&outside, vault.join("AGENTS.md")).unwrap();
        let original = read_instructions(Some(&vault)).unwrap();
        assert!(save_instructions(&vault, "new", original.revision.as_deref(), true).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
        for id in ["../outside", "..", "nested/skill", "nested\\skill"] {
            assert!(skill_directory(&vault, id).is_err());
        }
    }
}
