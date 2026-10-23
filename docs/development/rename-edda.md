# 更名 Edda：改名清单与迁移方案

> 状态：Phase 1–3 已在代码中完成（应用名、identifier、crate、slug、模板均已切到 Edda，迁移逻辑随之生效）。尚未发布：桥接版本、仓库改名与首个 Edda 版本见 §八。

Agentero（仓库 Becomingw/Aetero）更名为 **Edda**，与上游 poco-ai/Agentero 完全独立。全仓 `agentero` / `Agentero` / `poco-ai` / `aetero` 约 2700 处命中（不含 lock 文件），按"是否落盘、是否被用户或外部系统依赖"分级处理：

| 级别 | 含义 | 处理 |
|---|---|---|
| P（持久化） | 写进用户磁盘、Vault、系统注册表、钥匙串或外部配置 | 必须迁移或兼容读取 |
| D（分发） | 影响安装、更新、签名、商店 | 必须设计切换路径 |
| I（内部） | 代码标识、文案、文档 | 直接替换 |

## 一、决策项

| # | 问题 | 建议 |
|---|---|---|
| D1 | 新 bundle identifier | **已定**：`io.github.becomingw.edda` |
| D2 | 老用户兼容程度 | **已定**：完整迁移 Vault 和配置目录，并发桥接版本带走 WebView 本地状态（§4.3 方案 A） |
| D3 | 移动端（iOS/Android） | **已定**：暂停。本次只改桌面端，移动端配置保留但停止发布，桌面稳定后再迁 |
| D4 | GitHub 仓库 | **已定**：发 Edda 首个版本当天改名为 `Becomingw/Edda`。GitHub 会自动重定向旧 URL，对更新器的影响见 §5 |
| D5 | 中文名 | 统一用 "Edda"，不加译名，两种语言保持一致 |

## 二、Phase 1：先把散落的名称收敛成常量（用户无感知，可单独合入）

> **已完成**。产品名在磁盘和存储层只经由以下常量出现：Host `agentero_core::paths::{APP_SLUG, APP_DOT_DIR, RENAME_TEMP_MARKER}` 与 `vault_private_rel!`，前端 `src/lib/core/app-identity.ts`（同名常量）。与原计划的差异：`~/.agentero/import-tmp` 暂留原处（前端清理逻辑按路径判断，搬迁放到 Phase 3 一起做）。

这一步本身就是还技术债，做完后真正的改名只需要改几处常量。

1. **Vault 私有目录**：`.agentero` 字面量散在 58 个源文件里，共 334 处（含测试）。收敛为 `agentero_core::paths::VAULT_PRIVATE_DIR` 和 `vault_private_dir(vault: &Path) -> PathBuf`。远端 `integration/remote/catalog_mirror.rs` 里的 `CATALOG_REL` 等相对路径也从同一个常量派生。
2. **全局目录**：`paths.rs` 里的 `agentero_config_dir` / `agentero_cache_dir` / `agentero_data_dir` 改成中性名字 `app_config_dir` / `app_cache_dir` / `app_data_dir`，目录名统一取 `APP_DIR_NAME`。`import/mod.rs:540` 用的 `~/.agentero/import-tmp` 改为放到 `app_cache_dir()` 下。
3. **内置 provider id**：`"agentero"` 改成中性的 `"builtin"`。涉及 `translate/mod.rs:19`、`src/lib/core/builtin.ts:14`、`src/lib/pdf/layout/providers.ts:91` 和 i18n 键。读 `settings.json` 时把 `"agentero"` 映射为 `"builtin"`。这样以后再改名，这个 id 不用跟着动。
4. **PDF 标注标记**：`custom.app`（`pdf/locate/annotations.rs:188`、`use-pdf-highlights.ts:386`、`migrate-marks.ts:69`）同样改成产品无关的常量。读取时兼容 `"agentero"`。
5. **前端 localStorage 键和 CSS 类名**：约 40 个以 `agentero-` 开头的键。存储键收敛到一个 `STORAGE_PREFIX` 常量；CSS 类前缀在 Phase 3 统一替换。
6. **Vault 内的 sidecar 文件名**：`agentero-cite.json`、`agentero-skill.json` 收敛为常量，读取时兼容旧名（见 §4.1）。

