# 组件约定

## 应用图标

- Margin 使用明亮蓝色圆角底、白色哑光小脸、蓝 / 绿眼睛与黄 / 红腮红：从右下方探入，延续 Edda 的造型语言；配色受 Google / Material 产品启发，但不是官方标识。
- Margin 唯一源文件为 `src/assets/margin-app-icon.svg`：标题栏、浏览器图标、导出水印、原生资产与 README 文档副本均使用它。图标内的固定配色属于品牌插画，不改变 UI 的语义色 token。
- `src/assets/edda-app-icon.svg` / `edda-logo.svg` 保留给尚未裁剪的上游组件，不再作为 Margin 的应用图标。
- `uv run --with pillow scripts/generate-app-icons.py` 调用 Tauri 图标生成器，更新
  `src-tauri/icons/` 的 ICNS / ICO / PNG、已跟踪的 iOS / Android 图标副本、NSIS 侧图及文档站 SVG。
  macOS 保留约 10% 光学留白；原生资产和源 SVG 必须一起提交。Windows 用 `pnpm.cmd` 调用，生成脚本自动识别。
- 原生默认图标优先使用 `icons/icon.png`；启动时同时设置窗口小图标与任务栏 / Alt-Tab 大图标。Tauri 的 `set_icon` 本身只更新 Windows 小图标，不能据此判断任务栏已经更新。`build.rs` 显式跟踪 PNG / ICO 变化；原生二进制名为 `margin.exe`，不再复用 `edda.exe` 的路径缓存。

## Margin Windows 窗口

- 独立主窗保留原生 `decorations` 与系统 caption 样式，Rust Host 将客户区延伸到标题区，合并系统标题栏与应用顶栏；不在外部再套一条标准程序标题栏。
- 右侧标题按钮区域从 WebView 中裁出，交给原生窗口处理。拖动、双击最大化、系统菜单、窗口缩放和关闭请求沿用系统 / Tauri 路径，不放 React 自绘标题栏按钮，也不改变 Settings 等继承子窗口。
- Windows 11 使用 DWM 标题按钮；不支持标题颜色属性的 Windows 10 使用 Host 原生绘制兼容层，仍保留系统 caption 样式、命中区和系统命令，而不是把白色按钮留在浅色玻璃面上。两者共用主题 token 的前景 / 背景色。
- Windows 10 兼容层必须关闭旧的玻璃扩展，并以独立的不获取焦点的原生绘制表面覆盖 WebView2 合成层；仅改命中区或只在父窗 GDI 绘字会出现低对比度 / 透明字形。这个表面不接管按钮输入，事件继续交给原生 caption。
- 前端只给非交互的顶栏区域标记拖动，预留原生按钮空间；背景与文字颜色从现有主题 token 解析后传给 Host，避免为窗口另造一套 UI 颜色。
- 原生回归：`powershell -File scripts/margin-window-smoke.ps1` 验证标题区、原生按钮命中、字形对比度、主窗与标题区背景一致、最大化 / 恢复、WebView 裁剪及 HWND / EXE 图标。`pnpm test:margin-native` 在深浅主题下调用它，并在故意延迟保存时验证原生关闭会被草稿保护阻止。当前实机环境验证 Windows 10；Windows 11 和跨屏 DPI 移动仍需发行前实机回归。

## 工作台视觉与反馈

- `index.css` 管理语义配色、字体与尺寸阶梯；`styles/workbench.css` 管理公共表面、边缘与阴影。
  默认主题为暖纸色 / 石墨色，铜色用于焦点和轻量强调；自选主题继续通过语义变量提供颜色与圆角。
- 细线（`--hairline-soft` / `--border` / `--input`）、圆角阶梯与两级阴影（`shadow-floating`、`shadow-dialog`）
  的用法见 [设计规范](../design.md)；文档流中的卡片、按钮、输入框不加阴影。深色阴影使用黑色而非 foreground 混色。
  `workbench-card` / `workbench-toolbar` 放在 components layer，业务 hover / active utilities 可正常覆盖。
- Button 的按压以即时颜色变化反馈，通用按钮不做位移或缩放；业务手势仍由原有组件负责。
  Input / Textarea / Select 共用边界和焦点环，disabled / invalid 状态由现有 props 保持。
- Dialog / Popover / 菜单采用轻量 opacity + 98% scale，菜单位移为 1 个 spacing 单位；
  Radix 继续负责定位、键盘、焦点返回与关闭。浮层宽度受视口限制，菜单 / 子菜单按可用高度滚动，
  Popover 的纵向滚动由各业务内容决定。默认 Tooltip 悬停延迟 250ms，减少扫过工具栏时的干扰。
- Dockview 菜单使用同一浮层阴影；活动标签和分隔条反馈更清晰，键盘聚焦标签时关闭按钮可见。
  保持标题栏 `h-8`、PaneHeader / Dock 标签栏 `h-9`，不通过视觉改动重写 native window、拖拽或布局计算。
- 尊重现有 reduced-motion 规则；reduced-transparency / more-contrast 使用实色表面与更强边界，
  forced-colors 下保留系统 Highlight 焦点轮廓。

## AI Elements

Chat / Agent / 文件树 AI UI **统一使用** [AI Elements](https://elements.ai-sdk.dev/)。

- 落盘：`src/components/ai-elements/`
- 安装：`pnpm dlx shadcn@latest add https://elements.ai-sdk.dev/api/registry/<name>.json -y -o`
- 主题跟 shadcn token；**不是** Vercel AI SDK `useChat`（传输层为 ACP）。
- **禁止**新建 `src/components/ai/*` 或用 `ui/message` 搭 Chat。

常用：`conversation`、`message`、`prompt-input`、`sources`、`reasoning`、`file-tree`、queue 等。

Agent / Reasoning 消息里的 Markdown：`Streamdown` + `PlainTable` / `PlainCodeBlock`（代码块左上角语言标签，悬停复制/下载；无外侧卡片，见 [agent.md](agent.md)#消息-markdown-渲染）。

## 业务组件目录

| 目录 | 职责 |
|---|---|
| `components/shell/` | 三栏壳、标题栏、对话框挂载 |
| `components/sidebar/` | 文件树、Paper Info、魔棒 |
| `components/workspace/` | Dockview 宿主与 panel 内容 |
| `components/library/` | 论文库表 |
| `components/editor/` | Plate Markdown |
| `components/viewer/` | PDF / HTML / 图片。对外只经 `viewer/index.ts`；内部 `pdf/`（外壳 + `hooks/` + `layers/` + `chrome/` + `cards/` + `viewport/`）、`panels/`（右栏面板） |
| `components/agent/` | Agent 面板。外壳 + `hooks/`（面板与 composer 状态）+ `composer/`（输入区子件） |
| `components/wiki/` | 反链列表 / 引用近邻图（`graph-panel`） |
| `components/settings/` | 设置页 |
| `components/dialogs/` | 命令面板、权限、迁移等 |
| `components/ui/` | shadcn 基础件；`math-text.tsx` 用 KaTeX 渲染标题内联公式（`$\\pi$`） |

## 状态订阅

组件经 `hooks/use-app-stores.ts` selector 订阅；避免整树重渲染。命令式 dock/布局经 registry，不把 DOM ref 塞进 zustand。
