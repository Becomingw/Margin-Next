//! Vault create / scaffold helpers.
pub mod agent_config;
pub mod flat_papers;
pub mod presets;

use crate::error::AppError;
use crate::features::catalog;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// Default AGENTS.md; only pristine, hash-tracked copies may auto-upgrade.
pub const AGENTS_MD_TEMPLATE: &str = include_str!("../../../../../templates/vault/AGENTS.md");

/// Scaffold for `.agents/README.md` (only if missing).
pub const AGENTS_DIR_README: &str =
    include_str!("../../../../../templates/vault/.agents/README.md");

/// Skills index: bundled presets, third-party source + LICENSE.
pub const SKILLS_DIR_README: &str =
    include_str!("../../../../../templates/vault/.agents/skills/README.md");

/// Supervisor-Skills (HKUSTDial) CC BY-NC-SA 4.0 text.
pub const SUPERVISOR_SKILLS_LICENSE: &str =
    include_str!("../../../../../templates/vault/.agents/skills/LICENSE-Supervisor-Skills.txt");

/// Bundled paper-reader skill (file-tree Zap workflow).
pub const PAPER_READER_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/paper-reader/SKILL.md");

pub const PAPER_QA_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/paper-qa/SKILL.md");

/// Platform-neutral workspace guidance; tool schemas come from MCP.
pub const EDDA_WORKSPACE_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/edda-workspace/SKILL.md");

/// Bundled vault-normalizer skill (directory migration into Edda layout).
pub const VAULT_NORMALIZER_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/vault-normalizer/SKILL.md");

/// Bundled idea-evaluator skill (from Supervisor-Skills).
pub const IDEA_EVALUATOR_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/idea-evaluator/SKILL.md");

/// Bundled deep-research skill (from Supervisor-Skills).
pub const DEEP_RESEARCH_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/deep-research/SKILL.md");

pub const AUTHOR_LOOKUP_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/author-lookup/SKILL.md");

/// Fixing Browse page layouts with a site adapter's CSS.
pub const SITE_LAYOUT_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/site-layout/SKILL.md");

/// Importing papers from Browse pages through the `browse_*` tools.
pub const SITE_IMPORT_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/site-import/SKILL.md");

/// Reviewing and revising manuscripts under `reviews/` through `review_*` tools.
pub const EDDA_PAPER_REVIEWER_SKILL: &str =
    include_str!("../../../../../templates/vault/.agents/skills/edda-paper-reviewer/SKILL.md");

// Onboarding tutorial notes are discovered by build.rs and embedded here.
include!(concat!(env!("OUT_DIR"), "/onboarding_templates.rs"));

