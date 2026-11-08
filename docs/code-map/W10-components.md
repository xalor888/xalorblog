# W10 · 共享组件 / composable / 指令

覆盖 `web/src/components/{site,ui,home}`、`web/src/composables`、`web/src/directives` 共 16 个文件，全部逐行读完。

---

### web/src/components/site/CommentSection.vue（894 行）

评论区容器：表单 + 排序 + 折叠列表 + 直达高亮。

- **结构**：`h3` 标题带 `total` 徽标与「最早/最新」segmented 按钮（`v-if="total > 1"`）→ `.comment-form`（昵称/邮箱/网站/蜜罐/EmojiPicker/回复上下文/textarea/操作行）→ 三态列表（loading 三点 / loadFailed 重试 / `CommentItem` 递归树 / empty）。
- **props**：`articleId: Number required`、`initialHighlight: Number|String`（`?comment=12` 直达）。**状态**：`comments`（树）、`total`、`submitting`、`replyingTo`、`flashId`、`showAll`、`loading`、`loadFailed`、`sortOrder`、`fieldErrors`、`hpField`、`showEmoji`。
- **实际逻辑**：`load()` 用 `loadSeq` 递增序号丢弃过期响应（`L238-269`）；`countAll` 递归求和得 `total`；`findDepth` 递归找目标评论层级并据此 `showAll=true`，再 `document.querySelector('.comment-card[data-id]')` 滚动；`submit()` 先 trim 校验→`getFormTokenInfo('/comments')` 拿 `{token, hpField}`→`commentApi.create` 带动态蜜罐字段与 `X-Hp-Field` 头→成功按 `created.moderated` 决定提示文案→清草稿→`refreshFormToken`→重新 `load()`→`scrollToNewComment(created.id)` 精确锚定。
- **草稿**：`loadDraft(DRAFT_KEY())` 在 setup 期同步恢复（24h 内），`watch(content)` 800ms 防抖 `saveDraft`，`beforeunload` 与 `onUnmounted` 调 `flushDraft()` 强制落盘。
- **依赖**：`@/components/ui/XIcon.vue`、`EmojiPicker.vue`、`./CommentItem.vue`、`@/api`（`commentApi`）、`@/utils/formToken`（`getFormTokenInfo/getHpField/refreshFormToken`）、`@/utils/secureStorage`（`readSessionValue/writeSessionValue`）、`@/utils/localDraft`、`@/stores/site`、`element-plus` 的 `ElMessage`。
- **接口约定**：`GET /comments/article/:articleId?sort=asc|desc` → 根评论数组树（`id/parent_id/nickname/website/content/likes/created_at/is_admin/children[]`）；`POST /comments`（`article_id/parent_id/nickname/email/website/content/[hpField]/form_token` + `X-Hp-Field`）→ 含 `id…moderated` 的行；`GET /anti/seed?for=/comments` → `{token,hp_field}`。令牌路径绑定、10 分钟 TTL、nonce 一次性、2.1s 最小提交年龄。
- **UI/交互**：`aria-pressed` 排序、`aria-invalid`+`aria-describedby`+`role="alert"` 字段级报错、`focusFirstError()` 失败后聚焦首个错误字段、Ctrl/Cmd+Enter 提交、Enter 从昵称顺移焦点、表情插入按 `selectionStart/End` 落光标、`.hp-field` 用 `left:-9999px` 隐藏且 `tabindex=-1`、`prefers-reduced-motion` 关闭表情淡入、`@media (hover:none)` 隐藏快捷键提示。
- **副作用/失败**：`localStorage`（`xalor_csort/cname/emoji_open/cdraft_{id}`）+ `sessionStorage` 邮箱；两处全局 `document.querySelector`；`beforeunload` 监听已在卸载时移除；提交异常无本地提示。

### web/src/components/site/CommentItem.vue（435 行）

单条评论 + 递归子回复 + 点赞 + 复制直达链接。

