//! System preset skills: the first-party skills Edda ships stay exactly as
//! shipped unless developer mode is on. Enforcement compares each preset's
//! folder with the bundled files and puts the shipped version back; the first
//! run also keeps earlier customizations as `<id>-custom` user skills.
//!
//! See docs/development/developer-mode.md.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::Serialize;

use super::{agent_config, bundled_skill_files};
use crate::error::AppError;

const SKILLS: &str = ".agents/skills/";

/// Ids of the bundled skills (`.agents/skills/<id>/SKILL.md`).
pub fn preset_skill_ids() -> Vec<&'static str> {
    bundled_skill_files()
        .iter()
        .filter_map(|(path, _)| {
            path.strip_prefix(SKILLS)?
                .strip_suffix("/SKILL.md")
                .filter(|id| !id.contains('/'))
        })
        .collect()
}

pub fn is_preset_skill(id: &str) -> bool {
    preset_skill_ids().contains(&id)
}

/// `(path inside the skill folder, content)` for one preset.
fn preset_files(id: &str) -> Vec<(&'static str, &'static str)> {
    let prefix = format!("{SKILLS}{id}/");
    bundled_skill_files()
        .iter()
        .filter_map(|(path, content)| Some((path.strip_prefix(prefix.as_str())?, *content)))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetState {
    Pristine,
    Missing,
    Modified,
}

/// Files under `dir`, relative and `/`-separated; symlinks count as files.
fn files_under(dir: &Path) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut pending = vec![(dir.to_path_buf(), String::new())];
    while let Some((folder, rel)) = pending.pop() {
        for entry in fs::read_dir(&folder).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push((entry.path(), child)),
                _ => {
                    out.insert(child);
                }
            }
        }
    }
    out
}

pub fn preset_state(vault: &Path, id: &str) -> PresetState {
    let Ok(dir) = agent_config::skill_directory(vault, id) else {
        return PresetState::Modified;
    };
    if !dir.join("SKILL.md").is_file() {
        return PresetState::Missing;
    }
    let files = preset_files(id);
    let shipped: BTreeSet<String> = files.iter().map(|(rel, _)| rel.to_string()).collect();
    // Provenance and OS litter are not edits.
    let present: BTreeSet<String> = files_under(&dir)
        .into_iter()
        .filter(|rel| !rel.ends_with(".DS_Store") && !rel.starts_with(".edda"))
        .collect();
    let same = present == shipped
        && files
            .iter()
            .all(|(rel, content)| fs::read(dir.join(rel)).is_ok_and(|b| b == content.as_bytes()));
    if same {
        PresetState::Pristine
    } else {
        PresetState::Modified
    }
}

/// Presets that differ from the shipped version (missing ones excluded).
pub fn modified_presets(vault: &Path) -> Vec<String> {
    preset_skill_ids()
        .into_iter()
        .filter(|id| preset_state(vault, id) == PresetState::Modified)
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PresetRestore {
    /// Presets put back to the shipped version (edited, deleted or missing).
    pub restored: Vec<String>,
    /// Earlier customizations kept as user skills (`<id>-custom`).
    pub preserved: Vec<String>,
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), AppError> {
    fs::create_dir_all(to)?;
    for rel in files_under(from) {
        let target = to.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from.join(&rel), target)?;
    }
    Ok(())
}

/// `name: <id>` → `name: <custom>`; drop the managed `version`.
fn rename_frontmatter(content: &str, custom: &str) -> String {
    let Some(rest) = content.strip_prefix("---\n") else {
        return content.to_string();
    };
    let Some(end) = rest.find("\n---") else {
        return content.to_string();
    };
    let (front, body) = rest.split_at(end);
    let front: Vec<String> = front
        .lines()
        .filter(|line| !line.trim_start().starts_with("version:"))
        .map(|line| {
            if line.starts_with("name:") {
                format!("name: {custom}")
            } else {
                line.to_string()
            }
        })
        .collect();
    format!("---\n{}{body}", front.join("\n"))
}

