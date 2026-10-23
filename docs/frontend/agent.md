# Edda 面板

BYOA：连接本机（或远程）ACP Agent。Host 协议见 [../backend/agent.md](../backend/agent.md)。

Edda 是助手的名字；可切换的 Codex / Claude / 其它 ACP Agent 是运行后端。面板、布局、权限与提问弹窗、划词入口和 Toast 使用 Edda；安装配置、协议及第三方名称保留技术含义。英文与简体中文同步。

## UI 分层

```text
AI Elements (Conversation / Message / PromptInput / InlineCitation / Reasoning)
  → AgentPanel 状态机
  → invoke agent_* + 订阅 agent:* 事件
```

流式：`agent:stream`（message | thought）→ 完成 / 失败事件。

**行内 citation pill / 统一跳转**：Agent 按格式输出 `[label](papers/…/<id>.pdf#section|figure|page=…)` 或 `[[papers/…/NOTES]]`。`prepareAgentMessageMarkdown` 会给 vault 相对 href 加 `./` 前缀——Streamdown 内置 rehype-harden 只把 `/` `./` `../` 当相对路径，裸 `papers/…` 会被标成 Blocked；点击时再剥掉 `./`。`MessageResponse` / `ReasoningContent` 把 `<a>` 渲成同一 citation pill：`http(s)` 开系统浏览器，vault 路径走 `openCitation`。裸 `papers/…#page|section|figure=…` 也会补成链接。`.tex` href 回退到同论文 `{id}.pdf`。残留 status tag / `blocked` 标签有显示兜底。约定不加外层 `([…])`，不用文末 `## Sources`。Host 解析：`#figure=N` 在 caption 任意位置匹配 `Fig./Figure N`（避免 OCR 把标签挤到标题中间）；`#section=N` 同时认阿拉伯与 IEEE 罗马章节号（如 `3` ↔ `III.`），并抬高短数字的相似度门槛以免误命中页眉噪声。解析失败 Toast 按 fragment 类型短提示（如「找不到 Figure：…#figure=7」）并带上 source。跳转成功后用黄色半透明高亮块闪一下目标区域（约 1.6s 淡出消失），目的是引起注意；细条 section 标题会扩成标题下一段预览块，并按 bbox 滚进视口。Figures 侧栏选中仍用 kind 色描边（常驻）。

## 面板行为

