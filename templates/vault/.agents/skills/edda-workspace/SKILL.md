---
name: edda-workspace
version: 3
description: >-
  Find, read and manage the research library through Edda's connected MCP
  tools: search and filter papers, fetch metadata and source paths, read parsed
  text, figures and reading marks, edit tags and notes, import, move or trash
  papers, export bibliographies, run background tasks and diagnostics. Use for
  library lookups and housekeeping. Questions about a paper's content use
  paper-qa; the explicit full reading-note workflow uses paper-reader;
  manuscripts under reviews/ use edda-paper-reviewer; restructuring a whole folder
  uses vault-normalizer.
---

# Research workspace

Edda must be running with a local Vault open. Connected MCP tools expose the
business operations and their argument schemas; this skill decides which to use
and what needs care. Use the right tool directly, without a setup or
"check the connection" prelude.

If the workspace tools are not connected (remote Vault, an agent without HTTP
MCP, no running app), read with native file and search tools, say that business
operations are unavailable, and do not hand-edit SQLite or JSON to compensate.
Inside Edda, write tools also need an active turn and a permission mode other
than Restricted; if one is refused for permission, report it and let the user
decide instead of working around it.

## Find and read

- `paper_list` is token-cheap: rows are `id/path/title`. Add `fields`
  (`year`, `tags`, `authors`, `isRead`, …) only for what the task needs, narrow
  with `query`, `tag`, `unread`, and raise `limit` (default 50, cap 200) instead
  of listing everything. `paper_get` adds the abstract and full metadata of one
  paper. `tag_list` gives the user's tags and counts.
- `paper_context` returns the paper's real file paths (PDF, `PAPER.md`,
  `NOTES.md`, `source/`, TeX availability). Read them with native file and search
  tools; use `paper_sources` / `paper_read_source` (bounded slices) only when
  local files cannot be opened. Prefer TeX, then `PAPER.md`, then the PDF.
- No parsed body yet: `paper_task_start` with `parseBody` (also `download`,
  `parseReferences`, `analyzeLayout`). It returns a task id immediately; read
  the result after `task_get` reports success. Do not poll in a loop or start
  tasks the question does not need. `task_list` / `task_cancel` manage them.
- Figures, tables and equations: `layout_list` / `layout_get` after layout
  analysis exists. The user's reading marks: `mark_list` (compact, paged), then
  `mark_get` for the ones that matter.
- `paper_notes_get` reads `NOTES.md`; an empty string means there are none.
- Report findings with paper ids or paths so the user can open them. If a fact
  is not in the catalog or sources, say it is unknown; never fill in authors,
  years, identifiers, page numbers, regions or numbers from memory.

## Change the library

Mutations happen only when the user asked for them. Reading, summarizing and
answering never write notes, marks, tags or read status.

- **Import**: `import_id` takes an arXiv id, DOI or URL. Several items → one
  call each, then report which succeeded. `import_bibliography` takes supplied
  BibTeX/RIS text; `export_bibliography` returns text for you to save.
- **Tags**: prefer `paper_tag_add` / `paper_tag_rm`. `paper_tag_set` replaces
  the whole user tag set, so read the current tags first and use it only when
  that is the intent. Reuse existing tag names (`tag_list`) rather than inventing
  near-duplicates. Colors use the `name:color` suffix.
- **Notes**: read `paper_notes_get` before writing. Use `append` for additions;
  `replace` only when asked to rewrite, and keep user-written content.
- **Read status**: `paper_set_read` only when the user says so or after the
  reading-notes workflow completes.
- **Marks**: `mark_create` needs an exact PDF quote or an existing layout region;
  never supply invented coordinates. `mark_update`; `mark_delete` only for
  marks the user named.
- **Move / trash**: `paper_move` keeps links valid inside the flat `papers/`
  rules. `paper_trash` goes to the recycle bin and is recoverable; permanent
  deletion is not available here. List the affected papers first when the
  request is broad or fuzzy ("clean up old papers").
- **Recommendations**: `pool_example` shows the format, `pool_list` reads the
  configured pool, `pool_submit` offers verified candidates for the user's
  review. A submission does not add a paper to the library; verify identifiers
  before submitting.

## Check and repair

- `workspace_diagnose` and `wiki_diagnose` only report. Show findings first.
  `workspace_repair` runs one explicitly requested class of repair (missing
  aliases, legacy visual marks, duplicate catalog rows) and respects unsaved
  documents.
- Never edit `.edda/catalog.sqlite`, `metadata.json`, annotation JSON or layout
  JSON by hand; use the tools.
- A tool refusal or missing capability (no layout index, read-only pool) is a
  result to report, not something to route around.

## Bulk and destructive work

For anything touching more than a few papers, or trashing, moving, replacing
tags or notes, or deleting marks: state the exact set and the change, do it once
the request is clear, and finish with a short account: how many items, which
changed, which failed and why. Report the outcome naturally; do not announce
this skill or list the tools you called.
