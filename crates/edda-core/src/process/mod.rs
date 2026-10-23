pub mod discover;

pub use discover::{path_entries, resolve_command, resolve_command_in_paths};

/// Remove the extended-length prefix from local Windows drive paths before
/// handing them to cmd.exe or MSYS2 shells. UNC/device paths retain their own
/// semantics and must not be turned into relative paths by stripping `\\?\`.
pub fn windows_shell_path(path: &std::path::Path) -> std::path::PathBuf {
    let value = path.to_string_lossy();
    match value.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.into(),
        _ => path.to_path_buf(),
    }
}

/// `CreateProcessW` cannot start `.cmd`/`.bat` shims or `.ps1` scripts; it fails
/// with `ERROR_BAD_EXE_FORMAT`. npm, pnpm and Corepack all expose their CLIs as
/// `.cmd` shims, so a command resolved through `PATH` has to be routed through
/// its interpreter before spawning.
///
/// Returns the interpreter plus the arguments that must precede the script's own
/// arguments, or `None` when `path` is directly executable. Always `None` on
/// non-Windows targets.
pub fn windows_shell_invocation(
    path: &std::path::Path,
) -> Option<(&'static str, Vec<std::ffi::OsString>)> {
    #[cfg(windows)]
    {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let flag = |value: &str| std::ffi::OsString::from(value);
        match extension.as_str() {
            "cmd" | "bat" => Some((
                "cmd",
                vec![flag("/D"), flag("/C"), path.as_os_str().to_os_string()],
            )),
            "ps1" => Some((
                "powershell",
                vec![
                    flag("-NoProfile"),
                    flag("-ExecutionPolicy"),
                    flag("Bypass"),
                    flag("-File"),
                    path.as_os_str().to_os_string(),
                ],
            )),
            _ => None,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}
