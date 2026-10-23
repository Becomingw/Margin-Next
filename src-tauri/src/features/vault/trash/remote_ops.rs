//! Dependency inversion for the remote recycle-bin bridge.
//!
//! Trash commands branch on `remote:<sessionId>` vault handles but must not
//! import `integration::remote` (features may only depend on core). The remote
//! side (`integration::remote::trash_bridge`) implements [`RemoteTrashOps`]
//! for `RemoteRegistry`, and the desktop app registers it as Tauri state
//! (`Arc<dyn RemoteTrashOps>`).

use super::{TrashEntry, TrashResult};
use crate::core::error::AppError;
use async_trait::async_trait;

/// Remote-vault recycle-bin operations. `session_id` is the parsed
/// `remote:<id>` handle; the implementation resolves the active session and
/// operates on the remote vault through its filesystem + catalog mirror.
#[async_trait]
pub trait RemoteTrashOps: Send + Sync {
    /// Move files/folders into the remote vault recycle bin (undoable delete).
    async fn trash_paths_remote(
        &self,
        session_id: &str,
        rels: &[String],
    ) -> Result<TrashResult, AppError>;
    /// List every item currently in the remote recycle bin.
    async fn list_trash_remote(&self, session_id: &str) -> Result<Vec<TrashEntry>, AppError>;
    /// Empty the entire remote recycle bin (permanent).
    async fn purge_all_remote(&self, session_id: &str) -> Result<(), AppError>;
    /// Restore a single remote recycle-bin item to its original path.
    async fn restore_item_remote(
        &self,
        session_id: &str,
        batch_id: &str,
        stored: &str,
    ) -> Result<String, AppError>;
    /// Permanently delete a single remote recycle-bin item.
    async fn purge_item_remote(
        &self,
        session_id: &str,
        batch_id: &str,
        stored: &str,
    ) -> Result<(), AppError>;
}
