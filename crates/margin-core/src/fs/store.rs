//! Atomic local-disk writes: sibling temp file + rename.
//!
//! Before `docs/development/refactor-audit-2026-08.md` P2-17, eight features
//! each open-coded their own "write temp, rename into place" loop (temp
//! naming / Windows rename fallback / 0o600 permissions in every possible
//! combination). They now share this module.
//!
//! Contracts:
//! - temp files end in `.tmp` — `features/sync/snapshot.rs` excludes `*.tmp`
//!   from vault scans, so temps are never synced;
//! - the default temp is unique per write (`.{name}.edda-rename-{pid}-{n}.tmp`):
//!   two writers of one file used to share `{name}.tmp`, and one could rename
//!   the other's half-written temp into place. The `.edda-rename-` marker
//!   makes `features/watcher` report the swap as a content modify of the
//!   target instead of a create / rename of the temp;
//! - the deliberate FSEvents exceptions (doctor alias repair, refs cite
//!   sidecars) stay plain in-place writes and must NOT use this module.
//!
//! By default this does not `fsync`: durability is "atomic replacement", not
//! "crash-proof persistence". [`AtomicOpts::durable`] flushes the temp before
//! the rename, for files that are the only copy of their data.

use crate::error::AppError;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Options for [`atomic_write_with`] / [`json_store_with`].
#[derive(Debug, Clone, Default)]
pub struct AtomicOpts {
    /// Sibling temp file name. Defaults to a unique marked name (see the
    /// module docs) — the `.tmp` suffix is what sync snapshot scans filter out.
    pub temp_name: Option<String>,
    /// Unix permission mode applied to the written file (best-effort), e.g.
    /// `0o600` for files that hold secrets. Ignored on other platforms.
    pub unix_mode: Option<u32>,
    /// Flush the temp to disk before renaming it into place, so a crash or
    /// power loss leaves the old or the new content, never an empty file.
    pub durable: bool,
}

impl AtomicOpts {
    /// Owner-only file on Unix (0o600): settings / sync credentials.
    pub const OWNER_ONLY: Self = Self {
        temp_name: None,
        unix_mode: Some(0o600),
        durable: false,
    };

    /// A file that is the only copy of its data (review state).
    pub const DURABLE: Self = Self {
        temp_name: None,
        unix_mode: None,
        durable: true,
    };
}

/// Run a rename/delete operation, retrying while it fails with an error that
/// only clears once another process lets go of the file.
///
/// Windows refuses to rename or delete a file that another process still holds
/// open — the PDF viewer, an external editor, a second Edda window, or Defender
/// scanning on access. Those handles are released within milliseconds, so the
/// failure is transient even though `fs::rename` reports it as a plain error.
/// Anything else (missing file, access denied, cross-device link) is returned
/// immediately; see [`is_transient_lock`] for exactly what counts as transient.
pub fn retry_while_locked<T, F>(mut op: F) -> io::Result<T>
where
    F: FnMut() -> io::Result<T>,
{
    const ATTEMPTS: u32 = 5;
    const BACKOFF: [std::time::Duration; 4] = [
        std::time::Duration::from_millis(25),
        std::time::Duration::from_millis(75),
        std::time::Duration::from_millis(200),
        std::time::Duration::from_millis(400),
    ];

    let mut attempt = 0;
    loop {
        match op() {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !is_transient_lock(&error) || attempt >= ATTEMPTS - 1 {
                    return Err(error);
                }
                std::thread::sleep(BACKOFF[attempt as usize]);
                attempt += 1;
            }
        }
    }
}

/// Whether an I/O error is the "someone else has this file open" class that
/// clears on its own.
///
/// Only errors that are reliably transient belong here. `PermissionDenied` does
/// **not** qualify: on Windows it is `ERROR_ACCESS_DENIED`, i.e. a real access
/// problem, and retrying it only delays reporting it. The numeric codes are
/// matched per platform because the same values mean different things on
/// Windows and POSIX (32 is `ERROR_SHARING_VIOLATION` on Windows but `EPIPE`
/// on Unix).
///
/// Async callers that must not block the runtime should pair this with their own
/// `tokio::time::sleep` backoff instead of [`retry_while_locked`].
pub fn is_transient_lock(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    match error.raw_os_error() {
        // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION.
        Some(32) | Some(33) if cfg!(windows) => true,
        // ETXTBSY: still open for writing by another process.
        Some(26) if cfg!(unix) => true,
        _ => false,
    }
}

/// Atomic write with default options (unique temp, no flush).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write_with(path, bytes, &AtomicOpts::default())
}

