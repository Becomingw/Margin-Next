//! Shared foundations from margin-core. Workbench-only hooks and command
//! surfaces are available solely behind the explicit legacy feature.

#[cfg(feature = "legacy-workbench")]
pub mod app_handle;
#[cfg(feature = "legacy-workbench")]
pub mod usage;

pub use margin_core::blocking;
pub use margin_core::cancel;
pub use margin_core::error;
pub use margin_core::frontmatter;
pub use margin_core::fs;
pub use margin_core::http;
pub use margin_core::install_dirs;
pub use margin_core::json;
pub use margin_core::log_util;
pub use margin_core::paths;
pub use margin_core::process;
pub use margin_core::remote;
pub use margin_core::sqlite;
pub use margin_core::time;
