//! Promote a reviewed cold-pool candidate through the existing paper commit pipeline.
use super::{
    paper_commit, AssetsPolicy, CommitStatus, DedupePolicy, NoteShellMode, PaperCommitOptions,
};
use crate::{
    error::AppError,
    features::{
        catalog::papers::{PaperKind, PaperRecord, PaperTag},
        paper::discovery::pool::PoolPaper,
    },
};
use std::path::Path;

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolPromotion {
    pub path: String,
    pub id: String,
    pub title: String,
    pub created: bool,
}

pub async fn promote(
    vault: &Path,
    paper: &PoolPaper,
    note_mode: NoteShellMode,
) -> Result<PoolPromotion, AppError> {
    let key = paper
        .key
        .get(..24)
        .filter(|key| key.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| AppError::message("invalid paper pool key"))?;
    let mut meta = PaperRecord::local_pdf(format!("pool-{key}"), paper.title.clone());
    meta.paper_type = if paper.arxiv_id.is_some() {
        PaperKind::Arxiv
    } else if paper.doi.is_some() {
        PaperKind::Doi
    } else {
        PaperKind::Other
    };
    meta.authors = paper.authors.iter().map(|a| a.name.clone()).collect();
    meta.year = paper.year;
    meta.doi = paper.doi.clone();
    meta.arxiv_id = paper.arxiv_id.clone();
    meta.abstract_text = (!paper.abstract_text.is_empty()).then(|| paper.abstract_text.clone());
    meta.pdf_url = paper.pdf_url.clone();
    meta.html_url = paper.url.clone();
    meta.source_url = paper
        .url
        .clone()
        .or_else(|| {
            paper
                .doi
                .as_ref()
                .map(|doi| format!("https://doi.org/{doi}"))
        })
        .or_else(|| {
            paper
                .arxiv_id
                .as_ref()
                .map(|id| format!("https://arxiv.org/abs/{id}"))
        });
    meta.tags = paper
        .tags
        .iter()
        .map(|tag| PaperTag::new(tag.clone()))
        .collect();
    meta.meta_source = Some("paper-pool".into());
    // Preserve attribution and affiliations without copying private storage URLs.
    meta.extra = Some(serde_json::to_string(
        &serde_json::json!({"eddaPaperPool":{"key":paper.key,"authors":paper.authors,"recommendations":paper.recommendations}}),
    )?);
    let result = paper_commit(
        meta,
        PaperCommitOptions {
            vault,
            parent_dir: "papers",
            dedupe: DedupePolicy::ByIdentifiers,
            assets: AssetsPolicy::Deferred,
            translate_abstract: false,
            note_mode,
            fresh_timestamps: true,
            cache: None,
            app: None,
            defer_parse_jobs: true,
        },
    )
    .await?;
    Ok(PoolPromotion {
        path: result.path,
        id: result.id,
        title: result.title,
        created: result.status == CommitStatus::Created,
    })
}