## 三、Phase 3：改名清单

### 3.1 应用身份（D 级）

| 位置 | 现值 | 新值 |
|---|---|---|
| `src-tauri/tauri.conf.json` `productName`、窗口 `title` | Agentero | Edda |
| `tauri.conf.json` `identifier` | `com.poco-ai.agentero` | D1 |
| `tauri.macos.conf.json` 窗口 `title` | Agentero | Edda |
| `deep-link.schemes`（桌面和移动端） | `agentero` | `edda`。`open_request.rs` 保留一个版本对 `agentero://` 的解析 |
| `updater.endpoints` | `…/Becomingw/Aetero/…/latest.json` | 见 §5 |
| `src-tauri/nsis/hooks.nsh` | `OpenWithAgentero`、"Open with Agentero" | `OpenWithEdda`。PREINSTALL 增加清理旧键：只删 command 指向旧安装目录的那些 |
| `src-tauri/icons/*`、`src/assets/agentero-*.svg`、`docs/assets/agentero-app-icon.svg` | 旧 logo | 新 logo（需要设计） |
| `Info.ios.plist`、`ios-project.yml`、`gen/apple/*`、`gen/android/*` | Agentero / `com.poco-ai.agentero` | 暂不改（D3）；`ios-testflight.yml` 和 release 里的 Android 任务停用 |
| `integration/bridge/identity.rs:17` 钥匙串 service | `com.poco-ai.agentero.bridge` | `<D1>.bridge`。已配对的设备需要重新配对 |

### 3.2 Crate、包名与构建（I 级）

- 根 `Cargo.toml` workspace members：`crates/agentero-core` → `crates/edda-core`。
- `src-tauri/Cargo.toml`：包名 `agentero` → `edda`，lib 名 `agentero_lib` → `edda_lib`。同步修改 `app/logging.rs:27` 里 `level_for` 的 target 字符串，否则 Agent 日志级别会失效。
- 全仓 `agentero_core::` → `edda_core::`。
- `package.json` 的 `name`。
- `.github/workflows/ci.yml`、`release*.yml` 中的 `cargo test -p agentero*`、`agentero.exe`、安装验证目录名。
- `ios-testflight.yml` 暂不改，整条流水线停用（D3）。

### 3.3 环境变量（I 级，CI 密钥要同步改）

约 40 个 `AGENTERO_*` 统一改为 `EDDA_*`。需要同步在 GitHub Secrets 里重建的是构建期注入的那几个：`AGENTERO_BUILTIN_API_KEY`、`AGENTERO_BUILTIN_BASE_URL`、`AGENTERO_BUILTIN_*_MODEL`、`AGENTERO_POSTHOG_KEY`（遥测已移除，不再需要）。其余是测试或调试开关，直接替换即可。

### 3.4 对外协议标识（P 级，影响外部客户端）

| 位置 | 现值 | 新值 | 影响 |
|---|---|---|---|
| `integration/mcp/tools.rs:554` server name 和 title | `agentero` / Agentero | `edda` / Edda | 外部 MCP 客户端按 URL 连接，地址 `127.0.0.1:8765/mcp` 不变，只是显示名变了 |
| `ops/invariants.rs:28` 资源 URI | `agentero://vault` | `edda://vault` | Agent 提示词同步 |
| `http.rs` User-Agent、`AGENTERO_USER_AGENT_ENV` | Agentero/x.y | Edda/x.y | 内置网关如果按 UA 做白名单，要提前放行 |
| `scholar_api/sources/pubmed.rs:17` `tool` 参数 | `agentero` | `edda` | 无 |

### 3.5 Vault 模板（P 级，写进用户 Vault）

- `templates/vault/AGENTS.md`：把 version 4 → 5，并替换产品名。
- Skill `agentero-workspace` → `edda-workspace`，旧名称经现有的 `retired-skills` 机制下线。
- **删除早该删掉的 `agentero-cli` Skill**：CLI 已经退役，但模板里还保留着这个 Skill。
- 改动 Skill 后按 AGENTS.md 的规定更新版本号。

