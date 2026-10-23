# 网页论文阅读与划词

「网页」类论文（paper `type === "html"`，有 `html_url` 无本地 PDF）由 `HtmlViewer`（`src/components/viewer/html-viewer.tsx`）以内嵌 iframe 阅读。跨域 iframe 受同源策略约束，父页面拿不到选区——划词工具栏、翻译、引用到 Agent 都依赖内置代理注入的选区桥（近似浏览器扩展的 content script）。

## 架构

```text
HtmlViewer ── iframe src: edda-web://localhost/<host>/<path>
    │  (加载前 invoke web_proxy_allow_host 把 host 加入 allowlist)
    ▼
Host `features/web/proxy.rs`(edda-web scheme)
    ├─ allowlist 校验(discovery/proxy 之外唯一允许任意 host 的代理,绝不开放中继)
    ├─ reqwest 转发(浏览器 UA;重定向每跳都过 allowlist)
    └─ text/html 且 looks_like_document → 重构建响应:
        剥掉上游 CSP / X-Frame-Options,在 <head> 开标签后注入
        <base href="https://<host>/<dir>/"> + WEB_BRIDGE 脚本
```

### `<base href>` 注入

把文档的相对资源解析基准设回真实 origin,因此:

- 相对 / 根相对 / 协议相对的 CSS、图片、字体(含 CSS 内部 `url()`)全部**直接从站点加载,不经代理**——代理不用为 CDN 开任何上游(SSRF 面与广场代理同一条红线);
- 零 HTML 属性改写(不用 regex 扫 `src=`/`href=`);
- 只有**页面导航**需要留在代理里,由桥的 click 拦截器改写回 `/<host><path>` 形态。

### URL 双形态

与 `arxivReaderUrl` 同一约束:Windows WebView2 把自定义 scheme 拦截为 `http://<scheme>.localhost`。构造与 `event.origin` 校验统一走 `src/lib/web-view/proxy-url.ts`(`webViewProxyUrl` / `webViewProxyOrigins`,后者两种形态都接受)。

## 安全边界(Host 侧)

| 防线 | 实现 |
|---|---|
| 绝不做开放中继 | 进程级 allowlist(`features/web/allowlist.rs`);前端打开 paper 前 `web_proxy_allow_host` ensure |
| SSRF | allowlist 只收公网 DNS 名;拒绝 IP 字面量 / localhost / `.local` / `.internal` / `.arpa` / 无点主机 |
| 重定向绕过 | 自定义 reqwest redirect Policy:每一跳 host 都必须已在 allowlist,否则整请求报错(而非透传 3xx) |
| 凭据泄露 | 只转发 content-type / accept / accept-language,不带 cookie / Origin |
| 路径穿越 | `target_from_uri` 拒绝 `..` 与无 host 段的形态 |

## 桥脚本(WEB_BRIDGE)

NAV_BRIDGE 同款 vanilla ES5 IIFE,只装配顶层 frame。经 `parent.postMessage` 与应用通信;应用侧监听 `message` 并校验 `event.origin ∈ webViewProxyOrigins()` 且 `data.source === "edda-web"`(防无关 frame 伪造)。

### 消息协议

| 方向 | type | 载荷 | 语义 |
|---|---|---|---|
| frame → app | `selection` | `{text(≤4000), rect\|null, url}` | 选区(视口坐标矩形);空文本即清菜单。带 rect 时帧内已 `execCommand("copy")`(焦点在 frame,应用侧剪贴板写入可能被拒的降级) |
| frame → app | `scroll` | — | 页内滚动,隐藏工具栏(plaza 同款语义) |
| frame → app | `shortcut` | `{id: "quickChat" \| "addToChat"}` | ⌘K / ⌘L——iframe 聚焦时键盘事件进不了主 webview,必须显式转发;editable target 不转发 |
| frame → app | `external` | `{url}` | 跨站链接交系统浏览器 |
| app → frame | `clearSelection` | — | 加入对话后清除帧内选区 |
| app → frame | `copySelection` | — | 应用侧复制失败时的兜底 |

