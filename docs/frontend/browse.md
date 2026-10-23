# 浏览（Browse）

侧栏「浏览」（原「广场」）列出内置站点与用户添加的网站，全部在**原生子 WebView** 中打开，登录状态持久保留。
内置的 Cool Papers / ModelScope 的入库按钮与排版由预设适配器提供（不再经代理 iframe）。设计与取舍见
[../development/browse.md](../development/browse.md)。

## 侧栏

```text
论文库
└─ 论文池            ← 原在广场下，路径仍为 edda:plaza/paper-pool
回收站
Skill 管理
浏览                 ← plazaEnabled 控制显示；内部 id 仍为 edda:plaza
├─ Cool Papers / ModelScope 论文（内置，右键「浏览」可隐藏，plazaHiddenSources）
├─ <用户网站>        ← edda:plaza/site/<id>
└─ ＋ 添加网站
```

- **添加网站**：输入网址（可省略 `https://`）与可选名称；`normalizeSiteUrl` 只接受带点的公网主机名或
  `localhost` 的 http(s) 地址。名称默认取主机名（去掉 `www.`）。同一地址不会重复添加。
- **右键网站**：重命名、在系统浏览器中打开、清除登录数据（删除发往该主机的 Cookie）、移除网站
  （同时关闭其标签与视图；登录数据保留，需要时先清除）。
- 网站列表存设置 `browseSites`（`{ id, name, url }`，全局，不随知识库）；Host 与前端都会丢弃非法项。

## 原生视图

浮层发现由 `createViewCoverageProbe` 缓存候选元素，DOM 插入／移除及相关 role 属性变化才重新扫描；矩形仍逐帧测量，保留菜单动画、布局移动与遮挡判断的及时性，卸载时断开 observer。空闲时不再每帧全局扫描长文稿 DOM。

Host 将视图的检查／创建、位置显隐、关闭与适配器重建放在同一个异步生命周期锁内。并发 `browse_open`（包括开发模式重复挂载）只创建一次，其余请求复用现有页面；创建尚未完成时的隐藏／关闭请求也会等待，避免重复 label 报错及切走后残留原生视图。等待锁不阻塞原生 UI 消息线程。

标题栏布局按钮采用点击／键盘激活菜单，悬停仅原生提示。Windows 上浮层与网页相交时先用 WebView2 `CapturePreview` 取得当前画面，解码并绘制后才隐藏原生视图；浮层消失先恢复原生视图，再释放画面（#4）。菜单后方不再变成空白，页面本身不重载。

| 环节 | 实现 |
|---|---|
| 创建 | `browse_open`：在当前窗口 `add_child` 一个子 WebView，标签 `browse-<window>-<site>`；已存在则只定位并显示，页面状态保留 |
| 跟随 | `BrowseView`（`components/plaza/browse-view.tsx`）每帧比对占位元素的矩形，变化时 `browse_bounds`；侧栏收起、分栏拖动、窗口缩放都即时跟随 |
| 避让 | 模态浮层栈或与网页相交的菜单、列表框、Radix 浮层、Dialog / Sheet 遮罩、Toast、`ViewportFloating` 触发避让；非模态注册本身不影响网页，已挂载但不可见的浮层不触发。Windows 以当前画面接替原生视图，支持重叠 tooltip；浏览工具栏仍使用原生 `title`。拖拽同样接替，结束 / drop / 窗口失焦解除拖拽状态 |
| 生命周期 | 切换标签只隐藏；`trackBrowseView` 订阅工作区标签，某站点已无标签时 `browse_close` |
| 持久登录 | 独立配置档：macOS 14+ 用 `data_store_identifier`，Windows / Linux 用 `<应用数据>/browse-profile`；macOS 12–13 只能共享 Edda 的默认存储 |
| 导航 | http(s) / about / blob / data 在视图内打开；`mailto:` 等交给系统；弹出窗口（含登录弹窗）在同一视图中打开。WKWebView 会丢弃 `target="_blank"` 链接与脚本弹窗，受信桥在顶层页面把前者改为 `_self`、把有用户手势的 `window.open` 改为当前页跳转 |
| 地址栏 | 页面加载事件更新；`pushState` 之类的站内跳转不触发事件，面板可见时每秒以 `browse_location` 同步一次 |
| 下载 | 存入系统「下载」文件夹（重名加序号），完成后 Toast 提示 |
| 工具条 | 后退 / 前进 / 刷新（加载中旋转）/ 可编辑地址 / ✦ 让 Agent 改进（优化排版、让论文可入库）/ 适配器开关（有适配器命中时）/ 加入论文库 / 在系统浏览器打开；地址来自 `browse:page` 事件 |

