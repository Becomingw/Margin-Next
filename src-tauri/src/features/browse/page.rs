//! Reading a Browse page in layers, for the page conversation and agent tools.
//!
//! The host runs a self-contained function in the page through
//! `eval_with_callback`; pages get no bridge or IPC. Everything that comes back
//! was built by the page, so callers treat it as untrusted data.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Runtime, Webview};

/// What to read from a page.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PagePart {
    /// URL, title, selection and paper metadata (`citation_*`, Dublin Core, JSON-LD).
    #[default]
    Summary,
    /// Landmarks, headings and repeated item lists, with selectors to read them.
    Outline,
    /// Main text (or one element's) in character windows.
    Text,
    /// DOI, arXiv and PDF links with their anchor text.
    Links,
    /// Papers the site adapter declares (import buttons, `importTargets`, `items`).
    Targets,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PageQuery {
    #[serde(default)]
    pub part: PagePart,
    /// `text`: first character to return.
    #[serde(default)]
    pub offset: Option<u32>,
    /// `text`: characters to return (default 8000, at most 16000).
    #[serde(default)]
    pub limit: Option<u32>,
    /// `text`: read this element instead of the main content.
    #[serde(default)]
    pub selector: Option<String>,
}

const PAGE_JS: &str = r##"(function (q) {
  try {
    var clean = function (s) {
      return (s || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    };
    var meta = function (name) {
      var out = [];
      document.querySelectorAll('meta[name="' + name + '" i], meta[property="' + name + '" i]').forEach(function (m) {
        var v = (m.getAttribute("content") || "").trim();
        if (v) out.push(v);
      });
      return out;
    };
    var desc = function (el) {
      var s = el.tagName.toLowerCase();
      if (el.id) s += "#" + el.id;
      var cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) s += "." + cls.join(".");
      return s;
    };
    var main = function () {
      if (q.selector) return document.querySelector(q.selector);
      return document.querySelector("article, main, [role=main]") || document.body;
    };
    var out = { url: location.href, title: document.title, lang: document.documentElement.lang || null };
    var part = q.part || "summary";
    if (part === "summary") {
      var ld = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
        try {
          var v = JSON.parse(s.textContent);
          [].concat(v["@graph"] || v).forEach(function (x) { if (x && typeof x === "object") ld.push(x); });
        } catch (e) {}
      });
      var art = ld.filter(function (x) {
        return /Article|Report|Thesis|Chapter|Book/i.test([].concat(x["@type"] || []).join(" "));
      })[0] || {};
      var name = function (a) { return typeof a === "string" ? a : (a && a.name) || null; };
      var doiIn = function (list) {
        return list.filter(function (v) { return /10\.\d{4,9}\//.test(v); })[0] || null;
      };
      var arxiv = location.href.match(/arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})/i);
      var authors = meta("citation_author");
      if (!authors.length) authors = meta("dc.creator");
      if (!authors.length) authors = [].concat(art.author || []).map(name).filter(Boolean);
      var r = main();
      out.selection = String(window.getSelection ? window.getSelection() : "").trim().slice(0, 4000) || null;
      out.paper = {
        title: meta("citation_title")[0] || meta("dc.title")[0] || art.headline || art.name || null,
        doi: meta("citation_doi")[0] || meta("prism.doi")[0] || doiIn(meta("dc.identifier")) ||
          doiIn([].concat(art.identifier || [], art["@id"] || [], art.sameAs || []).map(function (v) {
            return typeof v === "string" ? v : (v && v.value) || "";
          })),
        arxiv: meta("citation_arxiv_id")[0] || (arxiv && arxiv[1]) || null,
        pdf: meta("citation_pdf_url")[0] || null,
        venue: meta("citation_journal_title")[0] || meta("citation_conference_title")[0] ||
          meta("prism.publicationname")[0] || null,
        date: meta("citation_publication_date")[0] || meta("citation_date")[0] || meta("dc.date")[0] ||
          art.datePublished || null,
        authors: authors.slice(0, 40),
        abstract: (meta("citation_abstract")[0] || meta("dc.description")[0] ||
          (typeof art.description === "string" ? art.description : "") || "").slice(0, 3000) || null
      };
      var E = window.__edda;
      out.adapters = E ? E.status() : null;
      var d = E && E.detail();
      if (d) {
        ["title", "doi", "arxiv"].forEach(function (k) { if (d[k]) out.paper[k] = d[k]; });
        if (d.pdfUrl) out.paper.pdf = d.pdfUrl;
      }
      out.textLength = r ? clean(r.innerText).length : 0;
      return out;
    }
    if (part === "text") {
      var hooked = !q.selector && window.__edda ? window.__edda.text() : null;
      var el = hooked ? null : main();
      if (!hooked && !el) return { url: location.href, error: "selector matched nothing" };
      var t = clean(hooked || el.innerText);
      var off = Math.max(0, q.offset || 0);
      var lim = Math.min(Math.max(q.limit || 8000, 1), 16000);
      out.offset = off;
      out.total = t.length;
      out.text = t.slice(off, off + lim);
      out.nextOffset = off + lim < t.length ? off + lim : null;
      return out;
    }
    if (part === "outline") {
      out.landmarks = [];
      document.querySelectorAll("header, nav, main, article, aside, footer, [role=main], [role=navigation], [role=banner], [role=contentinfo], [role=complementary]").forEach(function (el) {
        if (out.landmarks.length >= 40) return;
        var box = el.getBoundingClientRect();
        out.landmarks.push({ element: desc(el), width: Math.round(box.width), textLength: (el.innerText || "").length });
      });
      out.headings = [];
      document.querySelectorAll("h1, h2, h3, h4").forEach(function (el) {
        if (out.headings.length >= 200) return;
        var text = clean(el.innerText).slice(0, 160);
        if (text) out.headings.push({ level: +el.tagName[1], text: text, id: el.id || null });
      });
      // Repeated children (result lists, article cards): where items live.
      out.lists = [];
      document.querySelectorAll("body *").forEach(function (el) {
        if (el.children.length < 5 || out.lists.length >= 30) return;
        var groups = {};
        for (var i = 0; i < el.children.length; i++) {
          var c = el.children[i];
          var key = c.tagName.toLowerCase() + ((c.getAttribute("class") || "").trim().split(/\s+/)[0] ? "." + c.getAttribute("class").trim().split(/\s+/)[0] : "");
          groups[key] = (groups[key] || 0) + 1;
        }
        Object.keys(groups).forEach(function (key) {
          if (groups[key] >= 5 && !/^(script|style|link|meta|br|option)/.test(key)) {
            out.lists.push({ container: desc(el), item: key, count: groups[key] });
          }
        });
      });
      return out;
    }
    if (part === "links") {
      var seen = {};
      out.links = [];
      document.querySelectorAll("a[href]").forEach(function (a) {
        if (out.links.length >= 150) return;
        var h = a.href, kind = null;
        if (/doi\.org\/10\./i.test(h)) kind = "doi";
        else if (/arxiv\.org\/(abs|pdf)\//i.test(h)) kind = "arxiv";
        else if (/\.pdf($|[?#])|\/pdf\/|\/pdfft|\/epdf\/|stamp\/stamp\.jsp|\/doi\/pdf/i.test(h)) kind = "pdf";
        if (!kind || seen[h]) return;
        seen[h] = 1;
        out.links.push({ kind: kind, href: h, text: clean(a.innerText).slice(0, 120) || null });
      });
      return out;
    }
    if (part === "targets") {
      var A = window.__edda;
      out.adapters = A ? A.status() : null;
      out.targets = A ? A.targets() : [];
      out.items = A ? A.items() : null;
      return out;
    }
    return { error: "unknown part" };
  } catch (e) {
    return { url: location.href, error: String(e) };
  }
})"##;

/// Run `script` in the page and parse what it returns.
pub(super) async fn eval_json<R: Runtime>(
    view: &Webview<R>,
    script: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    view.eval_with_callback(script, move |json| {
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(json);
        }
    })
    .map_err(|e| e.to_string())?;
    let json = tokio::time::timeout(timeout, rx)
        .await
        .map_err(|_| "the page did not answer in time".to_string())?
        .map_err(|_| "the page closed".to_string())?;
    serde_json::from_str(&json).map_err(|e| format!("unreadable page answer: {e}"))
}

