//! Transport-independent reading-mark operations, shared by application tools.
use crate::error::AppError;
use crate::features::catalog::probe_paper_caps;
use crate::features::import::pdf_parse::run_pdf_locate;
use crate::features::pdf_locate::{annotations, LocateMatch, LocateRequest, NormRect};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateMark {
    /// highlight (default), ask, or translate; only explicit requests create marks.
    #[serde(default = "highlight")]
    pub kind: String,
    pub quote: Option<String>,
    /// Existing layout region ID, instead of a text quote.
    pub region: Option<String>,
    /// 1-based PDF page hint.
    pub page: Option<u32>,
    #[serde(default)]
    pub match_index: usize,
    #[serde(default)]
    pub all: bool,
    #[serde(default = "yellow")]
    pub color: String,
    pub comment: Option<String>,
    pub question: Option<String>,
    /// Supplied translation text. Translation itself is a separate tool.
    pub translation: Option<String>,
}
fn highlight() -> String {
    "highlight".into()
}
fn yellow() -> String {
    "yellow".into()
}

fn directory(vault: &Path, paper: &str) -> Result<PathBuf, AppError> {
    let (directory, _) = crate::fs::resolve_paper_dir(vault, paper)?;
    // Never follow a marks symlink for either reads or writes.
    if fs::symlink_metadata(directory.join("marks")).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::message("marks directory must not be a symlink"));
    }
    Ok(directory)
}

fn mark_path(dir: &Path, id: &str) -> Result<PathBuf, AppError> {
    if id.is_empty()
        || id.eq_ignore_ascii_case("annotations")
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::message("invalid mark id"));
    }
    let path = dir.join("marks").join(format!("{id}.json"));
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::message("mark must not be a symlink"));
    }
    Ok(path)
}

fn ensure_annotations(dir: &Path) -> Result<(), AppError> {
    let path = annotations::annotations_path(dir);
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::message("annotations must not be a symlink"));
    }
    if path.exists() {
        let value: Value = serde_json::from_slice(&fs::read(path)?)?;
        if !value.is_array() {
            return Err(AppError::message("invalid annotations file"));
        }
    }
    Ok(())
}

