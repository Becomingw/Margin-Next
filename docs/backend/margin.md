# Margin 事务文档后端

独立 Margin 使用 `crates/margin-core/src/features/margin/`，桌面壳为
`src-tauri/src/margin/commands.rs`。上游 Edda 的 `features/review/` 文件型服务仍保留，
但不再注册到 Margin 的运行时。前端通过 `src/lib/review/api.ts` 注入适配器，
不要求 Plate 知道数据库布局。

单 AI + 人的当前验收边界和接入方法见 [checkpoint](../margin-single-ai.md)。

## 权威与事务

- 每稿一份 `.margin/documents/<id>/review.sqlite`，不初始化 Edda Vault 或 catalog。
- `document.head` 是当前正文版本，`document.baseline` 是当前比较基线；两者只改指针。
- `revisions` 保存完整 Markdown、父版本、哈希、时间和来源；SQL 触发器禁止更新 / 删除。
- `proposals` 绑定 base / target 版本及作者，`suggestions` 保存不可变的文本范围和增删内容。
  `comparisons` 将某一 baseline / head 对绑定到稳定 proposal / suggestion ID；重读不会换 ID。
- `decisions` 记录裁决前后 head / baseline、比较提案及选择范围；稳定 ID 裁决还记录 suggestion ID。
- `threads` 保存独立线程 ID、初始锚定版本、当前锚定版本与线程内容；回复有独立 ID。
- schema 2 的 `reviewer` 单槽身份与 `entity_owners` 保存可信归属；schema 1 在事务中增量升级，
  不重写旧修订。显示名不是权限标识，旧 AI 内容没有 owner 映射时不能只按名字认领。
- `events` 是递增序列的追加日志；`receipts` 保存命令哈希、原始提交序列、head 与结果 ID。
  回执不重复保存整个正文 / 历史，避免每次保存产生平方级冗余。
- 写入使用 `BEGIN IMMEDIATE`，启用 foreign keys、WAL、`synchronous=FULL` 和 busy timeout。
  正文、比较指针、线程锚点、裁决、事件和回执在同一事务提交后才返回成功。
  跨连接 / 进程靠 SQLite 锁和版本校验，不依赖进程内 mutex。

正文与基线读取在同一只读事务中完成，校验版本内容哈希。活动稿件不写一份独立的
`manuscript.md`：编辑器路径只是资源标识，实际种子通过 `margin_open` 获取。
引用图片 / PDF 仍是文档目录里的普通附件；当前没有二进制附件版本管理。

## IPC 与命令

只读 / 导入导出：`margin_create`、`margin_import`、`margin_list`、`margin_open`、
`margin_stamp`、`margin_diff`、`margin_revision`、`margin_export`、`margin_parse_pdf`、
`margin_updates`、`margin_suggestions`、`margin_proposal_detail`。所有文档命令先检查工作区是否已经由
`margin_open_workspace` 授权；目录、数据库和迁入资源检查 canonical containment。

`margin_ai_start` / `margin_ai_stop` / `margin_ai_status` 负责单稿件的显式外部 AI 授权。
这个 MCP 只提供固定白名单，写入走 `execute_as_agent`，与本机作者的 `execute` 分离；
AI 不能调用通用 `margin_command`，也不能提供自己的 actor 身份或选择其它文件 / 稿件。

写入统一入口：

```json
{
  "vaultPath": "<opened workspace>",
  "reviewId": "doc-…",
  "commandId": "<unique stable retry id>",
  "request": { "kind": "…" }
}
```

`margin_command` 的 `request.kind`：

- `save`：`expectedHead`、`lastSaved`、`markdown`、可选 `anchors`。head 和原文都匹配才保存，
  所以正文经历 A → B → A 也不能绕过旧 head 的校验。作者保存自动产生不可变版本和来源提案。
- `decide`：`expectedStamp`、`reason`（`accept-change` / `reject-change` / `accept-all` /
  `reject-all`）、`nextBaseline`、可选 `nextManuscript`。用于保留现有编辑器的可视化选区适配。
  后端验证候选必须是权威 baseline → head 的部分文本裁决，不能引入新正文；接受 / 拒绝均受版本校验。
- `resolve-suggestions`：`expectedStamp`、`comparisonId`、`suggestionIds`、`action`
  （`accept` / `reject`）。推荐给直接集成服务的客户端：后端按稳定 ID 计算文本补丁，
  不接受客户端自行生成的整份正文；旧比较对上的 ID 不可用于新 head。