站内导航:同 host 链接被改写为 `/<host><path>` 原地导航(每次文档加载都重新注入桥);SPA 的 `pushState`/`replaceState` 被包装以保留 host 段;非 http(s) scheme 的链接直接阻止(私有 scheme 绝不漏给系统浏览器)。

## 划词动作管线(前端)

`use-web-view-selection.ts`(`src/components/viewer/web-view/`)消费桥消息,产出与 PDF / plaza 同款的浮层:

- **工具栏**:`SelectionMenu`(复用 `viewer/pdf/cards/`,`showHighlight={false}`——网页无 marks/,藏高亮留翻译)+ 选中即复制标签 `SelectionCopiedLabel`;
- **翻译**:`TranslateCard` 流式卡,双 provider(agent → `runOnce{workflow:"translate"}` 流式;免费 MT → `runTranslate`),ephemeral 单卡不写 marks;
- **问 Agent（⌘K / ⌘L）**：`publishSelection{origin:"markdown", sourcePath: html_url}` → `pinActiveSelection` → 打开完整 Agent 并聚焦输入框。原页内 Quick chat 已移除；引用作为消息附件保留，来源链接打开原网页。见 [agent-references.md](agent-references.md)。

坐标换算:`bridgeSelectionScreen(rect, iframeRect)`(桥给的是 frame 视口坐标,加 iframe 元素偏移即应用视口坐标),纯函数在 `bridge-message.ts`,与消息 parse 守卫一起有 vitest 覆盖。

## 本地 HTML 预览

知识库里的 `.html` 文件（常见于 Agent 生成的报告、图表）由 `LocalHtmlPreview`（`src/components/viewer/local-html-preview.tsx`）预览，与上面的网页论文是两条路径：

```text
LocalHtmlPreview ── iframe src: edda-preview://localhost/<rootId>/<vault 相对路径>
    │  (先 invoke vault_preview_root(root) 登记知识库根，拿到本会话的随机 rootId)
    ▼
Host `features/vault/preview.rs`(edda-preview scheme)
    └─ 只读已登记根下的文件；按扩展名给 Content-Type，HTML 附 CSP sandbox
```

- 路径与真实目录同构，页面里的相对 CSS / JS / 图片 / 链接都按原样解析，可在同目录页面间跳转。
- 隔离：iframe `sandbox="allow-scripts allow-forms allow-modals"`（无 `allow-same-origin`，页面拿到不透明 origin，读不到应用存储、碰不到 IPC），HTML 响应再带 `Content-Security-Policy: sandbox …`；不发 CORS 头，其它 frame（含广场代理页）无法 `fetch` 读取知识库内容；`..`、编码后的 `..` 与指向根外的符号链接一律 403；rootId 为每次运行随机生成，不可由路径推得；单文件上限 64 MiB。
- 工具条：源码 / 预览切换、重新加载、在访达（资源管理器）中显示。远程知识库不提供预览，直接显示源码。
- 判定按路径（`isHtmlPath(tab.path)`）而非 `htmlUrl`：论文文件夹里的 `.html` 也会带上该论文的远程 `htmlUrl`。

## 已知限制

- **登录站 / 部分 SPA**:站点 JS 以 `location.origin` 拼 API 请求会打到代理 scheme 上失败(评论区、站内搜索等残缺)。公开文章与文档站基本不受影响。
- **高亮 / 批注持久化**:网页无 marks/ sidecar,v1 不提供;如后续要做,需在 catalog 或 sidecar 定义网页锚点(文本 quote + 版本)。
- **跨 host 重定向**:重定向目标 host 必须也在 allowlist(如 www → 裸域),否则该请求报错——SSRF 边界优先。
- 剪贴板:首选应用侧 `copyTextToClipboard`,被拒时桥内 `execCommand("copy")` 已先行复制。
- 本地 HTML 预览:沙箱不给同源,依赖 `localStorage` / ES module 跨源加载的页面会降级;需要完整浏览器能力时用工具条在访达中打开。

## 相关

- 浏览（原生视图，登录、划词浮层、站点适配器）：[browse.md](browse.md)；翻译流程与其共用 `lib/translate/selection.ts`
- PDF 划词(持久化 marks 的对照实现):[pdf.md](pdf.md)
