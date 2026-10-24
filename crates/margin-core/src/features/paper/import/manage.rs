//! Explicit metadata-only creation and PDF attachment to a known catalog row.
use super::{
    paper_import::{paper_commit, AssetsPolicy, CommitStatus, DedupePolicy, PaperCommitOptions},
    NoteShellMode,
};
use crate::error::AppError;
use crate::features::catalog::{
    self,
    papers::{self, PaperMetaPatch, PaperRecord},
};
use std::{fs, io::Read, path::Path};

pub async fn create_manual(
    vault: &Path,
    patch: &PaperMetaPatch,
    mode: NoteShellMode,
) -> Result<PaperRecord, AppError> {
    let title = patch.title.as_deref().unwrap_or("").trim();
    if title.is_empty() {
        return Err(AppError::message("title cannot be empty"));
    }
    let mut record = PaperRecord::local_pdf(
        format!("manual-{}", uuid::Uuid::new_v4().simple()),
        title.to_string(),
    );
    papers::apply_metadata_patch(&mut record, patch)?;
    record.paper_type = if record.arxiv_id.is_some() {
        papers::PaperKind::Arxiv
    } else if record.doi.is_some() {
        papers::PaperKind::Doi
    } else {
        papers::PaperKind::Other
    };
    let result = paper_commit(
        record,
        PaperCommitOptions {
            vault,
            parent_dir: "papers",
            dedupe: DedupePolicy::ByIdentifiers,
            assets: AssetsPolicy::Deferred,
            translate_abstract: false,
            note_mode: mode,
            fresh_timestamps: true,
            cache: None,
            app: None,
            defer_parse_jobs: true,
        },
    )
    .await?;
    if result.status != CommitStatus::Created {
        return Err(AppError::domain(
            "paper_exists",
            "This paper is already in the library",
        ));
    }
    papers::get_by_path(vault, &result.path)?
        .ok_or_else(|| AppError::message("created paper not found"))
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachPdfResult {
    pub path: String,
    pub backup_path: Option<String>,
}

/// Validate and stage before touching the original. On replace, retain the old
/// PDF and page-dependent artifacts together outside the live paper directory.
pub fn attach_pdf(
    vault: &Path,
    rel: &str,
    source: &Path,
    replace: bool,
) -> Result<AttachPdfResult, AppError> {
    let rel = crate::fs::sanitize_vault_rel(rel).map_err(AppError::message)?;
    let mut record =
        papers::get_by_path(vault, &rel)?.ok_or_else(|| AppError::message("paper not found"))?;
    let dir = vault.join(&rel);
    if !dir.is_dir() || !dir.canonicalize()?.starts_with(vault.canonicalize()?) {
        return Err(AppError::message(
            "paper directory is outside the vault or missing",
        ));
    }
    let mut input = fs::File::open(source)?;
    let mut header = [0; 1024];
    let n = input.read(&mut header)?;
    if !header[..n].windows(5).any(|value| value == b"%PDF-") {
        return Err(AppError::domain("invalid_pdf", "Select a valid PDF file"));
    }
    let old = catalog::find_local_pdf(&dir);
    if old.is_some() != replace {
        return Err(AppError::domain(
            "pdf_changed",
            "PDF availability changed; refresh the library",
        ));
    }
    let token = uuid::Uuid::new_v4();
    let private = vault.join(crate::paths::APP_DOT_DIR);
    fs::create_dir_all(&private)?;
    let stage = private.join(format!("pdf-stage-{token}.pdf"));
    if let Err(error) = fs::copy(source, &stage) {
        let _ = fs::remove_file(&stage);
        return Err(error.into());
    }
    let destination = old.clone().unwrap_or_else(|| {
        dir.join(format!(
            "{}.pdf",
            dir.file_name().unwrap().to_string_lossy()
        ))
    });
    let backup_rel = format!("{}/pdf-backups/{token}", crate::paths::APP_DOT_DIR);
    let backup = vault.join(&backup_rel);
    let mut moved = Vec::new();
    let result = (|| -> Result<(), AppError> {
        if let Some(old) = &old {
            fs::create_dir_all(&backup)?;
            crate::fs::json_store(
                &backup.join("manifest.json"),
                &serde_json::json!({"paperPath": rel, "createdAt": crate::time::now_rfc3339_millis()}),
            )?;
            let mut paths = vec![old.clone()];
            paths.extend(
                ["PAPER.md", "source", "marks", "images", "annotations.json"]
                    .map(|name| dir.join(name)),
            );
            for path in paths {
                if !path.exists() {
                    continue;
                }
                let target = backup.join(
                    path.strip_prefix(&dir)
                        .map_err(|_| AppError::message("invalid PDF location"))?,
                );
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                if &path == old && fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    // The archived PDF must stay readable even for a relative
                    // link to a PDF outside the Vault. Never modify its target.
                    fs::copy(&path, &target)?;
                    fs::remove_file(&path)?;
                } else {
                    fs::rename(&path, &target)?;
                }
                moved.push((path, target));
            }
        }
        fs::rename(&stage, &destination)?;
        record.body_source = None;
        record.body_quality = None;
        record.updated_at = crate::time::now_rfc3339_millis();
        papers::reset_pdf_metadata(vault, &record)?;
        Ok(())
    })();
    if result.is_err() {
        // Only delete the newly published PDF, never a source that failed to move.
        if !stage.exists() {
            let _ = fs::remove_file(&destination);
        }
        for (path, saved) in moved.iter().rev() {
            let _ = fs::rename(saved, path);
        }
    }
    let _ = fs::remove_file(stage);
    result?;
    Ok(AttachPdfResult {
        path: rel,
        backup_path: replace.then_some(backup_rel),
    })
}
