//! Network connectivity diagnostics for the Doctor settings page.
//!
//! Probes a fixed list of common hosts and academic-paper endpoints through
//! the same proxy configuration used by the rest of the app, so the result
//! reflects real import behavior.

pub mod commands;

use crate::core::error::AppError;
use crate::core::http::{self, BROWSER_USER_AGENT, DEFAULT_REDIRECT_LIMIT};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use std::time::{Duration, Instant};

const NETWORK_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const NETWORK_PROBE_CONCURRENCY: usize = 6;
const DETAIL_MAX_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, Hash, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointId {
    Baidu,
    Google,
    GoogleScholar,
    Github,
    Arxiv,
    SemanticScholar,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkStatus {
    Reachable,
    Timeout,
    Unreachable,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEndpointDiagnostic {
    pub id: EndpointId,
    pub url: String,
    pub status: NetworkStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDoctorReport {
    pub endpoints: Vec<NetworkEndpointDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct EndpointDef {
    id: EndpointId,
    url: &'static str,
}

const ENDPOINTS: &[EndpointDef] = &[
    EndpointDef {
        id: EndpointId::Baidu,
        url: "https://www.baidu.com/",
    },
    EndpointDef {
        id: EndpointId::Google,
        url: "https://www.google.com/generate_204",
    },
    EndpointDef {
        id: EndpointId::GoogleScholar,
        url: "https://scholar.google.com/",
    },
    EndpointDef {
        id: EndpointId::Github,
        url: "https://api.github.com/",
    },
    EndpointDef {
        id: EndpointId::Arxiv,
        url: "https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1",
    },
    EndpointDef {
        id: EndpointId::SemanticScholar,
        url: "https://api.semanticscholar.org/graph/v1/paper/ARXIV:1706.03762?fields=title",
    },
];

fn truncate_detail(text: &str) -> String {
    let mut chars = text.chars();
    let mut out = String::with_capacity(DETAIL_MAX_CHARS.min(text.len()));
    for _ in 0..DETAIL_MAX_CHARS {
        match chars.next() {
            Some(c) => out.push(c),
            None => break,
        }
    }
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

fn classify_error(timed_out: bool) -> NetworkStatus {
    if timed_out {
        NetworkStatus::Timeout
    } else {
        NetworkStatus::Unreachable
    }
}

async fn probe_endpoint(
    client: &reqwest::Client,
    endpoint: &EndpointDef,
) -> NetworkEndpointDiagnostic {
    let start = Instant::now();
    match client.get(endpoint.url).send().await {
        Ok(response) => NetworkEndpointDiagnostic {
            id: endpoint.id,
            url: endpoint.url.to_string(),
            status: NetworkStatus::Reachable,
            status_code: Some(response.status().as_u16()),
            latency_ms: Some(start.elapsed().as_millis() as u64),
            detail: None,
        },
        Err(error) => {
            let timed_out = error.is_timeout();
            NetworkEndpointDiagnostic {
                id: endpoint.id,
                url: endpoint.url.to_string(),
                status: classify_error(timed_out),
                status_code: error.status().map(|s| s.as_u16()),
                latency_ms: Some(start.elapsed().as_millis() as u64),
                detail: Some(truncate_detail(&error.to_string())),
            }
        }
    }
}

pub async fn diagnose_network() -> Result<NetworkDoctorReport, AppError> {
    let client = http::client_with(
        NETWORK_PROBE_TIMEOUT,
        DEFAULT_REDIRECT_LIMIT,
        BROWSER_USER_AGENT,
    )?;

    let endpoints = stream::iter(ENDPOINTS.iter().copied().map(|endpoint| {
        let client = client.clone();
        async move { probe_endpoint(&client, &endpoint).await }
    }))
    .buffered(NETWORK_PROBE_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    Ok(NetworkDoctorReport {
        endpoints,
        proxy: http::effective_proxy_url(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_list_is_ordered_and_unique() {
        assert_eq!(ENDPOINTS.len(), 6);
        let ids: Vec<_> = ENDPOINTS.iter().map(|e| e.id).collect();
        let mut set = std::collections::HashSet::new();
        for id in &ids {
            assert!(set.insert(*id), "duplicate endpoint id: {:?}", id);
        }
        assert_eq!(ids[0], EndpointId::Baidu);
        assert_eq!(ids[1], EndpointId::Google);
        assert_eq!(ids[2], EndpointId::GoogleScholar);
        assert_eq!(ids[3], EndpointId::Github);
        assert_eq!(ids[4], EndpointId::Arxiv);
        assert_eq!(ids[5], EndpointId::SemanticScholar);
    }

    #[test]
    fn classify_error_maps_timeout_and_unreachable() {
        assert_eq!(classify_error(true), NetworkStatus::Timeout);
        assert_eq!(classify_error(false), NetworkStatus::Unreachable);
    }

    #[test]
    fn truncate_detail_keeps_short_text() {
        assert_eq!(truncate_detail("short"), "short");
    }

    #[test]
    fn truncate_detail_truncates_long_text() {
        let long = "x".repeat(DETAIL_MAX_CHARS + 10);
        let out = truncate_detail(&long);
        assert_eq!(out.len(), DETAIL_MAX_CHARS + "…".len());
        assert!(out.ends_with('…'));
    }
}
