# Doctor 全选修复后，双链问题数不变

## 复现与根因

DE-CLIP 笔记中的 PDF 引用被报告为 43 条 `invalidFragment`：例如
`[Section 2.2](paper.pdf#section=2.2)`、`[Figure 2](paper.pdf#figure=2)` 和 `#page=1`。
文件均存在，但 Wiki resolver 把这些阅读器参数当成 Markdown heading，在 PDF 的空 headings 中查询，
因此全部误报。探测器无法找到“正确标题”，就产生原文与替换完全相同的手动候选。

前端「全选」又把未编辑的手动候选一起选中；后端原样重写文件，并把文件列入 `updatedPaths`。
结果是用户看到成功提示，实际链接未变，下一次诊断仍有相同问题。

## 修复

- PDF 引用参数按现有阅读器协议验证，不冒充 Markdown 标题；继续检查目标文件及非法参数。
  具体页码 / 图表存在性由阅读器定位时校验。前端 fallback 与 Rust 使用同样的语义。
- UI 选择、全选和提交共用实际修改判定；未编辑手动项禁选并给出提示。预览可重新探测。
- 后端在既有 dirty/hash/range 校验之后跳过内容不变的文件；零写入不再显示修复成功。
- 报告更新关闭旧确认框，按 Vault 为修复 section 隔离本地预览状态。

## 验证

- 当前知识库只读诊断：修复前 resolved=7 / invalidFragment=43；修复后 resolved=50 / issues=[]。
  验证没有执行实际笔记修复。
- Rust 回归覆盖 PDF 参数、缺失文件、普通 Markdown 无效标题、非法页码、未编辑手动项不写入、
  混合批次只写真正改变的文件，以及正常路径 / 标题修复。
- 前端与 Rust 共用 semantic fixture；前端测试锁定全选 / 提交排除占位项。
- 浏览器验证自动项 + 未修改手动项的「探测 → 全选 → 确认」只发送一条实际修改，刷新后保留待人工处理的问题。
