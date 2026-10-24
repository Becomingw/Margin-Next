//! Review workspace (`reviews/<id>/`): in-progress manuscripts under review.
//!
//! The counterpart of `papers/<id>/` (finished literature). A review unit
//! holds a plain-Markdown `manuscript.md` plus `review.json` — comments,
//! revision snapshots and an event log — and never joins the catalog, never
//! fetches remote metadata, and never converts into a paper. Reading papers
//! may be referenced *from* a manuscript (wiki links); review units are not
//! reference targets.

pub mod anchor;
pub mod diff;
pub mod model;
pub mod ops;
pub mod review_md;
pub mod store;

pub use diff::{DiffHunk, DiffLine};
pub use model::{
    agent_display_name, clean_agent_name, AnchorStatus, CommentAction, CommentAnchor, CommentReply,
    CommentStatus, ReviewComment, ReviewCommentInput, ReviewEvent, ReviewState, ReviewUnitSummary,
    ReviewView, Revision, MANUSCRIPT_FILE, REVIEWS_ROOT, REVIEW_FORMAT, REVIEW_VERSION,
    REVISIONS_DIR, STATE_FILE,
};
pub use store::{
    apply_parsed_pdf_body, checked_unit_dir_pub, create_unit, find_unit_pdf_name, import_files,
    list_units, load_state, manuscript_path, open_unit, read_manuscript, rename_unit, reviews_root,
    save_state, slugify, state_path, unit_summary,
};
