# 浏览（Browse）— 设计草案

> 状态：设计稿 v2（2026-10）。**P0–P4 已实现**，含原生视图划词浮层与 Cool Papers / ModelScope 迁移
> （见 [../frontend/browse.md](../frontend/browse.md)）。未实现：开发者模式下直接编辑预设。
> 已确认：需要登录且持久保留登录；论文池移到论文库下；适配器放应用配置；
> Agent 可修改各网站的排版与脚本注入；导入出版社论文需要独立 Skill；
> 系统预设的 Skill / 插件 / 适配器只读，开发者模式下才可改（见 [developer-mode.md](developer-mode.md)）。
> 现状参考：[plaza.md](plaza.md)、[../frontend/web-view.md](../frontend/web-view.md)。

## 0. Edda 带 Chrome 内核吗？

不带。Tauri 用系统 WebView：macOS 是 WKWebView（WebKit，与 Safari 同源），Windows 是 WebView2
（Chromium，即 Edge 内核），Linux 是 WebKitGTK。安装包因此只有几十 MB；代价是三平台渲染略有差异，
拿不到浏览器扩展级别的控制。统一 Chromium 只能换 Electron / CEF，包体涨到一两百 MB 且要重写宿主层，不采用。

## 1. 目标

1. 侧栏「广场」改为 **浏览**：内置 Cool Papers、ModelScope，用户可添加任意网站。
2. **登录并持久保留**：在浏览里登录（含学校机构认证）后，重启应用仍保持登录。
3. Agent 能完整感知当前页面（正文、结构、论文元数据），照常基于页面对话。
4. **Agent 能为每个网站写排版优化与注入脚本**，例如让 Springer、Elsevier、IEEE 的论文页可一键入库（含登录后才能下载的 PDF）。
5. 所有修改可见、可撤销；系统预设只读。

## 2. 引擎：原生子 WebView

登录与持久 Cookie 是硬需求，代理 iframe 做不到（匿名转发、不带 Cookie），因此浏览改用**原生子 WebView**：
每个网站标签是窗口上叠放的一个真实浏览器视图，跟随 Dock 面板的位置与尺寸。

| 能力 | Tauri 2.11 接口 | 说明 |
|---|---|---|
| 叠放子视图 | `Window::add_child`（需 `unstable` 特性）、`set_bounds`、`show` / `hide` | 一个网站标签一个视图，标签 `browse-<siteId>-<n>` |
| 持久登录 | Windows / Linux：`data_directory`；macOS 14+：`data_store_identifier` | 浏览用**独立的持久配置档**，与 Edda 自身界面存储分开；macOS 12–13 退回共享默认存储 |
| 注入 | `initialization_script_for_all_frames` | 注入受信桥脚本 + 站点适配器（含 iframe 内的页面） |
| 读页面 | `eval_with_callback` | Host 直接在页面里执行取数函数并拿回 JSON，**页面不需要任何应用 IPC 权限** |
| 页面 → 应用 | `on_navigation` 拦截 `edda-action:` 链接 | 「入库」等动作经伪导航上报，Host 校验后处理并取消该导航 |
| 新窗口 / 弹窗 | `on_new_window` | 同站登录弹窗在浏览内打开；其它交给系统浏览器 |
| 带登录下载 | `on_download` | PDF 由该视图用自身会话下载到暂存目录，再进导入流程；Edda 不读取、不保存 Cookie |

### 2.1 与界面共存（主要难点）

原生视图永远压在网页 DOM 之上，需要一层协调：

- **位置同步**：面板里放占位元素，`ResizeObserver` + Dock 布局事件把矩形同步给 `set_bounds`；
  面板不可见（切到别的标签、分栏折叠）时 `hide`。
- **浮层避让**：应用已有浮层栈（`overlay-stack.ts`）。任一菜单 / 对话框 / 弹出层与浏览区域相交时，
  暂时隐藏该视图并显示占位（页面标题 + 最后一帧截图若可得，否则纯色占位），浮层关闭即恢复；Dock 拖拽期间同理。
- **多窗口**：Agent 面板弹出成独立窗口不受影响；浏览视图只挂在主窗口。

### 2.2 先做技术验证（P0）

在开工前用一个最小分支验证，任何一项不过关都回到本设计重议：

1. macOS / Windows 上子视图随分栏拖动、窗口缩放的跟随是否顺滑；浮层避让的闪烁是否可接受。
2. 登录一个需要账号的站点，重启后仍保持登录；独立配置档与 Edda 界面存储互不影响。
3. `initialization_script_for_all_frames` 在站内跳转、SPA 路由、iframe 中都生效。
4. `eval_with_callback` 取快照的延迟与大小上限；`edda-action:` 拦截可靠。
5. `on_download` 能拿到需登录的 PDF（用一个机构订阅站点验证）。

