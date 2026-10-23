# Vault 数据模型

事实来源分层：

| 数据 | 权威 |
|---|---|
| 笔记、PDF、TeX、marks | Vault 普通文件 |
| 论文集合与结构化 metadata | `.edda/catalog.sqlite`（权威字段同步投影到 `papers/<id>/metadata.json` sidecar，rescan 可据此重建，见 [sync.md](sync.md)） |
| 本机使用记录 | XDG `$XDG_DATA_HOME/edda/usage.sqlite`（非 Vault） |
| 双链索引 | 由 Markdown 重建（不落业务库） |

`PAPERS.md` / `library.bib` **不**默认生成；需要时导出。

## 根目录

```text
Vault/
├── AGENTS.md
├── papers/
├── notes/
├── reviews/          # 审阅工作区：在产稿件（与 papers/ 并列，永不互转）
├── .agents/skills/
└── .edda/
    ├── catalog.sqlite
    ├── doctor.json     # 可选：Doctor 忽略列表等 Vault 本地偏好
    └── .trash/
```

## Paper 单元

论文目录统一平铺在 `papers/` 下；分类使用 Catalog 标签。旧本地 Vault 打开时自动迁移嵌套论文，分类名转标签，路径和双链同步更新；分类说明文件保留到 `notes/paper-collections/`。手动创建文献无需 PDF。

```text
papers/<id>/
├── NOTES.md          # 人/Agent 笔记
├── metadata.json     # catalog 行的 sidecar 投影（PaperRecord JSON）
├── <id>.pdf          # 可选
├── marks/            # 高亮/批注/提问/翻译 JSON 与 mark 自有资产
├── source/           # TeX 等（可懒加载）
│   ├── edda-cite.json  # 参考文献 sidecar（可重建，见 api.md paper_refs_parse）
│   ├── layout.json         # PDF 版面 raw sidecar（可重建；merge/filter 可重复）
│   └── layout-index.json   # 侧栏同构索引（CLI/Agent；post-merge figure/table/…）
├── PAPER.md          # 无 TeX 时的派生正文（本地 liteparse 或云端引擎，见 paper-import.md § 正文解析引擎）
├── assets/           # NOTES 内嵌图等
├── code/             # Library 管理的只读源码快照，含来源清单与 files/，无 .git
└── attachments/      # 可选：用户支撑材料（supplement 等）
```

`metadata.json` 不是独立 schema：它就是 `PaperRecord`（catalog 行 / sidecar / IPC 出参共用的唯一论文模型）的 pretty JSON 投影，每次 catalog upsert 重写，`paper_rescan` 可据此重建丢失的行。列词表与归一化行为见 [catalog.md](catalog.md)。

`attachments/` **不**在入库时预建空目录。仅当其中有文件时，文件树论文行才显示 chevron，并把该目录的子项直接挂在论文下（桶本身不占一行）。`source/`、`marks/`、`assets/`、主 PDF、`NOTES.md`、`PAPER.md`、`metadata.json` 仍不进入树。

`layout-index.json` 与侧栏 Figures 同源（merge + score/NMS 后），供 `edda layout list` / `mark add --region` 使用；**可从** `layout.json` 重算，分析完成或缓存命中时由桌面写入。详见 [../frontend/pdf-layout-analysis.md](../frontend/pdf-layout-analysis.md)。

论文源码快照属于普通文件资产，随论文目录移动、同步与回收；具体结构与发现 / 下载流程见
[paper-code.md](paper-code.md)。`code/` 不参与主 PDF / TeX 判定、Wiki 改链或独立论文识别。

## 审阅单元 reviews/

`reviews/<id>/` 不是 Paper 单元：不进 catalog、不拉元信息、不转为论文。结构与语义见 [review.md](review.md)。

```text
reviews/<id>/
├── manuscript.md        # 待审阅正文
├── review.json          # 修订链 / 评论 / 事件（唯一审阅真源）
├── revisions/<rev>.md   # checkpoint 快照
└── assets/              # 正文内嵌图
```

## marks/

- 高亮/批注：`annotations.json`（含 `contents` 的为批注）。桌面划词与 CLI（`mark add --quote` / `--region`）都写这里；CLI 按 annotation id 去重后原子替换，阅读器监听外部变更增量导入。历史 per-id `kind: highlight` mark 仍可读（Doctor / 首次打开时投影）
- 提问/翻译：`<id>.json`（`kind`）；CLI 可用 `mark add --region … --question` 写 `ask` 壳
  - 桌面新建的划词翻译仅在阅读会话内存中，固定 / 移动 / 调整大小不落盘；只有「转为备注」才写 `annotations.json` 的高亮 + `contents`。历史 / CLI 的 `kind: translate` 文件仍兼容读取。
- 视觉批注：`<id>.json`（`kind: visual` v2）保存区域、用户 `comment`、可选嵌套 `agent` 与 `image.path`；裁剪图片位于 `assets/<id>.png`。旧版 `kind: agent-trace`（扁平 agent 字段）仍可读，Doctor 可迁移
- 不写 PDF 二进制，不强制写入 NOTES

```text
marks/
├── annotations.json
├── <id>.json
└── assets/
    └── <agent-trace-id>.png
```

`marks/assets/` 由 mark 拥有，删除视觉批注时同步删除对应图片。列表与轮询只解析 JSON；悬浮预览、打开 Agent 或 Wiki 嵌入需要图片时才读取二进制。该目录与 Paper 单元根部供 `NOTES.md` 引用的 `assets/` 分开。

## Markdown 内嵌图

`{mdDir}/assets/` + 相对路径 `![](./assets/…)`；前端 GC 无引用文件。

## 远程

逻辑模型相同；物理 IO 为 SFTP，catalog 有 work mirror。见 [remote.md](remote.md)。

## 类型

时间戳 ISO 8601 字符串。运行时 TS/Rust 类型以代码与 [api.md](api.md) 为准。  
Catalog 列定义：[catalog.md](catalog.md)。
