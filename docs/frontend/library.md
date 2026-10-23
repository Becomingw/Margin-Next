# 论文库 Library

中间栏 catalog 表格；数据一次 `paper_list` 进内存。Library 是论文分类与管理主入口，`papers/` 是平级文件存储。

## 外观

- 画布用 `bg-background`（与侧栏 `bg-sidebar` 分层）；表头 sticky 半透明 + `backdrop-blur`（滚动边缘用 soft shadow，非硬分割线）；行间 hairline `border-border/40`，悬停 `accent` 浅洗。
- 配色跟默认主题 token，见 [settings.md](settings.md)「主题」。

## 视图

- **面板响应式**：以 Library 面板宽度为准（`libraryLayout`，`library-row-utils.ts`），按优先级先藏次要列：低于 `68rem` 收起标识符、`60rem` 收起被引量、`52rem` 收起出版物；列偏好本身不被改写，面板变宽即恢复。低于 `48rem` 改为两行列表：标题最多两行（带阅读热度），第二行灰色显示作者 · 年份 · 出版物和前两个标签（多出的显示 `+N`）；空字段不显示，不用「—」占位。
- 列表模式表头收成一行工具栏：搜索、添加、排序下拉（当前列 + 方向，点同一列切换方向）、刷新元数据、期刊分区与标签筛选；右键仍可自定义列。表格模式下标签同样只占一行。两种模式共用同一组虚拟行、右键菜单与点击打开，切换时重新测量行高。

- 虚拟路径 `edda:library`（不写盘）。
- **全库**：点 Library 节点或关光文档后默认页。
- **分类**：使用标签、标题搜索和排序。点击 Papers 打开全库；新论文统一保存到 `papers/<id>/`，不再按树选择创建分类子目录。历史路径筛选 helper 仅保留兼容读取。
- **非 papers 目录**（`notes/`、`.agents/`、`plans/` 等）：不进入文件夹作用域，Library 显示全库（#160）。
- 外部 CLI / 同步工具改动 `.edda/catalog.sqlite` 或 `papers/` 结构时，前端会后台去抖重新 `paper_list`，同步 Library 表格与文件树论文标题。
- NOTES 可按需打开；Paper Info 保留最近选中的论文，切换到非论文文档时仍显示。

## 手动文献与 PDF

- 标题表头的 **＋** 打开「添加文献」，复用元数据编辑表单。标题必填，作者、年份、刊物、DOI/arXiv 和摘要可补充；年份校验与编辑一致。保存只创建 Catalog 行、`metadata.json` 和 NOTES 壳，不下载 PDF，也不启动 Agent 精读。同标识符的已存在条目不重复创建。
- 标题前的文档图标表示资源状态：红色文档为已有主 PDF，灰色空文档为无主 PDF，tooltip / accessible label 同步状态。未探测的远程条目不冒充无 PDF。附件或 TeX 插图 PDF 不算主 PDF。
- 右键指定行 → **添加 PDF… / 替换 PDF…**，选择本地文件，直接绑定该 Catalog 路径，保留用户元数据；不走文件名识别或另建论文。文件选择取消或期间切库不写入。
- 替换前校验、暂存；旧 PDF、`PAPER.md`、source、marks、images 和旧版 annotations 文件备份到 `.edda/pdf-backups/<uuid>/`，NOTES 与其 assets 保留。清除正文来源和页数缓存，刷新已打开 PDF viewer，重新安排正文、版面和引用解析。旧 viewer 的迟到高亮写入不能覆盖新 PDF 标注；失败恢复现有 writer。
- 本地后台任务尚未结束时暂不替换，防止旧解析任务写回新文件；脏论文文档须先保存。错误用 Toast。

## 论文代码仓库

本地论文行右键 → **代码仓库**。按需从已解析正文发现公开 GitHub / GitLab 候选，列表仅显示
仓库地址和打开 / 下载操作，不展示原文上下文或文件出处；也可手动输入仓库地址。用户点击下载才获取默认分支源码，保存为该论文
`code/` 中的只读快照，包含来源、commit 和导入时间，不保留 `.git`。

已保存资产可筛选文件并只读浏览、显示源码目录、整份移入回收站。不会运行代码或安装依赖；
切库不让迟到响应污染新论文。错误使用 Toast，正在保存时禁用重复操作。
远程 Vault 暂隐藏入口。后端格式、限额和后续见 [源码快照](../backend/paper-code.md)。

## 旧库升级

本地 Vault 打开时先自动平铺已有嵌套论文，再刷新树和调度后台任务。旧分类路径段转成标签；同名目标用数字后缀避让。迁移复用 Wiki rename 事务，同步 Catalog 路径、页数缓存和双链；脏链接源拒绝迁移，下次打开可重试。路径日志 `.edda/flat-papers.json` 用于恢复已保存的工作区路径。

分类目录中剩余说明文件迁入 `notes/paper-collections/`（同样修复链接）；只删除空分类目录。PDF 不属于识别论文的必要条件，metadata-only 条目也会迁移。论文路径对应的历史归属、最近对话指针、输入草稿和引用附件缓存同时迁移；保留删除标记、原始对话正文和其它 Vault 的缓存，重复打开不会覆盖目标路径下的新草稿。

## 表格能力