/// Vault-relative path → content for bundled skill seeding (no overwrite).
/// Paths are under the vault root (e.g. `.agents/skills/...`).
///
/// When the app ships new skills, [`ensure_vault`] / [`create_vault`] add any
/// missing paths here; existing files are left untouched so user edits survive.
pub fn bundled_skill_files() -> &'static [(&'static str, &'static str)] {
    &[
        (".agents/skills/README.md", SKILLS_DIR_README),
        (
            ".agents/skills/LICENSE-Supervisor-Skills.txt",
            SUPERVISOR_SKILLS_LICENSE,
        ),
        (".agents/skills/paper-reader/SKILL.md", PAPER_READER_SKILL),
        (".agents/skills/paper-qa/SKILL.md", PAPER_QA_SKILL),
        (
            ".agents/skills/author-lookup/SKILL.md",
            AUTHOR_LOOKUP_SKILL,
        ),
        (
            ".agents/skills/edda-workspace/SKILL.md",
            EDDA_WORKSPACE_SKILL,
        ),
        (".agents/skills/site-import/SKILL.md", SITE_IMPORT_SKILL),
        (".agents/skills/site-layout/SKILL.md", SITE_LAYOUT_SKILL),
        (
            ".agents/skills/edda-paper-reviewer/SKILL.md",
            EDDA_PAPER_REVIEWER_SKILL,
        ),
        (
            ".agents/skills/vault-normalizer/SKILL.md",
            VAULT_NORMALIZER_SKILL,
        ),
        // idea-evaluator (Supervisor-Skills)
        (
            ".agents/skills/idea-evaluator/SKILL.md",
            IDEA_EVALUATOR_SKILL,
        ),
        (
            ".agents/skills/idea-evaluator/references/domain-evaluation-frameworks.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/domain-evaluation-frameworks.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/fatal-flaws.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/fatal-flaws.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/five-dimensions.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/five-dimensions.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/lifecycle-capability-matching.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/lifecycle-capability-matching.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/paradigm-elephant.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/paradigm-elephant.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/paradigm-examples.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/paradigm-examples.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/paradigm-first-principles.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/paradigm-first-principles.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/paradigm-hamming.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/paradigm-hamming.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/paradigm-shift-probe.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/paradigm-shift-probe.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/paradigm-technology-cycle.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/paradigm-technology-cycle.md"
            ),
        ),
        (
            ".agents/skills/idea-evaluator/references/worked-examples.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/idea-evaluator/references/worked-examples.md"
            ),
        ),
        // deep-research (Supervisor-Skills)
        (
            ".agents/skills/deep-research/SKILL.md",
            DEEP_RESEARCH_SKILL,
        ),
        (
            ".agents/skills/deep-research/references/citation-protocol.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/deep-research/references/citation-protocol.md"
            ),
        ),
        (
            ".agents/skills/deep-research/references/hedge-calibration.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/deep-research/references/hedge-calibration.md"
            ),
        ),
        (
            ".agents/skills/deep-research/references/output-structure.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/deep-research/references/output-structure.md"
            ),
        ),
        (
            ".agents/skills/deep-research/references/quality-gates.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/deep-research/references/quality-gates.md"
            ),
        ),
        (
            ".agents/skills/deep-research/references/search-strategy.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/deep-research/references/search-strategy.md"
            ),
        ),
        (
            ".agents/skills/deep-research/references/self-adversarial.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/deep-research/references/self-adversarial.md"
            ),
        ),
        (
            ".agents/skills/deep-research/references/synthesis-framework.md",
            include_str!(
                "../../../../../templates/vault/.agents/skills/deep-research/references/synthesis-framework.md"
            ),
        ),
    ]
}

/// Parse optional integer `version:` from YAML frontmatter (Edda managed
/// bundled skills). Accepts `version: 1` or `version: "1"`. Non-integer values
/// are ignored so user/SemVer strings do not trigger silent overwrites.
pub(crate) fn parse_skill_frontmatter_version(content: &str) -> Option<u32> {
    let front_matter = crate::frontmatter::frontmatter_block(content)?;
    crate::frontmatter::scalar_field(front_matter, "version")?
        .parse::<u32>()
        .ok()
}

/// Whether `existing` may be replaced by the current bundled template.
///
/// Rules:
/// 1. Identical bytes → no upgrade.
/// 2. Bundled template has integer frontmatter `version` **and** existing has a
///    lower integer `version` → upgrade.
/// 3. Otherwise leave the file alone (no version / equal / higher / non-skill).
///
/// Opt out after editing a first-party skill: remove `version`, or set it higher
/// than the template.
pub fn should_auto_upgrade_bundled_skill(existing: &[u8], bundled: &str) -> bool {
    if existing == bundled.as_bytes() {
        return false;
    }
    let Some(bundled_version) = parse_skill_frontmatter_version(bundled) else {
        // Non-versioned bundled assets (README, LICENSE, references) are
        // seed-if-missing only.
        return false;
    };
    let Some(existing_version) = std::str::from_utf8(existing)
        .ok()
        .and_then(parse_skill_frontmatter_version)
    else {
        // No managed version → treat as user-owned / unversioned install.
        return false;
    };
    existing_version < bundled_version
}

/// True when the bundled template carries a managed `version` (may upgrade).
pub fn bundled_skill_may_upgrade(bundled: &str) -> bool {
    parse_skill_frontmatter_version(bundled).is_some()
}

/// Normalize a frontend/CLI locale preference to a supported onboarding locale.
/// Unknown or missing values fall back to English.
pub fn resolve_vault_locale(locale: &str) -> &str {
    match locale.trim().to_lowercase().as_str() {
        "zh-cn" | "zh" => "zh-CN",
        _ => "en",
    }
}