### 浮层画面接替的边界

- `browse_snapshot({ label })` 是应用 IPC，返回内存 PNG data URL；3 秒超时、16 MiB PNG 上限，不写磁盘，不添加 MCP 工具。Windows 原生 COM 操作留在 UI 线程，命令异步等待回调。
- `createBrowsePresentation` 串行提交显隐，只在一次连续遮挡开始时截取一帧；空闲不截图，多个浮层叠加复用画面。快速关闭丢弃过期结果；卸载、StrictMode 重放、图片解码晚到都不会恢复旧视图或清掉新实例的帧。恢复 IPC 短暂失败保留画面，最多额外重试两次。
- 画面接替期间网页暂停视觉更新与鼠标交互，浮层关闭恢复原页面及滚动位置；这不是原生实时合成。截取失败只报告一次并退回原来的隐藏避让，保证菜单仍可操作。
- macOS / Linux 暂无画面接替，仍使用原来的交互浮层隐藏避让并忽略信息性 tooltip。跨平台原生合成 / 画面接替及后台画面持续更新属于后续工作，不能视作已完成。
- 实测与回归入口见 [浏览浮层白屏复盘](../bug_fix/browse-overlay-handoff.md)。

## Agent 读页面

Host 用 `eval_with_callback` 在页面里执行一段自包含的取数函数（`features/browse/page.rs`），按层返回：

| 层 | 内容 |
|---|---|
| `summary` | URL、标题、语言、选中文字；论文元数据：`citation_*`、Dublin Core / PRISM、JSON-LD（标题、DOI、arXiv、PDF 链接、作者、期刊、日期、摘要），适配器 `detail` 优先；适配器状态（命中的适配器、错误） |
| `outline` | 地标（含宽度）、h1–h4 标题、重复条目列表（容器选择器 + 条目数），用来定位结果列表与正文块 |
| `text` | 主内容（`article` / `main` / `body`）或指定 `selector` 的文字，按 `offset` / `limit` 分段（单次至多 16000 字） |
| `links` | 页面上的 DOI / arXiv / PDF 链接及锚文字 |
| `targets` | 适配器声明的可入库论文（按钮、`importTargets`）与条目（`items`） |

- **页面对话**（`page:<tab path>`）每次发送自动附带 `summary` 元数据与正文前 6000 字（`browsePageSnapshot`），
  元数据在前，保证不被快照预算截掉；末尾注明视图标签。
- **Agent 工具**：内置 Agent 连接上的 MCP 工具 `browse_tabs` / `browse_page` / `browse_import`
  （见 [../backend/mcp.md](../backend/mcp.md)），Agent 按需分层读取、翻页、按选择器读块。
  外部 MCP 端口不提供这组工具（无鉴权端口不得读取登录后的页面）。
- 这些都是规则提取，不经模型；页面内容一律当作网站数据，不当指令。

## 加入论文库

工具条「加入论文库」与 `browse_import` 走同一条 Host 流程（`features/browse/import.rs`）：

1. 读 `summary`，标识优先级：DOI → arXiv id → 页面 URL（Agent 可显式传 `identifier` / `pdfUrl` 覆盖）。
2. 走普通标识导入（Translator / Crossref，含开放获取 PDF 下载），已存在则去重。
3. 仍无 PDF 且页面有 PDF 链接时，由**浏览视图用自己的登录会话**下载（`fetch.rs`）：
   - 先在当前页面里 `fetch(url, { credentials: "include" })`，同源链接（Springer、IEEE `stamp.jsp`）直接成功；
     返回 HTML 包装页时，按 `citation_pdf_url` / `iframe` / `embed` / PDF 链接继续跟进；
   - 跨域跳转（ScienceDirect `pdfft` → `pdf.sciencedirectassets.com`）会被 CORS 拦下，改为在同一配置档的
     隐藏视图里打开该链接，落地后在该页同源取回；若触发下载则直接接收文件。
   - 字节经 `eval_with_callback` 分块（base64）回到 Host，校验 `%PDF-` 后用 `paper_attach_pdf` 挂到论文，
     随后照常排队正文解析与版面分析。Cookie 始终留在 WebView 里，Edda 不读取。
4. Toast 报告结果：已加入 / 已在库中 / 已加入但未取得 PDF（附原因）。

## 划词

