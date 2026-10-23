//! Vault paper catalog: `.edda/catalog.sqlite`.
//!
//! Authoritative store for paper set + structured metadata; the tauri-free
//! body lives in `edda_core::features::paper::catalog`.
//! See `docs/backend/catalog.md`.

pub use edda_core::features::paper::catalog::*;

#[cfg(feature = "desktop")]
pub mod commands;
#[cfg(feature = "desktop")]
pub mod management;
