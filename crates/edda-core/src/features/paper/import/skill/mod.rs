//! Skill import: discover GitHub-backed skill archives, let the user pick
//! candidates, and install them into `.agents/skills`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::download::{extract_tar_safe, http_get_bytes_with_progress, AssetProgressAggregator};
use super::AppHandle;
use crate::error::AppError;
pub use crate::features::scholar_api::identifiers::SkillSource;
use crate::frontmatter::{frontmatter_block, scalar_field};

/// Provenance sidecar written next to an imported skill's `SKILL.md`.
pub const SKILL_PROVENANCE_FILE: &str = crate::app_file!("-skill.json");

const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_EXTRACTED_FILES: usize = 2_000;
const MAX_SKILL_NAME_LEN: usize = 64;
const MAX_DESCRIPTION_LEN: usize = 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportResult {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillCandidate {
    pub name: String,
    pub description: String,
    pub source: String,
    pub relative_path: String,
    pub already_installed: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiscovery {
    pub discovery_id: String,
    pub source: String,
    pub candidates: Vec<SkillCandidate>,
}

#[derive(Debug, Clone)]
struct ParsedSkillCandidate {
    dir: PathBuf,
    name: String,
    description: String,
}

pub async fn discover_skill_source(
    vault: &Path,
    source: &SkillSource,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<SkillDiscovery, AppError> {
    let reference = match &source.reference {
        Some(reference) => reference.clone(),
        None => default_branch(&source.owner, &source.repo).await?,
    };
    let archive_url = format!(
        "https://codeload.github.com/{}/{}/tar.gz/{}",
        source.owner,
        source.repo,
        urlencoding::encode(&reference)
    );
    let aggregator = AssetProgressAggregator::single(app, task_id, "skill");
    let archive =
        fetch_archive_with_mirror_fallback(&archive_url, Duration::from_secs(120), aggregator)
            .await?;
    if archive.len() > MAX_ARCHIVE_BYTES {
        return Err(AppError::message("skill archive is too large"));
    }

    let discovery_id = uuid::Uuid::new_v4().to_string();
    let temp = discovery_dir(&discovery_id)?;
    fs::create_dir_all(&temp)?;
    fs::write(temp.join("archive.tar.gz"), &archive)?;
    fs::write(
        temp.join("source.json"),
        serde_json::to_vec(&serde_json::json!({
            "source": source,
            "reference": reference,
        }))?,
    )?;
    let candidates = discover_candidates(&temp, vault, source)?;
    if candidates.is_empty() {
        let _ = fs::remove_dir_all(&temp);
        return Err(AppError::message(
            "no importable SKILL.md was found in this source",
        ));
    }
    Ok(SkillDiscovery {
        discovery_id,
        source: source.source.clone(),
        candidates,
    })
}

async fn default_branch(owner: &str, repo: &str) -> Result<String, AppError> {
    let canonical = format!("https://api.github.com/repos/{owner}/{repo}");
    let candidates = crate::http::github_url_candidates(&canonical);
    let mut last_err: Option<AppError> = None;
    for (index, url) in candidates.iter().enumerate() {
        match default_branch_once(url).await {
            Ok(branch) => return Ok(branch),
            Err(err) => {
                let retry =
                    index + 1 < candidates.len() && crate::http::should_fallback_github_error(&err);
                if retry {
                    log::warn!(
                        target: "edda::skill",
                        "GitHub default_branch via {url} failed ({err}); trying mirror"
                    );
                    last_err = Some(err);
                    continue;
                }
                return Err(err);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::message("GitHub repository lookup failed")))
}

async fn default_branch_once(url: &str) -> Result<String, AppError> {
    let client = crate::http::client_builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Edda/skill-import")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::message(format!("skill metadata request: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::message(format!(
            "GitHub repository lookup failed: {}",
            response.status()
        )));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::message(format!("invalid GitHub response: {e}")))?;
    body.get("default_branch")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::message("GitHub response did not include a default branch"))
}

async fn fetch_archive_with_mirror_fallback(
    canonical: &str,
    timeout: Duration,
    aggregator: AssetProgressAggregator<'_>,
) -> Result<Vec<u8>, AppError> {
    let candidates = crate::http::github_url_candidates(canonical);
    let mut last_err: Option<AppError> = None;
    for (index, url) in candidates.iter().enumerate() {
        match http_get_bytes_with_progress(url, timeout, None, aggregator.stream(0)).await {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                let retry =
                    index + 1 < candidates.len() && crate::http::should_fallback_github_error(&err);
                if retry {
                    log::warn!(
                        target: "edda::skill",
                        "skill archive via {url} failed ({err}); trying mirror"
                    );
                    last_err = Some(err);
                    continue;
                }
                return Err(err);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::message("skill archive download failed")))
}

pub fn install_discovered_skills(
    vault: &Path,
    discovery_id: &str,
    selected_names: &[String],
) -> Result<Vec<SkillImportResult>, AppError> {
    crate::fs::ensure_vault_dir(vault)?;
    let _guard = crate::features::vault::agent_config::lock(vault)?;
    let temp = discovery_dir(discovery_id)?;
    let archive = fs::read(temp.join("archive.tar.gz"))?;
    let metadata: serde_json::Value = serde_json::from_slice(&fs::read(temp.join("source.json"))?)?;
    let source: SkillSource = serde_json::from_value(
        metadata
            .get("source")
            .cloned()
            .ok_or_else(|| AppError::message("skill discovery metadata is invalid"))?,
    )?;
    let reference = metadata
        .get("reference")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::message("skill discovery reference is missing"))?;
    let result = install_from_archive(&temp, vault, &source, reference, &archive, selected_names);
    let _ = fs::remove_dir_all(&temp);
    result
}

