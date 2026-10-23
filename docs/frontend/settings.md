# 设置与主题

## 设置窗口

- 独立原生单例：`settings_window_open` + `?window=settings` → `SettingsNativeRoot`。
- macOS Overlay 标题栏 + 交通灯；Windows/Linux 系统原生边框。标题栏与侧栏共用 `--sidebar` 材质（macOS 标题栏 `backdrop-blur`；`prefers-reduced-transparency` 下实色）。
- 开/关：`⌘,`、菜单、齿轮；`Esc` / 标题栏 X 关闭。
- 窗口标题随界面语言（`settings:title`）；macOS 应用菜单里的系统项（关于、服务、隐藏、退出、编辑、窗口）也随语言切换。
- 除远程访问的「电脑名称」默认值外，不查询或展示本机 hostname / OS 身份。
- 保存：`settings_set` → 广播 `settings:changed` 跨窗口同步。
- 主题应用：相同 CSS 不重复重写全局样式；懒加载主题期间以最后一次选择为准（含切回默认），避免旧异步结果覆盖新选择。
- 落盘：XDG `$XDG_CONFIG_HOME/edda/settings.json`。
- 加载策略：设置 webview 不加载完整 `App`，也不加载 PDF 引擎与 KaTeX（二者随 `App` 动态 import）。各分区 pane 分 chunk；**当前分区**的 pane 与外壳并行预热（`preloadSettingsPane`），其余分区在窗口打开后依次后台预热；chunk 已就绪的 pane 直接渲染（`settingsPane`），不再经 `lazy()` 首次挂载时闪一帧空白。已访问的 pane 保持挂载。
- 「网络与集成」页的「网络代理」是 Host 级配置，启用后用于 Host 创建的 HTTP(S)/SOCKS 请求，并同步注入本地与远端 Agent 进程的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。旧版 Settings → Agent 的代理配置会在首次启动时迁移。

### UI 约定（System Settings 风格）

共用件在 `src/components/settings/settings-layout.tsx`：

| 元件 | 约定 |
|---|---|
| `PageTitle` | `text-lg` + `font-semibold`（字距/行高走字号阶梯 token），与分组标签形成清晰层级 |
| `SettingsSectionLabel` | `text-xs` + `font-medium` + muted，保留文案本身的大小写（避免 `text-caption` 被 twMerge 与 `text-muted-*` 互斥吃掉） |
| `SettingsGroup` / `settingsCardClassName` | 圆角 inset 卡片：`rounded-xl`、淡边框、极轻阴影 |
| `SettingsRow` / `settingsRowClassName` | Body 行：`text-sm` 常规字重、`min-h-10`、柔和行间分隔 |
| `HelpLabel` | 可键盘聚焦的 `?` 按钮（Tooltip），按压有微缩反馈 |
| `StatusDot` / `TooltipDot` / `Dot`（`status-dot.tsx`） | 状态点统一色调：`ok` / `idle` / `off`（未配置）/ `warn`（探测中、同步中，可脉冲）/ `err`；`probeTone` 把 key 探测状态映射成色调 |
| `ProviderCard` / `ProviderField`（`provider-card.tsx`） | 翻译 / 版面解析服务商卡片：未使用时折叠为一行；卡内「标签 + 输入」行 |
| `useLocalServer` / `ServerPortRow`（`panes/local-server.tsx`） | Zotero Connector 与 MCP 共用的开关、端口校验、状态事件与「监听中」端口行 |

侧栏（`SettingsContent`）：

- 材质：`bg-sidebar` / `border-sidebar-border`；选中项为 `sidebar-accent` 滑动高亮、细内边缘和 semibold 文本；按压颜色反馈，方向键在导航项间移动。
- 各 pane 由 `NAV` 列表统一挂载（`renderPane`），新增分区只需加导航项和一个 case。
- 内容区：`overscroll-y-contain`；切换分区平滑滚回顶部（尊重 `prefers-reduced-motion`）；pane 进入短时 opacity 交叉淡入。
- 选中条观察导航列表、当前项尺寸及根节点 style/class，字体缩放 / 图标导航重排无需窗口 resize 也能保持对齐；后台 Webview 不必等待绘制通知才更新目标几何。相同几何不重复更新状态，卸载时断开 observers。
- 主题预览卡：选中 inset ring + 按压缩放；slider 带 `aria-valuetext`。
- 内容区为 `settings-content` 命名容器：窄内容区的字段与控件纵向排列，主题预览按自身宽度分 1 / 2 / 3 列。
  小窗口缩短侧栏；低于 `28rem` 时使用图标导航，保留所有入口、完整 aria-label 和 title 提示，原键盘导航照常工作。

