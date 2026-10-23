# Dockview 文档工作区

中间栏由 **单一全局 Dockview** 管理全部打开文档；标题栏**无**文档 tab 条。

## 行为

状态更新保留引用语义：重复激活同一标签、原引用 tabs / LRU / 布局写回不触发 store 通知，减少 Dockview 同步与原生浏览生命周期订阅的无效工作。

| 场景 | 行为 |
|---|---|
| 打开文档 | 文件树 / Library / 命令面板 → `openTab` → `workspaceRef.openPanel` |
| 首篇 paper | 默认只开 PDF/HTML 正文；`autoOpenPaperNotes` 默认关闭，NOTES 可用 `⌘\` / 右键「打开笔记」按需展开。普通前台新 PDF 打开时进入阅读布局、收拢左右侧栏；显式分屏 / 打开笔记 / 已启用自动笔记的偏好不被覆盖 |
| 再开 paper | body 走自由 dock 放置（当前组 / 默认，可再拖分屏）；NOTES 优先叠进已有笔记列；body↔NOTES **焦点仍同步** |
| 同步关闭 | 关 paper body 时一并关 NOTES；关 NOTES 保留 body |
| 文件树拖入 | left/right/above/below/within 分屏落点 |
| 关 panel | dockview X → `closeTab`；焦点 `onDidActivePanelChange` |
| 循环 | `⌥⌘←/→` 按 `api.panels` **视觉序** |
| 移至新窗口 | 文档 tab **右键** → **移动至新窗口** → 独立 `doc-*` Webview；源 panel 关闭（Library / Trash 除外）；弹出窗自带 Vault watcher，Markdown 外部改盘就地重载；URL `mode` 参数与主窗口一致参与 PDF 模式保护（探测失败不降级 Markdown） |
| Split pane | `⌘\` / `Ctrl+\` 向右新增 pane；当前论文未开 NOTES 时默认打开 NOTES，否则复制当前 pane；横向 pane 重新等宽 |
| NOTES 开关 | Layout 菜单；优先叠右列 |
| 打开笔记 | 论文 tab 右键 /文件树论文行右键 → NOTES 进右侧阅读列（已开则聚焦；菜单显示 `⌘\` / `Ctrl+\`） |
| 关光文档 | 回到全库 Library panel |
| Agent 讨论 | 切换论文显示该论文自己的最近会话 / 新草稿；切回恢复，PDF 与同论文 NOTES 共用讨论 scope，详见 [agent-references.md](agent-references.md) |

标题栏 Layout 菜单提供 Agent 模式（PDF / Agent `1:1`）、笔记模式（PDF / Notes / Agent `1:1:1`）和阅读模式（关闭当前论文 Notes 分屏，收拢文件树与 Agent 侧栏）。侧栏可通过壳层按钮 / 快捷键重新展开；其它 PDF tab 保持打开。PDF 工具栏的「专注阅读」还会收起阅读器内的大纲 / 参考文献 / 版面解析 / 批注列，并恢复适合宽度。

标签组 chip 的颜色菜单会将展开/收起 icon 染为对应颜色，并同步用于组内 tab 的强调线；清除颜色后恢复默认颜色。

布局只存 dockview `toJSON()`；path/mode/title 在 panel params。同一路径可存在多个 split pane，panel id 保留 pane 实例后缀用于恢复布局。Tab 条上的论文标题经 `MathText` 渲染内联公式（`$\\pi$` 等）；`panel.api.setTitle` 仍存原始字符串。

启动恢复只 hydrate 每个 Dockview group 当前可见的 panel；隐藏标签在首次切换到前台时再读取资源。恢复出的占位 tab 直接用 params 里的 title 显示（论文名），无需等资源加载；未携带 title 的旧布局回退为文件夹名，激活后由资源加载刷新。PDFium 保留当前可见与最近使用的至多两个 PDF viewer，本地 PDF `ArrayBuffer` 离开保留集合后释放，避免多标签工作区重启时并发加载全部 PDF 并长期占用 WebContent 内存；重新 hydrate 既有 PDF tab 时只刷新资源，不因一次 PDF 探测失败降级成 Markdown 空编辑器；同一保护（`patchFromTabResources`）覆盖 ⇧⌘T 重开与文档弹出窗。资源侧论文正文只产出 pdf / html（`paperBodyMode`）：探测全空且 catalog bundle / 元数据也落空时先延迟重试一次（启动时 Host catalog 或 fs scope 未就绪的竞态），仍无资源则停在 PDF「暂无论文」空态，绝不渲染空 Markdown 编辑器；paper 文件夹内的子目录按 scoped library 打开，同样不进编辑器。Markdown 编辑器（含 NOTES）同样保活：至多两个最近使用的编辑器保持挂载，切换标签不再重建 Plate；离开保留集合的编辑器卸载为占位，切回时重新反序列化，卸载时未落盘的编辑会照常 flush。

## 面板类型

Library · Trash · PDF · HTML · 图片 · Markdown · 论文 NOTES。

## Library 与广场响应式页面

- 原生 Library / 论文池的断点跟随当前面板而不是整个窗口。Library 按测得的面板宽度隐藏次要列、
  窄于 `48rem` 时换成两行列表（见 [library.md](library.md)）；论文池使用命名容器 `paper-page`，
  `src/styles/paper-pages.css` 在小于 `48rem` 时将同一条虚拟表格行改为分组布局。行高由 virtualizer 测量。
- 论文池搜索在窄面板换行，详情 / 存储地址弹窗使用动态视口高度、内部滚动与最小宽度约束。
- Skill 管理使用 `skills` 容器；精选卡片按面板宽度采用 1 / 2 / 3 列（`42rem` / `64rem`），
  工具栏可换行，长知识库名和说明不撑宽面板。
- Cool Papers / ModelScope 的 iframe 始终占满面板，让站点 media query 使用 iframe 自身宽度。
  ModelScope 站点把页面钉在 1280px（根节点 min-width、布局固定宽度），代理在任意宽度都解除，
  并补 20px 左右留白；标题与搜索同行时搜索让宽、放不下整体换行，Tab 栏标签不折行，
  详情页「相关模型」列在窄时落到阅读区下方。代理还标记论文卡片、搜索及详情操作行的祖先容器，
  在 `56rem` 以下改为单列并解除网格列数和 flex-basis；搜索框不因 Ant Design 的 table / affix 布局溢出。
  标记基于论文链接 / arXiv 图标 / `ms-page-*` 等结构，不匹配站点的动态哈希类名。
  站点运行时插入的协议相对 URL（`//at.alicdn.com` 图标 sprite、`//resouces…` 封面图）
  在桥接脚本里改写为 `https:`，否则会解析到代理 scheme 下失效。
- 页面断点与间距使用 rem；弹窗依据所属窗口可用空间布局。验证覆盖桌面、分屏、窄屏、
  125% 字号、长标题 / 标签，以及虚拟列表滚动到末项。站点上游 DOM 改版后仍需复核代理适配。

## 代码

| 路径 | 职责 |
|---|---|
| `src/components/workspace/dock-workspace.tsx` | Dockview 宿主（tab 右键 → 移至新窗口） |
| `src/lib/shell/leaf.ts` | leaf 打开 / `moveDocToWindow` |
| `src/lib/shell/doc-window.ts` | `doc_window_open` 前端封装 |
| `src/components/shell/doc-window-root.tsx` | 文档弹出窗根 |
| `src/lib/workspace/store.ts` | tabs / active / dockLayout |
| `src/lib/workspace/tabs/` | DocTab 模型、NOTES 分屏、持久化 |
| `src/lib/workspace/dock-registry.ts` | 命令式 dockview 句柄 |

PDF 分屏拖动性能：见 `docs/bug_fix/dockview-sash-pdf-resize-jank.md`。
