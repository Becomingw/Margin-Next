//! Host handle bridge: re-exports the tauri-free [`AppHandle`] /
//! [`HostHooks`] from `edda-core` so `crate::core::app_handle::X`
//! paths stay stable for the migrated domain services.
//!
//! The desktop implementation of [`HostHooks`] (event emit + JobCenter
//! spawns) lives in `features::host_hooks` — `core/` must not depend on
//! `features/` — and headless (CLI) callers pass `None` /
//! [`AppHandle::headless`], where every hook is a no-op.

pub use edda_core::app_handle::{AppHandle, HostHooks};