| 能力 | 说明 |
|---|---|
| 排序 | 表头点击；排序/标签筛选变化时行区 150ms 淡入提示重排（搜索键入不触发） |
| 列 | 表头右键选列 / 拖拽排序；拖动表头右缘调列宽（与右邻列互让宽度，表格始终铺满面板；双击边缘恢复默认，聚焦后可用 ←/→ 微调），列宽以相对权重 `width` 存储；顺序、显隐与列宽持久化 `libraryColumns`（Rust 与前端的列键清单须一致）；标题列不可隐藏；标题单元格对 `$...$` / `\\(...\\)` 做 KaTeX 内联渲染（复制仍为原始 TeX） |
| 滚动 | 横向 + 纵向；滚动中表头控件瞬间隐藏为纯列名（搜索框与刷新/筛选等图标，固定 `h-9` 行高与占位不变；当前排序列仍保留方向箭头；有标签筛选时 Tags 列名旁留小圆点），停滚约 450ms 后淡入恢复（入 300ms） |
| tags | 染色 chip；搜索框匹配用户标签子串；`@zotero:` / `@arxiv:` 内部标签不显示 |
| 阅读热力 | 标题列左侧显示该论文阅读进度热力条；基于 `marks/` 中逐页标注与阅读位置聚合。激活 Library 时经 `paper_reading_activity_batch` 一次批量 IPC 刷新全部活动点（缓存保温，不再逐论文 3 次 IPC）；PDF 页数走 catalog `pdf_page_counts` 缓存，缺缓存时仅对可视行懒加载并回写 |
| Rescan | `paper_rescan`：盘上有、catalog 无则补齐 |
| 行右键 | 打开 / 编辑元数据（远程 Vault 隐藏编辑项）/ 添加到对话 / 在 Finder 中显示（仅本地）/ 删除→回收站；单击打开、双击复制 |
| Download | 库内任一篇缺资源时批量补下 |
| 导入/导出 | Library 工具栏；导出 BibTeX 亦可在 Library 节点右键 |
| 发现引用 | Library 节点右键「发现引用我的新论文」→ 后台扫描全库反向引用 → 候选清单勾选入库；见 [../backend/citation-parsing.md](../backend/citation-parsing.md) §7 |
| 拖入 PDF | Finder / 其它 App 把一个或多个 PDF 拖到 Library 表：虚线 overlay（仅 PDF），松手后后台导入到 `papers/`；识别、重命名和版面分析继续。为已有条目补文件应使用右键添加 PDF |

## Tags（前端）

- Paper Info 增删 + Apple 8 色色盘 → `paper_set_tags`。
- 配置 EasyScholar Key 后，Library 表头 Tags 列的筛选按钮左侧显示奖牌图标，点击后会为当前 Library 范围内的全部论文拉取期刊分区、影响因子、JCI 等数据并生成 `#easyscholar:` 命名空间标签；重复获取会替换该命名空间标签，不影响用户普通标签。
- `@zotero:` 前缀标签属于 Connector 来源标记，只保留在 catalog 中，不参与展示、搜索和筛选；编辑普通标签时会保留这些内部标签。
- arXiv 入库带来的学科分类（如 `Computer Science - Machine Learning`）以 `@arxiv:` 前缀保存为隐标签，同样不参与展示、搜索和筛选；已入库、尚未加前缀的同形标签也按隐标签处理。
- 标签类型与语义（normalize / coerce / 可见性）：`src/lib/paper/tags.ts`（类型在 `src/lib/paper/types.ts`）；色板映射：`src/lib/ui/tag-colors.ts`。
- CLI 标签见 [../backend/catalog.md](../backend/catalog.md)。

## 编辑元数据

误识别/缺失的论文元数据可手动修正，三个入口共享同一对话框（`edit-paper-meta-dialog.tsx`，挂在 `app-dialogs.tsx`，经 `libraryStore.editMetaDraft` 打开）：

- Paper Info 面板头部铅笔按钮；
- Library 表格行右键"编辑元数据"；
- 文件树论文行右键"编辑元数据"。

核心字段（标题/作者/年份/DOI/arXiv/期刊）直接展示，卷期页、出版社、摘要、URL 折叠在"更多字段"。作者每行一位；仅提交变更字段（patch）→ `paper_update_meta` → 返回行原地同步 Library 表与所有打开 tab（`paperMetaChange`）。远程 Vault 暂不支持，入口隐藏。后端语义见 [../backend/catalog.md](../backend/catalog.md)。

DOI 旁有 **刷新** 按钮：按当前 DOI（或 arXiv ID）拉取权威元数据（`paper_resolve_identifier` → Translator/Crossref/arXiv Atom，再用 S2 `publicationVenue` 补期刊/会议名），只填充表单供确认，保存仍走 patch。venue 源优先级见 [../backend/academic-search-apis.md](../backend/academic-search-apis.md) §2.5。

## 导入 PDF 识别

拖入/魔棒导入 PDF 直接进入后台导入任务，无确认对话框；识别链路（liteparse probe → Zotero recognizer → 标识符解析，见 [../backend/paper-import.md](../backend/paper-import.md)）在导入任务内自动补全：

- 识别成功自动填充 标题/作者/年份/DOI/arXiv ID，文件夹 id 按 arXiv ID → DOI slug → 文件名 slug 自动派生；
- 识别失败静默回退文件名派生元数据，用户在 Edit Metadata 中修正（DOI 旁刷新按钮拉取权威元数据）。

## 代码

新管理入口：`src/lib/paper/management.ts`、Host `features/paper/catalog/management.rs`；共享内核 `edda-core` 的 `paper/import/manage.rs` 和 `vault/flat_papers.rs`。

- UI：`src/components/library/`（拖入：`library-pdf-drop-surface.tsx`）
- 状态：`src/lib/paper/library-store.ts`、`library-actions.ts`、`import-actions.ts`（`dropLocalPdfs`）
- 单测：`test/library-scope.test.ts`、`test/prompt-image.test.ts`（`dataTransferLooksLikePdfs`）

## 后续

- 远程 Vault 的指定条目 PDF 附加与自动目录迁移。
- PDF 替换目前主动重载发起操作窗口；其他窗口中已打开的同篇 PDF 应重新打开，跨窗口写入协作仍需后续统一。