- **结构**：`<article aria-label>` 包 `.comment-card#comment-{id}[data-id]`（头像 / 昵称+管理员皇冠+网站外链+时间 / 正文含 `@上级` / 点赞+回复 / `.children` 递归自身）；`<transition>` 的内部必须是单元素，因此 `v-for` 被包在 `.children-list` 里。
- **props**：`comment(required)`、`depth`、`replyToName`、`highlightId`、`floor`；`emits: reply`。
- **逻辑**：`depth < 2 || expanded` 控制深层折叠，`watch(highlightId, immediate)` 在本节点或子树包含目标时自动展开（`containsId` 递归）；`isHighlighted` 驱动 `flashHighlight` 2.2s 动画；`likeComment()` 先 `+1` 乐观更新再 `commentApi.like`，成功用服务端 `likes` 覆盖，失败回滚；`copyCommentLink()` 拼 `origin + pathname + hash去查询 + ?comment=id`，优先 `navigator.clipboard`，兜底 `execCommand` 且**读取真实布尔返回值**（iOS 需 `setSelectionRange`）；`avatarColor` 用 `h*31+charCode` 取 6 组渐变。
- **依赖**：`XIcon`、`@/api`、`@/utils/format`（`timeAgo`）、`ElMessage`。
- **接口约定**：`POST /comments/:id/like` → `{likes:number}`（服务端按 IP 做 10s 窗口限流，超限计信誉）。
- **UI/交互**：`aria-pressed`+动态 `aria-label` 播报「已点赞/当前 N 赞」；`aria-expanded` 展开按钮；`white-space: pre-wrap` 保留评论换行；`prefers-reduced-motion` 关闭展开淡入；`[data-theme='dark']` 单独调皇冠金色。
- **副作用/失败**：`localStorage[xalor_clike_{id}]` 作「同设备已赞」唯一凭据；点赞失败静默回滚，无 toast（依赖 api 拦截器）。

### web/src/components/site/AskAi.vue（565 行）

文章页「问这篇」AI 浮窗：SSE 流式回答 + 一键问题 + 复制。

- **结构**：两个 Teleport —— 按钮进 `#float-dock`（不存在则退 `body`），面板单独挂 `body` 并靠 `--ask-bottom` 贴浮层栈上方；面板内 `ask-hello`（3 个建议问题）/ `ask-list`（用户/助手气泡、流式纯文本 + 光标、完成态 markdown）/ `ask-form`。
- **props**：`slug: String required`。**状态**：`open/available/bottomOffset/dockTarget/messages/draft/pending`，模块级 `controller`、`retryTimer`。
- **逻辑**：`checkAvailable()` 先 `await ensurePass()` 再 `signedFetch('/ai/status')` 读 `data.ready`；`scheduleRetry()` 每 10s 最多 6 次；`send()` push 用户消息 + 空助手消息，**从数组读回代理对象**再写 `reply.content`（裸对象写入不触发渲染，注释记录实测 0 次重渲染）；`history` 取非流式且非空的最后 6 条；流用 `getReader()` + `TextDecoder`，按 `\n\n` 分帧、取每块第一条 `data:` 行 JSON，处理 `text/status/error` 三类事件；`429` 单独文案；`finally` 收尾 `streaming/pending`。
- **依赖**：`XIcon`、`@/utils/signedFetch`（`signedFetch`）、`@/utils/pass`（`ensurePass`）、`@/utils/markdown`（`renderMarkdown` → marked + DOMPurify 消毒）。
- **接口约定**：`GET /ai/status` → `{data:{ready}}`；`POST /ai/ask`（`{slug,question,history}`，`Accept: text/event-stream`）→ SSE，事件 `data:{"type":"text"|"status"|"error"}`；闸门头 `Authorization/X-Pass/X-Fp/X-Timestamp/X-Nonce/X-Sig`（HMAC over `METHOD|path|ts|bodyHash|jti|nonce`）；并发一问返回 429。
- **UI/交互**：流式期用纯文本（markdown 块级元素会挤走光标）；`.ask-cursor` 内联闪烁；完成后「复制/已复制」自反馈；`max-width:640px` 时改成贴底抽屉；`z-index: calc(var(--z-float)+40)` 自带层级。
- **副作用/失败**：`resize` 监听器中量 `#float-dock` 实际高度；面板无 ESC 关闭、无焦点进入/陷阱、无 `role="dialog"`；`controller` 从不 `abort()`；轮询上限 6 次后入口永久隐藏。

### web/src/components/site/ArticleCard.vue（393 行）

文章卡片（feed / card 两种 `variant`）。

