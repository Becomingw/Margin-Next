# OpenCode 已安装但设置显示无 Agent / 无 ACP

## 原因

OpenCode 官方 installer 将二进制放在 `~/.opencode/bin/opencode`，并更新 shell PATH。
从 Finder / Launchpad 启动的 Agentero 不继承终端 PATH；设置页 catalog scan 使用
进程 PATH 与共享常见目录，而共享列表漏了 `.opencode/bin`。因此终端可以运行
`opencode --version`，设置页及运行前置检查却返回 `command opencode not found`。
OpenCode 的宿主与原生 ACP 共用该二进制，两项状态会同时缺失。

ACP 真正启动时虽会合并 login-shell 环境，但前置发现已经失败，不能依靠启动阶段修复。

## 修复与验证

- 将 `.opencode/bin` 加入 core `install_dirs::HOME_BIN_DIRS`，同时覆盖本地发现、
  ACP 子进程 PATH 补全、远端 SSH bootstrap 与远端 which 的候选目录。
- 回归测试使用独立子进程、临时 HOME 和 `/usr/bin:/bin` 精简 PATH，模拟官方安装；
  不修改并行测试进程环境。修复前解析结果为 `None`，修复后找到临时安装二进制。
- 远端命令生成测试检查 bootstrap 包含 `$HOME/.opencode/bin`。
- 本机验证（2026-09-18，OpenCode 1.18.31）：精简 PATH 下调用真实 catalog scan，
  返回 `binary=true` / `acp_cmd=true`，路径为 `~/.opencode/bin/opencode`；
  同一 PATH 下直接发送 ACP `initialize`，收到 OpenCode 身份、协议版本 1 和能力响应。

用户无需重装 OpenCode；完全退出旧应用并启动包含修复的版本后，在设置中重新扫描 / 探测。
非标准安装目录的统一发现与 shell 查询隔离仍见
[Rust 重构计划 S5](../development/rust-arch-refactor.md)。