### 2.2.2 P1 实现取舍

- 内部标识沿用 `plaza`（`edda:plaza/…`、`plazaEnabled`、`plazaHiddenSources`），只改界面名称，避免迁移已保存的标签页。
- 内置 Cool Papers / ModelScope 在 P3 之前仍走原代理 iframe；用户网站走原生视图（已于 P3 迁移，见 §2.3）。
- 弹出窗口在同一视图打开：依赖 `window.opener` 回传的登录弹窗可能失败，常见的机构认证（整页跳转）不受影响。
- 下载暂存入系统「下载」文件夹；P2 接入入库流程。

### 2.2.3 P2 / P4 第一步实现取舍

- **不先做受信桥**：入库入口放在 Edda 工具条和 `browse_import` 工具上，页面里不注入任何脚本；
  `edda-action:` 页内按钮随适配器（P3）一起做。
- **PDF 由页面自己下载**：不把 Cookie 交给 Host 的 HTTP 客户端（Zotero Connector 那条路），而是在页面里
  `fetch` 后分块取回；跨域跳转用同配置档的隐藏视图落地后再取。好处是与用户看到的会话、指纹完全一致，
  不易被出版社的反爬拦截；代价是单篇上限 150 MB、经 base64 传输。
- **工具只给内置 Agent**：外部 MCP 端口无鉴权，`browse_*` 仅在应用为内置 Agent 开的连接上可用；
  `browse_tabs` / `browse_page` 只读，自动批准；`browse_import` 是写操作，遵循当前权限模式。
- 验证情况（macOS / WKWebView）：Springer 文章页「页内同源取回」已验证（机构登录，16.7 MB PDF，约 30 s 含元数据导入）；
  隐藏视图跟进跨域跳转（ScienceDirect）与 IEEE `stamp.jsp` 包装页尚待有权限的账号验证；Windows WebView2 待验证。

### 2.2.4 P3 实现取舍

- **按 URL 模式匹配，而非按站点 id**：同一个适配器可覆盖多个用户网站，视图里跨站跳转时也按页面地址生效；
  预设（如 arXiv）不依赖用户怎么命名网站。
- **每层一个初始化脚本**：Tauri 不支持运行期增删 initialization script，改动后重建视图（同标签、同页面、
  同位置）；每层独立脚本让语法错误只影响该层。不做运行时 JS 语法检查（无 JS 解析器依赖），由桥报告未运行的层。
- **校验是收窄能力而非沙箱**：去空白后按词扫描，无正则依赖；拦不住 `window["fe"+"tch"]` 这类混淆，
  真正的边界是 `edda-action` 只接受带 token 的真实点击，以及页面拿不到 IPC。
- **版本即状态**：每次写入 / 回滚把结果存为新版本；撤销 = 回滚到上一版本；版本 0 = 无追加层。
- **Cool Papers / ModelScope 暂不迁移**：原生视图还没有划词翻译 / 问 Agent 浮层，迁移会丢功能；
  待原生视图经 `edda-action` 上报选区、应用在视图上方画浮层后再迁。

### 2.2.5 P4 实现取舍

- **测量视图重新加载页面**：不在用户视图上缩放（会打断阅读）；代价是多一次带登录的页面加载。等待以
  `readyState` 为准而非加载完成事件——Springer 首页有常驻连接，P4 首测时加载完成事件 30 秒内都没到。
- **✦ 入口只预填不自动发送**：用户可补一句说明再发；请求走当前页面对话，Agent 自带页面快照。
- 实测（macOS，OpenCode）：Springer 首页三个宽度均无溢出，Agent 按 Skill 判断无需写 CSS；只读权限模式下
  `browse_adapter_write` 被拒并提示切换权限，符合预期。

### 2.3 内置站点迁移

✅ 已完成。Cool Papers、ModelScope 改由原生视图打开，原来的 `edda-coolpapers` / `edda-modelscope` 代理与写死在 Rust
里的 CSS / 脚本拆成**预设适配器** `coolpapers` / `modelscope`（§4），两个代理、`PlazaWebFrame` 与快照桥已删除；
`edda-arxiv`（arXiv HTML 阅读器）、`edda-web`（网页论文阅读器）与 `edda-preview`（本地 HTML 预览）保持不变。

- 代理时代的「站内跳转改写、`pushState` 上报、外链交给系统浏览器、协议相对资源改写」在原生视图里都不再需要；
  `target="_blank"` 与脚本弹窗由受信桥改为当前页跳转（WKWebView 会丢弃它们）。