- **结构**：根节点即 `<router-link :to="/article/{slug}">`；封面（lazy img + shimmer + `cover-err`）→ 分类/日期 → `<component :is="h${headingLevel}">` 标题 → 摘要 2 行 clamp → 前 2 个标签 → `foot`（阅读全文 + 三计数）→ `pin` / `hot-badge`。
- **props**：`article`、`variant`（默认 `card`）、`headingLevel`（默认 3，调用方按页面大纲传 2/3 避免 h1→h3 跳级）。
- **逻辑**：无请求；图片 `@load` 加 `.loaded` 去模糊缩放、`@error` 加 `.failed` 由 `:has()` 切到占位层。
- **依赖**：`XIcon`、`@/utils/format`（`formatDate`）。
- **接口约定**：纯展示，字段来自 `articleApi.list` → `slug/cover/title/summary/category_name/category_color/published_at/tags[{id,name}]/views/comment_count/likes/is_top`。
- **UI/交互**：液态玻璃变量（`--sg-*`）、hover `translateY(-4px) scale(1.01)`、`read-more` 箭头位移、分类色用 `--cat` 自定义属性 + `color-mix`、`-webkit-line-clamp` 截断。
- **副作用/失败**：无副作用；封面失败态依赖 `:has()`（旧内核不生效，会留空白块）。

### web/src/components/site/AmbientParticles.vue（127 行）

全屏 canvas 环境粒子。

- **结构**：单 `<canvas class="ambient" aria-hidden="true">`，`position:fixed; inset:0; z-index:0; opacity:.55`。
- **逻辑**：`resize()` 按 `min(dpr,2)` 设位图尺寸并 `setTransform` 缩放；`seed()` 生成 36（<720px）/72 个粒子（`x/y/r/s/a/drift`）；`tick()` 每帧清屏、逐粒子下落 + 横向漂移、越界回卷、`globalAlpha` 绘制圆弧后自递归 `requestAnimationFrame`；`nextFillColor()` 每帧向目标色插值 0.12，避免主题切换整层瞬变；`visibilitychange` 隐藏时 `cancelAnimationFrame`，显示且 `raf===0` 时重启。
- **依赖**：仅 `vue`。
- **接口约定**：无。
- **UI/交互**：`pointer-events:none` 不挡点击；`prefers-reduced-motion` 下直接不启动（也不注册监听）。
- **副作用/失败**：常驻 rAF 合成成本；`onResize` 重建粒子并丢帧；主题色取自 `document.documentElement.dataset.theme`。

### web/src/components/ui/SearchModal.vue（671 行）

全局搜索弹窗（Ctrl/Cmd+K、`/`、自定义事件 `xalor-open-search` 三种入口）。

- **结构**：Teleport 到 body 的遮罩 + `role="dialog" aria-modal` 面板；head（图标/输入/关闭按钮/ESC kbd）、body（loading / 结果列表 / 无结果 / 历史 / 提示四态）、foot（↑↓、Enter、ESC 说明）。
- **状态**：`open/keyword/results/total/loading/searched/lastKeyword/activeIndex/inputRef/history`，模块级 `debounceTimer`、`searchSeq`、`lastFocused`。
- **逻辑**：`debouncedSearch` 300ms；`search()` 用 `searchSeq` 守卫过期响应；`saveHistory` 去重后按 `HISTORY_MAX=6` 截断，`loadHistory` **读取时也截断并过滤非字符串**（注释记录注入 8 条会全渲染）；`openSearch()` 幂等守卫（Ctrl+K 会同时命中本组件与 Layout 的 window 监听，重复 `lockBodyScroll` 会永久锁死滚动）；`close()` 反向解锁并归还焦点（无有效触发元素时退回 `.search-btn / [data-open-search]`）；`onTabTrap` 用放宽的可聚焦选择器，焦点不在弹窗内无条件拉回。
- **依赖**：`vue-router`、`XIcon`、`@/api`（`articleApi`）、`@/utils/format`、`@/utils/highlight`（`highlightKeyword`）、`@/utils/scrollLock`（计数锁）。
- **接口约定**：`GET /articles?pageSize=8&keyword=…` → `{list:[{id,slug,title,summary,category_name,category_color,published_at,views}], pagination:{total}}`（走 axios 拦截器签名，非 `signedFetch`）。
- **UI/交互**：`v-html="highlight(...)"` 高亮（`mark` 由 `highlightKeyword` 转义生成）、`aria-live="polite"` 播报结果区、鼠标 hover 同步 `activeIndex`、`scrollActiveIntoView` 保持键盘选中可见、`@media (pointer:coarse)` 把关闭按钮 40px。
- **副作用/失败**：`lockBodyScroll/unlockBodyScroll` 计数配对（卸载时兜底解锁）；搜索失败 `catch` 完全吞掉，界面停在旧结果/无提示。

