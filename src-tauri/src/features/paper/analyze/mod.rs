//! Paper analysis: citation refs, PDF layout, and PAPER.md body parse.
//!
//! `refs` keeps its desktop command/job shell here; the tauri-free body lives
//! in `edda_core`. `parse` (liteparse worker + engine framework) is fully
//! migrated; the desktop cloud engines register into the core engine registry
//! from [`body_engines`].

pub mod refs;

#[cfg(feature = "desktop")]
pub mod layout;

// `body_engines` dispatches through the target-gated `parse` re-export
// below, so the desktop GUI gate alone is not enough on mobile targets.
#[cfg(all(
    feature = "desktop",
    not(any(target_os = "ios", target_os = "android"))
))]
pub mod body_engines;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use edda_core::features::paper::analyze::parse;