pub fn list(vault: &Path, paper: &str) -> Result<Vec<Value>, AppError> {
    let dir = directory(vault, paper)?;
    ensure_annotations(&dir)?;
    let mut items = annotations::load(&dir)
        .into_iter()
        .map(|item| {
            json!({
                "id":item["annotation"]["id"], "kind":"highlight", "mark":item
            })
        })
        .collect::<Vec<_>>();
    let entries = match fs::read_dir(dir.join("marks")) {
        Ok(entries) => Some(entries),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    for entry in entries.into_iter().flatten() {
        let entry = entry?;
        if !entry.file_type()?.is_file() || entry.path().extension().is_none_or(|e| e != "json") {
            continue;
        }
        let id = entry
            .path()
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        if id.eq_ignore_ascii_case("annotations") {
            continue;
        }
        let path = mark_path(&dir, &id)?;
        let raw: Value = serde_json::from_slice(&fs::read(path)?)?;
        if !raw.is_object() {
            return Err(AppError::message("invalid mark object"));
        }
        items.push(json!({"id":id,"kind":raw["kind"],"mark":raw}));
    }
    items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(items)
}

pub fn get(vault: &Path, paper: &str, id: &str) -> Result<Value, AppError> {
    let dir = directory(vault, paper)?;
    let path = mark_path(&dir, id)?;
    if path.is_file() {
        let mark: Value = serde_json::from_slice(&fs::read(path)?)?;
        if !mark.is_object() {
            return Err(AppError::message("invalid mark object"));
        }
        return Ok(json!({"id":id,"kind":mark["kind"],"mark":mark}));
    }
    ensure_annotations(&dir)?;
    annotations::load(&dir)
        .into_iter()
        .find(|m| m["annotation"]["id"] == id)
        .map(|mark| json!({"id":id,"kind":"highlight","mark":mark}))
        .ok_or_else(|| AppError::domain("mark_not_found", "Mark not found"))
}

pub async fn create(vault: &Path, paper: &str, args: CreateMark) -> Result<Value, AppError> {
    if !["highlight", "ask", "translate"].contains(&args.kind.as_str()) {
        return Err(AppError::message(
            "kind must be highlight, ask or translate",
        ));
    }
    if annotations::highlight_hex(&args.color).is_none() {
        return Err(AppError::message("unknown mark color"));
    }
    if args.kind == "translate"
        && args
            .translation
            .as_deref()
            .is_none_or(|s| s.trim().is_empty())
    {
        return Err(AppError::message(
            "translate marks require translation text",
        ));
    }
    let dir = directory(vault, paper)?;
    let pdf = probe_paper_caps(&dir)
        .pdf_path
        .ok_or_else(|| AppError::domain("paper_pdf_missing", "Paper has no local PDF"))?;
    let (hits, quote) = if let Some(region) = &args.region {
        let item = crate::features::layout_index::load_region(vault, paper, region)?;
        let measured = run_pdf_locate(&pdf, &LocateRequest::measure(vec![item.page])).await?;
        let size = measured
            .pages
            .into_iter()
            .find(|p| p.page == item.page)
            .ok_or_else(|| AppError::message("layout region points outside the PDF"))?;
        let quote = args
            .quote
            .clone()
            .or(item.title)
            .unwrap_or_else(|| region.clone());
        (
            vec![LocateMatch {
                page: item.page,
                char_index: -1,
                char_count: 0,
                rects: vec![NormRect {
                    x: item.bbox.x as f32,
                    y: item.bbox.y as f32,
                    w: item.bbox.w as f32,
                    h: item.bbox.h as f32,
                }],
                page_width: size.width,
                page_height: size.height,
            }],
            quote,
        )
    } else {
        let quote = args
            .quote
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::message("quote or region is required"))?
            .to_string();
        let mut request = LocateRequest::new(&quote);
        request.page = args.page;
        let matches = run_pdf_locate(&pdf, &request).await?.matches;
        if matches.is_empty() {
            return Err(AppError::domain(
                "mark_locate_failed",
                "Quote was not found in the PDF",
            ));
        }
        let hits = if args.all {
            matches
        } else {
            vec![matches
                .into_iter()
                .nth(args.match_index)
                .ok_or_else(|| AppError::message("matchIndex is outside the located matches"))?]
        };
        (hits, quote)
    };
    let _lock = crate::features::vault::agent_config::lock(vault)?;
    let dir = directory(vault, paper)?;
    ensure_annotations(&dir)?;
    let now = annotations::now_iso();
    let mut marks = Vec::new();
    for hit in hits {
        let id = if args.kind == "highlight" {
            annotations::new_annotation_id()
        } else {
            annotations::new_mark_id()
        };
        let mark = match args.kind.as_str() {
            "highlight" => annotations::highlight_item(
                &id,
                &hit,
                &quote,
                &args.color,
                args.comment.as_deref(),
                &now,
            )?,
            "translate" => json!({"version":1,"id":id,"kind":"translate","paperPath":paper,
                "createdAt":now,"updatedAt":now,"page":hit.page,"rects":hit.rects,
                "quote":quote,"result":args.translation,"geometry":"resolved"}),
            _ => json!({"version":1,"id":id,"kind":"ask","paperPath":paper,
                "createdAt":now,"updatedAt":now,"status":"open","geometry":"resolved",
                "anchor":{"page":hit.page,"rects":hit.rects,"quote":quote,"trigger":"selection"},
                "comment":args.comment,"messages":args.question.as_ref().map(|q| vec![json!({"id":format!("{id}-q"),"role":"user","content":q,"createdAt":now})]).unwrap_or_default()}),
        };
        if args.kind != "highlight" {
            crate::fs::json_store(&mark_path(&dir, &id)?, &mark)?;
        }
        marks.push(mark);
    }
    if args.kind == "highlight" {
        annotations::append(&dir, marks.clone())?;
    }
    Ok(json!({"paperPath":paper,"kind":args.kind,"count":marks.len(),"marks":marks}))
}

