<p align="center">
  <img src="docs/assets/margin-app-icon.svg" width="128" height="128" alt="Margin icon" />
</p>

<h1 align="center">Margin</h1>

<p align="center"><strong>Changes in the text. Conversations in the margin.</strong></p>
<p align="center">A local-first desktop workspace for manuscript review. Track changes like Word, work with one AI reviewer, and keep every final decision in your hands.</p>

<p align="center">
  <a href="README.md">中文</a> · <b>English</b> · <a href="docs/margin.md">Project notes · 中文</a> · <a href="docs/margin-single-ai.md">AI setup · 中文</a> · <a href="LICENSE">MIT</a>
</p>

> **Development preview. No official installers yet.** The current checkpoint is one AI reviewer + one local author, not a multi-agent platform or the complete Edda research workbench. Back up important manuscripts first.

<p align="center">
  <img src="docs/assets/margin-review.png" width="100%" alt="Actual Margin desktop interface with inline tracked changes, anchored comments and replies, using a fictional manuscript" />
</p>

## Review first. Decide second.

- **Review inside the manuscript.** Green insertions, red deletions, and markup / final / original views. Accept or reject individual changes or the whole round without searching chat transcripts.
- **Keep discussions beside the text.** Comments anchor to selections; the author and AI reply in shared threads. Cards follow their text, and the review panel moves below the editor in narrow windows.
- **AI proposes. You decide.** An external AI submits a pending proposal. Preview it, apply it as tracked changes, then accept or reject. AI cannot overwrite the live manuscript or approve changes for you.
- **Save against explicit versions.** Each manuscript has its own transactional SQLite database for text, baseline, threads, decisions and events. Stale writes conflict, retries are idempotent, and new snapshots do not overwrite unsaved drafts.
- **Keep your workspace local.** Start with an ordinary folder. Export Markdown, the baseline, a complete review database and attachments; restore an exported database as a new manuscript.

## Run locally

Install Node.js 24+, pnpm (see `package.json` for the version), Rust stable, and the platform-specific [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/). Windows needs the C++ build tools and WebView2.

```sh
git clone https://github.com/Becomingw/Margin-Next.git
cd Margin-Next
pnpm install --frozen-lockfile
pnpm tauri dev
```

The first run stages PDFium and compiles the native Host, which may download dependencies. Use `pnpm.cmd` if PowerShell blocks `.ps1` scripts.

1. Open a workspace folder, then create a manuscript or import Markdown.
2. Edit, comment, and accept / reject tracked changes. Manuscript edits save automatically.
3. To work with AI, open **AI reviewer** in the header and authorize this manuscript.
4. Export when finished to keep both readable text and restorable review history.

`pnpm dev` is only a frontend preview; the browser cannot read or write local manuscripts. Windows / WebView2 is the primary validated environment. Independently validated cross-platform installers are not available yet.

## Work with one AI

Margin exposes review-only **Streamable HTTP MCP**. It does not include a model chat interface or run your AI client for you.

1. Open a manuscript → **AI reviewer** → choose a reviewer name → **Enable access**.
2. Expand and copy the connection configuration into an AI client that supports HTTP MCP and custom request headers.
3. Keep Margin open and ask the client, for example:

   > Read the current manuscript and comments. Reply to my questions in the same threads. Submit manuscript changes as proposals, wait for my decisions, then read the decisions and replies before continuing.

4. In Margin, preview pending proposals and choose **Apply as tracked changes** or **Dismiss**.

<p align="center">
  <img src="docs/assets/margin-ai-review.png" width="720" alt="Single-AI proposal preview, with human-controlled apply and dismiss actions; interface shown in Chinese" />
</p>

Access is pinned to one manuscript and one reviewer identity. AI can read saved text, comments, replies and decisions, but not unsaved drafts. It cannot edit author-created comments, apply proposals, accept revisions or resolve threads. Proposals based on an older manuscript must be resubmitted; they are not automatically merged.

The endpoint listens on a random loopback port and requires a Bearer credential. Disconnecting or switching manuscripts revokes the old grant. **Do not publish connection configurations or tokens.** These permissions constrain Margin MCP, not an external client's own filesystem or shell tools. Data shared with an external AI remains subject to that model or provider's policies.

See the [single-AI checkpoint](docs/margin-single-ai.md) for the tool contract, security boundaries and validation details (Chinese).

## Your data

```text
your-workspace/
└── .margin/documents/<manuscript-id>/
    ├── review.sqlite       # Text revisions, baseline, proposals, threads, decisions, events
    ├── manuscript.pdf      # Optional reference PDF
    └── assets/             # Optional attachments
```

- Immutable database revisions are authoritative. There is **no separately writable live `manuscript.md`** to edit concurrently outside Margin.
- Exports include a consistent database snapshot, `manuscript.md`, `baseline.md`, readable review JSON and attachments. Import an exported `review.sqlite` to restore a new manuscript.
- SQLite may use `review.sqlite-wal` / `review.sqlite-shm` while running. Prefer the application export for backups rather than copying only a live main database file.
- Legacy Edda `reviews/` data is imported read-only; originals remain untouched and are not subsequently synchronized. Attachments are not versioned yet.

Details: [transactional backend](docs/backend/margin.md) (Chinese).

## Current boundaries

- **Not an in-place LaTeX editor.** TeX import and Plate serialization do not preserve source bytes exactly.
- **PDF and complex manuscripts need further validation.** Reference PDFs and inherited parsing adapters remain, but offline OCR, complex layouts and every long-document workflow are not claimed as validated. AI tools read Markdown, not PDF or image contents directly.
- **No multi-AI or automatic merging.** One reviewer role; no built-in autonomous model execution, three-way merge, remote multi-user collaboration or account authentication.
- **Not release-ready.** Full history browsing, cross-manuscript comment-draft protection, dependency extraction, installers, and pre-release permission / CSP auditing remain follow-ups.

## Development

Tauri 2 · React 19 · TypeScript · Plate · Rust · SQLite.

```sh
pnpm typecheck
pnpm test
pnpm build
cargo test -p edda-core features::margin --lib
cargo test -p edda margin::ai::tests --lib
cargo clippy --workspace --all-targets -- -D warnings
```

`pnpm test:margin-native` drives a visible Windows development window over CDP; setup is documented in [running and validation](docs/margin.md#运行与验证). It exercises real HTTP MCP / SQLite reads, signed replies, idempotent retries, dirty-draft isolation, stale proposals, human decisions and revocation. Protocol calls simulate an AI client; they do not validate an actual model's output quality.

Entry points: `src/margin/` (standalone frontend), `src-tauri/src/margin/` (Host / MCP), and `crates/edda-core/src/features/margin/` (transactional core). Inherited Edda plans in the [development index](docs/development/index.md) are not automatically Margin's roadmap.

## Origins and license

Margin's review foundation was extracted from [Edda](https://github.com/Becomingw/Edda) v0.19.0, reusing and adapting its editor, inline revisions and comments. The new mist-blue and mint icon follows the same matte mascot style. This public repository starts at an independent root commit without Edda's Git history. **That does not mean every source file is new:** unused inherited modules and older documentation are still being extracted.

This is separate from the older Margin implementation and does not reuse its DOM / Node backend. The MIT license and original attribution are retained. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
