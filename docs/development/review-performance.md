# 审阅与长文档编辑：渲染、刷新与交互的底层优化（设计稿）

状态：设计稿，分阶段实施中。阶段 1.1、1.2（增量序列化）、2.1（外部写入按块应用）与 3.1（分块渲染）已落地。目标是让 3 万字级稿件、上百条批注、多个 Agent 同时写入时，编辑、滚动、缩放和刷新都保持流畅。

## 一、现状实测（2026-10-20）

样本：真实稿件 RACER（79k 字符 Markdown，287 个顶层块），另加到 66 条批注。数据来自隔离测试版（WKWebView）；标注「Node」的为 Node 中的纯计算计时，插件集合不完整，只作量级参考。

| 环节 | 耗时 | 触发时机 |
|---|---|---|
| Markdown 整篇序列化 | **200–310 ms / 次，每次自动保存两次，合计 ≈0.47–0.57 s**（应用内实测） | 停止输入 0.5 s 后：写盘前一次、写盘后核对一次 |
| Markdown 整篇反序列化 | ≈180 ms（Node） | 打开、外部写入（Agent 改稿）后重载 |
| 外部写入重载 | 反序列化 + `replaceNodes` 整篇 + 全部节点重渲染；应用内实测 3–7 s，之后视图跳走（2.1 之后 4–9 ms） | 每次 Agent 改稿或外部编辑 |
| 修订对齐与批注定位（冷） | ≈220 ms（Node） | 打开；段落 diff 有缓存，之后的增量很快 |
| 界面缩放 100%→90% | ≈480 ms（原 ≈650 ms，已去掉 React 重渲染） | 每次缩放：整篇重排 |
| 跳到未绘制区域 | 单帧 ≈150–190 ms | 拖动滚动条、快速翻页 |
| 单段序列化 | ≈0.5 ms（Node） | — |

结论：

1. **编辑时最大的卡顿来自自动保存**：每次停顿后主线程被整篇序列化占用约 0.5 s，正好撞上继续输入。批注、修订的计算不是主因。
2. **外部写入走「整篇替换」**：反序列化、替换全部节点、全部重渲染、修订重算一样不少，而 Agent 往往只改了一段。
3. **排版与绘制按整篇做**：Plate 默认开着分块（`ChunkingPlugin`，`chunkSize: 1000`），但几百个块的文档只有一块，而这一块永远在屏幕上，`content-visibility: auto` 什么都跳不过；Plate 也没设 `contain-intrinsic-size`。所以缩放和窗口变化要重排全部内容，滚动到新区域要一次画完一整屏。
4. **批注栏全量渲染、全量测量**：卡片数量随批注线性增长，位置用 `getClientRects` 逐条读取。

## 二、设计原则

- **按块增量**：文档是块的序列，未改动的块（对象身份不变）不重算、不重渲、不重序列化。所有派生数据（Markdown、修订、批注位置）都以块为缓存单位。
- **主线程只做交互**：纯计算（整篇 diff、序列化兜底、对齐）放进 Web Worker 或空闲时间分片；任何单个任务不超过 50 ms。
- **只画看得见的**：屏幕外的块跳过排版与绘制；批注栏只渲染视口附近的卡片。
- **变化以操作传播**：外部写入转成最小的块级编辑操作，批注范围、修订缓存、滚动位置和选区随操作映射，而不是推倒重来。
- **先测量后优化**：每一项都有基准数据和回归测试。

## 三、分阶段方案

（业内做法对照与各项依据见第四节。）

### 阶段 0：性能基线与回归保护

- 把本次排查用的帧时间探针做成开发者模式开关（滚动、缩放、输入时记录帧时长和长任务），日志落到应用日志。
- 在 `test/` 增加基准：整篇 / 增量序列化、反序列化、修订对齐，用仓库内的大样本文档；超过阈值即失败。

### 阶段 1：保存与计算移出关键路径

