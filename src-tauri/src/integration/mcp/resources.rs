//! MCP resources: workspace overview and research-operation guidance.

use super::McpController;
use crate::features::paper::catalog::{self, papers};
use edda_core::features::vault::EDDA_WORKSPACE_SKILL;
use edda_core::ops;

pub const VAULT_URI: &str = "edda://vault";
pub const VAULT_NAME: &str = "vault";

pub const INVARIANTS_URI: &str = "edda://agent-invariants";
pub const INVARIANTS_NAME: &str = "agent-invariants";

pub const SKILL_URI: &str = "edda://skills/edda-workspace";
pub const SKILL_NAME: &str = "edda-workspace-skill";

pub fn vault_markdown(ctrl: &McpController) -> String {
    match ctrl.local_vault() {
        Ok(vault) => {
            let (schema_version, papers_n, unread) = match catalog::ensure_catalog(&vault) {
                Ok(conn) => {
                    let ver = catalog::schema_version(&conn).ok();
                    drop(conn);
                    let rows = papers::list_all(&vault).unwrap_or_default();
                    let unread = rows.iter().filter(|r| !r.is_read).count();
                    (ver, rows.len(), unread)
                }
                Err(_) => (None, 0, 0),
            };
            let schema = schema_version
                .map(|v| v.to_string())
                .unwrap_or_else(|| "unknown".into());
            format!(
                "# Edda vault\n\n\
                 - **path**: `{}`\n\
                 - **schemaVersion**: {schema}\n\
                 - **papers**: {papers_n}\n\
                 - **unread**: {unread}\n\n\
                 Use `paper_list` for collection questions or `paper_context` for an identified paper when needed.\n\
                 `ref` is a paper id or vault-relative path. Supplied quotations need no preliminary lookup.\n",
                vault.display()
            )
        }
        Err(_) => {
            "# Edda vault\n\nNo local vault is open. Open a vault in Edda, then read this resource again.\n"
                .into()
        }
    }
}

pub fn invariants_markdown() -> String {
    ops::agent_invariants_markdown().to_string()
}

pub fn skill_markdown() -> String {
    EDDA_WORKSPACE_SKILL.to_string()
}

pub fn read(uri: &str, ctrl: &McpController) -> Option<(String, &'static str)> {
    match uri {
        VAULT_URI => Some((vault_markdown(ctrl), "text/markdown")),
        INVARIANTS_URI => Some((invariants_markdown(), "text/markdown")),
        SKILL_URI => Some((skill_markdown(), "text/markdown")),
        _ => None,
    }
}
