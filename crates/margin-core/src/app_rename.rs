//! One-time migration from the product's former name (Agentero → Edda).
//!
//! Every on-disk identifier derives from [`paths::APP_SLUG`]. Once that slug
//! differs from [`FORMER_APP_SLUG`], state written by the former build is
//! carried over: the vault-private directory before the catalog opens, the
//! XDG config/data directories at startup, renamed sidecars on access, and the
//! WebView state a bridge build exported. While the build still uses the
//! former slug ([`renamed`] is false) all of it is a no-op, except the guard
//! that refuses a vault the successor build has already taken over.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::fs::VaultFs;
use crate::paths::{self, APP_DOT_DIR, APP_SLUG};

/// Slug of the build being migrated from.
pub const FORMER_APP_SLUG: &str = "agentero";

/// Slug of the build that replaces the former one. Only consulted while this
/// build still uses the former slug, to avoid splitting a vault in two.
pub const SUCCESSOR_APP_SLUG: &str = "edda";

/// Every name the vault-private directory has had. Tree, wiki, watcher and
/// sync scans skip all of them so a leftover never shows up as user content.
pub const KNOWN_APP_DOT_DIRS: &[&str] = &[".agentero", ".edda"];

/// Domain error: the vault's private state now belongs to the successor build.
pub const ERR_VAULT_UPGRADED: &str = "vault.upgraded_to_successor";

/// Marker left in a former XDG directory after its contents were copied.
const MIGRATED_MARKER: &str = "MIGRATED.txt";

/// WebView state exported by the bridge build, in its config directory.
const WEBSTATE_FILE: &str = "webstate.json";
const WEBSTATE_IMPORTED_FILE: &str = "webstate.imported.json";

/// Whether this build runs under a new slug and must migrate former state.
pub fn renamed() -> bool {
    APP_SLUG != FORMER_APP_SLUG
}

fn dot_dir(slug: &str) -> String {
    format!(".{slug}")
}

/// The former spelling of a slug-derived file name (`edda-cite.json` →
/// `agentero-cite.json`), or `None` when nothing was renamed.
pub fn former_name(current: &str) -> Option<String> {
    former_name_with(current, APP_SLUG, FORMER_APP_SLUG)
}

fn former_name_with(current: &str, slug: &str, former: &str) -> Option<String> {
    (slug != former && current.contains(slug)).then(|| current.replacen(slug, former, 1))
}

/// `dir/name`, first renaming a file the former build left as `former_name`.
/// Best-effort: on failure the caller sees the file as missing and rebuilds it.
pub fn migrate_file_name(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    if let Some(former) = former_name(name) {
        let former = dir.join(former);
        if !path.exists() && former.is_file() {
            if let Err(error) = fs::rename(&former, &path) {
                log::warn!(
                    target: "edda::app_rename",
                    "rename {} → {} failed: {error}",
                    former.display(),
                    path.display()
                );
            }
        }
    }
    path
}

/// Outcome of carrying the former vault-private directory over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultDirMigration {
    /// Nothing under the former name.
    NotNeeded,
    /// The former directory was renamed in place.
    Renamed,
    /// Both existed; every former entry moved into the current directory.
    Merged,
    /// Both existed and these former entries collide with current ones; they
    /// stay under the former directory, the current ones win.
    Conflict(Vec<String>),
}

/// Carry `{vault}/.<former>` over to `{vault}/.<slug>`. Must run before
/// anything creates the current directory's catalog, otherwise the vault opens
/// empty. Fails when the successor build already owns the vault.
pub fn migrate_vault_dir(vault: &Path) -> Result<VaultDirMigration, AppError> {
    if !renamed() {
        refuse_successor_vault(vault)?;
        return Ok(VaultDirMigration::NotNeeded);
    }
    let outcome = migrate_dir_names(vault, &dot_dir(FORMER_APP_SLUG), APP_DOT_DIR)?;
    if outcome != VaultDirMigration::NotNeeded {
        log::info!(
            target: "edda::app_rename",
            "vault {}: {outcome:?}",
            vault.display()
        );
    }
    Ok(outcome)
}

fn refuse_successor_vault(vault: &Path) -> Result<(), AppError> {
    let successor = vault.join(dot_dir(SUCCESSOR_APP_SLUG));
    if successor.join("catalog.sqlite").is_file() && !paths::vault_private_dir(vault).exists() {
        return Err(upgraded_error());
    }
    Ok(())
}

fn upgraded_error() -> AppError {
    AppError::domain(
        ERR_VAULT_UPGRADED,
        "This vault has been upgraded to Edda. Open it with Edda instead.",
    )
}