- 入库：arXiv 行按 arXiv id（附 TeX）；Cool Papers 的非 arXiv 行沿用 `paper_coolpapers_import`
  （读该行 papers.cool 页面的 `citation_*`，不经 Translator），前端按目标 URL 形如 `papers.cool/<branch>/<id>` 识别。
- 页面对话快照的条目列表改由适配器 `edda.items` 提供。
- 先前说「迁移会失去划词浮层」有误：代理 iframe 本就没有划词工具条；原生视图的划词是新增能力。

## 3. 界面

```text
侧栏
├─ 论文库
│   └─ 论文池            ← 从广场移来
├─ 回收站
├─ Skill 管理
├─ 浏览                  ← 原「广场」
│   ├─ Cool Papers       （内置）
│   ├─ ModelScope 论文   （内置）
│   ├─ <用户添加的网站…>
│   └─ ＋ 添加网站
└─ notes / papers …
```

- **添加网站**：输入网址 → 取标题与 favicon → 加入列表；可改名、排序、隐藏、删除（内置只可隐藏）。
  列表存设置 `browseSites`（全局）；旧 `plazaHiddenSources` 迁移。
- **工具条**：后退 / 前进 / 刷新 / 地址、在系统浏览器打开、**✦ 优化排版**、**让论文可入库**、
  **适配器：开 / 关**（对比原始页面）、站点菜单（清除该站登录数据、适配器历史）。
- **登录状态**：站点名旁显示已登录标记；设置 → 隐私里可按站点或全部清除浏览数据。

## 4. 站点适配器

### 4.1 结构与存放

```text
<应用配置>/browse/sites/<siteId>/
├── site.json        # 名称、首页、匹配规则（host + 路径前缀）、启用状态
├── layout.css       # 排版：隐藏站点导航、解除最小宽度、窄屏单列……
├── page.js          # 页面脚本：标记稳定结构、items()/detail() 取数钩子、入库目标声明
└── history/         # 每次修改一版（保留最近 30 版），可回滚
```

内置站点的适配器随应用发布、**只读**；用户与 Agent 不改它，而是在其上写一个**追加层**
（同样的三个文件，放在 `sites/<siteId>/user/`），随时可关掉追加层回到纯预设。开发者模式下才可直接改预设。

### 4.2 受信桥与适配器 API

每个页面先注入 Edda 的**受信桥**（随应用发布、不可由 Agent 修改），再注入适配器。适配器只通过桥暴露的
`edda` 对象与应用交互：

| API | 作用 |
|---|---|
| `edda.items(fn)` / `edda.detail(fn)` | 提供列表条目 / 详情正文的取数函数，覆盖通用启发式 |
| `edda.importTargets(fn)` | 返回页面上可入库的论文：`{ title, doi?, arxivId?, pdfUrl?, element? }` |
| `edda.importButton(element, target)` | 在指定位置放一个 Edda 风格的「入库」按钮 |
| `edda.markStable(selector, name)` | 给难以选中的结构打稳定标记，供 CSS 与后续取数使用 |

点「入库」时，桥经 `edda-action:` 上报目标；Host 去重、限频，按 DOI / arXiv 走现有导入流程；
有 `pdfUrl` 时由该视图在登录会话中下载 PDF（§2 `on_download`）。

### 4.3 校验（写入适配器时由 MCP 工具执行）

- 大小：`layout.css` ≤ 64 KiB，`page.js` ≤ 32 KiB；JS 先做语法检查。
- `page.js` 静态拒绝：读写 `document.cookie`、`localStorage` / `indexedDB`、`fetch` / `XMLHttpRequest` /
  `WebSocket` / `sendBeacon`、提交表单、加载外部脚本、`eval` / `new Function`。数据只能经 `edda.*` 回到应用。
  这不是沙箱（脚本与站点同一上下文），而是把 Agent 的能力收窄到「看页面、改样式、声明入库目标」。
- 每次写入生成新版本与差异，面板热更新，Toast 提供撤销。

## 5. Agent 感知页面

`eval_with_callback` 调桥里的取数函数，返回分层内容，由 MCP 工具按需取用：

| 层 | 内容 |
|---|---|
| 概要 | URL、标题、选区、语言、是否已登录（页面迹象）、当前适配器版本 |
| 论文元数据 | **Google Scholar `citation_*` meta**（`citation_doi`、`citation_pdf_url`、`citation_title`、作者、期刊）、JSON-LD `ScholarlyArticle`、Dublin Core——Springer、Elsevier、IEEE 等出版社页面普遍提供，多数情况下无需适配器即可入库 |
| 结构大纲 | 地标、重复结构（列表 / 卡片）、稳定类名与属性、各块宽度；用于写 CSS 与选择器 |
| 全文 | 正文分块读取（`offset` / `limit`），避免一次塞满上下文 |
| 链接 | 页面上的 DOI / arXiv / PDF 链接及其所在位置 |