pub fn discard_skill_discovery(discovery_id: &str) -> Result<(), AppError> {
    let temp = discovery_dir(discovery_id)?;
    if temp.exists() {
        fs::remove_dir_all(temp)?;
    }
    Ok(())
}

fn install_from_archive(
    temp: &Path,
    vault: &Path,
    source: &SkillSource,
    reference: &str,
    archive: &[u8],
    selected_names: &[String],
) -> Result<Vec<SkillImportResult>, AppError> {
    let tar_bytes = decode_gzip(archive)?;
    if tar_bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(AppError::message("unpacked skill archive is too large"));
    }
    extract_tar_safe(temp, &tar_bytes)?;

    let candidates: Vec<_> = discover_candidates_from_tar(temp, source, &tar_bytes)?;
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|candidate| {
            selected_names.is_empty()
                || selected_names
                    .iter()
                    .any(|name| name == "*" || name == &candidate.name)
        })
        .collect();
    if candidates.is_empty() {
        return Err(AppError::message("no selected Skill remains to install"));
    }

    let mut results = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let target = crate::features::vault::agent_config::skill_directory(vault, &candidate.name)?;
        let relative_path = format!(".agents/skills/{}", candidate.name);
        if target.exists() {
            results.push(SkillImportResult {
                name: candidate.name,
                description: candidate.description,
                path: relative_path,
                source: source.source.clone(),
                skipped: true,
            });
            continue;
        }
        let provenance = serde_json::json!({
            "source": source.source,
            "owner": source.owner,
            "repo": source.repo,
            "reference": reference,
            "installedAt": crate::time::now_rfc3339_millis(),
        });
        crate::features::vault::agent_config::stage_skill(vault, &candidate.name, |stage| {
            copy_dir(&candidate.dir, stage)?;
            fs::write(
                stage.join(SKILL_PROVENANCE_FILE),
                serde_json::to_vec_pretty(&provenance)?,
            )?;
            Ok(())
        })?;
        results.push(SkillImportResult {
            name: candidate.name,
            description: candidate.description,
            path: relative_path,
            source: source.source.clone(),
            skipped: false,
        });
    }
    Ok(results)
}