- 新对话显示轻量欢迎页：吉祥物下方一行灰色小字「Edda · 论文标题或页面名」（过长截断，悬停看全称），不随所选运行后端改名。标题按 conversation scope 解析，不受临时附件影响；不展示预设提问按钮，直接在输入框提问。等待 Edda 和恢复历史时仍显示对应状态。
- 吉祥物静息姿态：默认双眼同高、竖直并关于圆头中线对称，腮红同高；基础漂浮只上下移动。互动动作仍可歪头，悬停中途结束时平滑回到中立身位，避免停在半途的倾斜／挤压姿态。
- 欢迎页的本地 SVG 吉祥物（与应用图标同款哑光圆头，无手）轻微漂浮、眨眼，眼睛与脸朝向用 spring 跟随整个窗口内的鼠标；空闲时每隔数秒随机做一个动作并配合表情——蹦跳、惊跳、侧倾眨眼、歪头好奇、打瞌睡（飘 z）、望向一侧思考、左右张望、原地转身、摇摆（脸沿圆头滑动并按头部裁剪，阴影随跳起缩小）。鼠标互动（窗口级监听、按头部半径命中，装饰本身仍不接收事件）：靠近时朝鼠标探身、悬停头部害羞低头、点头部 `> <` 挤压、来回快速晃动鼠标转圈晕眩、鼠标离开窗口左右张望、30 秒不动睡着，再动时惊醒；表情只靠眼睛，不画嘴、不用笑脸；装饰不接收点击、焦点或读屏，也不发送请求。首次提交、运行、切 Agent、恢复历史或出现消息时淡出，不参与 transcript 行高。低高度面板改为紧凑横排；隐藏侧栏 / Webview 时暂停，系统减少动态效果（含运行中切换）下停用循环、动作表情、鼠标互动与视线跟随。实现：`agent-welcome.tsx` / `agent-welcome.css`，标题：`lib/agent/welcome-context.ts`。
- **Agent 切换器列表**：App 启动即 `scanCatalog` + soft-probe（`prefetchAgentCatalog`，不依赖侧栏挂载）；面板挂载与 vault 变化时再 `listAgents + scanCatalog` 刷新。Settings 探测 / 安装 / 卸载 / 改默认会改 registry，Host 广播 `agent:registry-changed`（已纳入 lifecycle typed bus，见 [lifecycle-events](../development/lifecycle-events.md)），面板经 `lifecycle.on` 防抖刷新——面板常驻不卸载，否则探测成功后切换器仍是旧列表。catalog 项仅 `acpStatus === "ready"`（ACP 握手成功）才显示，不可用项直接隐藏而非置灰。
- **当前论文默认 context**（可 X 移除）；`@` 提及或文件树拖入 → 在输入正文光标处插入行内 mention chip（见下）。
- **引用式问答**：划词本身不发送；菜单「问 Agent」/ `⌘K` / 有选区时 `⌘L` / `⇧⌘A` 把选区引用加入完整侧栏 Agent 并聚焦。引用可预览、移除和跳回来源；跨页保留各页矩形，同句不同位置不误合并。发送 / 排队 / 编辑重发都保留来源快照，普通问答不自动创建 `kind: ask` 标记。详见 [agent-references.md](agent-references.md)。
- **论文上下文**：显式引用与手动 `@` 材料优先，已有论文会话不随 PDF 标签切换悄悄换来源。引用问答默认 `paper-qa` Skill，读取已有 TeX / PAPER.md / 版面结果；可继续会话在首次启用或指令版本变化时注入该 Skill，同版续聊不重复。历史问答标记保留只读查看与删除入口。
- **每篇论文自己的讨论**：切换论文时，侧栏清空上一篇的显示并恢复目标论文最近的会话；没有历史则进入新草稿。返回原论文恢复对话与输入草稿，也可主动「新建会话」，历史不会删除。论文 PDF / NOTES 共用 scope；等待消息与后台工具提问按论文 / 会话隔离。
- **按页面隔离历史**：历史列表只显示当前 Agent + 当前论文 / 页面归属的会话，归属按 Vault 与 provider session id 在本机持久化。文献库、广场、其它工作区页面分别保留会话与草稿；虚拟页面路径不作为可读文件附加。旧会话在需要时从首轮来源上下文恢复归属，无法判断的归入文献库管理历史，未归属记录不会混入论文历史。
- **页面上下文**：页面会话（`page:<路径>`）发送时，若该页面注册了快照提供者（`src/lib/agent/page-context.ts` 的 `registerPageContext`），会把页面快照作为隐藏上下文块拼在用户问题之后（标记 `PAGE_CONTEXT_MARKER`，转录中不显示），总长约 6000 字符、1 秒内未应答则跳过。目前广场网页（Cool Papers、ModelScope）已接入：面板经 postMessage 向代理注入的 `SNAPSHOT_BRIDGE` 请求快照，得到页面标题、URL、选中文字、论文条目（id、标题、作者、摘要，屏幕内的优先并附摘要）以及详情页正文；未经代理的网页只提供页面名与 URL。论文会话不走这条路径，仍由论文本身和来源文件提供上下文。
- **删除历史**：历史行右侧垃圾桶从 Edda 历史移除会话，清理本机草稿、引用附件和标题缓存；持久化删除标记阻止 provider 刷新或重启后重新出现。删除当前会话会回到本页新草稿，运行中会话需先停止。操作不删除原生 Agent 的会话文件或 PDF 标注；失败用 Toast。
- **图片附件**：Composer 支持粘贴 / 点选 / 从 Finder、预览或其它 App 窗口拖入图片（`image/*` 与 macOS image UTI，最多 8 张、单张 ≤ 10 MiB）。拖入图片且指针在 Agent 面板/输入框上时显示虚线 overlay；能判定为非图片（`.md` / PDF）或**文件树内部拖拽**则不显示、不抢落点。窗口 `dragDropEnabled: false`，走 HTML5（Windows 上 Tauri 原生拖放会吞掉 HTML5）；`FileList` 有数据时直接附加，否则按路径读盘。不抢成 `@` 路径 chip。提交时转为 ACP `ContentBlock::Image`（与 PDF 视觉批注同一 `runOnce.images` 通路）；会话气泡以缩略 chip 展示，纯图消息无文字气泡。图片仅会话本地保留，不随 `session/load` 历史回放。工具：`src/lib/agent/prompt-image.ts`。
- `@`：空时优先最近路径与浅层目录；› 进入子目录；论文标签与 `paperTreeLabelMode` 一致。`@`、`$` 与 `/` 候选菜单由 viewport 碰撞处理定位，空间不足时翻转并在可用高度内滚动。
- **回合显示（工作过程收起，只突出回答）**：`splitTurn`（`src/lib/agent/tool-activity.ts`）把一轮拆成「过程」（推理、工具调用、plan，以及工具之间的过渡叙述）和「回答」（最后一次工具 / plan 之后的正文；结束在工具上时全部正文都算回答）。
  - 运行中：一行实时状态（光球 + 轻趣味文案 + 计时），`streamingLabel` 只使用阶段与动作类别，不插入命令、路径、工具名称、输入输出或 provider 重连详情；光球的无障碍名称及移动端也不暴露详情。例如「循着线索找一找…」「让小齿轮转一转…」「把思路织成回答…」。同类文案每 8 秒温和轮换，不暗示完成度；减少动态效果时不轮换、不滑动。计时取回合 `startedAt`，虚拟化重挂载不归零。
  - 结束后：普通模式仅显示「Edda 用时 28 秒」，失败步骤另标明「部分步骤未完成」，不挂载过程原文或原始工具载荷。开发者模式保留原有可展开的技术诊断（分类工具、推理、plan、输入 / 输出），底层事件和历史记录不删改。回答、复制、生成文件卡片、权限和问卷交互保持原通路；用户主动请求代码或技术说明时，回答仍可正常显示代码。
  - Host `agent:tool` 透传 ACP `locations`（去重、最多 16 个路径）。实现：`turn-process.tsx`。
  - **生成的文件**：回合结束后，回答下方列出本轮写入的文件卡片（`producedFiles`：已完成的 edit 调用涉及的路径与 move 的目标，减去之后被 delete 的；通过命令行副作用写出的文件识别不到）。点卡片走 `openAgentFile`：知识库内的文件在中间栏打开（HTML 进本地预览，见 [web-view.md](web-view.md#本地-html-预览)），知识库外的在访达中显示。展开读 / 写 / 移动 / 删除类步骤时，涉及的路径同样可点。
- ACP tool 更新按 `toolCallId` 回写所属 Agent 消息，即使 completion 晚于回合结束也能修正原卡片；回合完成、失败或取消时，仍为 pending / in-progress 的卡片先收敛为 failed，避免永久 spinner。迟到的内容和 completed / failed 状态仍可更新原卡片，pending / in-progress 不会让已结束回合重新转圈。
- ACP 结构化提问工具会解析为 AI Elements `Tool` 内的可选回答；完成选择后以正常的下一用户轮提交，并继续同一 ACP 会话。支持多 harness 的 rawInput 形状（见下表）。
- 运行中可继续输入 → Queue waitlist（「等待发送」）；标题保持简洁，条目等宽并可单独移除；Esc / 停止中止。队列排在输入壳**上方**的正常文档流里（不绝对定位遮挡输入框）；队列另占一行高度。紧凑模式下队列自身也会收紧 padding。
- **会话配置条**（Header 下方）：模型选择、协作模式（有上报时）、Fast（有上报时）；推理强度收在模型选择弹层顶部，与当前模型名称同行。从 Composer 工具栏上移，紧凑输入时也不被隐藏；窄侧栏中保持单行，过长的模型 / 模式名称以省略号截断。
- 引用上下文：`@` 提及、`$skill`、`/command` 与**加入对话的选区**选中后都在输入正文里**行内插入**小 pill（contenteditable；行高贴近正文、`max-w` 较短；点击或 Backspace 整颗删除）。Skill pill **只显示图标 + 名称**（去掉 `$` / `skill :` 前缀）；`@` 仍带 `@`，`/` 仍带 `/`，选区 pill 带高亮图标。草稿 marker：`{{m:path}}` / `{{s:skillId}}` / `{{c:name}}` / `{{sel:…}}`；发送时剥离 m/s/sel（路径、skillIds、选区走原通路），c 展开为 `/name` 进 ACP 正文。当前文件、视觉批注为块级 chip，放在输入框**内部**正文上方（紧凑模式仍在输入框上方一行）：默认图标；hover / 聚焦时**宽度动画展开**短标签与 ×（不用 tooltip 浮层）。图片附件仍在边框内。输入框**随内容长高**：空时两行，最高约为面板正文高度的 40%（正文是 size container，`max-h` 用 `cqh`），超出后内部滚动；不再有拖拽分隔条。聚焦时边框变铜色并带浅光环；有内容时发送按钮变为实心深色。应用窗口高度 < 600px 时进入紧凑一行模式：按内容撑开，块级 chip 与图片收成图标圆片，隐藏底部工具栏，圆形发送按钮与输入框同一行并垂直居中（无内容时置灰）；单行用 `px-3 py-2.5`，与非紧凑 footer 的 `px-3 pb-2.5` 对齐，外层 `px-3` / `pb-3` 两种模式一致，切换时输入框宽度与底边距不跳。
- 会话空闲时 hover 用户消息可 **Edit** 后重发。
- **长会话虚拟化**：transcript 行数 ≥ 80（`use-transcript-virtualizer` 的 `VIRTUALIZE_MIN_LINES`）时切换 `@tanstack/react-virtual` 窗口化渲染，复用 use-stick-to-bottom 的 scrollRef（贴底与滚动按钮行为不变）；Reasoning / Tool / Plan 折叠态提升到 `ChatTranscript` 统一管理，行卸载不丢。
- **新建对话 / 历史恢复**：新建草稿不会清空刚离开的本地 transcript；历史项同时存在 Edda runtime id 与 ACP provider id 时，`session/load` / 后续续聊只使用 `providerSessionId`；连续续聊产生的新 runtime 行会按 provider id 合并回同一个历史项；远端历史项会先激活空 transcript 并显示 Shimmer/骨架占位，加载结果再通过一次原子 store 更新替换为真实内容，避免列表刷新后出现空白会话。详见 [Codex 历史恢复误用 runtime id](../bug_fix/codex-history-runtime-session-id.md) 与 [Agent 历史会话恢复加载反馈](../bug_fix/agent-history-session-shimmer.md)。会话标题优先用 ACP `session/list` / `session/load` 返回的 title，缺失时回退首条用户消息（本地已有 transcript 时立即从首条 user turn 推导；外部会话无 title 时先留空并由后台 `session/load` **预加载**补全——切 Agent / 打开历史弹层时对无标题项并发 hydrate，结果写入 `localStorage` 标题缓存，下次列表可秒开；**不再**用 session id 前缀占位以免挡住回退，见 #484）。历史列表元信息只显示 `Agent · 状态`，**不**再常驻 `ses_…` id；id 仅在标题完全缺失时作为最后兜底。运行中 Agent 经 `session_info_update` 推送的新标题由 `agent:session-info` 事件实时写回历史项（按 runtime id 或 providerSessionId 匹配；视觉批注会话标题不被覆盖）。
- **`/` 菜单（Skill + Agent 命令合一）**：输入 `/` 时同一个菜单先列 Edda Skill（Sparkles 图标，选中后作为 skill pill 注入 `SKILL.md`），再列当前 ACP session `available_commands_update` 广播的 Agent 原生命令（`/name` 原样发送）；Agent 把同名 skill 当命令广播时只保留 Edda Skill 一条（各 Agent 行为一致）。`$` 仍只列 Skill。菜单末尾固定「管理 Skills…」直达 Skill 管理页；只敲 `/` 或 `$` 时即使无匹配也会打开，带查询词无匹配则不打开（避免路径 ` /usr` 误触）。输入框工具条的 Sparkles 按钮等同输入 `/`，不知道触发符也能用。实现：`composer-quick-menus.tsx` 的 `ComposerQuickMenu` / `QuickOption`。
- **Skill 反馈**：本轮附带的 Skill 以小 pill 显示在用户气泡上方（从 `{{s:id}}` marker 读取，不另存字段）。发送前按当前 Skill 列表过滤：已删除 / 改名的 Skill 不再让整轮失败，而是去掉并 Toast 提示；Agent 原生命令消息不会附带 Skill（Host 原样转发命令），附带了会 Toast 说明。Skill 列表加载失败 Toast，不再静默为空。
- **模型选择（含第三方）**：列表来自 ACP `agent:models`；若 Agent 当前模型或用户偏好不在固定目录中（如 Codex + 中转 / cc-switch DeepSeek），仍会并入可选列表，并支持在搜索框输入任意 model id 作为自定义模型（`warm` / `run_once` 会尝试 `SetSessionConfigOption`，即使 id 未出现在上报目录中）。偏好按 agent 持久化。弹层顶部固定「当前选择」，模型名称与推理强度下拉按基线保持一行；搜索与模型目录在下方独立滚动。点击当前模型名称即清空搜索并滚动到完整目录中的当前模型、短暂高亮（不跳到收藏副本），无常驻定位按钮；打开时聚焦搜索。选择模型后弹层保持打开，可继续调整强度，点击外部或 Esc 关闭；协商期间暂停再次选择模型。
- **会话模式（capability-driven）**：Codex `collaboration_mode`（Default / Plan 等）。Plan 下才开放 `request_user_input`。事件 `agent:collaboration`；`warm` / `run_once` 携带 `collaborationModeId`。Header 下配置条有上报时显示「模式」下拉（仅模式名，不展示 description）；偏好按 agent 持久化。不暴露 ACP `category: mode` 沙箱档（Read-only / Agent 等）。
- **推理强度**：紧跟顶部当前模型名称，无分隔点、无常驻标签、无独立配置行；点击档位名称打开单选菜单。ACP 提供的档位名称与顺序原样展示（不翻译 Low / High / Max 等 Agent 数据），标签仅用于 Tooltip / 无障碍名称。没有已存选择时，默认当前模型支持的最高可识别档位（none/off → minimal → low → medium → high → xhigh → max → ultra）；ACP 不定义强度排序，自定义档位无法排序时采用 Agent 当前值。手动选择按 Agent 持久化，重新打开、切换 Agent 或模型后仍支持该档位时继续使用；不支持时采用 Agent 当前值，保留原偏好供切回时恢复。发送前 Host 按最终模型能力校验；未手动选择时传 `preferHighestReasoningEffort`，保证在 warm 尚未完成时首轮也应用最高档策略。快捷工作流切换 Agent 时采用目标 Agent 的偏好。

## 插件（MCP）

会话配置条右侧的插头按钮显示已启用的 Agent 插件数，点开列出新对话可使用的插件（名称 + 地址或命令）并可「管理插件…」直达设置 → 网络与集成。插件就是用户配置的 MCP 服务器，与 Edda 自带的 `edda-workspace` 一起在 new / load / resume 时交给 Agent（见 [backend/agent.md](../backend/agent.md)）。解析与合并：`src/lib/agent/mcp-plugins.ts`。

## 外观约定

- 头部与会话配置条视为一个整体：`PaneHeader` 去掉底边，配置条 `h-8` 透明底、细分隔线，模型名常规字重 + muted。
- 回答 Markdown 由 Streamdown 渲染，它的 Tailwind 类（列表圆点、标题、引用）需在 `index.css` 用 `@source` 扫描 `node_modules/streamdown/dist`，否则列表没有圆点。
- 用户气泡右下角收小圆角（聊天尾巴）；回合间距收紧，助手回答的复制按钮不额外占行。
- 工作摘要行可点区域为圆角胶囊（hover 底色）；运行中的状态文字带 Shimmer 流光。
- 错误行为淡红描边提示块（图标 + 文本），回合级通知（已停止等）为居中细分隔线 + 小字。
- 历史列表：标题在上，下方「状态 · 相对时间」（`Intl.RelativeTimeFormat`，一周外显示短日期），运行中带绿点；列表已按 Agent 过滤，不再重复 Agent 名。
- `/` 与 `@` 菜单宽度跟随输入框（`--radix-popover-trigger-width`），不溢出侧栏。
- 权限对话框：标题带盾牌图标；路径列表先显示文件名、目录淡化；只有第一个允许选项是主按钮。

## 权限 UI

全局模式（设置）：`restricted` / `ask` / `auto`。  
`ask` 时弹权限对话框 → `agent_respond_permission`。

## 表单 Elicitation / AskUserQuestion（同一 UI）

「Agent 向用户结构化提问」**共用** `AskUserQuestionForm`（AI Elements `Suggestion` 选项芯片）。

**背景**：ACP 无统一 ask-user tool 格式。Client 先声明交互能力（`elicitation.form`），再用 adapter 解析各 harness 的 tool / elicitation / ext；个别 provider 还需 Host 侧 RPC（Grok）或 spawn env（OpenCode `OPENCODE_ENABLE_QUESTION_TOOL`）。详见 [backend/agent.md](../backend/agent.md)「结构化提问」。

各 harness 经 client adapter 落到同一表单：

| 来源 | 协议 / rawInput | UI 位置 | 备注 |
|---|---|---|---|
| Codex tool / Claude / OpenCode `question` | `agent:tool` + 可解析 questions | **底部问卷**（从 tool 提升） | Transcript 只留 tool 行 +「请在下方问卷中作答」；不嵌表单 |
| Codex `request_user_input` | `elicitation/create` → `agent:elicitation-request` | **底部问卷** | Client 须声明 `elicitation.form` |
| Grok `_x.ai/ask_user_question` | ACP **ext method** → `agent:ask-user-request` | **底部问卷** | 提交 → `agent_respond_ask_user`；若同时有 tool 镜像则**抑制** tool 表单 |

**单一交互面**：优先级 `elicitation` > Grok ext > tool 提升；任意时刻只显示一张表单。表单在 **`AgentAskUserSurface`**（transcript 下方）。问卷与 free-text **composer 互斥**：有可渲染问卷时隐藏 resize 手柄与 `AgentComposer`（草稿状态仍由 session composer state 保留），提交或取消后恢复输入壳。解析：`parseAskUserQuestions` / `questionsFromElicitationFields` / `questionsFromAskUserDtos`。

问卷外观与输入框同一表面（`bg-card` 圆角卡片），顶部抓手条可收起 / 展开；选项选中为淡主色底，键盘焦点为加深边框（不叠加粗 ring）；键盘提示收在导航按钮的 tooltip 里，不常驻。

多题为 **翻页**：一页一题，上一题 / 下一题，末题显示「提交」；单选且无 Other 时选项点击后自动进下一题。多选（`multiSelect` / `multiple`）可点多个芯片，答案以 `, ` 拼接。单题仅「提交」。底部「取消」右对齐。

键盘（焦点在问卷区、非自由文本框）：`↑`/`↓` 移动选项焦点，`Space` 勾选/切换，`Enter` 确认当前焦点并下一题（末题提交），`←`/`→` 切题。

Client 声明 `elicitation.form`；用户提交 elicitation → `agent_respond_elicitation`（accept + content）或 cancel。映射：`elicitationContentFromAnswers`。

Tool 提升的作答：`formatAskUserAnswers` 后作为下一用户轮。若当前 turn 仍 `running`（OpenCode 等阻塞在 question tool），会先入队再 **取消该 turn**，以便队列立刻排空发送——避免卡在「等待发送」还要点停止。Grok ext / elicitation 不走此路径。

## 精读（paper-reader）

| 触发 | 条件 |
|---|---|
| Zap | 有 PDF +（TeX 或 `PAPER.md`）且未读 |
| 自动 | `autoPaperReader`（默认关）；魔棒/单篇 Download 后 |
| 对话中显式请求 | 本轮明确调用 `paper-reader`，或明确要求生成 / 更新整篇结构化精读笔记 |

成功写 `NOTES.md`，`is_read = true`；进度在后台任务条。批量导入不连跑。  
Skill 由 Host 把 `SKILL.md` 正文注入本轮提示（各 provider 一致，最多 5 个、64 KiB），见 [backend/agent.md](../backend/agent.md#工作流与-skill)。
用户提示会按当前 App 语言（设置里的 `en` / `zh-CN` / 跟随系统解析后）注入一句输出语言说明：正文跟 App 语言，skill 固定的英文 `##` 结构标题保持不变。

`paper-reader` v9 保留显式精读笔记边界，并直接使用已提供的指令，不要求重新激活 Skill。论文路径、普通「读 / 解释这篇」或局部问题不足以进入该工作流；发现 Skill 或历史里用过也不算本轮授权。普通问题沿用 `paper-qa`，保存单个回答不升级为整篇精读。业务操作统一使用工作区 MCP；正文用原生文件工具或有界源文件工具读取，下载/解析返回可跟踪的任务 ID。

`NOTES.md` 须带 YAML frontmatter：

- `aliases`（至少：**论文全称** + **一个短标题**），以便双链 `[[…]]` 按标题提示到该 NOTES；含冒号等 YAML 字符的标题必须作为带引号字符串写入
- `created: YYYY-MM-DD`（语言中性键；ISO 日期，Properties 按值识别为日期；已有创建日期则不覆盖）

保留用户已有 frontmatter 键与自定义 alias，不重命名 `NOTES.md` 文件名。约定见 vault 内 `paper-reader` skill。

排版采用一个论文标题 `#`、五个固定英文 `##` 和主题 `###` 子节；正文按 App 语言。仅确认是导入器生成的占位标题才用核实的论文标题替换，用户标题保留。方法以直觉 → 机制 → 示例直接讲解，不默认生成 Teacher/Student 对话。实验用可比指标的紧凑表格与结论解读，避免逐表转抄；普通数字 / 单位不套数学语法，重要公式独立成块并说明符号。短段落、少量重点加粗、块间一个空行，不附手工目录、装饰分割线或末尾 Sources 文件清单。精读入口提示与 Skill 统一要求在结论旁使用核实的行内引用。

## 个人偏好

`agentPersonalPrompt`：非空时经 Host `build_prompt` 注入 envelope。

## 消息 Markdown 渲染

回答末尾的 `Sources` / `References` / 中文来源小节默认折叠成一行 `text-xs` 的「来源」，展开后保持小字号并复用原有引用跳转。使用原生 `details/summary`，支持键盘操作；识别跳过代码围栏，也不折叠后面还有同级正文标题的中间章节。原始消息、复制内容和 provider 历史保持完整。

`MessageResponse` / `ReasoningContent` 用 Streamdown；表格与代码块走自研轻量壳，交互对齐：

| 块 | 组件 | 悬停操作 |
|---|---|---|
| 表格 | `PlainTable` | 复制（Markdown / CSV / TSV）、下载（CSV / Markdown）、全屏 |
| 代码块 | `PlainCodeBlock` | 左上角语言小标签；悬停复制/下载（按语言后缀）；无外侧卡片、无全屏；`mermaid` 仍走 Streamdown 图渲染 |

落盘：`src/components/ai-elements/plain-table.tsx`、`plain-code-block.tsx`。

## 代码

- UI：`src/components/agent/`（`agent-panel.tsx` / `agent-composer.tsx` / `agent-config-bar.tsx` 外壳、`hooks/` 面板与 composer 状态、`composer/` 输入区子件：附件 / 队列 / context chip / @ 与 $ 与 / 菜单 / 模型选择 / 工具条）
- 状态：`src/lib/agent/`（chat-state、composer-state、stream-parse、mention）
- 精读编排：`src/lib/paper/reader.ts`
