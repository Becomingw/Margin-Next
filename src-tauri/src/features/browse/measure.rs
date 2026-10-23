//! Layout diagnostics for a Browse page at several panel widths.
//!
//! The page is loaded again in a hidden view on the Browse profile (signed
//! in, adapters injected), resized to each width and measured: horizontal
//! overflow, the outermost elements sticking out, text squeezed into a
//! narrow column, and large fixed overlays. Agents use it to write and then
//! verify an adapter's `layout.css` without disturbing the user's view.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{LogicalPosition, LogicalSize, Runtime, Webview, WebviewBuilder, WebviewUrl};

use super::page::eval_json;

const HEIGHT: f64 = 900.0;
const LOAD_TIMEOUT: Duration = Duration::from_secs(40);
/// Pages that never finish (long polling, slow trackers) are measured once
/// their DOM has been ready this long.
const INTERACTIVE_GRACE: Duration = Duration::from_secs(5);
/// Time for scripts and late layout after load, and after each resize.
const SETTLE: Duration = Duration::from_millis(1500);
const RESIZE_SETTLE: Duration = Duration::from_millis(700);

/// One measurement at a time: each is a full page load.
static BUSY: AtomicBool = AtomicBool::new(false);

const MEASURE_JS: &str = r##"(function () {
  var W = document.documentElement.clientWidth, H = window.innerHeight;
  var desc = function (el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    var cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += "." + cls.join(".");
    var p = el.parentElement;
    if (p && p !== document.body && p.tagName) s = p.tagName.toLowerCase() + (p.id ? "#" + p.id : "") + " > " + s;
    return s;
  };
  var contained = function (el) {
    for (var a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      var ox = getComputedStyle(a).overflowX;
      if (ox !== "visible" && a.getBoundingClientRect().right <= W + 2) return true;
    }
    return false;
  };
  var ownText = function (el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim().length > 10) return true;
    }
    return false;
  };
  var wide = [], squeezed = [], overlays = [];
  var all = document.body ? document.body.getElementsByTagName("*") : [];
  for (var i = 0; i < all.length && i < 30000; i++) {
    var el = all[i], r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden") continue;
    if (wide.length < 15 && r.right > W + 2) {
      var pr = el.parentElement && el.parentElement.getBoundingClientRect();
      if ((!pr || pr.right <= W + 2) && !contained(el)) {
        wide.push({ element: desc(el), left: Math.round(r.left), width: Math.round(r.width),
          minWidth: cs.minWidth, cssWidth: cs.width, display: cs.display });
      }
    }
    if (squeezed.length < 10 && r.width < 48 && ownText(el)) {
      var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 16;
      if (r.height / lh > 6) squeezed.push({ element: desc(el), width: Math.round(r.width), lines: Math.round(r.height / lh) });
    }
    if (overlays.length < 5 && (cs.position === "fixed" || cs.position === "sticky") && r.width * r.height > W * H * 0.2) {
      overlays.push({ element: desc(el), position: cs.position, width: Math.round(r.width), height: Math.round(r.height) });
    }
  }
  var root = document.scrollingElement || document.documentElement;
  return {
    width: W,
    scrollWidth: root.scrollWidth,
    horizontalOverflow: root.scrollWidth > W + 2,
    wide: wide,
    squeezed: squeezed,
    overlays: overlays,
    adapters: window.__edda ? window.__edda.status() : null
  };
})()"##;

struct Release;
impl Drop for Release {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// Loaded, or its DOM ready for [`INTERACTIVE_GRACE`]: some sites keep
/// connections open and never report the load as finished.
async fn wait_until_ready<R: Runtime>(
    probe: &Webview<R>,
    finished: &mut tokio::sync::mpsc::UnboundedReceiver<()>,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + LOAD_TIMEOUT;
    let mut interactive_since = None;
    loop {
        if finished.try_recv().is_ok() {
            return Ok(());
        }
        let state = eval_json(
            probe,
            "location.protocol.indexOf('http') === 0 ? document.readyState : 'loading'",
            Duration::from_secs(1),
        )
        .await
        .ok();
        match state.as_ref().and_then(|s| s.as_str()) {
            Some("complete") => return Ok(()),
            Some("interactive") => {
                let since = *interactive_since.get_or_insert_with(tokio::time::Instant::now);
                if since.elapsed() >= INTERACTIVE_GRACE {
                    return Ok(());
                }
            }
            _ => {}
        }
        if tokio::time::Instant::now() > deadline {
            return Err("the page did not load in time".into());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Measure the page `view` shows at each width (CSS px, 320–1600).
pub async fn check_layout<R: Runtime>(
    view: &Webview<R>,
    widths: &[u32],
) -> Result<serde_json::Value, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("a layout check is already running".into());
    }
    let _release = Release;
    let url = view.url().map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only web pages can be checked".into());
    }
    let widths: Vec<u32> = widths
        .iter()
        .map(|w| (*w).clamp(320, 1600))
        .take(4)
        .collect();
    let first = *widths.first().ok_or("no widths to check")?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let label = format!(
        "{}measure-{}",
        super::LABEL_PREFIX,
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let token = uuid::Uuid::new_v4().simple().to_string();
    let builder = super::bridge::init_scripts(&token, None).into_iter().fold(
        WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
            .on_navigation(|u| matches!(u.scheme(), "http" | "https" | "about" | "blob" | "data"))
            .on_page_load(move |_view, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    let _ = tx.send(());
                }
            }),
        |b, script| b.initialization_script_for_all_frames(script),
    );
    let probe = view
        .window()
        .add_child(
            super::with_profile(builder),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(first as f64, HEIGHT),
        )
        .map_err(|e| e.to_string())?;
    let _ = probe.hide();
    let result = async {
        wait_until_ready(&probe, &mut rx).await?;
        tokio::time::sleep(SETTLE).await;
        let mut out = Vec::new();
        for (i, width) in widths.iter().enumerate() {
            if i > 0 {
                probe
                    .set_size(LogicalSize::new(*width as f64, HEIGHT))
                    .map_err(|e| e.to_string())?;
                tokio::time::sleep(RESIZE_SETTLE).await;
            }
            let mut measured = eval_json(&probe, MEASURE_JS, Duration::from_secs(5)).await?;
            measured["panelWidth"] = (*width).into();
            out.push(measured);
        }
        Ok(serde_json::json!({ "url": url.as_str(), "widths": out }))
    }
    .await;
    let _ = probe.close();
    result
}
