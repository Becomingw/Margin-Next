//! The trusted bridge and adapter layers injected into every Browse frame.
//!
//! The bridge runs first and defines `window.__edda`, the only way adapters
//! reach the app. Each adapter layer is a separate initialization script, so
//! a syntax error disables that layer alone; the bridge reports layers that
//! never ran. Import buttons send `edda-action://import` on a real (trusted)
//! click, carrying a per-view token the page scripts cannot read.
//!
//! In views the user browses, the bridge also draws the selection toolbar
//! (translate / ask the agent) and the translation card in a closed shadow
//! root: app UI cannot float above a native view. Selections are reported as
//! `edda-action://selection`; the app streams the card back through
//! `__edda.overlay`.

use serde::{Deserialize, Serialize};

use super::adapter;

const BRIDGE_JS: &str = r##"(function (TOKEN, ADAPTERS, UI) {
  if (window.__edda) return;
  var host = location.hostname.toLowerCase(), path = location.pathname;
  var covers = function (p) {
    var i = p.indexOf("/"), h = i < 0 ? p : p.slice(0, i), pre = i < 0 ? "" : p.slice(i);
    var ok = h.indexOf("*.") === 0
      ? host === h.slice(2) || host.slice(-(h.length - 1)) === h.slice(1)
      : host === h || host === "www." + h;
    return ok && path.indexOf(pre) === 0;
  };
  var matched = [], layers = {}, loaded = {}, errors = [], targets = [], hooks = {}, current = null;
  ADAPTERS.forEach(function (a) {
    if (!a.patterns.some(covers)) return;
    matched.push(a.id);
    a.layers.forEach(function (k) { layers[k] = true; });
  });
  var fail = function (key, e) {
    if (errors.length < 20) errors.push({ layer: key, message: String((e && e.message) || e).slice(0, 300) });
  };
  var safe = function (key, fn) {
    try { return fn(); } catch (e) { fail(key, e); }
  };
  var whenReady = function (fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  };
  var str = function (v, n) {
    return typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined;
  };
  var target = function (t) {
    t = t || {};
    return { title: str(t.title, 500), doi: str(t.doi, 200), arxiv: str(t.arxiv, 60),
      url: str(t.url, 2000), pdfUrl: str(t.pdfUrl, 2000) };
  };
  var send = function (kind, data) {
    location.href = "edda-action://" + kind + "?t=" + TOKEN + "&d=" + encodeURIComponent(JSON.stringify(data));
  };
  var LABEL = "+ Edda";
  var api = {
    ready: function (fn) {
      var key = current;
      whenReady(function () { safe(key, fn); });
    },
    observe: function (fn) {
      var key = current, timer = 0;
      var run = function () { timer = 0; safe(key, fn); };
      whenReady(function () {
        run();
        new MutationObserver(function () {
          if (!timer) timer = setTimeout(run, 400);
        }).observe(document.body || document.documentElement, { childList: true, subtree: true });
      });
    },
    items: function (fn) { hooks.items = fn; },
    detail: function (fn) { hooks.detail = fn; },
    text: function (fn) { hooks.text = fn; },
    importTargets: function (fn) { hooks.targets = fn; },
    importButton: function (el, t) {
      if (!el || !el.parentNode) return;
      var next = el.nextElementSibling;
      if (next && next.hasAttribute("data-edda-import")) return;
      var data = target(t);
      if (!data.doi && !data.arxiv && !data.url) return;
      targets = targets.filter(function (x) { return x.el !== el; });
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = LABEL;
      b.title = "Add to the Edda library";
      b.setAttribute("data-edda-import", "");
      b.style.cssText = "all:initial;display:inline-block;margin:0 0 0 .5em;padding:1px 7px;border:1px solid rgba(122,75,42,.35);border-radius:999px;background:#fbf7f2;color:#7a4b2a;font:500 11px/1.6 -apple-system,system-ui,sans-serif;cursor:pointer;vertical-align:middle;white-space:nowrap";
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!ev.isTrusted || b.disabled) return;
        b.disabled = true;
        b.textContent = "✓ Edda";
        send("import", data);
        setTimeout(function () { b.disabled = false; b.textContent = LABEL; }, 4000);
      }, true);
      el.insertAdjacentElement("afterend", b);
      targets.push({ target: data, el: el });
    },
    markStable: function (selector, name) {
      var key = current;
      safe(key, function () {
        document.querySelectorAll(selector).forEach(function (n) { n.setAttribute("data-edda", String(name)); });
      });
    }
  };
  // ---- New windows open in this view (top frame) --------------------------
  // WKWebView drops target="_blank" links and script popups; a panel has no
  // other windows anyway. Script popups need a user gesture, so ads cannot
  // take over the page.
  if (window.top === window) {
    document.addEventListener("click", function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest("a[target]") : null;
      if (a && a.target && a.target !== "_self" && /^https?:/.test(a.href)) a.target = "_self";
    }, true);
    var nativeOpen = window.open;
    window.open = function (url) {
      var gesture = !navigator.userActivation || navigator.userActivation.isActive;
      try {
        var to = new URL(url, location.href);
        if (gesture && /^https?:$/.test(to.protocol)) {
          location.assign(to.href);
          return null;
        }
      } catch (e) {}
      return nativeOpen.apply(window, arguments);
    };
  }
  // ---- Selection toolbar and translation card (views the user browses) ----
  var overlay = null;
  if (UI && window.top === window) overlay = (function () {
    var CSS = ":host{all:initial}" +
      ".bar,.card{position:fixed;z-index:2147483647;box-sizing:border-box;border:1px solid rgba(0,0,0,.12);background:#fff;color:#1a1b21;box-shadow:0 6px 24px rgba(0,0,0,.14);font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}" +
      ".bar{display:flex;gap:2px;padding:3px;border-radius:8px;font-size:12px;font-weight:500;line-height:1}" +
      "button{all:unset;box-sizing:border-box;cursor:pointer;padding:6px 8px;border-radius:6px;white-space:nowrap}" +
      "button:hover{background:rgba(0,0,0,.06)}kbd{font:inherit;opacity:.5;margin-left:4px}" +
      ".card{width:min(380px,calc(100vw - 16px));max-height:45vh;display:flex;flex-direction:column;border-radius:10px;font-size:13px;line-height:1.55}" +
      ".head{display:flex;align-items:center;gap:2px;padding:4px 4px 0 12px;font-size:11px;color:#6b6b72}.head span{flex:1}.head button{padding:4px 6px}" +
      ".body{overflow:auto;padding:4px 12px 10px;white-space:pre-wrap;word-break:break-word}.muted{color:#8a8a90}.err{color:#b42318}" +
      "@media (prefers-color-scheme: dark){.bar,.card{background:#202126;color:#ececf0;border-color:rgba(255,255,255,.14)}button:hover{background:rgba(255,255,255,.08)}.head{color:#9a9aa2}}";
    var host = null, root = null, bar = null, card = null, body = null, text = "", staged = "";
    // The app keeps the selection staged, so ⌘L / ⌘K (app shortcuts that never
    // reach the page) quote it like in the PDF viewer.
    var stage = function (t) {
      if (t === staged) return;
      staged = t;
      send("selection", { action: "stage", text: t, url: location.href });
    };
    var mount = function () {
      if (host && host.isConnected) return;
      host = document.createElement("edda-overlay");
      root = host.attachShadow({ mode: "closed" });
      var style = document.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);
      document.documentElement.appendChild(host);
      bar = card = body = null;
    };
    var el = function (tag, cls, label) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (label) n.textContent = label;
      return n;
    };
    var selected = function () {
      var s = window.getSelection();
      return s ? String(s).trim().slice(0, 4000) : "";
    };
    var rectOf = function () {
      var s = window.getSelection();
      if (!s || !s.rangeCount) return null;
      var r = s.getRangeAt(0).getBoundingClientRect();
      return r.width || r.height ? r : null;
    };
    var place = function (node, r, below) {
      var w = node.offsetWidth, h = node.offsetHeight;
      var x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
      var y = below ? r.bottom + 8 : r.top - h - 8;
      if (y < 8) y = r.bottom + 8;
      if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 8);
      node.style.left = x + "px";
      node.style.top = y + "px";
    };
    var hideBar = function () {
      if (bar) bar.remove();
      bar = null;
    };
    var closeCard = function () {
      if (card) card.remove();
      card = body = null;
    };
    var act = function (action) {
      var t = selected() || text;
      if (!t) return;
      if (action === "translate") openCard(rectOf());
      hideBar();
      send("selection", { action: action, text: t, url: location.href });
    };
    var button = function (label, hint, onClick) {
      var b = el("button", null, label);
      if (hint) b.appendChild(el("kbd", null, hint));
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.isTrusted) onClick();
      });
      return b;
    };
    var showBar = function (r) {
      mount();
      hideBar();
      bar = el("div", "bar");
      bar.appendChild(button(UI.translate, null, function () { act("translate"); }));
      bar.appendChild(button(UI.ask, UI.shortcut, function () { act("ask"); }));
      // Keep the page selection while pressing a button.
      bar.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      root.appendChild(bar);
      place(bar, r, false);
    };
    var openCard = function (r) {
      mount();
      closeCard();
      card = el("div", "card");
      var head = el("div", "head");
      head.appendChild(el("span", null, UI.translate));
      head.appendChild(button(UI.copy, null, function () {
        var area = el("textarea");
        area.value = body ? body.textContent : "";
        root.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }));
      head.appendChild(button("✕", null, closeCard));
      body = el("div", "body muted", UI.translating);
      card.appendChild(head);
      card.appendChild(body);
      card.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });
      root.appendChild(card);
      place(card, r || { left: innerWidth / 2, width: 0, top: 80, bottom: 80 }, true);
    };
    var check = function () {
      setTimeout(function () {
        var t = selected(), r = t && rectOf();
        if (!t || !r) { hideBar(); stage(""); return; }
        text = t;
        showBar(r);
        stage(t);
      }, 10);
    };
    document.addEventListener("mouseup", function (ev) {
      if (ev.target === host) return;
      check();
    }, true);
    document.addEventListener("keyup", function (ev) {
      if (ev.shiftKey || ev.key === "Shift") check();
    }, true);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { hideBar(); closeCard(); return; }
      var k = (ev.key || "").toLowerCase();
      if ((ev.metaKey || ev.ctrlKey) && (k === "l" || k === "k") && selected()) {
        ev.preventDefault();
        ev.stopPropagation();
        act("ask");
      }
    }, true);
    document.addEventListener("selectionchange", function () {
      if (selected()) return;
      if (bar) hideBar();
      if (staged) stage("");
    });
    window.addEventListener("scroll", hideBar, true);
    return function (msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "clear") {
        hideBar();
        staged = "";
        var s = window.getSelection();
        if (s) s.removeAllRanges();
      } else if (msg.type === "close") {
        closeCard();
      } else if (msg.type === "card" && body) {
        body.className = "body" + (msg.error ? " err" : msg.text ? "" : " muted");
        body.textContent = msg.error || msg.text || UI.translating;
      }
    };
  })();
  var describe = function (el) {
    if (!el || !el.tagName) return null;
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    return s;
  };
  Object.defineProperty(window, "__edda", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      start: function (key) {
        if (!layers[key]) return null;
        loaded[key] = true;
        current = key;
        return api;
      },
      end: function () { current = null; },
      css: function (key, css) {
        if (!css) return;
        var s = document.createElement("style");
        s.setAttribute("data-edda-adapter", key);
        s.textContent = css;
        var add = function () {
          var root = document.head || document.documentElement;
          if (root) root.appendChild(s); else setTimeout(add, 0);
        };
        add();
      },
      fail: fail,
      status: function () {
        var missing = Object.keys(layers).filter(function (k) { return !loaded[k]; });
        return { matched: matched, errors: errors.concat(missing.map(function (k) {
          return { layer: k, message: "the layer did not run (syntax error?)" };
        })) };
      },
      targets: function () {
        var out = [];
        targets.forEach(function (t) {
          if (document.contains(t.el)) out.push(Object.assign({ near: describe(t.el) }, t.target));
        });
        if (hooks.targets) safe("importTargets", function () {
          (hooks.targets() || []).forEach(function (t) { out.push(target(t)); });
        });
        return out.slice(0, 300);
      },
      items: function () {
        return hooks.items ? safe("items", function () {
          return (hooks.items() || []).slice(0, 200).map(function (i) {
            return { title: str(i.title, 500), authors: str(i.authors, 500), summary: str(i.summary, 2000),
              doi: str(i.doi, 200), url: str(i.url, 2000) };
          });
        }) || null : null;
      },
      detail: function () {
        return hooks.detail ? safe("detail", function () { return target(hooks.detail()); }) || null : null;
      },
      text: function () {
        return hooks.text ? safe("text", function () { return str(hooks.text(), 400000); }) || null : null;
      },
      overlay: function (msg) {
        if (overlay) overlay(msg);
      }
    })
  });
})"##;

