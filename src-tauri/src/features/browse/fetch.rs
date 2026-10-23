//! Downloading a PDF with the signed-in session of a Browse view.
//!
//! The bytes are fetched by the page itself (`fetch` with credentials), so
//! cookies never leave the webview. Same-origin links (Springer, IEEE's stamp
//! page) work from the visible view; links that redirect to another host
//! (ScienceDirect) are opened in a hidden view on the same profile and fetched
//! from there. HTML wrappers are followed to the PDF they embed.

use std::time::{Duration, Instant};

use base64::Engine as _;
use tauri::webview::{DownloadEvent, PageLoadEvent};
use tauri::{LogicalPosition, LogicalSize, Runtime, Url, Webview, WebviewBuilder, WebviewUrl};

use super::page::eval_json;

const MAX_PDF_BYTES: u64 = 150 * 1024 * 1024;
/// Raw bytes per transfer; base64 makes each answer about 1 MiB.
const CHUNK: usize = 768 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const VISIT_TIMEOUT: Duration = Duration::from_secs(45);

const START_JS: &str = r#"(function (u, key) {
  var st = window[key] = { state: "pending" };
  fetch(u, { credentials: "include" }).then(function (r) {
    st.status = r.status;
    st.type = r.headers.get("content-type") || "";
    st.url = r.url;
    return r.arrayBuffer();
  }).then(function (buf) {
    var bytes = new Uint8Array(buf);
    st.size = bytes.length;
    var head = String.fromCharCode.apply(null, bytes.subarray(0, 1024));
    st.pdf = head.indexOf("%PDF-") >= 0;
    if (st.pdf) {
      st.bytes = bytes;
    } else if (/html/i.test(st.type) || /<html|<!doctype/i.test(head)) {
      var doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes.subarray(0, 4000000)), "text/html");
      var pick = function (sel, attr, test) {
        var hit = null;
        doc.querySelectorAll(sel).forEach(function (el) {
          var v = el.getAttribute(attr);
          if (!hit && v && (!test || test.test(v))) hit = v;
        });
        return hit;
      };
      var pdfish = /\.pdf($|[?#])|pdf|getPDF|stampPDF|pdfft/i;
      var next = pick('meta[name="citation_pdf_url" i]', "content") ||
        pick("iframe[src], embed[src]", "src", pdfish) || pick("object[data]", "data", pdfish) ||
        pick("a[href]", "href", /\.pdf($|[?#])|pdfft|getPDF|stampPDF/i);
      if (next) st.next = new URL(next, st.url || u).href;
    }
    st.state = "done";
  }).catch(function (e) {
    st.state = "error";
    st.error = String(e);
  });
  return true;
})"#;

const POLL_JS: &str = r#"(function (key) {
  var s = window[key];
  if (!s) return { state: "missing" };
  return { state: s.state, status: s.status || 0, size: s.size || 0, pdf: !!s.pdf, next: s.next || null, error: s.error || null };
})"#;

const CHUNK_JS: &str = r#"(function (key, offset, length) {
  var b = window[key].bytes.subarray(offset, offset + length), s = "";
  for (var i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768));
  return btoa(s);
})"#;

enum Fetched {
    Pdf(Vec<u8>),
    /// A page, possibly wrapping the PDF at `next`.
    Html {
        next: Option<String>,
    },
}

fn is_pdf(bytes: &[u8]) -> bool {
    bytes.len() > 5
        && bytes[..bytes.len().min(1024)]
            .windows(5)
            .any(|w| w == b"%PDF-")
}

fn web_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("invalid PDF address: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http(s) PDF addresses can be downloaded".into());
    }
    Ok(url)
}

