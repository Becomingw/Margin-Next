# 审阅后续（未实现）

审阅工作区的第一轮已落地：`reviews/` 命名空间、划词批注、回复 / 解决 / 删除、锚点重定位、修订事件、checkpoint、Changes 视图与导出（见 [../backend/review.md](../backend/review.md)、[../frontend/review.md](../frontend/review.md)）。以下是明确推迟的部分，按优先级排列。

## P1：审阅稿的引用回流（阅读 → 审阅）

用户的核心场景：在阅读 `papers/` 中的文献时，把某段行文或某张图搬进正在审阅的稿件。

- **引一句**：`papers/` 的阅读标签上，划词菜单增加「引用到审阅稿」，选择目标 `reviews/<id>/manuscript.md`，在光标处插入带页码的双链（`[[papers/…/NOTES#page=N|…]]`）。
- **引一张图**：复用视觉批注（`marks/<id>.json` + `assets/<id>.png`），嵌入到 `reviews/<id>/assets/` 后以 `![[…]]` 引用。
- 前提：`papers/` 的引用语法已存在（双链与 `#page=` 片段），只需补入口，不需要新协议。

## P1：Agent 审阅

- 已新增 `edda-paper-reviewer` skill（与只读问答的 `paper-qa` 分开，避免 Agent 混淆「问这篇论文」与「改这份稿件」）。
- Skill 引导 Agent 根据用户意图选择新增批注或直接通过 `review_manuscript_replace` 改写正文；两者均记录 AI 来源，正文写入不确认基线。

## P2：PDF 侧审阅

- `reviews/<id>/manuscript.pdf`（参考件）可打开、划词；划词产出写入 `review.json` 的评论（锚点为 `pageIndex + quote`），**不写 `marks/annotations.json`**。
- 与 md 审阅线并列，不做跨格式映射（md ↔ PDF 的坐标映射代价过高）。
- 审阅列在 PDF 标签上以同一卡片形式出现，但锚点用页码。

## P2：MCP 与外部读取（已落地）

- 已提供只读 `review_list`、`review_read`（含完整批注回复）、`review_changes`（基线至当前的分页差异）、`review_edit_history`（来源事件）、`review_manuscript`；与 `paper_*` 分开命名，避免 Agent 把审阅稿当文献引用。
- 已提供创建 / 导入 / PDF 解析 / 重命名、AI 批注及正文精确替换、导出等 MCP 工具；不提供基线确认。AI 正文修改直接生效，按哈希校验避免覆盖已变化的磁盘稿件。

## P3：体验与边界

- 窄面板已有底部独立滚动审阅栏，仍需用真实长稿、密集批注及 PDF 双栏进一步验证。
- 表格单元格、代码块、脚注内的划词批注。
- 列表项内的块 id 完整解析（当前只在末行可靠）。
- 单元重命名 / 删除的 UI 入口（目前可用文件树的通用重命名与回收站）。
- 行内修订已使用语义 token（`review-insert` / `review-delete`），作者颜色与修改类型分离；Wiki 行级 diff 的颜色不在本轮范围内。

## 明确不做

- 多人实时协同、分支合并：`review.json` 不做冲突合并。
- 审阅包 ZIP 格式：导出为普通目录已足够，且与「一切都是可读 Markdown」的原则一致。
- 审阅稿转为 `papers/` 论文：审阅稿与阅读文献的生命周期不同，永不转换。
