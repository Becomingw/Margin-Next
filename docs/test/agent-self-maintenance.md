# Edda 环境、配置与日志自检验收

## 2026-10-15 Windows 桌面结果

真实 Tauri Host / WebView2，运行版本 0.16.1 的本地开发构建；通过运行中的
loopback MCP 调用，UI 缓存通过真实主窗口 CDP 回读，未用浏览器 mock Host。

- 工具目录 66 项；完整设置 schema 与 41 个写入路径可发现，随二进制产品资料可读。
- `environment_inspect` 返回实际 Windows 环境与 MCP listener；Host 探测 Node/npm 均可用。
- `environment_check(network)` 实际探测六个预设端点，本次均 reachable，耗时约 72–7076 ms；这是本次连接结果，不是长期网络保证。
- `settings_set` 的 dryRun 不落盘；包含非法字号的整批变更不部分写入；旧 expected 返回冲突。
- 实际修改 editorFontSize 后，MCP 回读与主窗口 `loadSettings()` 均收到新值；返回的 undo 恢复原值。
- 同字段两笔并发 patch：仅一笔成功，另一笔冲突；成功者的 undo 恢复原值。
- `logs_list` 本次有 1 个保留文件，`logs_read` 从 0 连续读完 15 页、7152 条记录；目录穿越请求被拒绝。归档枚举、UTF-8 分页、追加期间 snapshot、截断/替换检测与凭据过滤另有临时目录测试。
- 验证改动均已撤销；未更改论文、笔记、审阅基线或 Agent 凭据。

## 自动验证

```sh
cargo test -p edda features::system::settings
cargo test -p edda app::logging
cargo test -p edda integration::mcp
cargo test -p edda features::agent::prompt
cargo clippy -p edda --all-targets -- -D warnings
pnpm typecheck
pnpm exec vitest run test/prompt-display.test.ts test/agent-streaming-label.test.ts
```

本次 83 项相关 Rust 测试通过，1 项需真实 Grok 凭据的原生 provider 冒烟忽略；
19 项相关前端测试、类型检查、严格 Clippy 和桌面开发构建通过。
MCP HTTP 验证不是每个 ACP provider 的端到端模型验收，不宣称已测全部 provider。

## 重复验收

在测试工作区读取一项低影响设置，保存原值。用 dryRun、非法值和过期 expected 检查
无写入路径，再真实修改并回读 UI 与 Host。使用响应中的 `undo` 撤销，不直接编辑
settings.json。日志查询逐文件跟随 snapshot/nextOffset 到 complete，空过滤页也继续。
后续日志、平台与配置边界见 [MCP](../backend/mcp.md) 和 [运行日志](../backend/logging.md)。
