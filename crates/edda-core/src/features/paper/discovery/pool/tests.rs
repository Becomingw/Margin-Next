use super::*;
use crate::features::{
    catalog::{self, papers},
    import::NoteShellMode,
    paper::import::pool::promote,
};
use serde_json::json;

fn submission(source: &str, reason: &str) -> serde_json::Value {
    json!({"title":"A useful paper","authors":[{"name":"Ada","affiliations":["Research Institute"]}],"year":2026,"abstract":"An abstract","doi":"https://doi.org/10.1234/POOL","recommendation":reason,"source":source,"recommendedAt":"2026-09-18","tags":["vision"]})
}

#[test]
fn cold_delivery_is_idempotent_and_merges_reasons_without_requiring_an_app() {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().to_str().unwrap();
    let first = serde_json::to_vec(&submission("Codex", "Relevant method")).unwrap();
    let a = add(store, &first, None).unwrap();
    let b = add(store, &first, None).unwrap();
    assert_eq!(a.path, b.path);
    add(
        store,
        &serde_json::to_vec(&submission("Hermes", "Useful experiments")).unwrap(),
        None,
    )
    .unwrap();
    let snapshot = read_directory(store).unwrap();
    assert!(snapshot.warnings.is_empty());
    assert_eq!(snapshot.papers.len(), 1);
    let paper = &snapshot.papers[0];
    assert_eq!(paper.doi.as_deref(), Some("10.1234/pool"));
    assert_eq!(paper.authors[0].affiliations, vec!["Research Institute"]);
    assert_eq!(paper.recommendations.len(), 2);
}

#[test]
fn rejects_invalid_delivery_before_creating_files_but_reads_valid_neighbours() {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().join("pool");
    assert!(add(
        store.to_str().unwrap(),
        br#"{"title":"missing reason"}"#,
        None
    )
    .is_err());
    assert!(!store.exists());
    add(
        store.to_str().unwrap(),
        &serde_json::to_vec(&submission("Claude Code", "Useful")).unwrap(),
        None,
    )
    .unwrap();
    fs::write(store.join("partial.json"), b"{unfinished").unwrap();
    let snapshot = read_directory(store.to_str().unwrap()).unwrap();
    assert_eq!(snapshot.papers.len(), 1);
    assert!(!snapshot.warnings.is_empty());
    assert!(parse_document(br#"{"schemaVersion":2,"papers":[]}"#).is_err());
    let mut bad = submission("x", "reason");
    bad["url"] = json!("javascript:alert(1)");
    assert!(add(
        store.to_str().unwrap(),
        &serde_json::to_vec(&bad).unwrap(),
        None
    )
    .is_err());
}

#[test]
fn joins_partial_doi_and_arxiv_groups_without_losing_sources() {
    let mut doi = submission("A", "Reason A");
    doi["arxivId"] = json!(null);
    let mut arxiv = submission("B", "Reason B");
    arxiv["doi"] = json!(null);
    arxiv["arxivId"] = json!("2304.07193v2");
    let mut both = submission("C", "Reason C");
    both["arxivId"] = json!("2304.07193");
    let (records, issues) =
        parse_document(&serde_json::to_vec(&vec![doi, arxiv, both]).unwrap()).unwrap();
    assert!(issues.is_empty());
    let papers = model::merge_submissions(records);
    assert_eq!(papers.len(), 1);
    assert_eq!(papers[0].recommendations.len(), 3);
}

#[test]
fn does_not_merge_different_identifiers_just_because_titles_match() {
    let a = submission("A", "A");
    let mut b = submission("B", "B");
    b["doi"] = json!("10.1234/other");
    let (records, _) = parse_document(&serde_json::to_vec(&vec![a, b]).unwrap()).unwrap();
    assert_eq!(model::merge_submissions(records).len(), 2);
}

#[test]
fn canonical_links_supply_identifiers_without_guessing_from_other_hosts() {
    let mut row = submission("Agent", "Reason");
    row["doi"] = json!(null);
    row["url"] = json!("https://arxiv.org/abs/2304.07193v2");
    let (rows, issues) = parse_document(&serde_json::to_vec(&row).unwrap()).unwrap();
    assert!(issues.is_empty());
    assert_eq!(rows[0].arxiv_id.as_deref(), Some("2304.07193"));
    row["url"] = json!("https://example.org/2304.07193");
    let (rows, _) = parse_document(&serde_json::to_vec(&row).unwrap()).unwrap();
    assert!(rows[0].arxiv_id.is_none());
}

#[test]
fn accepts_jsonl_and_concurrent_producers_publish_complete_documents() {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().to_path_buf();
    let bytes = serde_json::to_vec(&submission("Codex", "A reason")).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let jobs: Vec<_> = (0..8)
        .map(|_| {
            let path = store.clone();
            let bytes = bytes.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                add(path.to_str().unwrap(), &bytes, None).unwrap();
            })
        })
        .collect();
    for job in jobs {
        job.join().unwrap();
    }
    let snapshot = read_directory(store.to_str().unwrap()).unwrap();
    assert_eq!(snapshot.papers.len(), 1);
    assert!(snapshot.warnings.is_empty());
    let jsonl = format!("{}\n{}\n", submission("A", "A"), submission("B", "B"));
    let (rows, issues) = parse_document(jsonl.as_bytes()).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(issues.is_empty());
}

#[tokio::test]
async fn promotion_is_explicit_metadata_only_repeatable_and_preserves_pool() {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().join("pool");
    let vault = temp.path().join("vault");
    fs::create_dir(&vault).unwrap();
    let written = add(
        store.to_str().unwrap(),
        &serde_json::to_vec(&submission("Codex", "Useful method")).unwrap(),
        None,
    )
    .unwrap();
    let original = fs::read(&written.path).unwrap();
    let snapshot = read_directory(store.to_str().unwrap()).unwrap();
    assert!(!vault
        .join(crate::vault_private_rel!("catalog.sqlite"))
        .exists());
    let result = promote(&vault, &snapshot.papers[0], NoteShellMode::Standard)
        .await
        .unwrap();
    assert!(result.created);
    assert_eq!(result.path.split('/').count(), 2);
    assert!(!catalog::has_local_pdf(&vault.join(&result.path)));
    assert!(vault.join(&result.path).join("NOTES.md").is_file());
    let row = papers::get_by_path(&vault, &result.path).unwrap().unwrap();
    assert_eq!(row.authors, vec!["Ada"]);
    assert_eq!(row.meta_source.as_deref(), Some("paper-pool"));
    assert!(row.extra.unwrap().contains("Research Institute"));
    assert!(
        !promote(&vault, &snapshot.papers[0], NoteShellMode::Standard)
            .await
            .unwrap()
            .created
    );
    assert_eq!(papers::list_all(&vault).unwrap().len(), 1);
    assert_eq!(fs::read(&written.path).unwrap(), original);
}

#[tokio::test]
async fn reads_static_http_json_without_a_pool_server_protocol() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let body = serde_json::to_vec(
        &json!({"schemaVersion":1,"papers":[submission("Remote Agent","Relevant")]}),
    )
    .unwrap();
    let server = tokio::spawn(async move {
        if let Ok(Ok((mut stream, _))) =
            tokio::time::timeout(Duration::from_secs(5), listener.accept()).await
        {
            let mut request = [0; 2048];
            let _ = stream.read(&mut request).await;
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        }
    });
    let snapshot = read(&format!("http://{address}/papers.json"))
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(snapshot.papers.len(), 1);
    assert_eq!(snapshot.papers[0].recommendations[0].source, "Remote Agent");
}
