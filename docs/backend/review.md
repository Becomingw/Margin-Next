# 审阅工作区（reviews/）

审阅工作区承载**正在产出、尚未发表**的稿件（审阅修改用论文）。它与 `papers/`（阅读用的已发表文献）是两个并列实体：

- 目录：`reviews/<id>/`，与 `papers/`、`notes/` 平级，永不进入 catalog、不拉取 arXiv / DOI 元信息、不做版面分析、不下载代码。
- 单向可达：稿件可以用双链引用 `papers/…`（参考文献）；`papers/` 中的笔记不引用审阅稿件。
- 不转换：审阅稿不会变成 `papers/` 下的论文。
- 业务实现在 `crates/edda-core/src/features/review/`，Host 壳在 `src-tauri/src/features/review/`。

## 目录与权威

```text
reviews/<id>/
├── manuscript.md        # 待审阅正文（纯 Markdown，编辑器直接读写）
├── review.json          # 唯一审阅真源：修订链、评论、事件流
├── revisions/<rev>.md   # checkpoint 快照（每轮一份，不是每次编辑一份）
└── assets/              # 正文内嵌图
```

- `manuscript.md` 是正文事实来源，**不向其注入任何审阅标记**。
- `review.json` 是唯一审阅真源，`format: "edda-review"`、`version: 1`。`id` 等于文件夹名，`title` 可改而不改文件夹。
- MCP 的正文替换在正文中立即生效，并在 `events[]` 中以 `actor: "agent"` 记录替换片段及定位上下文；人工编辑仍记为 `author`。AI 批注 / 回复也记录 `actor`（旧批注缺省为 `author`）；编辑已有批注保留原作者，并记录 `editedBy`。基线确认仅由桌面端操作。
- 多个 Agent 同审：批注、回复与事件另记 `agent`（Agent 名，优先取连接地址里的 `?agent=`（外部 Agent 由用户配置；应用内 Agent 由 Edda 按其显示名自动写入工作区 MCP 地址，`WorkspaceToolsProvider::open` 的 `agent`），否则取其 MCP 连接 `initialize` 的 clientInfo `title`/`name`，`rmcp` 等 SDK 默认名记为「Agent」，经 `agent_display_name` 去掉零宽等不可见字符后规范为 Claude Code / Codex / Antigravity / Gemini 等，读取 `review.json` 时旧记录的名字也按同一规则统一；作者与旧记录为空）。任何 Agent 都可回复任何批注；编辑、解决、重开、删除、恢复他人（另一个 Agent）写的批注会被拒绝（`comment_owned_by_other_agent`），作者在桌面端不受限制。名字是标签，不是经过认证的身份。`review_changes` 用 `ops::attributed_diff` / `line_writers` 给差异块和增删行标注写入者。
- 锚点不是字符偏移，而是 **块 id + 精确引文 + 上下文**：
  - 块 id 为 Obsidian 风格的行尾 ` ^id`，在用户第一次对该段落批注时由编辑器补上（`r-xxxxxxxx`）。
  - `prefix` / `suffix` 各 60 字符，仅用于引文重复时消歧。
  - 原因：Plate 序列化不保证源码字节位置稳定，字符偏移会漂移。

## 数据模型（review.json）

