//! Site adapters: layout CSS and page scripts injected into Browse views.
//!
//! An adapter applies to pages whose URL matches one of its patterns
//! (`host`, `*.domain`, optionally followed by a path prefix). Presets ship
//! with the app and are read-only; users and agents write a layer on top of
//! them, or their own adapters, under `<config>/browse/adapters/<id>/`:
//!
//! ```text
//! adapter.json   name, patterns, enabled
//! layout.css     ≤ 64 KiB
//! page.js        ≤ 32 KiB, checked by [`check_js`]
//! history/<n>/   every write, the last 30 kept; revert restores one
//! ```
//!
//! The checks narrow what an adapter does (look at the page, restyle it,
//! declare papers to import); they are not a sandbox, since adapters run in
//! the page's own context. See docs/development/browse.md §4.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::core::error::AppError;

const MAX_CSS: usize = 64 * 1024;
const MAX_JS: usize = 32 * 1024;
const MAX_PATTERNS: usize = 10;
const KEEP_VERSIONS: usize = 30;

struct Preset {
    id: &'static str,
    name: &'static str,
    patterns: &'static [&'static str],
    css: &'static str,
    js: &'static str,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "arxiv",
        name: "arXiv",
        patterns: &["arxiv.org"],
        css: "",
        js: include_str!("presets/arxiv.js"),
    },
    Preset {
        id: "coolpapers",
        name: "Cool Papers",
        patterns: &["papers.cool"],
        css: "",
        js: include_str!("presets/coolpapers.js"),
    },
    Preset {
        id: "modelscope",
        name: "ModelScope",
        patterns: &["modelscope.cn/papers"],
        css: include_str!("presets/modelscope.css"),
        js: include_str!("presets/modelscope.js"),
    },
];

fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// What `adapter.json` keeps for a user layer.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default)]
    name: String,
    #[serde(default)]
    patterns: Vec<String>,
    #[serde(default = "yes")]
    enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub id: String,
    pub name: String,
    pub patterns: Vec<String>,
    pub enabled: bool,
    /// Ships with the app; only a layer on top of it can be written.
    pub preset: bool,
    /// A user / agent layer exists.
    pub layer: bool,
    /// Latest history version (0 = none).
    pub version: u32,
}