/// Read one layer of the page a view shows.
pub async fn read_page<R: Runtime>(
    view: &Webview<R>,
    query: &PageQuery,
) -> Result<serde_json::Value, String> {
    let args = serde_json::to_string(query).map_err(|e| e.to_string())?;
    eval_json(view, &format!("{PAGE_JS}({args})"), Duration::from_secs(3)).await
}

/// The paper a page describes, from the `summary` layer.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct PagePaper {
    pub title: Option<String>,
    pub doi: Option<String>,
    pub arxiv: Option<String>,
    pub pdf: Option<String>,
}

impl PagePaper {
    pub fn from_summary(summary: &serde_json::Value) -> Self {
        summary
            .get("paper")
            .and_then(|paper| serde_json::from_value(paper.clone()).ok())
            .unwrap_or_default()
    }
}

/// `doi:10.1/x`, `https://doi.org/10.1/x` → `10.1/x`.
pub fn bare_doi(raw: &str) -> Option<String> {
    let start = raw.find("10.")?;
    let doi = raw[start..].trim().trim_end_matches(['.', ',', ';']);
    (doi.contains('/') && doi.len() > 7).then(|| doi.to_string())
}

/// What to hand the import pipeline: DOI, then arXiv id, then the page itself.
pub fn pick_identifier(paper: &PagePaper, page_url: &str) -> String {
    if let Some(doi) = paper.doi.as_deref().and_then(bare_doi) {
        return doi;
    }
    if let Some(arxiv) = paper
        .arxiv
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return arxiv.to_string();
    }
    page_url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_prefer_doi_then_arxiv_then_page() {
        let url = "https://example.org/a";
        let with = |doi: Option<&str>, arxiv: Option<&str>| PagePaper {
            doi: doi.map(Into::into),
            arxiv: arxiv.map(Into::into),
            ..Default::default()
        };
        assert_eq!(
            pick_identifier(
                &with(
                    Some("https://doi.org/10.1007/s11263-015-0816-y"),
                    Some("1409.0575")
                ),
                url
            ),
            "10.1007/s11263-015-0816-y"
        );
        assert_eq!(
            pick_identifier(&with(Some("doi:10.1109/5.771073."), None), url),
            "10.1109/5.771073"
        );
        assert_eq!(
            pick_identifier(&with(Some("n/a"), Some("1706.03762")), url),
            "1706.03762"
        );
        assert_eq!(pick_identifier(&with(None, None), url), url);
    }
}
