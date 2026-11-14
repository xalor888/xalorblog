# W11-styles — 全局样式与 markdown 样式

### web/src/styles/main.css（2145 行）

**职责**：全站唯一的设计系统来源——明/暗两套主题 token、液态玻璃（--lg-\* / --sg-\*）材质、基础 reset、Element Plus 变量与组件皮肤、可访问性兜底（焦点环 / skip-link / sr-only / reduced-motion / 触控输入框 16px / 触摸目标下限）、打印样式、沉浸阅读与页面转场。

**结构与"导出"**：无 JS 导出，全部是全局副作用；对外的真正接口是 `:root`（6-238）与第二段 `:root`（1262-1288）里的自定义属性：颜色 `--bg/--bg-soft/--card/--text(-2,-3)/--border/--line`、强调色五件套 `--accent` `--accent-soft` `--accent-deep` `--accent-text` `--accent-fill/--accent-contrast`、点缀色 `--amber(-text)/--teal/--blue/--rose/--violet`、字体 `--font-sans/serif/mono`、`--radius*`/`--shadow*`/`--ease*`/`--dur`、布局 `--nav-h/--content-w/--reading-w/--side-w`、安全区 `--sat/--sar/--sab/--sal`、层级 `--z-nav/--z-float/--z-scrim/--z-modal/--z-modal-2/--z-viewer/--z-toast`、玻璃材质 `--lg-*` 与 `--sg-*`。`[data-theme='dark']`（205）只做变量重映射，不改结构。

**实际逻辑**（按块）：
- 205-285 暗色重映射；`--accent-fill` 在暗色下仍字面量 `#ad422e`，理由是白字对比（222-228）。
- 337-374 `.sg-liquid::after` 用 `background-position` 做 9s 循环扫光（300% 宽度 + `pointer-events:none`），reduced-motion 下 `animation:none`。
- 377-443 **边缘亮环（rim）**：`@supports ((-webkit-mask-composite: xor) or (mask-composite: exclude))` 内一条配方，给 `.site-nav::before` / `.card::before` / `.dock-btn::before` / `.el-message-box::before` / `.site-footer::before` 各画 1px 环带（`padding:1px` + 两层 mask 做差集 + `border-radius:inherit`，因此自动跟随圆角）。环的颜料是 `--lg-rim` / `--sg-rim`：**从 `--lg-edge` / `--sg-edge` 用 `color-mix` 派生**的竖向渐变（上 72% → 中 0 → 下 32%），所以暗色主题不用再写一遍。@supports 同时把 `--lg-hairline` / `--sg-hairline` 切成 `transparent`（让位），不支持 mask 合成的浏览器里这两个 token 仍是原实线边 —— 亮环与旧实线是两套各自完整的设计，不是「降级成半成品」。
- 445-468 **边缘羽化 `.sg-frost`**：`backdrop-filter` + `linear-gradient` mask，让模糊沿一边渐隐（黑=画模糊，透明=底下原样透出）。**只能当兄弟层用**：塞进已有 `backdrop-filter` 的容器里会撞 backdrop root（同 `.el-overlay` 那条坑）。
- 470-521 **材质开关**（一律改 token，不写 `!important`：scoped 选择器带 `[data-v-*]`，裸类名比不过）：`prefers-reduced-transparency` / `prefers-contrast: more` / `print`（合并在 1845 起的那个 print 块，不能另起一块，否则 `test-focus-visible.mjs` 取第一个 print 块会把后台清单截断） / `max-width: 640px` 收一档模糊半径。
- 345-414 基础 reset + 触摸优化（`-webkit-tap-highlight-color:transparent`、`touch-action:manipulation`）+ 小号控件 min-height 32px / coarse 40px 清单。
- 432-479 分类色对比度修正：暗色用 `[data-theme='dark'][data-theme]` 双属性把特指度抬到能压过 scoped `(0,2,0)`；浅色按**后端下发的色值字面量**（`[style*='c9900f']`）逐色点名替换。
- 507-526 coarse 指针下 `font-size:16px !important`，注释明确这是压过 scoped `.form-input[data-v-x]` 的必要手段。
- 528-571 `body` + `body::before`：彩色渐变放在 `position:fixed` 的负层级层，供 `backdrop-filter` 采样（而非 `background-attachment:fixed`）。
- 590-596 `.theme-transition *` 450ms 一次性过渡（由 theme.js 挂/摘）；580-584 优先 View Transitions。
- 704-729 字段级错误 `.field-error/.is-invalid`，与组件里的 `aria-invalid`/`aria-describedby` 配对。
- 738-786 skip-link / sr-only 的键盘与读屏语义（skip-link 被注释要求用 JS 聚焦而非 href 锚点）。
- 802-832 焦点环三层：全局 `:focus-visible`、输入框补环、`.search-box:focus-within` 让环画在外层胶囊。
- 1089-1148 浮层栈 `.float-dock` 与 `.dock-btn` 收敛成一处规格（40px / 移动 36px），`opacity:.8` 悬停或 focus-within 恢复。
- 1151-1165 `.card` 使用 `--lg-sheen + --lg-surface`、`contain: layout paint style`，并显式 `position: relative`做 `::before` 亮环的锚点（`contain: paint` 本已足够，写出来是为了源码里看得见）。
- 1262-1811 Element Plus 皮肤：`:root` 变量→ `.el-overlay`（只上色、绝不上 backdrop-filter，1325-1331 说明 backdrop root 的坑）→ `.el-message` 胶囊 + `::before` 语义色条 → `.el-message-box` / `.el-dialog` → popper/select/dropdown → 表格/标签/按钮的深一档前景色（1418-1529）。
- 1762-1771、2011-2022 两个断点（820 / 860）；1845-2006 打印白名单式 `display:none` 清单（开头一条 `:root` 把 blur/rim 置空）。
- 2101-2145 沉浸阅读 `html[data-focus='on']`：用透明 + `pointer-events:none` 而非 `display:none`，避免正文跳动。

