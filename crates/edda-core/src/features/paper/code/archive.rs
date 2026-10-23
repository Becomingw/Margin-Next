use super::*;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{io::Cursor, time::Duration};

const MAX_DOWNLOAD: usize = 128 * 1024 * 1024;
const MAX_UNPACKED: u64 = 512 * 1024 * 1024;

pub struct DownloadedCode {
    pub(super) repository: Repository,
    pub(super) revision: String,
    pub(super) bytes: Vec<u8>,
}

async fn fetch(url: &str, max: usize) -> Result<Vec<u8>, AppError> {
    let client = crate::http::client(Duration::from_secs(120))?;
    let urls = if url.contains("github.com/") {
        crate::http::github_url_candidates(url)
    } else {
        vec![url.into()]
    };
    let mut last = error("code_download_failed", "Could not download repository");
    for url in urls {
        let result = async {
            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|e| error("code_download_failed", e.to_string()))?;
            if !response.status().is_success() {
                return Err(error(
                    "code_download_failed",
                    format!("Repository request returned {}", response.status()),
                ));
            }
            if response.content_length().is_some_and(|n| n > max as u64) {
                return Err(error("code_too_large", "Repository archive is too large"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| error("code_download_failed", e.to_string()))?
            {
                if bytes.len() + chunk.len() > max {
                    return Err(error("code_too_large", "Repository archive is too large"));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        }
        .await;
        match result {
            Ok(bytes) => return Ok(bytes),
            Err(e) => last = e,
        }
    }
    Err(last)
}

pub async fn download(url: &str) -> Result<DownloadedCode, AppError> {
    let repository = Repository::parse(url)?;
    let metadata_url = if repository.host == "github.com" {
        format!(
            "https://api.github.com/repos/{}/commits/HEAD",
            repository.project
        )
    } else {
        format!(
            "https://gitlab.com/api/v4/projects/{}/repository/commits/HEAD",
            urlencoding::encode(&repository.project)
        )
    };
    let metadata: serde_json::Value =
        serde_json::from_slice(&fetch(&metadata_url, 2 * 1024 * 1024).await?).map_err(|_| {
            error(
                "code_download_failed",
                "Repository metadata is not valid JSON",
            )
        })?;
    let revision = metadata
        .get(if repository.host == "github.com" {
            "sha"
        } else {
            "id"
        })
        .and_then(|v| v.as_str())
        .filter(|v| (40..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| error("code_download_failed", "Repository revision is missing"))?
        .to_string();
    let archive_url = if repository.host == "github.com" {
        format!(
            "https://codeload.github.com/{}/tar.gz/{revision}",
            repository.project
        )
    } else {
        format!(
            "https://gitlab.com/api/v4/projects/{}/repository/archive.tar.gz?sha={revision}",
            urlencoding::encode(&repository.project)
        )
    };
    let bytes = fetch(&archive_url, MAX_DOWNLOAD).await?;
    Ok(DownloadedCode {
        repository,
        revision,
        bytes,
    })
}

/// Caller serializes filesystem mutations. Download happens before taking the
/// Vault mutation lease; revalidate identity before publishing one atomic folder.
pub fn install(
    vault: &Path,
    rel: &str,
    expected_id: &str,
    downloaded: DownloadedCode,
) -> Result<CodeSnapshot, AppError> {
    let (id, paper) = paper_directory(vault, rel)?;
    if id != expected_id {
        return Err(error("paper_not_found", "Paper changed while downloading"));
    }
    let key = downloaded.repository.id();
    let target = snapshot_dir(&paper, &key)?;
    if target.exists() {
        return Err(error(
            "code_exists",
            "This repository already has a snapshot",
        ));
    }
    let private = safe_child(&vault.canonicalize()?, crate::paths::APP_DOT_DIR)?;
    fs::create_dir_all(&private)?;
    let stage = private.join(format!("code-stage-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&stage)?;
    let result = (|| {
        let files = stage.join("files");
        fs::create_dir(&files)?;
        let (file_count, bytes, skipped_entries) = extract(&downloaded.bytes, &files)?;
        let snapshot = CodeSnapshot {
            schema_version: 1,
            id: key,
            url: downloaded.repository.url(),
            revision: downloaded.revision,
            imported_at: crate::time::now_rfc3339_millis(),
            archive_sha256: hex::encode(Sha256::digest(&downloaded.bytes)),
            file_count,
            bytes,
            skipped_entries,
        };
        fs::write(stage.join(MANIFEST), serde_json::to_vec_pretty(&snapshot)?)?;
        // Check again immediately before publication; never replace user content.
        let (current_id, current) = paper_directory(vault, rel)?;
        if current_id != expected_id || current != paper || target.exists() {
            return Err(error("code_exists", "Snapshot destination changed"));
        }
        fs::create_dir_all(safe_child(&paper, "code")?)?;
        fs::rename(&stage, &target)?;
        Ok(snapshot)
    })();
    let _ = fs::remove_dir_all(&stage);
    result
}

pub(super) fn extract(bytes: &[u8], destination: &Path) -> Result<(usize, u64, usize), AppError> {
    // Bound decompression too, including headers/PAX data not counted as files.
    let mut archive =
        tar::Archive::new(GzDecoder::new(Cursor::new(bytes)).take(MAX_UNPACKED + 32 * 1024 * 1024));
    let mut count = 0;
    let mut total = 0u64;
    let mut skipped = 0;
    let mut archive_root: Option<String> = None;
    for (index, entry) in archive.entries()?.enumerate() {
        if index >= MAX_FILES * 2 {
            return Err(error("code_too_large", "Too many archive entries"));
        }
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        // PAX headers (e.g. GitHub's commit comment) describe the archive,
        // not its source tree. Ignore them before validating content roots.
        if matches!(
            kind,
            tar::EntryType::XGlobalHeader | tar::EntryType::XHeader
        ) {
            continue;
        }
        let path = entry.path()?.to_string_lossy().into_owned();
        let parts: Vec<_> = path.trim_end_matches('/').split('/').collect();
        if path.starts_with('/')
            || parts.len() > 32
            || parts.iter().any(|p| {
                p.is_empty()
                    || *p == ".."
                    || *p == "."
                    || p.contains(['\\', ':'])
                    || p.ends_with(['.', ' '])
            })
        {
            return Err(error(
                "code_invalid_archive",
                "Invalid repository archive path",
            ));
        }
        if archive_root.as_deref().is_some_and(|root| root != parts[0]) {
            return Err(error(
                "code_invalid_archive",
                "Repository archive has multiple roots",
            ));
        }
        archive_root.get_or_insert_with(|| parts[0].to_string());
        if parts.iter().any(|p| p.eq_ignore_ascii_case(".git")) {
            skipped += 1;
            continue;
        }
        if !kind.is_file() && !kind.is_dir() {
            skipped += 1;
            continue;
        }
        if parts.len() < 2 || kind.is_dir() {
            continue;
        }
        let size = entry.size();
        total = total
            .checked_add(size)
            .ok_or_else(|| error("code_too_large", "Repository is too large"))?;
        if size > 64 * 1024 * 1024 || total > MAX_UNPACKED || count >= MAX_FILES {
            return Err(error("code_too_large", "Unpacked repository is too large"));
        }
        let target = safe_child(destination, &parts[1..].join("/"))?;
        fs::create_dir_all(target.parent().unwrap())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        std::io::copy(&mut entry, &mut file)?;
        count += 1;
    }
    if count == 0 {
        return Err(error(
            "code_invalid_archive",
            "Repository archive contains no files",
        ));
    }
    Ok((count, total, skipped))
}
