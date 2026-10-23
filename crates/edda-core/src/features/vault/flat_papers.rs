//! Upgrade nested paper collections to a flat store; retain collection names as tags.
use super::rename::{run_local_rename_transaction, WikiIndex};
use crate::{
    error::AppError,
    features::catalog::papers::{self, PaperTag},
};
use std::{fs, path::Path};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperPathMigration {
    pub from: String,
    pub to: String,
}

/// A journal lets restored UI paths catch up even after an interrupted upgrade.
pub fn flatten(
    vault: &Path,
    index: &mut WikiIndex,
    dirty: &[String],
) -> Result<Vec<PaperPathMigration>, AppError> {
    let _lock = super::agent_config::lock(vault)?;
    let journal_path = vault.join(crate::vault_private_rel!("flat-papers.json"));
    let mut journal: Vec<PaperPathMigration> = match fs::read(&journal_path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    // Recover complete paper directories imported by older clients / sync.
    papers::rebuild_from_disk(vault)?;
    let mut rows = papers::list_all(vault)?;
    rows.sort_by(|a, b| a.path.cmp(&b.path));
    for row in rows {
        let parts: Vec<_> = row.path.split('/').collect();
        if parts.len() <= 2 || parts[0] != "papers" || !vault.join(&row.path).is_dir() {
            continue;
        }
        let from = crate::fs::sanitize_vault_rel(&row.path).map_err(AppError::message)?;
        let source = vault.join(&from);
        let mut component = vault.to_path_buf();
        for part in from.split('/') {
            component.push(part);
            if fs::symlink_metadata(&component)?.file_type().is_symlink() {
                return Err(AppError::message(
                    "Linked paper folders cannot be automatically moved",
                ));
            }
        }
        if !source.canonicalize()?.starts_with(vault.canonicalize()?) {
            return Err(AppError::message(
                "linked paper directory is outside the vault",
            ));
        }
        let base = parts.last().unwrap();
        let mut to = format!("papers/{base}");
        let mut suffix = 2;
        while vault.join(&to).exists() || papers::get_by_path(vault, &to)?.is_some() {
            to = format!("papers/{base}-{suffix}");
            suffix += 1;
        }
        let tags: Vec<_> = parts[1..parts.len() - 1]
            .iter()
            .map(|name| PaperTag::new(*name))
            .collect();
        // Persist intent first. On failure the source remains, so the journal
        // entry is not returned as a completed move and retry remains safe.
        journal.retain(|entry| entry.from != from);
        journal.push(PaperPathMigration {
            from: from.clone(),
            to: to.clone(),
        });
        crate::fs::json_store(&journal_path, &journal)?;
        run_local_rename_transaction(vault, index, &from, &to, dirty, || {
            papers::relocate_flat(vault, &from, &to, &tags).map_err(|e| e.to_string())
        })
        .map_err(|e| AppError::message(e.to_string()))?;
        // Remove only empty collection directories. Notes and other user files
        // in old collections remain accessible, never recursively deleted.
        let mut parent = source.parent();
        while let Some(dir) = parent {
            if dir == vault.join("papers") || fs::remove_dir(dir).is_err() {
                break;
            }
            parent = dir.parent();
        }
    }
    // Collection overview files belong with research notes once papers leave.
    // Use the same link-aware transaction and journal; never overwrite a note.
    let categories: std::collections::BTreeSet<_> = journal
        .iter()
        .filter_map(|entry| {
            let parts: Vec<_> = entry.from.split('/').collect();
            (parts.len() > 2 && parts[0] == "papers").then(|| format!("papers/{}", parts[1]))
        })
        .collect();
    for from in categories {
        if !vault.join(&from).is_dir() || !papers::list_under_path(vault, &from)?.is_empty() {
            continue;
        }
        let base = from.strip_prefix("papers/").unwrap();
        let mut to = format!("notes/paper-collections/{base}");
        let mut suffix = 2;
        while vault.join(&to).exists() {
            to = format!("notes/paper-collections/{base}-{suffix}");
            suffix += 1;
        }
        fs::create_dir_all(vault.join("notes/paper-collections"))?;
        journal.retain(|entry| entry.from != from);
        journal.push(PaperPathMigration {
            from: from.clone(),
            to: to.clone(),
        });
        crate::fs::json_store(&journal_path, &journal)?;
        run_local_rename_transaction(vault, index, &from, &to, dirty, || Ok(()))
            .map_err(|e| AppError::message(e.to_string()))?;
    }
    if let Ok(entries) = fs::read_dir(vault.join("papers")) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir())
                && papers::get_by_path(
                    vault,
                    &format!("papers/{}", entry.file_name().to_string_lossy()),
                )?
                .is_none()
            {
                let _ = fs::remove_dir(entry.path()); // empty legacy collections only
            }
        }
    }
    Ok(journal
        .into_iter()
        .filter(|entry| !vault.join(&entry.from).exists() && vault.join(&entry.to).is_dir())
        .collect())
}

#[cfg(test)]
#[path = "flat_papers_tests.rs"]
mod tests;