/// Keep a customized preset as a user skill next to it.
fn preserve_custom(vault: &Path, id: &str) -> Result<String, AppError> {
    let mut custom = format!("{id}-custom");
    let mut n = 2;
    while agent_config::skill_directory(vault, &custom)?.exists() {
        custom = format!("{id}-custom-{n}");
        n += 1;
    }
    let from = agent_config::skill_directory(vault, id)?;
    let to = agent_config::skill_directory(vault, &custom)?;
    copy_tree(&from, &to)?;
    let skill = to.join("SKILL.md");
    if let Ok(text) = fs::read_to_string(&skill) {
        crate::fs::atomic_write(&skill, rename_frontmatter(&text, &custom).as_bytes())?;
    }
    Ok(custom)
}

/// Put every preset back to the shipped version. The first run on a vault
/// keeps customized presets as `<id>-custom`; later edits go to the recycle
/// bin. `backup` (developer mode turning off) also copies each modified
/// preset there first.
pub fn enforce_presets(vault: &Path, backup: Option<&Path>) -> Result<PresetRestore, AppError> {
    let _guard = agent_config::lock(vault)?;
    let migrating = !agent_config::read_state(vault)?.presets_locked;
    let mut report = PresetRestore::default();
    for id in preset_skill_ids() {
        let state = preset_state(vault, id);
        if state == PresetState::Pristine {
            continue;
        }
        if state == PresetState::Modified {
            if let Some(root) = backup {
                copy_tree(&agent_config::skill_directory(vault, id)?, &root.join(id))?;
            }
            if migrating {
                report.preserved.push(preserve_custom(vault, id)?);
            }
            let trashed = super::trash::trash_paths(vault, &[format!("{SKILLS}{id}")])?;
            if trashed.count == 0 {
                return Err(AppError::message(format!(
                    "could not move the edited {id} skill to the recycle bin"
                )));
            }
        }
        agent_config::install_bundled_skill(vault, id)?;
        report.restored.push(id.to_string());
    }
    let mut state = agent_config::read_state(vault)?;
    let before = state.removed_skills.len();
    state.removed_skills.retain(|id| !is_preset_skill(id));
    if migrating || state.removed_skills.len() != before {
        state.presets_locked = true;
        agent_config::save_state(vault, &state)?;
    }
    Ok(report)
}

/// The shipped `SKILL.md` of a preset, for prompts that must not trust disk.
pub fn preset_skill_content(id: &str) -> Option<&'static str> {
    preset_files(id)
        .into_iter()
        .find(|(rel, _)| *rel == "SKILL.md")
        .map(|(_, content)| content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("edda-presets-{}", uuid::Uuid::new_v4()));
        super::super::create_vault(&dir, "en").unwrap();
        dir
    }

    #[test]
    fn first_run_keeps_customizations_then_later_edits_go_to_the_bin() {
        let vault = vault();
        let skill = vault.join(".agents/skills/paper-qa/SKILL.md");
        fs::write(&skill, "---\nname: paper-qa\nversion: 5\n---\nmy version\n").unwrap();
        agent_config::remove_skill(&vault, "author-lookup").unwrap();

        let first = enforce_presets(&vault, None).unwrap();
        assert!(first.restored.contains(&"paper-qa".to_string()));
        assert!(first.restored.contains(&"author-lookup".to_string()));
        assert_eq!(first.preserved, vec!["paper-qa-custom".to_string()]);
        let custom =
            fs::read_to_string(vault.join(".agents/skills/paper-qa-custom/SKILL.md")).unwrap();
        assert!(custom.starts_with("---\nname: paper-qa-custom\n"));
        assert!(!custom.contains("version:") && custom.contains("my version"));
        assert_eq!(preset_state(&vault, "paper-qa"), PresetState::Pristine);
        assert!(!agent_config::skill_is_removed(&vault, "author-lookup"));

        fs::write(vault.join(".agents/skills/paper-qa/extra.md"), "x").unwrap();
        let backup = vault.join("backup");
        let later = enforce_presets(&vault, Some(&backup)).unwrap();
        assert_eq!(later.restored, vec!["paper-qa".to_string()]);
        assert!(later.preserved.is_empty());
        assert!(backup.join("paper-qa/extra.md").is_file());
        assert!(modified_presets(&vault).is_empty());
        assert!(enforce_presets(&vault, None).unwrap().restored.is_empty());
        let _ = fs::remove_dir_all(vault);
    }
}