#[derive(Serialize)]
struct AdapterRef<'a> {
    id: &'a str,
    patterns: &'a [String],
    layers: Vec<&'a str>,
}

/// Selection toolbar strings, in the app's language.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseUiLabels {
    pub translate: String,
    pub ask: String,
    pub copy: String,
    pub translating: String,
    /// Shortcut hint beside "ask", e.g. `⌘L`.
    pub shortcut: String,
}

/// The bridge followed by one script per enabled adapter layer. `ui` turns on
/// the selection toolbar (views the user browses, not helper views).
pub fn init_scripts(token: &str, ui: Option<&BrowseUiLabels>) -> Vec<String> {
    let active = adapter::active();
    let refs: Vec<AdapterRef> = active
        .iter()
        .map(|(info, layers)| AdapterRef {
            id: &info.id,
            patterns: &info.patterns,
            layers: layers.iter().map(|l| l.key.as_str()).collect(),
        })
        .collect();
    let mut scripts = vec![format!(
        "{BRIDGE_JS}({}, {}, {});",
        json(&token),
        json(&refs),
        json(&ui)
    )];
    for (_, layers) in &active {
        for layer in layers {
            scripts.push(format!(
                "(function () {{\n  var e = window.__edda, edda = e && e.start({key});\n  if (!edda) return;\n  e.css({key}, {css});\n  try {{\n    (function (edda) {{\n{js}\n    }})(edda);\n  }} catch (x) {{\n    e.fail({key}, x);\n  }} finally {{\n    e.end();\n  }}\n}})();",
                key = json(&layer.key),
                css = json(&layer.css),
                js = layer.js,
            ));
        }
    }
    scripts
}