## 主要分类

| 分类 | 内容示例 |
|---|---|
| 通用 | 文件树标签/排序、**浏览开关**（`plazaEnabled`，默认开；关闭后侧栏隐藏「浏览」且不挂载其面板）；**笔记**：初始化方式、打开行为（`autoOpenPaperNotes` 默认关，打开论文只开 PDF/HTML，NOTES 按需展开；已有显式偏好保留）、外部改名后更新双链、导出默认水印；**打开与导入**：`replaceCurrentTabOnOpenPaper`（默认关，开启后打开新论文会先关闭当前标签页）、批量导入并发、EasyScholar Key（输入后点确定保存并探测，色点显示可用/不可用/未配置；留空则禁用。配置后可在 Library 表头 Tags 列一键为当前范围内全部论文获取 `#easyscholar:` 命名空间的分区/影响因子标签）；**数据**：清除本机使用记录（`usage.sqlite` 始终开启）、清除浏览数据（「浏览」中全部网站的登录与存储，见 [browse.md](browse.md)）、清除远程 Vault PDF 预览缓存、打开 / 清理日志（见 [backend/logging.md](../backend/logging.md)） |
| 网络与集成 | **网络**：网络代理、**GitHub 镜像**（Skill 导入直连失败时的 URL 前缀回退，说明在 `?` 提示里，见 [backend/skill-import.md](../backend/skill-import.md)）；**Zotero**：兼容 Connector 开关（「需先退出本地 Zotero」收在 `?` 提示里），端口开启后才显示；**Agent 插件（MCP）**：给所有本地 Agent 会话的 MCP 服务器列表，可粘贴服务器 URL 或 README 里的 `mcpServers` JSON（`parseMcpServers`，同名替换），逐条启停 / 移除，新对话生效；**Edda MCP 服务**（对外）：server 开关（loopback Streamable HTTP，默认关），端口 / 复制地址开启后才显示；ChatGPT Secure MCP Tunnel 的 Runtime API key / Tunnel ID 与起停收在「高级」折叠里（接 ChatGPT 见 [用 MCP 连接外部 Agent](../usage/mcp.md)） |
| Appearance | 明暗模式、`uiTheme`（默认显示 6 个精选主题，当前所选始终可见，「全部 N 个主题」展开完整网格，不再嵌套滚动）、`uiScale`；界面/正文/等宽字体；Markdown 字号 / 行距 / 工具栏 |
| Agent | Agent CLI / ACP 检测、安装/升级/卸载及进度取消（已安装的 Agent 在前，其余收进「更多 Agent（N）」；一个都没装时全部展开）、默认 Agent、权限模式、自动精读、可选 User-Agent、个人提示词与知识库 AGENTS.md 编辑。划词问答使用完整 Agent 当前会话 |
| 翻译 | 默认服务选择（含**内置 provider** `builtin`：无凭证卡片、无探测色点，可用性来自 Host `builtin_provider_status`；构建未注入 key 时禁用，当前已选中则仍留在列表里）、语言、Agent 座（选 Agent 翻译时紧跟在服务选择下方）、商用 API 配置（`ProviderCard`：只展开当前所选服务商，其余折叠成一行，点开才编辑） |
| 同步 | S3 兼容云同步配置、顶部常见服务商 logo 打开官方配置指南、自动同步、同步范围逐类开关；标题旁色点显示未连接 / 已连接 / 同步中 / 错误，标题右侧放置连接 / 保存 / 立即同步主操作，底部仅保留解绑 |
| 知识库诊断 | 网络连通性（按需运行）/ Vault / Catalog / 双链 / 论文 aliases / 视觉批注格式；没问题的项合并成一行勾选摘要，有问题才展开成分区；本地 Vault 可确认批量修复 |
| 关于 | 版本信息与应用更新、访达集成；标题右侧显示并打开 `Becomingw/Edda`，应用名称仍为 Edda，使用吉祥物应用图标。业务 CLI 安装/卸载及自动同步已移除；外部 Agent 在「网络与集成」中接入 MCP |

