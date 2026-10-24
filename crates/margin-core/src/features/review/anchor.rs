//! Quote relocation over manuscript source text.
//!
//! Blocks are blank-line-separated chunks; a block owns a `^block-id` when
//! its last line ends with ` ^id` (Obsidian syntax, inserted by the editor
//! on demand). The marker is stripped from the searchable text so quotes
//! never have to include it.
//!
//! Quotes come from two places: the editor, which copies rendered text
//! (`[1]`, `bold`), and Agents, which copy Markdown source (`\[1]`,
//! `**bold**`). A quote is looked up in the source first and, when absent
//! there, in the rendered plain text of the same blocks.

use std::cell::OnceCell;

use pulldown_cmark::{Event, Options, Parser, TagEnd};

use super::model::AnchorStatus;

/// One searchable block of manuscript text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub id: Option<String>,
    /// Block text with the trailing `^id` marker removed.
    pub text: String,
}

/// Split markdown source into blank-line-separated blocks, stripping
/// trailing `^block-id` markers from their text.
pub fn parse_blocks(source: &str) -> Vec<Block> {
    source
        .split("\n\n")
        .map(str::trim)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| {
            let (text, id) = strip_block_id(chunk);
            Block {
                id,
                text: text.to_string(),
            }
        })
        .collect()
}

/// Remove a trailing ` ^id` from a block's last line, returning the
/// remaining text and the id when present.
fn strip_block_id(chunk: &str) -> (&str, Option<String>) {
    let last_line = chunk.rsplit('\n').next().unwrap_or(chunk);
    let Some(caret) = last_line.rfind(" ^") else {
        return (chunk, None);
    };
    let id = &last_line[caret + 2..];
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return (chunk, None);
    }
    let keep = &chunk[..chunk.len() - (last_line.len() - caret)];
    (keep.trim_end(), Some(id.to_string()))
}

/// Rendered text of one Markdown block, as the editor shows it: escapes
/// resolved, emphasis, link and code markers dropped, line breaks kept.
fn plain_text(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM;
    let mut out = String::new();
    for event in Parser::new_ext(markdown, options) {
        match event {
            Event::Text(t) | Event::Code(t) | Event::InlineMath(t) | Event::DisplayMath(t) => {
                out.push_str(&t)
            }
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::TableRow
                | TagEnd::TableHead,
            ) => out.push('\n'),
            _ => {}
        }
    }
    out.trim_end().to_string()
}

/// A manuscript parsed once for relocating many comments.
pub struct Source {
    blocks: Vec<Block>,
    /// Source text with all block-id markers stripped.
    text: String,
    /// Rendered text per block, built only when a quote is not in `text`.
    plain: OnceCell<(Vec<String>, String)>,
}

impl Source {
    pub fn parse(source: &str) -> Self {
        let blocks = parse_blocks(source);
        let text = blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        Self {
            blocks,
            text,
            plain: OnceCell::new(),
        }
    }

    fn plain(&self) -> &(Vec<String>, String) {
        self.plain.get_or_init(|| {
            let blocks: Vec<String> = self.blocks.iter().map(|b| plain_text(&b.text)).collect();
            let text = blocks.join("\n\n");
            (blocks, text)
        })
    }
}

/// `fragment` rendered like [`plain_text`], keeping its edge whitespace so a
/// prefix or suffix still joins its quote.
fn rendered_fragment(fragment: &str) -> String {
    let body = fragment.trim();
    if body.is_empty() {
        return fragment.to_string();
    }
    let start = fragment.len() - fragment.trim_start().len();
    let end = fragment.trim_end().len();
    format!(
        "{}{}{}",
        &fragment[..start],
        plain_text(body),
        &fragment[end..]
    )
}

