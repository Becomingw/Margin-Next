use crate::core::error::AppError;
use crate::core::frontmatter::{frontmatter_block, scalar_field};
use crate::features::agent::models::{AgentSkill, AgentTemplate};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SKILL_BYTES: u64 = 64 * 1024;
const MAX_SELECTED_SKILLS: usize = 5;

/// How a given Agent CLI expects skills to be activated in the **user-visible prompt**.
///
/// Kept at the adapter boundary for compatibility. Composer-selected skills
/// are delivered inline for every provider; native /commands use a separate path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillMentionStyle {
    /// Codex (and similar): `$paper-reader`
    Dollar,
    /// Claude Code style slash skills / commands: `/paper-reader`
    Slash,
    /// No native trigger — Edda injects body only; do not pretend `$`/`/` activate anything.
    InjectedOnly,
}

/// Map Edda agent template → native skill mention style.
pub fn skill_mention_style(template: &AgentTemplate) -> SkillMentionStyle {
    match template {
        AgentTemplate::CodexAcp => SkillMentionStyle::Dollar,
        // pi-acp exposes skills as `/skill:<name>`, so a bare `/<name>` would name a
        // command that does not exist — rely on body injection instead.
        AgentTemplate::Pi => SkillMentionStyle::InjectedOnly,
        // All other agents use slash-style skill mentions.
        AgentTemplate::ClaudeAcp
        | AgentTemplate::Opencode
        | AgentTemplate::OpenClaw
        | AgentTemplate::Hermes
        | AgentTemplate::QoderCli
        | AgentTemplate::GrokBuild
        | AgentTemplate::Dsh
        | AgentTemplate::KimiCode
        | AgentTemplate::Custom => SkillMentionStyle::Slash,
    }
}

/// Format a single skill id the way this agent expects (or a neutral label).
pub fn format_skill_mention(skill_id: &str, _style: SkillMentionStyle) -> String {
    format!("skill:{skill_id}")
}

/// Composer skills are already loaded; never synthesize a native activation command.
pub fn skill_activation_prefix(_skill_ids: &[String], _style: SkillMentionStyle) -> String {
    String::new()
}

fn skill_roots(vault_path: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // Vault-local skills first (highest priority when same id exists later roots are skipped).
    if let Some(vault) = vault_path.map(Path::new).filter(|path| path.is_dir()) {
        roots.push(vault.join(".agents/skills"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".agents/skills"));
        roots.push(
            std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("skills"),
        );
        // Claude Code / Claude Desktop user skills (e.g. paper-reader).
        roots.push(home.join(".claude/skills"));
    }
    roots
}

fn parse_skill_metadata(content: &str, fallback_name: &str) -> (String, String) {
    let Some(front_matter) = frontmatter_block(content) else {
        return (fallback_name.to_string(), String::new());
    };
    let name = scalar_field(front_matter, "name").unwrap_or_else(|| fallback_name.to_string());
    let description = scalar_field(front_matter, "description").unwrap_or_default();
    (name, description)
}

fn skill_candidates(vault_path: Option<&str>) -> Vec<(String, PathBuf)> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for root in skill_roots(vault_path) {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if edda_core::features::vault::agent_config::RETIRED_SKILLS.contains(&id.as_str()) {
                continue;
            }
            if vault_path.is_some_and(|vault| {
                edda_core::features::vault::agent_config::skill_is_removed(Path::new(vault), &id)
            }) {
                continue;
            }
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            let path = entry.path().join("SKILL.md");
            if path.is_file() {
                candidates.push((id, path));
            }
        }
    }
    candidates
}

pub fn list_agent_skills(vault_path: Option<&str>) -> Vec<AgentSkill> {
    skill_candidates(vault_path)
        .into_iter()
        .filter_map(|(id, path)| {
            let content = fs::read_to_string(path).ok()?;
            let (name, description) = parse_skill_metadata(&content, &id);
            Some(AgentSkill {
                id,
                name,
                description,
            })
        })
        .collect()
}

fn skill_block_heading(skill_id: &str, style: SkillMentionStyle) -> String {
    format!(
        "### {} (already loaded)",
        format_skill_mention(skill_id, style)
    )
}

fn skill_section_preamble(_style: SkillMentionStyle, skill_ids: &[String]) -> String {
    format!("\n\n## Active local skills (Edda-injected)\nThe {} instructions below are already loaded. Apply them to the task without reloading them or announcing activation. Resolve supporting files relative to the given skill directory.\n\n", skill_ids.join(", "))
}

/// Load SKILL.md bodies and format them for the given agent skill-mention style.
pub fn load_skill_instructions(
    skill_ids: &[String],
    vault_path: Option<&str>,
    style: SkillMentionStyle,
) -> Result<String, AppError> {
    load_skill_instructions_with(skill_ids, vault_path, style, false)
}

