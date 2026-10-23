# Agent（ACP Host）

Edda 作为 **ACP Client**，stdio JSON-RPC 连接用户本机或远端 Agent（BYOA，不托管模型 Key）。

## Edda 身份与任务提示

产品中的科研助手统一名为 **Edda**，ACP agent 指它的运行后端。`prompt/envelope.rs` 在普通任务的公共前缀明确这一身份、逐步协助科研全流程的方向，以及当前阅读 / 修改 / 审阅的能力边界。语气温和、好奇、严谨，不重复自我介绍，不编造进度、实验或验证；中间描述面向科研任务，不播报例行命令、Skill 加载或工具参数。权限请求、可操作的错误及用户明确要求的技术解释仍可给出。

工作流分支、引用规则、问答只读、显式精读授权、语言与个人偏好、MCP 和审阅确认权限沿用原契约。`translate` 仍是纯翻译，不注入身份文案；原生 `/command` 仍绕过 envelope。Vault `AGENTS.md` 模板为 v8，保留数据、工具和写入边界，增加按需查询环境、配置与日志的自检指引；受管理模板按现有版本机制更新，自定义配置沿用既有保护。Host / 前端历史清洗同步识别新身份前缀，聊天记录只显示用户请求。

## 发现、识别与接入边界

接入分为三步，状态各自独立：

1. **发现入口**：`registry/templates.rs` 声明预设 `command` / `args`、可选宿主 `detect_command` 与安装方式；`registry/store.rs` 扫描应用进程 PATH 与常见安装目录。OpenCode 官方安装目录 `~/.opencode/bin` 在本地 GUI 与远端 SSH 共用的 `install_dirs::HOME_BIN_DIRS` 中补齐，不依赖终端 shell 已初始化 PATH。实际 ACP 启动另合并 login-shell 环境。宿主 CLI 已安装不代表 ACP 适配器存在；ACP 入口缺失时，即使注册表曾保存成功探针，也必须显示 `missing`。
2. **协议识别**：`acp/probe.rs` 启动入口并发送 `initialize`，读取 Agent 自报身份、协议版本和 session capabilities。探针不发用户 prompt；自报名称用于展示，功能按能力协商。只有入口可用且探针成功才显示 ACP `ready`。
3. **会话协商**：`session/new` 返回模型等 `configOptions`；Host 据此选择模型、模式、推理强度等，再经 `session/prompt` 和 `session/update` 交换消息、工具、计划与用量。续聊使用 provider session id，并按能力选择 resume / load。

| 接入类型 | 当前入口示例 |
|---|---|
| 原生 ACP | `opencode acp`、`openclaw acp`、`hermes acp`、`qodercli --acp`、`grok agent stdio`、`kimi acp` |
| ACP 适配器 | Claude Code → `claude-agent-acp`；Codex → `codex-acp`；Pi → `pi-acp`（内部调用 `pi --mode rpc`） |
| 专用服务端 / 自定义 | Dsh 的 `dsh-acp-demo`；用户提供实现 ACP 的 `command` / `args` / `env` |

任意 CLI 不会因被添加到注册表就获得 ACP 能力；其入口必须原生实现协议或提供适配器。模型 API、登录凭据、模型执行和 Agent 自身工具由相应框架管理。Edda 负责会话、上下文、事件归一、权限交互，以及按能力提供 terminal / 工作区 MCP。

**ACP ready 不等于认证或模型调用已验证**：通用 `initialize` 没有证明凭据可用的语义，Doctor 对握手成功的通用 Agent 显示认证 `unknown`；明确认证错误显示未登录。本地 Codex 另查 `login status`，未知结果仍为未知。真实模型请求是否成功要看实际回合。

探针结果仅回写同一启动配置：比较 template、command、args 与有效 descriptor env 的摘要，包含注册表注入的 proxy / User-Agent；配置改变或条目删除后，迟到结果被拒绝。设置页与通用 probe 共用 service；代理和 User-Agent 变更清除所有注册项（含自定义）的旧探针状态。修改显示名称不触发失效。

## 协议与运行时

