# Margin：独立审阅应用

## 起点

2026-10-23 从 GitHub Edda 最新默认分支拉取：v0.19.0，
`429499fd45623bebf07d041141e6b0f0967a04ed`。`upstream` 指向 Edda；
`margin-review` 是新项目开发分支，不向 Edda 推送。

公开项目地址为 `Becomingw/Margin-Next`。首次发布源码从当前快照建立无父根提交，
不上传 Edda 的 Git 历史；原有本地开发分支与历史保留。许可证和源码来源署名不会被移除。
未使用的继承源码尚未全面裁剪，不能将独立提交历史理解为独立重写。
继承的 Edda 文档部署 / 安装包 / TestFlight 工作流限定原仓库执行，不作为 Margin 发布通道；
CI 使用 Node.js 24。此轮只发布源码，不创建 tag 或安装包 Release。

本次不是给旧 Margin 换皮。旧 Margin 的 DOM 工作区、Node 服务和源码适配器没有带入。

## 已接通的独立链路

- `index.html` → `src/margin/main.tsx` → `MarginApp`，不执行 Edda 的 `src/main.tsx`。
- `src-tauri/src/lib.rs` → `margin::run`：只装配文件、对话框、链接打开插件、
  已授权工作区、Margin 文档 IPC 和 PDF 中文字体回退，不再装配文件型 `ReviewEditCache`。
- 不启动上游 Vault 初始化、catalog、Agent/ACP、完整 MCP 服务器、推荐、连接器、
  更新检查、云同步，也不迁移或加载 Edda 的全局配置。