知识库诊断页调用 Host 的只读 Doctor 报告。检查项各自作为小标题（检测说明收在标题旁 `?` 提示里），标题行右侧显示 icon + 问题数，尚未检测的分区不显示状态；检测调用本身失败走 `notifyError` Toast，不在页面里挂错误条；模块间用非通栏次要分隔线。列表过长时（双链 / 别名 / 视觉批注）`max-h` 内滚动。视觉批注一节只在库里还有旧版 `agent-trace` mark 时出现，可一键升级为 `visual` v2。Agent 的 ACP 连通性由 Agent 页各行的探测状态展示，诊断页不再重复。

- **Agent 安装依赖指引**（原诊断页的「主机运行环境」并入此处）：首次引导的 Agent 步骤与设置 → Agent 共用 `AgentRuntimeGuide`，复用
  `doctor_check_host` 分别展示 Node.js / npm 的可用、缺失或无法运行状态。都可用时缩成一行状态（版本 + 重新检测）。缺失时展开警示与
  Node.js 官方 LTS 下载入口，说明 npm / PATH 选项、安装后完整重启及重新检测；检测失败走
  Toast 并显示「尚未确认」，不误判成缺失。已有可用 Agent 的选择和引导下一步不受阻断。
  重新检测同步刷新 Agent 列表；引导内容区可滚动，低高度窗口仍保留底部导航。
  未设置默认 Agent 时，空注册 ID 不匹配默认项，未安装条目仍显示安装按钮。
- **网络连通性**（`doctor_check_network`）：按当前全局代理设置并行探测 Baidu / Google / Google Scholar / GitHub / arXiv / Semantic Scholar；一行一个端点，左侧状态点，右侧显示耗时或失败原因；失败时在行内展示原始错误与修复提示。不依赖 Vault，未打开 Vault 时也显示。打开诊断页时**不自动探测**，点分区标题右侧的运行按钮才开始；页头刷新只重跑已运行过的慢检查。

- **论文别名**：勾选与编辑标题/短 alias，标题行「修复」→ 确认后批量写入 frontmatter（不改 path）。单行「忽略」或「忽略所选」把路径写入 Vault `.edda/doctor.json`，下次诊断不再报错；列表底部可恢复。
- **双链语义**：
  1. 「探测」→ 自动建议（默认勾选）+ 可手改候选项（默认不勾选）；
  2. 每条 git 风格整行 diff：核心变更居中高亮，按设置窗宽度窗口化前后文；
  3. 标题行「全选 / 修复」应用选中项；
  4. 下方 Agent 提示词（随 UI 语言 en/zh）：复制，或「在 Agent 中打开」（关设置、打开主窗 Agent 并预填 composer）。

  手动候选须先填入不同且非空的替换，才可勾选；「全选」只选择实际有修改的行，确认数量也以此为准。
  预览中可通过刷新图标重新探测；零写入不会显示成功。PDF 的 page / section / figure / table 等阅读定位
  参数不作为 Markdown 标题检查，见 [Wiki 语义边界](../backend/wiki.md)。

主窗口把未保存的 Markdown 路径同步到 Host，因此独立设置 Webview 发起修复时仍能在任何写入前拒绝脏文件。远程 Vault 首版只显示不可用。

相关代码：`src/lib/doctor/`、`src/lib/agent/composer-seed.ts`。诊断页外壳 `src/components/settings/panes/doctor-pane.tsx` 只做报告拉取与分区编排（无问题的项归入 `DoctorPassedSummary`），各检查项在同目录拆分：`doctor-network-section.tsx`、`doctor-vault-catalog-sections.tsx`、`doctor-wikilink-section.tsx`、`doctor-alias-section.tsx`、`doctor-visual-marks-section.tsx`；共用展示件（小标题、问题行、git 风格 diff）在 `doctor-sections.tsx`，整行 diff 的文本测量与窗口化在 `doctor-line-fit.ts`（单测 `test/doctor-line-fit.test.ts`）。