- Crate：`agent-client-protocol`（及 Codex 的 npm ACP 适配器进程）。
- ACP `initialize` 在 run / warm / 历史 list / load 四处统一最多等待 30 秒（设置页
  探针同样保留 30 秒总预算），覆盖 BYOA 冷启动；其余 session RPC 保持 15 秒预算。
- 会话 `cwd` = 当前 Vault 根（远程则为远端 Vault 根），下发给 Agent 前经
  `simplified_agent_cwd` 归一一次（run / warm / list / load 四处入口）：Windows 把
  canonicalize 出的 `\?\D:\...` 还原为 `D:\...`，否则 Agent 把该路径转交给 MSYS2
  shell（Git Bash）时无法 `cd`，POSIX cwd 也会初始化错误，`mktemp`/`cd` 报 ENOENT；
  扩展 UNC（`\?\UNC\...`）与 POSIX 路径保持不变，远程历史入口不做本地路径转换。详见
  [bug_fix/hermes-terminal-pending-msys2-hang.md](../bug_fix/hermes-terminal-pending-msys2-hang.md)。
- 本地 Pi / 自定义 Agent 仍先经 shell 切到 Vault，其 `cmd.exe` 包装对同一前缀再剥一次
  （幂等），避免 CMD 把 `\?\D:\...` 误判为 UNC（#458）。
- Windows 的 cwd 与完整 Agent 命令通过环境变量展开，避免 Rust argv 转义破坏 CMD 内层引号；
  cwd 环境变量始终携带双引号，防止无空格路径中的括号等 CMD 元字符被当作语法（#458）。
- **Login-shell 环境注入**：本地 ACP agent 启动时会合并当前进程环境变量、用户 login-shell
  环境变量（`SHELL -lic 'env -0'`）以及 `AgentDescriptor.env`。这样 macOS/Linux 上从
  GUI 启动 Edda 也能读到 `.zshrc` / `.bashrc` 里 `export` 的 `OPENAI_API_KEY`、
  `OPENAI_BASE_URL` 等变量；`AgentDescriptor.env` 优先级最高，可覆盖 shell 值（#478）。
- 统一接口：OpenCode、OpenClaw、Hermes、Claude ACP、Codex ACP、Qoder、Grok、Pi、Dsh（DeepSeek Harness）、Kimi Code、自定义 `command`/`args`/`env`。
- Dsh：ACP 服务端是 `@deepseek-ai/dsh-acp-demo`（npm 包），与依赖插件一起固定
  `0.1.1-rc.2`。安装/启动三处入口，检测按序回退：
  1. App 管理目录 `~/.edda/dsh-acp/node_modules/.bin/dsh-acp-demo`（设置页「安装」按钮，
     Rust 写入默认 `cordis.yml` + 最小 `package.json` 后执行 `npm i`；`package.json`
     防止 npm 沿目录树向上找到用户 `~/package.json` 把包装进 `~/node_modules`）；
  2. 用户 home npm 根 `~/node_modules/.bin/dsh-acp-demo`（手动 `npm i` 且 home 有
     `package.json` 时）；
  3. PATH 上的全局 `dsh-acp-demo`（`npm i -g`）。注意：`npm i -g @deepseek-ai/dsh`
     是 umbrella CLI，**不带** ACP 服务端，不作为检测目标。
  - 启动走 shell 包装（`bash -c` / `cmd /C`）`cd` 进 launcher 目录后 exec——ACP stdio
    spawn 无 cwd 字段，而 `cordis.yml`、`.env`、session 持久化都相对该目录解析。
  - 会话在进程内，进程退出即失效，且不声明 `session/resume` / `session/load`：
    多轮续聊降级为**每轮新会话**（单发式），Host 不再报「不支持继续会话」。
  - API Key：在 launcher 目录 `.env` 写 `DEEPSEEK_API_KEY`，或在注册项 env 中
    export。缺少时 prompt 报 `no API key for provider route "deepseek-official"`。
    `dsh-acp-demo` 只读启动 cwd 的 `.env` + 启动环境：它**不读** `~/.dsh` 的
    凭据存储（`.credentials.yaml` 需在 `cordis.yml` 挂载 credentials provider，
    `~/.dsh/.env` 的 user-env 层只有官方 `dsh` CLI 的 `loadLayeredEnv` 加载），
    所以官方 CLI/Web UI 里配过的 key 对 ACP 服务不可见，须复制到 launcher `.env`。
