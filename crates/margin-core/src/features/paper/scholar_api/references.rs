//! Consolidated online reference lookup via the `scholar_api` abstraction.
//!
//! Semantic Scholar is tried first; Crossref is the fallback for DOI.
//! Free endpoints only; failures degrade silently to local parsing.

use crate::features::scholar_api::sources::{
    crossref::CrossrefApi, semantic_scholar::SemanticScholarApi,
};
use crate::features::scholar_api::traits::AcademicApi;
use crate::features::scholar_api::ApiPaper;

pub struct ReferencesOutcome {
    pub refs: Vec<ApiPaper>,
    /// `"s2"` or `"crossref"` when any provider returned entries.
    pub provider: Option<&'static str>,
    pub messages: Vec<String>,
}

/// Fetch outgoing references for a paper identified by DOI or arXiv id.
pub async fn fetch_references(doi: Option<&str>, arxiv_id: Option<&str>) -> ReferencesOutcome {
    let mut messages = Vec::new();

    let s2 = SemanticScholarApi;
    match s2.fetch_references(doi, arxiv_id).await {
        Ok(refs) if !refs.is_empty() => {
            messages.push(format!("semantic scholar: {} references", refs.len()));
            return ReferencesOutcome {
                refs,
                provider: Some("s2"),
                messages,
            };
        }
        Ok(_) => messages.push("semantic scholar: no references".to_string()),
        Err(e) => messages.push(format!("semantic scholar failed: {e}")),
    }

    if let Some(doi) = doi.filter(|d| !d.trim().is_empty()) {
        let crossref = CrossrefApi;
        match crossref.fetch_references(Some(doi), None).await {
            Ok(refs) if !refs.is_empty() => {
                messages.push(format!("crossref: {} references", refs.len()));
                return ReferencesOutcome {
                    refs,
                    provider: Some("crossref"),
                    messages,
                };
            }
            Ok(_) => messages.push("crossref: no references".to_string()),
            Err(e) => messages.push(format!("crossref failed: {e}")),
        }
    }

    ReferencesOutcome {
        refs: Vec::new(),
        provider: None,
        messages,
    }
}