1. **增量 Markdown 序列化**（**已落地**，见 [frontend/markdown.md](../frontend/markdown.md)；应用内实测每次保存从 ≈0.5 s 降到 1–3 ms，打开后第一次保存借预热也只要 ≈2 ms）：按顶层块缓存序列化结果（`WeakMap<节点, 文本>`），连续列表项作为一段一起序列化，拼接得到整篇。保存时只重新序列化改动的段。可行性：RACER、README、AGENTS.md 按段拼接与整篇序列化逐字节一致；需在真实编辑器插件集合下（列表、双链等）跑全量对照测试，不一致的块类型并段或回退整篇。目标：自动保存 ≈0.5 s → 个位数毫秒。
2. **保存后的核对改用同一缓存**，不再整篇序列化第二次（**已落地**）。
3. **修订对齐增量化并移出主线程**：块按内容哈希做 LCS（几百个块很便宜），段落 token diff 以「基线哈希 + 当前哈希」为键缓存，只重算脏块；未变的块返回同一个装饰数组，slate-react 就跳过它们的重渲染（slate-react 0.116 起按节点比较装饰）。打开时的整篇对齐放进 Worker（VS Code、@codemirror/merge 的做法），正在输入的段落仍在主线程即时计算。

### 阶段 2：增量刷新

1. **外部写入转为最小块级操作**（**已落地**，见 [frontend/markdown.md](../frontend/markdown.md) 数据流。改动的块整块替换而不做块内文字操作：Agent 改写引文时 Host 的 `follow_rewrite` 会把引文扩到改写后的文字，块内移动的 range 只会收缩，整块替换让这些批注按 Agent 更新后的引文重新定位。插件规范化（表格单元格、列表编号）让新解析的块与编辑器里的同一块不再相等，所以按节点记住它来自哪次解析）：新旧文档按顶层块的内容哈希对齐（参考 CoCalc slate-diff 的思路：每个块映射成一个字符再做序列 diff；其许可证为 MS-RSL，只借鉴思路、不复用代码），只对改动的块发出 `remove/insert` 或块内 `insert_text/remove_text` 操作，未改动的块保持对象身份。`replaceNodes` 会打断 range ref、分块树和 React 记忆化，改为操作后批注范围、段落 diff 缓存、滚动和选区都能保留。
2. **审阅数据按条目结构共享**：`review.json` 重载时未变的批注、事件沿用旧对象，卡片 `memo` 与装饰快照不失效。
3. **装饰按块缓存**：快照以块对象为键，只重算改动的块（现有快照已按节点身份复用，需扩展到对齐和批注定位）。

### 阶段 3：只画看得见的

