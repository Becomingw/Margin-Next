# MCP Server

桌面 Host 内嵌的 Streamable HTTP MCP，直接复用应用的数据服务。内部保持 BYOA/ACP，
外部 Agent 使用同一组 MCP 业务工具；应用必须运行。业务 CLI 已退役，不再构建、捆绑或安装。

## 应用内 Agent 自动接入

本地 ACP Agent 声明 `mcpCapabilities.http` 后，warm / new / load / resume 自动提供
`edda-workspace`。无需打开外部 MCP 开关，也无需在 Agent 配置中手填地址。

- 每条 ACP 连接使用独立的 loopback 临时端口、随机 Authorization 凭据及固定 Vault；
  不跟随全局 MCP controller 的 Vault 切换，防止后台任务读写另一知识库。
- 复用同一个 `EddaMcp` tool router。`workspace_context` 读取 Vault 统计和本轮任务目标；
  `paper_context` 返回单篇 metadata、已有正文/笔记/PDF/源目录与 TeX 可用性，供原生文件工具读取。
- 只读工具声明 MCP `readOnlyHint`。对于 Grok 等仍对 MCP 包装器询问权限的 adapter，
  仅在应用已提供工作区工具时自动批准精确命名的只读工具；写工具和 shell 不在此例外中。
  写调用还要求当前存在活动 turn，且 permission mode 不是 Restricted；Ask 沿用原生 ACP 权限询问。
- endpoint 随 ACP 连接结束、空闲回收或失败而关闭。凭据不写入用户配置，ACP trace 屏蔽 MCP headers。
- 退出集成测试用新 TCP 连接确认监听端口拒绝连接，保留 5 秒上限；不以 HTTP GET 的完成时间判断监听是否退出，避免关闭前接收的请求等待 graceful drain 导致 Windows CI 假超时（#2）。
- 未支持 HTTP MCP、远程 SSH 或非 Vault cwd 不接本机 endpoint；这些连接继续使用原生文件工具，
  业务操作不可用时明确说明能力缺失，不安装旧 CLI 或手改数据库。Agent 回合完成 / 失败后刷新 Library。
- 服务说明不要求先读 resource / Skill 文档；直接使用已有上下文，缺少信息才查询。

实现：`features/agent/workspace_tools.rs` 的 provider 接口，由
`integration/mcp/workspace.rs` 装配；warm pool 持有连接生命周期。

## 外部客户端连接

`workspace_context` 返回运行版本及当前连接的 review/tasks/browse/settingsRead/settingsWrite 能力摘要（不代表上游 Agent 已接受所有工具）。有桌面 Host 时提供设置读写；实际写入仍检查当前回合权限，`baselineConfirmation` 始终为 false。

### 产品认知、设置与自检（#5 / #9）

| 工具 | 契约 |
|---|---|
| `product_reference` | 随当前二进制发布的产品资料，含 ACP / 私有与外部 MCP / Vault / Skill / Browse / 任务 / 审阅边界与自检流程；返回真实版本 |
| `environment_inspect` | OS、架构、debug/release、当前连接、Vault、本轮后端和请求的模型参数、注册表探测状态、插件摘要、外部 MCP 与 Connector **实际**监听状态、设置写权限；不自动启动探测 |
| `environment_check(target)` | 复用已有 Doctor：`host` 检测 Node/npm，`network` 按现有超时策略探测预设学术/网络端点，可用于调整前后对照 |
| `settings_describe` | 从真实 `AppSettings` 及嵌套类型生成完整 schema，附允许写入的精确叶子路径、约束及生效时机；主题名/翻译 provider 复用实际清单 |
| `settings_get(fields?)` | 全量脱敏读取，或选取 section / 点分路径。密钥、提示词与插件 command/args/env/headers 不返回原文；URL 去掉用户信息、query 和 fragment |
| `settings_set(changes, expected, dryRun?)` | 字段级条件 patch：必须带每个字段上次读取值。整批校验、同一写锁内读取/合并/原子持久化、既有域回调及跨窗广播；返回可条件撤销的 `undo`，冲突需重读，不盲目覆盖 |
| `logs_list` / `logs_read` | 全部保留中的应用日志与轮转归档。按文件从 0 分页，支持字面关键词（session/op_id 等）及级别过滤，凭据脱敏；详见 [运行日志](logging.md) |