## 论文池地址

广场论文池的存储地址在论文池页面的齿轮对话框中配置，对应全局 `paperPoolLocation`（目录或静态 JSON URL）。原 arXiv Daily 的 Embedding 设置已随推荐代码一并移除，旧设置文件中的 `embedding` 字段读取时忽略。

## 知识库指令

设置 → Agent 的 **知识库指令 · AGENTS.md** 作用于当前 Vault，与全局个人提示词分开。打开编辑器只读取；「使用默认指令」只替换草稿。保存先进入完整内容预览，再点「确认保存」才写盘；返回编辑、取消和关闭不写盘，切库会丢弃旧库编辑状态。

本地使用 Host revision 比较、跨进程配置锁及原子文件写入；外部已修改则拒绝覆盖并提示重新打开合并。远程通过已有 SFTP 读写接口，保存前读回比较内容（不是原子 CAS）。已有 Agent 会话可能缓存指令，修改后新建对话使用。

`AGENTS.md` 默认模板 v3 使用任务优先、按需读取与默认只读约定，并要求论文平级存储、使用标签分类；初始化仅升级 hash 匹配的受管默认文件，保留旧版未知来源文件和用户改动。需要切换默认时在设置中恢复并确认。Skill 管理独立于通用页的广场开关。

## 应用更新

- 正式桌面构建的主窗口会在启动后异步检查一次稳定版更新，不阻塞首屏或 Vault 初始化；检查失败只记日志。
- 设置 → 关于可手动检查。发现新版后显示版本和 Release notes，用户点击「安装并重启」后才下载、验证、安装并重启；不会静默替换应用。
- 发现新版后标题栏右上角常驻「新版本」标签按钮（绿色胶囊 tag，`src/components/shell/update-indicator.tsx`），点击直接下载安装并重启；下载/安装中显示 spinner 与进度文案，安装完成前不消失。
- 安装前会重新拉取一次远端 manifest（`refreshStaleUpdate`）：应用长期驻留导致缓存的 Update 落后于最新 Release 时，直接改装最新版；re-check 失败（离线等）则回退安装缓存清单，不会因此中断（#481）。
- 更新包由 Tauri Updater 使用内置公钥验证签名，并根据当前系统/架构从 GitHub Release 的 `latest.json` 选择产物。
- 更新检查与下载复用「网络与集成」页的「网络代理」设置（`src/lib/update/service.ts` 在每次检查时读取，下载沿用检查时的代理）：Updater 插件自带 HTTP 客户端，不走 Host `core::http::client_builder`，因此必须显式传入。该客户端只支持 HTTP(S) 代理，SOCKS 代理需另配 HTTP 端口。
- 浏览器预览、`pnpm tauri dev`、移动端不检查更新；关于页此时不显示「检查更新」按钮。
- 只有 GitHub **已发布**的稳定版 Release 可作为更新源；Draft 和 prerelease 不会推送给普通稳定版用户。

## 主题