1. **让分块真正生效**（**已落地**，每 8 块一块，见 [frontend/markdown.md](../frontend/markdown.md#长文档渲染)。生产模式实测：缩放一步约 250–290 ms，其中缩到 90% 从 ≈480 ms 降到 ≈260 ms；跳到新区域的单帧从 ≈155–190 ms 降到 ≈145 ms。剩余缩放开销不随分块大小（8 / 24）变化，主要是可见区域的重排与订阅 `uiScale` 的其他组件重渲染，待分析）：`chunking: { chunkSize: 16–32 }`，自定义 `renderChunk` 给每块加 `content-visibility: auto` 和 `contain-intrinsic-size: auto <估计高度>px`（记住上次渲染的真实高度）。需要解决：
   - 滚动锚定：WKWebView 在 Safari 27 之前不支持 `overflow-anchor`，视口上方的块高度修正（如缩放后）会让内容跳动，要自己记录视口顶部的块和偏移并恢复（CodeMirror 6 的做法）。
   - 屏幕外测量：用 `contentvisibilityautostatechange`（Safari 18）或 IntersectionObserver 记录哪些块已渲染，只测量这些块里的批注引文，其余用块级位置缓存。
   - CSS：分块会多一层包裹元素，`[data-slate-editor] > * + *` 这类兄弟选择器会失效；开发时用 `chunkSize: 3` 暴露问题（Slate 文档的建议）。
   - 页内查找：Safari 26 起才能搜到被跳过的内容，Edda 自带的查找替换需要先让目标块进入渲染。
2. **批注栏虚拟化**：只测量已渲染块里的引文（Overleaf 的做法：视口外的条目直接不定位），只挂载视口上下各一屏内的卡片，视口外的用「上方 / 下方还有 N 条」入口；读取集中在一个读阶段、写 `top` 集中在一个写阶段。卡片放进编辑器自己的滚动容器，滚动时不再需要 JS 同步位置。排版已采用与 Overleaf 相同的「选中卡片钉住，向上、向下两次扫描」算法（`balloon-layout.ts`）。

### 阶段 4：交互

- 简洁标记 / 全部标记（精简模式升级）：简洁标记下修订只在行首显示竖线，点击展开；批注以紧凑卡片或行末标记显示。
- 批注栏密度控制：同一屏批注过多时折叠为「此处 N 条批注」，点击展开。
- 键盘导航：在修订与批注之间逐条跳转，焦点卡片对齐原文（现已部分实现）。

## 四、业内做法对照

| 来源 | 做法 | 在本方案中的对应 |
|---|---|---|
| [slate-react 分块](https://github.com/ianstormtaylor/slate/pull/5871)（0.116，[性能指南](https://docs.slatejs.org/walkthroughs/09-performance)） | 子节点分组成记忆化的块，可配 `content-visibility`；作者在 5 万块文档上测得 Safari 每次按键 344 ms → 60 ms | 阶段 3.1 |
| [CodeMirror 6](https://github.com/codemirror/view/blob/main/src/heightmap.ts) | 只渲染视口；屏幕外高度由 `HeightOracle` 估算、绘制后替换；自己维护滚动锚点；读写分相（`requestMeasure`）；昂贵装饰只算可见范围 | 阶段 3.1 的高度缓存与滚动锚定、3.2 的读写分相 |
| [ProseMirror](https://prosemirror.net/docs/ref/#view.DecorationSet.map) / [prosemirror-changeset](https://github.com/ProseMirror/prosemirror-changeset) | 装饰集随编辑映射而不是重算；基线固定，每次编辑只更新变更列表 | 阶段 1.3、2.3 |
| [Overleaf 审阅栏](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/review-panel/utils/position-items.ts) | 读阶段只给已渲染的位置定位；选中条目钉住、向上和向下各扫描一次；50–100 ms 防抖后一次写入；条目在编辑器滚动容器内；视口外用「上方 / 下方还有更多」 | 阶段 3.2（排版算法已采用） |
| [Lexical MarkNode](https://github.com/facebook/lexical/blob/main/packages/lexical-mark/src/MarkNode.ts) | 批注是带 id 的内联节点，锚点随文档树移动；用变更监听增量维护 id 表 | 现用 Slate range ref 实现同样效果（已实现） |
| [CoCalc slate-diff](https://github.com/sagemathinc/cocalc/tree/master/src/packages/frontend/editors/slate/slate-diff) | 外部改动先按块做序列 diff，再转成最小 Slate 操作 | 阶段 2.1（只借鉴思路） |
| [VS Code](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/services/editorWebWorker.ts) / [@codemirror/merge](https://github.com/codemirror/merge/blob/main/src/chunk.ts) | diff 在 Worker 中算；只重算两段未变块之间的变化区间，超时则放弃精确 diff | 阶段 1.3 |
| Word | 简洁标记 / 全部标记 / 无标记 / 原始状态四种视图 | 阶段 4 |

未能核实：Google Docs 与 Word 网页版批注栏的公开实现（Docs 已改为 canvas 渲染）；Notion、AFFiNE 的块虚拟化细节。Plate 文档中的实验性虚拟化渲染尚未发布，不依赖。

自动保存的整篇序列化问题在上述资料中没有直接对应，是 Edda 自身实现的问题，按块缓存即可解决（阶段 1.1）。

## 五、建议顺序

1. 阶段 0 + 阶段 1.1 / 1.2（增量序列化）：编辑卡顿的最大来源，改动集中在保存路径。
2. 阶段 3.1（让分块生效 + 滚动锚定）：缩放、改窗口大小和滚动的主要来源。
3. 阶段 2.1（外部写入转最小操作）：Agent 改稿后的刷新。
4. 阶段 1.3 / 2.3（增量装饰）与 3.2（批注栏虚拟化）。
5. 阶段 4 交互。

## 六、风险

- 分块渲染会改变屏幕外内容的测量方式，批注对齐、跳转、查找替换、大纲定位都要回归。
- 增量序列化必须与整篇序列化逐字节一致，否则会出现幽灵修订；保留整篇序列化作为校验与回退。
- 外部写入改为增量操作后，撤销栈语义需要明确。现状与整篇替换相同：一次外部写入是撤销栈中的一步（不进入撤销栈会让之前的撤销记录指向错误的路径）。