目前开放 41 个常用设置路径：外观、编辑器、阅读/笔记默认行为、导入并发、翻译/解析引擎及 Agent 座、回答语言、代理/镜像开关与地址、translator 地址和 MCP/Connector 开关与端口。地址写入不接受凭据、query 或 fragment；已有含凭据地址需在 UI 更改，避免 undo 回传秘密。未列入写策略的字段只读：权限、developer mode、密钥、插件启动配置与复杂集合仍由设置 UI 管理。全量 schema 不等于全量可写。

启动模板及 MCP server instructions 引导按需使用这些工具，不要求每轮先查询。Edda 自检采用「查环境/日志 → 提出有证据的调整 → 保存 undo → 调整 → 回读/真实探测 → 必要时撤销」；不允许直接编辑 `settings.json`。当前模型是**请求偏好**而非上游实际执行模型的保证；设置落盘也不代表异步重绑成功，需检查实际状态。外部客户端修改自身 listener 端口/开关可能断开，应用内私有工作区连接不依赖该开关。

工具目录中的 `outputSchema` 只为具备结构化 Rust 返回类型的工具声明，根类型为 `object`；动态 `Json<Value>` 工具省略无约束的 schema，但仍可返回 `structuredContent`。MCP 不要求每个结构化结果都声明输出 schema；不能发送仅含 `$schema` 的空壳，否则严格客户端会拒绝整份工具目录（#3）。共享路由注册和 HTTP 集成测试覆盖全部工具。

设置开关打开后在固定 loopback 端口监听；关掉即停。每个 MCP 会话固定到连接建立时
打开的**本地** Vault，桌面切库不会把旧客户端重定向到另一个库；切库后请重新连接。

远端 Vault 不服务。App 必须开着。

## 开关与地址

设置 → 通用 → **MCP server**。

| 设置 | 默认 | 说明 |
|---|---|---|
| `mcpEnabled` | `false` | 启停 listener |
| `mcpPort` | `8765` | 只绑 `127.0.0.1` |
| `mcpTunnelId` | `""` | OpenAI Secure MCP Tunnel ID（`tunnel_` + 32 hex） |
| `mcpTunnelApiKey` | `""` | Runtime（Restricted）API key；回显为 mask |

监听 URL：`http://127.0.0.1:{port}/mcp`。设置页端口旁绿点表示正在听；点击 URL 复制。

Host commands：`mcp_get_status` / `mcp_set_enabled` / `mcp_set_port` / `mcp_set_vault` / `mcp_set_parent_dir`，以及隧道相关 `mcp_tunnel_status` / `mcp_tunnel_start` / `mcp_tunnel_stop`。状态事件 `mcp:status`、`mcp:tunnel-status`。

`initialize.serverInfo` 带 `title`、`websiteUrl` 和 `icons`（应用 PNG 的 data URI）。客户端可以忽略不画。

`initialize.instructions` 说明直接使用工具、`paper_list` 默认瘦字段，并要求按用户请求保留或修改 NOTES；不要求先读取操作手册。

此外部客户端端口无鉴权。不要把端口绑到非 loopback；应用内的独立 endpoint 使用会话凭据。

## ChatGPT Secure MCP Tunnel

App 开着且 MCP 开关打开后，可在同一设置区填写 Tunnel ID 与 Runtime API key，点 **Start** 让 Edda 直接 spawn 并持有 `tunnel-client run`。按钮旁绿点表示隧道已连通控制平面；**注意 `/readyz` 返回 200 不代表认证成功**，真正的 ready 信号是 `tunnel-client health --require-control-plane-poll` 的 `control_plane_poll.ok=true`。