fn discover_candidates(
    temp: &Path,
    vault: &Path,
    source: &SkillSource,
) -> Result<Vec<SkillCandidate>, AppError> {
    let archive = fs::read(temp.join("archive.tar.gz"))?;
    let tar_bytes = decode_gzip(&archive)?;
    discover_candidates_from_tar(temp, source, &tar_bytes).map(|candidates| {
        candidates
            .into_iter()
            .map(|candidate| {
                let already_installed = vault.join(".agents/skills").join(&candidate.name).is_dir();
                SkillCandidate {
                    name: candidate.name,
                    description: candidate.description,
                    source: source.source.clone(),
                    relative_path: candidate
                        .dir
                        .strip_prefix(temp)
                        .unwrap_or(&candidate.dir)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    already_installed,
                }
            })
            .collect()
    })
}

fn discover_candidates_from_tar(
    temp: &Path,
    source: &SkillSource,
    tar_bytes: &[u8],
) -> Result<Vec<ParsedSkillCandidate>, AppError> {
    extract_tar_safe(temp, tar_bytes)?;
    let mut candidates = Vec::new();
    let entries = WalkDir::new(temp)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        .take(MAX_EXTRACTED_FILES + 1);
    for entry in entries {
        let dir = entry.path().parent().unwrap_or(temp).to_path_buf();
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok((name, description)) = parse_skill_metadata(&content) else {
            continue;
        };
        candidates.push(ParsedSkillCandidate {
            dir,
            name,
            description,
        });
    }
    if candidates.len() > MAX_EXTRACTED_FILES {
        return Err(AppError::message("skill archive contains too many files"));
    }

    Ok(candidates
        .into_iter()
        .filter(|candidate| {
            let relative = candidate
                .dir
                .strip_prefix(temp)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let path_matches = source.subpath.as_deref().is_none_or(|subpath| {
                relative == subpath || relative.ends_with(&format!("/{subpath}"))
            });
            let name_matches = source.skill_names.is_empty()
                || source
                    .skill_names
                    .iter()
                    .any(|name| name == "*" || name == &candidate.name);
            path_matches && name_matches
        })
        .collect())
}

fn discovery_dir(discovery_id: &str) -> Result<PathBuf, AppError> {
    let id = uuid::Uuid::parse_str(discovery_id)
        .map_err(|_| AppError::message("invalid skill discovery id"))?;
    Ok(std::env::temp_dir().join(format!("edda-skill-discovery-{id}")))
}

fn decode_gzip(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut decoder = GzDecoder::new(bytes);
    let mut output = Vec::new();
    decoder
        .read_to_end(&mut output)
        .map_err(|e| AppError::message(format!("skill archive gzip: {e}")))?;
    Ok(output)
}

fn parse_skill_metadata(content: &str) -> Result<(String, String), AppError> {
    if content.len() > 64 * 1024 {
        return Err(AppError::message("SKILL.md exceeds 64 KiB"));
    }
    let frontmatter = frontmatter_block(content)
        .ok_or_else(|| AppError::message("SKILL.md is missing YAML frontmatter"))?;
    let name = scalar_field(frontmatter, "name")
        .filter(|name| valid_skill_name(name))
        .ok_or_else(|| {
            AppError::message(
                "SKILL.md has an invalid name; use lowercase letters, numbers, and hyphens",
            )
        })?;
    let description = scalar_field(frontmatter, "description").unwrap_or_default();
    Ok((name, truncate_chars(&description, MAX_DESCRIPTION_LEN)))
}

