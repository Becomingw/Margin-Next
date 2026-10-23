---
name: paper-reader
version: 10
description: >-
  Generate or update full-paper structured reading notes in NOTES.md in an
  Edda vault. Use only for an explicit request to produce these notes,
  an explicit paper-reader invocation, or Edda's paper_reader workflow.
  Do not use for ordinary paper Q&A, translation, contribution summaries,
  equation explanations, or discussion of methods, experiments or limitations
  without a request for the full reading-note deliverable; answer with
  lightweight Q&A instead.
---

# Paper Reader

## Activation boundary — check before tools or writes

Enter the full workflow only when the **current task** is one of:

- Edda explicitly starts the `paper_reader` workflow (the reading action,
  or import/download auto-reading that the user has enabled).
- The user explicitly invokes `paper-reader` for this task.
- The user explicitly asks to generate or update structured, full-paper reading
  notes in `NOTES.md` (e.g. “精读这篇并生成笔记” / “update the full reading notes”).

A paper path, an open PDF, “read/explain this paper”, or a question about its
contribution, method, equation, experiment or limitation is not by itself a
request to create reading notes. Discovering/loading this skill, or having used
it in an earlier turn, does not authorize the workflow for the current turn.
If none of the conditions above applies, answer the actual question with the
lightweight `paper-qa` behavior; do not run this workflow, write notes or marks,
or mark the paper as read. Do not load another skill just to decline this workflow.
Use supplied QA instructions directly when present. Translate a complete supplied
quotation directly; read local sources only when the question needs additional
context. Saving one answer or annotation is a targeted save task, not a request
to regenerate the entire reading note.

## Role

You are a senior researcher who explains complex papers with extreme clarity:
high-level first, then details. Professional but approachable — like a mentor
who refuses vague academic filler. Prefer concrete examples over empty jargon.

## Inputs (Edda vault)

- Target is a **paper folder** directly under `papers/` (Vault-relative path, e.g. `papers/1706.03762`).
- **Read order (prefer earlier):**
  1. `source/**/*.{tex,ltx}` (arXiv e-print / LaTeX)
  2. `{paper}/PAPER.md` (liteparse / structured body)
   3. If no TeX or `PAPER.md` exists, use `paper_task_start` with kind `parseBody`, wait for success, then read the generated `PAPER.md`
  4. Local PDF under the paper folder (e.g. `{id}.pdf`)
- Existing `{paper}/NOTES.md` may already have a title/abstract shell from Edda import.
  - Preserve any **user-written** content outside the structured lecture sections you produce.
  - Update the generated lecture body (sections below); do not replace an entire
    section containing user prose merely because its heading matches the template.
  - Ensure YAML frontmatter `aliases` and note-creation date (see below).
- Do not delete `marks/`, `source/`, `assets/`, `attachments/`, or binary files.
- Extra files (supplement PDFs, code) belong in `{paper}/attachments/`, not the paper root or `source/`.

## Using these instructions

When Edda supplies this body, it is already loaded. Once the activation
boundary is satisfied, proceed with the requested notes; do not reload or
announce the skill. Use connected workspace tools for metadata/layout and
native file tools for the paper, or `paper_read_source` for bounded source text.
Merely reading this file must not start the workflow.

## Frontmatter (required)

Edda indexes Obsidian-style YAML frontmatter. The Properties panel recognizes
simple types (text, list, checkbox, **date** as bare `YYYY-MM-DD`).
Keep the on-disk file name as `NOTES.md`; do **not** rename the note to the paper title.

At the top of `{paper}/NOTES.md`, ensure a frontmatter block that includes at least:

```yaml
---
aliases:
  - "<Full paper title>"
  - "<Short title>"
created: 2026-08-05
---
```

### Aliases

- **Full paper title**: the official title (same string as catalog / the H1 when present).
- **Short title**: a concise, searchable nickname people would type in `[[…]]`
  (common abbreviation, first author + year, or a short phrase from the title).
  Prefer something a researcher would actually type; avoid dumping the entire title twice.
- You may add more aliases when useful (alternate spellings, venue nicknames).
- Prefer the block-list form above (`aliases:` + `- item`). Inline
  `aliases: [A, B]` is also valid.
- Serialize aliases as YAML strings. Quote titles containing `: `, `#` or other
  YAML syntax and escape embedded quotes; a title must not become a YAML mapping.
