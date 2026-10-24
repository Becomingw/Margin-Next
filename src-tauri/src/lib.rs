//! Margin desktop Host. Default builds assemble only the manuscript workspace
//! and review-only MCP. Retained workbench source is an explicit opt-in, never
//! an additional startup path in release artifacts.

#[cfg(feature = "legacy-workbench")]
extern crate margin_core as edda_core;
#[cfg(feature = "legacy-workbench")]
mod app;
/// Cross-cutting foundations (error, fs, paths, logging helpers).
pub mod core;
/// Retained research-workbench command shells; excluded from normal builds.
#[cfg(feature = "legacy-workbench")]
pub mod features;
#[cfg(all(feature = "desktop", not(feature = "legacy-workbench")))]
#[path = "features/pdf/export/mod.rs"]
pub mod fonts;
/// Retained integrations; not Margin's review-only MCP server.
#[cfg(feature = "legacy-workbench")]
pub mod integration;
#[cfg(all(feature = "desktop", not(feature = "legacy-workbench")))]
mod margin;
#[cfg(feature = "legacy-workbench")]
pub use app::run;
#[cfg(all(feature = "desktop", not(feature = "legacy-workbench")))]
pub use margin::run;
