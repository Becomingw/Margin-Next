use super::Grant;
use edda_core::{error::AppError, features::margin as service};
use rmcp::{
    handler::server::{
        router::tool::ToolRouter,
        wrapper::{Json, Parameters},
    },
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ServerHandler,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone)]
pub struct ReviewerMcp {
    grant: Arc<Grant>,
    tool_router: ToolRouter<Self>,
}
impl ReviewerMcp {
    pub fn new(grant: Arc<Grant>) -> Self {
        let mut tool_router = Self::tool_router();
        // Json<Value> has no concrete object schema. Structured content still
        // carries the real response, without advertising an invalid outputSchema.
        for route in tool_router.map.values_mut() {
            route.attr.output_schema = None;
        }
        Self { grant, tool_router }
    }
    async fn run(
        &self,
        f: impl FnOnce(&std::path::Path, &str, &service::Reviewer) -> Result<Value, AppError>
            + Send
            + 'static,
    ) -> Result<Json<Value>, AppError> {
        let grant = Arc::clone(&self.grant);
        let result = tokio::task::spawn_blocking(move || grant.run(f))
            .await
            .map_err(|e| AppError::message(e.to_string()))?;
        result.map(Json)
    }
    async fn write(&self, command_id: String, request: Value) -> Result<Json<Value>, AppError> {
        if request.to_string().len() > 2 * 1024 * 1024 {
            return Err(AppError::message(
                "Review write exceeds 2 MiB; submit a smaller change",
            ));
        }
        self.run(move |root, id, reviewer| {
            Ok(serde_json::to_value(service::execute_as_agent(
                root,
                id,
                &reviewer.id,
                &command_id,
                request,
            )?)?)
        })
        .await
    }
}
fn tool_error(e: AppError) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(
        json!({"code":e.code(),"message":e.to_string()}).to_string(),
    )])
}

#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Updates {
    after: i64,
    limit: Option<usize>,
}
#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revision {
    revision_id: String,
}
#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    proposal_id: String,
}
#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Propose {
    command_id: String,
    base_revision: String,
    markdown: String,
}
#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Comment {
    command_id: String,
    expected_head: String,
    quote: String,
    body: String,
    block_id: Option<String>,
    prefix: Option<String>,
    suffix: Option<String>,
}
#[derive(Debug, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Thread {
    command_id: String,
    comment_id: String,
    action: String,
    body: Option<String>,
    expected_updated_at: Option<String>,
    reply_id: Option<String>,
}

#[tool_router]
impl ReviewerMcp {
    #[tool(
        description = "Read the single authorized manuscript: saved Markdown, headId, baseline, comments/replies, revision sources and current-round decisions. Unsaved human drafts are not visible."
    )]
    async fn review_read(&self) -> Result<Json<Value>, CallToolResult> {
        self.run(|root, id, reviewer| {
            let mut view=serde_json::to_value(service::open(root,id)?)?;
            view["you"]=json!({"reviewerId":reviewer.id,"name":reviewer.label,"role":"agent","canApplyProposals":false,"canResolveRevisions":false});
            Ok(view)
        })
            .await.map_err(tool_error)
    }
    #[tool(
        description = "Read sequenced events and pending proposals after a cursor. Use after=0 initially; paginate until hasMore=false. Includes human replies and proposal/revision decisions."
    )]
    async fn review_updates(
        &self,
        Parameters(a): Parameters<Updates>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.run(move |root, id, _| service::updates(root, id, a.after, a.limit.unwrap_or(100)))
            .await
            .map_err(tool_error)
    }
    #[tool(
        description = "Read an immutable revision in this manuscript, including a pending proposal target. No file paths or other manuscripts are accessible."
    )]
    async fn review_revision(
        &self,
        Parameters(a): Parameters<Revision>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.run(move|root,id,_|Ok(json!({"revisionId":a.revision_id,"markdown":service::read_revision(root,id,&a.revision_id)?}))).await.map_err(tool_error)
    }
    #[tool(
        description = "Read a proposal's status, base/target IDs and bounded diff preview. The human applies or dismisses proposals; read target via review_revision for full text."
    )]
    async fn review_proposal(
        &self,
        Parameters(a): Parameters<Proposal>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.run(move |root, id, _| service::proposal_detail(root, id, &a.proposal_id))
            .await
            .map_err(tool_error)
    }
    #[tool(
        description = "Submit proposed Markdown against an immutable baseRevision from review_read. Does NOT change the live manuscript or baseline. Supply a unique commandId and reuse it with exactly the same arguments after an uncertain response."
    )]
    async fn review_propose(
        &self,
        Parameters(a): Parameters<Propose>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.write(
            a.command_id,
            json!({"kind":"propose","baseRevision":a.base_revision,"markdown":a.markdown}),
        )
        .await
        .map_err(tool_error)
    }
    #[tool(
        description = "Add an AI-signed manuscript comment using headId from review_read as expectedHead. Quote the selected text and provide prefix/suffix for repeated text. Stale versions are rejected."
    )]
    async fn review_comment_add(
        &self,
        Parameters(a): Parameters<Comment>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.write(a.command_id,json!({"kind":"comment-add","expectedHead":a.expected_head,"input":{"blockId":a.block_id,"quote":a.quote,"body":a.body,"prefix":a.prefix.unwrap_or_default(),"suffix":a.suffix.unwrap_or_default()}})).await.map_err(tool_error)
    }
    #[tool(
        description = "Reply to a live human/AI thread, or edit/delete only your own comment or reply. Editing/deletion requires expectedUpdatedAt from the read version. Replies append safely; only the human resolves threads or accepts/rejects revisions."
    )]
    async fn review_comment_update(
        &self,
        Parameters(a): Parameters<Thread>,
    ) -> Result<Json<Value>, CallToolResult> {
        self.write(a.command_id,json!({"kind":"comment-update","commentId":a.comment_id,"action":a.action,"body":a.body,"expectedUpdatedAt":a.expected_updated_at,"replyId":a.reply_id})).await.map_err(tool_error)
    }
}
#[tool_handler(router=self.tool_router)]
impl ServerHandler for ReviewerMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("margin-review",env!("CARGO_PKG_VERSION")))
            .with_instructions("Single AI + human review checkpoint. You act only as the reviewer identity granted by the human, for one pinned manuscript. Start with review_read; use review_updates to observe replies and human decisions. Submit changes with review_propose; pending proposals do not edit the manuscript. The human alone applies/dismisses proposals and accepts/rejects revisions. Discuss in shared comment threads, preserving other writers' content. Use commandId for every mutation; retry identical requests with the same ID after a lost response. On version conflict re-read and reconsider; never silently overwrite or retry against a newer version without reviewing it. Do not access databases/files or attempt to switch the authorized document. Access can be revoked at any time; reconnect only with new explicit authorization.")
    }
}
