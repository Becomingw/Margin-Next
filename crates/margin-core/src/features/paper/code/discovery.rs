use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct Repository {
    pub host: String,
    pub project: String,
}

impl Repository {
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        let raw = raw.trim().trim_end_matches(['.', ',', ';', ':']);
        let url = url::Url::parse(raw).map_err(|_| {
            error(
                "code_invalid_url",
                "Enter a public GitHub or GitLab repository URL",
            )
        })?;
        let host = url.host_str().unwrap_or("");
        if !matches!(url.scheme(), "http" | "https")
            || !matches!(host, "github.com" | "gitlab.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err(error(
                "code_invalid_url",
                "Enter a public GitHub or GitLab repository URL",
            ));
        }
        let mut parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
        if host == "github.com" {
            parts.truncate(2);
        } else if let Some(index) = parts.iter().position(|p| *p == "-") {
            parts.truncate(index);
        }
        if let Some(last) = parts.last_mut() {
            *last = last.strip_suffix(".git").unwrap_or(last);
        }
        if parts.len() < 2
            || parts.iter().any(|p| {
                p.is_empty()
                    || *p == "."
                    || *p == ".."
                    || !p
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            })
        {
            return Err(error(
                "code_invalid_url",
                "Enter a repository, not a profile or project page",
            ));
        }
        Ok(Self {
            host: host.into(),
            project: parts.join("/"),
        })
    }
    pub fn url(&self) -> String {
        format!("https://{}/{}", self.host, self.project)
    }
    pub fn id(&self) -> String {
        let digest = hex::encode(Sha256::digest(self.url().to_ascii_lowercase().as_bytes()));
        let name: String = self
            .project
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .take(80)
            .collect();
        format!(
            "{}-{name}-{}",
            self.host.split('.').next().unwrap(),
            &digest[..16]
        )
    }
}

pub(super) fn candidates(text: &str, source: &str) -> Vec<CodeCandidate> {
    let text = text.replace("\\_", "_").replace("\\%", "%");
    let mut out = Vec::new();
    for host in ["github.com/", "gitlab.com/"] {
        for (start, _) in text.match_indices(host) {
            // Avoid matching a lookalike domain or mail address.
            if text[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || matches!(c, '.' | '@' | '-'))
            {
                continue;
            }
            let tail = &text[start..];
            let end = tail
                .find(|c: char| !(c.is_ascii_alphanumeric() || "/._-".contains(c)))
                .unwrap_or(tail.len());
            if let Ok(repo) = Repository::parse(&format!("https://{}", &tail[..end])) {
                let begin = text[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let line_end = text[start..]
                    .find('\n')
                    .map(|i| start + i)
                    .unwrap_or(text.len());
                out.push(CodeCandidate {
                    url: repo.url(),
                    source: source.into(),
                    evidence: text[begin..line_end].chars().take(280).collect(),
                });
            }
        }
    }
    out
}

pub fn discover(paper: &Path) -> Result<PaperCode, AppError> {
    let mut paths = vec![paper.join("PAPER.md")];
    let source = safe_child(paper, "source")?;
    if source.is_dir() {
        for entry in walkdir::WalkDir::new(source)
            .follow_links(false)
            .max_depth(12)
            .sort_by_file_name()
            .into_iter()
            .take(2048)
        {
            let entry = entry.map_err(|e| AppError::message(e.to_string()))?;
            if entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|ext| {
                        matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "tex" | "ltx" | "md" | "txt" | "html" | "json"
                        )
                    })
            {
                paths.push(entry.into_path());
            }
        }
    }
    let mut found = BTreeMap::new();
    let mut total = 0;
    let mut state = PaperCode {
        candidates: vec![],
        snapshots: vec![],
        body_available: false,
        truncated: false,
    };
    for path in paths.iter().take(512) {
        let rel = path
            .strip_prefix(paper)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let path = safe_child(paper, &rel)?;
        if !path.is_file() {
            continue;
        }
        state.body_available = true;
        let bytes = match read_limited(&path, 4 * 1024 * 1024) {
            Ok(bytes) => bytes,
            Err(_) => {
                state.truncated = true;
                continue;
            }
        };
        total += bytes.len();
        if total > 16 * 1024 * 1024 {
            state.truncated = true;
            break;
        }
        for candidate in candidates(&String::from_utf8_lossy(&bytes), &rel) {
            found
                .entry(candidate.url.to_ascii_lowercase())
                .or_insert(candidate);
            if found.len() >= 64 {
                state.truncated = true;
                break;
            }
        }
        if found.len() >= 64 {
            break;
        }
    }
    state.truncated |= paths.len() > 512;
    state.candidates = found.into_values().collect();
    Ok(state)
}