/// Import one local Skill folder, including its supporting files, without executing it.
pub fn install_local_skill(vault: &Path, source: &Path) -> Result<SkillImportResult, AppError> {
    let source = source.canonicalize()?;
    let source = if source.is_file() && source.file_name().is_some_and(|name| name == "SKILL.md") {
        source
            .parent()
            .ok_or_else(|| AppError::message("invalid Skill path"))?
            .to_path_buf()
    } else {
        source
    };
    let skill = source.join("SKILL.md");
    if fs::metadata(&skill)?.len() > 64 * 1024 {
        return Err(AppError::message("SKILL.md exceeds 64 KiB"));
    }
    let (name, description) = parse_skill_metadata(&fs::read_to_string(&skill)?)?;
    let _guard = crate::features::vault::agent_config::lock(vault)?;
    let target = crate::features::vault::agent_config::skill_directory(vault, &name)?;
    let result = |skipped| SkillImportResult {
        name: name.clone(),
        description: description.clone(),
        path: format!(".agents/skills/{name}"),
        source: "local".into(),
        skipped,
    };
    if target.exists() {
        return Ok(result(true));
    }
    if target.starts_with(&source) {
        return Err(AppError::message(
            "Skill source cannot contain its installation directory",
        ));
    }
    let mut bytes = 0u64;
    for (index, entry) in WalkDir::new(&source).into_iter().enumerate() {
        let entry = entry.map_err(|e| AppError::message(e.to_string()))?;
        if index >= MAX_EXTRACTED_FILES || entry.file_type().is_symlink() {
            return Err(AppError::message(
                "Skill folder contains too many files or symbolic links",
            ));
        }
        if entry.file_type().is_file() {
            bytes += entry
                .metadata()
                .map_err(|e| AppError::message(e.to_string()))?
                .len();
        }
        if bytes > MAX_ARCHIVE_BYTES as u64 {
            return Err(AppError::message("Skill folder exceeds 64 MiB"));
        }
    }
    crate::features::vault::agent_config::stage_skill(vault, &name, |stage| {
        copy_dir(&source, stage)?;
        fs::write(
            stage.join(SKILL_PROVENANCE_FILE),
            serde_json::to_vec(
                &serde_json::json!({"source":"local", "installedAt":crate::time::now_rfc3339_millis()}),
            )?,
        )?;
        Ok(())
    })?;
    Ok(result(false))
}

fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((index, _)) => format!("{}…", value[..index].trim_end()),
        None => value.to_string(),
    }
}