- Kimi Code：原生 ACP（`kimi acp`）。官方 installer（`code.kimi.com/kimi-code/install.sh`）
  是单二进制、默认装入 `~/.kimi-code` 并写 PATH 进 shell rc；npm 包
  `@moonshot-ai/kimi-code`（需 Node 22.19+）作回退。`kimi upgrade` 是交互式的，静默
  `update` 重跑幂等的官方 installer。登录在终端完成（`kimi` → `/login`，OAuth 或
  Moonshot API key），skill 走 slash mention。
- Pi：无原生 ACP，走社区适配器 `pi-acp`（内部 spawn `pi --mode rpc`）；detect 用 host `pi`、
  ACP 入口用 `pi-acp`。pi 的 skill 以 `/skill:<name>` 暴露，故 Edda 不发 `/<name>`
  mention，只注入 `SKILL.md` 正文。
- Pi 启动横幅：`pi-acp` 在 `session/new` 后把 pi 的启动信息（`pi vX.Y.Z` +
  `## Context` / `## Skills` / `## Extensions` 清单）当作普通 agent message 推送。Host
  在本轮首个 message chunk 上识别该横幅并丢弃，不写入内容缓冲、不发 `agent:stream`，
  避免它出现在回答之前。
- 设置页会将 ACP 探测中的认证错误（如 `invalid_grant` / `failed to authenticate` /
  `authentication required` / `not logged in`）
  显示为「未登录」，其他握手或进程错误仍显示为「ACP 失败」。
- 后台熔断（`AgentWarmGate`）：`agent_warm` / `agent_list_sessions` 失败后进入
  120s 冷却，冷却期内直接返回上次错误、不再 spawn；成功或用户消息
  （`agent_run_once`）成功后清除。详见
  [bug_fix/gemini-login-browser-loop.md](../bug_fix/gemini-login-browser-loop.md)。

```text
spawn 用户配置的 agent
  → ACP initialize（读 loadSession / sessionCapabilities.resume）
  → session/new  或  继续：resume 优先，否则 session/load（Grok 仅 load）
  → available_commands_update → `agent:commands`
  → build_prompt（workflow + 可选 agentPersonalPrompt）
  → session/prompt → 流式 agent:stream
  → 权限请求 → 前端（ask 模式）
  → 完成（含 providerSessionId）/ 失败
```

流式 chunk 合并（`runtime/stream.rs`）：agent 通常每秒推 20–100 个小 chunk，
逐条 emit 会让 webview 每 token 重渲染一次（Windows 卡顿主因）。Host 用
~40ms 窗口合并连续同 kind 的文本 chunk 再发 `agent:stream`；kind 切换
（message ↔ thought）、tool/plan 等有序事件、`agent:completed` / `agent:failed`
之前都会先 flush，保证顺序与文本无损。`agent:tool` 的 `input`/`output` 超过
32KB 时截断为「头部 + truncated 标记」（前端只做预览渲染）。

ACP trace 对非 JSON 诊断行保留最多 120 字节的 UTF-8 完整前缀，再附省略号；中文 / emoji 启动日志不会因按字节切片跨字符边界而触发 panic。

ACP `terminal` 能力：Host 在 initialize 时声明 `terminal: true`，并本地实现
`terminal/create`、`terminal/output`、`terminal/release`、`terminal/wait_for_exit`、
`terminal/kill`。每个 ACP 连接持有独立的 `AcpTerminalManager`，按 `TerminalId`
管理子进程；每个 terminal 由单独任务独占 `Child`，`wait_for_exit` 不占 manager
锁，`kill` / `release` 通过控制通道保持可用。ACP 消息分发本身是串行的，因此
wait / kill / release 在分发时先获取或移除句柄，再经 `connection.spawn` 完成响应，
避免等待退出时堵住同连接后续请求。`terminal/output` 只快照当前缓冲区，
不会等待进程退出；输出按 `outputByteLimit` 从头部截断并保证 UTF-8 字符边界。该能力
让 Kimi Code 等需要执行 shell 命令的 Agent 可以在 Vault 工作目录下运行命令并
读取结果。

