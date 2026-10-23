# Checkpoint：单 AI + 人的审阅交互

本 checkpoint 基于 `da498831` 的事务文档内核，目标是先闭合一个外部 AI 审阅者与本机作者的
协作，不扩展多 AI、自动合并或内置模型聊天。连接使用 **审阅专用 Streamable HTTP MCP**，
不会启动完整 Edda Agent、研究工作台 MCP 或后台模型服务。

## 使用

1. 在 Margin 打开一篇稿件，点击标题栏的「AI 审阅」。
2. 填写审阅者名称，点击「开启访问」，展开「MCP 连接配置」。
3. 把配置加入选定的 AI 客户端。它是带 `Authorization` header 的 HTTP MCP 服务；
   不同客户端的配置外层可能不同，保留实际 URL 和 header 即可。Margin 必须保持运行。
4. 在该客户端发出任务，例如：

   > 请使用 Margin 的审阅工具阅读这篇稿件。先检查我的批注，在同一线程回复；正文修改请提交提案，
   > 不要直接改数据库或文件。提交后等我处理，再读取审阅事件和我的回复继续讨论。

5. AI 的评论、回复以所授权的名称出现在页边。作者在同一张卡片里回复，AI 通过工具回读。
6. 在「AI 审阅」中预览待处理提案，选择「作为修订应用」或「不采用」。应用不等于接受：
   它先进入当前正文的行内修订，作者仍使用原来的逐处 / 全部接受或拒绝。
7. 用「断开连接」结束授权。切换稿件或工作区也会撤销旧授权；重新连接需复制新的配置。

AI 不会因为一条新批注而自行运行。本版本没有模型调用队列或自主讨论循环；需要在外部 AI
客户端发出任务，让它读取工具。这里的「人」是本机作者，不是远程多用户账号。

## 验收边界

- 一个运行中的 Margin 只保留一份活动授权；授权固定到一个工作区、一个文稿、一个审阅身份。
  不同 MCP 会话可以使用同一个角色凭证，但这不等于多个独立 AI 身份。
- 访问默认关闭，端口为随机 loopback 端口。HTTP 需要随机 Bearer 凭证，拒绝浏览器 Origin；
  Host 校验限定 localhost / 127.0.0.1。凭证不保存到数据库或全局配置，不写日志。
- 审阅者显示名由作者授权时选择，不信任 MCP `clientInfo.name` 或工具参数里的自报身份。
  每篇文稿持久化一个 reviewer ID；关闭后重新授权仍可编辑自己先前写的内容。
- AI 可以读已保存正文、基线、全部当前线程、不可变版本、提案状态和序列事件；看不到尚未保存的草稿。
  工具以 Markdown 正文为准，不直接读取参考 PDF 或图片。
- AI 只可提交 **pending 提案**、添加批注、回复打开的线程、编辑 / 删除自己拥有的批注或回复。
  不能编辑作者创建的批注 / 回复、直接写正文、应用 / 撤回提案、确认 / 拒绝修订、解决 / 重开线程，或改变授权范围。
- 作者解决 / 删除的线程对 AI 停止写入，返回 `thread_closed`。作者需显式重开才能继续。
- 归属依据独立的持久 owner ID，不按名字猜测。迁入的旧 AI 评论仍可读、可回复，
  但没有 owner 映射的旧内容不会因为名字相同而被新连接认领。
- 提案应用要求当前 head 仍是提案 base。旧提案保持可读且可不采用，不能自动覆盖新稿。
  存在未保存草稿时 UI 和发送前检查均禁止应用；等待裁决时主编辑器临时只读。
- 每次 AI 写操作必须携带稳定 commandId；相同 ID + 相同参数重试不会重复写入。
  回执和业务变化一起提交。线程编辑要求读取时的 `expectedUpdatedAt`，追加回复不会整线程覆盖。
- 断开时先标记授权失效，再等待已进入的 SQLite 操作结束，之后关闭监听。
  已获准的操作可能在断开等待期间完成，但断开返回后旧凭证不能再产生写入。