- `propose`：`baseRevision`、`markdown`、可选 `agent`。可基于较旧的不可变版本提交，
  只创建 pending 提案与事件，**不动正文或基线**。
- `apply-proposal` / `dismiss-proposal`：`expectedStamp`、`proposalId`。应用还要求当前 head
  等于提案 base；过期 / 重叠提案明确报冲突，不做猜测性合并。应用提案也不自动确认基线。
- `comment-add`：`expectedHead`、`input`；`comment-update`：`commentId`、`action`、
  可选 `body` / `replyId` / `expectedUpdatedAt`。追加回复可并发，其它变更使用线程 CAS；
  单毫秒内连续变更也会获得不同的更新时间。事件保留线程变更前后内容。
- `rename`：`expectedStamp`、`title`；`parsed-pdf`：`expectedStamp`、`markdown`；
  `observe` 是旧前端生命周期兼容的无操作，不读取文件来建立第二个权威源。

相同 command ID + 相同请求只产生一次效果；同 ID 携带其它请求报 `command_reused`。
重试响应携带**当前**视图与原始 `acknowledgedSequence` / `acknowledgedHead` / `commandResult`，
不重放旧视图覆盖新状态。前端丢失 IPC 回执时复用 ID；若恢复保存回执时正文又更新，
保留草稿并报冲突，不把远端版本当成自己已保存的正文。

`margin_updates(after, limit)` 返回带序号事件、下一 cursor、当前 sequence、hasMore、
pending 提案及当前 comparison ID；事件与 suggestion 每页最多 200 条。
suggestion 范围采用 **UTF-8 字节偏移**，不能直接当 JavaScript UTF-16 字符索引。
当前界面仍轮询小型 sequence，变化后读取一致快照；未改成实时推送或协作网络协议。

## 编辑器保护

前端保存的 expectedHead 来自编辑器实际加载 / 上次确认的种子，不能用轮询读到的新 head
冒充脏草稿的 base。裁决请求期间正文暂时只读，防止等待回执时输入又被重载覆盖。
轮询仅在草稿仍干净时采纳新快照；视图按 sequence 防止乱序响应回退。
裁决携带点击时捕获的 sequence，不能在异步生成候选后换成轮询得到的新版本。
线程 / 回复编辑同样保留进入编辑时的版本，不用后来收到的 props 版本冒充旧草稿的 base。
Word 式行内增删、批注、回复和单处接受 / 拒绝保留，修改装饰不写入 Markdown。

## 迁入、备份与恢复

- 旧 `reviews/<id>` 只读读取：验证原路径、复制参考 PDF / assets，迁入正文、基线、旧快照、
  线程和事件。旧版本 ID 到新不可变快照的映射保存在 `legacy_revisions`。
- 不修复或覆盖旧文件，不与旧路径双向同步；旧数据本身已经覆盖掉的历史无法凭空恢复。
- 导出用 `VACUUM INTO` 获取含 WAL 已提交内容的一致独立库，同时导出当前 Markdown、基线、
  可读 JSON 摘要、带批注的 `REVIEW.md` 与附件。导出库去掉本机迁入来源路径；仍含完整审阅历史，包括已删评论 / 旧正文。
- 导出的 `review.sqlite` 可通过导入恢复为新 ID，校验 schema 版本、integrity 和外键；
  完成恢复后才发布数据库文件，不覆盖同工作区已有稿件。
- 备份运行中的数据库请用导出，不要只拷贝 `review.sqlite` 而遗漏 WAL。

## 验证与边界

`cargo test -p margin-core features::margin` 覆盖并发写入、旧版本拒绝、不可变快照、
回执幂等、稳定 suggestion、提案隔离、线程 CAS、Unicode、空文本、迁入 / 导出 / 恢复。
子进程测试在未提交事务内直接退出、不运行析构，然后重开库验证回滚与 integrity。
`pnpm test:margin-native` 使用真实 WebView2 + SQLite 跑保存、模式 / 草稿保护、逐处及批量裁决、
批注 / 回复、导出和过期保存拒绝。

单 AI 授权、共享线程与提案面板已接通；尚未实现：多 AI 身份 / 自动协作、历史浏览前端、提案三方合并 / 自动 rebase、
协作身份认证、附件版本化及数据库历史压缩。当前仍保存完整 Markdown 版本，长稿多次保存
会增加磁盘占用；没有声称具备 Word 文件格式兼容、CRDT 或旧 Margin 的 LaTeX 字节保真。
