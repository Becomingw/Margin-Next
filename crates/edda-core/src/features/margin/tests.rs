use super::*;
use serde_json::json;

fn setup() -> (tempfile::TempDir, String, View) {
    let dir = tempfile::tempdir().unwrap();
    let id = create(dir.path(), "Review").unwrap().id;
    let v = open(dir.path(), &id).unwrap();
    (dir, id, v)
}
fn save(root: &std::path::Path, id: &str, v: &View, text: &str) -> View {
    execute(
        root,
        id,
        &super::super::review::model::new_id("cmd"),
        json!({"kind":"save","expectedHead":v.head_id,"lastSaved":v.manuscript,"markdown":text}),
    )
    .unwrap()
}

#[test]
fn durable_history_receipts_and_stale_writers() {
    let (dir, id, old) = setup();
    let next = save(dir.path(), &id, &old, "甲🙂 beta\n");
    assert_eq!(
        read_revision(dir.path(), &id, &old.head_id).unwrap(),
        old.manuscript
    );
    assert!(execute(dir.path(),&id,"stale",json!({"kind":"save","expectedHead":old.head_id,"lastSaved":old.manuscript,"markdown":"lost update"})).is_err());
    let req = json!({"kind":"save","expectedHead":next.head_id,"lastSaved":next.manuscript,"markdown":"new"});
    let ack = execute(dir.path(), &id, "retry", req.clone()).unwrap();
    let replay = execute(dir.path(), &id, "retry", req).unwrap();
    assert_eq!(ack.head_id, replay.head_id);
    assert_eq!(ack.sequence, replay.sequence);
    assert!(execute(dir.path(), &id, "retry", json!({"kind":"observe"})).is_err());
    assert_eq!(open(dir.path(), &id).unwrap().manuscript, "new");
}

#[test]
fn pending_agent_proposals_never_overwrite_author_drafts() {
    let (dir, id, v) = setup();
    let proposal = execute(
        dir.path(),
        &id,
        "propose",
        json!({"kind":"propose","baseRevision":v.head_id,"markdown":"AI","agent":"Codex"}),
    )
    .unwrap();
    assert_eq!(proposal.head_id, v.head_id);
    let list = updates(dir.path(), &id, 0, 200).unwrap();
    let p = list["proposals"][0]["id"].as_str().unwrap();
    let author = save(dir.path(), &id, &v, "author draft");
    assert!(execute(
        dir.path(),
        &id,
        "apply",
        json!({"kind":"apply-proposal","expectedStamp":author.stamp,"proposalId":p})
    )
    .is_err());
    assert_eq!(open(dir.path(), &id).unwrap().manuscript, "author draft");
}

#[test]
fn partial_decisions_are_checked_and_snapshots_are_immutable() {
    let (dir, id, v) = setup();
    let v = save(dir.path(), &id, &v, "alpha beta\n");
    let v=execute(dir.path(),&id,"baseline",json!({"kind":"decide","expectedStamp":v.stamp,"reason":"accept-all","nextBaseline":v.manuscript})).unwrap();
    let edited = save(dir.path(), &id, &v, "alpha 中文🙂\nmore\n");
    let accept = json!({"kind":"decide","expectedStamp":edited.stamp,"reason":"accept-change","nextBaseline":"alpha 中文🙂\n"});
    let accepted = execute(dir.path(), &id, "one", accept).unwrap();
    assert_ne!(accepted.state.baseline_id, v.state.baseline_id);
    assert_eq!(
        read_revision(dir.path(), &id, &v.state.baseline_id).unwrap(),
        "alpha beta\n"
    );
    assert_eq!(accepted.manuscript, edited.manuscript);
    assert!(execute(dir.path(),&id,"bad",json!({"kind":"decide","expectedStamp":accepted.stamp,"reason":"accept-change","nextBaseline":"invented"})).is_err());
    assert!(execute(dir.path(),&id,"old",json!({"kind":"decide","expectedStamp":edited.stamp,"reason":"reject-all","nextBaseline":edited.state.baseline_text,"nextManuscript":edited.state.baseline_text})).is_err());
    let c = storage::connect(dir.path(), &id).unwrap();
    assert!(c.execute("UPDATE revisions SET body='oops'", []).is_err());
    assert!(c.execute("DELETE FROM decisions", []).is_err());
}