**项目内依赖**：被 `web/src/main.js:30` 与 `web/src/main-home.js:26` 全局引入（两个入口共享）；运行时被 `stores/theme.js` 的 `apply()` 以内联变量反向覆盖（`--accent*` 与 `--el-color-primary*`，99-107）并写 `documentElement.dataset.theme`；首屏由 `web/public/theme-init.js:9` 补 `data-theme='dark'`。类名契约由组件/指令反向依赖：`.sg-liquid`、`.dock-btn`、`.float-dock`、`.reveal/.reveal-stagger`（`directives/reveal.js`）、`.skip-link`、`.theme-transition`、`.page-fade-*`。

**与后端接口约定**：无 API 调用。唯一的数据契约是**分类色 hex 由后端下发**并写成内联自定义属性 `--cat`，本文件按色值字符串匹配并改写文字色（451-479）——即后端换色或改大小写会让样式修正静默失效。

**UI 要点**：覆盖 Element Plus 的 overlay / message / message-box / dialog / popper / select / dropdown / table / tag / button / pagination / loading-mask / input；自研层有液态玻璃、扫光、骨架屏 shimmer、交错入场、页面淡入。可访问性处理密度高：安全区 `env()` 兜底、`overflow-x:clip` 保 sticky、`min-height` 触摸目标、`prefers-reduced-motion` 用 0.01ms 而非 none（保 animationend 仍触发，1817-1820）。

**副作用与失败模式**：`html`/`body` 级规则（`overflow-x:clip`、`tap-highlight`、`:focus-visible`、打印清单）对所有页面生效，任何组件改类名都会跨文件失效；`.reveal` 默认 `opacity:0`，依赖 JS 加 `.in-view`，指令或 IntersectionObserver 失败即内容不可见；`will-change` 常驻于 `.reveal` 及每个 stagger 子元素；`.theme-transition *` 给全页加 `!important` 过渡，挂载时机错会残留。

### web/src/styles/markdown.css（482 行）