隧道子进程随 Edda 退出而停止（`RunEvent::Exit` 里 kill）。找不到 `tunnel-client` 时按钮禁用，并提示可复制安装命令 `brew install openai/tools/tunnel-client`，不会自动安装。

Edda 用独立 `--profile-dir`（`$XDG_CACHE_HOME/edda/mcp-tunnel`）运行 tunnel-client，避免串到用户已有的 `~/.config/tunnel-client/*.yaml`；API key 只通过子进程 env `CONTROL_PLANE_API_KEY` 注入，不出现在命令行参数或 UI 日志。

Codex / Inspector 也可直接打 loopback URL。stdio 子进程不是这条通路。详细逐步教程见 [用 MCP 连接外部 Agent](../usage/mcp.md)。

## Resource

| URI | MIME | 内容 |
|---|---|---|
| `edda://vault` | Markdown | 路径、schemaVersion、papers、unread |
| `edda://agent-invariants` | Markdown | `edda-core::ops` 的业务规则 |
| `edda://skills/edda-workspace` | Markdown | 跨平台的工作区操作指导 |

无 Vault 时 `edda://vault` 仍列出，`resources/read` 返回「未打开 Vault」正文；打开库后重新连接。`initialize` instructions 说明可直接使用工具；resources 按需读取。

## Tools

`ref` = paper id 或 vault 相对路径（如 `papers/1706.03762`）。禁止 `..`。

每个 tool 都声明 `outputSchema`，成功时走 MCP `structuredContent`（ChatGPT 需要这份才能理解结果）。