pub fn update(
    vault: &Path,
    paper: &str,
    id: &str,
    comment: Option<&str>,
    color: Option<&str>,
) -> Result<Value, AppError> {
    if comment.is_none() && color.is_none() {
        return Err(AppError::message("comment or color is required"));
    }
    if color.is_some_and(|c| annotations::highlight_hex(c).is_none()) {
        return Err(AppError::message("unknown mark color"));
    }
    let _lock = crate::features::vault::agent_config::lock(vault)?;
    let dir = directory(vault, paper)?;
    let path = mark_path(&dir, id)?;
    ensure_annotations(&dir)?;
    if !annotations::update(&dir, id, comment, color)? {
        if !path.is_file() {
            return Err(AppError::domain("mark_not_found", "Mark not found"));
        }
        if color.is_some() {
            return Err(AppError::message("color only applies to highlights"));
        }
        let mut mark: Value = serde_json::from_slice(&fs::read(&path)?)?;
        if !mark.is_object() {
            return Err(AppError::message("invalid mark object"));
        }
        if let Some(comment) = comment {
            mark["comment"] = json!(comment);
        }
        mark["updatedAt"] = json!(annotations::now_iso());
        crate::fs::json_store(&path, &mark)?;
    }
    get(vault, paper, id)
}

pub fn delete(vault: &Path, paper: &str, id: &str) -> Result<(), AppError> {
    let _lock = crate::features::vault::agent_config::lock(vault)?;
    let dir = directory(vault, paper)?;
    let path = mark_path(&dir, id)?;
    ensure_annotations(&dir)?;
    if !annotations::remove(&dir, id)? {
        if !path.is_file() {
            return Err(AppError::domain("mark_not_found", "Mark not found"));
        }
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_highlights_and_legacy_marks_round_trip_without_a_cli() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("papers/demo");
        fs::create_dir_all(dir.join("marks")).unwrap();
        annotations::append(&dir, vec![json!({"annotation":{"id":"highlight-1","pageIndex":0,"type":9,"custom":{"quote":"source"}}})]).unwrap();
        crate::fs::json_store(
            &dir.join("marks/translation-1.json"),
            &json!({"id":"translation-1","kind":"translate","result":"译文"}),
        )
        .unwrap();
        assert_eq!(list(temp.path(), "papers/demo").unwrap().len(), 2);
        let changed = update(
            temp.path(),
            "papers/demo",
            "highlight-1",
            Some("note"),
            Some("green"),
        )
        .unwrap();
        assert_eq!(changed["mark"]["annotation"]["contents"], "note");
        assert_eq!(changed["mark"]["annotation"]["custom"]["quote"], "source");
        assert_eq!(
            get(temp.path(), "papers/demo", "translation-1").unwrap()["mark"]["result"],
            "译文"
        );
        delete(temp.path(), "papers/demo", "translation-1").unwrap();
        assert!(get(temp.path(), "papers/demo", "translation-1").is_err());
        assert_eq!(list(temp.path(), "papers/demo").unwrap().len(), 1);
        assert!(delete(temp.path(), "papers/demo", "../../NOTES").is_err());
        assert!(delete(temp.path(), "papers/demo", "ANNOTATIONS").is_err());
        assert_eq!(annotations::load(&dir).len(), 1);
    }

    #[test]
    fn malformed_annotations_are_never_silently_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("papers/demo/marks");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("annotations.json"), "incomplete JSON").unwrap();
        assert!(update(temp.path(), "papers/demo", "a", Some("note"), None).is_err());
        assert_eq!(
            fs::read_to_string(dir.join("annotations.json")).unwrap(),
            "incomplete JSON"
        );
    }

    #[test]
    fn reading_one_mark_does_not_require_other_marks_to_be_valid() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("papers/demo/marks");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("broken.json"), "broken").unwrap();
        fs::write(
            dir.join("valid.json"),
            r#"{"id":"valid","kind":"translate","result":"saved"}"#,
        )
        .unwrap();
        assert_eq!(
            get(temp.path(), "papers/demo", "valid").unwrap()["mark"]["result"],
            "saved"
        );
    }
}
