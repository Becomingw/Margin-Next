# 业务 CLI 退役与迁移

Edda 的业务 CLI 已从当前源码、构建和运行链路移除。外部 Agent 通过运行中的应用
提供的 [MCP 接口](mcp.md) 操作文献、标注、推荐和任务；内部仍通过 BYOA/ACP 接入。
Codex、OpenCode 等 Agent 自己的客户端及登录方式保持各自原有机制。

## 迁移

- 不再有独立 CLI crate、同版本 CLI 归档、关于页安装按钮、启动自动同步或私有 PATH 别名。
- 操作参数通过 MCP `tools/list` 获取；不用查命令帮助或拼接 shell 参数。
- 下载/解析转为 `paper_task_start`，通过 `task_get` / `task_cancel` 跟踪和取消。
- 论文池转为 `pool_example` / `pool_list` / `pool_submit`，复用 UI 中配置的位置。
- 其他对应能力见 [MCP 工具表](mcp.md#tools)。Vault 生命周期、永久清理与跨 Vault 迁移仍由应用界面负责。
- 旧 Vault 的 `.agents/skills/agentero-cli` 会移到 `.edda/retired-skills/<id>/`，
  原文件及自定义内容保留，但退出生效目录；新指导为 `edda-workspace`。
- 旧版本已安装到系统的终端命令不会被新版本自动更新；用户可按旧安装方式自行移除。
- 已发布历史版本的资产不改写；此变更应通过新版本发布。

应用关闭时 MCP 不可用。不新增 headless daemon；文件型 JSON 推荐仍可由外部程序离线生成，
下次打开应用后读取。
