//! Cold-storage paper recommendations: JSON documents, no listener or daemon.
mod model;
use crate::error::AppError;
pub use model::{PoolAuthor, PoolPaper, PoolRecommendation, PoolSubmission};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

pub const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolDocument {
    pub schema_version: u32,
    pub papers: Vec<PoolSubmission>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolSnapshot {
    pub location: String,
    pub papers: Vec<PoolPaper>,
    pub warnings: Vec<String>,
}

pub fn default_directory() -> PathBuf {
    crate::paths::app_data_dir().join("paper-pool")
}
pub fn location(raw: &str) -> Result<String, AppError> {
    let raw = raw.trim();
    if raw.contains("://") {
        let url =
            reqwest::Url::parse(raw).map_err(|_| AppError::message("invalid paper pool URL"))?;
        return if matches!(url.scheme(), "http" | "https") {
            Ok(url.to_string())
        } else {
            Err(AppError::message(
                "use a directory path or HTTP(S) JSON URL",
            ))
        };
    }
    let path = if raw.is_empty() {
        default_directory()
    } else if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        dirs::home_dir()
            .ok_or_else(|| AppError::message("home directory is unavailable"))?
            .join(raw.get(2..).unwrap_or(""))
    } else {
        PathBuf::from(raw)
    };
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(path.to_string_lossy().into_owned())
}

/// Parse an envelope, a single submission, an array, or newline-delimited submissions.
pub fn parse_document(bytes: &[u8]) -> Result<(Vec<PoolSubmission>, Vec<String>), AppError> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::message("paper pool document exceeds 2 MiB"));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::message("paper pool documents must be UTF-8"))?
        .trim_start_matches('\u{feff}');
    let mut warnings = Vec::new();
    let values = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Array(values)) => values,
        Ok(mut object) if object.get("papers").is_some() => {
            if object.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1) {
                return Err(AppError::message("unsupported paper pool schemaVersion"));
            }
            object
                .get_mut("papers")
                .and_then(|v| v.as_array_mut())
                .map(std::mem::take)
                .ok_or_else(|| AppError::message("papers must be an array"))?
        }
        Ok(value) => vec![value],
        Err(_) => text
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .filter_map(|(i, line)| match serde_json::from_str(line) {
                Ok(value) => Some(value),
                Err(error) => {
                    if warnings.len() < 20 {
                        warnings.push(format!("line {}: {error}", i + 1));
                    }
                    None
                }
            })
            .collect(),
    };
    if values.len() > MAX_RECORDS {
        return Err(AppError::message("too many paper pool records"));
    }
    let mut papers = Vec::new();
    for (index, value) in values.into_iter().enumerate() {
        let row = serde_json::from_value::<PoolSubmission>(value)
            .map_err(AppError::from)
            .and_then(PoolSubmission::normalize);
        match row {
            Ok(row) => papers.push(row),
            Err(error) => {
                if warnings.len() < 20 {
                    warnings.push(format!("record {}: {error}", index + 1));
                }
            }
        }
    }
    Ok((papers, warnings))
}

fn read_limited(path: &Path) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take((MAX_DOCUMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn read_directory(raw: &str) -> Result<PoolSnapshot, AppError> {
    let location = location(raw)?;
    let root = Path::new(&location);
    let exists = root.try_exists()?;
    if exists && !root.is_dir() {
        return Err(AppError::message(
            "paper pool location must be a directory or HTTP(S) JSON URL",
        ));
    }
    let mut submissions = Vec::new();
    let mut warnings = Vec::new();
    let mut total = 0;
    if exists {
        let mut files: Vec<_> = walkdir::WalkDir::new(root)
            .sort_by_file_name()
            .max_depth(8)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|entry| match entry {
                Ok(entry) => Some(entry),
                Err(error) => {
                    if warnings.len() < 20 {
                        warnings.push(error.to_string());
                    }
                    None
                }
            })
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .is_some_and(|e| e == "json" || e == "jsonl")
            })
            .map(|entry| entry.into_path())
            .take(5001)
            .collect();
        files.sort();
        for (i, path) in files.iter().enumerate() {
            if i == 5000 || total > MAX_TOTAL_BYTES || submissions.len() >= MAX_RECORDS {
                warnings.push("Paper pool scan limit reached".into());
                break;
            }
            let result = read_limited(path).and_then(|bytes| {
                total += bytes.len();
                parse_document(&bytes)
            });
            let label = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
            match result {
                Ok((mut rows, issues)) => {
                    if rows.len() > MAX_RECORDS - submissions.len() {
                        warnings.push("Paper pool record limit reached".into());
                    }
                    rows.truncate(MAX_RECORDS - submissions.len());
                    submissions.extend(rows);
                    for issue in issues {
                        if warnings.len() < 20 {
                            warnings.push(format!("{label}: {issue}"));
                        }
                    }
                }
                Err(error) => {
                    if warnings.len() < 20 {
                        warnings.push(format!("{label}: {error}"));
                    }
                }
            }
        }
    }
    Ok(PoolSnapshot {
        location,
        papers: model::merge_submissions(submissions),
        warnings,
    })
}

