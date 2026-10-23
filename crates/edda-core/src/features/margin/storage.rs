use super::{event, now};
use crate::{
    error::AppError,
    features::review::{model::*, store},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

fn documents(root: &Path) -> PathBuf {
    root.join(".margin").join("documents")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    #[serde(flatten)]
    pub state: ReviewState,
    pub agents: Vec<String>,
    pub baseline_included: bool,
    pub stamp: String,
    pub head_id: String,
    pub manuscript: String,
    pub sequence: i64,
    /// Receipt metadata identifies the original commit even when a retry
    /// returns a newer document snapshot. Never replay an obsolete UI view.
    pub acknowledged_sequence: i64,
    pub acknowledged_head: String,
    pub command_result: Option<serde_json::Value>,
}

pub(super) fn dir(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::message("invalid document id"));
    }
    let path = documents(root).join(id);
    // Canonical containment also rejects directory junctions / symlinks.
    let ancestor = path
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| AppError::message("workspace does not exist"))?;
    if !fs::canonicalize(ancestor)?.starts_with(fs::canonicalize(root)?) {
        return Err(AppError::message("document outside workspace"));
    }
    Ok(path)
}

pub(super) fn connect(root: &Path, id: &str) -> Result<Connection, AppError> {
    try_connect(root, id)?.ok_or_else(|| AppError::message("document initialization is incomplete"))
}

fn try_connect(root: &Path, id: &str) -> Result<Option<Connection>, AppError> {
    let path = dir(root, id)?.join("review.sqlite");
    if !fs::canonicalize(&path)?.starts_with(fs::canonicalize(root)?) {
        return Err(AppError::message("database outside workspace"));
    }
    let mut conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 {
        return Ok(None);
    }
    if ![1, 2].contains(&version) {
        return Err(AppError::message("unsupported Margin database version"));
    }
    conn.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    )?;
    migrate(&mut conn)?;
    Ok(Some(conn))
}

fn migrate(conn: &mut Connection) -> Result<(), AppError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 1 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(include_str!("schema-v2.sql"))?;
        tx.commit()?;
    }
    Ok(())
}

pub(super) fn revision(
    conn: &Connection,
    body: &str,
    parent: Option<&str>,
    kind: &str,
) -> Result<String, AppError> {
    let id = new_id("rev");
    conn.execute(
        "INSERT INTO revisions VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, parent, body, store::sha256_hex(body), now(), kind],
    )?;
    Ok(id)
}

pub fn read_revision(root: &Path, id: &str, revision_id: &str) -> Result<String, AppError> {
    body(&connect(root, id)?, revision_id)
}

pub(super) fn body(conn: &Connection, id: &str) -> Result<String, AppError> {
    let (body, hash): (String, String) =
        conn.query_row("SELECT body,hash FROM revisions WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    if store::sha256_hex(&body) != hash {
        return Err(AppError::domain(
            "revision_corrupt",
            "Revision checksum mismatch",
        ));
    }
    Ok(body)
}