### web/src/components/ui/ImageLightbox.vue（441 行）

正文/手记图片灯箱：缩放、拖拽平移、双指捏合、焦点归还。

- **结构**：Teleport + `<transition name="lightbox">`，`role="dialog" aria-modal`；关闭按钮、`.lb-stage`（wheel/dblclick/mouse/touch 全套事件）、缩放控制条（仅 `zoom>1` 显示，含百分比复位）、`caption`、`hint`。
- **状态**：`visible/src/alt/zoom(1..4)/dragging/stageRef`，闭包 `dragStart/pinchDist/lastFocused/lastFocusedImg`。
- **逻辑**：`open(src, alt, opener)` 重置缩放、仅在未打开时加锁、`nextTick` 聚焦关闭按钮；`close()` 优先还焦点给 `lastFocused`，否则找 `closest('a[href],button,[role=button]')`，都失败才给图片补 `tabindex="-1"`（注释记录不能直接 `closest('[tabindex]')`，会命中 `<main tabindex="-1">`）；`zoomBy` 夹在 1–4 并 `toFixed(2)`；滚轮±0.25、双击 1↔2、`+/-/0` 键；放大后拖拽通过改 `stage.scrollLeft/Top` 平移；触摸双指按 `Math.hypot` 间距比例缩放；`onTabTrap` 与搜索弹窗同款。
- **依赖**：`XIcon`、`@/utils/scrollLock`。
- **接口约定**：无；对外 `defineExpose({ open })`。
- **UI/交互**：`touch-action: pan-x pan-y` + `@touchmove.prevent`、`:has(.lb-img.zoomed)` 切 grab 光标、`draggable="false"` + `user-select:none`、`lbZoom` 入场动画。
- **副作用/失败**：滚动锁按 `visible` 配对；无 `prefers-reduced-motion` 分支；缩放同时用 `transform: scale()` 与 `.zoomed{max-width:none}` 改布局尺寸，两者叠加导致实际可视倍数与百分比标签不一致。

### web/src/components/ui/ShortcutHelp.vue（297 行）

`?` / Shift+/ 唤起的快捷键说明弹窗。

- **结构**：遮罩 + `role="dialog" aria-modal aria-labelledby` 面板；head（标题 + 关闭）、body（`groups` 三组：全局/文章页/后台编辑，`keys` 按空格拆成多个 `<kbd>`）、foot 提示。
- **状态**：`open/panelRef/closeBtnRef/lastFocused`。
- **逻辑**：`onKeydown` 全局监听，`INPUT/TEXTAREA/contentEditable` 内不触发；`?` 或 `Shift+/` 切换；`Escape` 关闭（无条件调用 `close()`）；`openHelp()` 记录 `lastFocused`（`body` 视为 null）+ `lockBodyScroll` + 聚焦关闭按钮；`close()` 解锁并在 `nextTick` 检查 `document.contains(back)` 再还焦点；`watch(route.path)` 自动关闭；`defineExpose({ openHelp })` 供导航栏按钮调用。
- **依赖**：`vue-router`、`XIcon`、`@/utils/scrollLock`。
- **接口约定**：无。
- **UI/交互**：`@keydown.tab="onTabTrap"`（绑在面板上）；`--z-modal-2 + 10` 层级高于搜索弹窗；液态玻璃 `--lg-*`。
- **副作用/失败**：`toggle()`（`L112-119`）无人调用；面板级 Tab 陷阱在焦点位于面板外时不生效。

### web/src/components/ui/RouteProgress.vue（96 行）

路由切换顶部 3px 进度条（纯装饰动画，无百分比）。

