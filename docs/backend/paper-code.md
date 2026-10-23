# 论文源码快照

每篇论文可以拥有多个开源仓库快照。源码属于论文的普通文件资产，存放在同一论文目录，
不创建独立 Git 仓库，不运行代码、依赖安装、hooks 或子模块初始化。

## 目录与权威

```text
papers/<id>/code/
└── github-lab-project-<url-hash>/
    ├── snapshot.json
    └── files/               # README、源码、配置、LICENSE 等仓库文件
```

`snapshot.json` 保存 `schemaVersion: 1`、稳定目录 `id`、规范化仓库 `url`、下载时的
默认分支 commit `revision`、`importedAt`、归档 `archiveSha256`、`fileCount`、`bytes`
与 `skippedEntries`。这是资产来源清单，不是版本管理；不定时检查上游或自动更新。
一个仓库每篇论文只保存一份，重复下载不覆盖；更新需先将旧快照移入回收站。
文件和来源清单随论文移动、同步与删除，不另建 Catalog 行。手动放入且没有有效来源清单的
`code/` 子目录不会被管理列表接管或覆盖。

## 发现与下载

- 按需扫描当前论文 `PAPER.md` 与 `source/` 下 TeX、Markdown、文本、HTML、JSON；
  识别 GitHub / GitLab 链接，兼容 Markdown 与 TeX URL 中的转义下划线，保留出处和上下文。
  不扫描 NOTES 或已下载代码，不自动认定某个候选一定是官方实现；由用户选取。
- 发现只读本地文件，不联网下载。没有解析正文时允许手动输入地址，不隐式调用模型或重跑 PDF 解析。
- 只支持 `github.com` / `gitlab.com` 公开仓库 HTTPS 下载，含 GitLab subgroup；
  仓库子页面归一到项目，使用默认分支，明确不采用链接内的 branch/tag。
- API 查询默认分支的当前 commit，再下载该 commit 的 tar.gz。复用 core HTTP 的
  User-Agent、代理与 GitHub 镜像候选；网络请求在 Vault 文件变更租约外完成。
- 获取租约后重新核对论文身份；在 `.edda/code-stage-<uuid>` 解包，完整写好文件和清单后
  原子 rename 发布。失败清理暂存目录，已有论文资产不被替换。跨进程复用 Vault 配置锁。
- 丢弃任意层级 `.git`；符号链接、硬链接和特殊条目跳过并计数。不导入版本库身份。
  保留 LICENSE 和普通配置文件；archive 不包含子模块内容或按需 Git LFS 大文件下载。
- PAX 全局 / 局部扩展头是归档元数据，在源码根目录校验之前忽略；GitHub 的
  `pax_global_header` 不计为第二个源码目录，也不落盘。真实多根源码仍拒绝。
  复盘见 [GitHub PAX 归档兼容](../bug_fix/paper-code-pax-header.md)。
- 导入失败的底层原因记录于本地 `edda::paper_code` 日志，界面保留短错误 Toast。

## 只读与既有系统

Library 提供只读纯文本浏览，不执行 HTML / Markdown 内嵌脚本。通用 Markdown 打开也设为
只读；前端 Vault 文本和二进制写入口拒绝 `papers/<id>/code/`，删除入口只允许整份快照，
不能单独删除其内部文件。只读是应用内资产规则，不是修改用户 OS 权限或外部工具的沙箱。

代码目录初始懒加载，里面的 TeX/PDF 不参与论文正文能力探测，Markdown 不进入 Wiki 图和
自动改链，仓库里的 NOTES / metadata 不会被 rescan 当成另一篇论文。
移入回收站复用原有 trash/restore，恢复后资产列表可重新发现来源清单。

## IPC 与边界

`paper_code_inspect`、`paper_code_import`、`paper_code_files`、`paper_code_read`：Host 为异步
薄包装；文件 IO/解包在线程池执行，内核位于 `edda-core::features::paper::code`。

扫描最多 512 个正文文件 / 16 MiB，单文件 4 MiB，候选 64 个；目录遍历深度 12。
归档下载最多 128 MiB；解包最多 512 MiB / 20,000 文件，单文件最多 64 MiB；
额外限制解压流中的头部与元数据大小。拒绝越界路径、已有目标和链接目录。
预览仅限 1 MiB 内 UTF-8 文本；其他文件仍保留，可在文件管理器查看。

## 限制与后续

- 本地 Vault 的 Library 入口；远程 Vault 仓库下载、私有仓库鉴权、自托管 GitLab / Gitee 待支持。
- 当前直接识别正文 URL，尚不访问项目主页继续寻找仓库，也不自动区分本文实现与引用的基线。
- 尚不支持选择 branch/tag、子模块 / LFS 展开或多版本快照；保留固定来源 commit 供人工追溯。
- 网络 API 限流或仓库不可访问时返回错误，用户可重试；没有定时抓取或自动拉代码。