#[test]
fn failed_mutations_rollback_and_updates_are_paginated() {
    let (dir, id, v) = setup();
    let before = updates(dir.path(), &id, 0, 200).unwrap();
    assert!(execute(
        dir.path(),
        &id,
        "bad-parent",
        json!({"kind":"propose","baseRevision":"missing","markdown":"AI"})
    )
    .is_err());
    assert_eq!(open(dir.path(), &id).unwrap().sequence, v.sequence);
    assert_eq!(updates(dir.path(), &id, 0, 200).unwrap(), before);
    let v = save(dir.path(), &id, &v, "x\n");
    let all = updates(dir.path(), &id, 0, 1).unwrap();
    assert_eq!(all["events"].as_array().unwrap().len(), 1);
    assert_eq!(all["hasMore"], true);
    assert_eq!(
        updates(dir.path(), &id, v.sequence, 200).unwrap()["events"],
        json!([])
    );
}

#[test]
fn thread_cas_and_append_replies() {
    let (dir, id, initial) = setup();
    let v=execute(dir.path(),&id,"comment",json!({"kind":"comment-add","expectedHead":initial.head_id,"input":{"quote":"Review","body":"Check"}})).unwrap();
    let c = &v.state.comments[0];
    let stamp = c.updated_at.clone();
    let cid = c.id.clone();
    for n in 0..2 {
        execute(
            dir.path(),
            &id,
            &format!("reply{n}"),
            json!({"kind":"comment-update","commentId":cid,"action":"reply","body":"yes"}),
        )
        .unwrap();
    }
    assert!(execute(dir.path(),&id,"stale-comment",json!({"kind":"comment-update","commentId":cid,"action":"edit","body":"no","expectedUpdatedAt":stamp})).is_err());
    assert_eq!(
        open(dir.path(), &id).unwrap().state.comments[0]
            .replies
            .len(),
        2
    );
}

#[test]
fn legacy_import_is_read_only_and_export_is_consistent() {
    let root = tempfile::tempdir().unwrap();
    let old = super::super::review::store::create_unit(root.path(), "Legacy").unwrap();
    let path = std::path::Path::new(&old.path);
    let before = std::fs::read(path.join("review.json")).unwrap();
    let old_text = std::fs::read(path.join("manuscript.md")).unwrap();
    let units = list(root.path()).unwrap();
    assert_eq!(units.len(), 1);
    assert_eq!(list(root.path()).unwrap().len(), 1);
    assert_eq!(std::fs::read(path.join("review.json")).unwrap(), before);
    let v = open(root.path(), &old.id).unwrap();
    let v = save(root.path(), &old.id, &v, "new");
    assert_eq!(std::fs::read(path.join("manuscript.md")).unwrap(), old_text);
    let dest = tempfile::tempdir().unwrap();
    let output = export(root.path(), &old.id, dest.path()).unwrap();
    let db =
        rusqlite::Connection::open(std::path::Path::new(&output).join("review.sqlite")).unwrap();
    assert_eq!(storage::load(&db).unwrap().head_id, v.head_id);
    assert_eq!(
        std::fs::read_to_string(std::path::Path::new(&output).join("manuscript.md")).unwrap(),
        "new"
    );
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(db);
    let restored = import_files(
        root.path(),
        &[std::path::Path::new(&output)
            .join("review.sqlite")
            .to_string_lossy()
            .into()],
    )
    .unwrap();
    assert_ne!(restored[0].id, old.id);
    let restored = open(root.path(), &restored[0].id).unwrap();
    assert_eq!(restored.manuscript, v.manuscript);
    assert_eq!(restored.head_id, v.head_id);
}