fn migrate_dir_names(vault: &Path, from: &str, to: &str) -> Result<VaultDirMigration, AppError> {
    if from == to {
        return Ok(VaultDirMigration::NotNeeded);
    }
    let old = vault.join(from);
    let new = vault.join(to);
    match fs::symlink_metadata(&old) {
        Ok(meta) if meta.is_dir() => {}
        _ => return Ok(VaultDirMigration::NotNeeded),
    }
    if fs::symlink_metadata(&new).is_err() {
        fs::rename(&old, &new).map_err(|error| rename_error(&old, &new, error))?;
        return Ok(VaultDirMigration::Renamed);
    }
    // Something created the current directory first (e.g. a config write).
    // Move what it lacks; never overwrite what it already has.
    let mut conflicts = Vec::new();
    for entry in fs::read_dir(&old)? {
        let entry = entry?;
        let target = new.join(entry.file_name());
        if fs::symlink_metadata(&target).is_ok() {
            conflicts.push(entry.file_name().to_string_lossy().into_owned());
            continue;
        }
        fs::rename(entry.path(), &target)
            .map_err(|error| rename_error(&entry.path(), &target, error))?;
    }
    if conflicts.is_empty() {
        fs::remove_dir(&old)?;
        Ok(VaultDirMigration::Merged)
    } else {
        conflicts.sort();
        log::warn!(
            target: "edda::app_rename",
            "{} kept under {} (already present in {})",
            conflicts.join(", "),
            old.display(),
            new.display()
        );
        Ok(VaultDirMigration::Conflict(conflicts))
    }
}

fn rename_error(from: &Path, to: &Path, error: std::io::Error) -> AppError {
    AppError::message(format!(
        "cannot move {} to {} (is another copy of the app using this vault?): {error}",
        from.display(),
        to.display()
    ))
}

/// [`migrate_vault_dir`] for a remote vault behind [`VaultFs`]. Only the plain
/// rename is handled; when both directories exist the current one wins.
pub async fn migrate_vault_dir_fs(fs: &dyn VaultFs) -> Result<VaultDirMigration, AppError> {
    if !renamed() {
        let successor_catalog = format!("{}/catalog.sqlite", dot_dir(SUCCESSOR_APP_SLUG));
        if fs.exists(&successor_catalog).await? && !fs.exists(APP_DOT_DIR).await? {
            return Err(upgraded_error());
        }
        return Ok(VaultDirMigration::NotNeeded);
    }
    let former = dot_dir(FORMER_APP_SLUG);
    if !fs.exists(&former).await? {
        return Ok(VaultDirMigration::NotNeeded);
    }
    if fs.exists(APP_DOT_DIR).await? {
        log::warn!(
            target: "edda::app_rename",
            "remote vault has both {former} and {APP_DOT_DIR}; keeping {APP_DOT_DIR}"
        );
        return Ok(VaultDirMigration::Conflict(vec![former]));
    }
    fs.rename(&former, APP_DOT_DIR).await?;
    Ok(VaultDirMigration::Renamed)
}

/// Copy the former XDG config and data directories to the current ones, once.
/// Runs at startup before settings load. The former directories stay intact
/// (plus a marker) so the former build keeps working and rollback is possible.
pub fn migrate_app_dirs() {
    if !renamed() {
        return;
    }
    for base in [paths::xdg_config_home(), paths::xdg_data_home()] {
        let from = base.join(FORMER_APP_SLUG);
        let to = base.join(APP_SLUG);
        match copy_dir_once(&from, &to) {
            Ok(true) => log::info!(
                target: "edda::app_rename",
                "copied {} → {}",
                from.display(),
                to.display()
            ),
            Ok(false) => {}
            Err(error) => log::warn!(
                target: "edda::app_rename",
                "copy {} → {} failed: {error}",
                from.display(),
                to.display()
            ),
        }
    }
}

/// Copy `from` to `to` through a staging sibling so a crash never leaves a
/// half-filled `to` that would block the next attempt. `false` when skipped.
fn copy_dir_once(from: &Path, to: &Path) -> Result<bool, AppError> {
    if from == to || !from.is_dir() || to.exists() {
        return Ok(false);
    }
    let name = to
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staging = to.with_file_name(format!(".{name}.migrating-{}", uuid::Uuid::new_v4()));
    let result = crate::features::paper::catalog::copy_dir_all(from, &staging)
        .and_then(|()| fs::rename(&staging, to).map_err(AppError::from));
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = fs::remove_file(to.join(MIGRATED_MARKER));
    let _ = fs::write(
        from.join(MIGRATED_MARKER),
        format!(
            "Copied to {} on first launch of the renamed app.\n",
            to.display()
        ),
    );
    Ok(true)
}

