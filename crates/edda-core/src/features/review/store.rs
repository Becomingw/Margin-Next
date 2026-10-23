//! On-disk layout and unit lifecycle for `reviews/<id>/`.
//!
//! ```text
//! reviews/<id>/
//! ├── manuscript.md      # the manuscript under review (plain Markdown)
//! ├── review.json        # comments / revisions / events (single authority)
//! ├── revisions/<rev>.md # checkpoint snapshots
//! └── assets/            # images referenced by the manuscript
//! ```
//!
//! Writers (the editor's saves, the review panel, every Agent over MCP) each
//! read `review.json`, change it and write it back. [`lock_unit`] makes them
//! take turns per unit, or one would overwrite the other's change. State and
//! manuscript are replaced atomically and flushed to disk; the previous state
//! is kept as `review.json.bak` and read when `review.json` cannot be.

use super::model::*;
use crate::error::AppError;
use crate::fs::{atomic_write_with, json_store_with, AtomicOpts};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, LazyLock, Mutex, PoisonError};

/// Units being written, and a signal when one is released.
static WRITING: LazyLock<(Mutex<HashSet<PathBuf>>, Condvar)> =
    LazyLock::new(|| (Mutex::new(HashSet::new()), Condvar::new()));

/// Unit summaries for [`list_units`], by unit dir, with the file stamps they
/// were made from.
static SUMMARIES: LazyLock<Mutex<HashMap<PathBuf, (String, ReviewUnitSummary)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Held while one writer reads, changes and saves a unit; see [`lock_unit`].
pub struct UnitLock(PathBuf);

impl Drop for UnitLock {
    fn drop(&mut self) {
        let (writing, released) = &*WRITING;
        writing
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
        released.notify_all();
    }
}

/// Wait until no other writer holds `unit_dir`, then hold it until the
/// returned lock drops. Units are told apart by their canonical path, so the
/// app and MCP reach the same lock however they spelled the vault path.
pub fn lock_unit(unit_dir: &Path) -> UnitLock {
    let key = fs::canonicalize(unit_dir).unwrap_or_else(|_| unit_dir.to_path_buf());
    let (writing, released) = &*WRITING;
    let mut held = writing.lock().unwrap_or_else(PoisonError::into_inner);
    while held.contains(&key) {
        held = released.wait(held).unwrap_or_else(PoisonError::into_inner);
    }
    held.insert(key.clone());
    UnitLock(key)
}

/// Replace a file of the unit (manuscript, snapshot) atomically, flushed to
/// disk: a reader never sees half of it.
pub fn write_unit_file(path: &Path, contents: &str) -> Result<(), AppError> {
    atomic_write_with(path, contents.as_bytes(), &AtomicOpts::DURABLE)?;
    Ok(())
}

pub fn reviews_root(vault: &Path) -> PathBuf {
    vault.join(REVIEWS_ROOT)
}

/// Validate a review id coming over IPC: it must be a single path segment.
fn checked_unit_dir(vault: &Path, id: &str) -> Result<PathBuf, AppError> {
    if id.is_empty()
        || id.len() > 120
        || id.contains(['/', '\\'])
        || id.starts_with('.')
        || id.split('-').all(|p| p.is_empty())
    {
        return Err(AppError::message("invalid review id"));
    }
    Ok(reviews_root(vault).join(id))
}

/// Same guard for sibling modules (ops).
pub fn checked_unit_dir_pub(vault: &Path, id: &str) -> Result<PathBuf, AppError> {
    checked_unit_dir(vault, id)
}

pub fn manuscript_path(unit_dir: &Path) -> PathBuf {
    unit_dir.join(MANUSCRIPT_FILE)
}

pub fn state_path(unit_dir: &Path) -> PathBuf {
    unit_dir.join(STATE_FILE)
}

/// The state as it was before the last save.
pub fn backup_path(unit_dir: &Path) -> PathBuf {
    unit_dir.join(format!("{STATE_FILE}.bak"))
}

pub fn read_manuscript(unit_dir: &Path) -> Result<String, AppError> {
    Ok(fs::read_to_string(manuscript_path(unit_dir))?)
}