pub(super) fn load(conn: &Connection) -> Result<View, AppError> {
    let (mut state, head, baseline, seq): (ReviewState, String, String, i64) = conn.query_row(
        "SELECT metadata,head,baseline,sequence FROM document",
        [],
        |r| {
            let json: String = r.get(0)?;
            let state = serde_json::from_str(&json).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            Ok((state, r.get(1)?, r.get(2)?, r.get(3)?))
        },
    )?;
    state.baseline_id = baseline.clone();
    state.baseline_text = body(conn, &baseline)?;
    let manuscript = body(conn, &head)?;
    state.manuscript_hash = Some(store::sha256_hex(&manuscript));
    // The editor needs only the two comparison snapshots; full history remains
    // immutable in SQLite and is read explicitly, not resent after every keypress.
    let mut stmt = conn.prepare("SELECT id,parent,hash,created_at,kind FROM revisions WHERE id IN (SELECT head FROM document UNION SELECT baseline FROM document) ORDER BY rowid")?;
    state.revisions = stmt
        .query_map([], |r| {
            Ok(Revision {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                hash: r.get(2)?,
                created_at: r.get(3)?,
                reason: r.get(4)?,
                file: String::new(),
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare("SELECT payload FROM threads ORDER BY rowid")?;
    state.comments = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|s| Ok(serde_json::from_str(&s?)?))
        .collect::<Result<_, AppError>>()?;
    let mut stmt = conn.prepare("SELECT payload FROM events WHERE sequence > (SELECT round_start FROM document) ORDER BY sequence")?;
    state.events = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|s| Ok(serde_json::from_str(&s?)?))
        .collect::<Result<_, AppError>>()?;
    let agents = conn.prepare("SELECT agent FROM (SELECT rowid AS ordering,agent FROM proposals WHERE agent IS NOT NULL UNION ALL SELECT sequence, json_extract(payload,'$.agent') FROM events WHERE json_extract(payload,'$.agent') IS NOT NULL) GROUP BY agent ORDER BY min(ordering)")?
        .query_map([], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    Ok(View {
        state,
        agents,
        baseline_included: true,
        stamp: seq.to_string(),
        acknowledged_sequence: seq,
        acknowledged_head: head.clone(),
        command_result: None,
        head_id: head,
        manuscript,
        sequence: seq,
    })
}

pub fn open(root: &Path, id: &str) -> Result<View, AppError> {
    let mut conn = connect(root, id)?;
    let tx = conn.transaction()?;
    let view = load(&tx)?;
    tx.commit()?;
    Ok(view)
}

pub fn sequence(root: &Path, id: &str) -> Result<i64, AppError> {
    Ok(connect(root, id)?.query_row("SELECT sequence FROM document", [], |r| r.get(0))?)
}

pub(super) fn append(conn: &Connection, view: &mut View, e: ReviewEvent) -> Result<(), AppError> {
    view.sequence += 1;
    conn.execute(
        "INSERT INTO events VALUES (?1,?2,?3)",
        params![view.sequence, e.id, serde_json::to_string(&e)?],
    )?;
    view.state.events.push(e);
    view.stamp = view.sequence.to_string();
    Ok(())
}

pub(super) fn persist(conn: &Connection, view: &View) -> Result<(), AppError> {
    super::operations::comparison(conn, &view.state.baseline_id, &view.head_id)?;
    // Metadata deliberately excludes history, snapshots and independently stored threads.
    let mut meta = view.state.clone();
    meta.events.clear();
    meta.comments.clear();
    meta.revisions.clear();
    meta.baseline_text.clear();
    conn.execute(
        "UPDATE document SET title=?1,head=?2,baseline=?3,sequence=?4,metadata=?5",
        params![
            meta.title,
            view.head_id,
            view.state.baseline_id,
            view.sequence,
            serde_json::to_string(&meta)?
        ],
    )?;
    for c in &view.state.comments {
        conn.execute("INSERT INTO threads VALUES (?1,?2,?2,?3) ON CONFLICT(id) DO UPDATE SET anchor_revision=excluded.anchor_revision,payload=excluded.payload",
            params![c.id,view.head_id,serde_json::to_string(c)?])?;
    }
    Ok(())
}

fn initial(
    root: &Path,
    id: &str,
    title: &str,
    text: &str,
    legacy: Option<(ReviewState, &Path)>,
) -> Result<ReviewUnitSummary, AppError> {
    let dir = dir(root, id)?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("review.sqlite");
    if path.exists() && !fs::canonicalize(&path)?.starts_with(fs::canonicalize(root)?) {
        return Err(AppError::message("database outside workspace"));
    }
    let mut conn = Connection::open(&path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    )?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > 2 {
        return Err(AppError::message("unsupported Margin database version"));
    }
    conn.execute_batch(include_str!("schema.sql"))?;
    migrate(&mut conn)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if tx
        .query_row("SELECT id FROM document", [], |r| r.get::<_, String>(0))
        .optional()?
        .is_some()
    {
        tx.commit()?;
        return summary(root, &load(&conn)?);
    }
    let baseline_text = legacy
        .as_ref()
        .map_or(text, |(s, _)| s.baseline_text.as_str());
    let baseline = revision(&tx, baseline_text, None, "import-baseline")?;
    let head = if baseline_text == text {
        baseline.clone()
    } else {
        revision(&tx, text, Some(&baseline), "import-head")?
    };
    let source = legacy
        .as_ref()
        .map(|(_, p)| p.to_string_lossy().to_string());
    let has_pdf = dir.join("manuscript.pdf").is_file();
    let mut state = legacy.map(|(s, _)| s).unwrap_or(ReviewState {
        format: "margin-review".into(),
        version: 2,
        id: id.into(),
        title: title.into(),
        authors: vec![],
        year: None,
        has_pdf: false,
        pdf_file: None,
        body_parsed: !has_pdf,
        created_at: now(),
        baseline_id: baseline.clone(),
        manuscript_hash: None,
        baseline_text: String::new(),
        revisions: vec![],
        comments: vec![],
        events: vec![],
        stamp: String::new(),
    });
    if has_pdf {
        state.has_pdf = true;
        state.pdf_file = Some("manuscript.pdf".into());
    }
    // Retain every available old snapshot without reusing / rewriting its identifier.
    if let Some(source) = source.as_ref() {
        for r in &state.revisions {
            let path = Path::new(source).join(&r.file);
            if !fs::canonicalize(&path)?.starts_with(fs::canonicalize(source)?) {
                return Err(AppError::message("legacy snapshot outside review"));
            }
            let revision = revision(
                &tx,
                &fs::read_to_string(path)?,
                Some(&baseline),
                &format!("legacy:{}", r.id),
            )?;
            tx.execute(
                "INSERT INTO legacy_revisions VALUES (?1,?2)",
                params![r.id, revision],
            )?;
        }
    }
    let legacy_baseline = state.baseline_id.clone();
    state.format = "margin-review".into();
    state.version = 2;
    state.baseline_id = baseline.clone();
    let mut view = View {
        state,
        agents: vec![],
        baseline_included: true,
        stamp: "0".into(),
        acknowledged_sequence: 0,
        acknowledged_head: head.clone(),
        command_result: None,
        head_id: head,
        manuscript: text.into(),
        sequence: 0,
    };
    let old_events = std::mem::take(&mut view.state.events);
    tx.execute(
        "INSERT INTO document VALUES (?1,?2,?3,?4,?5,0,0,?6,?7)",
        params![
            id,
            title,
            view.state.created_at,
            view.head_id,
            baseline,
            serde_json::to_string(&view.state)?,
            source
        ],
    )?;
    let active_checkpoint = old_events.iter().position(|e| {
        e.kind == "checkpoint" && e.revision_id.as_deref() == Some(legacy_baseline.as_str())
    });
    for (index, e) in old_events.into_iter().enumerate() {
        append(&tx, &mut view, e)?;
        if Some(index) == active_checkpoint {
            tx.execute("UPDATE document SET round_start=?1", [view.sequence])?;
        }
    }
    append(&tx, &mut view, event("created"))?;
    persist(&tx, &view)?;
    tx.commit()?;
    summary(root, &load(&conn)?)
}

pub(super) fn summary(root: &Path, view: &View) -> Result<ReviewUnitSummary, AppError> {
    let dir = dir(root, &view.state.id)?;
    let mut summary = view.state.summary(
        dir.to_string_lossy().into(),
        dir.join("manuscript.md").to_string_lossy().into(),
        view.state
            .pdf_file
            .as_ref()
            .map(|f| dir.join(f).to_string_lossy().into()),
    );
    // A new round may have no visible events, but its summary must not jump
    // back to the document's creation time. Event rows are immutable.
    if let Some(updated) = connect(root, &view.state.id)?
        .query_row(
            "SELECT json_extract(payload,'$.createdAt') FROM events WHERE sequence=?1",
            [view.sequence],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        summary.updated_at = updated;
    }
    Ok(summary)
}

pub fn create(root: &Path, title: &str) -> Result<ReviewUnitSummary, AppError> {
    let title = if title.trim().is_empty() {
        "Untitled"
    } else {
        title.trim()
    };
    initial(root, &new_id("doc"), title, &format!("# {title}\n"), None)
}

pub fn list(root: &Path) -> Result<Vec<ReviewUnitSummary>, AppError> {
    // Read-only migration. Existing legacy files are never repaired or saved.
    let legacy = root.join("reviews");
    if legacy.is_dir() {
        for entry in fs::read_dir(legacy)? {
            let path = entry?.path();
            if !path.join(STATE_FILE).is_file() {
                continue;
            }
            let Some(legacy_id) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let target = dir(root, legacy_id)?;
            if target.join("review.sqlite").is_file() {
                if let Some(conn) = try_connect(root, legacy_id)? {
                    if conn
                        .query_row("SELECT id FROM document", [], |r| r.get::<_, String>(0))
                        .optional()?
                        .is_some()
                    {
                        // Once imported, the old files are not a second authority.
                        // Even later removal/corruption of an old snapshot must not
                        // prevent opening the healthy new document.
                        load(&conn)?;
                        continue;
                    }
                }
            }
            if !fs::canonicalize(&path)?.starts_with(fs::canonicalize(root)?) {
                return Err(AppError::message("legacy review outside workspace"));
            }
            // Validate paths before the legacy loader follows snapshot/PDF paths.
            let raw: ReviewState =
                serde_json::from_str(&fs::read_to_string(path.join(STATE_FILE))?)?;
            if path.file_name().and_then(|s| s.to_str()) != Some(raw.id.as_str()) {
                return Err(AppError::message(
                    "legacy document id does not match its directory",
                ));
            }
            for relative in raw
                .revisions
                .iter()
                .map(|r| r.file.as_str())
                .chain(raw.pdf_file.as_deref())
            {
                let candidate = path.join(relative);
                if !fs::canonicalize(candidate)?.starts_with(fs::canonicalize(&path)?) {
                    return Err(AppError::message("legacy resource outside review"));
                }
            }
            let state = store::load_state(&path)?;
            let target = dir(root, &state.id)?;
            fs::create_dir_all(&target)?;
            copy_assets(&path, &target)?;
            initial(
                root,
                &state.id,
                &state.title,
                &fs::read_to_string(path.join(MANUSCRIPT_FILE))?,
                Some((state.clone(), &path)),
            )?;
        }
    }
    let mut units = Vec::new();
    let documents = documents(root);
    if documents.is_dir() {
        for entry in fs::read_dir(documents)? {
            let path = entry?.path();
            if !path.join("review.sqlite").is_file() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some(conn) = try_connect(root, id)? else {
                continue;
            };
            if conn
                .query_row("SELECT id FROM document", [], |r| r.get::<_, String>(0))
                .optional()?
                .is_some()
            {
                units.push(summary(root, &open(root, id)?)?);
            }
        }
    }
    Ok(units)
}

fn copy_assets(source: &Path, target: &Path) -> Result<(), AppError> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_symlink()
            || !fs::canonicalize(&path)?.starts_with(fs::canonicalize(source)?)
        {
            return Err(AppError::message(
                "linked legacy assets require explicit import",
            ));
        }
        let name = entry.file_name();
        if name == "assets" && path.is_dir() {
            copy_asset_tree(&path, &target.join(&name))?;
        } else if path.is_file()
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
        {
            fs::copy(path, target.join(name))?;
        }
    }
    Ok(())
}

fn copy_asset_tree(source: &Path, target: &Path) -> Result<(), AppError> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_symlink()
            || !fs::canonicalize(&path)?.starts_with(fs::canonicalize(source)?)
        {
            return Err(AppError::message("linked asset outside archive"));
        }
        if path.is_dir() {
            copy_asset_tree(&path, &target.join(entry.file_name()))?;
        } else if path.is_file() {
            fs::copy(path, target.join(entry.file_name()))?;
        }
    }
    Ok(())
}

