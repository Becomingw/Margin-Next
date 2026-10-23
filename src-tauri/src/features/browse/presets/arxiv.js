// arXiv: an import button beside every paper in listings and search results.
// Abstract pages need nothing here: their citation_* metadata already
// feeds the toolbar's Add to library.
var idOf = function (text) {
  var m = String(text || "").match(/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/);
  return m ? m[1] : null;
};
var clean = function (el, prefix) {
  var t = el ? (el.innerText || el.textContent || "") : "";
  return t.replace(prefix || "", "").replace(/\s+/g, " ").trim();
};
edda.observe(function () {
  // /list/… and /catchup: <dt> holds the id link, the next <dd> the title.
  document.querySelectorAll("dl > dt").forEach(function (dt) {
    var link = dt.querySelector('a[href*="/abs/"]');
    var id = link && idOf(link.getAttribute("href"));
    if (!id) return;
    var dd = dt.nextElementSibling;
    edda.importButton(link, {
      arxiv: id,
      title: clean(dd && dd.querySelector(".list-title"), /^Title:/)
    });
  });
  // /search results.
  document.querySelectorAll("li.arxiv-result").forEach(function (li) {
    var link = li.querySelector(".list-title a");
    var id = link && idOf(link.textContent);
    if (!id) return;
    edda.importButton(link, { arxiv: id, title: clean(li.querySelector("p.title")) });
  });
});
