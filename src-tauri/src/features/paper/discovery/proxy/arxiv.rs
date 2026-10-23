//! Sandboxed arXiv HTML proxy used by the desktop reader.
//!
//! Request plumbing lives in [`super`]; only the site-specific origin and
//! chrome-hiding rewrite are defined here.

use super::SiteProxy;

const READER_STYLE: &str =
    "<style>.desktop_header, nav.ltx_TOC, .btn.btn-primary.hover-rp-button, #footer, .ltx_page_footer { display: none !important; }</style>";

fn rewrite(html: &str) -> String {
    html.replacen("</head>", &format!("{READER_STYLE}</head>"), 1)
}

static SITE: SiteProxy = SiteProxy {
    label: "arXiv",
    origin: "https://arxiv.org",
    user_agent: crate::core::http::USER_AGENT,
    rewrite,
};

pub fn handle(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    super::handle(&SITE, request, responder);
}
