# 设计规范

Edda 界面的单页规范：改 UI 之前先读这一页，新写的样式只用这里列出的 token。
token 定义在 `src/index.css`（语义色、字号、圆角、`@theme` 映射）与 `src/styles/workbench.css`（细线、表面、阴影）。
自选配色主题（`src/lib/ui/theme.ts`）只覆盖颜色与 `--radius`，下面的 token 都由它们派生，换主题无需改组件。

## 原则

- **文档是主角**：界面是暖纸色画布上的安静石墨色 chrome；PDF、笔记、对话内容的对比度最高，工具栏、边框都退后。
- **深度靠细线，不靠阴影**：表面之间用 1px 细线和底色差区分。阴影只属于浮在内容上方的层（菜单、弹窗）。
- **一个强调色**：铜色（`--ring` / `--brand`）只用于焦点、选中与轻量提示；主按钮用石墨色 `primary`，不用铜色铺大面积。
- **窄了就减内容，不压形状**：面板变窄时减少列数、隐藏次要字段；不把卡片压扁，也不把表格摊成表单。

## 颜色

| 角色 | Token | 用途 |
|---|---|---|
| 画布 | `bg-background` | 工作区、面板底色 |
| 侧栏 | `bg-sidebar` | 左栏、设置侧栏，比画布重一级 |
| 抬升表面 | `bg-card` / `bg-popover` | 卡片、输入框、菜单、对话框 |
| 弱底 | `bg-muted` / `bg-accent` | 悬停、选中行、标签底 |
| 正文 / 次要 | `text-foreground` / `text-muted-foreground` | 正文与元信息；不再自造灰度 |
| 主操作 | `bg-primary text-primary-foreground` | 每个区域最多一个 |
| 焦点 / 强调 | `ring` / `brand` | 焦点环、选中指示、进度 |
| 危险 | `destructive` | 删除、错误 |
| 审阅插入 / 删除 / 批注 | `review-insert` / `review-delete` / `review-comment` | 插入绿线、删除红线、批注轻高亮；见 `src/styles/review.css`，由现有主题 token 派生 |

不要直接写十六进制颜色或 `text-gray-*`；需要淡化时用语义色加透明度（如 `bg-muted/60`），并保持在同一语义里。

审阅的颜色表达修改类型，不表达作者：所有来源均使用绿色插入与红色删除，作者 / Agent 的身份色留在卡片署名、Agent 菜单与引线，避免把 AI 删除误读为插入。正文不铺连续的彩色背景，仅选中的修订显示轻量焦点轮廓。

## 图标

- **操作**（按钮、菜单项、工具条）用单色 lucide 图标，颜色跟随文字（`text-muted-foreground` 等）。
- **对象**（文件夹、论文、文件类型、侧栏节点、设置分区、空状态）用彩色双色调图标 `<ObjectIcon kind="…" />`
  （`components/icons/object-icon.tsx`，形状在 `object-icon-shapes.ts`）：16×16 网格，淡色填充 + 同色深色描边，1.2 描边、圆角端点。
- 颜色只用下面的图标 token，深浅主题各一套，不随自选配色主题变化：

| 色相 | Token | 用于 |
|---|---|---|
| 铜 | `--icon-copper` / `-soft` | 论文、论文库、HTML、通用设置 |
| 琥珀 | `--icon-amber` / `-soft` | 文件夹、论文池、版面 |
| 玫红 | `--icon-rose` / `-soft` | PDF、回收站、问题诊断 |
| 绿 | `--icon-green` / `-soft` | 浏览 / 网站、图片、网络 |
| 青 | `--icon-teal` / `-soft` | 代码、JSON、远程访问 |
| 蓝 | `--icon-blue` / `-soft` | 笔记、Markdown、翻译、同步、关于 |
| 紫 | `--icon-violet` / `-soft` | Skill、Agent |
| 石板 | `--icon-slate` / `-soft` | 其它文件、外观、快捷键 |

新增对象图标：在 `object-icon-shapes.ts` 加一项，只用 `body` / `line` / `hint` / `solid` / `knock` 五种画法，不写十六进制颜色。

## 细线（三级）

| 级别 | 写法 | 用途 |
|---|---|---|
| soft | `border-hairline-soft` / `bg-hairline-soft` / `ring-hairline-soft` | 表面**内部**的分隔：列表行、表头底边、工具栏、标题栏、Dock 分隔 |
| 默认 | `border`（即 `border-border`）/ `ring-border` | 表面**轮廓**：卡片、菜单、弹窗、分组框 |
| strong | `border-input` | 可输入 / 可点的控件：输入框、Select、描边按钮、Agent 输入框 |

不要再写 `border-border/40`、`/60`、`/80` 这类透明度。需要更轻用 soft，更重用 strong。

## 圆角（四级 + 胶囊）

基准 `--radius` = 10px，由主题决定，其余按比例派生。