/// A quote copied from Markdown source (`\\[1]`, `**bold**`) that the editor
/// shows differently, rewritten as shown so it highlights in the editor.
/// `None` when the quote already matches the rendered text or has no
/// rendered counterpart. Prefix and suffix are rewritten the same way.
pub fn rendered_quote(
    source: &Source,
    quote: &str,
    prefix: &str,
    suffix: &str,
) -> Option<(String, String, String)> {
    let shown = &source.plain().1;
    if shown.contains(quote) {
        return None;
    }
    let rendered = rendered_fragment(quote);
    (!rendered.trim().is_empty() && shown.contains(&rendered)).then(|| {
        (
            rendered,
            rendered_fragment(prefix),
            rendered_fragment(suffix),
        )
    })
}

/// Characters of context kept on each side of a quote, as the editor does.
const CONTEXT_CHARS: usize = 32;

/// Byte lengths of the common prefix and (non-overlapping) common suffix.
fn common_affixes(a: &str, b: &str) -> (usize, usize) {
    let prefix: usize = a
        .chars()
        .zip(b.chars())
        .take_while(|(x, y)| x == y)
        .map(|(c, _)| c.len_utf8())
        .sum();
    let suffix: usize = a[prefix..]
        .chars()
        .rev()
        .zip(b[prefix..].chars().rev())
        .take_while(|(x, y)| x == y)
        .map(|(c, _)| c.len_utf8())
        .sum();
    (prefix, suffix)
}

/// Where a comment now points after one contiguous rewrite of `old` into
/// `new` (an Agent's exact replacement): a quote the rewrite touched follows
/// it onto the new text, widened to the rewritten words, so the comment stays
/// beside what replaced its text instead of turning outdated. Returns the new
/// quote, prefix and suffix, or `None` when the rewrite left the quote alone,
/// removed it entirely, or the quote cannot be placed without guessing.
pub fn follow_rewrite(
    old: &Source,
    new: &Source,
    quote: &str,
    prefix: &str,
    suffix: &str,
) -> Option<(String, String, String)> {
    let (a, b) = (&old.plain().1, &new.plain().1);
    let (shared_start, shared_end) = common_affixes(a, b);
    let (start, old_end, new_end) = (shared_start, a.len() - shared_end, b.len() - shared_end);
    if quote.trim().is_empty() || (start == old_end && start == new_end) {
        return None;
    }
    let found: Vec<usize> = a.match_indices(quote).map(|(at, _)| at).collect();
    let at = match found.as_slice() {
        [only] => *only,
        _ => {
            let fits = |at: &&usize| {
                a[..**at].ends_with(prefix) && a[**at + quote.len()..].starts_with(suffix)
            };
            let mut hits = found.iter().filter(fits);
            match (hits.next(), hits.next()) {
                (Some(at), None) => *at,
                _ => return None,
            }
        }
    };
    let (q_start, q_end) = (at, at + quote.len());
    let overlaps = (q_start < old_end && q_end > start)
        || (start == old_end && q_start < start && start < q_end);
    if !overlaps {
        return None;
    }
    let from = q_start.min(start);
    let to = if q_end > old_end {
        q_end - old_end + new_end
    } else {
        new_end
    };
    // A quote stays within one paragraph.
    let mut text = &b[from..to];
    if let Some(cut) = text.find("\n\n") {
        text = &text[..cut];
    }
    let lead = text.len() - text.trim_start().len();
    let text = text.trim();
    if text.is_empty() || text == quote {
        return None;
    }
    let (from, to) = (from + lead, from + lead + text.len());
    let block_start = b[..from].rfind("\n\n").map_or(0, |i| i + 2);
    let block_end = b[to..].find("\n\n").map_or(b.len(), |i| to + i);
    let before: Vec<char> = b[block_start..from].chars().collect();
    let prefix = before[before.len().saturating_sub(CONTEXT_CHARS)..]
        .iter()
        .collect();
    let suffix = b[to..block_end].chars().take(CONTEXT_CHARS).collect();
    Some((text.to_string(), prefix, suffix))
}

fn occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.matches(needle).count()
}

/// Re-locate one comment against current source text.
pub fn locate(
    block_id: Option<&str>,
    quote: &str,
    prefix: &str,
    suffix: &str,
    source: &str,
) -> AnchorStatus {
    locate_in(&Source::parse(source), block_id, quote, prefix, suffix)
}

