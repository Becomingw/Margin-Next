//! Line diff for the Changes view (baseline snapshot vs current manuscript).
//!
//! Plain LCS over lines; manuscripts are small (a few hundred lines), so the
//! O(n·m) table is fine, with a hard cap beyond which the whole file renders
//! as one replace hunk.

use serde::Serialize;

const MAX_LCS_LINES: usize = 5_000;
const CONTEXT: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// `context` | `add` | `del`
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// 1-based start line in the baseline snapshot.
    pub old_start: u32,
    /// 1-based start line in the current manuscript.
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

enum Op {
    Keep,
    Add,
    Del,
}

fn ctx(text: &str) -> DiffLine {
    DiffLine {
        kind: "context".into(),
        text: text.into(),
    }
}

/// Diff `old` against `new` line by line, returning hunks with 3 lines of
/// context. Empty when the texts are identical.
pub fn diff_lines(old: &str, new: &str) -> Vec<DiffHunk> {
    if old == new {
        return Vec::new();
    }
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    if a.len() > MAX_LCS_LINES || b.len() > MAX_LCS_LINES {
        return vec![DiffHunk {
            old_start: 1,
            new_start: 1,
            lines: a
                .iter()
                .map(|l| DiffLine {
                    kind: "del".into(),
                    text: (*l).into(),
                })
                .chain(b.iter().map(|l| DiffLine {
                    kind: "add".into(),
                    text: (*l).into(),
                }))
                .collect(),
        }];
    }

    // LCS table, then backtrack into an op stream.
    let (n, m) = (a.len(), b.len());
    let mut table = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i][j] = if a[i] == b[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let mut ops: Vec<(Op, usize, usize)> = Vec::new(); // (op, old_line, new_line)
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push((Op::Keep, i, j));
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            ops.push((Op::Del, i, j));
            i += 1;
        } else {
            ops.push((Op::Add, i, j));
            j += 1;
        }
    }
    while i < n {
        ops.push((Op::Del, i, j));
        i += 1;
    }
    while j < m {
        ops.push((Op::Add, i, j));
        j += 1;
    }

    // Keep changed ops plus CONTEXT lines around them; merge nearby hunks.
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut idx = 0;
    while idx < ops.len() {
        if matches!(ops[idx].0, Op::Keep) {
            idx += 1;
            continue;
        }
        let start = idx.saturating_sub(CONTEXT);
        let mut end = (idx + 1).min(ops.len());
        // Extend while the gap to the next change fits within 2×CONTEXT.
        while end < ops.len() {
            let gap = ops[end..]
                .iter()
                .position(|(op, _, _)| !matches!(op, Op::Keep))
                .map(|p| p + end);
            match gap {
                Some(next) if next - end <= CONTEXT * 2 => end = (next + 1).min(ops.len()),
                _ => break,
            }
        }
        end = (end + CONTEXT).min(ops.len());
        let mut lines = Vec::with_capacity(end - start);
        for (op, oi, ni) in &ops[start..end] {
            lines.push(match op {
                Op::Keep => ctx(a[*oi]),
                Op::Del => DiffLine {
                    kind: "del".into(),
                    text: a[*oi].into(),
                },
                Op::Add => DiffLine {
                    kind: "add".into(),
                    text: b[*ni].into(),
                },
            });
        }
        let first_keep_or_del = ops[start..end]
            .iter()
            .find(|(op, _, _)| !matches!(op, Op::Add));
        let old_start = first_keep_or_del
            .map(|(_, oi, _)| *oi as u32 + 1)
            .unwrap_or(1);
        let new_start = ops[start..end]
            .iter()
            .find(|(op, _, _)| !matches!(op, Op::Del))
            .map(|(_, _, ni)| *ni as u32 + 1)
            .unwrap_or(1);
        hunks.push(DiffHunk {
            old_start,
            new_start,
            lines,
        });
        idx = end;
    }
    hunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_texts_produce_no_hunks() {
        assert!(diff_lines("a\nb\nc\n", "a\nb\nc\n").is_empty());
    }

    #[test]
    fn single_line_change() {
        let old = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
        let new = "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\n";
        let hunks = diff_lines(old, new);
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        assert_eq!(h.old_start, 1); // context pulls back to line 1
        let kinds: Vec<&str> = h.lines.iter().map(|l| l.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["context", "context", "context", "del", "add", "context", "context", "context"]
        );
        assert_eq!(h.lines[3].text, "four");
        assert_eq!(h.lines[4].text, "FOUR");
    }

    #[test]
    fn nearby_changes_merge_into_one_hunk() {
        let old = "a\nb\nc\nd\ne\nf\n";
        let new = "A\nb\nc\nd\nE\nf\n";
        let hunks = diff_lines(old, new);
        assert_eq!(hunks.len(), 1, "gap of 3 keeps should merge");
    }

    #[test]
    fn distant_changes_stay_separate() {
        let old = (1..=30)
            .map(|i| format!("l{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut new_lines: Vec<String> = (1..=30).map(|i| format!("l{i}")).collect();
        new_lines[2] = "L3".into();
        new_lines[27] = "L28".into();
        let hunks = diff_lines(&old, &new_lines.join("\n"));
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].new_start, 1);
        assert!(hunks[1].old_start >= 25);
    }

    #[test]
    fn pure_insert_reports_new_start() {
        let hunks = diff_lines("a\nb\n", "a\nx\nb\n");
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0]
            .lines
            .iter()
            .any(|l| l.kind == "add" && l.text == "x"));
    }
}