/// A file's size and modification time: changes whenever its content is
/// replaced. Empty when the file is missing.
pub fn file_stamp(path: &Path) -> String {
    let Ok(meta) = fs::metadata(path) else {
        return String::new();
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    format!("{}-{modified}", meta.len())
}

fn read_state(path: &Path) -> Result<ReviewState, AppError> {
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

pub fn load_state(unit_dir: &Path) -> Result<ReviewState, AppError> {
    // Taken before reading: a write in between makes the stamp older than
    // the content, which costs the panel one extra reload, never a missed one.
    let stamp = file_stamp(&state_path(unit_dir));
    let mut state = match read_state(&state_path(unit_dir)) {
        Ok(state) => state,
        // Damaged or missing (a sync conflict, a crash before flushes): the
        // state before the last save loses at most that one change; the
        // next save writes `review.json` again.
        Err(error) => match read_state(&backup_path(unit_dir)) {
            Ok(state) => {
                log::warn!(
                    "review: {} unreadable ({error}); using {}",
                    state_path(unit_dir).display(),
                    backup_path(unit_dir).display()
                );
                state
            }
            Err(_) => return Err(error),
        },
    };
    if state.format != REVIEW_FORMAT || state.version != REVIEW_VERSION {
        return Err(AppError::message("unsupported review.json format"));
    }
    state.stamp = stamp;
    normalize_agent_names(&mut state);
    if let Some(pdf_name) = find_unit_pdf_name(unit_dir, state.pdf_file.as_deref()) {
        state.has_pdf = true;
        state.pdf_file = Some(pdf_name);
    } else {
        state.has_pdf = false;
        state.pdf_file = None;
    }
    if let Some(rev) = state.revisions.iter().find(|r| r.id == state.baseline_id) {
        if let Ok(text) = fs::read_to_string(unit_dir.join(&rev.file)) {
            state.baseline_text = text;
        }
    }
    Ok(state)
}

/// Records written before names were cleaned may hold invisible characters
/// ("gemi\u{200b}ni 4"); name them as the Agent's newer writes are. Clean
/// names, including ones fixed in the MCP address, stay as they are.
fn normalize_agent_names(state: &mut ReviewState) {
    let names = state
        .comments
        .iter_mut()
        .flat_map(|c| {
            std::iter::once(&mut c.agent).chain(c.replies.iter_mut().map(|r| &mut r.agent))
        })
        .chain(state.events.iter_mut().map(|e| &mut e.agent));
    for name in names.flatten() {
        if super::model::clean_agent_name(name) != *name {
            *name = super::model::agent_display_name(name);
        }
    }
}

pub fn save_state(unit_dir: &Path, state: &mut ReviewState) -> Result<(), AppError> {
    let path = state_path(unit_dir);
    // Keep the current state only if it is whole JSON: a damaged file must
    // not replace a good backup.
    let whole = fs::read_to_string(&path)
        .is_ok_and(|raw| serde_json::from_str::<serde::de::IgnoredAny>(&raw).is_ok());
    if whole {
        fs::copy(&path, backup_path(unit_dir))?;
    }
    // The baseline lives in its snapshot file, where `load_state` reads it;
    // a copy here only doubled the file.
    let baseline = std::mem::take(&mut state.baseline_text);
    let saved = json_store_with(&path, &*state, &AtomicOpts::DURABLE);
    state.baseline_text = baseline;
    saved?;
    state.stamp = file_stamp(&path);
    Ok(())
}

/// Find the PDF file inside a review unit dir (`pdf_file` if present, else any `*.pdf`).
pub fn find_unit_pdf_name(unit_dir: &Path, preferred: Option<&str>) -> Option<String> {
    if let Some(name) = preferred {
        if unit_dir.join(name).is_file() {
            return Some(name.to_string());
        }
    }
    let entries = fs::read_dir(unit_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
        {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                return Some(name.to_string());
            }
        }
    }
    None
}

pub fn unit_summary(dir: &Path, state: &ReviewState) -> ReviewUnitSummary {
    let pdf_path = find_unit_pdf_name(dir, state.pdf_file.as_deref())
        .map(|name| dir.join(name).to_string_lossy().to_string());
    state.summary(
        dir.to_string_lossy().to_string(),
        manuscript_path(dir).to_string_lossy().to_string(),
        pdf_path,
    )
}

pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// Lowercase slug from a title: alnum runs joined with `-`; CJK and other
/// non-ASCII letters are kept. Falls back to `untitled`.
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut dash = false;
    for c in title.trim().chars() {
        if c.is_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.extend(c.to_lowercase());
        } else {
            dash = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "untitled".into()
    } else {
        out.chars().take(60).collect()
    }
}