run / warm / list / load / probe 共用 `edda_acp_builder!`（name + terminal
handler）；各入口自行挂 notification / permission 回调。

**warm 与空会话**：模型列表来自 Session Setup 的 `configOptions`（协议不在
`initialize` 提供），故 warm 仍需 `session/new`。连接与 session 进入 warm pool 供下一轮复用；真正空闲 10 分钟、连接关闭或被替换时回收。回收时，只有从未使用且 Agent 声明 `sessionCapabilities.delete` 的空会话才调用 `session/delete`；未声明时仅记 debug 日志。

- 存活判断同时检查 stop 信号、keepalive 接收端是否仍存在及 incoming EOF。SDK 的 `is_incoming_closed()` 只表示输入 EOF，不能证明驱动任务仍在运行。
- 复用键包含 agent id、Vault cwd、远端类型 / host / work-root，以及 template / command / args / descriptor env 的 SHA-256 摘要。配置不同不会取到旧连接或旧模型缓存；显示名称和 env 插入顺序不影响复用。业务 CLI 环境注入已移除，Agent 原有环境合并仍保留。
- 空闲回收在等待删除空会话前即发布失效信号；发布与安装活动 turn 共用 registry 锁，取出连接后再检查一次。模型长时间思考或等待权限时仍有活动 turn，不按空闲超时回收。
- pooled 路径的 pre-prompt 失败回退一次冷启动；SDK 明确报告 `failed to send outgoing request session/prompt: connection is no longer running`（实际 method 带反引号）时，请求尚未入发送队列，也走该回退并保留原续聊 ID。EOF、超时或已发出请求后的失败不自动重放，避免重复工具操作。
- 最终失败在 `agent:failed` 之外写入本地 warn 日志，带 runtime session id。复盘：[ACP warm 连接生命周期](../bug_fix/acp-warm-connection-lifetime.md)。
- 新草稿 / 切到另一页面的新讨论只复用 transport：如果 pooled session 已使用且请求没有 resume id，必须先 `session/new`，不能直接向旧 session 发 prompt。只有从未使用的 warm session 才能直接承接新草稿；明确续聊仍按 provider id 复用 / load / resume。

