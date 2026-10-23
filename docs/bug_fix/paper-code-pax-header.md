# GitHub 源码归档被误判为多个根目录

## 现象与原因

Library 下载论文代码显示「无法导入仓库归档」。DE-CLIP 的真实仓库
`https://github.com/TrustAIRLab/DE-CLIP` 可正常下载，但导入返回
`Repository archive has multiple roots`。

其 tar.gz 首条为 `pax_global_header`（type `g`），保存 commit comment；后面只有一个真正的
源码根目录。原解包器先登记根目录，再判断条目类型，因此误把 PAX 元数据头登记为首个源码根。
此前只验证了不包含该扩展头的小型仓库，未覆盖这种合法归档格式。

## 修复与验证

- 在文件路径与源码根目录校验前忽略 PAX 全局 / 局部扩展头，不把它写入快照。
- 保留真实多根、越界路径、大小限额和 `.git` 过滤。
- 离线回归包含 PAX header + README，修复前复现、修复后成功；同时断言真正的两个源码根仍被拒绝。
- 手动网络测试可通过 `AGENTERO_CODE_TEST_REPO` 指定论文实际仓库，在临时 Vault 验证，
  不向用户已有论文目录写入测试文件。
- Host 记录导入失败的底层原因，避免只剩通用 Toast 无法定位。

本次检查的 DE-CLIP commit 为 `fa415ca7fd38379159d7d0af609c409c66dea221`，仓库只有
`README.md`，内容为 `# DE-CLIP` / `Coming soon......`。可正常导入该快照与作者尚未公开
实现代码是两个独立事实；不能把下载成功表述为已经获得论文实现。