/// Vault-relative path → content for onboarding tutorial notes.
/// Files are written only if missing so user edits survive app updates.
pub fn bundled_onboarding_files(locale: &str) -> Vec<(&'static str, &'static str)> {
    let resolved = resolve_vault_locale(locale);
    BUNDLED_ONBOARDING_FILES
        .iter()
        .filter(|(entry_locale, _, _)| *entry_locale == resolved)
        .map(|(_, rel, content)| (*rel, *content))
        .collect()
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateVaultResult {
    pub path: String,
    pub created: Vec<String>,
    /// Untouched first-party bundled skills upgraded to the current template.
    pub updated: Vec<String>,
    /// Relative path suggested for first open (e.g. `AGENTS.md`).
    pub open_path: String,
    /// System presets put back to the shipped version (filled by the host
    /// outside developer mode; see [`presets::enforce_presets`]).
    pub presets: presets::PresetRestore,
}

fn join_rel(root: &Path, rel: &str) -> std::path::PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(part);
    }
    p
}

/// Write `rel` under `root` if missing. Creates parent dirs. Records `rel` in `created`.
fn seed_file_if_missing(
    root: &Path,
    rel: &str,
    content: &str,
    created: &mut Vec<String>,
) -> Result<(), AppError> {
    let path = join_rel(root, rel);
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, content)?;
    created.push(rel.into());
    Ok(())
}

/// Seed a missing bundled file, or safely upgrade a managed first-party
/// `SKILL.md` via frontmatter `version`.
/// Seed a bundled skill file, or upgrade it to a newer managed version unless
/// the user edited it since Edda last wrote it (`hashes` tracks those writes;
/// files from before tracking upgrade by version alone, then start tracking).
fn seed_or_upgrade_bundled_file(
    root: &Path,
    rel: &str,
    content: &str,
    hashes: &mut std::collections::BTreeMap<String, String>,
    created: &mut Vec<String>,
    updated: &mut Vec<String>,
) -> Result<(), AppError> {
    let path = join_rel(root, rel);
    let written = agent_config::hash(content.as_bytes());
    if !path.exists() {
        seed_file_if_missing(root, rel, content, created)?;
        hashes.insert(rel.to_string(), written);
        return Ok(());
    }
    let existing = fs::read(&path)?;
    if existing == content.as_bytes() {
        hashes.insert(rel.to_string(), written);
        return Ok(());
    }
    let edited = hashes
        .get(rel)
        .is_some_and(|recorded| *recorded != agent_config::hash(&existing));
    if !edited && should_auto_upgrade_bundled_skill(&existing, content) {
        fs::write(&path, content)?;
        updated.push(rel.to_string());
        hashes.insert(rel.to_string(), written);
    }
    Ok(())
}

/// Idempotent vault scaffold under `path` without overwriting existing user files.
///
/// Creates: `papers/`, `notes/`, `.edda/`, `.agents/` (+ `skills/`),
/// `AGENTS.md` (if missing), seeds `.agents/README.md` and bundled skills from
/// the app template, safely upgrades managed first-party skills (frontmatter
/// `version`), seeds localized onboarding tutorial notes under `notes/`, and
/// initializes `.edda/catalog.sqlite`.
/// Does **not** create `PAPERS.md` / `library.bib`.
///
/// Safe to call on every vault open after an app update so newly shipped skills
/// and onboarding notes appear while customized files stay intact.
pub fn ensure_vault(path: &Path, locale: &str) -> Result<CreateVaultResult, AppError> {
    // A moved or deleted vault must surface an error, never be re-scaffolded
    // from scratch at the old path.
    if !path.exists() {
        return Err(AppError::message(format!(
            "vault path not found: {}",
            path.display()
        )));
    }
    if !path.is_dir() {
        return Err(AppError::message(format!(
            "not a directory: {}",
            path.display()
        )));
    }

    crate::app_rename::migrate_vault_dir(path)?;

    let mut created: Vec<String> = Vec::new();
    let mut updated: Vec<String> = Vec::new();

    for dir in [
        "papers",
        "notes",
        "reviews",
        crate::paths::APP_DOT_DIR,
        ".agents",
        ".agents/skills",
    ] {
        let p = join_rel(path, dir);
        if !p.exists() {
            fs::create_dir_all(&p)?;
            created.push(format!("{dir}/"));
        }
    }

    // Seed vault-local agent layout from `templates/vault/.agents/`. Missing
    // files are created; known untouched first-party skills may be upgraded.
    seed_file_if_missing(path, ".agents/README.md", AGENTS_DIR_README, &mut created)?;
    {
        let _guard = agent_config::lock(path)?;
        agent_config::retire_skills(path)?;
        agent_config::initialize_instructions(path, &mut created, &mut updated)?;
        let removed = agent_config::removed_skills(path)?;
        let mut hashes = agent_config::bundled_skill_hashes(path)?;
        for (rel, content) in bundled_skill_files() {
            if rel
                .strip_prefix(".agents/skills/")
                .and_then(|p| p.split('/').next())
                .is_some_and(|id| removed.contains(id))
            {
                continue;
            }
            seed_or_upgrade_bundled_file(
                path,
                rel,
                content,
                &mut hashes,
                &mut created,
                &mut updated,
            )?;
        }
        agent_config::save_bundled_skill_hashes(path, hashes)?;
    }

    // Seed localized onboarding tutorial notes under `notes/` (no overwrite).
    let onboarding_files = bundled_onboarding_files(locale);
    for (rel, content) in &onboarding_files {
        seed_file_if_missing(path, rel, content, &mut created)?;
    }

    // Catalog: always ensure schema (may create catalog.sqlite)
    let db_path = catalog::catalog_db_path(path);
    let db_existed = db_path.exists();
    let conn = catalog::ensure_catalog(path)?;
    drop(conn);
    if !db_existed && db_path.exists() {
        created.push(crate::vault_private_rel!("catalog.sqlite").into());
    }

    let path_str = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();

    // Configuration is managed in Settings, never the ordinary document editor.
    let open_path = onboarding_files
        .first()
        .map(|(rel, _)| (*rel).to_string())
        .unwrap_or_default();

    Ok(CreateVaultResult {
        path: path_str,
        created,
        updated,
        open_path,
        presets: Default::default(),
    })
}

