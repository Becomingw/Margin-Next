//! `edda-preview://` — serve Vault files to the sandboxed local HTML preview.
//!
//! An agent-written report (`report.html` beside its `style.css` and charts)
//! only renders if its relative assets resolve, which a `srcdoc` or `blob:`
//! frame cannot do. This scheme mirrors the Vault under an opaque per-session
//! root id, so `edda-preview://localhost/<id>/notes/report.html` loads
//! `./style.css` from the same folder.
//!
//! Boundaries:
//! - only roots the frontend registered are served, under random ids, so no
//!   page can guess its way to an arbitrary path;
//! - `..` segments and symlinks that leave the root are refused;
//! - no CORS header: other frames (including the 广场 site proxies) cannot
//!   read Vault bytes with `fetch`;
//! - HTML is served with a CSP `sandbox` directive on top of the iframe's own
//!   `sandbox`, so the page never gets the app origin or its IPC.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use tauri::http::{header, Response, StatusCode};

use crate::core::error::ApiResult;

/// Registered roots: random id → canonical root.
static ROOTS: RwLock<Option<HashMap<String, PathBuf>>> = RwLock::new(None);

/// Largest file the preview serves (a report and its assets, not datasets).
const MAX_BYTES: u64 = 64 * 1024 * 1024;

const HTML_CSP: &str = "sandbox allow-scripts allow-forms allow-modals";

/// The id serving `root`, registering it on first use.
fn register_root(root: &Path) -> std::io::Result<String> {
    let root = root.canonicalize()?;
    let mut guard = ROOTS
        .write()
        .map_err(|_| std::io::Error::other("preview roots poisoned"))?;
    let roots = guard.get_or_insert_with(HashMap::new);
    if let Some((id, _)) = roots.iter().find(|(_, existing)| **existing == root) {
        return Ok(id.clone());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    roots.insert(id.clone(), root);
    Ok(id)
}

/// The file a request path (`/<id>/<percent-encoded segments>`) names.
fn resolve(path: &str) -> Result<PathBuf, StatusCode> {
    let mut segments = path.trim_start_matches('/').split('/');
    let id = segments.next().unwrap_or_default();
    let root = ROOTS
        .read()
        .ok()
        .and_then(|roots| roots.as_ref()?.get(id).cloned())
        .ok_or(StatusCode::FORBIDDEN)?;
    let mut target = root.clone();
    for segment in segments {
        let segment = urlencoding::decode(segment).map_err(|_| StatusCode::BAD_REQUEST)?;
        let mut parts = Path::new(segment.as_ref()).components();
        match (parts.next(), parts.next()) {
            (Some(Component::Normal(name)), None) => target.push(name),
            (None, _) => {}
            _ => return Err(StatusCode::FORBIDDEN),
        }
    }
    // Symlinks may point anywhere; only what still lives under the root is served.
    let target = target.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    if !target.starts_with(&root) {
        return Err(StatusCode::FORBIDDEN);
    }
    if !target.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(target)
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        "csv" => "text/csv; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn respond(path: &str) -> Response<Vec<u8>> {
    let read = resolve(path).and_then(|file| {
        let size = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?.len();
        if size > MAX_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let bytes = std::fs::read(&file).map_err(|_| StatusCode::NOT_FOUND)?;
        Ok((file, bytes))
    });
    let mut builder = Response::builder()
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store");
    match read {
        Ok((file, bytes)) => {
            let mime = content_type(&file);
            if mime.starts_with("text/html") {
                builder = builder.header(header::CONTENT_SECURITY_POLICY, HTML_CSP);
            }
            builder
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .body(bytes)
        }
        Err(status) => builder
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(
                status
                    .canonical_reason()
                    .unwrap_or("error")
                    .as_bytes()
                    .to_vec(),
            ),
    }
    .expect("valid preview response")
}

/// Scheme handler; file reads run off the webview thread.
pub fn handle(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || responder.respond(respond(&path)));
}

#[derive(Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultPreviewRootArgs {
    /// Local Vault root whose files the preview may load.
    pub root: String,
}

/// Register a local Vault root for `edda-preview://` and return its id.
#[tauri::command]
#[specta::specta]
pub async fn vault_preview_root(args: VaultPreviewRootArgs) -> Result<ApiResult<String>, String> {
    match register_root(Path::new(&args.root)) {
        Ok(id) => Ok(ApiResult::ok(id)),
        Err(e) => Ok(ApiResult::err(e.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes/assets")).unwrap();
        std::fs::write(dir.path().join("notes/report.html"), "<p>hi</p>").unwrap();
        std::fs::write(dir.path().join("notes/assets/a b.css"), "p{}").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "no").unwrap();
        let id = register_root(&dir.path().join("notes")).unwrap();
        (dir, id)
    }

    #[test]
    fn serves_files_under_the_root_with_their_type() {
        let (_dir, id) = vault();
        let page = respond(&format!("/{id}/report.html"));
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers()[header::CONTENT_SECURITY_POLICY], HTML_CSP);
        let css = respond(&format!("/{id}/assets/a%20b.css"));
        assert_eq!(css.status(), StatusCode::OK);
        assert!(css.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/css"));
        assert!(!css
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[test]
    fn refuses_escapes_and_unknown_roots() {
        let (_dir, id) = vault();
        assert_eq!(
            respond(&format!("/{id}/../secret.txt")).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            respond(&format!("/{id}/%2E%2E/secret.txt")).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            respond(&format!("/{id}/..%2Fsecret.txt")).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            respond("/not-registered/report.html").status(),
            StatusCode::FORBIDDEN
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_leave_the_root() {
        let (dir, id) = vault();
        std::os::unix::fs::symlink(
            dir.path().join("secret.txt"),
            dir.path().join("notes/link.txt"),
        )
        .unwrap();
        assert_eq!(
            respond(&format!("/{id}/link.txt")).status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn reuses_the_id_of_a_registered_root() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            register_root(dir.path()).unwrap(),
            register_root(dir.path()).unwrap()
        );
    }
}