- **结构**：`v-show="!onArticle"` 的固定条 + 内部 `.rp-bar`。
- **逻辑**：`onArticle = /^\/article\//.test(route.path)`（文章页已有阅读进度条，避免两条平行细线）；`router.beforeEach` 置 `visible=true`，`afterEach` 延时 350ms 置 false，`onError` 立即隐藏；`onUnmounted` 清两个定时器。
- **依赖**：`vue-router`。
- **接口约定**：无。
- **UI/交互**：`rpSlide` 无限滑动 + `overflow:hidden` 裁剪（注释记录 375px 下曾溢出 46px）；不可见时 `visibility:hidden` + `animation-play-state:paused` 真正脱离动画时间线；`aria-hidden` + `pointer-events:none`。
- **副作用/失败**：注册的路由守卫从不注销。

### web/src/components/ui/EmojiPicker.vue（86 行）

评论表情面板（三组共 40 个 emoji）。

- **结构**：`groups`（情绪/手势/物品）→ 每组 `label` + `.emoji-row` 按钮，点击 `emit('insert', e)`。
- **依赖**：无（纯静态数据）。
- **接口约定**：无。
- **UI/交互**：按钮 `title` 为 emoji 本身，hover `scale(1.2)`；分组间虚线分隔。
- **副作用/失败**：无状态、无持久化、无最近使用。

### web/src/components/ui/SkeletonList.vue（62 行）

列表骨架屏。

- **props**：`count`（默认 4）、`cover`（默认 true）。
- **结构**：`grid auto-fill minmax(320px,1fr)`，每项可选 160px 封面块 + 三条 85%/60%/40% 宽度骨架线，容器 `aria-hidden="true"`。
- **依赖**：无。
- **接口约定**：无。
- **UI/交互**：`max-width:700px` 降为单列。
- **副作用/失败**：无；骨架条宽度写成内联 style 常量。

### web/src/components/ui/XIcon.vue（59 行）

lucide 图标的白名单包装。

- **结构**：`<component :is="iconComponent" :size :stroke-width :fill :absolute-stroke-width="true">`。
- **props**：`name(required)`、`size`(18)、`strokeWidth`(1.8)、`fill`。
- **逻辑**：`ICONS` 显式映射约 95 个图标（避免全量引入、可 tree-shake），未命中回退 `Activity`；`resolvedFill` 把 `true/'true'` 归一为 `currentColor`、字符串原样透传、其余 `none`（`Heart :fill="liked"` 即实心/描边切换）。
- **依赖**：`lucide-vue-next`。
- **接口约定**：无。
- **UI/交互**：`absolute-stroke-width` 让缩小时线宽不塌；无 `aria-hidden`（图标本身无文本，依赖父级 `aria-label`）。
- **副作用/失败**：无。

### web/src/components/home/NoteCard.vue（228 行）

手记时间线卡片。

- **结构**：`<article class="note-card sg-liquid">`：head（头像/站名/`<time datetime>`+位置/置顶 Pin/心情标签）→ `router-link /notes/{id}`（摘要 + `truncated` 时的「…… 展开」 + 首图 + `+N` 余数角标）→ foot（查看全文 / 点赞按钮）。
- **props**：`note(required)`、`avatar`、`authorName`（默认 `'Xalor'`）、`likeAction: Function`（**用函数 prop 而非 emit**，为了 `await` 真实请求，429 时不会误标已赞）。
- **逻辑**：`truncated = excerpt.length >= 200`；`onLike()` 串行守卫 `liking/liked`，`await likeAction(note)` 成功才置 `liked`。
- **依赖**：`XIcon`、`@/utils/format`（`timeAgo`）。
- **接口约定**：点赞动作由父组件注入（最终打到 notes 的 like 接口），组件本身零请求。
- **UI/交互**：`aria-label="心情：…"` 补语义；`.nc-name` 单行省略（注释记录 40 字无空格站名会在 390px 屏顶出 200px 横向滚动）；`nc-pin + nc-mood` 用相邻选择器修 `margin-left:auto` 冲突；`::datetime` 供读屏/机器解析。
- **副作用/失败**：`liked` 仅内存态（无 localStorage），刷新可重复点赞；失败静默。

### web/src/components/home/NoteImages.vue（78 行）

手记九宫格 + 灯箱桥接。

- **结构**：`v-if="list.length"` 的 grid，类名 `n-{min(len,9)}`；每格 `<button :aria-label="查看第 N 张图片">` 包 `<img loading=lazy>`；末尾挂 `ImageLightbox`（Teleport 到 body，不占格）。
- **props**：`images: Array`。**逻辑**：`list` 过滤空值并 `slice(0,9)`；`open(i)` 调 `lightboxRef.open(src, '')`。
- **依赖**：`@/components/ui/ImageLightbox.vue`。
- **接口约定**：无。
- **UI/交互**：`n-1` 单图不裁切（`aspect-ratio:auto; max-height:420px; object-fit:contain`），其余 1:1 `cover`；hover 描边 + 上移 1px。
- **副作用/失败**：无；灯箱 `alt` 恒为空。

