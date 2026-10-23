// ModelScope papers (an umi SPA): mark the layout wrappers the CSS lifts, and
// put an import button on every paper card and on the detail page. The site's
// classes are content-hashed, so structure is found through stable hooks:
// `a[href^="/papers/"]` cards, the search input, the arXiv favicon.

// `/papers/<arxivId>` is the whole identity. One segment only: the detail
// page's own tabs are `/papers/<id>/summary` and `/papers/<id>/feedback`.
var ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var paperId = function (pathname) {
  var match = /^\/papers\/(.+)$/.exec(pathname);
  if (!match) return null;
  var id = match[1].replace(/\/+$/, "");
  return ID.test(id) ? id : null;
};
var pathOf = function (anchor) {
  var a = document.createElement("a");
  a.href = anchor.getAttribute("href") || "";
  return a.pathname;
};
// The card title is its first text-bearing leaf block.
var titleOf = function (card) {
  var nodes = card.querySelectorAll("div");
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].children.length) continue;
    if ((nodes[i].textContent || "").trim()) return nodes[i];
  }
  return null;
};
var fitAncestors = function (node) {
  for (var p = node && node.parentElement; p && p !== document.body; p = p.parentElement) {
    p.classList.add("edda-paper-layout");
  }
};
var cards = function () {
  var out = [];
  var seen = {};
  document.querySelectorAll('a[href^="/papers/"]').forEach(function (card) {
    var path = pathOf(card);
    // A link to the open page is the detail tab strip, not a card.
    if (path === window.location.pathname) return;
    var id = paperId(path);
    if (!id || seen[id]) return;
    seen[id] = true;
    out.push({ card: card, id: id, title: titleOf(card) });
  });
  return out;
};

edda.observe(function () {
  var search = document.querySelector('main input[type="text"], main input[type="search"]');
  if (search) {
    fitAncestors(search);
    // The search block is its topmost text-free ancestor; its row also holds the title.
    var block = search;
    while (block.parentElement && block.parentElement !== document.body &&
        !(block.parentElement.textContent || "").trim()) {
      block = block.parentElement;
    }
    var row = block.parentElement;
    if (row && getComputedStyle(row).display === "flex") {
      block.classList.add("edda-search-block");
      row.classList.add("edda-search-row");
    }
  }
  var columns = document.querySelector(".modelscope-deps > div");
  if (columns && columns.children.length === 2) columns.classList.add("edda-detail-columns");

  cards().forEach(function (c) {
    if (!c.title || !c.title.parentNode) return;
    c.card.classList.add("edda-paper-card");
    fitAncestors(c.card);
    // The title is width-clamped with an ellipsis: pair it with the button in a row.
    if (!c.title.parentNode.classList.contains("edda-import-titlerow")) {
      var titleRow = document.createElement("div");
      titleRow.className = "edda-import-titlerow";
      c.title.parentNode.insertBefore(titleRow, c.title);
      titleRow.appendChild(c.title);
    }
    edda.importButton(c.title, { arxiv: c.id, title: (c.title.textContent || "").trim() });
  });

  // The feed's tab bar: the nearest flex sibling above the card list.
  var first = document.querySelector("a.edda-paper-card");
  for (var up = first && first.parentElement; up && up !== document.body; up = up.parentElement) {
    var toolbar = up.previousElementSibling;
    if (toolbar && getComputedStyle(toolbar).display === "flex" &&
        !toolbar.querySelector('a[href^="/papers/"]')) {
      toolbar.classList.add("edda-feed-toolbar");
      break;
    }
  }

  // Detail page: beside the 「arXiv 原文 / PDF」 actions, found by the arXiv favicon.
  var current = paperId(window.location.pathname);
  var icon = current && document.querySelector('img[src*="arxiv.org"]');
  if (icon) {
    fitAncestors(icon.parentElement);
    edda.importButton(icon.parentElement, { arxiv: current });
  }
});

edda.items(function () {
  return cards().map(function (c) {
    var title = c.title ? (c.title.textContent || "").trim() : "";
    return {
      title: title,
      url: "https://arxiv.org/abs/" + c.id,
      summary: (c.card.innerText || "").replace(title, "").replace(/\+ Edda/g, "").trim()
    };
  });
});

// The detail page's <main> holds only the footer; the abstract renders elsewhere.
edda.text(function () {
  return paperId(window.location.pathname) ? document.body.innerText : null;
});

edda.detail(function () {
  var id = paperId(window.location.pathname);
  return id ? { arxiv: id } : null;
});