pub fn import_files(root: &Path, files: &[String]) -> Result<Vec<ReviewUnitSummary>, AppError> {
    let mut out = Vec::new();
    for name in files {
        let file = Path::new(name);
        let ext = file
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "sqlite" {
            out.push(import_archive(root, file)?);
            continue;
        }
        if !["md", "markdown", "txt", "tex", "pdf"].contains(&ext.as_str()) {
            return Err(AppError::message("unsupported manuscript format"));
        }
        let pdf = ext == "pdf";
        let text = if pdf {
            String::new()
        } else {
            fs::read_to_string(file)?
        };
        let title = store::extract_markdown_heading_title(&text).unwrap_or_else(|| {
            file.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        });
        let id = new_id("doc");
        let dir = dir(root, &id)?;
        fs::create_dir_all(&dir)?;
        if pdf {
            fs::copy(file, dir.join("manuscript.pdf"))?;
        }
        let unit = initial(root, &id, &title, &text, None)?;
        out.push(unit);
    }
    Ok(out)
}

fn import_archive(root: &Path, file: &Path) -> Result<ReviewUnitSummary, AppError> {
    let source = Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = source.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let integrity: String = source.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if ![1, 2].contains(&version) || integrity != "ok" {
        return Err(AppError::message("invalid Margin archive"));
    }
    if source
        .prepare("PRAGMA foreign_key_check")?
        .query([])?
        .next()?
        .is_some()
    {
        return Err(AppError::message("archive has broken references"));
    }
    let view = load(&source)?;
    if view.state.format != "margin-review" || view.state.version != 2 {
        return Err(AppError::message("not a Margin archive"));
    }
    let id = new_id("doc");
    let target = dir(root, &id)?;
    fs::create_dir_all(&target)?;
    let staging = target.join("importing.sqlite");
    source.execute("VACUUM INTO ?1", [staging.to_string_lossy().as_ref()])?;
    let mut conn = Connection::open(&staging)?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
    migrate(&mut conn)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut v = load(&tx)?;
    v.state.id = id.clone();
    tx.execute(
        "UPDATE document SET id=?1,source=?2",
        params![id, file.to_string_lossy().as_ref()],
    )?;
    if let Some(name) = v.state.pdf_file.as_ref() {
        let source_dir = file
            .parent()
            .ok_or_else(|| AppError::message("missing archive directory"))?;
        if Path::new(name).components().count() != 1 || !source_dir.join(name).is_file() {
            return Err(AppError::message("missing PDF archive attachment"));
        }
    }
    copy_assets(file.parent().unwrap_or(Path::new(".")), &target)?;
    append(&tx, &mut v, event("archive-imported"))?;
    persist(&tx, &v)?;
    tx.commit()?;
    drop(conn);
    fs::rename(staging, target.join("review.sqlite"))?;
    summary(root, &open(root, &id)?)
}

