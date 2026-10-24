use super::manage::*;
use crate::features::catalog::{
    self,
    papers::{self, PaperMetaPatch, PaperRecord},
};
use crate::features::import::NoteShellMode;
use std::fs;

#[test]
fn legacy_import_targets_normalize_to_flat_storage_without_accepting_traversal() {
    for parent in ["papers", "papers/vit", "papers\\vision\\vit", ""] {
        assert_eq!(super::normalize_parent_dir(parent).unwrap(), "papers");
    }
    assert!(super::normalize_parent_dir("papers/../notes").is_err());
    assert!(super::normalize_parent_dir("notes").is_err());
}

#[tokio::test]
async fn creates_metadata_only_and_validates_before_writing() {
    let temp = tempfile::tempdir().unwrap();
    let vault = temp.path();
    for patch in [
        PaperMetaPatch::default(),
        PaperMetaPatch {
            title: Some("Example".into()),
            year: Some("oops".into()),
            ..Default::default()
        },
    ] {
        assert!(create_manual(vault, &patch, NoteShellMode::Standard)
            .await
            .is_err());
    }
    let patch = PaperMetaPatch {
        title: Some("  My paper  ".into()),
        authors: Some(vec!["Ada".into()]),
        year: Some("2026".into()),
        doi: Some("10.1000/manual".into()),
        ..Default::default()
    };
    let row = create_manual(vault, &patch, NoteShellMode::Standard)
        .await
        .unwrap();
    assert_eq!(row.title, "My paper");
    assert_eq!(row.path.split('/').count(), 2);
    assert_eq!(row.meta_source.as_deref(), Some("manual"));
    assert!(vault.join(&row.path).join("NOTES.md").is_file());
    assert!(!catalog::has_local_pdf(&vault.join(&row.path)));
    assert!(create_manual(vault, &patch, NoteShellMode::Standard)
        .await
        .is_err());
    assert_eq!(papers::list_all(vault).unwrap().len(), 1);
}

#[test]
fn attaches_to_selected_record_and_replaces_with_preserved_backup() {
    let temp = tempfile::tempdir().unwrap();
    let vault = temp.path();
    let dir = vault.join("papers/manual");
    fs::create_dir_all(&dir).unwrap();
    let mut row =
        PaperRecord::local_pdf("manual".into(), "Keep this title".into()).at_path("papers/manual");
    row.body_source = Some("pdf".into());
    papers::upsert_paper(vault, &row).unwrap();
    fs::write(dir.join("NOTES.md"), "My hand-written notes").unwrap();
    let source = vault.join("input.pdf");
    fs::write(&source, b"%PDF-1.7\nfirst document").unwrap();
    assert!(attach_pdf(vault, &row.path, &source, false)
        .unwrap()
        .backup_path
        .is_none());
    assert_eq!(papers::list_all(vault).unwrap().len(), 1);
    fs::create_dir_all(dir.join("marks")).unwrap();
    fs::create_dir_all(dir.join("source")).unwrap();
    fs::write(dir.join("marks/annotations.json"), "old marks").unwrap();
    fs::write(dir.join("source/layout.json"), "old layout").unwrap();
    fs::write(dir.join("PAPER.md"), "old parsed text").unwrap();
    fs::write(&source, b"%PDF-1.7\nreplacement").unwrap();
    assert!(attach_pdf(vault, &row.path, &source, false).is_err());
    let result = attach_pdf(vault, &row.path, &source, true).unwrap();
    let backup = vault.join(result.backup_path.unwrap());
    assert_eq!(
        fs::read(backup.join("manual.pdf")).unwrap(),
        b"%PDF-1.7\nfirst document"
    );
    assert!(backup.join("marks/annotations.json").is_file());
    assert!(backup.join("source/layout.json").is_file());
    assert!(!dir.join("marks").exists());
    assert!(!dir.join("PAPER.md").exists());
    assert_eq!(
        fs::read(dir.join("manual.pdf")).unwrap(),
        b"%PDF-1.7\nreplacement"
    );
    assert_eq!(
        fs::read_to_string(dir.join("NOTES.md")).unwrap(),
        "My hand-written notes"
    );
    assert_eq!(
        papers::get_by_path(vault, &row.path)
            .unwrap()
            .unwrap()
            .title,
        "Keep this title"
    );
    fs::write(&source, "not a PDF").unwrap();
    assert!(attach_pdf(vault, &row.path, &source, true).is_err());
    assert_eq!(
        fs::read(dir.join("manual.pdf")).unwrap(),
        b"%PDF-1.7\nreplacement"
    );
}

#[test]
fn failed_catalog_commit_restores_original_pdf_and_derived_files() {
    let temp = tempfile::tempdir().unwrap();
    let vault = temp.path();
    let dir = vault.join("papers/rollback");
    fs::create_dir_all(dir.join("marks")).unwrap();
    let row =
        PaperRecord::local_pdf("rollback".into(), "Original".into()).at_path("papers/rollback");
    papers::upsert_paper(vault, &row).unwrap();
    fs::write(dir.join("rollback.pdf"), b"%PDF-1.7\noriginal").unwrap();
    fs::write(dir.join("PAPER.md"), "original text").unwrap();
    fs::write(dir.join("marks/annotations.json"), "original annotations").unwrap();
    let source = vault.join("new.pdf");
    fs::write(&source, b"%PDF-1.7\nnew").unwrap();
    catalog::with_catalog(vault, |conn| {
        conn.execute_batch("CREATE TRIGGER reject_change BEFORE UPDATE ON papers BEGIN SELECT RAISE(ABORT, 'test failure'); END;")?;
        Ok(())
    }).unwrap();
    assert!(attach_pdf(vault, &row.path, &source, true).is_err());
    assert_eq!(
        fs::read(dir.join("rollback.pdf")).unwrap(),
        b"%PDF-1.7\noriginal"
    );
    assert_eq!(
        fs::read_to_string(dir.join("PAPER.md")).unwrap(),
        "original text"
    );
    assert_eq!(
        fs::read_to_string(dir.join("marks/annotations.json")).unwrap(),
        "original annotations"
    );
}

#[cfg(unix)]
#[test]
fn replacing_linked_pdf_preserves_readable_original_without_modifying_external_file() {
    let temp = tempfile::tempdir().unwrap();
    let vault = temp.path();
    let dir = vault.join("papers/linked");
    fs::create_dir_all(&dir).unwrap();
    let row = PaperRecord::local_pdf("linked".into(), "Linked".into()).at_path("papers/linked");
    papers::upsert_paper(vault, &row).unwrap();
    let external = vault.join("external.pdf");
    fs::write(&external, b"%PDF-1.7\nexternal").unwrap();
    std::os::unix::fs::symlink("../../external.pdf", dir.join("linked.pdf")).unwrap();
    let source = vault.join("new.pdf");
    fs::write(&source, b"%PDF-1.7\nnew").unwrap();
    let result = attach_pdf(vault, &row.path, &source, true).unwrap();
    assert_eq!(fs::read(external).unwrap(), b"%PDF-1.7\nexternal");
    assert_eq!(
        fs::read(vault.join(result.backup_path.unwrap()).join("linked.pdf")).unwrap(),
        b"%PDF-1.7\nexternal"
    );
    assert_eq!(fs::read(dir.join("linked.pdf")).unwrap(), b"%PDF-1.7\nnew");
}
