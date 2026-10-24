//! One persistent reviewer identity per document. Transport credentials are
//! separate, short-lived capabilities; client-supplied names are never authority.
use super::{new_id, storage};
use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Reviewer {
    pub id: String,
    pub label: String,
}

pub(super) enum Principal {
    Author,
    Reviewer(Reviewer),
}
impl Principal {
    pub fn actor(&self) -> &str {
        match self {
            Self::Author => "author",
            Self::Reviewer(_) => "agent",
        }
    }
    pub fn label(&self) -> Option<&str> {
        match self {
            Self::Author => None,
            Self::Reviewer(r) => Some(&r.label),
        }
    }
    pub fn owns(&self, conn: &Connection, entity: &str) -> Result<bool, AppError> {
        match self {
            Self::Author => Ok(true),
            Self::Reviewer(r) => Ok(conn
                .query_row(
                    "SELECT reviewer_id FROM entity_owners WHERE entity_id=?1",
                    [entity],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .as_deref()
                == Some(r.id.as_str())),
        }
    }
    pub fn assign(&self, conn: &Connection, entity: &str) -> Result<(), AppError> {
        if let Self::Reviewer(r) = self {
            conn.execute(
                "INSERT INTO entity_owners VALUES (?1,?2)",
                params![entity, r.id],
            )?;
        }
        Ok(())
    }
}

pub fn bind_reviewer(root: &std::path::Path, id: &str, label: &str) -> Result<Reviewer, AppError> {
    let label = super::super::review::model::clean_agent_name(label);
    if label.is_empty() || label.chars().count() > 80 {
        return Err(AppError::message(
            "reviewer name must contain 1–80 characters",
        ));
    }
    let mut conn = storage::connect(root, id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = tx
        .query_row("SELECT id FROM reviewer WHERE slot=1", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    let reviewer = Reviewer {
        id: existing.unwrap_or_else(|| new_id("reviewer")),
        label,
    };
    tx.execute("INSERT INTO reviewer VALUES (1,?1,?2) ON CONFLICT(slot) DO UPDATE SET label=excluded.label",params![reviewer.id,reviewer.label])?;
    tx.commit()?;
    Ok(reviewer)
}

pub(super) fn load(conn: &Connection, id: &str) -> Result<Principal, AppError> {
    let reviewer = conn
        .query_row("SELECT id,label FROM reviewer WHERE id=?1", [id], |r| {
            Ok(Reviewer {
                id: r.get(0)?,
                label: r.get(1)?,
            })
        })
        .optional()?;
    reviewer.map(Principal::Reviewer).ok_or_else(|| {
        AppError::domain(
            "reviewer_not_bound",
            "Reviewer is not bound to this manuscript",
        )
    })
}