### web/src/composables/useMedia.js（25 行）

管理后台窄屏断点单例。

- **导出**：`BREAKPOINT_ADMIN = 820`、`useIsMobile()`（返回共享 `ref`）。
- **逻辑**：模块级 `matchMedia('(max-width: 820px)')`，`change` 事件写 `isMobile`；`bound` 标志防重复绑定；无 `window`（SSR/测试）时 `mq=null`，初值 false 且永不更新。
- **依赖**：`vue`。
- **接口约定**：无。
- **UI/交互**：供 Layout 与各管理视图共用一份监听从决定表格裁列/操作列解固定/表单纵排；与各视图 CSS 媒体查询的 820px 需人工保持一致。
- **副作用/失败**：模块级副作用（导入即注册）；只支持 `addEventListener` 写法；返回的 ref 可被任意调用方写。

### web/src/directives/reveal.js（50 行）

`v-reveal` 滚动揭示指令。

- **导出**：`revealDirective`（`mounted/updated/unmounted`）、`installReveal(app)`。
- **逻辑**：模块级单例 `IntersectionObserver`（`rootMargin:'0px 0px -8% 0px'`, `threshold:0.08`），进入视口加 `.in-view` 并 `unobserve`（只触发一次）；`binding.value === 'stagger'` 时加 `.reveal-stagger`，否则 `.reveal`；不支持 IO 或 `prefers-reduced-motion` 时直接加 `.in-view` 跳过动画；`updated` 在未 `in-view` 时重新 `observe`；`unmounted` `unobserve`。
- **依赖**：无。
- **接口约定**：无。
- **UI/交互**：`reveal` / `reveal-stagger` 两个类名由全局 CSS 定义，交错延迟完全在 CSS 侧。
- **副作用/失败**：观察器从不 `disconnect()`；`stagger` 不接受自定义延迟/方向参数。

---

## 观察