fn valid_skill_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SKILL_NAME_LEN
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn copy_dir(source: &Path, target: &Path) -> Result<(), AppError> {
    for entry in WalkDir::new(source) {
        let entry = entry.map_err(|e| AppError::message(e.to_string()))?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| AppError::message(format!("skill path: {e}")))?;
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&destination)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_install_copies_assets_skips_existing_and_can_be_reinstalled() {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path().join("vault");
        let source = root.path().join("source");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(source.join("references")).unwrap();
        let body = "---\nname: custom-skill\ndescription: Local skill\n---\n# Instructions";
        fs::write(source.join("SKILL.md"), body).unwrap();
        fs::write(source.join("references/context.md"), "support").unwrap();
        let first = install_local_skill(&vault, &source).unwrap();
        assert!(!first.skipped);
        assert_eq!(
            fs::read_to_string(vault.join(&first.path).join("references/context.md")).unwrap(),
            "support"
        );
        fs::write(
            source.join("SKILL.md"),
            body.replace("Instructions", "Edited"),
        )
        .unwrap();
        assert!(install_local_skill(&vault, &source).unwrap().skipped);
        assert_eq!(
            fs::read_to_string(vault.join(&first.path).join("SKILL.md")).unwrap(),
            body
        );
        crate::features::vault::agent_config::remove_skill(&vault, "custom-skill").unwrap();
        assert!(!install_local_skill(&vault, &source).unwrap().skipped);
        assert!(!crate::features::vault::agent_config::skill_is_removed(
            &vault,
            "custom-skill"
        ));
        assert!(fs::read_to_string(vault.join(&first.path).join("SKILL.md"))
            .unwrap()
            .contains("Edited"));
    }

    #[cfg(unix)]
    #[test]
    fn local_install_rejects_linked_resources_without_partial_install() {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path().join("vault");
        let source = root.path().join("source");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: custom\n---\n# Instructions",
        )
        .unwrap();
        std::os::unix::fs::symlink(root.path(), source.join("outside")).unwrap();
        assert!(install_local_skill(&vault, &source).is_err());
        assert!(!vault.join(".agents/skills/custom").exists());
    }

    #[test]
    fn validates_skill_names() {
        assert!(valid_skill_name("frontend-design"));
        assert!(!valid_skill_name("Frontend Design"));
        assert!(!valid_skill_name("../escape"));
    }

    #[test]
    fn parses_frontmatter() {
        let (name, description) = parse_skill_metadata(
            "---\nname: example-skill\ndescription: Useful instructions\n---\n# Body",
        )
        .unwrap();
        assert_eq!(name, "example-skill");
        assert_eq!(description, "Useful instructions");
    }

    #[test]
    fn reads_folded_description() {
        let (_, description) = parse_skill_metadata(
            "---\nname: paper-reader\nversion: 2\ndescription: >-\n  Read and explain a\n  research paper.\n---\n# Body",
        )
        .unwrap();
        assert_eq!(description, "Read and explain a research paper.");
    }

    #[test]
    fn truncates_long_description_instead_of_failing() {
        let long = "研究".repeat(MAX_DESCRIPTION_LEN);
        let content = format!("---\nname: deep-research\ndescription: \"{long}\"\n---\n# Body");
        let (name, description) = parse_skill_metadata(&content).unwrap();
        assert_eq!(name, "deep-research");
        assert_eq!(description.chars().count(), MAX_DESCRIPTION_LEN + 1);
        assert!(description.ends_with('…'));
    }

    #[test]
    fn installs_monorepo_skipping_unusable_skills() {
        let tag = format!("edda-skill-install-{}", std::process::id());
        let vault = std::env::temp_dir().join(&tag);
        let _ = fs::remove_dir_all(&vault);
        fs::create_dir_all(&vault).unwrap();

        let long_description = format!("深度研究代理团队。Triggers: {}", "深度研究，".repeat(200));
        let files = [
            (
                "repo-main/deep-research/SKILL.md",
                format!("---\nname: deep-research\ndescription: \"{long_description}\"\n---\n# Body"),
            ),
            (
                "repo-main/paper-reader/SKILL.md",
                "---\nname: paper-reader\ndescription: >-\n  Read and explain a\n  research paper.\n---\n# Body".to_string(),
            ),
            (
                "repo-main/templates/SKILL.md",
                "# Template without frontmatter".to_string(),
            ),
        ];
        let mut tar = tar::Builder::new(Vec::new());
        for (path, content) in &files {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, content.as_bytes())
                .unwrap();
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, &tar.into_inner().unwrap()).unwrap();
        let archive = encoder.finish().unwrap();

        let discovery_id = uuid::Uuid::new_v4().to_string();
        let staged = discovery_dir(&discovery_id).unwrap();
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("archive.tar.gz"), &archive).unwrap();
        let source = SkillSource {
            owner: "acme".into(),
            repo: "repo".into(),
            reference: None,
            subpath: None,
            skill_names: Vec::new(),
            source: "https://github.com/acme/repo".into(),
        };
        fs::write(
            staged.join("source.json"),
            serde_json::to_vec(&serde_json::json!({ "source": source, "reference": "main" }))
                .unwrap(),
        )
        .unwrap();

        let results = install_discovered_skills(&vault, &discovery_id, &["*".to_string()]).unwrap();
        let mut names: Vec<&str> = results.iter().map(|r| r.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["deep-research", "paper-reader"]);
        assert!(vault
            .join(".agents/skills/deep-research/SKILL.md")
            .is_file());
        assert!(vault
            .join(".agents/skills/deep-research")
            .join(SKILL_PROVENANCE_FILE)
            .is_file());
        assert!(!vault.join(".agents/skills/templates").exists());

        let _ = fs::remove_dir_all(&vault);
        let _ = fs::remove_dir_all(&staged);
    }
}