#[test]
fn independent_connections_serialize_writes() {
    let (dir, id, v) = setup();
    let root = dir.path().to_path_buf();
    let threads:Vec<_>=(0..2).map(|n|{let root=root.clone();let id=id.clone();let v=v.clone();std::thread::spawn(move||execute(&root,&id,&format!("parallel{n}"),json!({"kind":"save","expectedHead":v.head_id,"lastSaved":v.manuscript,"markdown":format!("text{n}")})))}).collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
}

#[test]
fn abandoned_initialization_does_not_hide_other_documents() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join(".margin")
        .join("documents")
        .join("interrupted");
    std::fs::create_dir_all(&path).unwrap();
    drop(rusqlite::Connection::open(path.join("review.sqlite")).unwrap());
    let doc = create(root.path(), "Visible").unwrap();
    let units = list(root.path()).unwrap();
    assert_eq!(units.len(), 1);
    assert_eq!(units[0].id, doc.id);
}

#[test]
fn imported_documents_do_not_depend_on_legacy_files_remaining_healthy() {
    let root = tempfile::tempdir().unwrap();
    let old = super::super::review::store::create_unit(root.path(), "Legacy").unwrap();
    assert_eq!(list(root.path()).unwrap().len(), 1);
    std::fs::write(
        std::path::Path::new(&old.path).join("review.json"),
        "no longer valid JSON",
    )
    .unwrap();
    assert_eq!(list(root.path()).unwrap().len(), 1);
}

#[test]
fn reject_and_empty_document_work() {
    let (dir, id, v) = setup();
    let v = save(dir.path(), &id, &v, "replacement");
    let r=execute(dir.path(),&id,"reject",json!({"kind":"decide","expectedStamp":v.stamp,"reason":"reject-change","nextBaseline":v.state.baseline_text,"nextManuscript":v.state.baseline_text})).unwrap();
    assert_eq!(r.manuscript, r.state.baseline_text);
    let empty = save(dir.path(), &id, &r, "");
    assert_eq!(empty.manuscript, "");
}

#[test]
fn durable_receipt_does_not_replay_a_stale_document_view() {
    let (dir, id, v) = setup();
    let request =
        json!({"kind":"save","expectedHead":v.head_id,"lastSaved":v.manuscript,"markdown":"first"});
    let ack = execute(dir.path(), &id, "first-save", request.clone()).unwrap();
    let newer = save(dir.path(), &id, &ack, "second");
    let retry = execute(dir.path(), &id, "first-save", request).unwrap();
    assert_eq!(retry.acknowledged_sequence, ack.sequence);
    assert_eq!(retry.acknowledged_head, ack.head_id);
    assert_eq!(retry.head_id, newer.head_id);
    assert_eq!(retry.manuscript, "second");
}

#[test]
fn pending_proposal_application_and_stable_comparison_ids() {
    let (dir, id, v) = setup();
    let proposed = execute(
        dir.path(),
        &id,
        "pending",
        json!({"kind":"propose","baseRevision":v.head_id,"markdown":"New text","agent":"Codex"}),
    )
    .unwrap();
    let pid = proposed.command_result.as_ref().unwrap()["proposalId"]
        .as_str()
        .unwrap();
    let applied = execute(
        dir.path(),
        &id,
        "apply",
        json!({"kind":"apply-proposal","expectedStamp":proposed.stamp,"proposalId":pid}),
    )
    .unwrap();
    assert_eq!(applied.manuscript, "New text");
    assert_eq!(applied.state.baseline_id, v.state.baseline_id);
    let updates = updates(dir.path(), &id, 0, 200).unwrap();
    let comparison = updates["comparisonId"].as_str().unwrap();
    let first = suggestions(dir.path(), &id, comparison, 0, 200).unwrap();
    assert!(!first["suggestions"].as_array().unwrap().is_empty());
    let after = open(dir.path(), &id).unwrap();
    assert_eq!(after.head_id, applied.head_id);
    assert_eq!(
        suggestions(dir.path(), &id, comparison, 0, 200).unwrap(),
        first
    );
}

