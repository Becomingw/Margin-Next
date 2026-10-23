//! Translation providers (free MT + LLM) shared by the Host and the CLI.
//!
//! Body in `edda_core::features::translate`; desktop command shell here.

pub use edda_core::features::translate::*;

#[cfg(feature = "desktop")]
pub mod commands;
