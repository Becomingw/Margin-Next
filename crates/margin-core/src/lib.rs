//! Tauri-independent services for Margin's document store and MCP adapters.
//! Nothing here may depend on `tauri` / `wry` / `tao`. The default Host exposes
//! only the review workspace; inherited research services remain for gradual
//! source extraction and read-only compatibility, not as a second app startup.

pub mod app_handle;
pub mod app_rename;
pub mod blocking;
pub mod cancel;
pub mod error;
pub mod features;
pub mod frontmatter;
pub mod fs;
pub mod http;
pub mod install_dirs;
pub mod json;
pub mod log_util;
pub mod ops;
pub mod paths;
pub mod process;
pub mod remote;
pub mod sqlite;
pub mod time;
pub mod usage;
