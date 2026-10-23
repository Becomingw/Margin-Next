//! Read-only Vault diagnostics and conservative paper-alias / wikilink repair.
//!
//! Body in `edda_core::features::vault::doctor`; desktop command shell here.

pub use edda_core::features::vault::doctor::*;

#[cfg(feature = "desktop")]
pub mod commands;