原生视图压在应用界面之上，应用的浮层画不到它上面，所以划词工具条与翻译卡由受信桥画在**页面里**
（`<edda-overlay>` 的 closed shadow root，样式与页面隔离，跟随系统深色模式）。只在用户浏览的视图的顶层页面启用，
测量 / 下载等辅助视图不启用。

| 环节 | 实现 |
|---|---|
| 工具条 | 选区结束（鼠标抬起、Shift 选择）时在选区上方显示「翻译」「问 Agent ⌘L」；滚动、清空选区、Esc 时收起；按下按钮不丢选区 |
| 上报 | 工具条按钮的真实点击 → `edda-action://selection`（`{action: translate \| ask, text ≤ 4000, url}`）；选区结束 / 清空时另发 `stage`（空文本即清空）。Host 校验 token、按种类限频（`stage` 100 ms，其余 250 ms）后发 `browse:action` |
| 待引用选区 | `stage` 让应用把页面选区作为当前待引用选区（与 PDF 一样）。焦点在原生视图时，⌘L 由**原生菜单加速键**触发（页面收不到），菜单与键盘快捷键共用「有待引用选区则钉住并打开 Agent，否则切换 Agent」；⌘K 没有菜单项，由页面桥直接按「问 Agent」处理 |
| 问 Agent | 应用 `publishSelection`（来源为页面 URL）→ 钉住引用 → 打开 Agent 并聚焦输入框；页面选区随即清除 |
| 翻译 | 页面先在选区下方开卡片（「翻译中…」）；应用以 `translateWebSelection`（`lib/translate/selection.ts`，与网页论文阅读器共用：Agent 流式或免费 MT）翻译，经 `browse_overlay` 把结果推回卡片（每 120 ms 至多一次）；卡片可复制、关闭 |
| 文案 | 打开视图时由前端经 `browse_open` 传入（复用 viewer 的 `selection.*` 文案），重建视图时沿用 |

## 让 Agent 改进

工具条 ✦ 菜单的两项各自打开 Agent 面板，把带 Skill 的请求预填进当前页面对话的输入框（可修改后发送）：

| 菜单项 | Skill | 预填请求 |
|---|---|---|
| 优化排版 | `site-layout` | 让网站在当前面板宽度下不横向溢出 |
| 让论文可入库 | `site-import` | 给网站上的论文加入库按钮 |

预填经 `setPendingAgentComposerPrompt`。面板刚打开时会切到页面对话并载入其已存草稿；预填与引用写入输入框时
登记为「随会话切换携带」（`use-session-composer-state.ts` 的 `holdForNextSession`，4 秒内有效、发送即失效），
切换时并入新会话的草稿而不被覆盖。

### 排版测量 `browse_check`

`measure.rs` 在同一配置档的隐藏视图里重新打开当前页（已登录、注入当前适配器，用户视图不受影响），依次缩放到
各宽度（默认 480 / 750 / 1000，320–1600，至多 4 个）测量：横向溢出、最外层越界元素（含 `min-width` / `width`）、
被挤成窄列的文字、大面积固定 / 粘性浮层，以及适配器错误。等待加载以 `document.readyState` 为准：`complete`，
或 DOM 就绪满 5 秒（有常驻连接的站点不会报告加载完成），总超时 40 秒；同时只跑一个测量。

## 网页适配器

适配器给匹配的页面注入排版 CSS 与页面脚本（`features/browse/adapter.rs`、`bridge.rs`）。

| 项 | 说明 |
|---|---|
| 匹配 | URL 模式：`host`（含 `www.`）、`*.domain`（含子域），可带 `/路径前缀`；同一视图跨站跳转时按每个页面（含 iframe）的地址判断 |
| 存放 | `<应用配置>/browse/adapters/<id>/`：`adapter.json`（名称、模式、开关）、`layout.css`、`page.js`、`history/<n>/`（每次写入一版，保留 30 版） |
| 预设 | 随应用发布、只读：`arxiv`（列表与搜索结果每篇旁的「+ Edda」按钮）、`coolpapers`（每行入库；arXiv 行按 arXiv id，其余行经该行 papers.cool 页面的 `citation_*` 入库）、`modelscope`（`modelscope.cn/papers`：卡片与详情页入库、窄面板单列排版、隐藏站点导航与引导浮层）。写入预设时只写其上的追加层；回滚到版本 0 即去掉追加层 |
| 注入 | 视图创建时作为 initialization script 注入所有 frame：先受信桥，再每个启用的适配器层各一个脚本——某层语法错误只让该层失效，桥会报告「未运行的层」。改动后 Host 关闭并按当前页面、位置重建打开的视图（脚本只能在创建时设置） |
| 校验 | `layout.css` ≤ 64 KiB，禁止 `@import`、`expression()` 与远程 `url()`；`page.js` ≤ 32 KiB，禁止 Cookie / 存储 / `fetch` / XHR / WebSocket / `sendBeacon` / 表单提交 / `eval` / `Function` / 动态 import / 脚本元素 / `postMessage` / 跳转。这是收窄能力而非沙箱 |
| 开关 | 页面被适配器覆盖时工具条显示拼图按钮，切换这些适配器的启用状态并重载视图 |
| 撤销 | Agent 写入或回滚后发 `browse:adapter` 事件，应用弹出 Toast（附 Agent 的说明）与「撤销」，即恢复上一版本 |