#[test]
fn immutable_suggestion_rejection_leaves_other_changes_pending() {
    let (dir, id, v) = setup();
    let v = save(dir.path(), &id, &v, "left old\n\nright old\n");
    let v=execute(dir.path(),&id,"round",json!({"kind":"decide","expectedStamp":v.stamp,"reason":"accept-all","nextBaseline":v.manuscript})).unwrap();
    let v = save(dir.path(), &id, &v, "left NEW\n\nright FRESH\n");
    let page = updates(dir.path(), &id, 0, 200).unwrap();
    let comparison = page["comparisonId"].as_str().unwrap();
    let s = suggestions(dir.path(), &id, comparison, 0, 200).unwrap();
    let selected = s["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["start"].as_u64().unwrap() < 10)
        .map(|s| s["id"].clone())
        .collect::<Vec<_>>();
    let rejected=execute(dir.path(),&id,"reject-left",json!({"kind":"resolve-suggestions","expectedStamp":v.stamp,"comparisonId":comparison,"suggestionIds":selected,"action":"reject"})).unwrap();
    assert_eq!(rejected.manuscript, "left old\n\nright FRESH\n");
    assert!(execute(dir.path(),&id,"stale-suggestion",json!({"kind":"resolve-suggestions","expectedStamp":rejected.stamp,"comparisonId":comparison,"suggestionIds":selected,"action":"accept"})).is_err());
}

#[test]
fn process_interruption_rolls_back_unacknowledged_transaction() {
    let (dir, id, v) = setup();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "features::margin::tests::crash_writer_child",
            "--ignored",
        ])
        .env("MARGIN_CRASH_ROOT", dir.path())
        .env("MARGIN_CRASH_ID", &id)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(77));
    let recovered = open(dir.path(), &id).unwrap();
    assert_eq!(recovered.head_id, v.head_id);
    assert_eq!(recovered.sequence, v.sequence);
    let conn = storage::connect(dir.path(), &id).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM receipts WHERE command_id='interrupted'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
#[ignore = "subprocess helper: intentionally exits without running destructors"]
fn crash_writer_child() {
    let Ok(root) = std::env::var("MARGIN_CRASH_ROOT") else {
        return;
    };
    let id = std::env::var("MARGIN_CRASH_ID").unwrap();
    let mut conn = storage::connect(std::path::Path::new(&root), &id).unwrap();
    conn.execute_batch("PRAGMA cache_size=8").unwrap();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let head = storage::revision(&tx, &"uncommitted".repeat(50000), None, "crash-test").unwrap();
    tx.execute("UPDATE document SET head=?1,sequence=sequence+1", [head])
        .unwrap();
    tx.execute(
        "INSERT INTO receipts VALUES ('interrupted','hash','{}')",
        [],
    )
    .unwrap();
    // No Drop/rollback/commit: the OS closes the SQLite handles.
    std::process::exit(77);
}

#[test]
fn single_reviewer_and_human_share_threads_without_impersonation() {
    let (dir, id, v) = setup();
    let reviewer = bind_reviewer(dir.path(), &id, "Reviewer AI").unwrap();
    let created=execute_as_agent(dir.path(),&id,&reviewer.id,"ai-comment",json!({"kind":"comment-add","expectedHead":v.head_id,"actor":"author","agent":"spoofed","input":{"quote":"Review","body":"Please clarify."}})).unwrap();
    let thread = &created.state.comments[0];
    assert_eq!(thread.actor, "agent");
    assert_eq!(thread.agent.as_deref(), Some("Reviewer AI"));
    let cid = thread.id.clone();
    let human=execute(dir.path(),&id,"human-reply",json!({"kind":"comment-update","commentId":cid,"action":"reply","body":"Here is the clarification."})).unwrap();
    assert_eq!(human.state.comments[0].replies[0].actor, "author");
    let request = json!({"kind":"comment-update","commentId":cid,"action":"reply","body":"Thank you, now it is clear."});
    let ai = execute_as_agent(dir.path(), &id, &reviewer.id, "ai-reply", request.clone()).unwrap();
    let retry = execute_as_agent(dir.path(), &id, &reviewer.id, "ai-reply", request).unwrap();
    assert_eq!(retry.state.comments[0].replies.len(), 2);
    assert_eq!(retry.acknowledged_sequence, ai.sequence);
    assert_eq!(
        ai.state.comments[0].replies[1].agent.as_deref(),
        Some("Reviewer AI")
    );
    let read = open(dir.path(), &id).unwrap();
    assert_eq!(read.state.comments[0].replies.len(), 2);
    assert_eq!(
        read.state.events.last().unwrap().agent.as_deref(),
        Some("Reviewer AI")
    );
}