fn json<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// A paper an import button sent.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseImportTarget {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub arxiv: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub pdf_url: Option<String>,
}

impl BrowseImportTarget {
    /// DOI, then arXiv id, then URL.
    pub fn identifier(&self) -> Option<String> {
        self.doi
            .as_deref()
            .and_then(super::page::bare_doi)
            .or_else(|| self.arxiv.clone())
            .or_else(|| self.url.clone())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

/// Selected text the user acted on from the toolbar or with ⌘L / ⌘K.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseSelection {
    /// `translate`, `ask`, or `stage` (the current selection, empty when cleared).
    pub action: String,
    pub text: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub enum BrowseAction {
    Import(BrowseImportTarget),
    Selection(BrowseSelection),
}

impl BrowseAction {
    pub fn kind(&self) -> &'static str {
        match self {
            BrowseAction::Import(_) => "import",
            BrowseAction::Selection(_) => "selection",
        }
    }

    /// Rate-limit bucket and minimum gap: imports are rarer than selections,
    /// and staging must not swallow the toolbar click that follows it.
    pub fn throttle(&self) -> (&'static str, u64) {
        match self {
            BrowseAction::Import(_) => ("import", 700),
            BrowseAction::Selection(s) if s.action == "stage" => ("stage", 100),
            BrowseAction::Selection(_) => ("selection", 250),
        }
    }
}

/// Parse `edda-action://<kind>?t=<token>&d=<json>`; `None` unless the token
/// matches and the payload is usable.
pub fn parse_action(url: &tauri::Url, token: &str) -> Option<BrowseAction> {
    let kind = url.host_str()?;
    let mut sent_token = None;
    let mut data = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "t" => sent_token = Some(value.into_owned()),
            "d" => data = Some(value.into_owned()),
            _ => {}
        }
    }
    if sent_token.as_deref() != Some(token) {
        return None;
    }
    let data = data?;
    match kind {
        "import" => {
            let target: BrowseImportTarget = serde_json::from_str(&data).ok()?;
            target.identifier()?;
            Some(BrowseAction::Import(target))
        }
        "selection" => {
            let mut selection: BrowseSelection = serde_json::from_str(&data).ok()?;
            if !matches!(selection.action.as_str(), "translate" | "ask" | "stage") {
                return None;
            }
            selection.text = selection.text.trim().chars().take(4000).collect();
            // Only staging may be empty: it clears the staged selection.
            (selection.action == "stage" || !selection.text.is_empty())
                .then_some(BrowseAction::Selection(selection))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_need_the_view_token_and_an_identifier() {
        let url = |q: &str| tauri::Url::parse(&format!("edda-action://import?{q}")).unwrap();
        let data = urlencoding::encode(r#"{"arxiv":"1706.03762","title":"Attention"}"#);
        let Some(BrowseAction::Import(target)) =
            parse_action(&url(&format!("t=abc&d={data}")), "abc")
        else {
            panic!("import action expected");
        };
        assert_eq!(target.identifier().as_deref(), Some("1706.03762"));
        assert!(parse_action(&url(&format!("t=xyz&d={data}")), "abc").is_none());
        let empty = urlencoding::encode(r#"{"title":"x"}"#);
        assert!(parse_action(&url(&format!("t=abc&d={empty}")), "abc").is_none());
        let selection = |d: &str| {
            let u = format!("edda-action://selection?t=abc&d={}", urlencoding::encode(d));
            parse_action(&tauri::Url::parse(&u).unwrap(), "abc")
        };
        assert!(matches!(
            selection(r#"{"action":"translate","text":" hi ","url":"https://x.org"}"#),
            Some(BrowseAction::Selection(s)) if s.text == "hi"
        ));
        assert!(selection(r#"{"action":"delete","text":"hi","url":"u"}"#).is_none());
        assert!(selection(r#"{"action":"ask","text":"  ","url":"u"}"#).is_none());
        assert!(selection(r#"{"action":"stage","text":"","url":"u"}"#).is_some());
    }

    #[test]
    fn the_bridge_comes_first_with_the_token() {
        let scripts = init_scripts("tok", None);
        assert!(scripts[0].starts_with("(function (TOKEN, ADAPTERS, UI)"));
        assert!(scripts[0].contains("(\"tok\", ["));
        assert!(scripts[0].ends_with(", null);"));
    }
}
