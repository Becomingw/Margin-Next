# 引用式 Agent 问答

PDF / 网页论文 / 广场详情的选区菜单统一为「问 Agent」。划选本身不发送消息；点击菜单或 `⌘/Ctrl+K` 后引用加入完整侧栏 Agent 并聚焦输入框。`⌘/Ctrl+L` 有选区时同样带入引用，无选区时仍切换侧栏。不会为选区新建独立聊天或自动产生 PDF 标记。

## 引用附件

- `SelectionContext` 保留来源路径、选中文字、页码、归一化矩形；`anchors[]` 保存跨页选区的所有页，旧的单页 `page/rects` 仍可读。
- 划选完成时直接使用 EmbedPDF 几何；异步文字提取有 revision 检查，旧选区晚返回不会覆盖新选区。失活 / 卸载只清理本文件的活跃选区，不清掉其他文件引用。
- 从已加载的 `layoutAnalysisStore.rawRegions` 中按页码与选区重叠匹配最多 8 个文字区域 ID（按阅读顺序）；不启动解析，不读取整份正文到 prompt。
- 引用 ID 使用随机稳定 ID；去重比较文本、来源、页码及各页矩形。同句出现在另一页或另一位置时保留为不同引用。
- 正文最多 4000 字符，超过时带 `truncated`，几何保留，预览会提示打开来源。引用随 `{{sel:…}}` 内联 token 保存在原有会话草稿机制里；输入框尚未挂载时等待 DOM 就绪，不提前消费引用。
- 点输入框引用标签可展开原文预览、查看来源或移除；标签上的 × / Backspace 删除引用。发送后消息也有可展开引用块，编辑重发保留原引用，排队时冻结引用及来源路径。

## Agent 上下文与成本

### 按论文隔离讨论

- 切换论文立即切换侧栏讨论：无历史的论文显示空白新会话，有历史的论文恢复最近选择的会话；清空的是当前显示，不删除原论文的历史。
- 同一论文的 PDF / NOTES 使用相同论文目录作为 scope。未发送草稿使用 `draft:paper:<path>` 独立存储，已有会话草稿仍按会话 ID 保存；排队消息按论文暂存，切回后才继续排队发送。
- 每篇论文在本机按 Vault 记录最近的 Agent、runtime / provider session ID；空白新草稿也记住所用 Agent，避免跨 Agent 切回时读到另一个草稿槽。恢复必须使用真正的 provider ID；只有 runtime ID 且内存会话已丢失时不会把它误当 ACP resume ID。
- 「新建会话」只重置当前论文的新草稿，旧对话仍可从历史打开；显式新草稿状态也会被记住，切回时不会又自动打开旧对话。
- 已接受的后台会话继续更新自己的 transcript。切换时尚未接受的提交会失效，迟到的接受结果被取消；待恢复历史有 generation 防护，不会把旧论文回放到当前论文。后台工具提问不覆盖当前论文的输入区。
- `conversationScope` 扩展为 `paper:<relative path>` / `page:<page key>`：文献库、广场及其它页面也有独立的最近会话、草稿和队列。论文 PDF / NOTES 仍映射到同一论文目录。Vault 切换在 layout 阶段先清理旧 store，避免恢复新 Vault 时误用旧记录。
- 每个会话的归属（不仅最近一条）按 Vault + Agent + runtime/provider id 保存在本机轻量索引。刷新原生历史先恢复归属，打开历史时可从旧会话首轮来源路径补齐；后续引用别的论文不会改变归属。历史列表只展示当前作用域，旧记录无法判断归属时进入文献库管理历史。
- 历史删除写入本机删除标记并移除本机缓存，原生 `session/list` 再返回同一 provider id 时仍会过滤；旧的论文最近会话指针也不能将其恢复。原生 Agent 文件与论文 marks 保留。

