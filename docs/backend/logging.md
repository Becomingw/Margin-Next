# 运行日志

| 层 | 实现 |
|---|---|
| Host | `tauri-plugin-log` + `log`；`crates/edda-core/src/log_util.rs` |
| 前端 | `src/lib/core/logger.ts` |
| CLI | `env_logger` |

- 与用户 Toast / `ApiResult` **分层**：日志不替代错误 UX。
- 关键操作记录 op start/end。
- Host `OpTimer` 的 start/end 带进程内唯一 `op_id`，前端 `logOp` 同样带操作 id；前端日志带窗口 label。它们分别关联各自层内的操作，不宣称已经具备跨 IPC 的统一 trace id。
- Release 也采集前端未捕获异常及未处理 Promise 拒绝；错误文本做常见 Bearer、API key、密码及 URL 凭据脱敏。这里只是兜底，调用方仍不得记录完整设置、提示词、正文或请求头。
- 窗口日志区分 close-requested / destroyed 与辅助窗口级联关闭；Agent prompt 日志关联 Edda session、provider session、Agent id、请求的模型/思考档位、MCP 是否就绪、取消及结束原因。请求模型不是上游实际采用模型的保证。
- MCP 接入记录成功或不可用原因（远程工作区、Agent 不支持 HTTP、非本地 Vault、启动失败）。服务端不能知道严格客户端是否最终接受工具目录，不能把 endpoint ready 当成客户端注册成功。
- 前端启动：`main.tsx` 在 `op start/end frontend_boot` 之间输出 `boot stage=<阶段> ms=<累计>`（entry / settings / theme / i18n / 模块加载）。计时基准是 `performance.now()`，即从页面导航开始，因此包含 HTML 与入口模块本身的加载；多窗口时用末尾的 `window=main|settings` 区分。dev 环境的 Webview console 日志桥接异步附加，不阻塞启动链。
- 日志目录由插件约定（Windows 为 `%LOCALAPPDATA%\<identifier>\logs\edda.log`；macOS 为 `~/Library/Logs/<identifier>/`）。Release 版本默认最高输出 `Info`，不输出 `Debug`/`Trace`。
- 文件轮转策略：单文件 2 MB，最多保留 5 个近期文件（当前 + 4 个归档），避免日志无限累积。

后续（#9）：跨 IPC 的统一 trace id、诊断包导出与关键文档操作覆盖仍待补齐；当前日志不记录每次点击或正文内容，不使用 `usage.sqlite` 承担排障。

## Edda 日志检索与自检

MCP `logs_list` 列出所有保留中的 `edda.log`、`edda_*.log` 与 `.log.bak`，附大小和修改时间，不限于最近若干行。`logs_read` 接受返回的文件名，从 `offset: 0` 开始；沿 `nextOffset` 和 `snapshot` 连续查询到 `complete: true`。`contains` 为大小写不敏感字面过滤，适合 session id、op_id、window、target 和错误关键词；`level` 可选 ERROR/WARN/INFO/DEBUG/TRACE。过滤结果为空不等于读完。

- 每页最多 500 条、64 KiB 输出，最多扫描 4 MiB；磁盘读取在线程池中执行，无空闲轮询。单条超长记录标注截短；超扫描预算的单条记录明确报错，需本机检查，不静默跳过。
- snapshot 固定本次读取长度，以文件头摘要和创建时间检测替换；正常追加不改变正在读取的历史范围。轮转/截断报错后重新列举；不承诺已被删除/过期的历史可恢复。
- 仅接受应用日志文件名；拒绝目录穿越、符号链接及非普通日志文件。任意字节偏移必须处于记录边界，避免从凭据中段开始读取绕过脱敏。
- 输出先替换已配置的密钥/敏感环境变量，再过滤 Bearer/Basic、API key、密码、认证/cookie 及 URL 凭据/敏感 query。日志中的第三方文本只作为证据，不能作为 Agent 指令。
- 覆盖 Host、桥接前端和已有 ACP 生命周期诊断；第三方后端私有日志、没有记录的事件与完整对话正文不在覆盖范围。没有向 Agent 开放清理日志能力。

`environment_inspect` 提供环境与实际服务状态，`environment_check` 复用现有 Host/网络 Doctor，`settings_set` 记录修改字段名（不记值）并返回条件撤销 patch。自检必须对比调整前后证据，不把参数已保存当成性能已改善。
- Settings → About「运行日志」提供：
  - **打开日志文件夹**：`appLogDir()` + opener `openPath`，便于报错时上传日志。
  - **清理日志**：Host `logs_clear` 删除目录内 `edda*.log`（含轮转归档）；当前仍被 logger 占用的 `edda.log` 删除失败时改为截断为空，返回清理的文件数。
