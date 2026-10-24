use crate::{
    error::AppError,
    features::scholar_api::identifiers::{clean_doi, extract_arxiv_id, strip_arxiv_version},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolAuthor {
    pub name: String,
    #[serde(default)]
    pub affiliations: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolSubmission {
    pub title: String,
    #[serde(default)]
    pub authors: Vec<PoolAuthor>,
    pub year: Option<i32>,
    #[serde(default, rename = "abstract")]
    pub abstract_text: String,
    pub doi: Option<String>,
    #[serde(alias = "arxiv_id")]
    pub arxiv_id: Option<String>,
    pub url: Option<String>,
    pub pdf_url: Option<String>,
    #[serde(alias = "reason")]
    pub recommendation: String,
    #[serde(default, alias = "recommendedBy")]
    pub source: String,
    pub recommended_at: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolRecommendation {
    pub source: String,
    pub reason: String,
    pub recommended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolPaper {
    pub key: String,
    pub title: String,
    pub authors: Vec<PoolAuthor>,
    pub year: Option<i32>,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub url: Option<String>,
    pub pdf_url: Option<String>,
    pub tags: Vec<String>,
    pub recommendations: Vec<PoolRecommendation>,
}

fn text(value: &str, max: usize) -> Result<String, AppError> {
    if value.len() > max {
        return Err(AppError::message("paper pool field exceeds size limit"));
    }
    Ok(value.trim().to_string())
}

fn web_url(value: Option<String>) -> Result<Option<String>, AppError> {
    let Some(value) = value.filter(|v| !v.trim().is_empty()) else {
        return Ok(None);
    };
    let value = text(&value, 4096)?;
    let url = reqwest::Url::parse(&value).map_err(|_| AppError::message("invalid paper URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::message("paper URLs must use HTTP(S)"));
    }
    Ok(Some(value))
}

impl PoolSubmission {
    pub fn normalize(mut self) -> Result<Self, AppError> {
        self.title = text(&self.title, 4096)?;
        self.recommendation = text(&self.recommendation, 32 * 1024)?;
        if self.title.is_empty() || self.recommendation.is_empty() {
            return Err(AppError::message("title and recommendation are required"));
        }
        self.abstract_text = text(&self.abstract_text, 128 * 1024)?;
        self.source = text(&self.source, 512)?;
        if self.year.is_some_and(|year| !(1000..=2100).contains(&year)) {
            return Err(AppError::message("invalid publication year"));
        }
        if self.authors.len() > 500 || self.tags.len() > 100 {
            return Err(AppError::message("too many authors or tags"));
        }
        for author in &mut self.authors {
            author.name = text(&author.name, 1024)?;
            if author.name.is_empty() || author.affiliations.len() > 50 {
                return Err(AppError::message("invalid author"));
            }
            author.affiliations = author
                .affiliations
                .iter()
                .map(|v| text(v, 2048))
                .collect::<Result<_, _>>()?;
            author.affiliations.retain(|v| !v.is_empty());
            author.affiliations.sort();
            author.affiliations.dedup();
        }
        let mut seen_authors = BTreeSet::new();
        self.authors.retain(|author| {
            seen_authors.insert((author.name.clone(), author.affiliations.clone()))
        });
        self.tags = self
            .tags
            .iter()
            .map(|v| text(v, 256))
            .collect::<Result<_, _>>()?;
        self.tags.retain(|v| !v.is_empty());
        self.tags.sort();
        self.tags.dedup();
        self.doi = self
            .doi
            .filter(|v| !v.trim().is_empty())
            .map(|v| {
                clean_doi(&v)
                    .map(|v| v.to_lowercase())
                    .ok_or_else(|| AppError::message("invalid DOI"))
            })
            .transpose()?;
        self.arxiv_id = self
            .arxiv_id
            .filter(|v| !v.trim().is_empty())
            .map(|v| {
                extract_arxiv_id(&v)
                    .map(|v| strip_arxiv_version(&v))
                    .ok_or_else(|| AppError::message("invalid arXiv ID"))
            })
            .transpose()?;
        self.url = web_url(self.url)?;
        self.pdf_url = web_url(self.pdf_url)?;
        // Canonical identifier links are evidence, unlike arbitrary URLs whose
        // paths happen to contain an arXiv-looking number.
        for raw in [&self.url, &self.pdf_url].into_iter().flatten() {
            let url = reqwest::Url::parse(raw).expect("validated URL");
            let host = url.host_str().unwrap_or("");
            if self.arxiv_id.is_none() && (host == "arxiv.org" || host.ends_with(".arxiv.org")) {
                self.arxiv_id = extract_arxiv_id(raw).map(|id| strip_arxiv_version(&id));
            }
            if self.doi.is_none() && matches!(host, "doi.org" | "dx.doi.org") {
                self.doi = clean_doi(raw).map(|doi| doi.to_lowercase());
            }
        }
        if let Some(value) = self.recommended_at.take().filter(|v| !v.trim().is_empty()) {
            let timestamp = chrono::DateTime::parse_from_rfc3339(&value)
                .map(|v| v.with_timezone(&chrono::Utc))
                .or_else(|_| {
                    chrono::NaiveDate::parse_from_str(&value, "%Y-%m-%d")
                        .map(|v| v.and_hms_opt(0, 0, 0).unwrap().and_utc())
                })
                .map_err(|_| AppError::message("recommendedAt must be an ISO date or timestamp"))?;
            self.recommended_at =
                Some(timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
        Ok(self)
    }

    fn aliases(&self) -> Vec<String> {
        let mut keys = Vec::new();
        if let Some(id) = &self.doi {
            keys.push(format!("doi:{id}"));
        }
        if let Some(id) = &self.arxiv_id {
            keys.push(format!("arxiv:{id}"));
        }
        if keys.is_empty() {
            let title: String = self
                .title
                .chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect();
            keys.push(format!(
                "title:{title}:{}:{}",
                self.year.unwrap_or_default(),
                self.authors
                    .first()
                    .map(|a| a.name.to_lowercase())
                    .unwrap_or_default()
            ));
        }
        keys
    }
}

pub fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// Exact scholarly IDs, with title/author/year fallback only when IDs are absent.
/// A submission carrying both DOI and arXiv can join two earlier partial groups.
pub fn merge_submissions(mut input: Vec<PoolSubmission>) -> Vec<PoolPaper> {
    input.sort_by(|a, b| {
        b.recommended_at
            .cmp(&a.recommended_at)
            .then(a.title.cmp(&b.title))
            .then(a.source.cmp(&b.source))
    });
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Option<(PoolPaper, BTreeSet<String>)>> = Vec::new();
    for row in input {
        let aliases = row.aliases();
        let matches: BTreeSet<_> = aliases
            .iter()
            .filter_map(|key| index.get(key).copied())
            .collect();
        let target = matches.first().copied().unwrap_or(groups.len());
        let incoming = PoolPaper {
            key: String::new(),
            title: row.title,
            authors: row.authors,
            year: row.year,
            abstract_text: row.abstract_text,
            doi: row.doi,
            arxiv_id: row.arxiv_id,
            url: row.url,
            pdf_url: row.pdf_url,
            tags: row.tags,
            recommendations: vec![PoolRecommendation {
                source: row.source,
                reason: row.recommendation,
                recommended_at: row.recommended_at,
            }],
        };
        if target == groups.len() {
            groups.push(Some((incoming, BTreeSet::new())));
        } else {
            merge_into(&mut groups[target].as_mut().unwrap().0, incoming);
        }
        for other in matches.into_iter().filter(|i| *i != target) {
            if let Some((paper, keys)) = groups[other].take() {
                let group = groups[target].as_mut().unwrap();
                merge_into(&mut group.0, paper);
                group.1.extend(keys);
            }
        }
        let group = groups[target].as_mut().unwrap();
        group.1.extend(aliases);
        for key in &group.1 {
            index.insert(key.clone(), target);
        }
    }
    let mut papers: Vec<_> = groups
        .into_iter()
        .flatten()
        .map(|(mut paper, keys)| {
            paper.key = digest(
                keys.iter()
                    .find(|v| v.starts_with("doi:"))
                    .or_else(|| keys.first())
                    .unwrap(),
            );
            paper
                .recommendations
                .sort_by(|a, b| b.recommended_at.cmp(&a.recommended_at));
            paper
        })
        .collect();
    papers.sort_by(|a, b| {
        b.recommendations
            .first()
            .and_then(|r| r.recommended_at.as_ref())
            .cmp(
                &a.recommendations
                    .first()
                    .and_then(|r| r.recommended_at.as_ref()),
            )
            .then(a.title.cmp(&b.title))
    });
    papers
}

fn merge_into(paper: &mut PoolPaper, other: PoolPaper) {
    paper.doi = paper.doi.take().or(other.doi);
    paper.arxiv_id = paper.arxiv_id.take().or(other.arxiv_id);
    paper.year = paper.year.or(other.year);
    paper.url = paper.url.take().or(other.url);
    paper.pdf_url = paper.pdf_url.take().or(other.pdf_url);
    if paper.abstract_text.is_empty() {
        paper.abstract_text = other.abstract_text;
    }
    for author in other.authors {
        if let Some(found) = paper
            .authors
            .iter_mut()
            .find(|a| a.name.eq_ignore_ascii_case(&author.name))
        {
            for affiliation in author.affiliations {
                if !found.affiliations.contains(&affiliation) {
                    found.affiliations.push(affiliation);
                }
            }
        } else {
            paper.authors.push(author);
        }
    }
    for tag in other.tags {
        if !paper.tags.contains(&tag) {
            paper.tags.push(tag);
        }
    }
    for reason in other.recommendations {
        if !paper
            .recommendations
            .iter()
            .any(|r| r.source == reason.source && r.reason == reason.reason)
        {
            paper.recommendations.push(reason);
        }
    }
}