/// Fetch `url` inside the page that `view` shows.
async fn fetch_in_page<R: Runtime>(view: &Webview<R>, url: &str) -> Result<Fetched, String> {
    let key = format!("__eddaFetch{}", uuid::Uuid::new_v4().simple());
    let args = |extra: &str| format!("({}{extra})", serde_json::to_string(&key).unwrap());
    let start = format!(
        "{START_JS}({}, {})",
        serde_json::to_string(url).map_err(|e| e.to_string())?,
        serde_json::to_string(&key).unwrap()
    );
    eval_json(view, &start, Duration::from_secs(3)).await?;
    let cleanup = format!("delete window[{}]", serde_json::to_string(&key).unwrap());
    let result = async {
        let deadline = Instant::now() + FETCH_TIMEOUT;
        let state = loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let state = eval_json(
                view,
                &format!("{POLL_JS}{}", args("")),
                Duration::from_secs(3),
            )
            .await?;
            if state["state"] != "pending" {
                break state;
            }
            if Instant::now() > deadline {
                return Err("the PDF download timed out".to_string());
            }
        };
        match state["state"].as_str() {
            Some("done") => {}
            Some("error") => {
                return Err(state["error"]
                    .as_str()
                    .unwrap_or("fetch failed")
                    .to_string())
            }
            _ => return Err("the page navigated away during the download".into()),
        }
        if !state["pdf"].as_bool().unwrap_or(false) {
            let next = state["next"].as_str().map(str::to_string);
            return Ok(Fetched::Html { next });
        }
        let size = state["size"].as_u64().unwrap_or(0);
        if size > MAX_PDF_BYTES {
            return Err("the PDF is too large".into());
        }
        let mut bytes = Vec::with_capacity(size as usize);
        let mut offset = 0usize;
        while (offset as u64) < size {
            let chunk = eval_json(
                view,
                &format!("{CHUNK_JS}{}", args(&format!(", {offset}, {CHUNK}"))),
                Duration::from_secs(10),
            )
            .await?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(chunk.as_str().unwrap_or_default())
                .map_err(|e| e.to_string())?;
            if decoded.is_empty() {
                break;
            }
            offset += decoded.len();
            bytes.extend_from_slice(&decoded);
        }
        if !is_pdf(&bytes) {
            return Err("the download is not a PDF".into());
        }
        Ok(Fetched::Pdf(bytes))
    }
    .await;
    let _ = view.eval(&cleanup);
    result
}

enum Visit {
    Loaded(Url),
    Downloaded(Option<std::path::PathBuf>),
}

/// Open `url` in a hidden view on the Browse profile and take the PDF from
/// wherever it lands: a PDF document, a download, or a page embedding one.
async fn visit_and_fetch<R: Runtime>(source: &Webview<R>, url: Url) -> Result<Vec<u8>, String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Visit>();
    let load_tx = tx.clone();
    let label = format!(
        "{}fetch-{}",
        super::LABEL_PREFIX,
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about" | "blob" | "data"))
        .on_page_load(move |_view, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = load_tx.send(Visit::Loaded(payload.url().clone()));
            }
        })
        .on_download(move |_view, event| {
            match event {
                DownloadEvent::Requested { destination, .. } => {
                    *destination = std::env::temp_dir()
                        .join(format!("edda-browse-{}.pdf", uuid::Uuid::new_v4().simple()));
                }
                DownloadEvent::Finished { path, success, .. } => {
                    let _ = tx.send(Visit::Downloaded(path.filter(|_| success)));
                }
                _ => {}
            }
            true
        });
    let helper = source
        .window()
        .add_child(
            super::with_profile(builder),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    let _ = helper.hide();
    let result = async {
        let deadline = tokio::time::Instant::now() + VISIT_TIMEOUT;
        let mut followed = 0;
        loop {
            let visit = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .map_err(|_| "the PDF page did not load in time".to_string())?
                .ok_or("the PDF view closed")?;
            match visit {
                Visit::Downloaded(Some(path)) => {
                    let bytes = std::fs::read(&path).map_err(|e| e.to_string());
                    let _ = std::fs::remove_file(&path);
                    let bytes = bytes?;
                    return if is_pdf(&bytes) {
                        Ok(bytes)
                    } else {
                        Err("the download is not a PDF".into())
                    };
                }
                Visit::Downloaded(None) => return Err("the PDF download failed".into()),
                Visit::Loaded(at) if matches!(at.scheme(), "http" | "https") => {
                    match fetch_in_page(&helper, at.as_str()).await {
                        Ok(Fetched::Pdf(bytes)) => return Ok(bytes),
                        Ok(Fetched::Html { next: Some(next) }) if followed < 2 => {
                            followed += 1;
                            helper
                                .navigate(web_url(&next)?)
                                .map_err(|e| e.to_string())?;
                        }
                        // An interstitial page may still redirect on its own.
                        _ => {}
                    }
                }
                Visit::Loaded(_) => {}
            }
        }
    }
    .await;
    let _ = helper.close();
    result
}

/// Download the PDF at `url` with the session of `view`.
pub async fn download_pdf<R: Runtime>(view: &Webview<R>, url: &str) -> Result<Vec<u8>, String> {
    let mut target = web_url(url)?.to_string();
    for _ in 0..3 {
        match fetch_in_page(view, &target).await {
            Ok(Fetched::Pdf(bytes)) => return Ok(bytes),
            Ok(Fetched::Html { next: Some(next) }) if next != target => {
                target = web_url(&next)?.to_string()
            }
            // Cross-origin redirects fail here (CORS); visiting follows them.
            _ => break,
        }
    }
    visit_and_fetch(view, web_url(url)?).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pdf_bytes_count() {
        assert!(is_pdf(b"%PDF-1.7\n..."));
        assert!(is_pdf(b"\xef\xbb\xbf%PDF-1.4"));
        assert!(!is_pdf(b"<!doctype html><html>"));
        assert!(web_url("file:///etc/passwd").is_err());
    }
}