pub fn export(root: &Path, id: &str, dest: &Path) -> Result<String, AppError> {
    if !dest.is_dir() {
        return Err(AppError::message("choose an existing export folder"));
    }
    let source = dir(root, id)?;
    let output = dest.join(new_id("margin-export"));
    fs::create_dir(&output)?;
    let conn = connect(root, id)?;
    // VACUUM INTO is a consistent standalone snapshot, including WAL contents.
    conn.execute(
        "VACUUM INTO ?1",
        [output.join("review.sqlite").to_string_lossy().as_ref()],
    )?;
    let exported = Connection::open(output.join("review.sqlite"))?;
    // The portable archive does not disclose the local source workspace path.
    exported.execute("UPDATE document SET source=NULL", [])?;
    let view = load(&exported)?;
    fs::write(output.join("manuscript.md"), &view.manuscript)?;
    fs::write(output.join("baseline.md"), &view.state.baseline_text)?;
    fs::write(
        output.join(EXPORT_REVIEW_MD),
        crate::features::review::review_md::render(&view.state, &view.manuscript),
    )?;
    fs::write(
        output.join("review.json"),
        serde_json::to_string_pretty(&view)?,
    )?;
    copy_assets(&source, &output)?;
    // Release the snapshot connection before handing the directory to the UI.
    conn.flush_prepared_statement_cache();
    Ok(output.to_string_lossy().into())
}
