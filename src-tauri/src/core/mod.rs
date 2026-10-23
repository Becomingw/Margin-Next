//! Cross-cutting foundations shared by Host features and the headless CLI.
//!
//! Tauri-independent foundations live in the `edda-core` crate and are
//! re-exported here so `crate::core::X` paths stay stable (the CLI depends on
//! `edda-core` directly). Modules kept in this crate:
//!
//! - [`app_handle`]: re-export bridge around `edda_core::app_handle`
//!   (tauri-free [`AppHandle`](app_handle::AppHandle) / `HostHooks`); the
//!   desktop `TauriHostHooks` implementation lives in `features::host_hooks`
//!   to keep `core/` free of `features/` deps.
//! - [`usage::commands`]: `#[tauri::command]` surface over the tauri-free
//!   storage layer in `edda_core::usage`.

pub mod app_handle;
pub mod usage;

pub use edda_core::blocking;
pub use edda_core::cancel;
pub use edda_core::error;
pub use edda_core::frontmatter;
pub use edda_core::fs;
pub use edda_core::http;
pub use edda_core::install_dirs;
pub use edda_core::json;
pub use edda_core::log_util;
pub use edda_core::paths;
pub use edda_core::process;
pub use edda_core::remote;
pub use edda_core::sqlite;
pub use edda_core::time;
