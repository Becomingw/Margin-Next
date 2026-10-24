# 开发草稿

Margin fork 的当前实现和剩余拆分范围见 [独立审阅说明](../margin.md)。下面是保留的上游 Edda 规划，不自动纳入 Margin 范围。
Margin 的事务版本 / 提案内核已实现，契约与未实现边界见 [后端文档](../backend/margin.md)。
当前收敛到 [单 AI + 人 checkpoint](../margin-single-ai.md)，多 AI / 自动合并暂缓。
独立 Windows 预览的版本、打包、安全边界与人工发布门禁见 [release.md](release.md)。

本目录只放：

1. **工程规划**（版本切片、发布）
2. **尚未实现**的功能设计稿

已实现功能的说明在 [`../frontend/`](../frontend/index.md) 与 [`../backend/`](../backend/index.md)，按功能分篇。

## 未实现草稿

工作台视觉与通用交互呈现已统一：主题表面、浮层层次、稳定按压、键盘焦点及设置窄屏布局，
实现约定见 [前端组件](../frontend/components.md#工作台视觉与反馈)。业务流程与窗口控制的架构规划仍按下表跟踪。

Library 的论文源码发现与只读仓库快照已落地；远程 Vault、私有仓库、自托管站点和
项目主页二次发现列于 [源码快照的限制与后续](../backend/paper-code.md#限制与后续)。

| 文档 | 主题 |
|---|---|
| [lifecycle-events.md](lifecycle-events.md) | 生命周期事件系统：语义事件 + 注册式 handler，统一事件命名规范。**已落地**，保留为设计记录（scoped 事件与 teardown 语义、为何不需要 `vault:closed`、为何 `app:will-quit` 延后） |
| [browse.md](browse.md) | **浏览（设计稿 v2）**：广场改为可添加任意网站的「浏览」；原生子 WebView + 持久登录；页面感知；站点适配器；`site-layout` / `site-import` Skill |
| [developer-mode.md](developer-mode.md) | **系统预设只读与开发者模式（设计稿）**：预设 Skill / 插件 / 适配器不可删改，开发者模式下才可改 |
| [plaza.md](plaza.md) | 广场（Cool Papers / ModelScope 论文 / 推荐 / 播客）。**壳 + 两个站点来源浏览与入库已落地**（现为浏览的原生视图 + 预设适配器，见 [browse.md](browse.md)）；推荐 / 播客仍为草稿 |
| [plaza-feeds.md](plaza-feeds.md) | 广场订阅历史设计，**已退役**；由外部 Agent 冷存储论文池承接推荐收集 |
| [usage-analytics.md](usage-analytics.md) | \#239 Activity 总线。P0 存储已落地：XDG `usage.sqlite`（见 [../backend/usage.md](../backend/usage.md)） |
| [zotero-word-integration.md](zotero-word-integration.md) | 官方 Zotero Word 插件 provider 兼容、文档迁移与平台实现评估 |
| [cloud-sync-s3.md](cloud-sync-s3.md) | 云同步（S3 兼容）：catalog sidecar 化前置 + 内容寻址 blob/manifest/CAS 同步引擎。**Phase 0–1 已落地**（见 [../backend/sync.md](../backend/sync.md)）；自动同步 / GC / E2EE / 官方托管仍为草稿 |
| [mark-cli-roadmap.md](mark-cli-roadmap.md) | \#170 历史设计；业务 CLI 已退役，标注通过共享服务与 [MCP](../backend/mcp.md) 提供 |
| [mark-locate-lazy.md](mark-locate-lazy.md) | 文字定位：打开 PDF 再算（惰性，默认主路径） |
| [import-api-abstraction.md](import-api-abstraction.md) | Import 学术 API 抽象层：统一论文元数据、期刊指标、PDF URL 与题录批处理的 trait 与数据结构。**已落地**（`crates/edda-core` 的 `features/paper/scholar_api/`），保留为设计记录 + 论文元数据重构的剩余缺口清单（`citation_count` 入库断点、`status`/`body_source` enum 化代价、`PaperTag` 生成契约） |
| [mark-locate-eager.md](mark-locate-eager.md) | 文字定位：标注时算（即时 B1 viewer / 可选 B2 headless） |
| [crate-split-roadmap.md](crate-split-roadmap.md) | edda-core crate 拆分路线：Phase 1/2 已落地（基座 + CLI 数据域迁入、`HostHooks` 事件抽象、CLI 脱离 `edda_lib`）；留守域耦合清单与 Phase 3 建议 |
| [agent-dx.md](agent-dx.md) | Agent DX：ops 自省 / MCP 对齐 / Skill 削薄。Phase 2 + 精简 3 + 4 已落地；dry-run 与更多 MCP tools 仍为后续 |
| [rust-arch-refactor.md](rust-arch-refactor.md) | Rust 架构重构计划（2026-09-08 更新）：共享业务用例、提交与恢复、Vault 派生状态、论文准备/共享提取、任务生命周期、Agent 上下文六条主线；含前置正确性修复、依赖与验收、旧任务归并及历史裁决。实施未开始 |
| [rename-edda.md](rename-edda.md) | 更名 Edda：全仓改名清单（持久化 / 分发 / 内部三级）、Vault 与全局目录迁移、WebView 状态桥接、更新器切换与上游切割。**代码已完成**，桥接版本与首个 Edda 发布待办见 §八 |
| [review-performance.md](review-performance.md) | 审阅与长文档编辑的渲染、刷新与交互底层优化：实测基线（自动保存整篇序列化、整篇替换重载、分块未生效）、分阶段方案与业内做法对照。阶段 1.1–1.2（增量序列化）、2.1（外部写入按块应用）与 3.1（分块渲染）已落地，其余为设计稿 |
| [review-storage.md](review-storage.md) | 审阅存储的稳定性与性能：基线实测（`review.json` 体积构成、各操作耗时、并发写丢失）与分阶段方案，坚持文件存储。阶段 1–4（写锁、原子刷盘、备份恢复；正文保存进锁；只传变化；编辑分段记录、不存基线副本）已落地 |
| [review-followups.md](review-followups.md) | 审阅工作区后续（引用回流、Agent 审阅建议、PDF 侧审阅、体验边界）。MCP 审阅读写已落地，基线确认只在 UI，见 [backend/review.md](../backend/review.md) |
| [zhihu.md](zhihu.md) | 知乎开放平台集成：统一 CLI 后端（探测/一键安装/Keychain 凭证）+ 知乎虚拟 Agent（builtin ACP 适配 + 直答大脑）+ 广场知乎面板 + 论文找讨论 / 划词插引用。设计稿，实施未开始 |

macOS 签名与公证（已实现流程说明）在 [`../bug_fix/macos-signing.md`](../bug_fix/macos-signing.md)。

论文管理已收敛为 Library + 标签 + 平级文件存储，手动题录与指定 PDF 添加/替换已落地。[冷存储论文池](../backend/paper-pool.md) 已支持目录/静态 JSON、MCP 提交和审阅入库。业务 CLI 已移除，应用运行时开放 MCP，内部保持 BYOA/ACP；后续项见 [Agent DX](agent-dx.md)。

本目录没有单独的 Roadmap / TODO 文件：未决项按能力记在对应已实现文档的「限制与后续」里。内置 provider（翻译 / 正文 OCR）的未决清单——`⟦n⟧` 占位符透传待真实 key 验证、Hunyuan-MT 模板空格待 A/B、目标语言从 en/zh-CN 扩到 37 种、把内嵌 key 换成网关签发的 per-install activation token——在 [`../backend/builtin-provider.md`](../backend/builtin-provider.md) §限制与后续。
