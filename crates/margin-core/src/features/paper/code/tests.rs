use super::*;
use flate2::{write::GzEncoder, Compression};

fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    for (path, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, path, *bytes).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

fn paper(vault: &Path) {
    fs::create_dir_all(vault.join("papers/example/source")).unwrap();
    let record = papers::PaperRecord::local_pdf("example".into(), "Example".into())
        .at_path("papers/example");
    papers::upsert_paper(vault, &record).unwrap();
    fs::write(vault.join("papers/example/NOTES.md"), "My notes").unwrap();
}

#[test]
fn discovers_markdown_and_tex_links_without_scanning_code_or_notes() {
    let root = tempfile::tempdir().unwrap();
    paper(root.path());
    let dir = root.path().join("papers/example");
    fs::write(dir.join("PAPER.md"), "Code: [implementation](https://github.com/Lab/Model.git).\nhttps://github.com/Lab/Model/tree/main\n").unwrap();
    fs::write(
        dir.join("source/paper.tex"),
        r"\url{https://gitlab.com/group/sub/model\_code/-/tree/main}",
    )
    .unwrap();
    fs::write(dir.join("NOTES.md"), "https://github.com/unrelated/note").unwrap();
    fs::create_dir_all(dir.join("code/unmanaged")).unwrap();
    fs::write(
        dir.join("code/unmanaged/README.md"),
        "https://github.com/unrelated/dependency",
    )
    .unwrap();
    let state = inspect(root.path(), "papers/example").unwrap();
    assert!(state.body_available);
    assert_eq!(state.candidates.len(), 2);
    assert_eq!(state.candidates[0].url, "https://github.com/Lab/Model");
    assert_eq!(
        state.candidates[1].url,
        "https://gitlab.com/group/sub/model_code"
    );
    assert!(state.candidates[0].evidence.contains("implementation"));
    for bad in [
        "file:///tmp/repo",
        "https://github.com/user",
        "https://evilgithub.com/a/b",
        "https://token@github.com/a/b",
        "https://github.com:123/a/b",
    ] {
        assert!(Repository::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn snapshot_is_atomic_git_free_readable_and_owned_by_the_paper() {
    let root = tempfile::tempdir().unwrap();
    paper(root.path());
    let download = || DownloadedCode {
        repository: Repository::parse("https://github.com/lab/model").unwrap(),
        revision: "a".repeat(40),
        bytes: archive(&[
            ("root/README.md", b"Read me"),
            ("root/src/main.py", b"print(1)"),
            ("root/.git/config", b"git metadata"),
            ("root/sub/.git", b"gitdir: elsewhere"),
        ]),
    };
    assert!(install(root.path(), "papers/example", "changed", download()).is_err());
    let snapshot = install(root.path(), "papers/example", "example", download()).unwrap();
    assert_eq!(snapshot.file_count, 2);
    assert_eq!(snapshot.skipped_entries, 2);
    assert_eq!(
        read_file(root.path(), "papers/example", &snapshot.id, "src/main.py").unwrap(),
        "print(1)"
    );
    assert_eq!(
        files(root.path(), "papers/example", &snapshot.id).unwrap(),
        ["README.md", "src/main.py"]
    );
    assert!(read_file(
        root.path(),
        "papers/example",
        &snapshot.id,
        "../../NOTES.md"
    )
    .is_err());
    assert!(install(root.path(), "papers/example", "example", download()).is_err());
    assert_eq!(
        inspect(root.path(), "papers/example")
            .unwrap()
            .snapshots
            .len(),
        1
    );
    assert_eq!(
        fs::read_to_string(root.path().join("papers/example/NOTES.md")).unwrap(),
        "My notes"
    );
    let rel = format!("papers/example/code/{}", snapshot.id);
    let deleted =
        crate::features::vault::trash::trash_paths(root.path(), std::slice::from_ref(&rel))
            .unwrap();
    assert!(inspect(root.path(), "papers/example")
        .unwrap()
        .snapshots
        .is_empty());
    assert!(papers::get_by_path(root.path(), "papers/example")
        .unwrap()
        .is_some());
    crate::features::vault::trash::restore_batch(root.path(), &deleted.batch_id).unwrap();
    assert_eq!(
        inspect(root.path(), "papers/example")
            .unwrap()
            .snapshots
            .len(),
        1
    );
}

#[test]
fn failed_archive_leaves_no_snapshot_or_stage() {
    let root = tempfile::tempdir().unwrap();
    paper(root.path());
    let downloaded = DownloadedCode {
        repository: Repository::parse("https://github.com/a/b").unwrap(),
        revision: "b".repeat(40),
        bytes: archive(&[("root/good.py", b"good"), ("root/good.py", b"duplicate")]),
    };
    assert!(install(root.path(), "papers/example", "example", downloaded).is_err());
    assert!(!root.path().join("papers/example/code").exists());
    assert!(!fs::read_dir(root.path().join(crate::paths::APP_DOT_DIR))
        .unwrap()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().starts_with("code-stage-")));
}

#[test]
fn code_is_lazy_and_does_not_supply_paper_body_or_wiki_sources() {
    let root = tempfile::tempdir().unwrap();
    paper(root.path());
    let code = root.path().join("papers/example/code/demo/files");
    fs::create_dir_all(&code).unwrap();
    fs::write(code.join("paper.tex"), "example TeX").unwrap();
    fs::write(code.join("paper.pdf"), "%PDF-").unwrap();
    fs::write(code.join("README.md"), "[[NOTES]]").unwrap();
    fs::write(code.join("NOTES.md"), "Repository example notes").unwrap();
    fs::remove_file(root.path().join("papers/example/metadata.json")).unwrap();
    papers::rebuild_from_disk(root.path()).unwrap();
    assert_eq!(papers::list_all(root.path()).unwrap().len(), 1);
    let caps =
        crate::features::paper::capabilities::probe_paper_caps(&root.path().join("papers/example"));
    assert!(!caps.has_tex && !caps.has_pdf());
    let wiki = crate::features::wiki::index::collect_wiki_target_files(root.path()).unwrap();
    assert!(wiki.iter().all(|p| !is_code_path(p)));
    let tree = crate::features::vault::tree::build_tree(
        root.path(),
        &crate::features::catalog::CapsCache::new(),
    );
    let papers = tree.iter().find(|n| n.name == "papers").unwrap();
    let paper = &papers.children.as_ref().unwrap()[0];
    let code = paper
        .children
        .as_ref()
        .unwrap()
        .iter()
        .find(|n| n.name == "code")
        .unwrap();
    assert_eq!(code.children_pending, Some(true));
    assert!(code.children.as_ref().unwrap().is_empty());
}

#[test]
fn unsafe_tar_paths_are_rejected_and_links_are_not_materialized() {
    use std::io::Write;
    for path in ["root/../../outside", "root/C:/escape", "root/dir\\escape"] {
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Regular);
        header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
        header.set_cksum();
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(header.as_bytes()).unwrap();
        gzip.write_all(&[0; 1024]).unwrap();
        let root = tempfile::tempdir().unwrap();
        assert!(super::archive::extract(&gzip.finish().unwrap(), root.path()).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    let mut header = tar::Header::new_gnu();
    header.set_size(0);
    header.set_mode(0o777);
    header.set_entry_type(tar::EntryType::Symlink);
    tar.append_link(&mut header, "root/link", "../../outside")
        .unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_size(2);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "root/readme", &b"ok"[..])
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let bytes = tar.into_inner().unwrap().finish().unwrap();
    assert_eq!(
        super::archive::extract(&bytes, root.path()).unwrap(),
        (1, 2, 1)
    );
    assert!(!root.path().join("link").exists());
}

#[tokio::test]
#[ignore = "requires network access to public GitHub"]
async fn live_public_repository_snapshot() {
    let root = tempfile::tempdir().unwrap();
    paper(root.path());
    let repository = std::env::var("EDDA_CODE_TEST_REPO")
        .unwrap_or_else(|_| "https://github.com/octocat/Hello-World".into());
    let downloaded = download(&repository).await.unwrap();
    let snapshot = install(root.path(), "papers/example", "example", downloaded).unwrap();
    assert!(snapshot.file_count > 0);
    let names = files(root.path(), "papers/example", &snapshot.id).unwrap();
    let readme = names
        .iter()
        .find(|f| f.to_lowercase().starts_with("readme"))
        .unwrap();
    assert!(
        !read_file(root.path(), "papers/example", &snapshot.id, readme)
            .unwrap()
            .is_empty()
    );
    eprintln!(
        "snapshot {} revision={} files={} bytes={}",
        snapshot.url, snapshot.revision, snapshot.file_count, snapshot.bytes
    );
}

#[test]
fn global_pax_metadata_is_not_a_repository_root() {
    // GitHub archives can start with this global commit-comment header.
    // It describes the archive; it is not a file or a second content root.
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    let metadata = b"14 comment=ok\n";
    let mut header = tar::Header::new_gnu();
    header.set_size(metadata.len() as u64);
    header.set_mode(0o644);
    header.set_entry_type(tar::EntryType::XGlobalHeader);
    header.set_cksum();
    tar.append_data(&mut header, "pax_global_header", &metadata[..])
        .unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_size(5);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "repo-commit/README.md", &b"hello"[..])
        .unwrap();
    let bytes = tar.into_inner().unwrap().finish().unwrap();
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        super::archive::extract(&bytes, root.path()).unwrap(),
        (1, 5, 0)
    );
    assert_eq!(
        fs::read_to_string(root.path().join("README.md")).unwrap(),
        "hello"
    );
    assert!(!root.path().join("pax_global_header").exists());

    let root = tempfile::tempdir().unwrap();
    let two_roots = archive(&[("first/README.md", b"one"), ("second/train.py", b"two")]);
    assert!(super::archive::extract(&two_roots, root.path()).is_err());
}

#[cfg(unix)]
#[test]
fn code_directory_symlink_cannot_publish_outside_the_paper() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    paper(root.path());
    std::os::unix::fs::symlink(external.path(), root.path().join("papers/example/code")).unwrap();
    assert!(inspect(root.path(), "papers/example").is_err());
    assert!(install(
        root.path(),
        "papers/example",
        "example",
        DownloadedCode {
            repository: Repository::parse("https://github.com/a/b").unwrap(),
            revision: "b".repeat(40),
            bytes: archive(&[("root/a", b"data")])
        }
    )
    .is_err());
    assert_eq!(fs::read_dir(external.path()).unwrap().count(), 0);
}