/// [`locate`] over an already parsed manuscript.
pub fn locate_in(
    source: &Source,
    block_id: Option<&str>,
    quote: &str,
    prefix: &str,
    suffix: &str,
) -> AnchorStatus {
    if quote.trim().is_empty() {
        return AnchorStatus::Unlocated;
    }
    // Source text first (Agent quotes), then rendered text (editor quotes).
    let (blocks, haystack): (Vec<&str>, &str) = if source.text.contains(quote) {
        (
            source.blocks.iter().map(|b| b.text.as_str()).collect(),
            &source.text,
        )
    } else {
        let (blocks, text) = source.plain();
        (blocks.iter().map(String::as_str).collect(), text)
    };

    // Fast path: quote still lives inside its recorded block.
    if let Some(bid) = block_id {
        let recorded = source
            .blocks
            .iter()
            .position(|b| b.id.as_deref() == Some(bid));
        if recorded.is_some_and(|i| blocks[i].contains(quote)) {
            return AnchorStatus::Attached;
        }
    }

    match occurrences(haystack, quote) {
        0 => AnchorStatus::Deleted,
        1 => {
            if block_id.is_some() {
                // Unique in the document but no longer in its block.
                AnchorStatus::Modified
            } else {
                AnchorStatus::Attached
            }
        }
        _ => {
            // Disambiguate duplicates with the recorded context.
            let contextual = format!("{prefix}{quote}{suffix}");
            let has_context = !prefix.is_empty() || !suffix.is_empty();
            if has_context && occurrences(haystack, &contextual) == 1 {
                return if block_id.is_some() {
                    AnchorStatus::Modified
                } else {
                    AnchorStatus::Attached
                };
            }
            AnchorStatus::Unlocated
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blocks_strips_trailing_ids() {
        let src = "# Title\n\nFirst paragraph. ^blk-1\n\n- a\n- b\n\nLast line ^blk_2";
        let blocks = parse_blocks(src);
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[1].id.as_deref(), Some("blk-1"));
        assert_eq!(blocks[1].text, "First paragraph.");
        assert_eq!(blocks[2].id, None);
        assert_eq!(blocks[3].id.as_deref(), Some("blk_2"));
        assert_eq!(blocks[3].text, "Last line");
    }

    #[test]
    fn non_marker_caret_is_kept() {
        // `2^10` has no space before the caret; `^ ` with a space after is
        // not an id either.
        let blocks = parse_blocks("value is 2^10 here");
        assert_eq!(blocks[0].id, None);
        assert_eq!(blocks[0].text, "value is 2^10 here");
    }

    #[test]
    fn locate_attached_in_block() {
        let src = "Intro.\n\nThe quick brown fox. ^a1\n\nOutro.";
        assert_eq!(
            locate(Some("a1"), "quick brown", "", "", src),
            AnchorStatus::Attached
        );
    }

    #[test]
    fn locate_modified_when_quote_leaves_block() {
        let src = "Intro.\n\nChanged block. ^a1\n\nThe quick brown fox.";
        assert_eq!(
            locate(Some("a1"), "quick brown", "", "", src),
            AnchorStatus::Modified
        );
    }

    #[test]
    fn locate_deleted_when_quote_gone() {
        let src = "Intro. ^a1\n\nOther text.";
        assert_eq!(
            locate(Some("a1"), "quick brown", "", "", src),
            AnchorStatus::Deleted
        );
    }

    #[test]
    fn locate_unlocated_on_duplicates_and_context_recovers() {
        // Quote lives in two blocks, neither being its recorded block.
        let src = "start. ^a1\n\nalpha beta one.\n\nalpha beta two.";
        assert_eq!(
            locate(Some("a1"), "alpha beta", "", "", src),
            AnchorStatus::Unlocated
        );
        // Context pins it to a single occurrence outside its block.
        assert_eq!(
            locate(Some("a1"), "alpha beta", "", " one.", src),
            AnchorStatus::Modified
        );
        // Block-less comments with a unique contextual match stay attached.
        assert_eq!(
            locate(None, "alpha beta", "", " one.", src),
            AnchorStatus::Attached
        );
    }

    #[test]
    fn quotes_match_across_block_id_markers() {
        // The `^id` marker must not break quotes selected next to it.
        let src = "method converges quickly ^m9\n\nnext";
        assert_eq!(
            locate(Some("m9"), "converges quickly", "", "", src),
            AnchorStatus::Attached
        );
    }

    #[test]
    fn editor_quotes_match_rendered_text() {
        // The editor copies what it shows; the source keeps escapes and marks.
        let src = "# Intro\n\nReports carry evidence\\[1]. Models write **whole** reports\\[2–4], see [docs](https://x.org).\n\n| a | b |\n|---|---|\n| 9 | 27 |";
        for quote in ["evidence[1]. Models write whole reports[2–4]", "see docs."] {
            assert_eq!(
                locate(None, quote, "", "", src),
                AnchorStatus::Attached,
                "{quote}"
            );
        }
        // Agents quote Markdown source, table rows included.
        for quote in ["evidence\\[1]", "| 9 | 27 |"] {
            assert_eq!(
                locate(None, quote, "", "", src),
                AnchorStatus::Attached,
                "{quote}"
            );
        }
        assert_eq!(
            locate(None, "evidence[9]", "", "", src),
            AnchorStatus::Deleted
        );
    }

    #[test]
    fn source_quotes_are_rewritten_as_shown() {
        let source = Source::parse("Reports carry evidence\\[1] and **whole** text.");
        let (quote, prefix, _) =
            rendered_quote(&source, "evidence\\[1] and **whole**", "carry ", "").unwrap();
        assert_eq!(
            (quote.as_str(), prefix.as_str()),
            ("evidence[1] and whole", "carry ")
        );
        assert_eq!(rendered_quote(&source, "evidence[1]", "", ""), None);
        assert_eq!(rendered_quote(&source, "absent \\[9]", "", ""), None);
    }

    #[test]
    fn quotes_follow_the_rewrite_that_replaced_them() {
        let follow = |old: &str, new: &str, quote: &str| {
            follow_rewrite(&Source::parse(old), &Source::parse(new), quote, "", "")
                .map(|(q, _, _)| q)
        };
        let old = "# T\n\nOur method reduces memory by 40% on all benchmarks.\n\nNext.";
        // The whole quote rewritten: the comment moves onto the new words.
        let new = old.replace("reduces memory by 40%", "cuts peak memory by 38%");
        assert_eq!(
            follow(old, &new, "reduces memory by 40%").as_deref(),
            Some("cuts peak memory by 38%")
        );
        // One word inside the quote rewritten.
        let new = old.replace("40%", "38%");
        assert_eq!(
            follow(old, &new, "reduces memory by 40% on all").as_deref(),
            Some("reduces memory by 38% on all")
        );
        // Partly rewritten across its end: widened to the new words.
        let new = old.replace("40% on all benchmarks", "38% on two benchmarks");
        assert_eq!(
            follow(old, &new, "memory by 40%").as_deref(),
            Some("memory by 38% on two")
        );
        // Elsewhere, or removed entirely: left to anchoring.
        assert_eq!(
            follow(old, &old.replace("Next.", "Then."), "reduces memory"),
            None
        );
        assert_eq!(follow(old, &old.replace(" by 40%", ""), "by 40%"), None);
        // Editor quotes are rendered text; the source keeps escapes.
        let old = "Reports carry evidence\\[1] that is weak.";
        let new = old.replace("weak", "limited");
        let (quote, prefix, suffix) = follow_rewrite(
            &Source::parse(old),
            &Source::parse(&new),
            "evidence[1] that is weak",
            "",
            "",
        )
        .unwrap();
        assert_eq!(
            (quote.as_str(), prefix.as_str(), suffix.as_str()),
            ("evidence[1] that is limited", "Reports carry ", ".")
        );
    }
}