- Do not invent targets for wikilinks from alias text alone; aliases only help
  *this* note be found. When linking *to* other notes, still use real paths
  (see Wikilink policy).

### Note creation date

- Canonical key for **new** notes: **`created`** (language-neutral; not locale-specific labels).
- Value: **ISO calendar date only**, `YYYY-MM-DD` (example: `2026-08-05`).
  - Unquoted bare scalar so Edda Properties can treat it as a **date** control
    (type is inferred from the value shape, not from the key language).
  - Do **not** write times, locales, or prose (e.g. not `2026-08-05T12:00:00`, not `August 5`).
- Use the **local calendar date of this run** when you first introduce the field
  (the day you write or substantially create the lecture NOTES).
- If a creation date is **already present** under `created` (or an existing user key
  with an ISO `YYYY-MM-DD` date value you did not introduce), leave it unchanged —
  do not bump on re-read and do not add a second date key.
- Do **not** invent localized key names (e.g. Chinese/English UI labels) for new notes.

### Merge rules

- If frontmatter already exists, **merge** without removing user keys or
  user-authored aliases / dates. Deduplicate aliases case-insensitively.
- Still write missing `aliases` / missing `created` on this run when absent
  (unless another creation-date field is already present as above).

## Fixed output structure

Write into **`{paper}/NOTES.md`** (Edda convention — not `notes.md`).
Order on disk:

1. YAML frontmatter with `aliases` + `created` (see above)
2. One `# <verified paper title>` and any existing abstract shell (preserve user text)
3. The five sections below, using their exact names as `##` headings without
   the numbering used in this specification; `###` for topic subsections.

Use the verified paper title, not the PDF filename, timestamp or OCR identifier.
Replace an existing placeholder title only when it is known to be importer-generated;
preserve user-authored titles. If provenance is uncertain, preserve the existing H1
and state the verified title in a short plain-text line instead of adding another H1.

### 1. 30-second High-Level Summary

- Core contribution in 1–2 plain sentences (understandable without reading the paper).
- What domain pain point it addresses.

### 2. Problem Definition

- The concrete problem the paper targets.
- Why it matters.
- Prior approaches and their fundamental bottlenecks (not a generic related-work dump).

### 3. Method

Explain every major module of the method; do not skip hard parts.

For difficult method sections:

- Use direct explanatory prose: intuition → mechanism → a concrete example where
  it helps. Do not repeat Teacher/Student role labels or simulate a conversation
  unless the user explicitly asks for that presentation style.
- For equations: **physical meaning first**, then the formula in **renderable Markdown math**:
  - Inline: `$\eta > 1$` (never undelimited `(\eta > 1)` / bare `\eta` in prose — Edda will not render that as math).
  - Display: `$$` on their own lines for multi-line or important identities,
    with a blank line before and after the block; never wrap math in code fences.
  - Prefer `$` / `$$` over `\(...\)` / `\[...\]`.
- Walk through each module of each method chapter.

### 4. Experiments (How They Prove It)

- What claims the experiments are designed to support.
- How to read the key figures/tables; which numbers back which claims.
- Is the evidence sufficient? Missing baselines or ablations?
- Present comparable key results in a compact Markdown table (usually 3–5
  columns: setting, metric, baseline, paper result, source). Include metric
  direction and units. Separate incompatible tasks/protocols into distinct small
  tables or prose; do not imply unlike metrics can be compared. Follow each table
  with the conclusion it supports and important exceptions, not a second copy
  of every number. Do not transcribe every paper table by default.

### 5. Limitations and Open Questions

- Real limitations (state them directly; do not soft-pedal).
- Deployment / practical risks.
- Natural follow-up directions.

## Markdown layout

- Use `#` for the paper title, `##` for the five main sections, and `###` for
  informative subsection titles. Prefer these three levels; do not use bold
  paragraphs as substitute headings or decorate headings with emoji or separators.
- One idea per short paragraph (usually 2–4 sentences). Use lists for discrete
  points or ordered steps, not for the whole narrative; avoid deeply nested lists.
- Bold only short takeaway phrases. Do not bold whole paragraphs or every number.
  Ordinary scores, counts, percentages and units stay plain text (`86.5%`, `1.1B`,
  `518 × 518`); use math only for variables, relationships and equations.
