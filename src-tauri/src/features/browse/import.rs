//! Add the paper a Browse page shows to the library.
//!
//! Metadata goes through the ordinary identifier import (DOI, then arXiv id,
//! then the page URL). When that finds no open PDF, the view downloads the
//! publisher PDF with its signed-in session ([`super::fetch`]) and it is
//! attached like a user-chosen file.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::page::{pick_identifier, read_page, PagePaper, PageQuery};
use crate::core::error::{ApiResult, AppError};
use crate::features::paper::catalog::CapsCache;
use crate::features::paper::import::{self, LookupImportArgs};

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseImportArgs {
    /// Browse view label; the active view when omitted.
    #[serde(default)]
    pub label: Option<String>,
    pub vault_path: String,
    /// Vault-relative folder under `papers`.
    pub parent_dir: String,
    /// DOI, arXiv id or URL; read from the page when omitted.
    #[serde(default)]
    pub identifier: Option<String>,
    /// PDF to download with the page's session; read from the page when omitted.
    #[serde(default)]
    pub pdf_url: Option<String>,
    /// Report what would be imported without importing.
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseImportResult {
    pub identifier: String,
    pub title: Option<String>,
    pub pdf_url: Option<String>,
    /// Vault-relative paper folder (absent for a dry run).
    pub path: Option<String>,
    pub id: Option<String>,
    pub deduped: bool,
    /// The paper has a local PDF now.
    pub pdf: bool,
    /// That PDF was downloaded through the page's session.
    pub pdf_from_page: bool,
    pub messages: Vec<String>,
}

fn settings(app: &AppHandle) -> Option<crate::features::system::settings::AppSettings> {
    app.try_state::<crate::features::system::settings::AppSettingsStore>()
        .and_then(|store| store.get().ok())
        .map(|state| state.settings)
}

/// Shared by the toolbar command and the `browse_import` MCP tool.
pub async fn import_page(
    app: &AppHandle,
    args: BrowseImportArgs,
) -> Result<BrowseImportResult, AppError> {
    let op = crate::core::log_util::OpTimer::start_with(
        "browse_import",
        format!("dry_run={}", args.dry_run),
    );
    let result = import_page_inner(app, args).await;
    match &result {
        Ok(r) => op.finish_ok_extra(format!(
            "id={} deduped={} pdf={} pdf_from_page={} messages={}",
            r.id.as_deref().unwrap_or("-"),
            r.deduped,
            r.pdf,
            r.pdf_from_page,
            crate::core::log_util::trunc(&r.messages.join(" | "), 300),
        )),
        Err(e) => op.finish_err(e),
    }
    result
}

async fn import_page_inner(
    app: &AppHandle,
    args: BrowseImportArgs,
) -> Result<BrowseImportResult, AppError> {
    if crate::integration::remote::parse_remote_handle(&args.vault_path).is_some() {
        return Err(AppError::message(
            "Adding papers from Browse needs a local library",
        ));
    }
    let view = super::resolve_view(app, args.label.as_deref()).map_err(AppError::message)?;
    let summary = read_page(&view, &PageQuery::default())
        .await
        .map_err(AppError::message)?;
    let page_url = summary["url"].as_str().unwrap_or_default().to_string();
    let paper = PagePaper::from_summary(&summary);
    let identifier = args
        .identifier
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| pick_identifier(&paper, &page_url));
    let pdf_url = args
        .pdf_url
        .clone()
        .or(paper.pdf.clone())
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"));
    let mut result = BrowseImportResult {
        identifier: identifier.clone(),
        title: paper.title.clone(),
        pdf_url: pdf_url.clone(),
        path: None,
        id: None,
        deduped: false,
        pdf: false,
        pdf_from_page: false,
        messages: Vec::new(),
    };
    if args.dry_run {
        return Ok(result);
    }

    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;
    let host_app = crate::features::host_hooks::wrap(app);
    let cache = app.try_state::<CapsCache>();
    let imported = import::import_by_identifier_with_progress(
        LookupImportArgs {
            vault_path: vault.to_string_lossy().to_string(),
            parent_dir: import::normalize_parent_dir(&args.parent_dir)?,
            text: identifier,
            translator_base_url: settings(app).map(|s| s.translator_base_url),
            task_id: None,
        },
        Some(&host_app),
        cache.as_ref().map(|state| state.inner()),
        import::note_mode_from_app(app),
    )
    .await?;
    result.title = Some(imported.title.clone());
    result.path = Some(imported.path.clone());
    result.id = Some(imported.id.clone());
    result.deduped = matches!(imported.status, Some(import::CommitStatus::Deduped));
    result.messages = imported.asset_messages.clone();
    result.pdf = imported.pdf || import::has_local_pdf(std::path::Path::new(&imported.paper_dir));
    if result.pdf {
        return Ok(result);
    }
    let Some(pdf_url) = pdf_url else {
        result.messages.push("pdf: the page links no PDF".into());
        return Ok(result);
    };
    match super::fetch::download_pdf(&view, &pdf_url).await {
        Ok(bytes) => {
            let staged = std::env::temp_dir()
                .join(format!("edda-browse-{}.pdf", uuid::Uuid::new_v4().simple()));
            std::fs::write(&staged, &bytes)?;
            let attached = crate::features::paper::catalog::management::paper_attach_pdf(
                app.clone(),
                args.vault_path.clone(),
                imported.path.clone(),
                staged.to_string_lossy().to_string(),
                false,
            )
            .await;
            let _ = std::fs::remove_file(&staged);
            if attached.ok {
                result.pdf = true;
                result.pdf_from_page = true;
            } else {
                let reason = attached.error.map(|e| e.message).unwrap_or_default();
                result.messages.push(format!("pdf: {reason}"));
            }
        }
        Err(reason) => result.messages.push(format!("pdf: {reason}")),
    }
    Ok(result)
}

/// Add the paper the page shows (toolbar button).
#[tauri::command]
#[specta::specta]
pub async fn browse_import(
    app: AppHandle,
    args: BrowseImportArgs,
) -> Result<ApiResult<BrowseImportResult>, String> {
    Ok(match import_page(&app, args).await {
        Ok(result) => ApiResult::ok(result),
        Err(e) => ApiResult::err(e),
    })
}
