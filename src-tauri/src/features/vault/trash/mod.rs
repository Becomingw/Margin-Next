//! Vault recycle bin (`.edda/trash`).
//!
//! Body in `edda_core::features::vault::trash`; desktop command shell and
//! the remote-vault inversion trait stay here.

pub use edda_core::features::vault::trash::*;

/// Tauri command shells for this feature.
#[cfg(feature = "desktop")]
pub mod commands;

/// Remote-vault inversion trait (implemented by `integration::remote`).
#[cfg(feature = "desktop")]
pub mod remote_ops;