### 3.6 Phase 1 有意未收敛的内部标识（Phase 3 直接全局替换）

不落盘、或只是瞬时/内部命名，收敛成常量没有收益：CSS 类前缀（`agentero-scroll`、`agentero-dockview` 等）与 ModelScope 注入样式、DOM 事件和元素 id（`agentero:pdf-color-scheme`、`agentero-ui-theme`）、`postMessage` 的 `source`、自定义 URI 协议（`agentero-web` / `agentero-model` / `agentero-arxiv` / `agentero-coolpapers` / `agentero-modelscope` / `agentero-wiki`）、日志 target（`agentero::…`）、系统临时目录名（`agentero-skill-discovery-` 等）。

**例外**：虚拟路径 `agentero:library` / `agentero:trash` / `agentero:plaza` / `agentero:arxiv:` 会写进已持久化的标签页和会话键，Phase 3 改名时需要在 §4.3 的 WebView 状态导入里一并映射。bundle id 派生值（`finder_service` 的 `MARKER_BUNDLE_ID`、bridge 钥匙串 service）等 D1 确定后处理。

### 3.7 文案与文档（I 级）

- i18n：en 和 zh-CN 各约 37 处 "Agentero"（集中在 `settings.json`、`app.json`、`onboarding.json`、`sidebar.json`、`editor.json`），另有 30 个组件或 lib 文件含硬编码的产品名，需要逐一核对。
- `README.md`、`README.en.md`、`mkdocs.yml`、`AGENTS.md`、`docs/**`。`docs/bug_fix/` 是历史记录，正文不改，只在目录页加一句"Agentero 为 Edda 旧名"。
- `.github/ISSUE_TEMPLATE/*`、`.agents/skills/*`。

## 四、Phase 2：数据迁移

> **已完成（逻辑与测试）**。全部集中在 `agentero_core::app_rename`。判定条件是 `APP_SLUG != FORMER_APP_SLUG`：当前构建仍是旧名，所以除"拒绝已被 Edda 接管的 Vault"外全部是空操作；Phase 3 把 `APP_SLUG` 改成 `edda` 后自动生效。

原则：**先复制或改名，再切换；旧数据尽量保留，方便回滚**。所有步骤都可重复执行（幂等）。

### 4.1 Vault 内数据（本地和远端）

| 旧 | 新 | 实现 |
|---|---|---|
| `{vault}/.agentero/` | `{vault}/.edda/` | `migrate_vault_dir`，由 `ensure_catalog`（catalog 首次打开前）和 `ensure_vault`（打开 Vault 时）调用。只有旧目录时原子 `rename`；新目录已被别的写入先建出时，把旧目录里新目录没有的条目逐个移入，**从不覆盖**；真正冲突的条目留在旧目录并记日志。改名失败（例如另一个进程占用）直接报错，不会退而新建空 catalog |
| `{paper}/source/agentero-cite.json` | `edda-cite.json` | `refs::sidecar_path` 经 `migrate_file_name` 访问时就地改名；文件名由 `app_file!` 从 slug 派生 |
| `.agents/skills/*/agentero-skill.json` | `edda-skill.json` | 同上，列出 Skill 时改名 |
| catalog meta 键 `agentero_app` | `app` | 不升 schema 版本（升版本会让桥接版打不开同一个 Vault），只把写入改成 `app = APP_SLUG` |
| 远端 Vault | 同上 | `migrate_vault_dir_fs` 在 `CatalogMirror::checkout` 开头经 `VaultFs::rename` 改名；两者并存时保留新目录 |
| S3 同步 | — | 无需处理：私有目录本来就不进快照，同步状态（`sync/`、`vault.json`）随目录一起改名 |

**桥接版的反向保护**：旧名构建发现 Vault 里只有 `.edda/catalog.sqlite`、没有 `.agentero/` 时，返回 `vault.upgraded_to_successor` 错误，不会新建一个空 catalog 把数据劈成两份。