#[test]
fn reviewer_cannot_overwrite_human_text_or_claim_other_threads() {
    let (dir, id, v) = setup();
    let reviewer = bind_reviewer(dir.path(), &id, "AI").unwrap();
    let human=execute(dir.path(),&id,"comment",json!({"kind":"comment-add","expectedHead":v.head_id,"input":{"quote":"Review","body":"Human comment"}})).unwrap();
    let c = &human.state.comments[0];
    for action in ["edit", "delete", "resolve", "restore"] {
        assert!(execute_as_agent(dir.path(),&id,&reviewer.id,&format!("forbidden-{action}"),json!({"kind":"comment-update","commentId":c.id,"action":action,"body":"AI override","expectedUpdatedAt":c.updated_at})).is_err());
    }
    for kind in [
        "save",
        "decide",
        "apply-proposal",
        "dismiss-proposal",
        "rename",
        "parsed-pdf",
        "resolve-suggestions",
    ] {
        assert_eq!(
            execute_as_agent(dir.path(), &id, &reviewer.id, kind, json!({"kind":kind}))
                .unwrap_err()
                .code(),
            "reviewer_forbidden"
        );
    }
    assert_eq!(open(dir.path(), &id).unwrap().manuscript, v.manuscript);
}

#[test]
fn reviewer_identity_survives_reconnect_and_thread_edits_use_cas() {
    let (dir, id, v) = setup();
    let reviewer = bind_reviewer(dir.path(), &id, "Original label").unwrap();
    let made=execute_as_agent(dir.path(),&id,&reviewer.id,"make",json!({"kind":"comment-add","expectedHead":v.head_id,"input":{"quote":"Review","body":"AI note"}})).unwrap();
    let reconnected = bind_reviewer(dir.path(), &id, "Updated label").unwrap();
    assert_eq!(reviewer.id, reconnected.id);
    let c = &made.state.comments[0];
    let edited=execute_as_agent(dir.path(),&id,&reconnected.id,"edit",json!({"kind":"comment-update","commentId":c.id,"action":"edit","body":"Updated AI note","expectedUpdatedAt":c.updated_at})).unwrap();
    assert_eq!(edited.state.comments[0].body, "Updated AI note");
    assert!(execute_as_agent(dir.path(),&id,&reconnected.id,"stale-edit",json!({"kind":"comment-update","commentId":c.id,"action":"edit","body":"stale","expectedUpdatedAt":c.updated_at})).is_err());
    assert!(execute_as_agent(
        dir.path(),
        &id,
        "unknown-reviewer",
        "bad",
        json!({"kind":"propose","baseRevision":v.head_id,"markdown":"other"})
    )
    .is_err());
}

#[test]
fn schema_one_upgrade_is_additive() {
    let (dir, id, v) = setup();
    let conn = storage::connect(dir.path(), &id).unwrap();
    conn.execute_batch("DROP TABLE entity_owners; DROP TABLE reviewer; PRAGMA user_version=1;")
        .unwrap();
    drop(conn);
    let reviewer = bind_reviewer(dir.path(), &id, "AI").unwrap();
    assert!(!reviewer.id.is_empty());
    let current = open(dir.path(), &id).unwrap();
    assert_eq!(current.head_id, v.head_id);
    assert_eq!(current.sequence, v.sequence);
    assert_eq!(
        read_revision(dir.path(), &id, &v.head_id).unwrap(),
        v.manuscript
    );
}

