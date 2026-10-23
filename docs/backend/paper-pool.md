# 冷存储论文池

## 边界

冷存储 JSON 是候选推荐的来源；正式文献以当前 Vault Catalog 为准。无需新增 SQLite 服务、HTTP listener 或计划任务。目录投递和静态 HTTP(S) JSON 共用解析、校验与去重内核；配置 `paperPoolLocation` 为全局设备设置，空值使用本机默认目录。

数据契约和外部自动化示例见 [用户指南](../usage/paper-pool.md)。`schemaVersion: 1` 批次中的 `PoolSubmission` 包括 title、authors[{name,affiliations}]、year、abstract、doi、arxivId、url、pdfUrl、recommendation、source、recommendedAt、tags。

## 数据流

```text
外部 Agent / 人 / 定时脚本
  → MCP pool_submit / JSON 文件 / 对象存储发布
  → paper_pool_read（启动预读或显式刷新）
  → 校验与 ID 归并 → PoolSnapshot → 论文池表格
  → 用户入库 → paper_pool_promote
  → paper_commit（ByIdentifiers + Deferred，metadata-only）
  → Catalog + papers/<id>/NOTES.md + metadata.json
```

- 单条不合法时读取端隔离并返回 warnings；MCP 投递端整批拒绝，避免误以为所有记录已保存。
- DOI/arXiv 是强别名；同一提交同时给出两者可连接先前的部分记录。无 ID 才使用标题、首作者、年份精确键；不同 ID 不仅凭同名标题合并。
- 推荐按时间排序；相同来源和理由不重复。合并时保留作者单位与非空 metadata。
- 提交服务按内容寻址发布独立批次，临时文件唯一，避免并发生产者共享可变索引；Windows 竞争已存在目标时不退化为原地截断写入。
- HTTP 客户端复用应用代理，30 秒超时，按实际读取字节限制 2 MiB。错误不回显 URL 中的凭证。应用不提供远程上传服务；发布方使用自己的存储接口。
- promotion 重新读取指定地址和 key，候选失效时报 `pool_candidate_changed`；只接受本地 Vault。Host 串行化同库 promotion，再使用共享 commit，不联网猜测或覆盖用户手填 metadata。
- `extra` 以 JSON 字符串保存 `eddaPaperPool` 来源、单位和推荐信息，不复制可能含凭证的存储地址。原始池不修改，「已入库」由当前 Catalog 的 ID/DOI/arXiv 推导。
- 前端请求有代次隔离，同地址在途读取合并，旧地址迟到结果不会覆盖新地址；入库目标 Vault 在点击时捕获。

## 命令

| 入口 | 命令 |
|---|---|
| Tauri | `paper_pool_read(location)` → PoolSnapshot |
| Tauri | `paper_pool_example()` → JSON 示例字符串 |
| Tauri | `paper_pool_promote(location,key,vaultPath)` → {path,id,title,created} |
| MCP | `pool_example` / `pool_submit(document,by?)` / `pool_list`；使用应用配置的 `paperPoolLocation` |
| 自省 | MCP `tools/list` |

## 退役功能

广场订阅与 arXiv Daily 的页面、前端服务、Host 代码（feeds / recommend 模块）和启动预热已移除；旧 tab 路径恢复为论文池。仅供旧推荐使用的 Embedding 设置（含内置 provider 的 embedding 模型）也已移除。历史 `feeds.sqlite` 与 catalog 缓存表不主动删除，旧 `embedding` 设置字段读取时忽略；arXiv 论文导入、References 和普通检索继续使用各自的流程。

## 实现与验证

- core：`paper/discovery/pool/`（协议、IO、归并），`paper/import/pool.rs`（转正）。
- MCP：`integration/mcp/research.rs`；Host：`features/paper/discovery/pool.rs`。
- UI：`src/components/plaza/paper-pool-view.tsx`；状态/索引：`src/lib/plaza/paper-pool.ts`。
- 回归覆盖并发/重复投递、坏记录隔离、静态 HTTP、跨 ID 合并、metadata-only 转正、MCP 传输、来源切换、标识符比对及旧 tab 迁移。

## 后续

- 超大论文池的增量索引、多地址聚合、远程 Vault 转正尚未实现。
