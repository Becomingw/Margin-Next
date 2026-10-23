//! Edda Host library (`edda_lib`).
//!
//! - [`run`] — Tauri app entry (desktop / mobile).
//! - [`core`] / [`features`] — bridge the tauri-free `edda-core` crate
//!   (which the headless CLI consumes directly) and keep the desktop shells
//!   (`#[tauri::command]` surfaces, JobCenter, watcher, integrations).
//!
//! Assembly lives in [`app`]; domain logic in [`features`].

#[cfg(feature = "desktop")]
mod app;
/// Cross-cutting foundations (error, fs, paths, logging helpers).
pub mod core;
/// Domain features (Vault / Catalog / Import / Wiki / …).
/// Service bodies live in `edda_core::features::*`; this crate keeps the
/// desktop-only shells. `features::agent` (BYOA) is desktop-only.
pub mod features;
/// External integrations (bridge, MCP, remote vault, cloud sync).
/// Desktop-only; CLI must not depend on these.
pub mod integration;
#[cfg(feature = "desktop")]
mod margin;
#[cfg(feature = "desktop")]
pub use margin::run;
// Retain the upstream assembly as an explicit library compatibility entry
// while shared features are extracted. The Margin binary never calls it.
#[cfg(feature = "desktop")]
#[doc(hidden)]
pub use app::run as run_edda_workbench;