- `uiTheme` 默认 `default`（内置外观）：暖纸色画布与低饱和石墨色深色界面，侧栏、内容和浮层逐级区分；铜色 `--brand` / `--ring` 用于强调与焦点，`--highlight` 保留高亮语义。颜色定义见 `src/index.css` `:root` / `.dark`，默认预览卡同步该配色。
- 通用控件与阴影层次适配自选主题（含 modern-minimal），不改写用户保存的 `uiTheme`、字体或明暗偏好；表面规范见 [components.md](components.md#工作台视觉与反馈)。
- 外观设置中的配色主题以紧凑预览网格展示背景、卡片、主色和强调色；点击预览项即可应用主题。
- 36 个 tweakcn 预设：`src/themes/tweakcn.json`；`src/lib/ui/theme.ts` 注入 CSS 变量。
- 刷新主题数据：`node scripts/fetch-tweakcn-themes.mjs`。
- 可访问性：`prefers-reduced-transparency` 下标题栏 / Library 表头退回实色；`prefers-contrast: more` 加深边框。
- `uiScale`：80%–150% 滑块（1% 步进），改 `html` font-size（基数仍为 **16×scale**，与编辑器字号/行距正交；不把根字号改成 13，以免 rem 间距在 Windows 125% 等缩放下整体被压扁），并写入 CSS 变量 `--ui-scale`。编辑器正文的 px 字号用 `calc(<字号>px * var(--ui-scale))` 跟随缩放，缩放时编辑器不重新渲染，长文档只做一次重排。
- 字号阶梯（Apple UI 光学字阶，见 `src/index.css` `@theme`；`body` 默认 `text-sm`，PaneHeader / 侧栏 / 底栏 / 顶栏 / Dock / 库表 / Agent chrome 共用）。每档是 **字号 + 行高 + 字距** 一组，不是只改 size：
  - `text-caption` → **11px**（Caption；行高 1.35，字距 +0.012em；chip / 密集元数据；禁止再写 9/10px）
  - `text-xs` → **12px**（Callout；行高 1.35，字距 +0.006em；次要控件、快捷键）
  - `text-sm` → **13px**（Body；行高 ≈1.385，字距 0；主 chrome）
  - `text-base` → **15px**（Title 3；行高 1.25，字距 −0.012em；设置/对话框标题）
  - `text-lg` → **17px**（Title 2；行高 1.2，字距 −0.018em；欢迎页等大标题）
- 字重：正文 `font-normal`（400）；强调用 `font-medium`（510）/ `font-semibold`（590）；chrome 少用 `font-bold`。可变字体（SF Pro / Geist）吃得到中间档，Segoe 等会落到最近可用字重。
- 圆角基值 `--radius`：**0.5rem（8px）**；PaneHeader / Dock 页签栏高度：**2.25rem（h-9）**。
- 字体（Appearance → Fonts，对齐 Obsidian 三分法）：
  - `interfaceFontFamily`：界面 chrome（`--font-sans` / `--font-heading`）。
  - `textFontFamily`：Markdown/笔记正文（仅编辑器根节点）。
  - `monoFontFamily`：代码块与 `font-mono`（`--font-mono`）。
  - 取值：空 = **系统 UI**（macOS SF Pro / Windows Segoe UI + 雅黑等 CJK 回退）；`system` 同义；`geist` = 打包 Geist Variable；`serif` / `mono` = 内置栈；其余 = 系统字体族名。
  - 等宽默认含 Cascadia Mono / Consolas，照顾 Windows。
  - 选择器：Popover + 搜索；Host `list_system_fonts`（fontdb）枚举本机字体。
- Markdown 编辑器（Appearance → Markdown editor）：
  - `editorFontSize`：12–20 px（默认 14，阅读区可略大于 chrome）。
  - `editorLineHeight`：1.4–2.0（步长 0.1，默认 1.6）。
- `batchImportConcurrency`：魔棒批量导入及后续资源下载的并发上限，范围 1–10，默认 5。
- `paperNoteMode`：新导入论文 NOTES.md 壳的初始化方式，四档：
  - `standard`（默认）：aliases + `# 标题` + 摘要引用块（zh-CN 机翻，失败省略）。
  - `title-only`：aliases + `# 标题`，不写摘要。
  - `blank`：仅 aliases frontmatter。
  - `custom`：渲染 vault 内 `.edda/templates/NOTES.md`（变量 `{{title}} {{authors}} {{year}} {{date}} {{abstract}} {{arxiv_id}} {{doi}} {{url}} {{id}}`，`{{abstract}}` 为原文不翻译，未知变量原样保留；模板缺失回退 standard）。选中该项时显示模板路径与「生成起始模板」按钮（`notes_template_seed`，仅当模板不存在时写入）。
  - 所有模式产物都保证含 aliases frontmatter；只影响新导入，不改存量笔记。

## i18n

- 用户文案一律 `t()` / `react-i18next`；en 源语言，同步 `zh-CN`。
- 词条：`src/i18n/locales/`。
- Appearance → Language：`applyLocale` 在设置窗本地立即切语种（设置 webview 不挂 `useAppBootstrap`）；`settings:changed` 广播时各窗口 `subscribeSettings` 也会再应用一次，主窗另经 bootstrap 同步原生菜单。

## 代码

- UI：`src/components/settings/`
- 状态：`src/lib/settings/`
- 更新服务：`src/lib/update/`