Kimi Code ACP 会把 `Bash`/`Glob`/`Grep` 等工具实现为 `terminal/create`。[当前实现](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/acp/tools.py)
会把完整 shell 文本放进 `command`；Host 对可解析的可执行文件继续按 `command + args`
直接 spawn，对无法解析且没有 `args` 的命令在 Windows 用 PowerShell、Unix 用
`/bin/sh -c` 执行，以兼容 `pwd`、`echo ...` 等 shell 命令；请求没有显式 `cwd`
时使用当前 ACP session 的 Vault cwd。若 Host 没有声明 `terminal` 能力，或 Kimi Code 版本过旧，这些工具会
直接失败并报 `ACP runtime only supports interactive Bash tool processes`。
此外 Kimi Code 的权限请求目前只返回通用 `"bash"` 字符串（[MoonshotAI/kimi-code#800](https://github.com/MoonshotAI/kimi-code/issues/800)），不会给出具体命令，因此 Edda 默认的 Restricted 策略会拒绝、Ask 模式也只能看到 `bash`，需要用户在 Kimi 侧或 Edda 侧开启自动批准（YOLO）才能静默执行。

多轮续聊必须传 **provider session id**（不是 Edda runtime id）。Grok Build ACP
声明 `loadSession: true`、**不**声明 `resume`；对 Grok 调用 `session/resume` 会
`Method not found`，Host 应改走 `session/load`。

生成中取消时，只要 provider session 已创建或本轮正在恢复，取消结果仍携带 `providerSessionId`。前端保留该 ID，并写回视觉批注 mark，使下一条消息和重启后的 pin 续聊继续同一会话；在 `session/new` 返回前取消时尚无可恢复的 provider session。

`session/load` 会把历史以 `SessionNotification` 回放。Host 在
`session/prompt` 之前 **suppress** 回放中的 stream/tool/plan（不 `agent:stream`、
不写入本轮 content buffer），避免第二轮气泡开头重复上一轮回答；usage /
commands / config 仍可在 load 期间转发。

`agent_load_session` 在 `session/load` 返回后等待回放通知**静默**（200ms 无新
通知即返回，最长仍封顶 800ms），替代此前的固定 800ms sleep；回放通常在
response 前/后很快推完，空会话与短会话因此显著更快（#271）。

回放聚合（`ReplayBuilder`）会丢弃 Agent 侧的合成占位文本：Claude Code 在
turn 未产生回复（如被中断）时会往 transcript 里拼接合成 assistant 消息
（"No response requested."、"[Request interrupted by user]" 等），
`claude-agent-acp` 等适配器在 `session/load` 回放时原样转发。这些占位不是
真实回答，Host 在聚合历史行时按整段精确匹配过滤，避免被当作 Agent 回复渲染
（#411）。

`agent_list_sessions` 必须**跟随 `nextCursor` 翻页**。codex-acp 按全局时间窗口分
页、再在每页内部按 `cwd` 过滤，因此属于当前 Vault 的会话会散落在多页里，中间
夹着大量「空页但仍有 nextCursor」的页。只取第一页会让 Codex 历史只剩少数几条、
甚至完全为空（#338）。Host 在单条 ACP 连接内走完 cursor，按 `sessionId` 去重，
并受三重封顶保护：5s 预算、200 页、500 条；因未走完而中断时把 cursor 一并返回。
cursor 不再推进（`next == prev`）时视为走完，避免死循环。

## 命令（摘要）

| Command | 说明 |
|---|---|
| `agent_probe` / `agent_warm` | 探测与预热 |
| `agent_run_once` | 发起一轮；`sessionId` 时按能力 resume 或 load；可选 `images[]`（base64 + mime）→ ACP `ContentBlock::Image` |
| `agent_list_sessions` / `agent_load_session` | 会话历史 |
| `agent_list_skills` | Vault skill 列表 |
| `agent_respond_permission` | 回答权限请求 |
| `agent_respond_elicitation` | 回答 form elicitation（Codex `request_user_input`） |
| `agent_respond_ask_user` | 回答 Grok `_x.ai/ask_user_question` |
| `agent_run_tool_lifecycle` | 静默安装/升级/卸载 catalog CLI（及 Claude/Codex ACP 适配器）；本机 lifecycle 串行执行，设置页在对应 Agent 行内展示安装 / 扫描 / 探测进度（#250），Windows 使用唯一临时 `.bat` 并按 UTF-8/GBK 解码错误输出；安装失败会将 npm 缓存目录 EPERM 转成可操作的缓存迁移提示；Windows 探测 `.exe` 时校验 PE 头，避免把文本 shim 当作 16 位程序执行；`uninstall` 做 best-effort npm 卸载 + 受管目录删除（不改 shell rc），成功后联动删除 catalog 注册项；见 [api.md](api.md) 与 [#225](https://github.com/poco-ai/Agentero/issues/225) |
| `agent_check_catalog_updates` | PATH scan + 版本对比：本地 `detect --version` vs npm latest（或 dsh pin）；写入 `installedVersion` / `latestVersion` / `updateAvailable`。设置页「升级」仅在 `updateAvailable === true` 时显示；hermes 等无稳定 npm 源或探测失败时不显示。不塞进同步 `agent_scan_catalog`（避免 Doctor / 切换器打网络） |
| `agent_tool_lifecycle_supported` / `agent_tool_install_commands` / `agent_tool_uninstall_info` | 是否支持静默安装；平台手动安装文案；卸载清理项清单（确认对话框展示） |

ACP slash command 不是独立的 `session/compact` RPC。Host 转发 Agent 广播的
`available_commands_update`；前端提交命令时设置 `isAcpCommand`，Host 跳过
Edda prompt envelope、skill/context 注入，并将原始 `/command` 作为
`session/prompt` 发送到当前 provider session。

## 权限

全局 `agentPermissionMode`，前端经 `runOnce({ permissionMode })` 下发（优先字段；
旧 `autoApprove` 仅 Host 侧兼容读取）：

| 模式 | 行为 |
|---|---|
| `restricted` | 默认；收紧写/敏感操作 |
| `ask` | `agent:permission-request` → 用户选择 → `agent_respond_permission` |
| `auto` | 自动批准策略项 |

## Elicitation（不稳定协议）

- Host 依赖 `agent-client-protocol` feature `unstable_elicitation`。
- `initialize` 声明 `elicitation.form`，否则 codex-acp 对 `request_user_input` 直接返回空 answers。
- 收到 `elicitation/create` → 事件 `agent:elicitation-request` → 前端表单 → `agent_respond_elicitation`。

## 结构化提问（多 harness）

ACP **没有**统一的 ask-user tool 规范：各 harness 的字段名、挂载点（tool / elicitation / ext method）都不一样。Edda 作为 ACP Client 做三件事：

1. **打开交互能力**：`initialize` 声明 `elicitation.form`（依赖 crate feature `unstable_elicitation`）；否则 Codex 等对 `request_user_input` 会直接空答。
2. **Client adapter 归一**：把不同 rawInput / 事件解析成同一套 `AskUserQuestion` 页（`parseAskUserQuestions` 等），前端只渲染一张表。
3. **Harness 特例**：OpenCode spawn 时注入 `OPENCODE_ENABLE_QUESTION_TOOL=1`；Grok 的 `_x.ai/ask_user_question` 由 Host JSON-RPC 处理（`acp/ask_user.rs`），再经 `agent:ask-user-request` / `agent_respond_ask_user` 与前端对齐；tool 镜像与 ext 去重。

| Harness | 形态 | 回答通路 |
|---|---|---|
| Codex | tool `variant: AskUserQuestion` 或 elicitation form | tool → 提升到 **底部问卷** → 下一用户轮；elicitation → `agent_respond_elicitation` |
| Claude | tool `questions[]`（含 Other 伴生页合并） | 同 tool 提升 → 下一用户轮 |
| OpenCode | tool `question` → `questions[]` | 同 tool 提升；spawn **默认 env** `OPENCODE_ENABLE_QUESTION_TOOL=1`；turn 阻塞时 cancel+drain 立刻送出答案 |
| Grok | ext method `_x.ai/ask_user_question` | Host → `agent:ask-user-request` → `agent_respond_ask_user`；与 tool 镜像去重 |

**UI 约定**：可交互表单只在 **`AgentAskUserSurface`（底部问卷）**；与 free-text composer **互斥**；transcript tool 卡不嵌选项。优先级 elicitation > Grok ext > tool 提升。

详见 [frontend/agent.md](../frontend/agent.md)。

## 工作流与 Skill

- **工作区 MCP**：本机支持 HTTP MCP 的 Agent 在 new / load / resume 时自动获得 `edda-workspace`。业务操作通过结构化工具，读取 Markdown/TeX 用原生文件工具或 `paper_read_source`。不再捆绑、探测或注入业务 CLI；不支持工作区 MCP 的连接明确说明能力缺失。固定 Vault、生命周期与权限见 [mcp.md](mcp.md#应用内-agent-自动接入)。原生 `/command` 保持原样，闭合翻译不追加工作区能力提示。
- **Agent 插件（用户 MCP 服务器）**：设置 `agentMcpServers`（名称 + `url` 走 Streamable HTTP，或 `command` / `args` / `env` 走 stdio）。装配层把启用项镜像进 Agent 侧的 `AgentPlugins`（`features/agent/plugins.rs`，与代理设置同一订阅模式，Agent 不直接读设置）；`workspace_tools::connect` 产出的 `WorkspaceConnection` 同时携带工作区工具与插件，new / load / resume 统一经 `servers()` 下发。stdio 插件总是下发（ACP 要求 Agent 支持），HTTP 插件仅在 Agent 声明 `mcpCapabilities.http` 时下发；远程 SSH 会话不带插件（命令与地址只对本机有效）。改动在新会话生效。
- workflow：`summary` / `qa` / `related_work` 等；由请求上下文或调用方指定。面板不再展示空态预设提问。
- `library`：文献库及其它管理页面的默认工作流，侧重检索、组织与管理文献；当前页面作为 context-only 标识传入，不把 `edda:library` 等虚拟路径当文件。论文页默认 `qa`，本轮显式论文引用可覆盖管理默认；前端的页面会话作用域独立于工作流与临时附加来源。
- `translate`：**不套 envelope**（无 `## Sources`、无 CLI 政策、不注入回答语言与个人偏好）。翻译 prompt 自己已指定目标语言并要求「只返回译文」，envelope 会与之冲突。
- Skill：Composer 选中的 `SKILL.md` 统一直接提供正文与支持文件目录，标为已加载的 `skill:id`。不再同时合成 `$id` / `/id` 激活提示，也不要求再查同名原生 Skill；Vault 内目录用相对路径，用户全局 Skill 给出实际目录。显式 ACP `/command` 仍由原生 Agent 处理。回答以任务结果为中心，不宣告常规 Skill 加载或 CLI 检查。
- paper-reader：v9 仅用于本轮显式精读调用或整篇精读笔记请求，直接执行已提供的正文；普通问答不触发。使用工作区 MCP，完成笔记后标记已读。输出排版见 [frontend/agent.md](../frontend/agent.md#精读paper-reader)。
- paper-qa：v3 将协议缩短为自然回答、按需取证、准确引用与默认只读；完整引用翻译直接回答，缺上下文才使用原生文件或工作区工具。未播种时 Host 内嵌回退，本地同名 Skill 优先；前端按指令版本刷新旧会话，同版本不重复注入。不自动写 Ask marks。
- Host `build_prompt` envelope 负责本轮 workflow 角色、回答语言、个人偏好、`User request`（`paper_reader` 另带激活句）；QA 额外提醒沿用已提供的工作流、完整引用无需强制读取来源。引用格式、CLI 政策、论文阅读顺序仍在 `AGENTS.md` / Skill 中；cwd 为 vault 根时 Agent 自载 `AGENTS.md`。
- `agent_prompt_prepared` 本地日志记录 workflow、Skill id、注入字符数及是否含原生激活提示，便于区分「已注入」和原生 Agent 后续自行选择工具；不记录 prompt 正文。该提示不是 provider 端的 Skill 禁用开关。
- 引用约定（`AGENTS.md` / `paper-reader`）：**阅读**可用 TeX/`PAPER.md`，citation **href 优先本地 PDF + fragment**；笔记用 `[[papers/<id>/NOTES]]`；不加外层 `([…])`、不用文末 `## Sources`。前端负责 pill 渲染、`.tex`→PDF 回退，以及残留 `blocked` 标签的显示兜底。Host `agent_resolve_citation`：`#figure=N` 在 caption 任意位置匹配 `Fig./Figure N`；`#section=N` 认阿拉伯与 IEEE 罗马章节号（如 `3`↔`III.`），纯数字不走模糊 overlap；失败时前端按 fragment 类型 Toast（短分类 + source）。
- 自由模型选择：`preferred_model_id` 可指向 ACP catalog 外的任意模型 id；Warm / Run 时始终尝试 `session/set_config_option`，失败不阻断会话。

## 模型协商

- `session/new`（及 config 更新）中的 `SessionConfigOption`（category=Model 或 name 回退）解析为 `agent:models`。
- 若 `current_value` 不在 selector 选项中（第三方网关 / cc-switch 等只改默认 model、目录仍是官方列表），Host **注入**该 current id，避免 UI 丢失。
- `preferred_model_id`（warm / run_once）在与 current 不同时 **始终尝试** `session/set_config_option`，不要求 id 已在上报列表中；失败仅 debug 日志，不阻断会话。
- Codex `collaboration_mode`（Default / Plan 等）解析为 `agent:collaboration`；`collaboration_mode_id` 在选项内且与 current 不同时尝试 `session/set_config_option`。UI 称「模式」。Plan 才能用 `request_user_input`。不解析 / 不暴露 ACP `category: mode` 沙箱档。
- 推理强度：识别 `category: thought_level`（兼容 id `reasoning_effort` / `effort`），转为 `agent:effort`。默认值和支持的档位由 Agent/适配器决定，ACP 不规定 low/high 枚举或跨会话持久化；前端保存用户选择；面板无已存选择时传 `preferHighestReasoningEffort: true`，Host 在模型和模式协商完成后选择最高可识别档位，覆盖 warm 未完成就发送的首轮。显式 `reasoningEffort` 优先；未知档位无法排序时不覆盖 Agent 当前值，其他调用者缺省不开启此策略。`run_once` 在 new/resume/load 后、prompt 前应用 `reasoningEffort`。先完成模型和模式切换、读取完整 `configOptions`，再仅对仍在列表中且与 current 不同的档位调用 `session/set_config_option`；不支持时沿用 Agent 当前值。参见 [ACP Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options)。
- Fast 开关（`fast-mode` model_config 选项）与上述一致：仅当会话当前值与请求值不同时才发 `session/set_config_option`，未变化的配置不再每轮重复下发（#271）。

## User-Agent（中转站亲和）

部分中转站用 `User-Agent` 做客户端亲和（new-api Codex 通道常见 `codex-cli/<version>`；Claude 侧常见 `claude-cli/*` / `claude-code/*`）。

Edda 是 ACP **Client**：模型 HTTP **不**经 Host 转发，因此只能在 **spawn ACP 子进程时** 注入 env/config（与 bb 等 Host 一致），不能像 cc-switch 本地代理那样中途改头。

- 设置 → Agent → **User-Agent**（预设下拉 + 可手填）+ **Codex Provider id**（可选）。
- Host 在 registry snapshot 时按模板注入：
  - 所有模板：`EDDA_USER_AGENT=<value>`
  - `codex-acp` / `custom`：`CODEX_CONFIG.model_providers.<id>.http_headers.User-Agent`
  - `claude-acp`：`ANTHROPIC_CUSTOM_HEADERS` 中 upsert `User-Agent: …` 行
- Codex Provider 目标：显式列表；否则 `CODEX_CONFIG` 已有 keys、`MODEL_PROVIDER`、或回退 `openai`。
- 远程 SSH 转发：`EDDA_USER_AGENT` / `CODEX_CONFIG` / `MODEL_PROVIDER` / `ANTHROPIC_CUSTOM_HEADERS`。
- 命令：`agent_set_user_agent`；`agent_scan_catalog` 回传当前值。

说明：是否生效取决于底层 Agent 是否认上述 env/config；OpenCode/Grok 目前仅带 `EDDA_USER_AGENT`（多数忽略）。

**new-api 侧（源码）在做什么：**

- 读的是 **客户端请求** 的 `User-Agent`（`c.Request.UserAgent()`），不是 model id。
- 通道亲和规则可选 `user_agent_include`：子串匹配（大小写不敏感）；**默认规则该项为 nil = 不按 UA 过滤**。
- Codex 默认亲和规则还匹配路径 `/v1/responses`、模型 `^gpt-.*$`，并把客户端的 `User-Agent`、`Originator`、`Session_id` 等 **透传** 到上游。
- new-api **自己** 调上游 Codex 模型列表时会设 `User-Agent: codex-cli/<version>`（`service/codex_models.go`）——那是网关出站，不是你的客户端。

因此：若限制来自「亲和规则要求 UA 含 `codex-cli`」或上游看透传 UA，我们的 spawn 注入 **有机会** 解决；若还校验其它 Codex 专有头/路径/鉴权形态，仅改 UA **不够**。

## 注册表（非模型 BYOK）

配置「如何启动本机 Agent」：id、name、template、command、args、env、默认 id、可选 User-Agent。  
持久化在应用配置目录；**不**要求填写模型 API Key。

## 远程

远程 Vault 时在 **SSH 远端** 启动 Agent。见 [remote.md](remote.md)。远程 agent catalog 的扫描/探测/安装命令属 agent 域（`registry/remote.rs` + `commands/remote.rs`），复用 `agent::models` / `probe_agent` / `templates`；agent 域不直接依赖 `integration::remote`，而是经反转 trait `agent::remote_host::{RemoteAgentHosts, RemoteAgentLaunch}`（由 remote 域 `RemoteRegistry` / `RemoteSession` 实现，app 启动时注册为 State）走 SSH。命令壳与 bridge RPC 共用 `agent::service` 门面。

## 代码

`src-tauri/src/features/agent/`  
前端：[../frontend/agent.md](../frontend/agent.md)