pub async fn read(raw: &str) -> Result<PoolSnapshot, AppError> {
    let location = location(raw)?;
    if !location.starts_with("http://") && !location.starts_with("https://") {
        return tokio::task::spawn_blocking(move || read_directory(&location))
            .await
            .map_err(|e| AppError::message(e.to_string()))?;
    }
    let client = crate::http::client_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::message(e.to_string()))?;
    let mut response = client
        .get(&location)
        .send()
        .await
        .map_err(|e| AppError::message(e.without_url().to_string()))?
        .error_for_status()
        .map_err(|e| AppError::message(e.without_url().to_string()))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::message(e.without_url().to_string()))?
    {
        if bytes.len() + chunk.len() > MAX_DOCUMENT_BYTES {
            return Err(AppError::message("paper pool document exceeds 2 MiB"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let (submissions, warnings) = parse_document(&bytes)?;
    Ok(PoolSnapshot {
        location,
        papers: model::merge_submissions(submissions),
        warnings,
    })
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolWriteResult {
    pub path: String,
    pub accepted: usize,
}

/// One immutable, content-addressed batch per delivery: concurrent producers never
/// rewrite a shared index. Repeating the same delivery is idempotent.
pub fn add(raw: &str, bytes: &[u8], source: Option<&str>) -> Result<PoolWriteResult, AppError> {
    let location = location(raw)?;
    if location.starts_with("http://") || location.starts_with("https://") {
        return Err(AppError::message(
            "pool add requires a directory; publish remote JSON with your storage provider",
        ));
    }
    let (mut papers, issues) = parse_document(bytes)?;
    if !issues.is_empty() {
        return Err(AppError::message(issues.join("; ")));
    }
    if papers.is_empty() {
        return Err(AppError::message("no paper recommendations supplied"));
    }
    if let Some(source) = source {
        if source.len() > 512 {
            return Err(AppError::message("source exceeds 512 bytes"));
        }
        for paper in &mut papers {
            if paper.source.is_empty() {
                paper.source = source.trim().into();
            }
        }
    }
    let accepted = papers.len();
    let document = serde_json::to_string_pretty(&PoolDocument {
        schema_version: 1,
        papers,
    })?;
    if document.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::message("paper pool delivery exceeds 2 MiB"));
    }
    let directory = PathBuf::from(location);
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{}.json", model::digest(&document)));
    if path.exists() {
        if fs::symlink_metadata(&path)?.file_type().is_symlink()
            || read_limited(&path)? != document.as_bytes()
        {
            return Err(AppError::message(
                "paper pool delivery filename conflicts with existing content",
            ));
        }
    } else {
        // The generic atomic writer falls back to an in-place write on Windows.
        // Cold-store producers must never publish a partial JSON document.
        let temp = directory.join(format!(".delivery-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temp, document.as_bytes())?;
        if let Err(error) = fs::rename(&temp, &path) {
            let _ = fs::remove_file(&temp);
            // Another producer may have published the identical delivery first.
            if read_limited(&path).ok().as_deref() != Some(document.as_bytes()) {
                return Err(error.into());
            }
        }
    }
    Ok(PoolWriteResult {
        path: path.to_string_lossy().into_owned(),
        accepted,
    })
}

pub fn example() -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"papers":[{"title":"Paper title","authors":[{"name":"Author name","affiliations":["University / institute"]}],"year":2026,"abstract":"Paper abstract","doi":null,"arxivId":null,"url":"https://example.org/paper","pdfUrl":null,"recommendation":"Why this paper is relevant to the user's research","source":"Codex / Claude Code / Hermes","recommendedAt":"2026-09-18","tags":["topic"]}]})
}

#[cfg(test)]
mod tests;
