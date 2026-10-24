# Margin 预览发布

只针对 `Becomingw/Margin-Next`，继承的发布 / TestFlight / 文档部署工作流已移除，
不推送 `upstream`。首版为 `0.1.0-beta.1`，Windows x64、NSIS、当前用户安装，
没有 Authenticode 签名或自动更新；不宣称支持已验收的其他平台。

## 版本与构建

1. 按 bump Skill 独立提交版本：`package.json`、两个 Cargo package、
   `tauri.conf.json` 与保留的 iOS 模板保持一致，检查 `Cargo.lock`。
2. 验证类型、前端测试、Rust 核心 / HTTP MCP 和 workspace Clippy。
3. 从干净工作区运行：

   ```powershell
   pnpm.cmd install --frozen-lockfile
   pnpm.cmd tauri build --config src-tauri/tauri.release.conf.json --bundles nsis
   ```

   使用 `cargo metadata` 的 `target_directory` 定位 `release/bundle/nsis/`。
   `mainBinaryName` 与 Cargo `default-run` 必须显式为 `margin`（包名为 `margin-desktop`）；
   默认构建只有 `margin.exe`，release 禁止 `legacy-workbench`。
   此本地发布流程不依赖上游安装器工作流成功；须记录本地验证结果并检查 Margin CI。

## 打包边界

- release 配置启用显式 CSP，限制脚本 / 连接来源，允许本地 WASM、worker 和文档资源。
  图片可来自 HTTPS；这不是对不可信文稿的全面沙箱或完整安全审计。
- 只启用主窗口 `default` capability，无 updater / shell / process 权限。
  打开目录后动态授予文件访问范围；所有已打开目录仍保留到进程退出。
- 不注册旧工作台的 Explorer 菜单、深链或更新通道，不编入旧 provider 密钥。
- 安装包应包含 PDFium DLL 及其原始许可证 / 依赖 notices、MIT LICENSE / NOTICE、
  `skills/margin-mcp-reviewer/`；Skill 是可选指引，不是内置模型或后台 Agent。
- 默认依赖树不含 Tesseract / Leptonica；只支持 PDF 文字层提取，扫描件应明确报告
  `pdf_needs_ocr` 而不崩溃或覆盖正文。不承诺随包 OCR 或后台模型下载。
- 用临时目录安装并启动已安装的 release 程序；检查资源、原生图标、窗口、
  正文保存、MCP 授权 / 提案 / 撤销与 CSP，不用开发服务器代替安装包验收。
  在专用测试进程启用 WebView2 CDP（见 `docs/margin.md`，不得用于日常运行），
  设置 `MARGIN_TEST_PID` 为专用安装测试进程的 PID，运行 `pnpm test:margin-release`，
  验证生产资源、编辑器自动保存、真实 MCP、撤销、旧 IPC 隔离以及随包 PDFium 子进程解析。
  烟测驱动该进程的真实原生文件夹选择器，不替换 IPC 或业务服务；
  使用自动清理的虚构临时稿件，不连接个人工作区。
- 保留 Windows 11 原生标题区、真实跨屏 DPI、复杂 PDF / 长稿件等未验收限制。

## 上传与人工门禁

1. 提交并 push `origin main`；核对远端提交和 CI。首版证据含无父根提交及其后的
   全部第一父链提交；旧本地上游 tags 不构成 Margin 的发布基线。
2. 为最终提交创建新 `v<version>` tag，仅显式推送该 tag；不得 `push --tags`
   泄露旧上游 tags，也不得覆盖已存在的 tag。
3. 创建 **Draft + prerelease**，上传 Windows 安装包、
   `margin-mcp-reviewer_<version>.zip`、`SHA256SUMS.txt`。
   独立 ZIP 顶层是 `margin-mcp-reviewer/`，含 `SKILL.md` 和客户端 metadata，
   不含令牌、个人文稿或本机路径。
4. 按 release Skill 写中英文镜像说明，中文在前、每项有证据和作者。
   没有上一版时链接首版代码树，不伪造比较基线。
5. 从 GitHub 回读 Draft 的正文、tag SHA 和附件大小 / SHA-256，给用户检查。
   **用户确认最终说明及附件后才可公开发布**；上传 Draft 不等于已公开发行。
