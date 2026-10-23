//! Domain features (feature-first layout, aligned with frontend `src/lib`).
//!
//! Tauri-free service bodies live in `edda_core::features::*` and are
//! bridged here; callers use the semantic `crate::features::<domain>::<module>`
//! paths. This crate keeps the desktop shells: `#[tauri::command]` surfaces,
//! JobCenter runners, watcher/agent/integration wiring. MCP exposes the shared
//! services while the application runs; BYOA (`agent`) is desktop-only.

#[cfg(feature = "desktop")]
pub mod agent;
#[cfg(feature = "desktop")]
pub mod host_hooks;
#[cfg(feature = "desktop")]
pub mod jobs;

pub mod lifecycle;

#[path = "../app/open_request/mod.rs"]
pub mod open_request;

/// 浏览 (Browse): websites in native child webviews.
#[cfg(feature = "desktop")]
pub mod browse;
pub mod markdown;
pub mod paper;
pub mod pdf;
pub mod review;
pub mod system;
pub mod translate;
pub mod vault;
#[cfg(feature = "desktop")]
pub mod web;
