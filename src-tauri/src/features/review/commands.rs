//! `review_*` IPC shells. Heavy work runs in `run_blocking`; bodies live in
//! `edda_core::features::review`.

use super::ReviewEditCache;
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use edda_core::features::review::{
    ops, CommentAction, DiffHunk, ReviewCommentInput, ReviewState, ReviewUnitSummary, ReviewView,
};

/// The panel's view after an operation that may have changed the baseline:
/// the baseline text goes with it.
fn with_baseline(state: ReviewState) -> ReviewView {
    ops::view(state, None)
}

/// The panel's view after an operation that left the baseline alone: the
/// panel keeps the text it has.
fn without_baseline(state: ReviewState) -> ReviewView {
    let hash = state
        .revisions
        .iter()
        .find(|r| r.id == state.baseline_id)
        .map(|r| r.hash.clone());
    ops::view(state, hash.as_deref())
}
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn review_create(
    vault_path: String,
    title: String,
) -> Result<ApiResult<ReviewUnitSummary>, String> {
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| edda_core::features::review::create_unit(&vault, &title))
        {
            Ok(unit) => ApiResult::ok(unit),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_import(
    vault_path: String,
    file_paths: Vec<String>,
) -> Result<ApiResult<Vec<ReviewUnitSummary>>, String> {
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| edda_core::features::review::import_files(&vault, &file_paths))
        {
            Ok(units) => ApiResult::ok(units),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_parse_pdf(
    cache: State<'_, ReviewEditCache>,
    vault_path: String,
    review_id: String,
) -> Result<ApiResult<ReviewView>, String> {
    let cache = cache.inner().clone();
    let res: Result<(ReviewState, String), AppError> = async {
        let vault = crate::core::fs::resolve_vault(&vault_path)?;
        let dir = edda_core::features::review::checked_unit_dir_pub(&vault, &review_id)?;
        let state = edda_core::features::review::load_state(&dir)?;
        let pdf_name =
            edda_core::features::review::find_unit_pdf_name(&dir, state.pdf_file.as_deref())
                .ok_or_else(|| AppError::message("no PDF file in this review unit"))?;
        let pdf_path = dir.join(pdf_name);
        let markdown = edda_core::features::paper::analyze::parse::parse_pdf_to_dir(
            &pdf_path,
            &dir,
            edda_core::features::review::MANUSCRIPT_FILE,
            None,
        )
        .await?;
        let vault_clone = vault.clone();
        let id_clone = review_id.clone();
        let md_clone = markdown.clone();
        let updated = tokio::task::spawn_blocking(move || {
            edda_core::features::review::apply_parsed_pdf_body(&vault_clone, &id_clone, &md_clone)
        })
        .await
        .map_err(|e| AppError::message(format!("apply parsed PDF join failed: {e}")))??;
        Ok((updated, markdown))
    }
    .await;
    Ok(match res {
        Ok((state, markdown)) => {
            cache.set(&vault_path, &review_id, markdown);
            ApiResult::ok(with_baseline(state))
        }
        Err(e) => map_err(e),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn review_apply_change(
    cache: State<'_, ReviewEditCache>,
    vault_path: String,
    review_id: String,
    next_baseline: String,
    next_manuscript: Option<String>,
    reason: Option<String>,
) -> Result<ApiResult<ReviewView>, String> {
    let cache = cache.inner().clone();
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path).and_then(|vault| {
            edda_core::features::review::ops::apply_tracked_change(
                &vault,
                &review_id,
                &next_baseline,
                next_manuscript.as_deref(),
                reason.as_deref(),
            )
        }) {
            Ok((state, manuscript)) => {
                cache.set(&vault_path, &review_id, manuscript);
                ApiResult::ok(with_baseline(state))
            }
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_list(vault_path: String) -> Result<ApiResult<Vec<ReviewUnitSummary>>, String> {
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| edda_core::features::review::list_units(&vault))
        {
            Ok(units) => ApiResult::ok(units),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_open(
    cache: State<'_, ReviewEditCache>,
    vault_path: String,
    review_id: String,
    // Hash of the baseline revision the panel already holds; its text is
    // then not sent again.
    known_baseline: Option<String>,
) -> Result<ApiResult<ReviewView>, String> {
    let cache = cache.inner().clone();
    Ok(run_blocking(move || {
        let previous = cache.get(&vault_path, &review_id);
        let result = crate::core::fs::resolve_vault(&vault_path).and_then(|vault| {
            edda_core::features::review::store::open_unit_with_previous(
                &vault,
                &review_id,
                previous.as_deref(),
            )
        });
        match result {
            Ok((state, manuscript)) => {
                cache.set(&vault_path, &review_id, manuscript);
                ApiResult::ok(ops::view(state, known_baseline.as_deref()))
            }
            Err(e) => map_err(e),
        }
    })
    .await)
}

/// `review.json`'s current stamp (see `ReviewView::stamp`): the panel asks
/// this before reloading on a watcher event and skips the reload when it
/// matches, so its own writes echoing back cost no full read.
#[tauri::command]
#[specta::specta]
pub async fn review_state_stamp(
    vault_path: String,
    review_id: String,
) -> Result<ApiResult<String>, String> {
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| edda_core::features::review::checked_unit_dir_pub(&vault, &review_id))
        {
            Ok(dir) => ApiResult::ok(edda_core::features::review::store::file_stamp(
                &edda_core::features::review::state_path(&dir),
            )),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_rename(
    vault_path: String,
    review_id: String,
    title: String,
) -> Result<ApiResult<ReviewUnitSummary>, String> {
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| edda_core::features::review::rename_unit(&vault, &review_id, &title))
        {
            Ok(unit) => ApiResult::ok(unit),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_comment_add(
    vault_path: String,
    review_id: String,
    input: ReviewCommentInput,
) -> Result<ApiResult<ReviewView>, String> {
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path).and_then(|vault| {
            edda_core::features::review::ops::add_comment(&vault, &review_id, &input)
        }) {
            Ok(state) => ApiResult::ok(without_baseline(state)),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_comment_update(
    vault_path: String,
    review_id: String,
    comment_id: String,
    action: CommentAction,
    body: Option<String>,
    expected_updated_at: Option<String>,
    // A reply in the thread: `edit` the author's own, `delete` any.
    reply_id: Option<String>,
) -> Result<ApiResult<ReviewView>, String> {
    use edda_core::features::review::ops;
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path).and_then(|vault| match reply_id {
            Some(reply_id) => ops::update_reply_as(
                &vault,
                &review_id,
                &comment_id,
                &reply_id,
                action,
                body.as_deref(),
                "author",
                None,
            ),
            None => ops::update_comment(
                &vault,
                &review_id,
                &comment_id,
                action,
                body.as_deref(),
                expected_updated_at.as_deref(),
            ),
        }) {
            Ok(state) => ApiResult::ok(without_baseline(state)),
            Err(e) => map_err(e),
        }
    })
    .await)
}

/// The review editor's save: write the manuscript and record the edit under
/// the unit's lock (see `ops::save_manuscript`). Fails with
/// `manuscript_changed` when the file changed on disk since `last_saved`.
#[tauri::command]
#[specta::specta]
pub async fn review_save_manuscript(
    cache: State<'_, ReviewEditCache>,
    vault_path: String,
    review_id: String,
    markdown: String,
    last_saved: String,
    // Comment ranges the editor moved with the author's edits (Word-style).
    anchors: Option<Vec<edda_core::features::review::CommentAnchor>>,
) -> Result<ApiResult<ReviewView>, String> {
    let cache = cache.inner().clone();
    Ok(run_blocking(move || {
        let prev = cache.get(&vault_path, &review_id);
        let result = crate::core::fs::resolve_vault(&vault_path).and_then(|vault| {
            edda_core::features::review::ops::save_manuscript(
                &vault,
                &review_id,
                &markdown,
                &last_saved,
                prev.as_deref(),
                anchors.as_deref().unwrap_or_default(),
            )
        });
        match result {
            Ok((state, _)) => {
                cache.set(&vault_path, &review_id, markdown);
                ApiResult::ok(without_baseline(state))
            }
            Err(e) => map_err(e),
        }
    })
    .await)
}

/// Record one manuscript save. `kind`: `edit` (renderer autosave) or
/// `external` (disk watcher reseed). The span comes from the Host-side cache,
/// so duplicate/echo calls are no-ops.
#[tauri::command]
#[specta::specta]
pub async fn review_record_edit(
    cache: State<'_, ReviewEditCache>,
    vault_path: String,
    review_id: String,
    kind: String,
    // Comment ranges the editor moved with the author's edits (Word-style).
    anchors: Option<Vec<edda_core::features::review::CommentAnchor>>,
) -> Result<ApiResult<ReviewView>, String> {
    let cache = cache.inner().clone();
    Ok(run_blocking(move || {
        let prev = cache.get(&vault_path, &review_id);
        let result = crate::core::fs::resolve_vault(&vault_path).and_then(|vault| {
            edda_core::features::review::ops::record_edit_with_anchors(
                &vault,
                &review_id,
                prev.as_deref(),
                &kind,
                anchors.as_deref().unwrap_or_default(),
            )
        });
        match result {
            Ok((state, recorded)) => {
                if recorded || prev.is_none() {
                    if let Ok(vault) = crate::core::fs::resolve_vault(&vault_path) {
                        let dir =
                            edda_core::features::review::reviews_root(&vault).join(&review_id);
                        if let Ok(text) = edda_core::features::review::read_manuscript(&dir) {
                            cache.set(&vault_path, &review_id, text);
                        }
                    }
                }
                ApiResult::ok(if kind == "untracked" {
                    with_baseline(state)
                } else {
                    without_baseline(state)
                })
            }
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_checkpoint(
    vault_path: String,
    review_id: String,
    reason: Option<String>,
) -> Result<ApiResult<ReviewView>, String> {
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path).and_then(|vault| {
            edda_core::features::review::ops::checkpoint(&vault, &review_id, reason.as_deref())
        }) {
            Ok(state) => ApiResult::ok(with_baseline(state)),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffResult {
    pub hunks: Vec<DiffHunk>,
    /// Baseline snapshot creation time (display label).
    pub baseline_at: String,
}

#[tauri::command]
#[specta::specta]
pub async fn review_diff(
    vault_path: String,
    review_id: String,
) -> Result<ApiResult<ReviewDiffResult>, String> {
    Ok(run_blocking(move || {
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| edda_core::features::review::ops::diff_baseline(&vault, &review_id))
        {
            Ok((hunks, baseline_at)) => ApiResult::ok(ReviewDiffResult { hunks, baseline_at }),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn review_export(
    vault_path: String,
    review_id: String,
    dest_dir: String,
) -> Result<ApiResult<String>, String> {
    Ok(run_blocking(move || {
        let dest = std::path::PathBuf::from(dest_dir.trim());
        if !dest.is_dir() {
            return map_err(AppError::message("choose an existing folder"));
        }
        match crate::core::fs::resolve_vault(&vault_path)
            .and_then(|vault| edda_core::features::review::ops::export(&vault, &review_id, &dest))
        {
            Ok(out) => ApiResult::ok(out),
            Err(e) => map_err(e),
        }
    })
    .await)
}
