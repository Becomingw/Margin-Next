//! Margin's transactional document service. No live manuscript file or research
//! catalog: immutable revisions, version-bound proposals, decisions and threads.
mod agent;
mod operations;
mod storage;
#[cfg(test)]
mod tests;

pub use agent::{bind_reviewer, Reviewer};
pub use operations::{execute, execute_as_agent, proposal_detail, suggestions, updates};
pub use storage::{create, export, import_files, list, open, read_revision, sequence, View};

use super::review::model::{new_id, ReviewEvent};
use crate::error::AppError;

fn conflict() -> AppError {
    AppError::domain(
        "manuscript_changed",
        "Document changed; reload before retrying this command.",
    )
}

fn now() -> String {
    crate::time::now_rfc3339_millis()
}

fn event(kind: &str) -> ReviewEvent {
    ReviewEvent {
        id: new_id("event"),
        kind: kind.into(),
        created_at: now(),
        actor: "author".into(),
        agent: None,
        comment_id: None,
        reply_id: None,
        before: None,
        after: None,
        prefix: None,
        suffix: None,
        revision_id: None,
        reason: None,
    }
}