/// Create Edda vault skeleton. Creates the root directory when missing;
/// explicit creation is the only path allowed to scaffold a fresh location.
pub fn create_vault(path: &Path, locale: &str) -> Result<CreateVaultResult, AppError> {
    if !path.exists() {
        fs::create_dir_all(path)?;
    }
    ensure_vault(path, locale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn create_vault_scaffolds_dirs_and_catalog() {
        let dir = env::temp_dir().join(format!("edda-vault-create-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let r = create_vault(&dir, "en").expect("create");
        assert!(dir.join("papers").is_dir());
        assert!(dir.join("notes").is_dir());
        assert!(!dir.join("plans").exists());
        assert!(dir.join(crate::paths::APP_DOT_DIR).is_dir());
        assert!(dir.join(".agents").is_dir());
        assert!(dir.join(".agents/skills").is_dir());
        assert!(dir.join(".agents/README.md").is_file());
        assert!(dir.join(".agents/skills/README.md").is_file());
        assert!(dir
            .join(".agents/skills/LICENSE-Supervisor-Skills.txt")
            .is_file());
        assert!(dir.join(".agents/skills/paper-reader/SKILL.md").is_file());
        assert!(dir.join(".agents/skills/paper-qa/SKILL.md").is_file());
        assert!(dir.join(".agents/skills/edda-workspace/SKILL.md").is_file());
        assert!(dir
            .join(".agents/skills/edda-paper-reviewer/SKILL.md")
            .is_file());
        assert!(dir.join(".agents/skills/idea-evaluator/SKILL.md").is_file());
        assert!(dir
            .join(".agents/skills/idea-evaluator/references/five-dimensions.md")
            .is_file());
        assert!(dir.join(".agents/skills/deep-research/SKILL.md").is_file());
        assert!(dir
            .join(".agents/skills/deep-research/references/quality-gates.md")
            .is_file());
        assert!(dir.join("AGENTS.md").is_file());
        assert!(dir
            .join(crate::vault_private_rel!("catalog.sqlite"))
            .is_file());
        let onboarding_paths = bundled_onboarding_files("en")
            .into_iter()
            .map(|(rel, _)| rel.to_string())
            .collect::<Vec<_>>();
        assert_eq!(onboarding_paths.len(), 3);
        for rel in &onboarding_paths {
            assert!(dir.join(rel).is_file(), "missing onboarding note: {rel}");
        }
        assert_eq!(r.open_path, onboarding_paths[0]);
        assert!(!dir.join("PAPERS.md").exists());
        assert!(!dir.join("library.bib").exists());
        assert!(r
            .created
            .iter()
            .any(|c| c.contains("catalog") || c == "AGENTS.md" || c.ends_with('/')));
        assert!(r.created.iter().any(|c| c.starts_with(".agents")));
        assert!(r.created.iter().any(|c| c.starts_with("notes/")));

        // Second call does not wipe AGENTS.md, .agents/README.md, or onboarding notes
        fs::write(dir.join("AGENTS.md"), "# custom\n").unwrap();
        fs::write(dir.join(".agents/README.md"), "# keep\n").unwrap();
        fs::write(dir.join(&onboarding_paths[0]), "# edited\n").unwrap();
        let r2 = create_vault(&dir, "en").expect("again");
        assert_eq!(r2.open_path, onboarding_paths[0]);
        let content = fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(content.starts_with("# custom"));
        assert!(!r2.created.iter().any(|c| c == "AGENTS.md"));
        let agents_readme = fs::read_to_string(dir.join(".agents/README.md")).unwrap();
        assert!(agents_readme.starts_with("# keep"));
        assert!(!r2.created.iter().any(|c| c == ".agents/README.md"));
        let onboarding = fs::read_to_string(dir.join(&onboarding_paths[0])).unwrap();
        assert!(onboarding.starts_with("# edited"));
        assert!(!r2.created.iter().any(|c| c == &onboarding_paths[0]));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn retiring_business_skill_preserves_custom_content_and_is_repeatable() {
        let temp = tempfile::tempdir().unwrap();
        create_vault(temp.path(), "en").unwrap();
        let old = temp.path().join(".agents/skills/agentero-cli");
        fs::create_dir_all(old.join("scripts")).unwrap();
        fs::write(old.join("SKILL.md"), "my customized instructions").unwrap();
        fs::write(old.join("scripts/helper.py"), "print('custom')").unwrap();
        let former_workspace = temp.path().join(".agents/skills/agentero-workspace");
        fs::create_dir_all(&former_workspace).unwrap();
        fs::write(former_workspace.join("SKILL.md"), "v1").unwrap();
        ensure_vault(temp.path(), "en").unwrap();
        ensure_vault(temp.path(), "en").unwrap();
        assert!(!old.exists());
        assert!(!former_workspace.exists());
        let archives = fs::read_dir(
            temp.path()
                .join(crate::vault_private_rel!("retired-skills")),
        )
        .unwrap()
        .collect::<Vec<_>>();
        // One archive per retired skill, made once despite the repeated ensure.
        assert_eq!(archives.len(), 2);
        let archived = archives
            .iter()
            .map(|entry| entry.as_ref().unwrap().path().join("agentero-cli"))
            .find(|path| path.is_dir())
            .expect("archived business skill");
        assert_eq!(
            fs::read_to_string(archived.join("SKILL.md")).unwrap(),
            "my customized instructions"
        );
        assert!(archived.join("scripts/helper.py").is_file());
        assert!(temp
            .path()
            .join(".agents/skills/edda-workspace/SKILL.md")
            .is_file());
    }

    #[test]
    fn localized_onboarding_files_are_flattened_under_notes() {
        for locale in ["en", "zh-CN"] {
            let onboarding_paths = bundled_onboarding_files(locale);
            assert_eq!(onboarding_paths.len(), 3, "locale: {locale}");
            for (rel, _) in onboarding_paths {
                assert_eq!(
                    Path::new(rel).parent(),
                    Some(Path::new("notes")),
                    "onboarding path must be directly under notes/: {rel}"
                );
                assert!(!rel.starts_with("notes/en/"));
                assert!(!rel.starts_with("notes/zh-CN/"));
            }
        }

        let dir = env::temp_dir().join(format!("edda-vault-create-zh-flat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let result = create_vault(&dir, "zh-CN").expect("create Chinese vault");
        assert!(dir.join("notes/01 论文导入与管理.md").is_file());
        assert!(!dir.join("notes/zh-CN").exists());
        assert_eq!(result.open_path, "notes/01 论文导入与管理.md");

        let _ = fs::remove_dir_all(&dir);
    }

    /// After app update: missing bundled skills are added and customized files stay.
    #[test]
    fn ensure_vault_seeds_missing_bundled_skills_without_overwriting_customized_files() {
        let dir = env::temp_dir().join(format!("edda-vault-ensure-skills-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        create_vault(&dir, "en").expect("create");

        // Simulate an older vault that lacked a later-bundled skill, plus a user edit.
        let deep = dir.join(".agents/skills/deep-research");
        let _ = fs::remove_dir_all(&deep);
        let paper_skill = dir.join(".agents/skills/paper-reader/SKILL.md");
        fs::write(&paper_skill, "# my custom paper-reader\n").unwrap();

        let r = ensure_vault(&dir, "en").expect("ensure after update");
        assert!(
            r.created
                .iter()
                .any(|c| c.starts_with(".agents/skills/deep-research/")),
            "expected deep-research paths in created: {:?}",
            r.created
        );
        assert!(dir.join(".agents/skills/deep-research/SKILL.md").is_file());
        assert!(dir
            .join(".agents/skills/deep-research/references/quality-gates.md")
            .is_file());
        // User-edited skill must not be overwritten
        let paper = fs::read_to_string(&paper_skill).unwrap();
        assert!(paper.starts_with("# my custom paper-reader"));
        assert!(!r
            .created
            .iter()
            .any(|c| c == ".agents/skills/paper-reader/SKILL.md"));
        assert!(!r
            .updated
            .iter()
            .any(|c| c == ".agents/skills/paper-reader/SKILL.md"));

        // Idempotent: second ensure adds nothing for already-present skills
        let r2 = ensure_vault(&dir, "en").expect("ensure again");
        assert!(!r2
            .created
            .iter()
            .any(|c| c.starts_with(".agents/skills/deep-research/")));
        assert!(r2.updated.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_vault_refuses_missing_path_while_create_vault_scaffolds_it() {
        let dir = env::temp_dir().join(format!("edda-vault-ensure-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        // A moved/deleted vault must not be silently re-created on open.
        let err = ensure_vault(&dir, "en").expect_err("missing path must fail");
        assert!(err.to_string().contains("vault path not found"));
        assert!(!dir.exists());

        // Explicit creation still scaffolds a missing directory.
        create_vault(&dir, "en").expect("create");
        assert!(dir.join("papers").is_dir());
        assert!(dir
            .join(crate::vault_private_rel!("catalog.sqlite"))
            .is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_skill_frontmatter_version_reads_integer() {
        assert_eq!(
            parse_skill_frontmatter_version("---\nname: x\nversion: 2\n---\nbody\n"),
            Some(2)
        );
        assert_eq!(
            parse_skill_frontmatter_version("---\nversion: \"3\"\nname: x\n---\n"),
            Some(3)
        );
        assert_eq!(
            parse_skill_frontmatter_version("---\nname: x\n---\nno version\n"),
            None
        );
        // SemVer / non-integer must not be treated as managed.
        assert_eq!(
            parse_skill_frontmatter_version("---\nversion: 1.2.0\n---\n"),
            None
        );
    }

    #[test]
    fn bundled_skill_upgrades_when_version_is_lower() {
        let dir =
            env::temp_dir().join(format!("edda-vault-upgrade-version-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rel = ".agents/skills/example/SKILL.md";
        let path = join_rel(&dir, rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let old = "---\nname: example\nversion: 1\n---\nold body\n";
        let new = "---\nname: example\nversion: 2\n---\nnew body\n";
        fs::write(&path, old).unwrap();
        let mut created = Vec::new();
        let mut updated = Vec::new();
        let mut hashes = std::collections::BTreeMap::new();

        seed_or_upgrade_bundled_file(&dir, rel, new, &mut hashes, &mut created, &mut updated)
            .unwrap();
        assert!(created.is_empty());
        assert_eq!(updated, vec![rel]);
        assert_eq!(fs::read_to_string(&path).unwrap(), new);

        // Same version with user edits must not be overwritten.
        let customized = "---\nname: example\nversion: 2\n---\nuser edit\n";
        fs::write(&path, customized).unwrap();
        updated.clear();
        seed_or_upgrade_bundled_file(&dir, rel, new, &mut hashes, &mut created, &mut updated)
            .unwrap();
        assert!(updated.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), customized);

        // Higher local version (user fork) must not be overwritten by template.
        let forked = "---\nname: example\nversion: 9\n---\nfork\n";
        fs::write(&path, forked).unwrap();
        updated.clear();
        seed_or_upgrade_bundled_file(&dir, rel, new, &mut hashes, &mut created, &mut updated)
            .unwrap();
        assert!(updated.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), forked);

        // No version → treat as user-owned; never overwrite.
        fs::write(&path, "user customization without version\n").unwrap();
        updated.clear();
        seed_or_upgrade_bundled_file(&dir, rel, new, &mut hashes, &mut created, &mut updated)
            .unwrap();
        assert!(updated.is_empty());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "user customization without version\n"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_skill_edited_after_seed_survives_a_version_bump() {
        let dir = env::temp_dir().join(format!("edda-vault-upgrade-edit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rel = ".agents/skills/example/SKILL.md";
        let v1 = "---\nname: example\nversion: 1\n---\nbody\n";
        let v2 = "---\nname: example\nversion: 2\n---\nnew body\n";
        let (mut created, mut updated) = (Vec::new(), Vec::new());
        let mut hashes = std::collections::BTreeMap::new();

        // Edda seeds v1, the user edits it but keeps `version: 1`.
        seed_or_upgrade_bundled_file(&dir, rel, v1, &mut hashes, &mut created, &mut updated)
            .unwrap();
        let edited = "---\nname: example\nversion: 1\n---\nmy notes\n";
        fs::write(join_rel(&dir, rel), edited).unwrap();

        seed_or_upgrade_bundled_file(&dir, rel, v2, &mut hashes, &mut created, &mut updated)
            .unwrap();
        assert!(updated.is_empty());
        assert_eq!(fs::read_to_string(join_rel(&dir, rel)).unwrap(), edited);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_vault_upgrades_versioned_first_party_skills() {
        let dir = env::temp_dir().join(format!("edda-vault-ensure-version-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        create_vault(&dir, "en").expect("create");

        let paper = dir.join(".agents/skills/paper-reader/SKILL.md");
        let current = fs::read_to_string(&paper).unwrap();
        let bundled_v = parse_skill_frontmatter_version(&current).expect("bundled version");
        assert!(bundled_v >= 1);

        // Simulate an older managed install (lower version, different body).
        let older = "---\nname: paper-reader\nversion: 0\n---\n# stale paper-reader\n";
        fs::write(&paper, older).unwrap();
        // …from before Edda tracked what it wrote (no hash record yet).
        agent_config::save_bundled_skill_hashes(&dir, Default::default()).unwrap();
        let r = ensure_vault(&dir, "en").expect("ensure upgrades by version");
        assert!(
            r.updated
                .iter()
                .any(|p| p == ".agents/skills/paper-reader/SKILL.md"),
            "expected paper-reader in updated: {:?}",
            r.updated
        );
        let after = fs::read_to_string(&paper).unwrap();
        assert_eq!(parse_skill_frontmatter_version(&after), Some(bundled_v));
        assert!(after.contains("# Paper Reader"));

        // User-edited skill without version must not be overwritten.
        fs::write(&paper, "# my custom paper-reader\n").unwrap();
        let r2 = ensure_vault(&dir, "en").expect("ensure preserves custom");
        assert!(!r2
            .updated
            .iter()
            .any(|p| p == ".agents/skills/paper-reader/SKILL.md"));
        assert_eq!(
            fs::read_to_string(&paper).unwrap(),
            "# my custom paper-reader\n"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Optional smoke write:
    /// `EDDA_TEST_VAULT_PATH=$HOME/Downloads/edda-from-rust cargo test create_vault_at_env_path -- --ignored --nocapture`
    #[test]
    #[ignore = "set EDDA_TEST_VAULT_PATH to write a real vault (e.g. under Downloads)"]
    fn create_vault_at_env_path() {
        let raw = env::var("EDDA_TEST_VAULT_PATH").expect("set EDDA_TEST_VAULT_PATH");
        let dir = Path::new(&raw);
        if dir.exists() {
            let _ = fs::remove_dir_all(dir);
        }
        fs::create_dir_all(dir).unwrap();
        let r = create_vault(dir, "en").expect("create");
        assert!(dir
            .join(crate::vault_private_rel!("catalog.sqlite"))
            .is_file());
        assert!(dir.join("AGENTS.md").is_file());
        assert!(dir.join("papers").is_dir());
        assert!(!dir.join("PAPERS.md").exists());
        eprintln!(
            "create_vault wrote {} items to {}",
            r.created.len(),
            dir.display()
        );
    }
}

pub mod doctor;
pub mod rename;
pub mod trash;
pub mod tree;
