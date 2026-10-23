use super::*;
use serde_json::{json, Value};

struct Client {
    http: reqwest::Client,
    url: String,
    bearer: String,
    session: Option<String>,
}
impl Client {
    async fn request(&self, body: Value) -> reqwest::Response {
        let mut req = self
            .http
            .post(&self.url)
            .header("Authorization", &self.bearer)
            .header("Accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(id) = self.session.as_ref() {
            req = req.header("Mcp-Session-Id", id);
        }
        req.send().await.unwrap()
    }
    async fn connect(status: &Status) -> Self {
        let mut c = Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(8))
                .build()
                .unwrap(),
            url: status.url.clone().unwrap(),
            bearer: status.config.as_ref().unwrap()["mcpServers"]["margin"]["headers"]
                ["Authorization"]
                .as_str()
                .unwrap()
                .into(),
            session: None,
        };
        let init=c.request(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"untrusted-client-name","version":"1"}}})).await;
        assert!(init.status().is_success());
        c.session = init
            .headers()
            .get("mcp-session-id")
            .map(|v| v.to_str().unwrap().into());
        let _ = init.text().await.unwrap();
        assert!(c
            .request(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
            .status()
            .is_success());
        c
    }
    async fn rpc(&self, method: &str, params: Value) -> Value {
        let response=self.request(json!({"jsonrpc":"2.0","id":uuid::Uuid::new_v4().to_string(),"method":method,"params":params})).await;
        assert!(response.status().is_success());
        let body = response.text().await.unwrap();
        serde_json::from_str(&body).unwrap_or_else(|_| {
            body.lines()
                .filter_map(|s| s.strip_prefix("data: "))
                .find_map(|s| serde_json::from_str(s).ok())
                .expect("MCP JSON or SSE response")
        })
    }
    async fn call(&self, name: &str, args: Value) -> Value {
        self.rpc("tools/call", json!({"name":name,"arguments":args}))
            .await
    }
}

#[tokio::test]
async fn review_endpoint_is_authenticated_pinned_and_revocable() {
    let root = tempfile::tempdir().unwrap();
    let doc = service::create(root.path(), "One document").unwrap();
    let other = service::create(root.path(), "Not granted").unwrap();
    let ctrl = Controller::default();
    let status = ctrl
        .start(root.path().into(), doc.id.clone(), "Chosen Reviewer".into())
        .await
        .unwrap();
    let url = status.url.as_ref().unwrap();
    let bearer = status.config.as_ref().unwrap()["mcpServers"]["margin"]["headers"]
        ["Authorization"]
        .as_str()
        .unwrap();
    let http = reqwest::Client::new();
    assert_eq!(
        http.post(url).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        http.post(url)
            .header("Authorization", bearer)
            .header("Origin", "https://untrusted.example")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    let client = Client::connect(&status).await;
    let listed = client.rpc("tools/list", json!({})).await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    let names = tools
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(names.len(), 7);
    assert!(names.contains("review_read"));
    assert!(!names.contains("settings_set"));
    assert!(!names.contains("review_manuscript_replace"));
    let read = client
        .call(
            "review_read",
            json!({"reviewId":other.id,"vaultPath":"somewhere else"}),
        )
        .await;
    assert_eq!(read["result"]["structuredContent"]["id"], doc.id);
    let head = read["result"]["structuredContent"]["headId"]
        .as_str()
        .unwrap();
    let args = json!({"commandId":"ai-comment","expectedHead":head,"quote":"One document","body":"Please explain this claim."});
    let added = client.call("review_comment_add", args.clone()).await;
    assert_ne!(added["result"]["isError"], true);
    let thread = &added["result"]["structuredContent"]["comments"][0];
    assert_eq!(thread["actor"], "agent");
    assert_eq!(thread["agent"], "Chosen Reviewer");
    assert_ne!(
        client.call("review_comment_add", args).await["result"]["isError"],
        true
    );
    assert_eq!(
        service::open(root.path(), &doc.id)
            .unwrap()
            .state
            .comments
            .len(),
        1
    );
    let cid = thread["id"].as_str().unwrap();
    service::execute(root.path(),&doc.id,"human-reply",json!({"kind":"comment-update","commentId":cid,"action":"reply","body":"The explanation is in the next paragraph."})).unwrap();
    let read = client.call("review_read", json!({})).await;
    assert_eq!(
        read["result"]["structuredContent"]["comments"][0]["replies"][0]["actor"],
        "author"
    );
    let answer = client
        .call(
            "review_comment_update",
            json!({"commandId":"ai-reply","commentId":cid,"action":"reply","body":"I see it now."}),
        )
        .await;
    assert_eq!(
        answer["result"]["structuredContent"]["comments"][0]["replies"][1]["agent"],
        "Chosen Reviewer"
    );
    assert!(client
        .call("review_apply_change", json!({}))
        .await
        .get("error")
        .is_some());
    let proposed = client
        .call(
            "review_propose",
            json!({"commandId":"proposal","baseRevision":head,"markdown":"# Revised document\n"}),
        )
        .await;
    let pid = proposed["result"]["structuredContent"]["commandResult"]["proposalId"]
        .as_str()
        .unwrap();
    assert_eq!(service::open(root.path(), &doc.id).unwrap().head_id, head);
    let v = service::open(root.path(), &doc.id).unwrap();
    service::execute(
        root.path(),
        &doc.id,
        "human-dismiss",
        json!({"kind":"dismiss-proposal","expectedStamp":v.stamp,"proposalId":pid}),
    )
    .unwrap();
    let details = client
        .call("review_proposal", json!({"proposalId":pid}))
        .await;
    assert_eq!(
        details["result"]["structuredContent"]["status"],
        "dismissed"
    );
    let next = ctrl
        .start(root.path().into(), other.id, "Same reviewer role".into())
        .await
        .unwrap();
    let new_url = next.url.as_ref().unwrap();
    assert_eq!(
        http.post(new_url)
            .header("Authorization", bearer)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_ne!(next.config, status.config);
    ctrl.stop().await.unwrap();
    assert!(!ctrl.status().await.listening);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_drains_in_flight_writes_and_rejects_queued_work() {
    let root = tempfile::tempdir().unwrap();
    let doc = service::create(root.path(), "Drain").unwrap();
    let ctrl = Arc::new(Controller::default());
    ctrl.start(root.path().into(), doc.id.clone(), "AI".into())
        .await
        .unwrap();
    let grant = Arc::clone(&ctrl.running.lock().await.as_ref().unwrap().grant);
    let (entered, ready) = oneshot::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let writer = Arc::clone(&grant);
    let job = tokio::task::spawn_blocking(move || {
        writer.run(|root,id,r|{
        let _=entered.send(());resume.recv().unwrap();
        let base=service::open(root,id)?;
        service::execute_as_agent(root,id,&r.id,"in-flight",serde_json::json!({"kind":"propose","baseRevision":base.head_id,"markdown":"Changed"}))
    })
    });
    ready.await.unwrap();
    let stopping = Arc::clone(&ctrl);
    let stopped = tokio::spawn(async move { stopping.stop().await });
    while grant.active.load(Ordering::Acquire) {
        tokio::task::yield_now().await;
    }
    assert!(!stopped.is_finished());
    release.send(()).unwrap();
    job.await.unwrap().unwrap();
    stopped.await.unwrap().unwrap();
    assert_eq!(
        grant.run(|_, _, _| Ok(())).unwrap_err().code(),
        "reviewer_disconnected"
    );
    assert_eq!(
        service::updates(root.path(), &doc.id, 0, 200).unwrap()["proposals"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
