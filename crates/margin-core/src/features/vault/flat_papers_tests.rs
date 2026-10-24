use super::*;
use crate::features::catalog::papers::PaperRecord;

fn paper(root: &Path, rel: &str, id: &str) {
    let dir = root.join(rel);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("NOTES.md"), "# Methods\n\nUser notes").unwrap();
    fs::write(dir.join("demo.pdf"), b"%PDF-1.7").unwrap();
    papers::upsert_paper(
        root,
        &PaperRecord::local_pdf(id.into(), id.into()).at_path(rel),
    )
    .unwrap();
}

#[test]
fn flatten_preserves_files_tags_and_links_and_is_repeatable() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    paper(root, "papers/demo", "root");
    paper(root, "papers/视觉/vit/demo", "vit");
    paper(root, "papers/other/demo", "other");
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::write(
        root.join("notes/map.md"),
        "[[papers/视觉/vit/demo/NOTES#Methods]]\n[pdf](../papers/视觉/vit/demo/demo.pdf#page=2)",
    )
    .unwrap();
    fs::write(root.join("papers/视觉/NOTES.md"), "collection overview").unwrap();
    let mut index = WikiIndex::default();
    let moved = flatten(root, &mut index, &[]).unwrap();
    assert_eq!(moved.len(), 3);
    let dest = &moved
        .iter()
        .find(|entry| entry.from.contains("视觉"))
        .unwrap()
        .to;
    assert_eq!(dest.split('/').count(), 2);
    assert!(root.join(dest).join("demo.pdf").is_file());
    assert_eq!(
        fs::read_to_string(root.join(dest).join("NOTES.md")).unwrap(),
        "# Methods\n\nUser notes"
    );
    let row = papers::get_by_path(root, dest).unwrap().unwrap();
    assert!(row.tags.iter().any(|tag| tag.name == "vit"));
    assert!(row.tags.iter().any(|tag| tag.name == "视觉"));
    let links = fs::read_to_string(root.join("notes/map.md")).unwrap();
    assert!(links.contains(&format!("{dest}/NOTES#Methods")), "{links}");
    assert!(
        links.contains(&format!("{dest}/demo.pdf#page=2")),
        "{links}"
    );
    assert!(root.join("notes/paper-collections/视觉/NOTES.md").is_file());
    assert_eq!(flatten(root, &mut index, &[]).unwrap().len(), 3);
    assert_eq!(papers::list_all(root).unwrap().len(), 3);
}

#[test]
fn dirty_link_source_blocks_migration_and_retry_recovers() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    paper(root, "papers/vit/demo", "demo");
    fs::create_dir(root.join("notes")).unwrap();
    fs::write(root.join("notes/map.md"), "[[papers/vit/demo/NOTES]]").unwrap();
    let mut index = WikiIndex::default();
    assert!(flatten(root, &mut index, &["notes/map.md".into()]).is_err());
    assert!(root.join("papers/vit/demo").is_dir());
    assert!(!root.join("papers/demo").exists());
    assert!(papers::get_by_path(root, "papers/vit/demo")
        .unwrap()
        .is_some());
    assert_eq!(flatten(root, &mut index, &[]).unwrap().len(), 1);
}
