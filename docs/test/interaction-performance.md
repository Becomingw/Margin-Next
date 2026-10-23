# 交互性能验证

## 2026-10-15：工作区与设置热路径

Windows WebView2、Tauri dev（Vite 开发构建），同一长文稿、20,893 个 DOM 节点。
通过 WebView2 CDP 在实际主窗口执行侧栏按钮 `click()`，连续 6 次开合，每次等待两帧后再间隔 350ms；采集 `devtools.timeline`、CPU profile 与 `longtask`。对照只改变侧栏宽度插值，其他首批优化在两组中均已加载。

| 指标（6 次合计） | 宽度动画 | 最终直接切换 |
|---|---:|---:|
| Layout 次数 | 183 | 24 |
| Layout 时间 | 767.5ms | 109.4ms |
| PrePaint 时间 | 514.3ms | 84.1ms |
| Paint 时间 | 272.7ms | 34.7ms |
| >50ms 主线程任务 | 3 | 0 |

这是单机开发构建的一组场景数据，不代表所有操作的延迟或发布构建性能。并行编译/lint 时复测仍出现 64–66ms 长任务，因此保留布局耗时与次数作为主要对照。两帧等待本身受刷新率影响，不能当作 INP。

实际交互检查：六次切换后栏宽恢复（亚像素误差容许 1px）；文稿文本未改变；阅读／Agent 布局预设切换后状态正确，右栏按钮可反复开合。程序化布局通知必须同时保护左右栏，否则 sibling 的 ResizeObserver 会把刚选中的布局改回 custom。

## 回归保护

- 审阅：真实 Plate 静态渲染验证跨块范围进入正确 leaf；嵌套／带格式文本、反向与重叠范围裁剪结果一致；1000 段各一条修订时，段级候选访问由 100 万降为 1000（算法工作量，不是实测整体加速倍数）。
- 浏览：120 次空闲探测只发现浮层一次；菜单插入／移除重新发现，位置变化继续即时测量，卸载断开 observer。
- 设置主题：重复应用不重写 CSS；异步加载后的旧选择不能覆盖默认／新选择。
- 工作区：原引用／同值更新不通知，真实激活仍通知。
- Host：并发 blocking 保存后磁盘、缓存和密钥一致，订阅回调可重入读取；写失败不替换缓存或通知；不变的代理保留连接池。

```sh
pnpm exec vitest run test/review-decoration-index.test.ts test/review-track-changes.test.ts test/browse-native-view.test.ts test/ui-theme-apply.test.ts test/workspace-noop.test.ts
cargo test -p edda features::system::settings::
cargo test -p edda-core http::tests::
```

跨平台发布验收仍按 [发布 Checklist](release-checklist.md) 执行，包含原生浏览遮挡、分隔条拖拽、PDF 与编辑器切换；本轮 Windows 场景不能替代 macOS/Linux 验收。
