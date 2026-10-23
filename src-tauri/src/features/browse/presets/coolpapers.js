// Cool Papers (papers.cool): an import button on every paper row, and the rows
// for the agent's page reading. arXiv rows import by arXiv id (TeX sources
// come along); other rows import from their papers.cool page, whose citation_*
// metadata covers every venue papers.cool aggregates, PDF included.
var branch = function () {
  return (document.body && document.body.id) || "venue";
};
var arxivId = function (url) {
  var m = /arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:v\d+)?(?:\.pdf)?(?:[?#]|$)/.exec(url || "");
  return m ? m[1] : null;
};
// The `#N` index anchor is the upstream landing page on every branch.
var upstream = function (panel) {
  var index = panel.querySelector(".index");
  var anchor = index && index.closest ? index.closest("a[href]") : null;
  if (!anchor) anchor = panel.querySelector("h2.title a[href]");
  return anchor ? anchor.href : null;
};
var targetOf = function (panel) {
  var link = document.getElementById("title-" + panel.id);
  var title = link ? (link.textContent || "").trim() : "";
  var arxiv = arxivId(upstream(panel)) || (branch() === "arxiv" ? panel.id : null);
  if (arxiv) return { arxiv: arxiv, title: title };
  return { url: "https://papers.cool/" + branch() + "/" + panel.id, title: title };
};

edda.observe(function () {
  document.querySelectorAll(".panel.paper").forEach(function (panel) {
    var link = document.getElementById("title-" + panel.id) || panel.querySelector("h2.title a");
    if (link) edda.importButton(link, targetOf(panel));
  });
});

edda.items(function () {
  var out = [];
  document.querySelectorAll(".panel.paper").forEach(function (panel) {
    var t = targetOf(panel);
    var authors = [];
    panel.querySelectorAll(".authors a.author").forEach(function (a, i) {
      if (i < 8) authors.push((a.textContent || "").trim());
    });
    var summary = document.getElementById("summary-" + panel.id);
    out.push({
      title: t.title,
      authors: authors.join(", "),
      summary: summary ? (summary.textContent || "").trim() : "",
      url: t.arxiv ? "https://arxiv.org/abs/" + t.arxiv : t.url
    });
  });
  return out;
});
