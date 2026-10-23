# Vault Doctor

Doctor 聚合本地 Vault 的只读完整性检查，并为论文别名、双链与视觉批注格式提供**显式确认**的安全修复。

## 检查范围

`DoctorReport` 包含五组结果：

1. Vault 目录结构（`papers/`、`notes/`、`.edda/`）；
2. `.edda/catalog.sqlite` 是否存在且 schema 与当前版本一致；
3. Catalog 中是否存在重复行：同一 `id` 出现在多条记录，或同一 `path` 出现多次（后者为 schema 完整性校验）；
4. 与桌面导航共用 `WikiIndex::check_links` 的双链语义结果；
5. Catalog 中每篇 `papers/**/NOTES.md` 的 frontmatter aliases；
6. `papers/**/marks/*.json` 视觉批注格式（旧版 `agent-trace` → `visual` v2）。

一次检查不会创建目录、迁移 Catalog 或修改 Markdown；Catalog 以只读 SQLite connection 打开。

一篇论文笔记至少要有两个按 Wiki resolver 规则归一化后仍不同的非空 alias。Doctor 保留现有自定义 aliases，并提出可编辑的标题 alias 与确定性短 alias：

- 优先使用冒号或破折号前的有效短标题；
- 英文标题使用去掉常见连接词后的首字母缩写；
- 中文标题无可靠短标题时使用「第一作者 + 年份」；
- 冲突时依次追加年份、第一作者；仍冲突则只报告、默认不选。

重复的正式标题只告警，不修改 Catalog；编辑标题 alias 也不会回写 Catalog。

## 安全修复

### Catalog 重复行

`doctor_fix_catalog_duplicates` / CLI `edda doctor fix catalog-duplicates`：

- 对每组重复 `id`，按「路径存在磁盘 > `updated_at` 最新 > 路径最短 > 字典序最小」保留一条 canonical 记录，删除其余行；
- 对重复 `path`（schema 完整性校验），保留 `updated_at` 最新的一条；
- 返回 `removedRows`、`removedPaths`、`keptPaths`；
- 桌面端在 Doctor 设置页的 Catalog 区显示「去重」按钮。

### 论文 aliases

`doctor_apply_aliases` 只接受当前 Catalog 行对应的 `NOTES.md`。批量写入前会：

- 拒绝主窗口报告的未保存编辑路径；
- 校验诊断时的 SHA-256 内容哈希；
- 拒绝复杂、异常或无法精确定位的 YAML；
- 先规划全部文件，再**原地写入**（不改 path / 文件名，只改 frontmatter）；
- 任一写入失败时按规划内容回滚本批已写文件。

不使用 tmp+rename 式原子替换：那样会被 Vault 文件监听器当成「不完整改名」，误报外部改名未修复链接。

#### 忽略（持久化）

用户可在设置页对单篇或已勾选论文选择 **忽略** 别名检查。忽略列表落在 Vault 本地 `.edda/doctor.json` 的 `ignoredAliasPaths`（相对 `papers/**/NOTES.md` 路径）：

- 再诊断时这些路径不再计入别名错误 / 修复候选，也不使 `aliases.ok` 为 false；
- `DoctorReport.aliases.ignoredPaths` 返回仍不完整且仍被忽略的路径，供 UI 恢复；
- 已补齐至少两个 distinct aliases 的笔记会自动从活跃忽略展示中消失（列表条目可在写盘时保留，无害）；
- `doctor_ignore_aliases` 以 `ignore: true|false` 增删路径。

### 双链语义

1. **探测** `doctor_plan_wikilinks`  
   - 对 unresolved 边做唯一高置信匹配（path / stem / alias 近邻、heading/block 近邻）→ `layer=deterministic`（默认勾选）  
   - 无法唯一匹配时仍输出可编辑候选项 → `layer=manual`（默认不勾选，绿色区可手改）  
   - 每条 suggestion 含 `rangeStart/End`、`expected`、`expectedHash`、`linePrefix` / `lineSuffix`（整行上下文）  
2. **UI 列表**：git 风格整行展示，核心变更居中高亮，按容器宽度窗口化前后文  
3. **Agent 协作（不自动跑）**：探测后展示可复制提示词（随 UI 语言 en/zh）；「在 Agent 中打开」关闭设置窗、打开主窗 Agent 并预填 composer；Agent 应先给计划、等用户确认再改文件  
4. **修复** `doctor_apply_wikilinks`：用户勾选后原地写入选中 range；脏路径 / 哈希 / 重叠 range 预检，失败回滚  