| 写法 | 默认值 | 用途 |
|---|---|---|
| `rounded-sm` | 6px | 标签、kbd、行内代码、徽标、小图标按钮 |
| `rounded-md` | 8px | 按钮、输入框、菜单项、列表行、缩略图 |
| `rounded-lg` | 10px | 卡片、菜单 / Popover、工具栏浮条 |
| `rounded-xl` | 14px | 对话框、Agent 输入框、对话气泡、大面板 |
| `rounded-full` | — | 胶囊按钮、头像、状态点、开关 |

例外：文本 / PDF 上的高亮与标记（`rounded-[2px]`、`rounded-[1px]`）贴合字形，不参与阶梯。
不用 `rounded`（固定 4px，不随主题）和 `rounded-2xl` 及以上。

## 层级与阴影（两级）

| 写法 | 用途 |
|---|---|
| `shadow-floating` | 菜单、Popover、HoverCard、右键菜单、查找条、划词菜单、拖拽预览、悬浮按钮 |
| `shadow-dialog` | 对话框、抽屉、引导窗 |

在文档流里的元素（卡片、输入框、按钮、列表、代码块）**不加阴影**，用细线轮廓 + `bg-card`。
浮层同时带默认细线（`ring-1 ring-border` 或 `border`），深色模式下阴影几乎不可见，靠细线界定。

例外（物理隐喻，保留 `shadow-sm`）：PDF 页面与页面上的批注 / 选区控件、图片查看器中的图片、
分段控件与开关的滑块。

## 焦点

- 键盘焦点统一：边框变为 `border-ring`，外加 `ring-2 ring-ring/20`（输入类）；按钮用 `focus-visible:ring-2`。
- 只响应 `focus-visible`，鼠标点击不出现光环。组合控件（如 Agent 输入框）在外框上用 `has-[:focus-visible]` 呈现。
- 不用 `outline-none` 去掉焦点而不给替代样式。

## 间距与尺寸

- 4px 基数（Tailwind 默认 spacing）：控件内边距 `px-2.5–3`、`py-1.5–2`；同组元素间距 `gap-1.5–2`；区块间距 `gap-4–6`。
- 控件高度：紧凑 `h-7`、默认 `h-8`、大 `h-9`；同一行的控件高度一致。
- 列表行：单行 32–36px，双行（标题 + 元信息）约 56–64px。
- 尺寸、断点、对齐一律用 rem，避免 Windows 125% 等非整数缩放下的错位。

## 字体

- 字号阶梯见 `index.css`：`text-caption` 11 / `text-xs` 12 / `text-sm` 13（正文）/ `text-base` 15 / `text-lg` 17。
- 强调用 `font-medium`（510）或 `font-semibold`（590），界面里不用 `font-bold`。
- 元信息、计数、时间用 `text-xs text-muted-foreground`，数字加 `tabular-nums`。

## 动效

- 时长 token：`--motion-duration-micro` 100ms（按压 / 悬停）、`fast` 150ms（浮层进出）、`normal` 200ms（布局变化）。
- 浮层进出：淡入 + 98% 缩放；按钮按压只变色，不位移不缩放。
- 遵守 `prefers-reduced-motion`；状态说明用文字，不靠动画本身传达。

## 响应式

- 面板宽度由 Dock 决定，与窗口无关：响应式用容器查询（`@container` / `@lg/name:`），不用视口 media query。
- 变窄时按优先级处理：先藏次要列 / 字段 → 减少网格列数 → 文字换行或截断；空字段直接不显示，不用「—」占位。
- 工具栏放不下时整体换行，标签和按钮文字不折行（`whitespace-nowrap` / `shrink-0`）。
- 内嵌的外部站点（广场）同样按面板宽度适配，见 [frontend/workspace.md](frontend/workspace.md)。

## 反馈

- 操作失败用 `notifyError` Toast；不在面板头部挂常驻错误条。
- 能用图标表达的不加文案；图标按钮必须有 `aria-label` 和 tooltip。
- 空状态：一个图标 + 一句说明 + 至多一个操作，居中，不铺插图。

## 要做 / 不要做

| 要做 | 不要做 |
|---|---|
| 用三级细线和底色差表达层次 | 给卡片、输入框、按钮加 `shadow-sm` |
| 浮层用 `shadow-floating` + 细线 | 浮层用 `shadow-2xl`、`ring-black/5` 等临时组合 |
| 圆角按用途选 sm / md / lg / xl | 写 `rounded`、`rounded-2xl`、`rounded-[7px]` |
| 每个区域一个主按钮 | 同一行放多个实心按钮 |
| 窄面板减少列数、隐藏次要信息 | 把表格摊成「字段名：值」表单 |
| 语义色 + 透明度 | 十六进制颜色、`text-gray-*` |
| 面向用户文案走 `t()` | 为能用图标表达的操作加说明文字 |
