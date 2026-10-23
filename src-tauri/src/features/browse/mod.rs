//! 浏览 (Browse): websites in native child webviews over the dock panel.
//!
//! Each site gets one webview per window, labelled `browse-<window>-<site>`,
//! that the frontend keeps aligned with its panel. Views share one persistent
//! profile kept apart from Edda's own webview storage, so logins survive
//! restarts. Pages get no app IPC; see docs/development/browse.md.

pub mod adapter;
pub mod bridge;
mod fetch;
pub mod import;
pub mod measure;
pub mod page;
mod snapshot;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewBuilder,
    WebviewUrl,
};
use tauri_plugin_opener::OpenerExt;

use crate::core::error::ApiResult;

const LABEL_PREFIX: &str = "browse-";
/// Temporary views (downloads, layout checks, cookie maintenance), never shown to the user.
const INTERNAL_PREFIXES: [&str; 3] = ["browse-fetch-", "browse-measure-", "browse-maintenance"];
const PAGE_EVENT: &str = "browse:page";
const DOWNLOAD_EVENT: &str = "browse:download";
const ACTION_EVENT: &str = "browse:action";
pub const ADAPTER_EVENT: &str = "browse:adapter";

/// A page action: an import button clicked (`import`), or selected text the
/// user asked to translate or quote (`selection`).
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseActionEvent {
    pub label: String,
    pub kind: String,
    pub target: Option<bridge::BrowseImportTarget>,
    pub selection: Option<bridge::BrowseSelection>,
}