/// Everything an adapter injects.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterFiles {
    #[serde(flatten)]
    pub info: AdapterInfo,
    pub preset_css: String,
    pub preset_js: String,
    pub css: String,
    pub js: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterPatch {
    pub name: Option<String>,
    pub patterns: Option<Vec<String>>,
    /// Replaces the layer's CSS; `""` clears it.
    pub css: Option<String>,
    /// Replaces the layer's script; `""` clears it.
    pub js: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AdapterVersion {
    pub version: u32,
    pub note: String,
    pub at: String,
}

fn root() -> PathBuf {
    crate::core::paths::app_config_dir()
        .join("browse")
        .join("adapters")
}

pub fn valid_id(id: &str) -> bool {
    (1..=48).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
}

/// `link.springer.com` → `link-springer-com`.
pub fn id_for_host(host: &str) -> String {
    let id: String = host
        .trim_start_matches("www.")
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    id.trim_matches('-').chars().take(48).collect()
}

fn dir(id: &str) -> Result<PathBuf, AppError> {
    if !valid_id(id) {
        return Err(AppError::message(
            "adapter id must be 1–48 of a-z, 0-9 and -",
        ));
    }
    Ok(root().join(id))
}

fn read_text(path: PathBuf) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn stored(id: &str) -> Option<Stored> {
    let raw = fs::read(dir(id).ok()?.join("adapter.json")).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn versions(id: &str) -> Vec<u32> {
    let mut out: Vec<u32> = dir(id)
        .ok()
        .and_then(|d| fs::read_dir(d.join("history")).ok())
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    out.sort_unstable();
    out
}

fn info(id: &str) -> Option<AdapterInfo> {
    let stored = stored(id);
    let preset = preset(id);
    if stored.is_none() && preset.is_none() {
        return None;
    }
    let base = dir(id).ok()?;
    let layer = base.join("layout.css").is_file() || base.join("page.js").is_file();
    let (name, patterns) = match (preset, &stored) {
        (Some(p), _) => (
            p.name.to_string(),
            p.patterns.iter().map(|s| s.to_string()).collect(),
        ),
        (None, Some(s)) => (s.name.clone(), s.patterns.clone()),
        (None, None) => unreachable!(),
    };
    Some(AdapterInfo {
        id: id.to_string(),
        name,
        patterns,
        enabled: stored.map(|s| s.enabled).unwrap_or(true),
        preset: preset.is_some(),
        layer,
        version: versions(id).last().copied().unwrap_or(0),
    })
}

/// Presets first, then user adapters by id.
pub fn list() -> Vec<AdapterInfo> {
    let mut ids: Vec<String> = PRESETS.iter().map(|p| p.id.to_string()).collect();
    let mut own: Vec<String> = fs::read_dir(root())
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok()?.file_name().to_str().map(str::to_string))
        .filter(|id| valid_id(id) && preset(id).is_none())
        .collect();
    own.sort();
    ids.extend(own);
    ids.iter().filter_map(|id| info(id)).collect()
}

pub fn read(id: &str) -> Result<AdapterFiles, AppError> {
    let info = info(id).ok_or_else(|| AppError::message(format!("no adapter {id}")))?;
    let base = dir(id)?;
    let preset = preset(id);
    Ok(AdapterFiles {
        info,
        preset_css: preset.map(|p| p.css.to_string()).unwrap_or_default(),
        preset_js: preset.map(|p| p.js.to_string()).unwrap_or_default(),
        css: read_text(base.join("layout.css")),
        js: read_text(base.join("page.js")),
    })
}

/// `host` or `*.domain`, optionally followed by `/path-prefix`.
fn check_pattern(pattern: &str) -> Result<(), AppError> {
    let (host, _) = pattern.split_once('/').unwrap_or((pattern, ""));
    let bare = host.strip_prefix("*.").unwrap_or(host);
    let ok = bare.contains('.')
        && !bare.starts_with('.')
        && !bare.ends_with('.')
        && bare
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !pattern.chars().any(char::is_whitespace);
    if ok {
        Ok(())
    } else {
        Err(AppError::message(format!(
            "pattern {pattern:?} must be a lowercase host or *.domain, optionally with a /path prefix"
        )))
    }
}

/// Whether `pattern` covers `host` + `path` (the page URL's parts).
pub fn pattern_matches(pattern: &str, host: &str, path: &str) -> bool {
    let (want_host, prefix) = match pattern.split_once('/') {
        Some((h, p)) => (h, format!("/{p}")),
        None => (pattern, String::new()),
    };
    let host = host.to_ascii_lowercase();
    let host_ok = match want_host.strip_prefix("*.") {
        Some(domain) => host == domain || host.ends_with(&format!(".{domain}")),
        None => host == want_host || host == format!("www.{want_host}"),
    };
    host_ok && path.starts_with(&prefix)
}

/// Collapse whitespace so `fetch (` and `new  Function` are caught alike.
fn squash(source: &str) -> String {
    source.chars().filter(|c| !c.is_whitespace()).collect()
}

fn has_token(squashed: &str, token: &str) -> bool {
    squashed.match_indices(token).any(|(at, _)| {
        let before = squashed[..at].chars().next_back();
        // `prefetch(` is not `fetch(`; `.fetch(` and `(fetch(` are.
        !matches!(before, Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '$')
            || token.starts_with('.')
    })
}

/// Reject what a page script must not do: reach storage or the network,
/// submit forms, load code, or talk to the app other than through `edda.*`.
pub fn check_js(source: &str) -> Result<(), AppError> {
    if source.len() > MAX_JS {
        return Err(AppError::message("page.js exceeds 32 KiB"));
    }
    let s = squash(source);
    let forbidden = [
        ("document.cookie", "cookies"),
        ("localStorage", "localStorage"),
        ("sessionStorage", "sessionStorage"),
        ("indexedDB", "indexedDB"),
        ("fetch(", "fetch"),
        ("XMLHttpRequest", "XMLHttpRequest"),
        ("WebSocket", "WebSocket"),
        ("EventSource", "EventSource"),
        ("sendBeacon", "sendBeacon"),
        (".submit(", "form submission"),
        ("requestSubmit", "form submission"),
        ("eval(", "eval"),
        ("Function(", "Function constructor"),
        ("newFunction(", "Function constructor"),
        ("import(", "dynamic import"),
        ("importScripts", "importScripts"),
        ("createElement('script'", "script elements"),
        ("createElement(\"script\"", "script elements"),
        ("window.open(", "window.open"),
        ("postMessage", "postMessage"),
        ("edda-action", "edda-action links (use edda.importButton)"),
        ("location=", "navigation"),
        ("location.href=", "navigation"),
        ("location.assign(", "navigation"),
        ("location.replace(", "navigation"),
    ];
    for (token, what) in forbidden {
        if has_token(&s, token) {
            return Err(AppError::message(format!(
                "page.js may not use {what}; return data through edda.* instead"
            )));
        }
    }
    Ok(())
}

/// CSS may restyle the page but not load anything from elsewhere.
pub fn check_css(source: &str) -> Result<(), AppError> {
    if source.len() > MAX_CSS {
        return Err(AppError::message("layout.css exceeds 64 KiB"));
    }
    let s = squash(source).to_ascii_lowercase();
    if s.contains("@import") || s.contains("expression(") {
        return Err(AppError::message(
            "layout.css may not use @import or expression()",
        ));
    }
    for (at, _) in s.match_indices("url(") {
        let target = s[at + 4..].trim_start_matches(['\'', '"']);
        if target.starts_with("http:") || target.starts_with("https:") || target.starts_with("//") {
            return Err(AppError::message(
                "layout.css may not load remote url(); use data: URIs",
            ));
        }
    }
    Ok(())
}

fn write_layer(base: &std::path::Path, css: &str, js: &str) -> Result<(), AppError> {
    for (name, body) in [("layout.css", css), ("page.js", js)] {
        let path = base.join(name);
        if body.is_empty() {
            let _ = fs::remove_file(path);
        } else {
            crate::core::fs::atomic_write(&path, body.as_bytes())?;
        }
    }
    Ok(())
}

/// Save the current state as the next history version.
fn record(id: &str, note: &str) -> Result<u32, AppError> {
    let base = dir(id)?;
    let next = versions(id).last().copied().unwrap_or(0) + 1;
    let version_dir = base.join("history").join(next.to_string());
    fs::create_dir_all(&version_dir)?;
    for name in ["adapter.json", "layout.css", "page.js"] {
        if base.join(name).is_file() {
            fs::copy(base.join(name), version_dir.join(name))?;
        }
    }
    crate::core::fs::json_store(
        &version_dir.join("version.json"),
        &AdapterVersion {
            version: next,
            note: note.chars().take(300).collect(),
            at: crate::core::time::now_rfc3339_millis(),
        },
    )?;
    let all = versions(id);
    for old in &all[..all.len().saturating_sub(KEEP_VERSIONS)] {
        let _ = fs::remove_dir_all(base.join("history").join(old.to_string()));
    }
    Ok(next)
}

/// Create or change an adapter (a layer, for presets) and record a version.
pub fn write(id: &str, patch: AdapterPatch, note: &str) -> Result<AdapterInfo, AppError> {
    let base = dir(id)?;
    let current = read(id).ok();
    let mut meta = stored(id).unwrap_or_default();
    if preset(id).is_none() {
        if let Some(name) = patch
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
        {
            meta.name = name.chars().take(60).collect();
        }
        if let Some(patterns) = patch.patterns {
            meta.patterns = patterns
                .into_iter()
                .map(|p| p.trim().to_ascii_lowercase())
                .filter(|p| !p.is_empty())
                .collect();
        }
        if meta.patterns.is_empty() || meta.patterns.len() > MAX_PATTERNS {
            return Err(AppError::message("an adapter needs 1–10 URL patterns"));
        }
        for pattern in &meta.patterns {
            check_pattern(pattern)?;
        }
        if meta.name.is_empty() {
            meta.name = meta.patterns[0].clone();
        }
    }
    if let Some(enabled) = patch.enabled {
        meta.enabled = enabled;
    } else if current.is_none() {
        meta.enabled = true;
    }
    let css = patch
        .css
        .unwrap_or_else(|| current.as_ref().map(|c| c.css.clone()).unwrap_or_default());
    let js = patch
        .js
        .unwrap_or_else(|| current.as_ref().map(|c| c.js.clone()).unwrap_or_default());
    check_css(&css)?;
    check_js(&js)?;
    fs::create_dir_all(&base)?;
    crate::core::fs::json_store(&base.join("adapter.json"), &meta)?;
    write_layer(&base, &css, &js)?;
    record(id, note)?;
    info(id).ok_or_else(|| AppError::message("adapter vanished"))
}

/// Turn an adapter (preset included) on or off without a new version.
pub fn set_enabled(id: &str, enabled: bool) -> Result<(), AppError> {
    let mut meta = stored(id)
        .or_else(|| preset(id).map(|_| Stored::default()))
        .ok_or_else(|| AppError::message(format!("no adapter {id}")))?;
    meta.enabled = enabled;
    let base = dir(id)?;
    fs::create_dir_all(&base)?;
    crate::core::fs::json_store(&base.join("adapter.json"), &meta)
}

pub fn history(id: &str) -> Vec<AdapterVersion> {
    let Ok(base) = dir(id) else { return Vec::new() };
    versions(id)
        .into_iter()
        .rev()
        .filter_map(|v| {
            let raw = fs::read(
                base.join("history")
                    .join(v.to_string())
                    .join("version.json"),
            )
            .ok()?;
            serde_json::from_slice(&raw).ok()
        })
        .collect()
}

/// Restore version `version` (0 = no layer at all), recorded as a new version.
pub fn revert(id: &str, version: u32) -> Result<AdapterInfo, AppError> {
    let base = dir(id)?;
    if version == 0 {
        write_layer(&base, "", "")?;
        if preset(id).is_none() {
            let mut meta = stored(id).unwrap_or_default();
            meta.enabled = false;
            crate::core::fs::json_store(&base.join("adapter.json"), &meta)?;
        }
    } else {
        let from = base.join("history").join(version.to_string());
        if !from.is_dir() {
            return Err(AppError::message(format!("no version {version} of {id}")));
        }
        for name in ["adapter.json", "layout.css", "page.js"] {
            let _ = fs::remove_file(base.join(name));
            if from.join(name).is_file() {
                fs::copy(from.join(name), base.join(name))?;
            }
        }
    }
    record(id, &format!("revert to version {version}"))?;
    info(id).ok_or_else(|| AppError::message(format!("no adapter {id}")))
}

/// One injected layer.
#[derive(Debug, Clone, Serialize)]
pub struct Layer {
    /// `<id>` for the preset part, `<id>/user` for the layer.
    pub key: String,
    pub css: String,
    pub js: String,
}

/// Enabled adapters with their patterns and layers, for injection.
pub fn active() -> Vec<(AdapterInfo, Vec<Layer>)> {
    list()
        .into_iter()
        .filter(|a| a.enabled)
        .filter_map(|info| {
            let files = read(&info.id).ok()?;
            let mut layers = Vec::new();
            if !files.preset_css.is_empty() || !files.preset_js.is_empty() {
                layers.push(Layer {
                    key: info.id.clone(),
                    css: files.preset_css,
                    js: files.preset_js,
                });
            }
            if !files.css.is_empty() || !files.js.is_empty() {
                layers.push(Layer {
                    key: format!("{}/user", info.id),
                    css: files.css,
                    js: files.js,
                });
            }
            (!layers.is_empty()).then_some((info, layers))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_match_hosts_subdomains_and_paths() {
        assert!(pattern_matches("arxiv.org", "arxiv.org", "/abs/1"));
        assert!(pattern_matches("arxiv.org", "www.arxiv.org", "/"));
        assert!(!pattern_matches("arxiv.org", "export.arxiv.org", "/"));
        assert!(pattern_matches(
            "*.sciencedirect.com",
            "www.sciencedirect.com",
            "/"
        ));
        assert!(pattern_matches(
            "*.sciencedirect.com",
            "sciencedirect.com",
            "/"
        ));
        assert!(pattern_matches(
            "ieeexplore.ieee.org/document/",
            "ieeexplore.ieee.org",
            "/document/1"
        ));
        assert!(!pattern_matches(
            "ieeexplore.ieee.org/document/",
            "ieeexplore.ieee.org",
            "/search"
        ));
        assert!(check_pattern("*.ieee.org/xpl").is_ok());
        assert!(check_pattern("localhost").is_err());
        assert!(check_pattern("Example.com").is_err());
        assert_eq!(id_for_host("www.Link.springer.com"), "link-springer-com");
    }

    #[test]
    fn scripts_cannot_reach_storage_network_or_navigation() {
        assert!(check_js("edda.importButton(el, { doi: d });").is_ok());
        assert!(check_js("const x = prefetchList();").is_ok());
        for bad in [
            "document . cookie",
            "fetch ('/x')",
            "window.fetch('/x')",
            "new  Function('a')",
            "location.href = u",
            "localStorage.getItem('a')",
            "form.submit()",
        ] {
            assert!(check_js(bad).is_err(), "{bad}");
        }
        assert!(check_css("a { color: red; background: url(data:image/png;base64,AA) }").is_ok());
        assert!(check_css("a { background: url( 'https://evil.example/x' ) }").is_err());
        assert!(check_css("@import 'x.css';").is_err());
        for preset in PRESETS {
            assert!(check_js(preset.js).is_ok(), "preset {}", preset.id);
            assert!(check_css(preset.css).is_ok(), "preset {}", preset.id);
        }
    }
}
