//! Vault tree, path services, and Vault creation.
//!
//! The tauri-free body lives in `edda_core::features::vault`; this module
//! bridges it and keeps the desktop-only shells (commands, watcher).

pub use edda_core::features::vault::*;

/// Tauri command shells for this feature.
#[cfg(feature = "desktop")]
pub mod commands;
pub mod doctor;
/// `edda-preview://` scheme for the local HTML preview.
#[cfg(feature = "desktop")]
pub mod presets;
pub mod preview;
pub mod rename;
pub mod trash;
#[cfg(feature = "desktop")]
pub mod watcher;