**职责**：文章正文（`.markdown-body`）的阅读排版层——标题层级与锚点偏移、首字下沉、引用/行内码/代码块外壳/表格/任务列表/图片/分割线，以及 One Dark 暖调 hljs 配色。

**结构与逻辑**：几乎全部选择器都以 `.markdown-body` 为根，例外三处：`.code-block/.code-head/.ch-left/.code-dots/.code-lang/.code-copy` 是顶层类（代码块外壳由 JS 生成，157-261）；`.detail-content > .markdown-body > p:first-child::first-letter` 是编辑感首字下沉（17-26，`Georgia`、`3.1em`、`float:left`、`line-height:.9`、取 `--accent-text`）；`hr::after` 用 `'· · ·'` + `--bg` 底盖出一条点线分割。标题只到 h4（29-70），h2 用 `::before` 4px 竖条 + 底边线，全部带 `scroll-margin-top: calc(var(--nav-h) + 24px)`。代码块 `.code-copy` 有 `min-width:6.2em` 锁宽防三态（复制/已复制✓/复制失败）抖动，`.copied` 走绿、`.copy-failed` 走冷红，并各自在 reduced-motion 下关掉过渡（218-252）。移动端（255-261）把复制按钮放大到 `8px 14px / 0.8rem`。表格在 ≤640px 变 `display:block` + `overflow-x:auto` + 右侧 22px 渐隐，并给 `table:focus-visible` 焦点环。任务列表、图片（`max-width:100%`、`cursor:zoom-in`、`imgFadeIn`）、hljs 十六组配色（404-469）分块独立。

**项目内依赖**：`web/src/main.js:31` 与 `web/src/main-home.js:27` 全局引入（个人主页入口也吃同一份，因此其中依赖 `.detail-content` 的首字下沉在别处不生效）。DOM 契约来自 `web/src/utils/markdown.js`：代码块外壳与 `.code-copy` 三态类、`<table ... tabindex="0">`（:176）、标题 `id` + `tabindex="-1"`（:306）、GFM checkbox。

**与后端接口约定**：无 API。输入是文章的 markdown 文本，经 `utils/markdown.js` 转成 HTML 后套用本文件；本文件不涉及签名、票据或请求头。

**UI 要点**：不使用 Element Plus 组件，全部是原生标签排版；交互只有复制按钮的视觉反馈与表格横向滚动；可访问性上给表格补 `:focus-visible` 环（332-338）、给任务列表 checkbox `accent-color`、图片 `cursor:zoom-in` 提示可点开灯箱。

**副作用与失败模式**：全局选择器，任何渲染 `.markdown-body` 的地方（详情页、预览、留言）都会吃到同一套排版；`imgFadeIn` 对每张图各跑一次 0.6s；≤640px 的 `display:block` 会改变表格的无障碍角色（见观察）。

### web/src/styles/list-page.css（128 行）

**职责**：收藏页（Bookmarks）与阅读足迹页（History）共用的页面皮肤，靠 `@import` 注入到两个 SFC 的 `<style scoped>`，避免两边样式漂移。

**结构与逻辑**：`.bookmarks-page` 只管底部留白；`.bm-grid` 用 `repeat(auto-fill, minmax(330px, 1fr))` 自适应列；`.bm-item` 为定位容器，`.bm-remove` 绝对定位在右上（`rgba(29,27,22,.72)` 深底 + 白图标 + `blur(4px)`），默认 `opacity:0; translateY(-3px)`，`.bm-item:hover` 才显形，`(hover:none)`/`≤640px`/`≤700px` 三处兜底常显；`.bm-clear` 是页头右侧的次级按钮，hover 转红并发 8% 淡红底；`.bm-go` 是空态里的胶囊链接，hover 反色。失效条目 `.bm-item--stale` 仅降到 `opacity:.72`，`.bm-stale-note` 用虚线 + `--bg-soft` 画一块说明区，保留条目而不给死链。本文件还**重定义**了 `.page-head .eyebrow`（7-14）。