1. `web/src/components/site/CommentSection.vue:207` — `DRAFT_KEY` 是读当前 `props.articleId` 的函数，而 `watch(content)`（`L229-232`）在保存时重新求值：文章切换后，上一条文章的正文会被写进**新文章**的草稿键，同时旧文章的草稿残留。
2. `web/src/components/site/CommentSection.vue:416-423` — `catch` 只按 403 决定刷令牌；服务端 `verifyToken` 通过即把 nonce 记入 `USED`，故一次 500 后缓存令牌已作废，下次提交必多吃一次「令牌已被使用」。
3. `web/src/components/site/CommentSection.vue:105` — 提示写死 `Ctrl+Enter`，而 `L338-343` 同时支持 `metaKey`；mac 用户看不到可用快捷键，文案与实现不一致。
4. `web/src/components/site/CommentSection.vue:193` + `:464` — setup 期 `getHpField` 只读缓存（默认 `'hp_website'`），挂载后才真正签发；`hpField` 换名后旧 `form` 键值残留成脏字段。
5. `web/src/components/site/CommentItem.vue:24` — `<span class="time" @click>` 承担「复制评论链接」，无 `tabindex`/`role`/键盘事件；`L12` 头像 `div @click` 同理。键盘与读屏用户拿不到这两个能力。
6. `web/src/components/site/CommentItem.vue:135` — 直接改 `props.comment.likes`（prop 内部可变），父级 `total`/排序视图不会感知；配合 `L127/L141` 只把「已赞」记在 `localStorage`，清存储或换设备即可重复点赞，服务端仅 10s IP 窗口限流。
7. `web/src/components/site/CommentItem.vue:100-114` — `containsId` 递归 + 每个实例 `immediate` 跑一次全子树扫描；直达深度回复时是 O(节点数²)，长楼（数百条）首屏可见卡顿。
8. `web/src/components/site/CommentItem.vue:125-129` — 外层 `try` 包内层 `try/catch`，外层 catch 永不可达，冗余防御。
9. `web/src/components/site/AskAi.vue:193` — `history` 在 `push` 之后过滤 `messages`，末尾元素就是刚提交的当前提问，于是问题同时出现在 `question` 与 `history` 末位，模型收到重复提问。
10. `web/src/components/site/AskAi.vue:191` + `:275-281` — `AbortController` 创建后从不 `abort()`，`onUnmounted` 只清轮询与 resize；关闭面板/切路由后流仍在读，写入的是已卸载组件的状态，白耗 token 与带宽。
11. `web/src/components/site/AskAi.vue:221` — 每个 `\n\n` 帧只取第一条 `data:` 行，`\r\n\r\n` 不识别；服务端当前单行 `res.write` 可用，但任何多行 data 或多事件粘连都会被静默丢弃。
12. `web/src/components/site/AskAi.vue:13` — 面板是 `<section>`，无 `role="dialog"`/`aria-modal`/ESC 关闭/焦点进入；与 SearchModal、ImageLightbox 已经做全的模态规范不一致（同一产品里三套标准）。
13. `web/src/components/site/AskAi.vue:135-171` 与 `web/src/components/site/CommentItem.vue:176-195` — clipboard→`execCommand`→iOS `setSelectionRange` 的复制兜底被完整抄了两份，未抽 `utils/clipboard`。
14. `web/src/components/site/ArticleCard.vue:2` — 整张卡片是单个 `<router-link>`，`h{level}`、摘要、`views/comment_count/likes` 全在链接内：读屏会把整段念成链接名，标题也无法用「按标题跳转」单独定位。
15. `web/src/components/site/ArticleCard.vue:56` — 「热门」阈值 `views >= 500` 硬编码在展示组件里，全站唯一口径却在最不该放的地方，改阈值要动前端发版。
16. `web/src/components/site/AmbientParticles.vue:51` — `tick()` 每帧调用 `c.getContext('2d')`，并每帧读 `window.innerWidth/innerHeight`；60fps 下重复取 context/触发重排读取，属可省的常驻开销。
17. `web/src/components/ui/SearchModal.vue:4` — 遮罩上的 `@keydown.esc` 永不触发（`div` 不可聚焦，键盘事件不会落到它身上），ESC 实际由 `L333` 的 document 监听处理：死代码，且让后来者误以为有两条关闭路径。
18. `web/src/components/ui/SearchModal.vue:107-109` 与 `:364-369` — 同一份「路由变化即关闭」的 watcher 写了两遍（setup 顶层 + `onMounted` 内），每个实例多挂一个监听。
19. `web/src/components/ui/SearchModal.vue:199-201` — `finally` 无条件 `loading=false`，而 `L190` 又用 `searchSeq` 丢弃过期响应：快速输入时旧响应会把新请求的 loading 熄掉，出现「无 spinner 但结果未到」的空窗（`CommentSection.vue:267` 的同类守卫写法是对的）。
20. `web/src/components/ui/SearchModal.vue:337` — 无结果时 `Math.min(activeIndex+1, results.length-1)` 得到 `-1`，`activeIndex` 变负；仅靠 `results[-1] === undefined` 兜住，`scrollActiveIntoView` 也查不到元素。
21. `web/src/components/ui/SearchModal.vue:37-42` — 结果项是 `<a>` 却没有 `href`：不可聚焦、不支持中键新标签，视觉是链接但语义不是，键盘只能靠 document 级方向键。
22. `web/src/components/ui/ImageLightbox.vue:70-72` + `:365-368` — 缩放同时用 `transform: scale()` 与 `.zoomed` 放开布局尺寸，两套放大叠加；百分比标签与实际倍数不符，可平移范围跳变。
23. `web/src/components/ui/ImageLightbox.vue:220-226` — `Escape` 在 `if (!visible.value) return` 之前处理，未打开时任何 Esc 也会走一遍 `close()`；同时 `+/-/0` 只在打开时生效，行为不对称。
24. `web/src/components/ui/ShortcutHelp.vue:14` — `@keydown.tab` 绑在面板自身，焦点在面板外时事件根本进不来，`L66` 的 `!panel.contains(active)` 分支几乎不可达：`aria-modal="true"` 宣称的焦点约束实际不成立（另两个弹窗用的是 document 级监听）。
25. `web/src/components/ui/ShortcutHelp.vue:112-119` — `toggle()` 无任何调用点（模板不使用、`defineExpose` 只暴露 `openHelp`），且它不记录 `lastFocused`、与 `openHelp/close` 逻辑重复，属死代码。
26. `web/src/components/ui/RouteProgress.vue:17` — `let timer` 只被 `clearTimeout`，从未被赋值：死变量，`L23` 的清定时器是空操作。
27. `web/src/components/ui/RouteProgress.vue:21-36` — `beforeEach/afterEach/onError` 的返回值（注销函数）被丢弃，`onUnmounted` 只清定时器；组件卸载后守卫仍持有闭包写 `visible`，重复挂载会累加。
28. `web/src/components/ui/RouteProgress.vue:27-31` — 隐藏时机是 `afterEach + 350ms`，与真实加载耗时无关：快导航恒显示 350ms，慢导航期间也毫无进度推进。
29. `web/src/components/ui/EmojiPicker.vue:70-72` — emoji 按钮 30×30，低于 `CommentSection.vue:537-540` 注释里明确把触摸目标从 30 提到 36 的约定；且只有 `title` 无 `aria-label`。
30. `web/src/components/ui/SkeletonList.vue:2` — 容器 `aria-hidden` 但无 `role="status"`/`aria-busy`，读屏在加载期听不到任何提示。
31. `web/src/components/ui/XIcon.vue:13-40` — import 与 `ICONS` 映射手写两遍，`L49-51` 又把未命中静默回退 `Activity`：漏写不报错，只出现错图标，属掩盖型失败。
32. `web/src/components/home/NoteCard.vue:57` + `:60` — `liked` 只有内存态（`CommentItem` 有 localStorage），刷新即可重复点赞；`truncated` 用 `>= 200` 猜服务端截断长度，服务端改长度后「…… 展开」会误显示/漏显示。
33. `web/src/components/home/NoteImages.vue:75-77` — 560px 媒体查询把三列规则原样重写（同 `L42`），该断点零效果。
34. `web/src/components/home/NoteImages.vue:11` + `:30` — 网格图与灯箱 `alt` 都为空串，`ImageLightbox` 的 `aria-label` 退化为「查看大图」，与按钮的「查看第 N 张图片」不一致；手记图片无任何替代文本。
35. `web/src/composables/useMedia.js:17` — 只注册 `addEventListener('change')`，无 `addListener` 回退；`L13-20` 的 `bound` 在模块单次求值下恒真，是冗余防御；`useIsMobile()` 直接返回共享 ref，任何调用方都能写。
36. `web/src/directives/reveal.js:30-34` — `'stagger'` 只负责加类，交错延迟/步长全部依赖外部 CSS，指令层无法传参；`L8-21` 的单例观察器从不 `disconnect()`。

