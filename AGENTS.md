# AGENTS.md

## 项目概览

Margin 是基于 Tauri 2 + React 19 的本地优先稿件审阅应用。每稿的 `.margin/documents/<id>/review.sqlite` 是正文版本、基线、提案、批注和裁决的权威存储；虚拟 `manuscript.md` 不可作为独立活文件写入。AI 仅提交待审提案，作者负责应用和接受 / 拒绝。

架构与边界：[docs/margin.md](docs/margin.md)、[事务核心](docs/backend/margin.md)、[单 AI MCP](docs/margin-single-ai.md)。保留的上游源码 / 文档不代表 Margin 对外开放这些功能。

## 开发规则

- 优先做小而聚焦的改动，能用少的修改解决问题就不要增加复杂度。高内聚、低耦合。如果系统有额外冗余可以提示用户进行重构
- 只加必要的影响性能和功能的测试代码，不加没有实际意义的测试用例。
- 尽可能能复用能力，避免重复造轮子。
- 改 UI 前先读 [docs/design.md](docs/design.md)，只用其中的颜色、细线、圆角、阴影 token，不自造 `border-border/60`、`shadow-md` 这类临时组合。
- 在 UI 修改的过程中尽量少加入无关的、非必须的i18n 文案，如果能用icon表达，就不要加额外的描述。操作失败用 `notifyError` Toast，不在侧栏 header 挂常驻错误条。
- 国际化（i18n）：所有面向用户文案必须经 `t()` 走 `react-i18next`。en 源语言 → 同步 `zh-CN`（`src/i18n/locales/`）。详见 [docs/frontend/shell.md](docs/frontend/shell.md)。
- 如果修改了 Template 下的 Skill 和 AGENTS.md ，需要对应更新版本号。
- 修改后需同步更新相关文档，并检查 Roadmap 和 Todo。
- 修改完成后，把当次相关的改动按照 commit 部分的要求提交。

## Windows 注意事项

- **路径**：禁止手拼 `${vault}/${rel}`，统一走 `joinVaultPath` 并归一分隔符；混用 `/` `\` 在 `\\?\` 前缀下报 ERROR_INVALID_NAME（#181），拖入文件路径也要归一后再去重。
- **新窗口**：同步 `#[tauri::command]` 里 build WebviewWindow 会在 WebView2 嵌套消息循环死锁（白屏、关不掉），必须用 async command。
- **窗口装饰**：统一用原生 decorations；React 自绘标题栏按钮在 Settings 等子窗口拿不到 IPC 权限。
- **子进程/安装**：Windows 只走 npm/PowerShell 安装路径，Unix 脚本用 `cfg(not(windows))` gate；注意 `CREATE_NO_WINDOW` 与 `.exe` 命令名。
- **cfg 门控**：Cargo target cfg（如 `cfg(all(unix, ...))`）必须与代码侧 gate 对齐，否则 Windows release 编译失败。
- **UI 缩放**：Windows 125% 等非整数 DPR 会放大 px/rem 混用误差，对齐类样式用 rem。

## Commit

- 提交信息必须符合 [Conventional Commits](https://www.conventionalcommits.org/) 规范。
- 一次提交只做一件事，避免混合多个 unrelated changes。
- 如果有多个 unrelated changes，`git commit --only -m "msg" -- <path1> <path2>` 使用只提交指定路径的改动
- 项目级 Agent Skill：`.agents/skills/bump/SKILL.md` 定义版本升级流程；`.agents/skills/commit/SKILL.md` 定义按逻辑拆分当前改动并提交的流程。
- 面向外部 Agent 的 Skill 是 `skills/margin-mcp-reviewer/`，MCP 工具契约变化时同步维护并运行 `test/margin-skill.test.ts`。`templates/vault/` 为尚未裁剪的上游资料，不是 Margin 的运行时模板。
- 仅向 `origin`（`Becomingw/Margin-Next`）推送，不能误推 `upstream`。默认构建只装配 Margin，`legacy-workbench` 不得用于 release。Windows 预览打包使用 `src-tauri/tauri.release.conf.json`，流程见 [发布说明](docs/development/release.md)。保留 MIT 来源署名，不以全仓字符串替换破坏兼容标记。
- `bump` Skill 只修改版本来源文件并运行最小验证，默认不创建 commit、tag、Release 或 push；需要时由用户显式要求。
- `commit` Skill 必须保留用户已有改动，按目的精确暂存，检查相关文档，并只创建本地 Conventional Commit。
- 如果库当中有对应的 issue，则在提交信息中引用（如 `Fix #123`）；解决了该 issue 则关闭；部分解决则在 issue 区评论。
- 解决 Issue 之后，把解决的方法评论在 issue 中

## 常用命令

```bash
pnpm install
pnpm dev
pnpm tauri dev
pnpm build
pnpm lint
pnpm format
pnpm tauri build
```

```bash
# 单 AI MCP 与共享事务服务（仓库根 workspace）
cargo test -p margin-desktop margin::ai::tests --lib
cargo test -p margin-core
pnpm tauri build --config src-tauri/tauri.release.conf.json --bundles nsis
```

完成实现前运行最小必要验证。UI 改动优先启动应用检查对应流程。

## 文档地图

| 层 | 技术栈 | 关键能力 | 入口 |
|---|---|---|---|
| 前端 | React 19、TypeScript、Tailwind CSS 4、Plate、EmbedPDF | `src/margin/` 独立壳、行内修订与页边讨论 | [docs/margin.md](docs/margin.md) |
| Host | Rust、Tauri 2、SQLite | `margin-desktop` / `margin_lib`、`crates/margin-core` 事务服务 | [docs/backend/margin.md](docs/backend/margin.md) |
| MCP | Rust、Streamable HTTP | 单稿、单审阅身份、可撤销授权；七个审阅工具 | [docs/margin-single-ai.md](docs/margin-single-ai.md) |

| 分类 | 内容 | 路径 |
|---|---|---|
| **架构** | 整体架构、工作台布局、核心工作流、数据流 | [docs/architecture.md](docs/architecture.md) |
| **设计** | 界面 token：颜色、细线、圆角、阴影、焦点、响应式 | [docs/design.md](docs/design.md) |
| **前端** | 壳、工作区、文件树、论文库、入库、Markdown、PDF、Agent、双链、翻译、设置 | [docs/frontend/](docs/frontend/index.md) |
| **后端** | 数据模型、Catalog、Vault、入库、Connector、Wiki、Agent、远程、搜索、日志、MCP、API | [docs/backend/](docs/backend/index.md) |
| **教程** | 快速上手、导入论文、阅读整理、接入 Agent、Zotero | [docs/usage/](docs/usage/index.md) |
| **开发** | 路线图、TODO、设计记录 | [docs/development/](docs/development/index.md) |
| **测试** | 测试策略、发布 Checklist | [docs/test/](docs/test/index.md) |
| **Bug 复盘** | 历史 Bug 分析（不删除） | [docs/bug_fix/](docs/bug_fix/) |

约定：已实现按功能写在 `docs/frontend/` / `docs/backend/`；未实现草稿在 `docs/development/`。
