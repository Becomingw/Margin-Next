//! Human/agent-readable `REVIEW.md` export rendering.

use super::model::*;

fn quote_block(text: &str) -> String {
    text.split('\n')
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Render the review state as a Markdown reading aid. `review.json` remains
/// the restorable authority; this file is for people and external agents.
pub fn render(state: &ReviewState, manuscript: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Review: {}\n\n", state.title));
    out.push_str(&format!(
        "Unit: `{}` · Open: {} · Resolved: {} · Rounds: {}\n\n",
        state.id,
        state.open_count(),
        state.resolved_count(),
        state.revisions.len().max(1) - 1
    ));
    out.push_str("This is a reading aid. `review.json` holds the complete restorable record; anchors are `^block-id` + quote, not offsets.\n\n");

    for comment in &state.comments {
        out.push_str(&format!(
            "## {} · {} · actor: {} · anchor: {}\n\n",
            comment.id,
            comment.status.as_str(),
            comment.actor,
            comment.anchor.as_str()
        ));
        if let Some(editor) = &comment.edited_by {
            out.push_str(&format!("Last body edit: {editor}\n\n"));
        }
        if !comment.heading.is_empty() {
            out.push_str(&format!("Section: {}\n\n", comment.heading));
        }
        out.push_str("Selection:\n\n");
        out.push_str(&quote_block(&comment.quote));
        out.push_str("\n\nComment:\n\n");
        out.push_str(&quote_block(&comment.body));
        out.push_str("\n\n");
        for reply in &comment.replies {
            out.push_str(&format!(
                "Reply ({}, {}, {}):\n\n{}\n\n",
                reply.id,
                reply.created_at,
                reply.actor,
                quote_block(&reply.body)
            ));
        }
    }

    if state.revisions.len() > 1 {
        out.push_str("## Rounds\n\n");
        for rev in state.revisions.iter().skip(1) {
            let reason = if rev.reason.is_empty() {
                "No note."
            } else {
                &rev.reason
            };
            out.push_str(&format!(
                "- `{}` · {} · {}\n",
                rev.id, rev.created_at, reason
            ));
        }
        out.push('\n');
    }

    let edits = state
        .events
        .iter()
        .filter(|e| e.kind == "edit" || e.kind == "external-change")
        .count();
    if edits > 0 {
        out.push_str(&format!("## Edit events: {edits}\n\n"));
        for e in state
            .events
            .iter()
            .filter(|e| e.kind == "edit" || e.kind == "external-change")
        {
            out.push_str(&format!(
                "### {} · {} · {}\n\n",
                e.kind, e.actor, e.created_at
            ));
            if let Some(before) = &e.before {
                out.push_str("Before:\n\n");
                out.push_str(&quote_block(before));
                out.push_str("\n\n");
            }
            if let Some(after) = &e.after {
                out.push_str("After:\n\n");
                out.push_str(&quote_block(after));
                out.push_str("\n\n");
            }
        }
    }

    out.push_str("## Manuscript\n\n```markdown\n");
    out.push_str(manuscript);
    out.push_str("\n```\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::review::ops::add_comment;
    use crate::features::review::store::create_unit;

    #[test]
    fn render_includes_comments_and_manuscript() {
        let dir = tempfile::tempdir().expect("tempdir");
        let unit = create_unit(dir.path(), "Draft").expect("create");
        std::fs::write(
            dir.path()
                .join("reviews")
                .join(&unit.id)
                .join(MANUSCRIPT_FILE),
            "# Draft\n\nalpha beta.\n",
        )
        .unwrap();
        let input = ReviewCommentInput {
            block_id: None,
            quote: "alpha beta".into(),
            source: crate::features::review::model::CommentSource::Manuscript,
            page: None,
            prefix: String::new(),
            suffix: String::new(),
            heading: String::new(),
            body: "tighten this".into(),
        };
        let state = add_comment(dir.path(), &unit.id, &input).unwrap();
        let md = render(&state, "# Draft\n\nalpha beta.\n");
        assert!(md.contains("# Review: Draft"));
        assert!(md.contains("> tighten this"));
        assert!(md.contains("```markdown"));
    }
}