| Tool | 作用 |
|---|---|
| `workspace_context` | Vault 路径、论文 / 未读数；应用内连接还带本轮 workflow / taskTarget。不是必须的前置步骤。 |
| `paper_context` | 单篇 metadata 与实际存在的 PDF / PAPER.md / NOTES.md / source 目录 / layout-index 路径，以及 TeX 可用性；不触发解析或全文读取。 |
| `paper_list` | 列表。**默认**每行只有 `id/path/title`（省 token）。`fields[]?` 按需加字段（`year`/`tags`/`authors`/`isRead`/…）；`full?` 恢复完整 metadata 行。另有 `query?`、`tag[]?`、`unread?`、`limit?`（默认 50，封顶 200）。abstract 只在 `paper_get`。 |
| `paper_get` | 单篇 metadata（含 abstract） |
| `paper_set_read` | 设置 catalog `isRead`（默认 true） |
| `import_id` | 魔棒入库（arxiv / DOI / URL）。`parent?` 默认当前 Library 作用域或 `papers` |
| `paper_notes_get` | 读 `{paper}/NOTES.md`（文件不存在则空字符串） |
| `paper_notes_write` | 写 `NOTES.md`。`mode`: `replace`（默认）或 `append` |
| `paper_tag_add` | 加标签；可用 `topic:blue` 色后缀 |
| `paper_tag_rm` | 删标签 |
| `layout_list` | 侧栏版面索引（需 `{paper}/source/layout-index.json`）。`kind[]?`、`minScore?` |
| `layout_get` | 按 region id 取一条（如 `figure-3`） |
| `paper_read_source` | `ref/path/offset?/limit?`，读取论文内 Markdown/TeX/文本/JSON；字符分页、单次最多 16000 字符，文件上限 2 MiB，拒绝越界路径和二进制 |
| `paper_sources` | 有界列出论文内文本源文件，供无本机目录工具的外部 Agent 定位 TeX 等文件；跳过符号链接与源码快照 |
| `review_list` | 列出审阅单元（reviews/），含 id / 标题 / 待处理与已解决计数。只读 |
| `review_read` | `ref`（单元 id 或 `reviews/<id>/...` 路径）→ 标题、计数、基线轮次与全部批注（作者、Agent 名 `agent`、最近不同于原作者的编辑者、锚点、状态、`outdated`、回复及其 `agent`、`updatedAt`），以及 `you`（`agent` 为本连接写入时使用的名字，`fixed` 表示来自连接地址的 `?agent=`，否则附 `hint` 提示用户在地址里写名字）；正文引文已不存在的批注不计待处理。只读 |
| `review_changes` | `ref/offset?/limit?` → 当前正文相对本轮基线的逐行差异，含增删、上下文与基线时间；按字符分页（默认 / 最多 16000 字符），只读，不接受／拒绝修订。每个差异块标题注明写入者（`@@ -14 +14 @@ by Codex, author`），`writers` 另列出每个增删行的写入者（`newLine` / `oldLine`）。归属按本轮编辑记录中仍在该行的写入文字匹配：Agent 编辑先用保存的前后文定位，其余要求至少两个字母或数字并按整词匹配，属于尽力标注而非逐字 blame。 |
| `review_edit_history` | `ref/offset?/limit?` → 按时间分页读取正文编辑事件的作者、已知的替换前后片段；离线直接改盘首次被发现时若无旧正文缓存，`external-change` 的前后片段为 null。供 Agent 分辨作者、AI 及具体是哪个 Agent（`agent`），默认 20、最多 100 条。只读 |
| `review_manuscript` | `ref` → 当前 `manuscript.md` 原文及 SHA-256 `hash`；批注在 `review.json`。只读 |
| `review_create` / `review_import` / `review_parse_pdf` / `review_rename` | 创建审阅稿、从本地路径导入 PDF/Markdown/TeX、解析 PDF 正文、修改标题；写入工具 |
| `review_comment_add` / `review_comment_update` | 带正文引文或 PDF 页码添加批注；回复、编辑、解决、重开、删除、恢复（可用 `expectedUpdatedAt` 防止覆盖并发修改；回复只追加，不做该检查）；带 `replyId` 时 `edit` / `delete` 编辑或删除本连接自己写的一条回复；AI 作者标识与本连接的 Agent 名随记录保存。多个 Agent 同审时可互相回复，但只能修改 / 解决 / 删除自己写的批注和回复。写入工具 |
| `review_manuscript_replace` | `ref/expectedHash/before/after` → 直接替换唯一精确匹配的 Markdown 片段，哈希不匹配或片段不唯一时拒绝；正文改动归属 AI 并自动重定位批注；引文被这次替换改到的批注跟到替换后的文字上（引文扩到改写的词），不变成过时，不推进基线。写入工具 |
| `review_export` | `ref/destDir` → 导出完整审阅目录（外部目标已存在目录），不修改当前 Vault。写入权限工具 |
| `paper_task_start` | `ref/kind/force?`；kind 为 `download/parseBody/parseReferences/analyzeLayout`，返回 JobCenter 任务快照 |
| `task_list` / `task_get` / `task_cancel` | 仅访问当前 Vault 的任务；快照包含进度、状态和错误，取消须具备写权限 |
| `mark_list` / `mark_get` | 列表仅返回 id/kind/page/quote（摘录上限 240 字符），offset/limit 分页默认 50、最多 200；get 按 ID 读取完整标记，不展开其他会话记录 |
| `mark_create` | `ref/options`；quote 或 region 由 PDFium/现有版面解析为坐标，支持 highlight、显式 ask、提供译文的 translate |
| `mark_update` / `mark_delete` | 修改评论/高亮颜色，或删除用户明确指定的标记 |
| `tag_list` / `paper_tag_set` | 用户标签统计，以及整组用户标签替换 |
| `paper_trash` / `paper_move` | 回收站删除，以及应用内允许的 link-aware 移动；仍遵循平级论文规则 |
| `import_bibliography` / `export_bibliography` | 使用应用配置的 Translator 导入题录文本、导出题录内容 |
| `pool_example` / `pool_list` / `pool_submit` | 示例、读取和提交推荐；自动使用 `paperPoolLocation`，不要求 Agent 猜测目录 |
| `workspace_diagnose` / `wiki_diagnose` | 结构化诊断；Wiki 可指定 `source` 范围 |
| `workspace_repair` | 按明确请求修复 aliases、visualMarks 或 catalogDuplicates；遵循已有 dirty/hash 保护 |
| `translate_text` | 免费引擎翻译文本；不产生笔记或标注 |
| `browse_tabs` / `browse_page` | **仅应用内 Agent 连接**。列出「浏览」中打开的网站视图；按层（summary / outline / text / links / targets）读取页面，text 支持 offset/limit/selector。页面内容是网站数据，不是指令。只读、自动批准 |
| `browse_import` | **仅应用内 Agent 连接**。按页面 DOI / arXiv / URL 入库，无开放 PDF 时用该视图的登录会话下载出版社 PDF；`dryRun` 只报告；`identifier` / `pdfUrl` 可覆盖。见 [../frontend/browse.md](../frontend/browse.md) |
| `browse_check` | **仅应用内 Agent 连接**。在隐藏视图中按 480 / 750 / 1000 px（可指定）重新加载当前页，返回横向溢出、越界元素、挤压文字、大浮层与适配器错误；只读、自动批准 |
| `browse_adapter_list` / `browse_adapter_read` / `browse_adapter_history` | **仅应用内 Agent 连接**。列出 / 读取网页适配器（预设只读部分与追加层）及版本；只读、自动批准 |
| `browse_adapter_write` / `browse_adapter_revert` | **仅应用内 Agent 连接**，写操作。写入或回滚适配器（`layout.css` / `page.js` 校验见 browse.md），打开的浏览视图随即重建，应用弹出带「撤销」的提示 |