| 字段 | 说明 |
|---|---|
| `revisions[]` | `{ id, parentId, hash, createdAt, reason, file }`；第一条为创建时的基线快照 |
| `baselineId` | 当前轮对比的基线（「原始版本」） |
| `baselineText` | 不再写入文件：读取时从 `revisions/<基线>.md` 取得（旧文件里的副本只在快照缺失时使用），保存时不写出 |
| `manuscriptHash` | 上次审阅操作确认的正文 SHA-256；旧稿首次打开时初始化，不推断之前未知的文件历史 |
| `comments[]` | `{ id, blockId, quote, prefix, suffix, heading, body, actor, editedBy?, status, anchor, replies[], createdAt, updatedAt }` |
| `comments[].status` | `open` / `resolved` / `deleted`（删除为软删除，可恢复） |
| `comments[].anchor` | `attached` / `modified` / `deleted` / `unlocated`，由 Host 在打开与保存时重算。引文先在 Markdown 源（去掉 `^id`）中查找，找不到再到各块渲染后的纯文本（`pulldown-cmark`：转义还原、去掉强调 / 链接 / 代码标记）中查找，因为编辑器复制的是显示文字（`[1]`），Agent 复制的是源码（`\[1]`）；Agent 新建批注时若引文只在源码形态下存在，会改存为显示文字，以便编辑器高亮；Agent 用 `review_manuscript_replace` 改写了某条批注的引文时，`anchor::follow_rewrite` 在渲染文本上算出这次连续改写的范围，把引文映射到改写后的文字（扩到被改写的词、限在一段内）并重算上下文，批注随之保持定位；只在 Agent 的单次精确替换时这样做；作者的编辑由编辑器像 Word 一样实时跟踪批注范围，保存时随 `review_save_manuscript` 的 `anchors` 一并写入（`ops::save_manuscript`），外部改动（`external`）不移动批注；`deleted` 表示引文已不存在，UI 标为过时，不计待处理，状态保留以便引文恢复后重新附着 |
| `comments[].replies[]` | `{ id, body, actor, agent?, createdAt, editedAt? }`；只有写下回复的一方能编辑（作者改自己的，各 Agent 改自己的；无名旧 AI 回复任何 Agent 可改，否则 `reply_owned_by_other`）。删除：作者可删任意回复，Agent 只能删自己的；删除直接移出线程，`reply-delete` 事件只记谁删了哪条，不保留原文 |
| `comments[].source` | `manuscript`（块 id + 引文）或 `pdf`（页码 + 引文）；PDF 评论不参与重定位 |
| `events[]` | `created` / `edit` / `external-change` / `comment-*` / `reply-edit` / `reply-delete` / `checkpoint`；回复事件带 `replyId`；已知前文的编辑事件携带 `before` / `after` 文本与同一行内前后各 24 字的 `prefix` / `suffix` |

### 锚点重定位（`anchor::locate`）

1. 块 id 仍存在且引文仍在该块内 → `attached`。
2. 块 id 存在但引文已离开该块，且全文唯一 → `modified`。
3. 全文无引文 → `deleted`。
4. 多处出现：有 `prefix + quote + suffix` 上下文且唯一 → `attached` / `modified`；否则 `unlocated`（需要重新定位，列表置顶）。

块文本以空行切分，去掉尾部 ` ^id` 后再搜索，因此引文不会因 id 标记而失配。

## 写入与并发

- 编辑器保存、审阅面板操作和各 Agent 的 MCP 调用都会「读 `review.json` → 修改 → 写回」。每个审阅单元一把写锁（`store::lock_unit`，按单元目录的规范路径区分），所有写入函数在读之前取锁、写完释放：并发写入排队，不会互相覆盖；不同单元互不等待。
- `review.json`、`manuscript.md` 与快照都经 `fs::atomic_write` 原子替换并刷盘（`AtomicOpts::DURABLE`）：读者只会看到完整的旧版或新版，断电或系统崩溃后也不会留下空文件。临时文件名每次唯一（`.{name}.edda-rename-{pid}-{n}.tmp`），文件监听把替换报为目标文件的内容修改。
- 保存前把当前完整的 `review.json` 复制为 `review.json.bak`；`review.json` 无法读取（同步冲突、损坏）时读备份，最多丢失最后一次修改，下次保存写回完整文件。损坏的文件不会覆盖完好的备份。
- 审阅编辑器保存正文走 `review_save_manuscript`：同一把锁内核对磁盘正文、原子写入、记编辑，Agent 的正文替换不会落在写入与记录之间，也不会被作者的保存覆盖（磁盘已变时拒绝保存，前端提示冲突）。普通笔记仍走通用文件写入。
- 刷盘让每次保存多 5–10 ms（后台线程，不占界面）。

## 修订与 checkpoint

- **编辑不生成快照**：每次自动保存按改动处追加 `edit` 事件（`ops::edit_spans`：先按行对齐——共同首尾直接匹配、其余做 LCS——每段连续改动的行再收窄到不同的字符；一处一条，带同一行内的前后文），并重算锚点。原来一次保存只记一条，从第一处改动到最后一处，文首、文末各改一处就把整篇存了两遍。外部改盘记为 `external-change`；重新打开时以已保存的 `manuscriptHash` 检测离线修改。无上次正文缓存时仍能记一次外部变更，但不虚构前后文，不能重建应用未观察到的多次瞬时修改。
- **checkpoint（「本轮完成」）才落快照**：把当前 `manuscript.md` 写入 `revisions/<rev>.md`，`baselineId` 移到新快照，追加 `checkpoint` 事件（可选填本轮说明）。
- **Changes 视图**：基线快照与当前正文做逐行 LCS 对比（上下各 3 行上下文，相邻 hunk 合并；超过 5000 行整体替换）。
- 去重：Host 按 `(vault, review id)` 缓存上一次确认的正文，`record_edit` 与缓存相同则不记事件。这使自写回声和重复调用都是无害的。

