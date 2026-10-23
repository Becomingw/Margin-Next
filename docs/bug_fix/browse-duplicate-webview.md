# 浏览网页首次打开时报 already exists

## 现象与原因

2026-10-15，Windows 开发版打开浏览网站时报告：

```text
a webview with label `browse-main-…` already exists
```

`browse_open` 原来先 `get_webview`，不存在再 `add_child`。原生创建完成前视图尚不可查询，两个异步 IPC 请求可以同时通过检查；React StrictMode 的 effect 重放会稳定放大这个窗口。给创建调用换随机 label 或吞掉报错都不能保证单站点视图、登录态及生命周期正确。

## 修复

Host 的 `VIEW_LIFECYCLE` 异步锁覆盖检查到创建完成，也覆盖显隐／位置更新、关闭和适配器重建。后续打开请求等创建完成后复用原页面；排队的隐藏／关闭不会在视图尚未出现时被忽略。适配器 UI 与 MCP 重建入口统一 await 同一流程。

不能在原生 UI 消息线程阻塞等待同步锁：Windows WebView2 的创建本身依赖该消息循环。所有这些 command 保持 async，状态表的短同步锁与生命周期锁分离。

## 复现与回归

在已启动的 Tauri dev 主 WebView 控制台中运行（本地 SVG 避免外网因素，不修改网站列表）：

```js
const { commands } = await import('/src/lib/core/bindings.ts');
const { browseUiLabels } = await import('/src/lib/browse/native-view.ts');
const label = `browse-main-racecheck-${Date.now()}`;
const args = {
  label, window: 'main',
  url: 'http://localhost:1420/src/assets/edda-logo.svg',
  rect: { x: 0, y: 0, width: 1, height: 1 }, labels: browseUiLabels(),
};
try {
  console.log(await Promise.allSettled(Array.from({length: 4}, () => commands.browseOpen(args))));
} finally {
  await commands.browseClose({label});
}
```

修复前实测：4 个并发请求中 1 个成功、3 个返回相同 label already exists。回归要求：全部成功且只有一个视图；创建期间隐藏／关闭有效，关闭后可用原 label 重开，创建失败后可重试。

修复后在重新启动的 Windows WebView2 实测通过：4/4 打开成功、原生视图计数为 1；创建期间隐藏返回成功，创建期间关闭后计数为 0；以不存在的宿主窗口创建失败后，同 label 重试成功且计数为 1。测试视图均在 finally 中关闭。

相关检查：`cargo test -p edda features::browse::`、`cargo clippy -p edda --lib --tests -- -D warnings`。原生并发复现必须使用重新编译并重启后的 Host，单纯 Vite HMR 不会加载 Rust 修复。
