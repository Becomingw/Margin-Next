//! Application data directories following the [XDG Base Directory
//! Specification](https://specifications.freedesktop.org/basedir-spec/latest/).
//!
//! | Kind | Env | Default (Unix) | Contents |
//! |------|-----|----------------|----------|
//! | config | `$XDG_CONFIG_HOME` | `~/.config` | `edda/settings.json`, `agents.json` |
//! | cache | `$XDG_CACHE_HOME` | `~/.cache` | remote work mirrors, PDF blobs |
//! | data | `$XDG_DATA_HOME` | `~/.local/share` | `usage.sqlite` (device-local activity) |
//! | state | `$XDG_STATE_HOME` | `~/.local/state` | reserved |
//!
//! On Windows and iOS, when XDG env vars are unset, falls back to the platform
//! dirs crate (Windows: `config` → `%APPDATA%`, `cache` → `%LOCALAPPDATA%`;
//! iOS: `Library/Application Support` / `Library/Caches` — the container root
//! itself is not writable, so `~/.config` would fail with EPERM).
//!
//! The product name appears on disk only through [`APP_SLUG`] and
//! [`APP_DOT_DIR`]; derive paths and tags from them instead of spelling it.

use std::path::{Path, PathBuf};

/// Lowercase product slug: directory name under the XDG / platform base
/// dirs and the provenance tag on app-written records.
pub const APP_SLUG: &str = "edda";

/// Hidden product directory: `{vault}/.edda` (vault-private state such as
/// the catalog) and `~/.edda` (home-level installs and staging).
pub const APP_DOT_DIR: &str = ".edda";

/// Vault-relative path under [`APP_DOT_DIR`] as a `&'static str`, for `const`
/// items: `vault_private_rel!("catalog.sqlite")` → `".edda/catalog.sqlite"`.
/// The literal must stay in sync with [`APP_DOT_DIR`] (asserted in tests).
#[macro_export]
macro_rules! vault_private_rel {
    ($rel:literal) => {
        concat!(".edda/", $rel)
    };
}

/// Infix of app-owned atomic-write temps (`.NOTES.md.edda-rename-<id>.tmp`);
/// the vault watcher treats these as content modifies, not user renames.
pub const RENAME_TEMP_MARKER: &str = ".edda-rename-";

/// Slug-prefixed file name as a `&'static str`, for `const` items:
/// `app_file!("-cite.json")` → `"edda-cite.json"`. The literal must stay in
/// sync with [`APP_SLUG`] (asserted in tests).
#[macro_export]
macro_rules! app_file {
    ($suffix:literal) => {
        concat!("edda", $suffix)
    };
}

/// `{vault}/.edda` — vault-private state owned by the app.
pub fn vault_private_dir(vault: &Path) -> PathBuf {
    vault.join(APP_DOT_DIR)
}

/// `~/.edda` — home-level installs and staging outside any vault.
pub fn home_dot_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(APP_DOT_DIR))
}

/// Resolve XDG config home (`$XDG_CONFIG_HOME` or platform default).
pub fn xdg_config_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_CONFIG_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::config_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".config")
    }
}

/// Resolve XDG cache home (`$XDG_CACHE_HOME` or platform default).
pub fn xdg_cache_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_CACHE_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::cache_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".cache")
    }
}

/// `$XDG_CONFIG_HOME/edda` (created on demand by callers).
pub fn app_config_dir() -> PathBuf {
    xdg_config_home().join(APP_SLUG)
}

/// Resolve XDG data home (`$XDG_DATA_HOME` or platform default).
pub fn xdg_data_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_DATA_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".local").join("share")
    }
}

/// `$XDG_CACHE_HOME/edda` (created on demand by callers).
pub fn app_cache_dir() -> PathBuf {
    xdg_cache_home().join(APP_SLUG)
}

/// `$XDG_DATA_HOME/edda` (created on demand by callers).
pub fn app_data_dir() -> PathBuf {
    xdg_data_home().join(APP_SLUG)
}

