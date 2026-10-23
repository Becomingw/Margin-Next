# ACP warm 连接已退出仍被复用

## 现象与证据

空闲一段时间后点击「总结当前论文」，偶发：

```text
prompt: Internal error: failed to send outgoing request `session/prompt`: connection is no longer running
```

本地日志记录了 2026-09-17 17:18:58 `warm slot exiting (idle-timeout)`，
23:39:51 同一 Agent 又 `warm reused pooled slot`。23:41:05 的请求随即结束，
没有对应出站 `session/prompt`；23:41:24 重发后才重新 initialize / session/new
并正常发送。问题发生在连接复用层，与总结提示词或论文元信息无关。

## 根因

`PooledSlot::is_alive` 只使用 SDK `is_incoming_closed()`。ACP 1.3 中该方法
只表示输入 EOF 已处理，`connect_with` 的 foreground 因空闲超时返回并停止
driver 时可能仍为 false。池中保留的连接句柄于是被误判为存活。

SDK 的 `PendingRepliesRegistrar::subscribe` 此时无法升级已释放的 driver
弱引用，在请求入队前返回上述错误。但应用把所有 prompt 错误统一视为发送后
失败，未触发原有 pre-prompt 冷启动回退。

## 修复

- 将已有 stop channel 的退休标志和接收端生命周期加入存活检查。
- 回收前先置退休标志，再异步删除空会话；keepalive 仅持有弱 sender，不阻止
  pooled owner 丢弃后的正常退出。
- registry 锁协调空闲回收与 turn 安装；安装后再核对存活状态。活动请求即使
  没有输出也不按 idle TTL 回收。
- 仅对 SDK 明确的「尚未入队、driver 已退出」prompt 错误允许一次 pooled → cold
  回退。其他断线和超时仍不自动重放；原始续聊 ID 随参数进入冷启动。
- 补充最终失败的本地诊断日志。

## 验证

`cargo test -p agentero --lib features::agent::session::` 覆盖 stop / owner drop /
EOF、活动请求超时保护、退休与取用竞态、不可重放错误分类。
使用真实 ACP SDK 的内存 pending transport 复现「driver 已退出但 EOF=false」，
验证其真实 `session/prompt` 错误可判定为未发送；不依赖模型或外网。