- Tauri 应用 identifier 和主题存储独立；不跟随 Edda 更新通道。
- 独立蓝 / 红 / 黄 / 绿品牌图标：SVG 源、桌面 / 移动生成资产、NSIS 侧图、标题栏、favicon 与导出水印同步。Windows 显式设置小图标和任务栏大图标，二进制名为 `margin.exe`；修改图标后需重建原生程序，前端热更新不会替换运行中的 EXE 图标。
- Windows 主窗以原生标题区覆盖层合并应用顶栏，不再显示两层标题框。保留系统按钮与关闭事件；实现及验证入口见 [组件约定](frontend/components.md#margin-windows-窗口)。
- 普通浏览器只显示桌面启动提示，不伪造本地文件能力。
- 用户通过原生对话框选目录，Host 只授予该目录的递归文件权限；打开目录不搭建
  Vault、不注入 Skill。新建/导入稿件写 `.margin/documents/`；旧 `reviews/` 只读迁入。
- 稿件列表：打开目录、新建、导入、搜索、手动刷新。
- 直接挂载 Edda `ReviewWorkspace`：Plate 编辑、自动保存、常开修订、逐处/全部
  接受或拒绝、精简显示、批注及回复、页边连线、PDF 对照、普通目录导出。
- 不显示依赖 Library 的引用选择器；格式工具栏通过标题栏按钮开关。
- 保存与裁决通过 `margin_command` 在 SQLite 事务中完成：不可变版本、版本校验、
  持久命令回执和审阅记录一起提交；有未保存草稿时阻止换稿/换目录和关闭原生窗口。
- 可见时轮询当前稿件：更新批注状态，且只在草稿干净时重载外部正文，读取后再次
  核对草稿，避免覆盖正在输入的文本。
- 已接通 [单 AI + 人 checkpoint](margin-single-ai.md)：标题栏授权一个外部 AI 审阅者，
  只开放当前稿件的 MCP；AI 提案由用户预览、应用为修订，用户和 AI 可在同一批注线程回复。

## 审阅显示与交互（2026-10-24）

- 顶部提供「显示修订 / 最终文本 / 原始文本」。前两者使用同一编辑器，不重建正文；原始文本是本轮基线的独立只读预览，正在编辑的实例继续挂载和自动保存，不把基线写回稿件。
- 所有作者的插入统一用绿色下划线，删除统一用红色删除线；Agent 的身份色留在署名和审阅侧栏，修订装饰不写进 Markdown。
- 只给选中的修订显示一张页边前后对照卡片，提供接受 / 拒绝；批注与回复保留原有锚点联动。保存未完成时禁用裁决，避免依据旧的保存快照确认基线。
- 正文限制阅读宽度，工具栏可换行；按正文容器实际宽度，窄窗将审阅栏移到底部并独立滚动，不挤成两条窄列。
- 批注卡片改为作者 / 时间、引文、正文的清晰层次，不使用常驻阴影；批注编辑显式保存，失败保留输入，组字期间不触发发送快捷键。
- 界面优化检查点没有更换存储；随后后端已切换为下面的事务文档服务，保留这套行内修订界面。
- 本轮验证：前端测试 1429 项通过、5 项跳过；类型检查、生产构建和真实 WebView2 烟测通过（含模式 / 草稿保护、页边裁决、深浅主题与窄窗）。前端 lint 通过，保留上游已有的 7 条 warning 与 1 条 info。

## 数据与兼容边界

Margin 独立后端以每稿一份 SQLite 为唯一权威数据源（详细契约见 [后端文档](backend/margin.md)）：

```text
workspace/
  .margin/documents/<id>/
    review.sqlite
    review.sqlite-wal / review.sqlite-shm   # SQLite 运行时文件
    manuscript.pdf                       # 可选参考件
    assets/                              # 可选附件
  reviews/<legacy-id>/                    # 若原本存在，只读保留
```

正文、比较基线分别指向不可变版本；接受一处修改生成新基线版本，不覆盖旧版本内容。
提案、稳定 suggestion ID、裁决、线程、事件序列与命令回执独立持久化，初始数据库结构版本为 1，
兼容视图为 `margin-review` v2。单 AI checkpoint 将 SQLite schema 1 增量迁移到 2，
增加 reviewer 身份和实体归属，不改旧版本内容。保留原许可证，见 [NOTICE](../NOTICE.md)。

打开旧工作区时只读导入 `edda-review` v1 的正文、基线、已有快照、线程和事件，
复制附件到新目录，不改写旧 `review.json`、原稿或快照；重复打开不重复迁入。
迁入后旧文件不再与新库双向同步，手动编辑旧文件不会改写新稿。

`manuscript.md` 在活动文档中只是编辑器资源标识，不存在第二份可独立写入的正文文件。
导出产生一致的完整 `review.sqlite`、`manuscript.md`、`baseline.md`、`review.json` 和附件；
选择导出的 `review.sqlite` 可恢复为一篇新稿，保留完整版本与审阅历史，不覆盖现有稿件。
数据库变更应通过命令进入；外部 Markdown 可重新导入，或通过 `propose` 作为明确的版本提案提交。

上游的块 ID 可能写入 Markdown；Plate 序列化不保证保留源文件的每个字节。
TeX 导入与 PDF 解析沿用上游行为，**不是旧 Margin 的 LaTeX 原位保真编辑**。
PDF 提取是否需要解析器/模型配置也沿用上游约束，不能把未验证的 OCR 宣称为离线可用。

## 运行与验证

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
cargo test -p edda-core features::margin
pnpm tauri dev
```

Windows PowerShell 策略不允许 `.ps1` 时使用 `pnpm.cmd`。
开发服务默认 loopback；首次原生构建前 `pnpm pdfium:stage` 准备上游 PDFium。

Windows 原生烟测（仅开发窗口，真实 IPC / 磁盘，不模拟后端）：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9431 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion"
pnpm tauri dev
# 在另一个终端运行：
pnpm test:margin-native
```

烟测创建并清理临时虚构稿件，通过与文件对话框相同的打开函数选择测试目录，
验证独立命令白名单、导入、输入/自动保存、三种显示模式、页边逐处 / 全部接受与拒绝、批注/回复、窄窗布局、导出和旧保存拒绝；原始预览和宽窄切换不丢正文或回复草稿。
烟测需保持原生窗口可见：最小化或系统遮挡判定可能暂停 WebView2 动画帧，从而无法验证页边定位。
截图在忽略提交的 `artifacts/margin-native-review.png`、`artifacts/margin-review-dark.png`、`artifacts/margin-review-compact.png`。
原生对话框本身、PDF 解析和发行安装包不在这条烟测的验证范围内。

后端回归涵盖不可变历史、CAS、命令重试、待处理提案、逐条 suggestion 裁决、并发写入、
线程冲突、只读迁入、导出恢复和子进程中断后的 SQLite 恢复。运行上述命令获取最新测试数。
本次后端检查点：Vitest 1437 项通过、5 项跳过；Margin Rust 14 项通过（中断测试实际启动子进程），
保留的 Edda review 44 项通过；类型 / 生产构建、全 workspace Clippy `-D warnings` 与真实 WebView2 烟测通过。
前端 lint 通过，保留上游已有的 7 条 warning 和 1 条 info。
上游装配暂作为隐藏的库兼容入口 `run_edda_workbench` 保留，Margin 二进制不调用它；
生产前端仍有大 chunk 警告，留待依赖裁剪，不以改阈值隐藏。

## 后续范围（不是已实现能力）

- 继续裁剪未使用的前后端模块、Rust feature 和依赖；当前完整上游代码树仍保留，
  **运行时装配已独立，但依赖/源码体积尚未完成拆分**。
- 多 AI 身份 / 自动协作和提案三方合并。当前只提供单文稿、单审阅角色的独立 MCP 与提案面板，不开放完整 Edda MCP。
- 最近目录、评论草稿跨稿件切换保护、完整历史浏览入口。
- 收敛上游编辑器中的 Wiki、Agent、文献引用等非审阅入口。
- 窄窗审阅栏已有底部回退；PDF 导入解析和图片/复杂稿件仍需完整原生回归。
- 独立发布元数据、CSP 与权限审计，完成前不打包发布；源码仓库公开不代表已通过安装包验收。
- Windows 11 标题区与跨屏 DPI 移动的实机回归；当前原生外框 / 图标验证在 Windows 10 完成。

此检查点只验证独立审阅基础，不宣称已经完成所有产品迁移或可发布。
