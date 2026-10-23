//! Coordinated Vault rename (folder/heading rename across wiki links).
//!
//! Body in `edda_core::features::vault::rename`; desktop command shell here.

pub use edda_core::features::vault::rename::*;

#[cfg(feature = "desktop")]
pub mod commands;
