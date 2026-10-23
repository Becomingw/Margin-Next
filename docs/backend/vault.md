# Vault 文件系统

## 职责

打开/创建 Vault；读写文本与二进制；目录树；回收站；文件监听；终端打开。本地或远程 session（远程见 [remote.md](remote.md)）。

## 初始化

```text
用户选择目录（dialog）
  → vault_create / 打开已有
  → papers/ notes/ .agents/skills/ AGENTS.md
  → notes/ 下三篇本地化新手教程（缺失时才写入）
  → .edda/catalog.sqlite
  → 前端加载树（Create 后自动打开 notes/01 ...）
```

- 模板：`templates/vault/`。
- 教程模板按 UI 语言存放在 `templates/vault/notes/en/` 或
  `templates/vault/notes/zh-CN/`，写入 Vault 时统一展开到 `notes/` 根目录；
  不覆盖用户已编辑的同名文件。
- `vault_create` 返回的 `openPath` 为首篇教程路径，即使教程已存在也不打开配置文件。
- 每次打开补种缺失的 bundled skills，但跳过 `.edda/agent-config.json` 的 `removedSkills`。第一方 `SKILL.md` 沿用 frontmatter 整数 `version` 升级（盘上版本低于模板则覆盖并 toast）；无 `version`、同版本或更高版本保持原样。`updated` 列出本次升级路径。
- **系统预设**：非开发者模式下，`vault_ensure` 之后还会执行 `presets::enforce_presets`——与内置版本不同（含多出的文件）或缺失的预设 Skill 移入回收站并按内置版本重写，`removedSkills` 中的预设 id 清除；结果放在 `presets.restored`。该 Vault 第一次执行时（`agent-config.json` 的 `presetsLocked` 为假）先把改过的预设另存为用户 Skill `<id>-custom`（`name` 改名、去掉 `version`），列在 `presets.preserved`。见 [../development/developer-mode.md](../development/developer-mode.md)。
- `AGENTS.md` 默认模板 v3 增加论文平级存储约定；其初始化与 Skill 版本升级分开：`agentsTemplateHash` 记录最后生成内容的 SHA-256，仅盘上内容仍匹配时自动升级；缺失时创建，未知来源和用户自定义文件保留。设置保存须 `confirmed=true` 且 `expectedRevision` 与当前文件匹配；否则分别返回 `confirmation_required` / `agent_config_conflict`。写入使用原子替换，最多 128 KiB，拒绝修改符号链接。
- 初始化、Skill 安装/移除/恢复与指令保存共享 `.edda/agent-config.lock` 跨进程锁。删除移入既有回收站并记 tombstone；撤销恢复完整原目录，重新添加恢复内置默认版本。目录安装暂存后整体 rename 发布，失败不暴露半安装 Skill。

### 更名迁移

打开 Vault 时（`ensure_vault`）以及 catalog 首次打开前（`ensure_catalog`），`edda_core::app_rename::migrate_vault_dir` 把旧产品名的私有目录改名为当前目录，冲突时只移入缺失条目、从不覆盖；远端 Vault 在 catalog 检出前做同样的改名。私有目录的所有历史名称（`KNOWN_APP_DOT_DIRS`）都不出现在文件树、wiki 索引、文件监听和同步快照中。设计见 [更名 Edda 方案](../development/rename-edda.md)。

## 关闭 / 切换

没有 `vault_close` 命令。vault 的生命期由前端 `vault:opened` 作用域的 teardown 表达（见 [../development/lifecycle-events.md](../development/lifecycle-events.md)）：

```text
切换 / 关闭 vault
  → 释放 vault:opened 作用域
  → 各 store 的 vault 级 clear（catalog 行、wiki 重命名流程、
     agent 会话、标注、layout 结果、相关弹窗）
  → app::vault_session::vault_release：取消该 vault 的 JobCenter 任务、
     清 paper caps cache、驱逐该 vault 的 catalog 连接缓存条目
```

文件监听不需要显式停止：`fs_watch_start` 会替换该窗口的既有 watcher，窗口销毁时由 `on_window_event(Destroyed)` 停止。

## 文件树

| Command | 说明 |
|---|---|
| `vault_tree_build` | 本地一次 IPC 整树 |
| `vault_tree_children` | 懒加载（如 `source/`） |
| 路径读写 | `path_read_text` / `path_write_text` / `path_mkdir` / 移动等 |

规则：产品目录全量递归；`source/` 与其它根子目录懒加载；忽略 `.git`/`node_modules`/…  
前端：[../frontend/vault-tree.md](../frontend/vault-tree.md)。

## 回收站

| Command | 说明 |
|---|---|
| `path_trash` | 移入 `.edda/.trash/`（含 catalog 快照） |
| `path_list_trash` | 列表 |
| `path_restore_item` | 恢复 |
| `path_purge_item` / `path_purge_trash` | 永久删除 / 清空 |

本地 `path_trash` 成功后会取消被删论文的全部排队/运行中 JobCenter 任务（`JobCenter::cancel_for_paper`），避免已删论文继续下载 / 解析。

## 文件监听

- Host `notify` → `vault:file-changed`。
- Host 空闲时阻塞等待 FS 事件（无定期空转）；有变更时再做约 300ms trailing debounce。停止 watcher 时 drop 原生监听以唤醒阻塞线程。
- 前端：打开 md 自动重载（有未存则提示）；结构变化局部刷树。窗口隐藏/失焦时缓冲 `vault:file-changed`，回到前台再按序 flush；树 / wiki / Library 的去抖在后台会拉长。
- 代码：`features/vault/watcher/`、`src/lib/vault/fs-watch.ts`、`src/lib/vault/file-change-gate.ts`、`src/lib/vault/shell-activity.ts`。

## Capabilities（摘要）

`src-tauri/capabilities/default.json`：`fs:*` 读写/dir、`dialog`、`opener`（含 reveal）、scope 覆盖 `$HOME/**` 等用户可选目录。

## 其它

- `path_open_in_terminal`：系统默认终端（目录自身 / 文件父目录）。Windows 复用 `core::process::windows_shell_path` 去掉本地盘符路径的 `\\?\` 前缀，Windows Terminal 的 `-d` 与 CMD 的进程工作目录使用同一结果；CMD 通过隐藏的 `start` 启动进程创建独立交互控制台，不再拼接 `cd` 命令，也不继承桌面应用的关闭 / 重定向输入输出句柄。
- 多窗口：`window_new`、`settings_window_open`。

## 代码

`features/vault/` · `app/vault_session/` · `app/terminal/` · `app/window/`
