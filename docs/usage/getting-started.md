# 安装与首次使用

本教程带你完成第一次打开 Edda、创建 Vault，并确认工作区可用。

## 准备工作

### 系统要求

| 平台 | 最低要求 |
|---|---|
| macOS | 12.0+ |
| Windows | 发布页 x64 安装包 |
| Linux | Ubuntu **22.04+**（需 **webkit2gtk 4.1**，包名常见 `libwebkit2gtk-4.1-0`） |

Linux 桌面包在 Ubuntu 22.04 上构建。更旧的发行版（如 Ubuntu 20.04，仅有 webkit2gtk 4.0）请先升级系统。

从 [Becomingw/Edda 发布页](https://github.com/Becomingw/Edda/releases) 下载与系统匹配的桌面版本。本分支已提供 macOS Apple Silicon 和 Windows x64 包；应用名称仍为 Edda。Linux 等其他平台暂按源码构建说明使用。

请检查具体 Release 的签名说明：ad-hoc 签名包未经过 Apple 公证，首次打开可能需要在 macOS「系统设置 → 隐私与安全性」允许打开。外部 Agent 接口见 [MCP 接入](mcp.md)，当前源码已移除业务 CLI。

自 v0.16.1 起提供 Windows x64 安装包；Windows 10 / 11 x64 用户下载 `Edda_<version>_x64-setup.exe`。当前包未做 Authenticode
发布者签名，可能出现 SmartScreen 提示；若缺少 WebView2，安装器可能需要联网安装运行时。

开发者可在仓库根目录运行：

```bash
pnpm install
pnpm tauri dev
```

首次使用**不需要**先安装 Zotero 或 Agent。只有在浏览器导入或 AI 辅助阅读时，才需要继续配置对应软件。

### Windows 源码构建前置条件

macOS 与 Linux 的工具链要求见上文；Windows 需要额外几项，缺任一项会在
`cargo build` 阶段以「program not found」或 glob 匹配失败的形式报错：

| 依赖 | 用途 | 说明 |
|---|---|---|
| Rust stable（`x86_64-pc-windows-msvc`） | 编译 Host | 必须用 **MSVC** 工具链：测试二进制需 `/MANIFESTDEPENDENCY` 嵌入 Common-Controls v6，GNU 工具链目前不受支持 |
| Visual Studio Build Tools 2022 + **使用 C++ 的桌面开发**工作负载 | C/C++ 编译 | `rusqlite` bundled、zstd、bzip2 等依赖需要 C 编译器 |
| CMake ≥ 3.15 | 构建 OCR 原生库 | `tesseract-rs` 会从源码编译 leptonica 与 tesseract，缺失时报 `is cmake not installed?` |
| Node.js 24 + pnpm 11.5.3 | 前端 | pnpm 版本由 `packageManager` 固定 |
| WebView2 Runtime | 运行时 | 多数 Windows 10/11 已预装 |

PDFium 不随仓库提交，`tauri.conf.json` 的 `bundle.resources` 需要 `src-tauri/pdfium/`
存在，因此**首次构建前**先执行一次：

```bash
pnpm pdfium:stage
```

若只是想确认改动能否编译，用 `cargo check --workspace --all-targets` 即可，
不必跑完整的 `pnpm tauri build`（后者开启 fat LTO，耗时较长）。

> **Windows 已知坑**：`tesseract-rs` 会用 CMake 源码构建 leptonica / tesseract，
> 但 `cmake` crate 未向多配置生成器（`Visual Studio 17 2022`）传 `--config`，
> 于是产物是 Debug 版 `leptonica-1.84.1d.lib`，而构建脚本按 Release 名
> `leptonica.lib` 查找，最终报
> `could not find native static library 'leptonica', perhaps an -L flag is missing?`。
> 这是上游依赖的 Windows 构建问题，与本仓库代码无关。若在本地遇到，
> 把 Debug 产物复制成脚本期望的名字即可绕过：
>
> ```powershell
> $lib = "$env:APPDATA\tesseract-rs\leptonica\lib"
> 'leptonica.lib', 'libleptonica.lib', 'leptonica-static.lib', 'leptonica-1.84.1.lib' |
>   ForEach-Object { Copy-Item "$lib\leptonica-1.84.1d.lib" "$lib\$_" }
> $tes = "$env:APPDATA\tesseract-rs\tesseract\lib"
> Copy-Item "$tes\tesseract53d.lib" "$tes\tesseract53.lib"
> ```

### Agent 安装环境

首次引导的 **Agent** 步骤会检测 Node.js 与 npm。部分 Agent 安装方式和 ACP 适配器通过
npm 安装，缺失或无法运行时会显示警示。点击 **下载 Node.js LTS** 前往官网，选择当前系统
的长期支持版，保留 npm 和 PATH 安装选项；安装完成后完全退出并重开 Edda，再重新检测。
同一指引也可在 **设置 → Agent** 查看。已有可用 Agent 可以继续使用，也可先完成引导，
稍后配置；普通论文阅读和笔记功能不需要 Node.js/npm。

### Linux：`libwebkit2gtk-4.1-0` 无法满足

旧版 `.deb` 安装时若缺少 `libwebkit2gtk-4.1-0`（常见于 Ubuntu 20.04），请升级到 **22.04+**。当前 Linux 支持与可下载产物以具体 Release 为准，未提供对应包时需从源码构建。

## 创建第一个 Vault

1. 启动 Edda。
2. 在欢迎页选择 **Create Vault**。
3. 选择一个长期保存研究资料的位置，例如 `~/Documents/ResearchVault`。
4. 等待左侧文件树和中间 Library 加载完成。

Vault 是普通目录。建议不要放在临时目录、下载目录或会被自动清理的同步缓存中。

创建后，目录通常会包含：

```text
ResearchVault/
├── papers/
├── notes/
│   ├── 01 论文导入与管理.md
│   ├── 02 Agent 与 Skill.md
│   └── 03 Markdown 与双链.md
├── .agents/
│   └── skills/
├── AGENTS.md
└── .edda/
    └── catalog.sqlite
```

- `notes/` 下的三篇教程会按当前语言自动生成，首次创建 Vault 后会自动打开第一篇。
- 这些教程只是普通 Markdown，你可以自由编辑或删除；删除后不会自动恢复。
- 不要手动编辑 `.edda/catalog.sqlite`。论文正文和笔记可以直接用外部编辑器修改，但结构化论文元数据应通过 Edda 操作。

## 打开已有 Vault

在欢迎页选择 **Open Vault**，选择包含 `papers/`、`notes/` 或 Markdown 资料的目录。

如果已有目录中的文件没有立即出现在 Library：

1. 打开 Library（左侧虚拟节点，或关光文档后回到全库）。
2. 点击 **Rescan**。
3. 等待扫描完成后重新查看论文列表。

有 Zotero 文库时，欢迎页也可选择 **从 Zotero 迁移**（迁移前会先创建 Vault）。详见 [导入和管理论文](import-papers.md)。

## 认识工作台

| 区域 | 作用 |
|---|---|
| 左侧文件树 | 浏览 Vault；顶部有 Library、回收站；魔棒可入库 |
| 中间工作区 | Dockview 文档面板：Library 表、PDF、Markdown、回收站等 |
| 右侧栏（可选） | Agent / 批注 / References（引用卡片 + 近邻图）/ Figures；编辑器状态栏看双链反链 |
| 左下角 | 后台任务（下载、入库、精读等） |
| 右上角 | 错误 / 警告 Toast |

打开论文时，默认会 **左右分屏**：左侧 PDF（或 HTML），右侧 `NOTES.md`。可用 Layout 菜单或快捷键开关 NOTES。

## 第一次检查

打开 Vault 后，建议依次确认：

1. 左侧文件树能展开 `papers/`。
2. Library 能显示论文或空状态。
3. 能新建一个 Markdown 文件并保存。
4. 若有 PDF，打开后可翻页和 `⌘F` 搜索。
5. `⌘P` 能打开快速打开面板；划词后 `⌘K` / `⌘L` 将原文作为引用加入完整 Agent，输入问题后发送。

## 数据位置和备份

| 路径 | 用途 |
|---|---|
| `papers/<paper>/NOTES.md` | 论文笔记、摘要和整理结果 |
| `papers/<paper>/marks/` | PDF 高亮、批注、提问和翻译结果 |
| `papers/<paper>/*.pdf` | PDF 原文 |
| `papers/<paper>/source/` | arXiv 等来源的 TeX 或其它源文件 |
| `papers/<paper>/attachments/` | 可选支撑材料（补充 PDF、幻灯片、代码仓库）；有文件时文件树论文行才可展开 |
| `.edda/catalog.sqlite` | Library 使用的论文集合和元数据 |
| `~/.local/share/edda/usage.sqlite` | 本机使用记录（不在 Vault 内；设置 → 通用 → 数据可清除） |

建议定期备份整个 Vault。若使用 Git，优先提交 Markdown、JSON、TeX 和其它源文件；`catalog.sqlite` 也应随 Vault 一起备份，以保留 Library 元数据。

## 自动更新失败

设置中点击更新时若弹出 **「无法安装更新，请重试」**（英文 **Couldn't install the update. Try again**），通常是下载安装包时网络不通或代理不稳导致：

1. **换一个代理节点**后重试；确认当前网络能访问 GitHub Releases。
2. 检查 **设置 → 网络与集成 → 网络代理** 的代理配置是否正确。
3. 若仍失败，可直接到 [发布页](https://github.com/Becomingw/Edda/releases) 手动下载最新安装包。

## 下一步

- [导入和管理论文](import-papers.md)
- [阅读、标注与整理](read-and-organize.md)
- [接入 Agent](agents.md)