### 受信桥 `edda`

页面脚本以 `function (edda) { … }` 运行：

| API | 作用 |
|---|---|
| `edda.ready(fn)` / `edda.observe(fn)` | DOM 就绪后运行；`observe` 在 DOM 变化后（400 ms 防抖）重跑，适合 SPA 与无限列表 |
| `edda.importButton(el, {doi \| arxiv \| url, title, pdfUrl})` | 在 `el` 后放「+ Edda」按钮，同一元素只放一次；同时登记为可入库目标 |
| `edda.importTargets(fn)` / `edda.items(fn)` | 不放按钮也声明论文 / 条目，供 `browse_page` 的 `targets` 层读取 |
| `edda.detail(fn)` | 覆盖文章页元数据（`title`、`doi`、`arxiv`、`pdfUrl`），`summary` 与工具条入库都会用它 |
| `edda.text(fn)` | 覆盖正文来源（如 ModelScope 详情页 `<main>` 只有页脚），`text` 层与页面对话快照使用 |
| `edda.markStable(selector, name)` | 给元素加 `data-edda="name"`，供 CSS 与后续选择器使用 |

按钮只响应**真实点击**（`event.isTrusted`）：点击时桥以 `edda-action://import?t=<token>&d=<json>` 发起伪导航，
Host 在 `on_navigation` 中校验视图专属 token（页面脚本读不到）、同视图 700 ms 限频后取消该导航，发出
`browse:action`；面板随后走与工具条相同的入库流程（同一目标并发去重）。

## 清除登录数据

- 单个网站：右键 →「清除登录数据」→ `browse_clear_site`（`cookies_for_url` + `delete_cookie`）。
- 全部：设置 → 通用 → 数据 →「清除浏览数据」→ `browse_clear_all`（`clear_all_browsing_data`）。
  仅在配置档独立时可用（`browse_profile_isolated`）；macOS 12–13 按钮禁用，以免清掉 Edda 自身数据。

## 开发注意

- **不要在 Host 命令里用 `tauri::WebviewWindow`**：窗口一旦挂上浏览子视图就不再是 WebviewWindow
  （Tauri 的 `is_webview_window()` 要求窗口只含一个同名 webview），以 `WebviewWindow` 为参数的命令会报
  「current webview is not a WebviewWindow」，`get_webview_window` 也会返回空。命令参数用 `tauri::Webview`，
  查窗口用 `get_window`。事件按标签投递，不受影响。
- 新增 Host 事件要同时登记到 `app/events_contract.rs` 与 `bindings_test.rs`，否则契约测试失败。

## 代码

| 层 | 路径 |
|---|---|
| Host | `src-tauri/src/features/browse/`：`mod.rs` 视图与命令（需 Tauri `unstable` 特性）、`page.rs` 分层读取、`fetch.rs` 带登录下载 PDF、`import.rs` 入库、`adapter.rs` 适配器存储与校验、`bridge.rs` 受信桥与注入、`measure.rs` 排版测量、`presets/` 预设 |
| MCP | `src-tauri/src/integration/mcp/browse.rs`；Skill `templates/vault/.agents/skills/site-import`、`site-layout` |
| 设置 | `browseSites`（`src-tauri/src/features/system/settings/mod.rs`、`src/lib/settings`） |
| 前端逻辑 | `src/lib/browse/native-view.ts`、`src/lib/plaza/sources.ts`（`browseSiteSource` / `browseSiteForPath`） |
| 组件 | `components/plaza/browse-view.tsx`、`browse-site-dialog.tsx`；侧栏 `file-tree/` 的 `plazaAdd` 行与右键菜单 |