这只是 Margin MCP 的权限边界，不是对外部 AI 客户端其它工具的沙箱。
不要把令牌交给不信任的进程，也不要把它放进仓库、对话公开记录或截图。

## 工具契约

服务只暴露以下 7 个工具，均无需路径或稿件选择参数：

| 工具 | 输入 / 结果 |
|---|---|
| `review_read` | 一致文稿快照：`headId`、`manuscript`、`baselineText`、线程 / 回复和当前轮事件；`you` 说明固定角色 |
| `review_updates` | `after`、可选 `limit`；序列事件、cursor、hasMore、待处理提案。作者裁决可在这里回读 |
| `review_revision` | `revisionId`；读取本稿件的不可变 Markdown，也可读取提案的完整目标内容 |
| `review_proposal` | `proposalId`；base / target、status、baseMatchesHead 与有界 diff 预览 |
| `review_propose` | `commandId`、`baseRevision`、`markdown`；创建 pending 提案，不改 head / baseline |
| `review_comment_add` | `commandId`、`expectedHead`、`quote`、`body`；可选 `blockId` / `prefix` / `suffix` |
| `review_comment_update` | `commandId`、`commentId`、`action`（reply / edit / delete）、可选 body / replyId / expectedUpdatedAt |

工具响应使用 MCP structuredContent；领域错误带 `isError` 和 code / message。
工具写入不接受任意 actor、agent、路径或通用命令。写请求最多 2 MiB；大稿件需报告限制，
不能绕过接口直接编辑数据库。提案预览最多 16000 个字符，截断时 UI 会明确提示。
生成提案建议时的字符差异搜索有时间预算，大改写可能生成较粗的建议范围，但不会截断提案正文。

应用提案后其 status 为 `applied`，不是「作者已接受全部修改」；最终确认以正文基线和
`review_updates` 中的 `decision` 事件为准。`review_read` 的事件仅含当前轮，读取完整交互过程
需要按序列分页读取 updates，不能仅凭一张当前快照判断历史。

## 实现与验证入口

- 核心身份与归属：`crates/edda-core/src/features/margin/agent.rs`，SQLite schema 1 → 2 为增量迁移。
  不自动降级数据库；若要回退旧二进制，应保留升级前的备份。
- 专用 Host / MCP：`src-tauri/src/margin/ai.rs` 与 `ai/tools.rs`；不复用 Edda 的完整工具路由。
- 授权与提案 UI：`src/margin/ai-dialog.tsx`；只读 / 脏草稿保护在 `ai-client.ts` 与审阅组件。
- `cargo test -p edda-core features::margin`：身份归属、同线程人 / AI 互动、CAS、幂等、关闭线程、迁移及原事务回归。
- `cargo test -p edda margin::ai::tests --lib`：真实 HTTP MCP 身份 / 白名单、范围固定、凭证轮换及撤销时的 in-flight 屏障。
- `pnpm test:margin-native`：真实 WebView2 + HTTP MCP + SQLite 闭环，包含一次故意延迟的真实保存，
  验证草稿不暴露给 AI、脏稿禁止应用、保存后旧提案失效、重新提案 / 应用 / 人工接受、共享回复和断开后无写入。

验证使用 MCP 协议客户端模拟 AI 的工具调用，不代表测试过某个实际大模型的生成质量。
多 AI 身份、AI 自动接力、提案三方合并、完整历史浏览与发布权限审计仍不属于本 checkpoint。

本次验证：前端 1441 项通过、5 项跳过；Margin 核心 20 项通过（另有一个供进程中断测试
调用的忽略子进程辅助项），HTTP MCP 2 项通过。类型检查、生产构建、workspace Clippy
`-D warnings` 与真实桌面 smoke 均通过。前端 lint 仍有 7 项既存 warning 和 1 项 info；
生产构建保留较大 chunk 的提示。桌面 smoke 额外检查了 720 × 640 下的提案面板。
