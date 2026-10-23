# 系统预设只读与开发者模式 — 设计草案

> 状态：**已实现**（2026-10），见 §6；未实现项列在 §6.2。
> 原则：Edda 随应用发布的 Skill、插件与网站适配器是**系统预设**，普通模式下不可删除、不可修改；
> 只有打开**开发者模式**才能改。用户自己添加的 Skill、MCP 插件、网站与适配器不受影响。

## 1. 预设清单

| 类别 | 预设 | 现状 |
|---|---|---|
| Skill | `paper-reader`、`paper-qa`、`author-lookup`、`deep-research`、`idea-evaluator`、`vault-normalizer`、`edda-workspace`、`edda-paper-reviewer`、`site-import`、`site-layout` | 复制进知识库 `.agents/skills/`；可从 Skill 管理删除（记入 `removedSkills` 不再重装），用户编辑跨版本保留（`bundledSkillHashes`） |
| 插件 | Edda 工作区 MCP（含规划中的 `browse_*` 工具） | 自动接入，不在插件列表里展示 |
| 网站适配器 | `arxiv`、`coolpapers`、`modelscope`（见 [browse.md](browse.md#4-站点适配器)） | 预设编进应用、只读，修改写入追加层 |

知识库指令 `AGENTS.md` 属于用户内容，照常可编辑，不在此列。

## 2. 普通模式

### 2.1 界面

- Skill 管理：预设 Skill 显示锁形标记，没有删除、编辑入口；悬停说明「系统预设，开启开发者模式后可修改」。
- 插件菜单：Edda 工作区工具作为一项锁定插件列出（可看工具清单），不可删除、停用或编辑。
- 浏览：预设适配器只读，修改写入其上的追加层（见 browse.md §4.1）。

### 2.2 强制（不只靠界面）

知识库里的预设 Skill 目录视为**受管镜像**：外部编辑器或 Agent 仍可能直接改文件，因此在三处校验：

1. **打开知识库时**与**文件监听发现变动时**：逐个比对预设 Skill 与应用内置版本的哈希；
   不一致就把改动后的副本移入回收站，再从内置版本恢复，并提示「已恢复内置 Skill X」。被删除的同理重装。
2. **注入 Skill 时**：发给 Agent 之前再校验一次，保证这一轮用的是原版。
3. **Agent 权限请求**：编辑类工具调用的路径命中预设 Skill 目录时，Host 直接拒绝
   （包括「自动批准」模式），并在回合里显示原因。

## 3. 开发者模式

- 位置：设置 → 高级 → **开发者模式**，打开时二次确认，说明后果。设置项 `developerMode`（全局）。
- 打开后：
  - 预设 Skill 可编辑、删除，Skill 管理里显示「已修改」标记；§2.2 的自动恢复与权限拒绝暂停。
  - 预设插件可停用（便于调试）；预设适配器可直接编辑。
  - 浏览视图可打开网页检查器（构建支持时）。
- 关闭时：被改过的预设先备份到 `<应用配置>/dev-backups/<时间>/`，再恢复为内置版本；
  确认框列出将恢复的项目。备份不会自动删除。

## 4. 迁移

以前版本允许并保留了用户对预设 Skill 的编辑。升级到本设计的版本时：

- 与内置版本不同的预设 Skill，先复制为同目录下的**用户 Skill** `<id>-custom`（名称加「（自定义）」），
  再恢复预设；提示用户自定义版本已另存。
- 之前被删除的预设 Skill 重新安装，`removedSkills` 中的预设 id 清除。
- 这会取代 `8732f756`（「升级时保留已编辑的内置 Skill」）的行为。

## 5. 实现落点（预估）

| 层 | 改动 |
|---|---|
| `edda-core` `agent_config.rs` | 预设校验与恢复、迁移；`remove_skill` 拒绝预设 id（开发者模式除外） |
| Host 设置 | `developerMode`；Agent 权限处理里拦截写入预设路径 |
| 文件监听 | 预设目录变动触发校验 |
| 前端 | Skill 管理与插件菜单的锁定态；设置开关与确认框；提示文案 |

## 6. 实现

### 6.1 已实现

| 环节 | 实现 |
|---|---|
| 设置 | `developerMode`（全局，默认关）；设置 → 通用 →「开发者」。开启 / 关闭都有确认框；关闭时列出当前 Vault 与内置版本不同的预设 Skill（`preset_skills_modified`），确认后 `preset_skills_restore` 先备份到 `<应用配置>/dev-backups/<时间>/<Vault 名>/` 再恢复 |
| 校验与恢复 | `edda-core` `vault/presets.rs`：`preset_state`（逐文件比对，多出的文件也算修改，忽略 `.DS_Store`）、`enforce_presets`（改过的移入回收站后按内置版本重写，缺失的重装，清除预设 id 的 `removedSkills`） |
| 打开 Vault | `vault_ensure` 在 `ensure_vault` 之后执行恢复，结果放在 `CreateVaultResult.presets`，前端提示「已恢复 N 个系统预设 Skill」 |
| 文件变动 | 文件监听发现 `.agents/skills/<预设>/` 变动时，800 ms 后（同一批变动只跑一次）恢复，并发 `vault:presets-restored` 提示 |
| 注入 Skill | `load_skill_instructions_with(..., shipped_presets)`：非开发者模式下预设 Skill 直接用内置文本，不读盘 |
| Agent 权限 | `decide_permission` 前置检查：读 / 搜索以外的请求，若路径或输入（含 shell 命令）提到 `.agents/skills/<预设>`，在任何权限模式下（含自动批准）都拒绝 |
| 删除 | `agent_remove_vault_skill` 对预设 id 返回 `preset_skill` 错误（开发者模式除外）；Skill 管理里预设显示锁形标记，开发者模式下显示删除按钮与「已修改」标记 |
| 迁移（§4） | 每个 Vault 第一次恢复时（`agent-config.json` 的 `presetsLocked` 为假），先把改过的预设另存为 `<id>-custom`（重名则 `-custom-2`…，`name` 改名、去掉 `version`），提示「你修改过的版本已另存为…」 |
| 插件 | Agent 插件菜单顶部列出锁定的「Edda 工作区」系统插件 |

### 6.2 未实现 / 取舍

- **预设适配器**仍编进应用，开发者模式也不直接改；修改写追加层（`browse_adapter_write`），整体可用工具条开关关闭。
- **停用工作区插件**、**浏览视图网页检查器**未做：后者需开启 Tauri `devtools` 特性，会让正式版所有窗口都可检查。
- **回合内说明**：权限被拒时只记日志，Agent 收到的是取消；被改的预设随后由文件监听恢复。
- 不经权限请求直接写文件的 Agent（完全放开权限的原生 Agent）只能靠文件监听事后恢复。
- 远程知识库不执行恢复（`ensure` 结果的 `presets` 为空）。