## 小结

1. 这一层是「纯展示 + 交互编排」，不含业务真相：评论排序/审核/点赞限流、AI 是否可用、搜索分页与总数全部由后端决定，组件只做乐观更新与文案映射。
2. 三条安全边界都落在这里而非路由层：评论的 `form_token`（路径绑定、一次性 nonce、2.1s 最小提交年龄）+ 随机蜜罐字段名（`X-Hp-Field` 声明）、AI 的 PoW 票据 + HMAC 请求签名（`signedFetch`）、后台读接口的签名化。
3. 可访问性投入集中在三个模态（SearchModal / ImageLightbox / ShortcutHelp）的 `aria-modal` + 焦点陷阱 + 关闭后焦点归还，但实现各写一份且质量不一（SearchModal/ImageLightbox 用 document 级监听，ShortcutHelp 绑在面板上失效），AskAi 面板完全没进入这套规范。
4. 状态持久化全靠浏览器存储：`localStorage`（排序、昵称、表情开关、草稿、搜索历史、已赞）、`sessionStorage`（邮箱），无服务端身份参与，「已赞」清存储即可绕过——是 UX 记忆而非防刷。
5. 反复出现的横向约定被复制而非抽象：clipboard 兜底、焦点陷阱、`FOCUSABLE` 选择器、滚动锁、最近搜索上限，至少 4 处重复实现——是这个分区最主要的可维护性债。
6. 边界清晰：本分区不直接 `fetch`，只经 `@/api`（axios 签名拦截器）与 `@/utils/signedFetch` 两条通道；不含路由定义、不含 store 定义，也不含反爬逻辑本身（仅在 `formToken` 侧消费签发结果）。