/// `shipped_presets`: system preset skills are injected as shipped, whatever
/// their files on disk say (outside developer mode).
pub fn load_skill_instructions_with(
    skill_ids: &[String],
    vault_path: Option<&str>,
    style: SkillMentionStyle,
    shipped_presets: bool,
) -> Result<String, AppError> {
    if skill_ids
        .iter()
        .any(|id| edda_core::features::vault::agent_config::RETIRED_SKILLS.contains(&id.as_str()))
    {
        return Err(AppError::domain(
            "skill_retired",
            "Edda business operations now use MCP; remove the retired Skill attachment",
        ));
    }
    if skill_ids.len() > MAX_SELECTED_SKILLS {
        return Err(AppError::message(format!(
            "at most {MAX_SELECTED_SKILLS} skills can be used in one prompt"
        )));
    }
    let candidates = skill_candidates(vault_path);
    for id in skill_ids {
        if id != "paper-qa"
            && vault_path.is_some_and(|vault| {
                edda_core::features::vault::agent_config::skill_is_removed(Path::new(vault), id)
            })
        {
            return Err(AppError::message(format!(
                "Skill `{id}` was removed from this Vault; restore it in Skill management"
            )));
        }
    }
    let skill_ids: Vec<_> = skill_ids
        .iter()
        .filter(|id| {
            !vault_path.is_some_and(|vault| {
                edda_core::features::vault::agent_config::skill_is_removed(Path::new(vault), id)
            })
        })
        .cloned()
        .collect();
    let mut blocks = Vec::new();
    for skill_id in &skill_ids {
        let shipped = shipped_presets
            .then(|| edda_core::features::vault::presets::preset_skill_content(skill_id))
            .flatten();
        if let Some(content) = shipped {
            blocks.push(format!(
                "{}\nSkill directory: `.agents/skills/{skill_id}`\n{content}",
                skill_block_heading(skill_id, style)
            ));
            continue;
        }
        let Some((_, path)) = candidates.iter().find(|(id, _)| id == skill_id) else {
            // A vault can already be open when a new app workflow is installed.
            // Keep automatic QA usable until the next non-destructive vault seed.
            if skill_id == "paper-qa" {
                blocks.push(format!(
                    "{}\n{}",
                    skill_block_heading(skill_id, style),
                    edda_core::features::vault::PAPER_QA_SKILL
                ));
                continue;
            }
            return Err(AppError::message(format!(
                "local skill `{skill_id}` was not found"
            )));
        };
        let metadata = fs::metadata(path).map_err(AppError::Io)?;
        if metadata.len() > MAX_SKILL_BYTES {
            return Err(AppError::message(format!(
                "local skill `{skill_id}` exceeds {MAX_SKILL_BYTES} bytes"
            )));
        }
        let content = fs::read_to_string(path).map_err(AppError::Io)?;
        let directory = path.parent().unwrap_or(Path::new("."));
        let directory = vault_path
            .and_then(|vault| directory.strip_prefix(vault).ok())
            .unwrap_or(directory);
        blocks.push(format!(
            "{}\nSkill directory: `{}`\n{content}",
            skill_block_heading(skill_id, style),
            directory.display()
        ));
    }
    if blocks.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!(
            "{}{}",
            skill_section_preamble(style, &skill_ids),
            blocks.join("\n\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::agent::models::AgentTemplate;

    #[test]
    fn parses_skill_front_matter() {
        let (name, description) = parse_skill_metadata(
            "---\nname: example\ndescription: Useful instructions\n---\n# Body",
            "fallback",
        );
        assert_eq!(name, "example");
        assert_eq!(description, "Useful instructions");
    }

    #[test]
    fn bundled_qa_skill_is_focused_and_read_only() {
        let skill = edda_core::features::vault::PAPER_QA_SKILL;
        let (name, description) = parse_skill_metadata(skill, "paper-qa");
        assert_eq!(name, "paper-qa");
        assert!(!description.is_empty());
        assert!(skill.contains("Ordinary Q&A is read-only"));
        assert!(skill.len() < 4000, "the default QA skill must remain small");
    }

    #[test]
    fn paper_qa_is_already_loaded_not_a_native_skill_trigger() {
        for template in [
            AgentTemplate::CodexAcp,
            AgentTemplate::ClaudeAcp,
            AgentTemplate::GrokBuild,
            AgentTemplate::Opencode,
            AgentTemplate::Pi,
        ] {
            let style = skill_mention_style(&template);
            let ids = ["paper-qa".to_string()];
            assert!(skill_activation_prefix(&ids, style).is_empty());
            assert!(skill_block_heading("paper-qa", style).starts_with("### skill:paper-qa"));
            let preamble = skill_section_preamble(style, &ids);
            assert!(preamble.contains("already loaded"));
            assert!(!preamble.contains("Prefer the native skill"));
        }
    }

    #[test]
    fn explicit_skills_are_delivered_once_without_native_activation_hints() {
        let ids = ["paper-qa".to_string(), "custom-skill".to_string()];
        assert_eq!(skill_activation_prefix(&ids, SkillMentionStyle::Slash), "");
        assert_eq!(skill_activation_prefix(&ids, SkillMentionStyle::Dollar), "");
        assert!(skill_section_preamble(SkillMentionStyle::Slash, &ids)
            .contains("instructions below are already loaded"));
    }

    #[test]
    fn managed_qa_prompt_uses_the_vault_body_without_native_activation() {
        let vault = tempfile::tempdir().unwrap();
        let skill_dir = vault.path().join(".agents/skills/paper-qa");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            edda_core::features::vault::PAPER_QA_SKILL,
        )
        .unwrap();
        let ids = ["paper-qa".to_string()];
        let style = skill_mention_style(&AgentTemplate::GrokBuild);
        let instructions = load_skill_instructions(&ids, vault.path().to_str(), style).unwrap();
        let user = "翻译这段原文：\n\nSelected text from papers/example (page 1):\n> These features work across image distributions and tasks without fine-tuning.";
        let prompt = format!(
            "{}{}",
            crate::features::agent::prompt::build_prompt(
                Some("qa"),
                user,
                Some("papers/example"),
                style,
                &ids,
                None,
                None
            ),
            instructions
        );
        assert!(!prompt.contains("User request:\n/paper-qa"));
        assert!(prompt.contains("version: 5"));
        assert!(prompt
            .replace('\\', "/")
            .contains("Skill directory: `.agents/skills/paper-qa`"));
        assert!(prompt.contains("Translate/rephrase the supplied quotation"));
        // Optional artifact for a bounded manual native-provider smoke test.
        if let Ok(path) = std::env::var("EDDA_QA_PROBE_PROMPT_OUT") {
            fs::write(path, prompt).unwrap();
        }
    }

    #[test]
    fn parses_bundled_folded_description() {
        let bundled =
            include_str!("../../../../../templates/vault/.agents/skills/paper-reader/SKILL.md");
        let (name, description) = parse_skill_metadata(bundled, "paper-reader");
        assert_eq!(name, "paper-reader");
        assert!(description.starts_with("Generate or update full-paper structured reading notes"));
    }

    #[test]
    fn removed_qa_does_not_fall_back_and_restoring_reenables_it() {
        use edda_core::features::vault::{agent_config, ensure_vault};
        let vault = tempfile::tempdir().unwrap();
        ensure_vault(vault.path(), "en").unwrap();
        let ids = ["paper-qa".to_string()];
        let removed = agent_config::remove_skill(vault.path(), "paper-qa").unwrap();
        ensure_vault(vault.path(), "en").unwrap();
        assert!(
            load_skill_instructions(&ids, vault.path().to_str(), SkillMentionStyle::Slash)
                .unwrap()
                .is_empty()
        );
        assert!(!skill_candidates(vault.path().to_str())
            .iter()
            .any(|(id, _)| id == "paper-qa"));
        agent_config::undo_remove_skill(vault.path(), "paper-qa", &removed.batch_id).unwrap();
        assert!(
            load_skill_instructions(&ids, vault.path().to_str(), SkillMentionStyle::Slash)
                .unwrap()
                .contains("Ordinary Q&A is read-only")
        );
        agent_config::remove_skill(vault.path(), "paper-reader").unwrap();
        assert!(load_skill_instructions(
            &["paper-reader".into()],
            vault.path().to_str(),
            SkillMentionStyle::Slash
        )
        .is_err());
    }

    #[test]
    fn codex_receives_neutral_loaded_skill_labels() {
        assert_eq!(
            skill_mention_style(&AgentTemplate::CodexAcp),
            SkillMentionStyle::Dollar
        );
        assert_eq!(
            format_skill_mention("paper-reader", SkillMentionStyle::Dollar),
            "skill:paper-reader"
        );
    }

    #[test]
    fn claude_receives_neutral_loaded_skill_labels() {
        assert_eq!(
            skill_mention_style(&AgentTemplate::ClaudeAcp),
            SkillMentionStyle::Slash
        );
        assert_eq!(
            format_skill_mention("paper-reader", SkillMentionStyle::Slash),
            "skill:paper-reader"
        );
    }

    #[test]
    fn generic_agents_do_not_receive_synthetic_slash_commands() {
        assert_eq!(
            skill_mention_style(&AgentTemplate::Opencode),
            SkillMentionStyle::Slash
        );
        assert!(
            skill_activation_prefix(&["paper-reader".into()], SkillMentionStyle::Slash).is_empty()
        );
    }
}