**项目内依赖**：`views/site/Bookmarks.vue:142`、`views/site/History.vue:134` 的 `<style scoped> @import '@/styles/list-page.css'`；类名由这两个视图的模板消费（`bookmarks-page` / `bm-item` / `bm-remove` / `bm-stale-note`），卡片外观来自 `components/site/ArticleCard.vue`，动画来自 `v-reveal="'stagger'"`。颜色全部读 main.css 的 token。

**与后端接口约定**：本文件不触达 API；按钮点击调用的是 `utils/bookmark` 的本地存储（`getBookmarks/removeBookmark/clearBookmarks`），无请求头、无票据、无签名。

**UI 要点**：无 Element Plus 组件，纯自研 hover 显隐 + 触屏兜底；可访问性只做了 `role="note"`（在视图里）与按钮 `:title`，未见焦点可见性处理。

**副作用与失败模式**：`@import` 进 scoped 块不会被加 `data-v` 属性，实际是**全局**规则；两个视图各自打包一份 → 同一份 CSS 出现在两个 chunk；`.bm-*` 类名进入全局命名空间，无前缀隔离。

## 观察

1. **main.css:843-852 与 main.css:1831-1839 是同一段全局 reduced-motion 兜底**，后者还多一条 `.fade-up/.reveal` 处理；前者完全被覆盖，属历史残留。
2. **main.css:573-576 与 main.css:1576-1579 逐字重复 `::selection`**（第二次才带暗色变体）：同一属性写两遍，暗色规则只挂在后一处，改色时容易只改一处。
3. **main.css:743 `.skip-link { z-index: 9999 }` 是裸值**，直接违反 117-127「全站唯一的层级来源、组件里不要再写裸数字」，且高于 `--z-toast:5000` 与注释里"EP 从 2000 起"的约定。
4. **main.css:451-479 依赖 `[style*='c9900f']` 这类小写字面量匹配**：CSS 属性选择器的值区分大小写，后端若输出 `#C9900F` 或 `rgb()` 形式，全部对比度修正静默失效，且不报错。
5. **main.css:469-479 黛绿/黛蓝两条漏了 `.grid-pin`**（琥珀 451-456、绛红 460-465 都有）：浅色主题下置顶徽标仍是 4.33:1，与同段注释"差一点点"的整改目标不符。
6. **main.css:451 起整套 `[data-theme='light']` 修正只在 theme.js `apply()` 之后成立**：`web/public/theme-init.js:9` 首屏仅写 `dark`，浅色首帧没有该属性 → 修正延迟生效；若 JS 报错则永久不生效。
7. **main.css:386-399 与 main.css:403-412 两份触摸目标清单不一致**：coarse 版漏了 `.ticker-close`、`.emoji-toggle`，触屏上这两处仍按桌面 32px 兜底。
8. **main.css:1446-1460 的变量级修复只覆盖 6 个容器类**，而 1065 的 `--el-text-color-secondary: #9a937f`（白底约 2.7:1）仍被 `el-descriptions`/`el-empty`/`el-alert` 等读取，1418-1432 声称的 18 项整改并未真正收口。
9. **main.css:1590-1591、1603-1605 把 `will-change` 永久留在元素上**且从不清除：列表页每张卡各成一层，长页面上合成层数量与显存随条目线性增长。
10. **main.css:1600-1619 的交错延迟只写到 `nth-child(8)`**：第 9 项起无 `transition-delay`，与"交错入场"意图不符（网格一行 3 个、两行即越界）；同时 `.reveal` 默认 `opacity:0`，指令失败即整块内容不可见。
11. **main.css:1642、1881、1907 引用 `.ambient`，但本文件从不定义它**（定义在 `components/site/AmbientParticles.vue:120`）：跨文件隐式契约，改类名会让打印隐藏与沉浸模式静默失效。
12. **main.css:1193 的 `--el-messagebox-width: 440px` 是死变量**：1195 已用 `width: min(440px, ...) !important` 直接定宽，EP 读该变量的路径被绕过。
13. **markdown.css:342-357 与 markdown.css:471-482 是同一功能（GFM 任务列表）的两套实现**，`margin-left` 分别 -1.2em / -1.25em、`accent-color` 分别 `--accent-fill` / `--accent`，后写规则只覆盖部分属性 → flex 布局与 -1.25em 混搭，checkbox 同时吃 `gap:.5em` 与 `margin-right:6px` 的双份间距。
14. **markdown.css:321 `table { display:block }`（≤640px）会丢掉表格的隐式 table 角色**（Chrome/Safari 以此判定角色），与 `utils/markdown.js:173-176` 明确"不能加 role、要保持隐式 table 角色"的取舍正面冲突。
15. **markdown.css:327-329 只声明 1 层 `background`，却给 `background-attachment` 两个值**（`local, scroll`）：多出的值按规范被丢弃，"渐隐随内容滚动"的意图不成立。
16. **markdown.css:29-38 只定义到 h4**：h5/h6 既无字号也无 `scroll-margin-top`，目录跳到 h5 会被固定导航压住。
17. **markdown.css:17-26 首字下沉用 `float:left` + `line-height:.9` + 3.1em**，中文首字与首行基线易重叠；且选择器写死 `.detail-content > .markdown-body`，其它容器里渲染的正文静默无效果。
18. **list-page.css:11 的 0.74rem 与 main.css:884 的 0.72rem 冲突**，而 Archive/ArticleList/Tags/Messages/Links/About 六个视图又各抄了一份 0.74rem → 同一元素 8 处定义，main.css 那条已成死规则。
19. **list-page.css:47-69 `.bm-remove` 只在 hover 显形且无 `:focus-visible` 规则**：键盘 Tab 会落在 `opacity:0` 的按钮上，看不到焦点在哪。
20. **list-page.css:52-53 的 30×30 小于 44×44**，且未被 main.css:386-412 的下限清单收录，"触屏常显"解决的是可见性而非可达性。
21. **list-page.css:79-81 hover 用 #c24b5e 压 8% 淡底（≈4.0:1）**，正是 main.css:458-465 用 #9e3548 修掉的同一问题在此处回潮。
22. **list-page.css:113-115 用 `opacity:.72` 表达"弱一档"**，恰恰是 main.css:992-997 明确反对的做法（叠透明度会把已合规的 5.34:1 拉到 4.3 左右），而这里淡化的正是"为什么不可访问"的说明文字。
23. **list-page.css:36-38 `minmax(330px, 1fr)`**：360px 屏减去左右 `max(16px, --sal)` 后内容宽 328px < 330px → 轨道溢出 2px，被 main.css:356 的 `overflow-x:clip` 静默裁掉。
24. **list-page.css:51 `z-index:5` 裸值**，与 main.css 的 `--z-*` 契约不符；且 72-77 与 101-109 两个媒体查询重复表达"常显删除按钮"。

