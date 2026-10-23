//! Zotero integration: local library scan/migration, catalog ↔ bibliography
//! file export/import via the Translator Runtime, and the sync-note codec.
//!
//! Bidirectional sync lives in the [`sync`] submodule (desktop-only), which
//! builds on this feature's [`db`] readers and the codec in `edda_core`.
//!
//! The tauri-free codec/io body lives in
//! `edda_core::features::paper::import::sources::zotero`; the desktop-only
//! local-library reader (`db`) and Tauri commands stay here.

pub use edda_core::features::paper::import::sources::zotero::*;

#[cfg(feature = "desktop")]
pub mod commands;
#[cfg(feature = "desktop")]
pub mod db;
#[cfg(feature = "desktop")]
pub mod sync;

#[cfg(feature = "desktop")]
pub use db::{
    migrate_zotero, scan_zotero, MigrateProgress, ZoteroMigrateArgs, ZoteroMigrateResult,
    ZoteroScan, ZoteroScanArgs,
};