fn allocate_unit_dir(root: &Path, slug: &str) -> Result<(String, PathBuf), AppError> {
    fs::create_dir_all(root)?;
    for attempt in 0..100 {
        let id = if attempt == 0 {
            slug.to_string()
        } else {
            format!("{slug}-{}", attempt + 1)
        };
        let dir = root.join(&id);
        if !dir.exists() {
            return Ok((id, dir));
        }
    }
    Err(AppError::message("could not allocate review folder"))
}

/// Create a new review unit: folder, manuscript scaffold, initial snapshot
/// (the round-zero baseline), and `review.json`.
pub fn create_unit(vault: &Path, title: &str) -> Result<ReviewUnitSummary, AppError> {
    let title = title.trim();
    let title = if title.is_empty() { "Untitled" } else { title };
    let root = reviews_root(vault);
    let (id, dir) = allocate_unit_dir(&root, &slugify(title))?;
    let initial_md = format!("# {title}\n");
    let created = scaffold_with_content(&id, &dir, title, &initial_md, None, true);
    match created {
        Ok(state) => Ok(unit_summary(&dir, &state)),
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// Extract `# Heading` or `<h1>Heading</h1>` from the top of a Markdown file.
pub fn extract_markdown_heading_title(markdown: &str) -> Option<String> {
    for line in markdown.lines().take(30) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title = rest.trim().trim_matches('#').trim();
            if !title.is_empty() {
                return Some(title.chars().take(180).collect());
            }
        }
        if let Some(rest) = trimmed
            .strip_prefix("<h1>")
            .or_else(|| trimmed.strip_prefix("<H1>"))
        {
            if let Some(end) = rest.find("</h1>").or_else(|| rest.find("</H1>")) {
                let title = rest[..end].trim();
                if !title.is_empty() {
                    return Some(title.chars().take(180).collect());
                }
            }
        }
    }
    None
}

/// Import one or more local files (`.pdf`, `.md`, `.markdown`, `.tex`, `.txt`)
/// into `reviews/<id>/` as first-class review units.
pub fn import_files(
    vault: &Path,
    file_paths: &[String],
) -> Result<Vec<ReviewUnitSummary>, AppError> {
    use std::io::Read;
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }
    let root = reviews_root(vault);
    fs::create_dir_all(&root)?;
    let mut imported = Vec::new();
    let mut errors = Vec::new();

    for raw in file_paths {
        let src = PathBuf::from(raw.trim());
        if !src.is_file() {
            errors.push(format!("{}: file not found", raw.trim()));
            continue;
        }
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("review");
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if ext == "pdf" {
            let mut f = match fs::File::open(&src) {
                Ok(f) => f,
                Err(e) => {
                    errors.push(format!("{stem}: {e}"));
                    continue;
                }
            };
            let mut header = [0u8; 1024];
            let n = f.read(&mut header).unwrap_or(0);
            if !header[..n].windows(5).any(|w| w == b"%PDF-") {
                errors.push(format!("{stem}: invalid PDF file"));
                continue;
            }
            let title = crate::features::import::title_from_stem(stem);
            let slug = slugify(&title);
            let (id, dir) = allocate_unit_dir(&root, &slug)?;
            let pdf_name = format!("{id}.pdf");
            let initial_md = format!("# {title}\n");
            let res = (|| -> Result<ReviewState, AppError> {
                let state = scaffold_with_content(
                    &id,
                    &dir,
                    &title,
                    &initial_md,
                    Some(pdf_name.clone()),
                    false,
                )?;
                fs::copy(&src, dir.join(&pdf_name))?;
                Ok(state)
            })();
            match res {
                Ok(state) => imported.push(unit_summary(&dir, &state)),
                Err(e) => {
                    let _ = fs::remove_dir_all(&dir);
                    errors.push(format!("{stem}: {e}"));
                }
            }
        } else {
            let content = match fs::read_to_string(&src) {
                Ok(c) => c,
                Err(e) => {
                    errors.push(format!("{stem}: {e}"));
                    continue;
                }
            };
            let title = extract_markdown_heading_title(&content)
                .unwrap_or_else(|| crate::features::import::title_from_stem(stem));
            let slug = slugify(&title);
            let (id, dir) = allocate_unit_dir(&root, &slug)?;
            let body = if content.trim().is_empty() {
                format!("# {title}\n")
            } else {
                content
            };
            match scaffold_with_content(&id, &dir, &title, &body, None, true) {
                Ok(state) => imported.push(unit_summary(&dir, &state)),
                Err(e) => {
                    let _ = fs::remove_dir_all(&dir);
                    errors.push(format!("{stem}: {e}"));
                }
            }
        }
    }

    if imported.is_empty() && !errors.is_empty() {
        return Err(AppError::message(errors.join("; ")));
    }
    Ok(imported)
}

