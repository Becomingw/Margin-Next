---
name: edda-mcp-library
description: >-
  Work with a researcher's Edda paper library from an external agent (Claude
  Code, Codex, Antigravity, Cursor, …) through Edda's local MCP server: find
  and filter papers, read metadata, parsed text, figures and reading marks,
  answer questions from the user's own papers, and, when asked, import papers,
  edit tags and notes, move or trash papers, export bibliographies or run
  diagnostics. Use when the user mentions their Edda library or vault, or the
  Edda MCP tools (paper_list, paper_context, …) are connected. Manuscripts
  under review are handled by edda-mcp-reviewer.
---

# Edda library over MCP

Edda is a desktop research workbench. Its library ("vault") is a folder of
papers (`papers/<id>/` with the PDF, `PAPER.md` parsed text, `NOTES.md`,
`source/` TeX, `marks/` reading marks), standalone notes in `notes/`, and
manuscripts under review in `reviews/`. Bibliographic metadata and tags live in
`.edda/catalog.sqlite`. You reach all of it through the tools of Edda's MCP
server; the tool list carries the exact argument schemas.

## Connect first

- Edda must be running with a **local** vault open, and the MCP server switched
  on (Settings → Network → Edda MCP server; in Chinese 设置 → 网络与集成 →
  Edda MCP 服务). The default address is
  `http://127.0.0.1:8765/mcp`, a streamable HTTP server on this machine only.
  Add the agent's name as `?agent=<Name>` so its work in Edda is signed with
  it. In Claude Code:
  `claude mcp add --transport http edda "http://127.0.0.1:8765/mcp?agent=Claude%20Code"`.
- If the Edda tools are missing or every call fails, tell the user exactly
  that and how to switch the server on. Do not open or edit the vault's
  database or JSON files instead.
- A connection stays bound to the vault that was open when it connected. Call
  `workspace_context` when unsure which vault you are in; if the user switched
  vaults in Edda, they need to reconnect.
- Tools named `browse_*` belong to agents running inside Edda and are not
  offered here. Website pages open in Edda are out of reach.

## Find and read

- `paper_list` is token-cheap: rows are `id/path/title`. Add `fields`
  (`year`, `tags`, `authors`, `isRead`, …) only as needed, narrow with `query`,
  `tag`, `unread`, and raise `limit` (default 50, max 200) instead of listing
  everything. `paper_get` adds the abstract and full metadata of one paper;
  `tag_list` gives tags and counts.
- `paper_context` returns a paper's real file paths. If you can read local
  files, read them directly; otherwise use `paper_sources` and bounded
  `paper_read_source` slices. Prefer TeX, then `PAPER.md`, then the PDF.
- No parsed text yet: `paper_task_start` with `parseBody` (or `download`,
  `parseReferences`, `analyzeLayout`) returns a task id; read the result after
  `task_get` reports success. Do not poll in a tight loop or start tasks the
  question does not need.
- Figures and tables: `layout_list` / `layout_get` once layout analysis exists.
  The user's highlights and questions on a PDF: `mark_list`, then `mark_get`.
  A paper's notes: `paper_notes_get` (empty string means none).
- Answer from these sources and cite the paper id or path, with page, section
  or figure when you have it. If something is not in the library, say so;
  never fill in authors, years, identifiers or numbers from memory.

## Change the library only when asked

Reading and answering never write notes, marks, tags or read status.

- **Import**: `import_id` takes an arXiv id, DOI or URL; one call per item, then
  report which succeeded. `import_bibliography` takes BibTeX/RIS text;
  `export_bibliography` returns text for you to save.
- **Tags**: prefer `paper_tag_add` / `paper_tag_rm`. `paper_tag_set` replaces all
  of a paper's tags, so read them first. Reuse existing tag names.
- **Notes**: read `paper_notes_get` before `paper_notes_write`; use `append` for
  additions and `replace` only for an explicit rewrite, keeping the user's text.
- **Read status**: `paper_set_read` only when the user says so.
- **Marks**: `mark_create` needs an exact PDF quote or an existing layout region,
  never invented coordinates; `mark_delete` only for marks the user named.
- **Move / trash**: `paper_move` keeps links valid; `paper_trash` goes to the
  recycle bin. Permanent deletion is not available. List the affected papers
  first when the request is broad ("clean up old papers").
- **Recommendations**: `pool_list` reads the user's paper pool; `pool_submit`
  offers verified candidates for the user to review (see `pool_example` for
  the format). Submitting does not import.
- **Checks**: `workspace_diagnose` and `wiki_diagnose` only report; run
  `workspace_repair` for one explicitly requested kind of repair.

The user sees every change in Edda right away. For anything touching more than
a few papers, state the exact set first and finish with what changed, what
failed and why.