**扫描忽略**：文件树（Host 与前端）、wiki 索引、文件监听、同步快照都跳过 `KNOWN_APP_DOT_DIRS`（`.agentero` 与 `.edda`），冲突残留不会被当成用户内容。

### 4.2 全局目录

`migrate_app_dirs` 在启动时、读取 settings 之前运行：把 XDG config 和 data 下的 `agentero/` 经临时目录完整复制为 `edda/`（目标已存在就跳过），并在旧目录写 `MIGRATED.txt`。旧目录保留，桥接版照常可用。Windows 上 config 与 data 同为 `%APPDATA%`，第二次自然跳过。缓存目录不迁移，可重建。provider 旧 id 已由 Phase 1 的 `normalize()` 兼容。`~/.agentero/` 下的 dsh-acp 安装与 import-tmp 暂不迁移（前者重装即可，后者是临时文件）。

### 4.3 WebView 本地状态

bundle identifier 一改，WebView 数据目录随之改变，最近 Vault、标签页、PDF 阅读位置、主题、侧栏尺寸等都会丢失。采用方案 A：

- **桥接版导出**：主窗口启动时、以及每次窗口隐藏时（10 秒节流），把所有 `agentero-` / `agentero.` 开头的 localStorage 键经 `app_webstate_export` 写到 `~/.config/agentero/webstate.json`。
- **Edda 导入**：首次启动、各 store 读取 localStorage 之前，经 `app_webstate_import_former` 读取旧目录里的导出（读完改名为 `webstate.imported.json`，只交付一次），把键前缀和持久化的虚拟路径（`agentero:library` 等）改写为新 slug，只写入当前不存在的键。
- 前端实现：`src/lib/shell/app-rename.ts`；虚拟路径前缀已收敛为 `VIRTUAL_PATH_PREFIX`。
- **仍待桥接版本补上**：提示用户"已更名为 Edda，请下载新版"的 UI 与下载链接。

### 4.4 系统层残留

- Windows 右键菜单：旧版的 `OpenWithAgentero` 注册表项随旧版卸载器清理；Edda 安装器的 PREINSTALL 只清理 command 指向旧 Agentero 安装目录的项。
- 旧版不会被自动卸载：新 identifier 等于一个新应用，会和旧版并存。桥接版本的提示里要引导用户卸载旧版。

## 五、发布与更新切换（D 级）

关键风险：GitHub 改名后，旧仓库的 `releases/latest/download/latest.json` 会自动重定向到新仓库。如果 Edda 的 release 里也有 `latest.json`，旧版应用会**自动把自己"更新"成 Edda**：

- macOS 上 `Agentero.app` 的包内容会被替换，但 Finder 里显示的名字不变。
- Windows 上会按新 identifier 另装一份，两个版本并存。

处理办法：

1. Edda 的更新清单改名为 `edda-latest.json`，endpoint 指向 `https://github.com/Becomingw/Edda/releases/latest/download/edda-latest.json`。
2. 旧名的 `latest.json` 只在桥接版本 v0.11.x 里发布一次。之后 Edda 的 release 都不带 `latest.json`，旧版检查更新会拿到 404，静默停在桥接版本。
3. updater 签名 key 可以沿用（私钥在本人手里），也可以借此机会换新。
4. macOS 公证和 Windows 安装包都要用新的产品名和 identifier 重新走一遍签名流程。

## 六、与上游彻底切开

- **LICENSE**：MIT 要求在副本或实质性部分中保留原版权和许可声明。所以保留 `Copyright (c) 2026 poco-ai`，另起一行加自己的版权行。README 顶部的"基于 poco-ai/Agentero 继续开发"可以移到"致谢"一节，但不要删掉署名。
- **删除上游残留**：`.github/workflows/feishu-bot.yml`、空的 `cli/` 目录、已退役的 feeds/recommend 死代码（约 3600 行，已删除）、模板里的 `agentero-cli` Skill。
- **PostHog 遥测**：**【已决定】** 整体移除（`core/telemetry`、`telemetryEnabled` 设置与 `EDDA_POSTHOG_KEY` 构建变量均已删除），本地 `usage.sqlite` 保留。