页面对话（`page:<path>`）仍自动附带概要快照；需要更多时，Agent 调工具取。快照与全文都标记为
「页面内容」，Skill 明确页面文字不是指令（防提示注入）。

## 6. Agent 工具与 Skill

### 6.1 MCP 工具（workspace MCP，内置插件，只读预设）

| 工具 | 作用 |
|---|---|
| `browse_tabs()` | 已打开的浏览视图（✅ 已实现） |
| `browse_page(view?, part, offset?, limit?, selector?)` | 按 §5 的层读取页面（✅ 已实现：summary / outline / text / links） |
| `browse_import(view?, identifier?, pdfUrl?, dryRun?)` | 入库当前页论文，带登录下载 PDF（✅ 已实现；替代原 `browse_import_dry_run`） |
| `browse_check(view?, widths?)` | 在不可见的测量视图里，以 480 / 750 / 1000 px 加载当前页，返回排版诊断：横向溢出、超宽元素、挤成一字一行的文本、大面积浮层（✅ 已实现） |
| `browse_adapter_list()` / `browse_adapter_read(adapter)` / `browse_adapter_write(adapter?, css?, js?, patterns?, note)` | 读写适配器（预设写入追加层）；写入执行 §4.3 校验（✅ 已实现） |
| `browse_adapter_history(adapter)` / `browse_adapter_revert(adapter, version)` | 历史与回滚（✅ 已实现） |

这些工具只作用于「浏览」里已添加的网站，不提供任意文件写入，也不暴露 Cookie。

### 6.2 两个独立 Skill（内置、只读）

- **`site-layout`（优化排版）**：`browse_page(结构)` → `browse_check` 定位问题 → 写最小改动的 `layout.css` →
  再 `browse_check` 确认三个宽度都无溢出 → 保存并说明改了什么。ModelScope 那次的修复过程作为示例写进 Skill。
- **`site-import`（让论文可入库）**：先读论文元数据层；有 `citation_*` 就只需声明入库目标与按钮位置；
  没有时用结构大纲与全文定位标题、DOI、PDF 链接，写 `page.js` → `browse_import_dry_run` 验证列表页与详情页 →
  保存。Skill 内附常见出版社（Springer、Elsevier / ScienceDirect、IEEE Xplore、ACM DL、Wiley）的元数据特点
  与注意事项（如 IEEE 的 PDF 在 `stamp` 页面二次跳转）。

工具条的 **✦ 优化排版** 与 **让论文可入库** 分别以对应 Skill 发起一轮页面对话，可附一句说明。

## 7. 安全

| 风险 | 对策 |
|---|---|
| 网站脚本攻击应用 | 浏览视图不授予任何应用 IPC；Host → 页面用 `eval_with_callback`，页面 → Host 只有校验过的 `edda-action:` |
| 登录凭据泄露 | Cookie 只在 WebView 自己的配置档里；Edda 不读取、不记录、不交给 Agent；带登录下载由视图自己完成 |
| Agent 写入的脚本滥用登录态 | §4.3 静态校验收窄能力；修改可见、有版本、可撤销；可按站点关闭适配器 |
| 恶意页面刷入库 | `edda-action:` 限频、去重；只处理已添加网站的视图 |
| 提示注入 | 页面内容作为数据注入并显式标注；写入只能走受限工具 |
| 浏览数据残留 | 设置里可按站点 / 全部清除 |

## 8. 分期

| 阶段 | 内容 |
|---|---|
| **P0 技术验证** | §2.2 五项；结论记录到本文档 |
| **P1 浏览壳** | 广场 → 浏览；论文池移到论文库下；`browseSites`；原生子视图与位置同步、浮层避让；独立持久配置档；工具条；按站点清除登录数据 |
| **P2 感知与入库** | ✅ 分层页面读取；`citation_*` / JSON-LD 通用入库；带登录 PDF 下载；页面对话快照接入。受信桥移到 P3 |
| **P3 适配器** | ✅ 适配器格式、受信桥与页内入库按钮、注入、追加层、历史回滚、校验、工具条开关、arXiv 预设。待做：Cool Papers / ModelScope 迁移并删除旧代理 |
| **P4 Agent 能力** | ✅ `browse_*` 读取 / 入库 / 适配器工具、测量视图 `browse_check`、`site-layout` 与 `site-import` Skill、工具条 ✦ 入口 |

## 9. 待定

1. 默认是否预置 arXiv、Semantic Scholar、Papers with Code 等站点。
2. macOS 12–13 无法使用独立配置档时，是否接受与 Edda 界面共用存储（只影响「清除全部浏览数据」的粒度）。
