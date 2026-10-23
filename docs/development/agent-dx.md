# Agent DX：MCP 业务接口

## 已落地

- 业务 CLI crate、打包/安装/同步、私有 PATH 注入及命令说明已退役。
- UI 与 MCP 复用 core/Host 业务服务；内部 Agent 继续使用 BYOA/ACP。
- 应用运行时，外部客户端可连接设置中的 loopback MCP；本地支持 HTTP MCP 的 ACP
  Agent 自动获得固定 Vault、带连接凭据的私有工作区接口。
- 任务、标注、题录导入导出、推荐与诊断已通过结构化工具提供，具体契约见
  [MCP 文档](../backend/mcp.md)。工具 Schema 是唯一操作参数来源。
- Skill 负责研究方法与行为指导：`edda-workspace` v1、`paper-qa` v4、
  `paper-reader` v9、`vault-normalizer` v3，AGENTS 模板 v4。
- 旧业务 Skill 归档保留原文件，新接口不再提示安装终端命令。
- Edda 自身认知与自检：随二进制产品资料、环境/真实探测、完整脱敏设置 schema 与条件写入、所有保留日志的分页查询已落地（#5 / #9）。模板 AGENTS v8；契约及权限见 [MCP 文档](../backend/mcp.md#产品认知设置与自检5--9)。

## 后续

- 远程 SSH / 仅 stdio adapter 的工作区 MCP 接入（当前明确报告缺失业务能力）。
- 更多研究任务产物卡片与事件订阅；当前复用 JobCenter 进度、状态和取消。
- 接口覆盖评估、可选批量操作与幂等请求键；不引入重复的 shell 操作协议。
- Skill 内容哈希更新保护、来源/覆盖关系展示与按会话减少重复注入。
- 当前不实现独立后台 daemon，也不自建模型推理运行时。