设置页流程：探测 → 建议列表（全选 / 修复）→ 下方 Agent 提示词（复制或打开 Agent）。

### 视觉批注格式

扫描 `papers/**/marks/*.json`（跳过 `annotations.json`）。对 `kind: agent-trace` 或扁平 agent 字段的旧格式给出候选：

- `doctor_apply_visual_marks` / CLI `doctor fix visual-marks`：改写为 `kind: visual` v2，agent 字段嵌套进 `agent` 对象；**保留 id 与 `image.path`**
- 幂等：已是嵌套 v2 的跳过
- 脏路径（打开中的 mark）拒绝写入

读路径（桌面）始终 dual-read v1/v2，不依赖 Doctor 也能打开旧 Vault。

## Host / Agent 诊断

除 Vault Doctor 外还有两个 **host 级**检查（不依赖 Vault）。设置 → 问题诊断只展示网络连通性（按需运行）；主机运行环境由设置 → Agent 的安装依赖指引展示。各 Agent 的 ACP 连通性由 Agent 页每行的 `agent_probe` 探测展示，Doctor 不再单独重探；Node.js 一键安装（`doctor_install_node`）已随诊断页的主机运行环境一节移除。

### 主机运行环境（`doctor_check_host`）

`agent/doctor.rs` `diagnose_host`：在 Agent 实际使用的合并环境（`effective_local_agent_env`，PATH 按 descriptor → 进程 → login shell → 常见 GUI 缺失目录顺序合并）里检查：

- `node` / `npm`：解析路径 + `--version`（5s 超时），状态 `available / missing / unusable`；
- `npm prefix -g`：追加进环境 PATH 后再查 node（覆盖 npm 全局安装但 GUI PATH 缺失的场景）。
- Windows：探测子进程一律带 `CREATE_NO_WINDOW`（`diagnostic_command` 统一收口）。应用是 GUI 子系统二进制，缺该标志时 Windows 会给每个控制台子进程新建可见控制台——表现为每次打开/刷新问题诊断，每探测一个工具就多一个黑窗（标题即该工具路径，两个 hermes 条目就是两个黑窗）。

### 网络连通性（`doctor_check_network`）

`system/network/mod.rs` `diagnose_network`：按当前应用的全局代理设置（`effective_proxy_url`），并行探测六个常用站点/论文源：

| 端点 | 探测 URL |
|---|---|
| Baidu | `https://www.baidu.com/` |
| Google | `https://www.google.com/generate_204` |
| Google Scholar | `https://scholar.google.com/` |
| GitHub | `https://api.github.com/` |
| arXiv | `https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1` |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1/paper/ARXIV:1706.03762?fields=title` |

- 8s 超时，`buffered(6)` 并行探测，按固定顺序返回；
- 使用 `BROWSER_USER_AGENT` 与 `DEFAULT_REDIRECT_LIMIT`，与导入/下载流程的 HTTP 客户端行为一致；
- 任何 HTTP 响应（1xx–5xx）都算 `reachable`，仅 transport 失败（DNS、连接、TLS、代理错误、超时）标记为 `timeout` / `unreachable`；
- 返回每个端点的状态码、耗时与当前生效代理，方便判断代理是否生效。

## 入口

- 桌面：设置 → 知识库诊断；远程 Vault 当前显示不可用。
- CLI：`edda doctor`、`edda doctor fix aliases`、`edda doctor fix visual-marks`、`edda doctor fix catalog-duplicates`、`edda -y doctor fix …`（CLI 诊断同样尊重 `.edda/doctor.json` 忽略列表）。
- Host：`doctor_check`、`doctor_apply_aliases`、`doctor_ignore_aliases`、`doctor_set_dirty_paths`、`doctor_plan_wikilinks`、`doctor_apply_wikilinks`、`doctor_apply_visual_marks`、`doctor_fix_catalog_duplicates`；host 级：`doctor_check_host`、`doctor_check_network`。

代码：`src-tauri/src/features/vault/doctor/`（聚合入口）、`src-tauri/src/features/markdown/wiki/doctor.rs`（双链修复）、`src-tauri/src/features/pdf/marks/doctor.rs`（视觉批注修复）、`src-tauri/src/features/agent/doctor.rs`（主机运行环境）、`src-tauri/src/features/system/network/`（网络连通性）、`src/lib/doctor/`、`src/components/settings/panes/doctor-pane.tsx`。