/// Apply the Markdown body parsed from the unit's PDF. If the user has not
/// made manual edits yet, also advances the initial baseline (`r0`) so the
/// parsed body is treated as the clean starting document.
pub fn apply_parsed_pdf_body(
    vault: &Path,
    id: &str,
    markdown: &str,
) -> Result<ReviewState, AppError> {
    let dir = checked_unit_dir(vault, id)?;
    let _lock = lock_unit(&dir);
    let mut state = load_state(&dir)?;
    let had_edits = state
        .events
        .iter()
        .any(|e| e.kind == "edit" || e.kind == "external-change");
    if !had_edits {
        if let Some(extracted_title) = extract_markdown_heading_title(markdown) {
            state.title = extracted_title;
        }
        if let Some(rev) = state
            .revisions
            .iter_mut()
            .find(|r| r.id == state.baseline_id)
        {
            write_unit_file(&dir.join(&rev.file), markdown)?;
            rev.hash = sha256_hex(markdown);
        }
        state.baseline_text = markdown.to_string();
    }
    state.body_parsed = true;
    state.manuscript_hash = Some(sha256_hex(markdown));
    super::ops::reanchor_all(&mut state, markdown);
    save_state(&dir, &mut state)?;
    Ok(state)
}

fn scaffold_with_content(
    id: &str,
    dir: &Path,
    title: &str,
    manuscript: &str,
    pdf_file: Option<String>,
    body_parsed: bool,
) -> Result<ReviewState, AppError> {
    fs::create_dir_all(dir.join(REVISIONS_DIR))?;
    fs::create_dir_all(dir.join("assets"))?;
    fs::write(manuscript_path(dir), manuscript)?;
    let now = crate::time::now_rfc3339_millis();
    let rev_id = new_id("rev");
    let rev = Revision {
        id: rev_id.clone(),
        parent_id: None,
        hash: sha256_hex(manuscript),
        created_at: now.clone(),
        reason: String::new(),
        file: format!("{REVISIONS_DIR}/{rev_id}.md"),
    };
    fs::write(dir.join(&rev.file), manuscript)?;
    let mut state = ReviewState {
        format: REVIEW_FORMAT.into(),
        version: REVIEW_VERSION,
        id: id.to_string(),
        title: title.to_string(),
        authors: Vec::new(),
        year: None,
        has_pdf: pdf_file.is_some(),
        pdf_file,
        body_parsed,
        created_at: now.clone(),
        baseline_id: rev.id.clone(),
        manuscript_hash: Some(sha256_hex(manuscript)),
        baseline_text: manuscript.to_string(),
        revisions: vec![rev.clone()],
        comments: Vec::new(),
        stamp: String::new(),
        events: vec![
            ReviewEvent {
                id: new_id("e"),
                kind: "created".into(),
                created_at: now.clone(),
                actor: "author".into(),
                agent: None,
                comment_id: None,
                reply_id: None,
                before: None,
                after: None,
                prefix: None,
                suffix: None,
                revision_id: None,
                reason: None,
            },
            ReviewEvent {
                id: new_id("e"),
                kind: "checkpoint".into(),
                created_at: now,
                actor: "author".into(),
                agent: None,
                comment_id: None,
                reply_id: None,
                before: None,
                after: None,
                prefix: None,
                suffix: None,
                revision_id: Some(rev.id.clone()),
                reason: Some("initial".into()),
            },
        ],
    };
    save_state(dir, &mut state)?;
    Ok(state)
}

