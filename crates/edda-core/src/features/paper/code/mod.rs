//! Paper-owned source snapshots. No Git checkout, execution, or automatic update.
mod archive;
mod discovery;
#[cfg(test)]
mod tests;

use crate::{error::AppError, features::catalog::papers};
pub use archive::{download, install, DownloadedCode};
pub use discovery::{discover, Repository};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MANIFEST: &str = "snapshot.json";
pub(super) const MAX_FILES: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeSnapshot {
    pub schema_version: u32,
    pub id: String,
    pub url: String,
    pub revision: String,
    pub imported_at: String,
    pub archive_sha256: String,
    pub file_count: usize,
    pub bytes: u64,
    pub skipped_entries: usize,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeCandidate {
    pub url: String,
    pub source: String,
    pub evidence: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperCode {
    pub candidates: Vec<CodeCandidate>,
    pub snapshots: Vec<CodeSnapshot>,
    pub body_available: bool,
    pub truncated: bool,
}

pub(super) fn error(code: &'static str, message: impl Into<String>) -> AppError {
    AppError::domain(code, message.into())
}

pub fn paper_directory(vault: &Path, rel: &str) -> Result<(String, PathBuf), AppError> {
    let rel = crate::fs::sanitize_vault_rel(rel).map_err(AppError::message)?;
    let record = papers::get_by_path(vault, &rel)?
        .ok_or_else(|| error("paper_not_found", "Paper no longer exists"))?;
    let root = vault.canonicalize()?;
    let dir = safe_child(&root, &rel)?;
    if !dir.is_dir() {
        return Err(error("paper_not_found", "Paper directory is missing"));
    }
    Ok((record.id, dir))
}

/// Existing components must be ordinary files/directories within the owned root.
pub(super) fn safe_child(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let rel = crate::fs::sanitize_vault_rel(rel).map_err(AppError::message)?;
    let mut path = root.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(error(
                    "code_invalid_path",
                    "Linked code paths are not supported",
                ))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(path)
}

pub(super) fn read_limited(path: &Path, max: usize) -> Result<Vec<u8>, AppError> {
    let mut out = Vec::new();
    fs::File::open(path)?
        .take(max as u64 + 1)
        .read_to_end(&mut out)?;
    if out.len() > max {
        return Err(error("code_too_large", "Code asset exceeds the size limit"));
    }
    Ok(out)
}

fn snapshot_dir(paper: &Path, id: &str) -> Result<PathBuf, AppError> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(error("code_invalid_path", "Invalid snapshot id"));
    }
    safe_child(paper, &format!("code/{id}"))
}

pub(super) fn read_snapshot(paper: &Path, id: &str) -> Result<CodeSnapshot, AppError> {
    let dir = snapshot_dir(paper, id)?;
    let snapshot: CodeSnapshot =
        serde_json::from_slice(&read_limited(&safe_child(&dir, MANIFEST)?, 64 * 1024)?)?;
    if snapshot.schema_version != 1
        || snapshot.id != id
        || Repository::parse(&snapshot.url)?.id() != id
    {
        return Err(error("code_invalid_path", "Invalid code snapshot manifest"));
    }
    Ok(snapshot)
}

pub fn inspect(vault: &Path, rel: &str) -> Result<PaperCode, AppError> {
    let (_, paper) = paper_directory(vault, rel)?;
    let mut state = discover(&paper)?;
    let code = safe_child(&paper, "code")?;
    if code.is_dir() {
        for entry in fs::read_dir(code)?.take(128) {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                // Unmanaged folders are left alone; only snapshot manifests are managed.
                if let Ok(snapshot) = read_snapshot(&paper, &entry.file_name().to_string_lossy()) {
                    state.snapshots.push(snapshot);
                }
            }
        }
    }
    state.snapshots.sort_by(|a, b| a.url.cmp(&b.url));
    Ok(state)
}

pub fn files(vault: &Path, rel: &str, id: &str) -> Result<Vec<String>, AppError> {
    let (_, paper) = paper_directory(vault, rel)?;
    read_snapshot(&paper, id)?;
    let root = safe_child(&snapshot_dir(&paper, id)?, "files")?;
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .max_depth(32)
    {
        let entry = entry.map_err(|e| AppError::message(e.to_string()))?;
        if entry.file_type().is_file() {
            files.push(
                entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
            if files.len() > MAX_FILES {
                return Err(error("code_too_large", "Too many code files"));
            }
        }
    }
    files.sort();
    Ok(files)
}

pub fn read_file(vault: &Path, rel: &str, id: &str, file: &str) -> Result<String, AppError> {
    let (_, paper) = paper_directory(vault, rel)?;
    read_snapshot(&paper, id)?;
    let root = safe_child(&snapshot_dir(&paper, id)?, "files")?;
    let bytes = read_limited(&safe_child(&root, file)?, 1024 * 1024)?;
    if bytes.contains(&0) {
        return Err(error("code_not_text", "This file is not UTF-8 text"));
    }
    String::from_utf8(bytes).map_err(|_| error("code_not_text", "This file is not UTF-8 text"))
}

/// Reserved subtree in the flat paper layout; also used to keep repository
/// README/TeX examples out of authored-note indexing and paper capabilities.
pub fn is_code_path(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/");
    let parts: Vec<_> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    parts.len() >= 3 && parts[0] == "papers" && parts[2] == "code"
}