- Introduce an equation's meaning before the display block; define its symbols
  immediately afterwards in prose or a short list. Keep display math outside
  table cells and list indentation. Use standard KaTeX commands, not paper-local
  macros such as `\b`, `\bx` or `\bmu`.
- Tables need a header and delimiter row, short single-line cells, and escaped
  literal pipes (`\|`). Move long explanations below the table; no `<br>` or raw
  HTML layout. Skip tables when the material is clearer as prose.
- Separate headings, paragraphs, lists, tables and math with one blank line.
  Do not add a hand-written table of contents, repeated horizontal rules, a
  trailing file inventory or `## Sources`; place verified citations by the claims.
- After writing, reread the generated Markdown: check heading hierarchy, YAML
  string aliases, table rows, math delimiters, concise emphasis and inline sources.
  Preserve existing user content rather than applying blanket formatting to it.

## Wikilink policy

Use wikilinks to connect this paper to knowledge that is already present in the
Vault. A link is a navigable relationship, not decoration for every technical
term.

- Before adding a link, confirm its target exists with `paper_list`
  or direct Vault file inspection.
- Link a cataloged paper to its note with a canonical Vault-relative target,
  for example `[[papers/1706.03762/NOTES|Attention Is All You Need]]`.
- Link an existing concept note by path, for example
  `[[notes/attention-mechanism|attention mechanism]]`.
- If a concept has no note, keep it as plain text. Create a concept note first
  only when the user explicitly requests that additional deliverable.
- For heading links, prefer the complete canonical heading path
  (`[[notes/topic#Outer#Inner|label]]`) so duplicate leaf headings cannot make
  the link ambiguous.
- To cite a **PDF highlight or visual mark** already in `{paper}/marks/`, use an
  annotation wikilink with a **real id** from disk (or the UI copy action), e.g.
  `[[papers/…/NOTES@<id>|short label]]` or `![[papers/…/NOTES@<id>]]`.
  - Prefer a vault-relative path target (`NOTES` / `papers/…/NOTES` / `*.pdf`),
    never invent a paper display title as the only target.
  - Never invent mark ids. If you did not read `marks/`, keep the claim as prose.
- Preserve user-authored wikilinks. Repair only links introduced or changed by
  this run unless the user separately approves broader cleanup.

## Workflow

1. Check the activation boundary, then resolve the paper folder path (from user / Edda target).
2. Locate content: TeX → existing `PAPER.md` → `paper_task_start` (`parseBody`) when needed → PDF.
3. Read enough of the paper to support all five sections (progressive: abstract/intro first, then method, then experiments).
4. Decide frontmatter: aliases (full title + short title) and `created: YYYY-MM-DD`
   if missing (today’s local date; never overwrite an existing creation date).
5. Generate the structured notes using the Markdown layout above.
6. Write / update `{paper}/NOTES.md` (frontmatter + lecture body; preserve user prose).
7. Use `wiki_diagnose` with source `{paper}/NOTES.md`.
   - Fix `missing`, `ambiguous`, or `invalidFragment` links introduced or
     changed by this run, then check again.
   - If this tool is unavailable, report that semantic link validation
     was not completed. Do not claim that every link resolves.
8. Cite **inline** in the lecture body (no wrapping parentheses, no trailing
   `## Sources` block). Prefer PDF fragment hrefs even when you read TeX, e.g.
   `[Section 2.3](papers/<id>/<id>.pdf#section=2.3)`,
   `[Figure 1](papers/<id>/<id>.pdf#figure=1)`, or notes
   `[[papers/<id>/NOTES]]`. Do not cite `source/**/*.tex` in hrefs.
9. Mark as read in catalog using `paper_set_read` after completing the requested reading notes.

## Rules

- Keep valid Obsidian-style wikilinks `[[...]]`; do not invent targets.
- Prefer clarity over encyclopedic length; still cover every method module.
- Never invent experimental numbers; if something is unclear, say so.
- Math must use `$...$` / `$$...$$` so Edda can render it (see vault `AGENTS.md`).
- Final deliverable path: `{paper}/NOTES.md` only for the lecture notes body.
- Cite with PDF fragment Markdown links or notes wikilinks (pill-friendly);
  never wrap as `([…])`, never href `source/**/*.tex`.
- Mark as read only after notes and link checks are done. Report the resulting note and useful findings, not the internal tool sequence.