/// List review units under `reviews/` (dirs with a readable `review.json`).
pub fn list_units(vault: &Path) -> Result<Vec<ReviewUnitSummary>, AppError> {
    let root = reviews_root(vault);
    let mut out = Vec::new();
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || !state_path(&dir).exists() {
            continue;
        }
        // Any change under `reviews/` lists every unit again; one whose
        // files did not change keeps the summary it had.
        let key = format!(
            "{}|{}|{}",
            file_stamp(&state_path(&dir)),
            file_stamp(&manuscript_path(&dir)),
            find_unit_pdf_name(&dir, None).unwrap_or_default()
        );
        let cache = SUMMARIES.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((cached_key, summary)) = cache.get(&dir) {
            if *cached_key == key {
                out.push(summary.clone());
                continue;
            }
        }
        drop(cache);
        let Ok(mut state) = load_state(&dir) else {
            continue; // corrupt units stay visible on disk, just unlisted
        };
        // Keep list badges current even when the manuscript was edited with
        // the review tab closed; listing must not mutate the review history.
        if !state.comments.is_empty() {
            if let Ok(manuscript) = read_manuscript(&dir) {
                super::ops::reanchor_all(&mut state, &manuscript);
            }
        }
        let summary = unit_summary(&dir, &state);
        SUMMARIES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(dir, (key, summary.clone()));
        out.push(summary);
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// Load + re-anchor one unit against its current manuscript, persisting
/// anchor changes. This is the open/refresh path.
pub fn open_unit(vault: &Path, id: &str) -> Result<(ReviewState, String), AppError> {
    open_unit_with_previous(vault, id, None)
}

/// Use the Host's last confirmed content when available to preserve a
/// before/after span for changes made outside the review editor.
pub fn open_unit_with_previous(
    vault: &Path,
    id: &str,
    previous: Option<&str>,
) -> Result<(ReviewState, String), AppError> {
    let dir = checked_unit_dir(vault, id)?;
    if !dir.is_dir() {
        return Err(AppError::message("review not found"));
    }
    let _lock = lock_unit(&dir);
    let mut state = load_state(&dir)?;
    let manuscript = read_manuscript(&dir)?;
    let old_hash = state.manuscript_hash.clone();
    super::ops::reconcile_external_change(&mut state, &manuscript, previous);
    let anchors_changed = super::ops::reanchor_all(&mut state, &manuscript);
    let changed = old_hash != state.manuscript_hash || anchors_changed;
    if changed {
        save_state(&dir, &mut state)?;
    }
    Ok((state, manuscript))
}

pub fn rename_unit(vault: &Path, id: &str, title: &str) -> Result<ReviewUnitSummary, AppError> {
    let dir = checked_unit_dir(vault, id)?;
    let _lock = lock_unit(&dir);
    let mut state = load_state(&dir)?;
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::message("title must not be empty"));
    }
    state.title = title.to_string();
    save_state(&dir, &mut state)?;
    Ok(unit_summary(&dir, &state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_titles() {
        assert_eq!(slugify("CVPR 2026 Submission"), "cvpr-2026-submission");
        assert_eq!(slugify("  -- weird --  "), "weird");
        assert_eq!(slugify(""), "untitled");
        assert_eq!(slugify("论文修改稿"), "论文修改稿");
    }

    #[test]
    fn create_and_list_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = dir.path();
        let unit = create_unit(vault, "My Draft").expect("create");
        assert_eq!(unit.id, "my-draft");
        assert!(Path::new(&unit.manuscript_path).exists());
        assert_eq!(unit.open_count, 0);

        // Collision gets a suffix.
        let second = create_unit(vault, "My Draft").expect("second");
        assert_eq!(second.id, "my-draft-2");

        let units = list_units(vault).expect("list");
        assert_eq!(units.len(), 2);

        let (state, manuscript) = open_unit(vault, &unit.id).expect("open");
        assert_eq!(state.title, "My Draft");
        assert_eq!(state.revisions.len(), 1);
        assert_eq!(state.baseline_id, state.revisions[0].id);
        assert!(manuscript.starts_with("# My Draft"));
        // Snapshot exists at the recorded path.
        assert!(vault
            .join("reviews/my-draft")
            .join(&state.revisions[0].file)
            .exists());
    }

    #[test]
    fn rename_updates_title_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let unit = create_unit(dir.path(), "Old").expect("create");
        let renamed = rename_unit(dir.path(), &unit.id, "New Title").expect("rename");
        assert_eq!(renamed.id, unit.id, "folder id is stable");
        assert_eq!(renamed.title, "New Title");
    }

    #[test]
    fn rejects_path_escape_in_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(open_unit(dir.path(), "../escape").is_err());
        assert!(open_unit(dir.path(), "a/b").is_err());
    }
}