/// Device-local activity log: `…/edda/usage.sqlite`.
pub fn usage_db_path() -> PathBuf {
    app_data_dir().join("usage.sqlite")
}

/// ONNX / other large assets: `$XDG_CACHE_HOME/edda/models`.
pub fn app_models_dir() -> PathBuf {
    app_cache_dir().join("models")
}

/// Owned by the built-in ChatGPT tunnel supervisor:
/// `$XDG_CACHE_HOME/edda/mcp-tunnel` (private `--profile-dir`, health url, log).
pub fn mcp_tunnel_dir() -> PathBuf {
    app_cache_dir().join("mcp-tunnel")
}

/// App settings file: `…/edda/settings.json`.
pub fn settings_path() -> PathBuf {
    app_config_dir().join("settings.json")
}

/// Agent registry file: `…/edda/agents.json`.
pub fn agents_path() -> PathBuf {
    app_config_dir().join("agents.json")
}

/// Long-lived desktop Bridge identity and paired-device registry.
pub fn bridge_config_dir() -> PathBuf {
    app_config_dir().join("bridge")
}

/// Pre-XDG path used by older builds (`dirs::config_dir()/edda`).
/// On Linux this often equals the XDG path; on macOS it was
/// `~/Library/Application Support/edda`.
pub fn legacy_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join(APP_SLUG))
}

/// If `target` is missing but a legacy file exists, copy it once (best-effort).
pub fn migrate_legacy_file(file_name: &str, target: &std::path::Path) {
    if target.exists() {
        return;
    }
    let Some(legacy_dir) = legacy_config_dir() else {
        return;
    };
    // Same directory as the new path — nothing to migrate.
    if legacy_dir == app_config_dir() {
        return;
    }
    let src = legacy_dir.join(file_name);
    if !src.is_file() {
        return;
    }
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::copy(&src, target) {
        Ok(_) => {
            log::info!(
                target: "edda::paths",
                "migrated {file_name} from {} → {}",
                src.display(),
                target.display()
            );
        }
        Err(e) => {
            log::warn!(
                target: "edda::paths",
                "failed to migrate {file_name} from {}: {e}",
                src.display()
            );
        }
    }
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Fallback home directory for XDG defaults. Only used where the `~/.config`
/// convention applies (not Windows/iOS), hence the cfg gate to avoid a
/// dead-code warning on those builds.
#[cfg(not(any(windows, target_os = "ios")))]
fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_ends_with_app_dir_name() {
        let p = app_config_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(APP_SLUG));
    }

    #[test]
    fn vault_private_rel_matches_dot_dir() {
        assert_eq!(
            vault_private_rel!("catalog.sqlite"),
            format!("{APP_DOT_DIR}/catalog.sqlite")
        );
        assert_eq!(APP_DOT_DIR, format!(".{APP_SLUG}"));
        assert_eq!(app_file!("-cite.json"), format!("{APP_SLUG}-cite.json"));
    }

    #[test]
    fn settings_and_agents_share_config_dir() {
        assert_eq!(settings_path().parent(), agents_path().parent());
    }

    #[test]
    fn cache_dir_ends_with_app_dir_name() {
        let p = app_cache_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(APP_SLUG));
    }

    #[test]
    fn models_dir_under_cache() {
        let p = app_models_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("models"));
        assert_eq!(p.parent(), Some(app_cache_dir().as_path()));
    }

    #[test]
    fn mcp_tunnel_dir_under_cache() {
        let p = mcp_tunnel_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("mcp-tunnel"));
        assert_eq!(p.parent(), Some(app_cache_dir().as_path()));
    }

    #[test]
    fn data_dir_ends_with_app_dir_name() {
        let p = app_data_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(APP_SLUG));
    }

    #[test]
    fn usage_db_under_data_dir() {
        let p = usage_db_path();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("usage.sqlite"));
        assert_eq!(p.parent(), Some(app_data_dir().as_path()));
    }
}