## 小结

- main.css 是整个前端的**视觉与可访问性宪法**：主题变量、玻璃材质、层级、打印、reduced-motion 全在此处，任何组件级样式都在与它的特指度和注入顺序博弈（文件里 427-431、508-514、1433-1436 三次记录了同一类踩坑）。
- 它与 JS 的耦合是双向的：`stores/theme.js` 用内联变量反向覆盖 `--accent*`/`--el-color-primary*`，`public/theme-init.js` 只负责首帧的暗色属性；三处字面量（CSS/store/首屏脚本）必须同值，这是本项目最脆的隐式契约。
- markdown.css 是**内容层**排版，只对 `.markdown-body` 生效，其 DOM 契约完全由 `utils/markdown.js` 生成；它被两个入口全局引入，因此"文章排版"实际是全站生效的公共样式。
- list-page.css 是**页面级**皮肤，通过 `@import` 注入两个 scoped 块，实为全局注册；它只管收藏/足迹两页的卡片列与失效条目表达，数据来自本地存储而非后端。
- 边界：三个文件都不发起请求、不处理签名或票据；它们决定"长什么样"，不决定"取什么数据"。修改时真正要守的边界是——不新增裸 `z-index`、不新增 `opacity` 淡化文字、不在 coarse 指针下留 16px 以下的输入框。