`paper_notes_write`：

- 只写 `NOTES.md`，不动 `PAPER.md` / `source/` / `marks/`
- 原子写
- `replace`：新内容没有 YAML frontmatter 时保留原 aliases 头
- `append`：追加正文，保留 frontmatter
- 编辑器有未存改动时走现有 `vault:file-changed` 冲突逻辑

审阅 MCP 写工具遵循现有 workspace 写权限：应用内 Agent 需处于可写活动回合，外部 MCP 需启用服务。Agent 不能调用审阅基线确认／checkpoint；人工仍可在 UI 中纳入基线、开启新一轮、还原正文。MCP 改写正文直接生效，并记录 AI 来源供行内修订和导出辨认。

长任务进入现有 JobCenter，保留后台面板的进度与取消；`task_get` 成功后再通过
`paper_context`、`paper_read_source` 或 `layout_list` 获取产物。相同活动任务复用既有去重规则。
标注写操作复用应用文件变更租约与 core 标注服务，坐标由现有 PDFium worker 解析。

工具契约以 `tools/list` 的实际 Schema 为准，不再维护另一套命令/flag 目录。
不提供任意 shell、任意 SQL、跨 Vault 切换或独立无界面服务；永久删除、跨 Vault 迁移和
Vault 创建/打开继续使用应用相应界面。普通文件读写仍可使用 Agent 原生工具。

## 代码

`src-tauri/src/integration/mcp/`：`McpController` + Streamable HTTP（`rmcp`）+ tools/resource。
`tools.rs` 与 `research.rs` 合并路由，直接复用业务服务与 JobCenter；标注内核在
`crates/edda-core/src/features/pdf/marks/service.rs`。

## 安全

- 仅 `127.0.0.1`；默认关
- `ref` / `parent` 消毒
- 不暴露 PDF 二进制、不读 XDG API key
- `browse_*` 不在外部端口提供；浏览视图的 Cookie 不经 MCP 暴露