## 七、执行顺序与验证

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | Phase 1 收敛常量（无用户可见变化） | `cargo test --workspace`、`pnpm test`，`git grep '\.agentero'` 只剩常量定义和测试 |
| 2 | 桥接版本 v0.11.x（方案 A 时需要） | 手动核对导出的 webstate.json，确认更新提示能弹出 |
| 3 | Phase 2 迁移逻辑 + 单元测试 | 覆盖：只有旧目录、只有新目录、新旧并存、远端 Vault、重复执行幂等 |
| 4 | Phase 3 全量改名 | `git grep -i 'agentero\|poco-ai'` 只剩迁移代码、LICENSE、bug_fix 历史文档 |
| 5 | 用一个真实的旧 Vault 加旧配置跑一遍首次启动 | macOS 和 Windows 各跑一次：catalog、标注、阅读位置、Agent 配置都完整 |
| 6 | 改仓库名、发 Edda 首个版本 | 旧版检查更新拿到 404；新版检查更新正常 |

## 八、Phase 3 之后仍待完成

Phase 3 已完成：`productName` / `identifier` / 窗口标题 / deep link（`edda://`）/ updater 地址（`edda-latest.json`）/ NSIS 右键菜单 / Finder 服务与 bridge 钥匙串 ID / crate（`edda`、`edda-core`）/ 环境变量（`EDDA_*`）/ MCP 与 ACP 标识 / 自定义协议（`edda-web` 等）/ CSS 与存储键 / i18n / Vault 模板（`edda-workspace`，旧 `agentero-workspace` 与 `agentero-cli` 经 `RETIRED_SKILLS` 归档）/ 文档。release 流水线新增 `updater-manifest` 任务，Android 任务与 iOS 的 tag 触发已停用；`feishu-bot.yml` 已删除；LICENSE 增加本仓库版权行，README 的上游说明移至致谢。

**有意保留旧名的地方**：迁移代码（`FORMER_APP_SLUG`、`KNOWN_APP_DOT_DIRS`、`LEGACY_BUILTIN_PROVIDER_IDS`、`RETIRED_SKILLS`）、对话历史里的旧提示词前缀、`docs/bug_fix/` 历史复盘、上游 issue 链接。Zotero 同步标记也已改为 `edda:sync`（改名前尚无用户同步过，无需兼容旧标记）。

**待办**：

1. **新图标**：`src-tauri/icons/*`、`src/assets/edda-*.svg` 仍是旧图形，只改了文件名。
2. **GitHub Secrets**：发布流水线改读 `EDDA_BUILTIN_API_KEY`，需在仓库 Secrets 新建（签名类 secret 名称未变；遥测已移除，不再需要 `POSTHOG_KEY`）。
3. **桥接版本**：必须从 Phase 2 提交（`50c0419a`，仍是旧 identifier）拉分支构建，不能从 main 构建。补上"已更名为 Edda"的提示与下载链接、`vault.upgraded_to_successor` 的 i18n 文案；这个版本的 Release 照常带 `latest.json`，之后的 Edda Release 只带 `edda-latest.json`。
4. **仓库改名**：发布 Edda 首个版本当天把 `Becomingw/Aetero` 改名为 `Becomingw/Edda`（代码里的链接已指向新名）。
5. **端到端验证**（§七第 5 步）：拿真实的旧 Vault 与旧配置在 macOS、Windows 上首次启动 Edda，检查 catalog、标注、阅读位置、标签页、Agent 配置。
6. **用户需重做的少量操作**：dsh-acp 演示 Agent 需重新安装（目录从 `~/.agentero/dsh-acp` 变为 `~/.edda/dsh-acp`）；移动端需重新配对。
7. **独立性残留（2026-10-04 决定暂时沿用）**：默认 Zotero translator 服务 `translator.philfan.cn` 与内置 provider 网关 `api.qiyuanchen.top` 由上游贡献者托管；本仓库未配置 `EDDA_BUILTIN_API_KEY`，发布包不含内置 provider。若日后自备 key，必须同时注入 `EDDA_BUILTIN_BASE_URL`，否则 key 会发往默认网关。iOS TestFlight 文档仍指向上游站点（移动端已暂停）。