`referenceContextPaths` 使显式引用来源优先于当前工作区标签；`@` 明确加入的材料仍附加。PDF 标签切换不会偷偷替换已经绑定的论文会话上下文；新引用可明确切入另一篇论文，并保留多篇讨论关系。移除当前文件 context 后不再自动补入绑定路径。

本地 PDF 引用默认使用 `qa` workflow，未手选其他 Skill 时启用 `paper-qa`。这是 Edda 直接注入的已加载指令，不发送 `/paper-qa` 或 `$paper-qa` 原生触发提示。在可继续的 provider 会话中，首次启用或指令版本变化时注入；同版本续聊不重复附加 Skill 正文，也不拼接整个聊天历史。`qaInstructionsVersion` 只记录已发送的指令版本，不表示 provider 原生 Skill 已执行；旧记录缺少版本时会刷新。不支持继续的会话才通过已有本地 transcript helper 带回上下文。

模型收到来源路径、页码、引用原文和已有版面 block ID；矩形及本机绝对路径不进入 prompt。`paper-qa` 按需读取已有 TeX / `PAPER.md` / 版面结果，普通问答不写 NOTES、不创建 marks、不标记已读。它与负责整篇精读写笔记的 `paper-reader` 分离。新 Skill 随 Vault 模板播种；已经打开但未播种的 Vault 可用 Host 内嵌 Skill 回退，已有同名本地 Skill 优先。

`paper-qa` v3 使用更短的自然讨论约定：完整引用的翻译/改写直接回答，解释论文背景才按需取证；工作区工具提供 metadata / layout，原生文件工具读已有正文。CLI 是兼容入口，不是每轮前置步骤；不宣告 Skill 激活或机械套报告模板。实际工具选择仍由原生 Agent 决定。

通过 Skill 管理移除 `paper-qa` 后，Host 不再注入它或回退内嵌版本，重新打开 Vault 也不会自动补种。恢复后刷新注册列表及前端 QA 指令版本；既有 provider 会话历史不会被撤回，配置变化应在新会话中验证。

## 历史与回跳

- `ChatLine.references` 是用户消息附件。按 Vault + Agent + provider session ID 在本机 localStorage 保存轻量引用缓存（只存对应用户轮的文本校验与附件，不复制整份聊天）。首次接受但尚无 provider id 时先以 runtime id 缓存；终态有 provider id 后保存到该持久会话键。
- 原生历史恢复后，按用户轮顺序及问题文本校验合并精确引用，避免同名问题错绑。缓存缺失时可从历史 prompt 的 `Selected text from …` 块恢复原文和页码，但没有几何时只能回到该页。
- 点来源复用工作区 `openTab` / PDF handle 注册表及 pending-page 意图；已知矩形通过 `revealReference` 短暂高亮原文，不写 `marks/`。引用跳转不自动切到收拢 Agent 的阅读布局。
- 历史 `kind: ask` 文件仍可读取和删除；原页内 Ask 卡变为只读历史卡，可把原文引用到侧栏继续提问。独立 Ask 的发送 hook、弹窗、自动落盘绑定与完成回写均已移除。

## 代码

| 路径 | 职责 |
|---|---|
| `src/lib/agent/selection-reference.ts` | 引用契约、校验、去重、轻量 prompt |
| `src/lib/agent/paper-qa.ts` | 来源优先级、会话论文关系、默认 Skill |
| `src/lib/agent/paper-conversations.ts` + `hooks/use-paper-conversations.ts` | 每论文最近会话、草稿 scope、显示切换与后台会话隔离 |
| `src/lib/agent/reference-history.ts` | 引用附件缓存、原生历史降级恢复 |
| `src/lib/agent/reference-navigation.ts` | 来源回跳，不创建标记 |
| `src/lib/pdf/selection/reference-context.ts` | 在已有预解析区域中匹配选区 |
| `src/components/agent/chat-references.tsx` | 输入预览与消息引用共用显示 |
| `templates/vault/.agents/skills/paper-qa/SKILL.md` | 轻量、按需、只读论文问答协议 |