#[test]
fn ai_can_edit_its_reply_but_not_human_replies_or_closed_threads() {
    let (dir, id, v) = setup();
    let reviewer = bind_reviewer(dir.path(), &id, "AI").unwrap();
    let made=execute(dir.path(),&id,"human-note",json!({"kind":"comment-add","expectedHead":v.head_id,"input":{"quote":"Review","body":"A question"}})).unwrap();
    let cid = made.state.comments[0].id.clone();
    let replied = execute_as_agent(
        dir.path(),
        &id,
        &reviewer.id,
        "ai-answer",
        json!({"kind":"comment-update","commentId":cid,"action":"reply","body":"First answer"}),
    )
    .unwrap();
    let c = &replied.state.comments[0];
    let rid = c.replies[0].id.clone();
    let edited=execute_as_agent(dir.path(),&id,&reviewer.id,"ai-edit-answer",json!({"kind":"comment-update","commentId":cid,"replyId":rid,"action":"edit","body":"Corrected answer","expectedUpdatedAt":c.updated_at})).unwrap();
    assert_eq!(edited.state.comments[0].replies[0].body, "Corrected answer");
    let human = execute(
        dir.path(),
        &id,
        "human-answer",
        json!({"kind":"comment-update","commentId":cid,"action":"reply","body":"Human wording"}),
    )
    .unwrap();
    let c = &human.state.comments[0];
    assert!(execute_as_agent(dir.path(),&id,&reviewer.id,"claim-human-reply",json!({"kind":"comment-update","commentId":cid,"replyId":c.replies[1].id,"action":"edit","body":"Overwrite","expectedUpdatedAt":c.updated_at})).is_err());
    execute(dir.path(),&id,"close",json!({"kind":"comment-update","commentId":cid,"action":"resolve","expectedUpdatedAt":c.updated_at})).unwrap();
    assert_eq!(
        execute_as_agent(
            dir.path(),
            &id,
            &reviewer.id,
            "late-answer",
            json!({"kind":"comment-update","commentId":cid,"action":"reply","body":"Late answer"})
        )
        .unwrap_err()
        .code(),
        "thread_closed"
    );
}

#[test]
fn wholesale_ai_rewrite_keeps_the_complete_target_when_diff_is_coarsened() {
    let (dir, id, v) = setup();
    let old = "X".repeat(18000);
    let target = "Y".repeat(18000);
    let v = save(dir.path(), &id, &v, &old);
    let v = execute(
        dir.path(),
        &id,
        "round",
        json!({"kind":"decide","expectedStamp":v.stamp,"reason":"accept-all","nextBaseline":old}),
    )
    .unwrap();
    let reviewer = bind_reviewer(dir.path(), &id, "AI").unwrap();
    let made = execute_as_agent(
        dir.path(),
        &id,
        &reviewer.id,
        "rewrite",
        json!({"kind":"propose","baseRevision":v.head_id,"markdown":target}),
    )
    .unwrap();
    let pid = made.command_result.as_ref().unwrap()["proposalId"]
        .as_str()
        .unwrap();
    let detail = proposal_detail(dir.path(), &id, pid).unwrap();
    assert_eq!(
        read_revision(dir.path(), &id, detail["targetRevision"].as_str().unwrap()).unwrap(),
        target
    );
    assert!(detail["truncated"].as_bool().unwrap());
    assert_eq!(open(dir.path(), &id).unwrap().manuscript, old);
    let applied = execute(
        dir.path(),
        &id,
        "apply",
        json!({"kind":"apply-proposal","expectedStamp":made.stamp,"proposalId":pid}),
    )
    .unwrap();
    assert_eq!(applied.manuscript, target);
    let accepted=execute(dir.path(),&id,"accept",json!({"kind":"decide","expectedStamp":applied.stamp,"reason":"accept-change","nextBaseline":target})).unwrap();
    assert_eq!(accepted.state.baseline_text, target);
}