/// One Web Storage entry carried from the former build's WebView.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct WebStateEntry {
    pub key: String,
    pub value: String,
}

/// Bridge build: save the WebView's Web Storage so the renamed build, whose
/// WebView data directory differs, can restore it. No-op once renamed.
pub fn export_webstate(entries: &[WebStateEntry]) -> Result<(), AppError> {
    if renamed() {
        return Ok(());
    }
    write_webstate(&paths::app_config_dir(), entries)
}

fn write_webstate(dir: &Path, entries: &[WebStateEntry]) -> Result<(), AppError> {
    fs::create_dir_all(dir)?;
    let raw = serde_json::to_vec(entries)?;
    crate::fs::atomic_write(&dir.join(WEBSTATE_FILE), &raw)?;
    Ok(())
}

/// Renamed build: take the bridge build's export, at most once. The file is
/// renamed rather than deleted so a failed restore can be retried by hand.
pub fn take_former_webstate() -> Result<Option<Vec<WebStateEntry>>, AppError> {
    if !renamed() {
        return Ok(None);
    }
    take_webstate(&paths::xdg_config_home().join(FORMER_APP_SLUG))
}

fn take_webstate(dir: &Path) -> Result<Option<Vec<WebStateEntry>>, AppError> {
    let path = dir.join(WEBSTATE_FILE);
    let Ok(raw) = fs::read(&path) else {
        return Ok(None);
    };
    fs::rename(&path, dir.join(WEBSTATE_IMPORTED_FILE))?;
    Ok(Some(serde_json::from_slice(&raw)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn known_dot_dirs_cover_former_and_successor() {
        assert!(KNOWN_APP_DOT_DIRS.contains(&dot_dir(FORMER_APP_SLUG).as_str()));
        assert!(KNOWN_APP_DOT_DIRS.contains(&dot_dir(SUCCESSOR_APP_SLUG).as_str()));
        assert!(KNOWN_APP_DOT_DIRS.contains(&APP_DOT_DIR));
    }

    #[test]
    fn former_name_swaps_the_slug_once() {
        assert_eq!(
            former_name_with("edda-cite.json", "edda", "agentero").as_deref(),
            Some("agentero-cite.json")
        );
        assert_eq!(former_name_with("metadata.json", "edda", "agentero"), None);
        assert_eq!(
            former_name_with("agentero-cite.json", "agentero", "agentero"),
            None
        );
    }

    #[test]
    fn vault_dir_is_renamed_when_only_the_former_exists() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join(".old")).unwrap();
        fs::write(vault.path().join(".old/catalog.sqlite"), b"db").unwrap();
        let outcome = migrate_dir_names(vault.path(), ".old", ".new").unwrap();
        assert_eq!(outcome, VaultDirMigration::Renamed);
        assert_eq!(
            fs::read(vault.path().join(".new/catalog.sqlite")).unwrap(),
            b"db"
        );
        assert!(!vault.path().join(".old").exists());
        // Idempotent.
        assert_eq!(
            migrate_dir_names(vault.path(), ".old", ".new").unwrap(),
            VaultDirMigration::NotNeeded
        );
    }

    #[test]
    fn vault_dir_merges_into_a_current_dir_created_first() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join(".old")).unwrap();
        fs::write(vault.path().join(".old/catalog.sqlite"), b"db").unwrap();
        fs::create_dir(vault.path().join(".new")).unwrap();
        fs::write(vault.path().join(".new/agent-config.json"), b"{}").unwrap();
        let outcome = migrate_dir_names(vault.path(), ".old", ".new").unwrap();
        assert_eq!(outcome, VaultDirMigration::Merged);
        assert!(vault.path().join(".new/catalog.sqlite").is_file());
        assert!(vault.path().join(".new/agent-config.json").is_file());
        assert!(!vault.path().join(".old").exists());
    }

    #[test]
    fn vault_dir_conflict_keeps_current_and_leaves_former_entries() {
        let vault = tempdir().unwrap();
        for (dir, body) in [
            (".old", b"former".as_slice()),
            (".new", b"current".as_slice()),
        ] {
            fs::create_dir(vault.path().join(dir)).unwrap();
            fs::write(vault.path().join(dir).join("catalog.sqlite"), body).unwrap();
        }
        fs::write(vault.path().join(".old/doctor.json"), b"{}").unwrap();
        let outcome = migrate_dir_names(vault.path(), ".old", ".new").unwrap();
        assert_eq!(
            outcome,
            VaultDirMigration::Conflict(vec!["catalog.sqlite".into()])
        );
        assert_eq!(
            fs::read(vault.path().join(".new/catalog.sqlite")).unwrap(),
            b"current"
        );
        assert!(vault.path().join(".new/doctor.json").is_file());
        assert!(vault.path().join(".old/catalog.sqlite").is_file());
    }

    #[test]
    fn vault_with_only_the_current_dir_needs_nothing() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join(APP_DOT_DIR)).unwrap();
        assert_eq!(
            migrate_vault_dir(vault.path()).unwrap(),
            VaultDirMigration::NotNeeded
        );
    }

    #[test]
    fn unrenamed_build_refuses_a_vault_the_successor_took_over() {
        if renamed() {
            return;
        }
        let vault = tempdir().unwrap();
        let successor = vault.path().join(dot_dir(SUCCESSOR_APP_SLUG));
        fs::create_dir(&successor).unwrap();
        fs::write(successor.join("catalog.sqlite"), b"db").unwrap();
        let err = migrate_vault_dir(vault.path()).unwrap_err();
        assert!(err.to_string().contains("Edda"), "{err}");
        // Its own directory present (e.g. both builds used the vault): open it.
        fs::create_dir(vault.path().join(APP_DOT_DIR)).unwrap();
        assert!(migrate_vault_dir(vault.path()).is_ok());
    }

    #[test]
    fn migrate_file_name_adopts_the_former_sidecar() {
        let dir = tempdir().unwrap();
        let current = crate::app_file!("-cite.json");
        let former = format!("{FORMER_APP_SLUG}-cite.json");
        fs::write(dir.path().join(&former), b"{}").unwrap();
        let path = migrate_file_name(dir.path(), current);
        assert_eq!(path, dir.path().join(current));
        assert_eq!(path.is_file(), renamed());
        assert_eq!(dir.path().join(&former).is_file(), !renamed());
    }

    #[test]
    fn renamed_build_takes_over_a_former_vault() {
        if !renamed() {
            return;
        }
        let vault = tempdir().unwrap();
        let former = vault.path().join(dot_dir(FORMER_APP_SLUG));
        fs::create_dir(&former).unwrap();
        fs::write(former.join("catalog.sqlite"), b"db").unwrap();
        assert_eq!(
            migrate_vault_dir(vault.path()).unwrap(),
            VaultDirMigration::Renamed
        );
        assert!(paths::vault_private_dir(vault.path())
            .join("catalog.sqlite")
            .is_file());
    }

    #[test]
    fn copy_dir_once_copies_then_marks_and_never_overwrites() {
        let base = tempdir().unwrap();
        let from = base.path().join("old");
        let to = base.path().join("new");
        fs::create_dir_all(from.join("bridge")).unwrap();
        fs::write(from.join("settings.json"), b"{\"theme\":\"dark\"}").unwrap();
        fs::write(from.join("bridge/identity.json"), b"id").unwrap();
        assert!(copy_dir_once(&from, &to).unwrap());
        assert_eq!(
            fs::read(to.join("settings.json")).unwrap(),
            b"{\"theme\":\"dark\"}"
        );
        assert_eq!(fs::read(to.join("bridge/identity.json")).unwrap(), b"id");
        assert!(from.join("settings.json").is_file(), "former dir kept");
        assert!(from.join(MIGRATED_MARKER).is_file());
        assert!(!to.join(MIGRATED_MARKER).exists());
        // Second launch: target exists, nothing happens.
        fs::write(to.join("settings.json"), b"{}").unwrap();
        assert!(!copy_dir_once(&from, &to).unwrap());
        assert_eq!(fs::read(to.join("settings.json")).unwrap(), b"{}");
        // No staging dirs left behind.
        let leftovers: Vec<_> = fs::read_dir(base.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("migrating"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn webstate_round_trips_once() {
        let dir = tempdir().unwrap();
        let entries = vec![WebStateEntry {
            key: "agentero-open-tabs".into(),
            value: "[\"agentero:library\"]".into(),
        }];
        write_webstate(dir.path(), &entries).unwrap();
        assert_eq!(take_webstate(dir.path()).unwrap(), Some(entries));
        assert_eq!(take_webstate(dir.path()).unwrap(), None);
        assert!(dir.path().join(WEBSTATE_IMPORTED_FILE).is_file());
    }
}