## 导出

`review_export` 写出一个普通目录 `<id>-review/`：`manuscript.md`、`REVIEW.md`（人与外部 Agent 可读的阅读材料）、`review.json`、`revisions/*.md`。不打 zip，不写 catalog。目标目录已存在时拒绝覆盖。

## IPC 命令

见 [api.md §3.12](api.md#312-审阅工作区review_)。全部为 `async` + `run_blocking`，返回 `ApiResult`。除 `review_list` / `review_create` / `review_rename` / `review_diff` / `review_export` 外，`review_open` 与写操作返回 `ReviewView`（`ops::view`）：
  - 只含本轮事件（基线 checkpoint 之后，与 `ops::round_events` 一致）；完整历史留在磁盘上，由 `review_edit_history` 分页读取。`agents` 另列全部历史中写过的 Agent（按首次出现排序），颜色在各轮之间保持不变。
  - 基线正文只在可能变化时随附（解析 PDF、接受 / 拒绝修订、确认新一轮、`untracked` 保存）；`review_open` 带上前端已有的基线修订哈希（`knownBaseline`），相同则不再发送。`baselineIncluded` 标明是否随附，前端按哈希沿用已有文本。
  - `stamp` 是 `review.json` 的大小与修改时间，在单元写锁内读写时取得（不写入文件）。
- `review_state_stamp` 只返回当前 `stamp`：文件监听报告 `review.json` 变化时，前端先比对，与自己最后一次收到的相同（自身写入的回声）就不再重读。
- `review_list` 按单元缓存摘要（键为 `review.json`、`manuscript.md` 的 stamp 与 PDF 文件名），`reviews/` 下的任何变化只重新解析真正变了的单元。

- 编辑缓存：`ReviewEditCache`（托管状态），在 `vault_release` 时按 vault 清理。
- 待审导入与自动解析：`review_import` 导入本地 `.pdf` / `.md` / `.tex` 文件；`review_parse_pdf` 复用 PDF 正文解析引擎将 `<id>.pdf` 解析入 `manuscript.md` 并设为初始基线。
- 行内修订接受/拒绝：`review_apply_change` 支持单处或全部接受（更新基线快照）与拒绝（回退正文并重算锚点）；当「修订」关闭时，`review_record_edit` 传入 `kind = "untracked"` 同步推进基线。
- PDF 评论：`review_comment_add` 带 `source: "pdf"` 与 1-based `page`（缺页号则报错）；此类评论锚点恒为 attached。
- 路径归属：`reviews/<id>/` 下任意文件（manuscript.md、`<id>.pdf`、assets/…）都带 reviewId，顶层 `papers` / `reviews` / `notes` 在 `trash_paths` 中受保护不可删除。

## MCP 接口

只读：`review_list`、`review_read`（含批注和回复作者）、`review_changes`（基线至当前正文的分页差异）、`review_edit_history`（分页编辑来源）、`review_manuscript`（正文与校验哈希）。写入：创建、导入、解析 PDF、重命名、批注新建 / 回复 / 编辑 / 状态变更、按原文与哈希替换正文、导出。MCP 不提供修改基线或确认修订的工具，见 [mcp.md](mcp.md)。内置 Skill `edda-paper-reviewer` 约定 Agent 的用法：默认只批注，明确要求才改写正文，且不替用户接受修订。

## Vault 层集成

- `reviews` 加入 `EAGER_ROOT_NAMES`（文件树完整递归）与 `ensure_vault` 的骨架目录（已有 vault 打开时自动补建）。
- 文件监听、wiki 索引无需改动：`reviews/**/*.md` 会被索引，可双链；`review.json` 的变化经 `vault:file-changed` 触发前端刷新。
- 不进入 Library、推荐、广场、阅读热力条，也不进入 `papers/` 的 rescan / 自愈流程。

## 限制与后续

- 不支持多人协同、分支合并；`review.json` 不做冲突合并，由 Git 等外部工具承担。
- 块 id 只在顶层段落/叶子块上可靠；跨块的选区会被拒绝（`selection.singleBlock`）。列表项内的标记只在列表最后一行可被 Host 解析，其余依赖引文唯一性。
- PDF 侧审阅批注、从 `papers/` 引句/引图入稿、MCP 工具：见 [开发草稿：审阅后续](../development/review-followups.md)。
