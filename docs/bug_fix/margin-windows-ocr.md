# Margin Windows 预览：自动 OCR 导致解析子进程崩溃

## 现象与定位

首次独立 NSIS 安装后的生产烟测导入一页、带 Helvetica 文字层的虚构 PDF，
`margin_parse_pdf` 返回子进程 `0xc0000005`、无 response JSON。
主窗未退出，SQLite 未应用解析结果。直接运行安装目录中的私有解析 worker 同样复现；
同一 EXE / 同一 PDF / 同一随包 PDFium 的只读文字 probe 则正常返回词框。
PDB 的邻近符号落在 Leptonica `pixWriteMemBmp`；这只是定位线索，
没有据此宣称已查明第三方原生代码的确切内存安全根因。

## 预览版处理

继承的解析配置开启自动 OCR，即使是稀疏文字页也可能进入原生图像链路。
Rust 的 `ocr_failure_fatal: false` 无法捕获进程级 access violation。
Margin 预览本来没有承诺 OCR，因此收窄到明确支持的 PDF 文字层提取：

- LiteParse 关闭默认 `tesseract` feature，不打包 Tesseract / Leptonica。
- 解析时显式 `ocr_enabled: false`，不隐式下载训练模型。
- 去掉不再适用的 OCR 质量预判，成功只标记 `pdf` / `medium`。
- 无可提取文字返回 `pdf_needs_ocr`，让用户先转换 Markdown；不静默写入空正文。

真实发行烟测 `scripts/margin-release-smoke.mjs` 必须检查文字 PDF 提取成功，
以及空白 PDF 明确失败且版本不变。这个最小样本不代表复杂版式、扫描件识别或长文档已通过验收。
如以后重新引入 OCR，必须单独验证 native image / tessdata 分发、线程与内存安全，
不能仅恢复默认 feature 来声称支持。