/// An agent changed an adapter; the app offers to undo it.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseAdapterEvent {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub note: String,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePageEvent {
    pub label: String,
    pub url: String,
    pub title: Option<String>,
    pub loading: bool,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDownloadEvent {
    pub label: String,
    pub name: String,
    pub path: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn valid_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
        && label.len() <= 96
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn browse_view<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<tauri::Webview<R>> {
    valid_label(label).then(|| app.get_webview(label)).flatten()
}

/// The view the user looked at last, and each view's page title.
static ACTIVE: Mutex<Option<String>> = Mutex::new(None);
static TITLES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// What rebuilding a view needs, and its action token.
#[derive(Clone)]
struct ViewState {
    window: String,
    rect: BrowseRect,
    visible: bool,
    token: String,
    /// Selection toolbar strings; kept so a rebuilt view gets them too.
    ui: Option<bridge::BrowseUiLabels>,
    /// Last accepted action per kind, for rate limiting.
    last_action: HashMap<&'static str, std::time::Instant>,
}

static VIEWS: Mutex<Option<HashMap<String, ViewState>>> = Mutex::new(None);

// add_child waits for native creation before get_webview can see the result.
// Keep check/create and subsequent hide/close/rebuild operations in order;
// StrictMode replay or rapid tab switches may invoke them concurrently.
// This must be async: never block the native UI message loop on this gate.
static VIEW_LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn with_state<T>(f: impl FnOnce(&mut HashMap<String, ViewState>) -> T) -> T {
    let mut guard = VIEWS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn set_active(label: &str) {
    if let Ok(mut active) = ACTIVE.lock() {
        *active = Some(label.to_string());
    }
}

fn user_views<R: Runtime>(app: &AppHandle<R>) -> Vec<tauri::Webview<R>> {
    let mut views: Vec<_> = app
        .webviews()
        .into_values()
        .filter(|view| {
            let label = view.label();
            valid_label(label) && !INTERNAL_PREFIXES.iter().any(|p| label.starts_with(p))
        })
        .collect();
    views.sort_by(|a, b| a.label().cmp(b.label()));
    views
}

/// `label`, or the last active view, or the only open one.
pub fn resolve_view<R: Runtime>(
    app: &AppHandle<R>,
    label: Option<&str>,
) -> Result<tauri::Webview<R>, String> {
    if let Some(label) = label.map(str::trim).filter(|l| !l.is_empty()) {
        return browse_view(app, label).ok_or_else(|| format!("no Browse page {label} is open"));
    }
    let active = ACTIVE.lock().ok().and_then(|a| a.clone());
    if let Some(view) = active.and_then(|label| browse_view(app, &label)) {
        return Ok(view);
    }
    let mut views = user_views(app);
    match views.len() {
        1 => Ok(views.remove(0)),
        0 => Err("no Browse page is open".into()),
        _ => Err("several Browse pages are open; pass a view from browse_tabs".into()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseViewInfo {
    pub view: String,
    pub site: Option<String>,
    pub url: String,
    pub title: Option<String>,
    pub active: bool,
}

/// Open Browse views with their site names, for agent tools.
pub fn list_views(app: &AppHandle) -> Vec<BrowseViewInfo> {
    let active = ACTIVE.lock().ok().and_then(|a| a.clone());
    let titles = TITLES
        .lock()
        .ok()
        .and_then(|t| t.clone())
        .unwrap_or_default();
    let sites = app
        .try_state::<crate::features::system::settings::AppSettingsStore>()
        .and_then(|store| store.get().ok())
        .map(|state| state.settings.browse_sites)
        .unwrap_or_default();
    user_views(app)
        .into_iter()
        .map(|view| {
            let label = view.label().to_string();
            BrowseViewInfo {
                site: sites
                    .iter()
                    .find(|site| label.ends_with(&format!("-{}", site.id)))
                    .map(|site| site.name.clone()),
                url: view.url().map(|u| u.to_string()).unwrap_or_default(),
                title: titles.get(&label).cloned(),
                active: active.as_deref() == Some(label.as_str()),
                view: label,
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_major() -> u32 {
    use std::sync::OnceLock;
    static MAJOR: OnceLock<u32> = OnceLock::new();
    *MAJOR.get_or_init(|| {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|v| v.trim().split('.').next()?.parse().ok())
            .unwrap_or(0)
    })
}

/// Whether Browse has its own profile. On macOS 12–13 WKWebView only offers
/// the shared default store, so clearing everything would also wipe Edda's
/// own webview storage.
pub fn profile_isolated() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_major() >= 14
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

fn with_profile<R: Runtime>(builder: WebviewBuilder<R>) -> WebviewBuilder<R> {
    #[cfg(target_os = "macos")]
    {
        if profile_isolated() {
            return builder.data_store_identifier(*b"edda-browse-v1\0\0");
        }
        builder
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.data_directory(crate::core::paths::app_data_dir().join("browse-profile"))
    }
}

/// `<Downloads>/<name>`, or `<name> (n)` when taken.
fn download_target(name: &str) -> PathBuf {
    let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = path.extension().and_then(|e| e.to_str());
    let mut candidate = dir.join(name);
    let mut n = 1;
    while candidate.exists() {
        let numbered = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        candidate = dir.join(numbered);
        n += 1;
    }
    candidate
}

fn file_name_from(url: &Url) -> String {
    url.path_segments()
        .and_then(|mut segments| segments.next_back().map(str::to_string))
        .map(|name| {
            urlencoding::decode(&name)
                .map(|n| n.into_owned())
                .unwrap_or(name)
        })
        .filter(|name| !name.is_empty() && !name.contains(['/', '\\']))
        .unwrap_or_else(|| "download".into())
}

fn emit_page<R: Runtime>(app: &AppHandle<R>, label: &str, url: &Url, loading: bool) {
    let _ = app.emit(
        PAGE_EVENT,
        BrowsePageEvent {
            label: label.into(),
            url: url.to_string(),
            title: None,
            loading,
        },
    );
}

/// Forward a verified page action to the app, rate limited per view and kind
/// (see [`bridge::BrowseAction::throttle`]).
fn handle_action<R: Runtime>(app: &AppHandle<R>, label: &str, url: &Url) {
    let allowed = with_state(|views| {
        let state = views.get_mut(label)?;
        let action = bridge::parse_action(url, &state.token)?;
        let (bucket, gap) = action.throttle();
        let now = std::time::Instant::now();
        let last = state.last_action.get(bucket);
        if last.is_some_and(|at| now.duration_since(*at) < std::time::Duration::from_millis(gap)) {
            return None;
        }
        state.last_action.insert(bucket, now);
        Some(action)
    });
    let Some(action) = allowed else { return };
    let kind = action.kind().to_string();
    let (target, selection) = match action {
        bridge::BrowseAction::Import(target) => (Some(target), None),
        bridge::BrowseAction::Selection(selection) => (None, Some(selection)),
    };
    let _ = app.emit(
        ACTION_EVENT,
        BrowseActionEvent {
            label: label.into(),
            kind,
            target,
            selection,
        },
    );
}

fn build_view<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: Url,
    token: &str,
    ui: Option<&bridge::BrowseUiLabels>,
) -> WebviewBuilder<R> {
    let nav_app = app.clone();
    let nav_label = label.to_string();
    let load_app = app.clone();
    let load_label = label.to_string();
    let popup_app = app.clone();
    let popup_label = label.to_string();
    let download_app = app.clone();
    let download_label = label.to_string();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_navigation(move |url| match url.scheme() {
            "http" | "https" | "about" | "blob" | "data" => true,
            // Import buttons; never a real navigation.
            "edda-action" => {
                handle_action(&nav_app, &nav_label, url);
                false
            }
            // mailto:, tel:, app links … belong to the system.
            _ => {
                let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
                false
            }
        })
        .on_page_load(move |webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_page(&load_app, &load_label, payload.url(), loading);
            if loading {
                return;
            }
            let (app, label, url) = (
                load_app.clone(),
                load_label.clone(),
                payload.url().to_string(),
            );
            let _ = webview.eval_with_callback("document.title", move |title| {
                let title = serde_json::from_str::<String>(&title)
                    .ok()
                    .filter(|t| !t.trim().is_empty());
                if let (Some(title), Ok(mut titles)) = (&title, TITLES.lock()) {
                    titles
                        .get_or_insert_with(HashMap::new)
                        .insert(label.clone(), title.clone());
                }
                let _ = app.emit(
                    PAGE_EVENT,
                    BrowsePageEvent {
                        label: label.clone(),
                        url: url.clone(),
                        title,
                        loading: false,
                    },
                );
            });
        })
        // Popups (sign-in windows included) open in the same view.
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                if let Some(view) = popup_app.get_webview(&popup_label) {
                    let _ = view.navigate(url);
                }
            } else {
                let _ = popup_app.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_view, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    *destination = download_target(&file_name_from(&url));
                }
                DownloadEvent::Finished { url, path, success } => {
                    let path = path.unwrap_or_default();
                    let _ = download_app.emit(
                        DOWNLOAD_EVENT,
                        BrowseDownloadEvent {
                            label: download_label.clone(),
                            name: file_name_from(&url),
                            path: path.display().to_string(),
                            ok: success,
                        },
                    );
                }
                _ => {}
            }
            true
        });
    let builder = bridge::init_scripts(token, ui)
        .into_iter()
        .fold(builder, |b, script| {
            b.initialization_script_for_all_frames(script)
        });
    with_profile(builder)
}

/// Create a view in `window` and remember how to rebuild it.
fn create_view(
    app: &AppHandle,
    window: &str,
    label: &str,
    url: Url,
    rect: BrowseRect,
    visible: bool,
    ui: Option<bridge::BrowseUiLabels>,
) -> Result<(), String> {
    let window_handle = app.get_window(window).ok_or("window not found")?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let view = window_handle
        .add_child(
            build_view(app, label, url, &token, ui.as_ref()),
            LogicalPosition::new(rect.x, rect.y),
            LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    if !visible {
        let _ = view.hide();
    }
    with_state(|views| {
        views.insert(
            label.to_string(),
            ViewState {
                window: window.to_string(),
                rect,
                visible,
                token,
                ui,
                last_action: HashMap::new(),
            },
        )
    });
    Ok(())
}

/// Reload every open view with the current adapters (scripts are fixed at
/// creation, so the view is recreated at its current page).
pub async fn rebuild_views(app: &AppHandle) {
    let _lifecycle = VIEW_LIFECYCLE.lock().await;
    for view in user_views(app) {
        let label = view.label().to_string();
        let Some(state) = with_state(|views| views.get(&label).cloned()) else {
            continue;
        };
        let url = view
            .url()
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https"));
        let Some(url) = url else { continue };
        if view.close().is_err() {
            continue;
        }
        let _ = create_view(
            app,
            &state.window,
            &label,
            url,
            state.rect,
            state.visible,
            state.ui,
        );
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseOpenArgs {
    /// `browse-<window>-<site>`.
    pub label: String,
    /// Window hosting the panel.
    pub window: String,
    /// Loaded only when the view is created; an existing view keeps its page.
    pub url: String,
    pub rect: BrowseRect,
    /// Selection toolbar strings in the app's language.
    pub labels: bridge::BrowseUiLabels,
}

/// Create the view for a panel, or show the existing one at `rect`.
#[tauri::command]
#[specta::specta]
pub async fn browse_open(app: AppHandle, args: BrowseOpenArgs) -> Result<ApiResult<bool>, String> {
    if !valid_label(&args.label) {
        return Err("invalid browse view label".into());
    }
    let _lifecycle = VIEW_LIFECYCLE.lock().await;
    let position = LogicalPosition::new(args.rect.x, args.rect.y);
    let size = LogicalSize::new(args.rect.width.max(1.0), args.rect.height.max(1.0));
    set_active(&args.label);
    if let Some(view) = app.get_webview(&args.label) {
        with_state(|views| {
            if let Some(state) = views.get_mut(&args.label) {
                state.rect = args.rect;
                state.visible = true;
            }
        });
        let _ = view.set_position(position);
        let _ = view.set_size(size);
        let _ = view.show();
        return Ok(ApiResult::ok(true));
    }
    let url = Url::parse(&args.url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http(s) sites can be browsed".into());
    }
    create_view(
        &app,
        &args.window,
        &args.label,
        url,
        args.rect,
        true,
        Some(args.labels),
    )?;
    Ok(ApiResult::ok(true))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseBoundsArgs {
    pub label: String,
    pub rect: BrowseRect,
    pub visible: bool,
}

/// Follow the panel; hidden while the panel is inactive or covered.
#[tauri::command]
#[specta::specta]
pub async fn browse_bounds(
    app: AppHandle,
    args: BrowseBoundsArgs,
) -> Result<ApiResult<bool>, String> {
    let _lifecycle = VIEW_LIFECYCLE.lock().await;
    let Some(view) = browse_view(&app, &args.label) else {
        return Ok(ApiResult::ok(false));
    };
    with_state(|views| {
        if let Some(state) = views.get_mut(&args.label) {
            state.visible = args.visible;
            if args.visible {
                state.rect = args.rect;
            }
        }
    });
    if args.visible {
        set_active(&args.label);
        let _ = view.set_position(LogicalPosition::new(args.rect.x, args.rect.y));
        let _ = view.set_size(LogicalSize::new(
            args.rect.width.max(1.0),
            args.rect.height.max(1.0),
        ));
        let _ = view.show();
    } else {
        let _ = view.hide();
    }
    Ok(ApiResult::ok(true))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseNavArgs {
    pub label: String,
    /// `back`, `forward`, `reload`, or an `http(s)` URL.
    pub to: String,
}

#[tauri::command]
#[specta::specta]
pub async fn browse_nav(app: AppHandle, args: BrowseNavArgs) -> Result<ApiResult<bool>, String> {
    let Some(view) = browse_view(&app, &args.label) else {
        return Ok(ApiResult::ok(false));
    };
    let done = match args.to.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        to => {
            let url = Url::parse(to).map_err(|e| format!("invalid url: {e}"))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("only http(s) addresses can be opened".into());
            }
            view.navigate(url)
        }
    };
    done.map_err(|e| e.to_string())?;
    Ok(ApiResult::ok(true))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseLabelArgs {
    pub label: String,
}

/// Capture the visible viewport for the app's temporary overlay handoff.
#[tauri::command]
#[specta::specta]
pub async fn browse_snapshot(app: AppHandle, args: BrowseLabelArgs) -> Result<String, String> {
    let view = {
        let _lifecycle = VIEW_LIFECYCLE.lock().await;
        browse_view(&app, &args.label).ok_or("browse view not open")?
    };
    snapshot::capture(&view).await
}

/// Close a site's view (its tab closed or the site was removed).
#[tauri::command]
#[specta::specta]
pub async fn browse_close(
    app: AppHandle,
    args: BrowseLabelArgs,
) -> Result<ApiResult<bool>, String> {
    let _lifecycle = VIEW_LIFECYCLE.lock().await;
    if let Some(view) = browse_view(&app, &args.label) {
        view.close().map_err(|e| e.to_string())?;
    }
    if let Ok(mut titles) = TITLES.lock() {
        if let Some(titles) = titles.as_mut() {
            titles.remove(&args.label);
        }
    }
    with_state(|views| views.remove(&args.label));
    Ok(ApiResult::ok(true))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseReadArgs {
    pub label: String,
    pub query: page::PageQuery,
}

/// Read one layer of a view's page (JSON; see [`page::PagePart`]).
#[tauri::command]
#[specta::specta]
pub async fn browse_read(
    app: AppHandle,
    args: BrowseReadArgs,
) -> Result<ApiResult<String>, String> {
    let view = browse_view(&app, &args.label).ok_or("browse view not open")?;
    let value = page::read_page(&view, &args.query).await?;
    Ok(ApiResult::ok(value.to_string()))
}

/// The view's current address; follows in-page (pushState) navigation, which
/// fires no page-load event.
#[tauri::command]
#[specta::specta]
pub async fn browse_location(app: AppHandle, args: BrowseLabelArgs) -> Option<String> {
    browse_view(&app, &args.label)?
        .url()
        .ok()
        .map(|u| u.to_string())
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseOverlayArgs {
    pub label: String,
    /// JSON for the page's selection overlay: `{type: "card", text?, error?}`,
    /// `{type: "close"}` or `{type: "clear"}`.
    pub message: String,
}

/// Update the selection toolbar / translation card drawn in a view's page.
#[tauri::command]
#[specta::specta]
pub async fn browse_overlay(
    app: AppHandle,
    args: BrowseOverlayArgs,
) -> Result<ApiResult<bool>, String> {
    let Some(view) = browse_view(&app, &args.label) else {
        return Ok(ApiResult::ok(false));
    };
    let message: serde_json::Value =
        serde_json::from_str(&args.message).map_err(|e| e.to_string())?;
    view.eval(format!("window.__edda && window.__edda.overlay({message})"))
        .map_err(|e| e.to_string())?;
    Ok(ApiResult::ok(true))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseUrlArgs {
    pub url: String,
}

/// Adapters (enabled or not) whose patterns cover `url`.
#[tauri::command]
#[specta::specta]
pub fn browse_adapters_for(args: BrowseUrlArgs) -> Vec<adapter::AdapterInfo> {
    let Ok(url) = Url::parse(&args.url) else {
        return Vec::new();
    };
    let host = url.host_str().unwrap_or_default();
    adapter::list()
        .into_iter()
        .filter(|a| {
            a.patterns
                .iter()
                .any(|p| adapter::pattern_matches(p, host, url.path()))
        })
        .collect()
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseAdapterToggleArgs {
    pub ids: Vec<String>,
    pub enabled: bool,
}

/// Turn adapters on or off and reload the open views.
#[tauri::command]
#[specta::specta]
pub async fn browse_adapter_set_enabled(
    app: AppHandle,
    args: BrowseAdapterToggleArgs,
) -> Result<ApiResult<bool>, String> {
    for id in &args.ids {
        if let Err(e) = adapter::set_enabled(id, args.enabled) {
            return Ok(ApiResult::err(e));
        }
    }
    rebuild_views(&app).await;
    Ok(ApiResult::ok(true))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseAdapterRevertArgs {
    pub id: String,
    pub version: u32,
}

/// Restore an adapter version (undo of an agent change) and reload the views.
#[tauri::command]
#[specta::specta]
pub async fn browse_adapter_revert(
    app: AppHandle,
    args: BrowseAdapterRevertArgs,
) -> Result<ApiResult<adapter::AdapterInfo>, String> {
    Ok(match adapter::revert(&args.id, args.version) {
        Ok(info) => {
            rebuild_views(&app).await;
            ApiResult::ok(info)
        }
        Err(e) => ApiResult::err(e),
    })
}

/// A webview on the Browse profile: an open one, or a hidden temporary one.
fn with_profile_view<T>(
    app: &AppHandle,
    run: impl FnOnce(&tauri::Webview) -> tauri::Result<T>,
) -> Result<T, String> {
    if let Some(view) = app
        .webviews()
        .into_values()
        .find(|view| view.label().starts_with(LABEL_PREFIX))
    {
        return run(&view).map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("main window not found")?;
    let label = format!("{LABEL_PREFIX}maintenance");
    let builder = with_profile(WebviewBuilder::new(
        &label,
        WebviewUrl::External(Url::parse("about:blank").expect("static url")),
    ));
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    let _ = view.hide();
    let result = run(&view).map_err(|e| e.to_string());
    let _ = view.close();
    result
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseClearSiteArgs {
    /// Any page of the site; cookies for its host are removed.
    pub url: String,
}

/// Sign the user out of one site by deleting the cookies sent to its host.
#[tauri::command]
#[specta::specta]
pub async fn browse_clear_site(
    app: AppHandle,
    args: BrowseClearSiteArgs,
) -> Result<ApiResult<u32>, String> {
    let url = Url::parse(&args.url).map_err(|e| format!("invalid url: {e}"))?;
    let removed = with_profile_view(&app, |view| {
        let cookies = view.cookies_for_url(url.clone())?;
        let count = cookies.len() as u32;
        for cookie in cookies {
            view.delete_cookie(cookie)?;
        }
        Ok(count)
    })?;
    Ok(ApiResult::ok(removed))
}

/// Clear every site's cookies and storage. Refused where the profile is shared
/// with Edda's own webview (macOS 12–13).
#[tauri::command]
#[specta::specta]
pub async fn browse_clear_all(app: AppHandle) -> Result<ApiResult<bool>, String> {
    if !profile_isolated() {
        return Ok(ApiResult::ok(false));
    }
    with_profile_view(&app, |view| view.clear_all_browsing_data())?;
    Ok(ApiResult::ok(true))
}

/// Whether [`browse_clear_all`] is available on this system.
#[tauri::command]
#[specta::specta]
pub fn browse_profile_isolated() -> bool {
    profile_isolated()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_namespaced_and_plain() {
        assert!(valid_label("browse-main-springer"));
        assert!(!valid_label("main"));
        assert!(!valid_label("browse-../x"));
    }

    #[test]
    fn download_names_come_from_the_url_path() {
        let url = Url::parse("https://example.com/files/A%20paper.pdf?x=1").unwrap();
        assert_eq!(file_name_from(&url), "A paper.pdf");
        assert_eq!(
            file_name_from(&Url::parse("https://example.com/").unwrap()),
            "download"
        );
    }
}
