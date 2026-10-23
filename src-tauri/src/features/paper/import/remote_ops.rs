//! Dependency inversion for the remote import bridge.
//!
//! Import commands branch on `remote:<sessionId>` vault handles but must not
//! import `integration::remote` (features may only depend on core). The remote
//! side (`integration::remote::import_bridge`) implements [`RemoteImportOps`]
//! for `RemoteRegistry`, and the desktop app registers it as Tauri state
//! (`Arc<dyn RemoteImportOps>`).

use crate::core::error::AppError;
use crate::features::paper::import::pdf_parse::{PaperParseBodyArgs, PaperParseResult};
use crate::features::paper::import::{
    AssetDownloadResult, ImportLocalPdfArgs, ImportLocalPdfResult, LookupImportBatchArgs,
    LookupImportBatchResult, NoteShellMode, PaperDownloadAssetsArgs, PaperImportArgs,
    PaperImportResult,
};
use async_trait::async_trait;

/// Remote-vault import operations. `session_id` is the parsed `remote:<id>`
/// handle; the implementation resolves the active session, stages work in its
/// local work root, and pushes files + catalog over the remote filesystem.
#[async_trait]
pub trait RemoteImportOps: Send + Sync {
    /// Batch resolve identifiers and write papers into the remote vault.
    async fn import_by_identifier_batch_remote(
        &self,
        session_id: &str,
        args: LookupImportBatchArgs,
        note_mode: NoteShellMode,
    ) -> Result<LookupImportBatchResult, AppError>;
    /// Download PDF/TeX assets for an existing remote paper folder.
    async fn download_paper_assets_remote(
        &self,
        session_id: &str,
        args: PaperDownloadAssetsArgs,
    ) -> Result<AssetDownloadResult, AppError>;
    /// Import local PDF file(s) into the remote vault.
    async fn import_local_pdfs_remote(
        &self,
        session_id: &str,
        args: ImportLocalPdfArgs,
        note_mode: NoteShellMode,
    ) -> Result<ImportLocalPdfResult, AppError>;
    /// Parse a remote paper's staged PDF into `PAPER.md`, write it back to the
    /// remote vault, and push the catalog mirror.
    async fn parse_paper_body_remote(
        &self,
        session_id: &str,
        args: PaperParseBodyArgs,
    ) -> Result<PaperParseResult, AppError>;
    /// Import BibTeX/RIS/… catalog entries into the remote vault.
    async fn import_catalog_remote(
        &self,
        session_id: &str,
        args: PaperImportArgs,
        note_mode: NoteShellMode,
    ) -> Result<PaperImportResult, AppError>;
}