/// Write `bytes` to `path` via a sibling temp file + rename.
///
/// When the rename fails (Windows refuses to rename over an existing file),
/// the temp is removed and the target is written directly instead — same
/// fallback the original implementations used.
pub fn atomic_write_with(path: &Path, bytes: &[u8], opts: &AtomicOpts) -> io::Result<()> {
    let temp = temp_path(path, opts);
    if opts.durable {
        let mut file = fs::File::create(&temp)?;
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
    } else {
        fs::write(&temp, bytes)?;
    }
    apply_mode(&temp, opts);
    if fs::rename(&temp, path).is_err() {
        // Windows may fail rename over an existing file.
        let _ = fs::remove_file(&temp);
        fs::write(path, bytes)?;
        apply_mode(path, opts);
    }
    Ok(())
}

/// Serialize `value` as pretty JSON and write it atomically (see
/// [`atomic_write`]). Field order and formatting come from the `Serialize`
/// impl, exactly as a direct `serde_json::to_vec_pretty` would produce.
pub fn json_store<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    json_store_with(path, value, &AtomicOpts::default())
}

/// [`json_store`] with options (e.g. [`AtomicOpts::OWNER_ONLY`] for secrets).
pub fn json_store_with<T: Serialize>(
    path: &Path,
    value: &T,
    opts: &AtomicOpts,
) -> Result<(), AppError> {
    let raw = serde_json::to_vec_pretty(value)?;
    atomic_write_with(path, &raw, opts)?;
    Ok(())
}

fn temp_path(path: &Path, opts: &AtomicOpts) -> PathBuf {
    match &opts.temp_name {
        Some(name) => path.with_file_name(name),
        None => {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let name = path.file_name().map(|n| n.to_string_lossy());
            path.with_file_name(format!(
                ".{}{}{}-{}.tmp",
                name.unwrap_or_default(),
                crate::paths::RENAME_TEMP_MARKER,
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ))
        }
    }
}

/// Best-effort permission change, mirroring the original `let _ = …` calls.
/// Applied to the temp before rename so the target never exists with looser
/// permissions, and to the target after the Windows fallback write.
#[cfg(unix)]
fn apply_mode(path: &Path, opts: &AtomicOpts) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = opts.unix_mode {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
}

#[cfg(not(unix))]
fn apply_mode(_path: &Path, _opts: &AtomicOpts) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notes.md");
        fs::write(&path, "old").expect("seed");

        atomic_write(&path, b"new").expect("atomic write");

        assert_eq!(fs::read_to_string(&path).expect("read"), "new");
        let names: Vec<String> = fs::read_dir(dir.path())
            .expect("read_dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, vec!["notes.md".to_string()]);
    }

    #[test]
    fn custom_temp_name_is_honored_and_cleaned_up() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("NOTES.md");
        // Watcher contract: wiki temps carry the `.edda-rename-` marker.
        let opts = AtomicOpts {
            temp_name: Some(format!(
                ".NOTES.md{}deadbeef.tmp",
                crate::paths::RENAME_TEMP_MARKER
            )),
            ..Default::default()
        };

        atomic_write_with(&path, b"x", &opts).expect("atomic write");

        assert_eq!(fs::read(&path).expect("read"), b"x");
        assert!(!dir
            .path()
            .join(format!(
                ".NOTES.md{}deadbeef.tmp",
                crate::paths::RENAME_TEMP_MARKER
            ))
            .exists());
    }

    /// Writers of one file each use their own temp: a reader only ever sees
    /// one writer's complete content.
    #[test]
    fn concurrent_writers_never_expose_partial_content() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let bodies: Vec<Vec<u8>> = (0..4u8).map(|i| vec![b'a' + i; 200_000]).collect();
        atomic_write(&path, &bodies[0]).expect("seed");
        std::thread::scope(|scope| {
            for body in &bodies {
                let path = &path;
                scope.spawn(move || {
                    for _ in 0..20 {
                        atomic_write(path, body).expect("write");
                    }
                });
            }
            for _ in 0..200 {
                let read = fs::read(&path).expect("read");
                assert!(
                    bodies.contains(&read),
                    "partial content: {} bytes",
                    read.len()
                );
            }
        });
        assert_eq!(fs::read_dir(dir.path()).expect("read_dir").count(), 1);
    }

    #[test]
    fn json_store_writes_pretty_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let value = json!({"k": "v", "n": 1});

        json_store(&path, &value).expect("json store");

        let expected = serde_json::to_string_pretty(&value).expect("serialize");
        assert_eq!(fs::read_to_string(&path).expect("read"), expected);
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_mode_is_applied() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("secrets.json");

        json_store_with(&path, &json!({"a": 1}), &AtomicOpts::OWNER_ONLY).expect("json store");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
