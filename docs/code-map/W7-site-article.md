# W7-site-article — 博客站文章详情与列表

范围：`web/src/views/site/ArticleDetail.vue`（2496 行）、`web/src/views/site/ArticleList.vue`（1380 行）。两个文件均逐行读完（含 style 段），关键外部契约对照了 `web/src/api/index.js`、`web/src/utils/{markdown,highlight,pageMeta,readingPrefs,scrollLock,wordStats}.js`、`server/src/routes/articles.js`。

---

### web/src/views/site/ArticleDetail.vue（2496 行）

**职责**：按 URL 里的 slug 取一篇文章，前端解密后渲染 Markdown 正文，并同时承担阅读偏好调节、阅读进度/断点续读、TOC、收藏/点赞/分享/导出/打印、版权卡、上下篇与相关阅读、评论区挂载、`document.head` 的 SEO 注入。

**组件结构（template 1–376）**：单根 `.article-detail`，四个平级区块按 `article` / `loading` / `loadError` 三态互斥——`v-if="!article && loading"` 骨架（10–23，`aria-hidden="true"`，纯装饰）、`v-else-if="loadError"` 失败页（26–41，带 `?` 水印、错误码、回首页与重试）、`v-if="article"` 正文 `<article>`（43–287）。正文内部依次：头（分类徽章/置顶/6 个分享按钮 + 弹出菜单/标题/元信息/标签）→ 封面（`@error` 加 `cover-failed`）→ 阅读工具栏 + `.markdown-body` → 点赞区 → 版权卡 → 上下篇 nav → 相关阅读 → `CommentSection` 或「评论已关闭」→ 灯箱 → `Teleport to="#float-dock"` 浮层（296–304，跳评论/开目录）→ 移动端目录抽屉（307–330）→ 侧栏 TOC + 进度卡（333–361）→ 恢复位置提示条（366–371）→ `AskAi`（374）。

**状态与派生**：`article/loading/loadError/loadErrorCode/neighbors/related/toc/liked/activeHeading/progress/restoredPos/shareMenu/tocCollapsed/mobileTocOpen` 为 ref；偏好四项 `fontSize/lineHeight/readWidth/fontStyle/focusMode` 初值直接由 `readingPrefs` 的 `load*` 从 `localStorage` 读取（444–448），经 `step*` 夹取、`save*` 回写，越界与脏值在工具层被夹成合法值。派生：`charsPerLineValue`（`charsPerLine(readWidth, fontSize)`）、`bookmarked`（本地书签）、`wordCount`（560–565，汉字数 + 字母数字串数）、`pageUrl`（`site_url` + `/#/article/slug`）、`shareUrl`/`canonicalUrl`（均为 `site_url + /api/share/slug`）、`copyrightText`、`renderedContent`（717–721：`renderMarkdown` → `addHeadingIds` → `addImgAttrs`）。props 无——路由参数是唯一入口参数。

**实际逻辑**：
1. `load()`（723–809）用模块级 `loadSeq` 做请求序号守卫，`route.params.slug` 变化（watch 1209–1217）与首挂载（1219）都会进；拿到响应后依次 `setArticleCopyAllowed(a.allow_copy)` → `applyPageMeta()` → `toc = extractToc(a.content)` → 处理二级 hash 深链（742–756：`nextTick` + `requestAnimationFrame` 双跳，为了跨过 router `scrollBehavior` 的 `top:0` 复位）→ 从 `localStorage` 恢复 `liked`／`isBookmarked` → `addHistory(a)`（正文取到后才记足迹）→ 注册 `onBookmarksChange` 跨标签同步 → 并发取 `neighbors`/`related`（772–784，独立 try/catch，失败降级空）→ `nextTick` 后建 TOC 观察器 → `restoreScroll()` 恢复断点并弹提示 → 主动 `onScroll()` 同步一次进度。失败分支按 `e.response.status` 分流 404 与其它（795–805）。
2. 渲染管线：正文 `v-html="renderedContent"`，`renderMarkdown` 内部走 `DOMPurify.sanitize`；图片点击走事件委托 `onContentClick`（482–495），caption 三级兜底 `alt → aria-label → 文件名`，交给 `lightboxRef.open(src, caption, img)`。
3. 阅读偏好：字号/行距/版心步进（498–511）以行内 `font-size/line-height/max-width` 绑到 `.markdown-body`；`fontStyle` 切 `.serif`；`focusMode` 写 `<html data-focus>`（`watch immediate`，530–532），卸载清空（1237）。
4. 进度与断点：`computeReadingProgress`（999–1012）分母取「正文末尾滚到视口顶」的位置，而非整页；`rememberScroll`（1032–1056）按 slug 存 0–1 比例，500ms 节流但首帧直写（`lastScrollSave === 0` 跳过节流），3% 以下与 98% 以上不记；`restoreScroll`（1072–1087）用 `behavior:'auto'` 直接落位。三者共用一个 `contentEndScroll()`（1059–1063）。
5. TOC：`syncActiveHeading`（1160–1166）→ `computeActiveHeading`（1148–1158，逐项量 `getBoundingClientRect().top - 110`，遇第一个未越过激活线的就 break）；`revealActiveTocItem`（1125–1136）用 `block:'nearest'` 把高亮项滚进 `.toc-list` 这个小滚动区，折叠时跳过。点击条目 `scrollToHeading`（959–964）先 `focus({preventScroll:true})` 再滚，标题上的 `tabindex="-1"` 由 `addHeadingIds` 写入。
6. 交互杂项：`openShare`（592–616）优先 `navigator.share`（需 `isSecureContext`），`AbortError` 直接返回，否则开菜单并用 `setTimeout(…,0)` 延迟挂外部点击监听，`onUnmounted` 清 timer + 移除监听；`copyLink`（628–650）刻意丢掉 query 只留 `origin+pathname+hash`，带 `execCommand` 兜底；`printPage` 只为在模板里拿到 `window.print`；`exportMarkdown`（674–715）拼 YAML front matter、把正文 `^# ` 降级为 `## `、`downloadBlob` 下载；`doLike`（935–948）调接口后用返回值覆盖 `article.likes` 并写本地标记；`toggleBookmark` 写本地书签；`onKeydown`（967–984）绑定 ESC 关抽屉/菜单、←/→ 跳上/下篇，输入框与 `contentEditable` 内不触发。
7. 副作用面：`document.title` 与 `meta[name|property]`（`setMeta`/`setByName` 853–933）、`link[rel=canonical]`、`script#jsonld-blogposting`（908–922，卸载移除）、`<html data-focus>`、`body` 滚动锁（471–474 与 `scrollLock` 计数）、`localStorage` 三类键（`xalor_readpos_*`、`xalor_liked_*`、`xalor_toc_collapsed`）、阅读历史。

**项目内依赖**：`@/components/ui/XIcon.vue`、`ImageLightbox.vue`、`@/components/site/CommentSection.vue`、`AskAi.vue`、`@/api`（`articleApi`）、`@/utils/markdown`、`@/utils/format`、`@/utils/bookmark`、`@/utils/history`、`@/stores/site`、`@/utils/scrollLock`、`@/utils/copyGuard`、`@/utils/download`、`@/utils/readingPrefs`；`element-plus` 只取 `ElMessage`。

**后端接口约定**：
- `GET /api/articles/slug/:slug` → `{code:0, data:{…文章行, category_name/slug/color, tags[], comment_count, views(服务端已 +1), content(密文), content_enc:true, content_key:slug}}`。正文为传输层密文，密钥 = `HMAC(盐, 票据|slug)`，在 `api/index.js` 响应拦截器里用**请求发出时冻结的 `config._ticket`** 解密，失败则写 `content_decrypt_failed`（本文件 201–203 据此显示「正文解密失败」）。
- `GET /api/articles/neighbors/:id` → `{prev:{id,title,slug}|null, next:…}`；`GET /api/articles/related/:id` → 最多 4 条 `{id,title,slug,cover,views,published_at,category_name,category_color}`；`POST /api/articles/:id/like` → `{likes}`。
- 请求头由拦截器统一注入：`X-Fp`（指纹）、`X-Pass`（票据）、`X-Timestamp`、`X-Nonce`、`X-Sig = HMAC(ticket, METHOD|path|ts|sha256(body)|jti|nonce)`，有 JWT 时附 `Authorization: Bearer`。服务端对 `x-pass` 请求按 IP+fp+slug 做阅读频率闸门，超限 429；浏览量按 IP+fp+文章 5 分钟窗口去重。403 且文案命中「通行证/安全通道」时拦截器 `forceRefresh` 后重放一次。页面层不接触任何签名材料。

**UI/交互要点**：没有 `el-*` 组件，只把 `ElMessage` 当 toast 服务；图标统一 `XIcon` 按名字取。自研交互包括顶部 3px `scaleX` 进度条、6 项分享气泡（微博/Twitter/QQ空间/知乎/Telegram/复制）、折叠 TOC（偏好记忆）、右侧滑入目录抽屉（玻璃材质 + 安全区四向 padding）、固定「已回到上次读到的位置」提示条、点赞心跳动画。可访问性做了不少：`aria-pressed`（收藏/沉浸）、`aria-expanded`（Aa）、`aria-label` 覆盖纯图标按钮、`aria-hidden` 骨架、`focus()` + `tabindex="-1"` 保证 TOC 跳转后焦点落到标题、`prefers-reduced-motion` 交给 `main.css` 的 `scroll-behavior:auto !important`。响应式：`.detail-side` 在 ≥1100px 显示、浮层在 <1100px 显示（互补无缺口），≤720px 把 11 个阅读控件收进「Aa」，≤640px 上下篇与相关阅读降为单列。

**运行期副作用与失败模式**：跨路由的 `document.head` 写入若不清理会污染下一页（已用 `removeJsonLd` 兜底，但 meta 与 canonical 仍会残留到非文章页）；`localStorage` 在隐私模式抛错，全部读写都包了 try/catch；图片 `@error` 在模板里直接改 DOM 类名；`Teleport to="#float-dock"` 依赖 `index.html`/`home.html` 里的 `#float-dock` 节点存在（两入口都有，缺失则浮层静默不渲染并告警）；正文密文解密失败时页面仍「成功」，只是正文空白并显示提示，此时 `toc` 为空、进度恒 0。

---

### web/src/views/site/ArticleList.vue（1380 行）

**职责**：`/articles` 归档页——把分类/标签/关键词/排序/页码/每页条数全部当作 URL 状态，从后端分页取列表，渲染列表/卡片两种视图并提供筛选、搜索、分页、空态出口与页面 head 元信息。

**组件结构**：`.container.narrow` 内五段——页头（eyebrow/标题/总数/分类描述）、筛选栏（排序 3 键 + 视图切换、分类 chips、标签 chips、搜索行）、常驻 `sr-only role="status"` 播报点（142–144）、结果三态（`SkeletonList` / `loadFailed` 的 `role="alert"` 错误块 / `articles.length` 的列表或空态）、`total > pageSize` 时的分页 nav（上一页、数字页码 + 省略号、下一页、页码文案、每页条数 `<select>`）。`v-reveal="'stagger'"` 挂在列表容器上做一次性入场。

**状态与派生**：`articles/categories/tags/total/page/pageSize/keyword/loading/loadFailed/randomLoading` 为 ref，`viewMode` 从 `localStorage('xl_view_mode')` 取（默认 `grid`）。派生几乎全部来自 `route.query`：`activeCategory/activeTag/kw/sort`（344–347）、`hasFilter`（316，三项任一）、`filterKey`（624–626，**用 `\u0000` 拼成字符串**）、`totalPages`、`pageList`（445–455，首尾 + 当前±1 + 省略号）、`pageTitle/eyebrow/activeCategoryDesc`、`emptyTitle/emptyHint`（357–393，按生效筛选的**组合**生成文案）、`resultAnnouncement`（434–441，只报条数与页码区间，不念标题）。

**实际逻辑**：
1. 单一数据入口 `load(p=1)`（540–582）：`articleApi.list({page,pageSize,category,tag,keyword,sort})`，同样有 `loadSeq` 守卫；若 `p` 超过后端返回的真实末页则递归 `load(lastPage)`（564，注释说明递归自增序号使外层 `finally` 不再改 `loading`）；成功后写 `articles/total/page` 并 `router.replace` 把页码同步进 URL（`page=1` 时删键），翻页后平滑回顶。
2. `watch(filterKey, …)`（628–633）是筛选变化的唯一触发点：`page=1` → 同步 `keyword`（前进/后退时输入框跟随）→ `load(1)` → 回顶。之所以能这样做，是因为 `filterKey` 是字符串而非数组（612–623 记录了用数组 getter 导致「翻页被冲回第 1 页」的旧 bug）。
3. 各筛选器只改自己那一维：`selectCategory/selectTag` 保留对方的 query（476–501，注释说明服务端本就支持两者同时生效），`setSort` 只改 `sort` 并删 `page`（517–523），`applySearch` 写 `keyword` 并删 `category/tag/page`（503–509），`clearFilter` 删三项筛选但保留 `sort/pageSize`（396–403）。
4. `onMounted`（671–705）：`Promise.allSettled([categoryApi.list(), tagApi.list()])` 并行取分类与标签（单边失败降级空数组），再用 **URL 校正** `pageSize`（用 `suppressPageSizeChange` 绕过 `@change`，避免 v-model 赋值触发 `router.replace` 删掉 `page`）与 `page`，然后 `await load(page.value)`，最后把纠正后的页码再写回 URL。
5. `onPageSizeChange`（328–339）写 `localStorage`、把 `pageSize` 写进 query（8 时删键）、`router.replace` 并 `load(1)`；`watchEffect`（639–656）把 `pageTitle` 写进 `document.title`，并用 `URLSearchParams` 把 `keyword/tag/category/page/pageSize/sort` 拼进 `applyPageMeta` 的 `path`。
6. 其它：`highlight(text)`（607–609）统一走 `highlightKeyword`（先匹配原文、再逐段转义，命中段包 `<mark>`）；`randomArticle`（586–600）在空态跳一篇随机已发布文章；`loadFailed` 时「重试」按钮复调 `load(page)`。

**项目内依赖**：`@/components/ui/XIcon.vue`、`SkeletonList.vue`、`@/utils/pageMeta`（`applyPageMeta`）、`@/utils/highlight`（`highlightKeyword`）、`@/api`（`articleApi/categoryApi/tagApi`）、`@/utils/format`、`@/stores/site`、全局指令 `v-reveal`（`@/directives/reveal`）。

**后端接口约定**：`GET /api/articles?page&pageSize&category&tag&keyword&sort` → `{code:0, data:{list:[{id,title,slug,summary,cover,is_top,views,likes,published_at,category_name,category_slug,category_color,tags[],comment_count}], pagination:{page,pageSize,total}}}`。服务端把 `page` 夹在 `[1,10000]`、`pageSize` 夹在 `[1,50]`（默认 10）、`sort` 只接受 `latest|hot|commented`、`status` 强制 `published`（防 `?status=draft` 枚举草稿），`keyword` 只截 50 字符并 `escapeLike` 后匹配 `title/summary`；`tag` 通过 `article_tags` 预查 id 再 `whereIn`，无命中直接返回空页。`GET /api/categories` 与 `GET /api/tags` 返回数组（分类含 `article_count/description`）；`GET /api/articles/random` → `{slug,title}`。头与签名同上（`X-Fp/X-Pass/X-Timestamp/X-Nonce/X-Sig`）。

**UI/交互要点**：同样零 `el-*` 组件；自研 chips、分段排序按钮、视图切换、胶囊搜索框（焦点环画在父容器 `.search-box:focus-within`，输入框显式 `outline:none` 并注明是有意为之）、数字分页与 `<select>` 每页条数。可访问性投入较高：排序/视图/chips 全带 `aria-pressed`，分页当前页带 `aria-current="page"` 且 `disabled`，图标按钮有 `aria-label`，`sr-only` 播报点放在三条分支之外以覆盖「加载中」阶段，骨架 `aria-hidden`，错误块 `role="alert"`，搜索框除 placeholder 外另有 `aria-label`。响应式：≤640px 筛选行改纵向、隐藏右侧统计列、卡片网格退化为单列（`repeat(auto-fill, minmax(min(300px,100%),1fr))`）。

**运行期副作用与失败模式**：`load()` 会 `router.replace` 改 URL，与 `watch(filterKey)` 之间存在隐含契约（`filterKey` 必须排除 `page`，否则自激循环）；`onMounted` 串行等待分类/标签再取列表，接口慢时整页停在骨架屏；请求失败只置 `loadFailed`，`total/page` 保留旧值，分页条会与错误提示同时出现；分类/标签接口失败时 chips 为空但 URL 仍带 `category`，`pageTitle` 会退化成「分类归档」，空态文案里的分类名退化为「该分类」；`localStorage` 读写全部 try/catch。

---

## 观察

1. `web/src/views/site/ArticleDetail.vue:217` — `:name="liked ? 'Heart' : 'Heart'"` 两个分支同值，条件恒等，是无意义残留（真正变化的是 `:fill` 与 `:stroke-width`），读代码时会误以为有两套图标。
2. `ArticleDetail.vue:534` — `scrollTop()` 定义后全文件只有这一处，模板与脚本都未调用（回顶实际由 `backToTop` 与全局进度环负责），属死代码。
3. `ArticleDetail.vue:278` 与 `:296` — 同一开关两种判定：评论区用 `v-if="article.allow_comment"`（真值），浮层按钮用 `!== false`。`allow_comment` 为 `null/0` 时评论区隐藏但「跳到评论区」按钮照旧渲染，点了 `scrollToComments` 找不到节点直接 `return`，用户得到零反馈。
4. `ArticleDetail.vue:115` — 元信息里的「{{ comment_count }} 评论」是带 `@click` 的 `<span>`，没有 `role`/`tabindex`/`@keydown`，键盘与读屏用户无法触发这个跳转；同一功能在 296 行有真按钮，说明能力存在只是这里没做成按钮。
5. `ArticleDetail.vue:789-792` — `setTimeout(() => restoredPos.value = false, 6000)` 没有登记句柄：切到另一篇（watch slug）或卸载后定时器仍会写 ref，上一篇文章的计时器可能把新文章的「已回到上次位置」提示提前关掉。
6. `ArticleDetail.vue:574-589` — `shareUrl` 与 `canonicalUrl` 是两份逐字相同的 computed（都返回 `/api/share/:slug`），命名不同掩盖了「分享页 = 收录页」这个唯一事实，改一处漏一处只是时间问题。
7. `ArticleDetail.vue:82` 与 `:640` — 分享菜单把 `/api/share/:slug` 递给微博/Telegram，而「复制链接」给的是 `origin+pathname+#/article/:slug`；同一组按钮产出两个不同地址，复制给别人的人和用菜单分享的人会打开不同的页面。
8. `ArticleDetail.vue:863-873` — 868 行刚把 `ogImage` 绝对化写入 `twitter:image`，873 行 `if (cover) setByName('twitter:image', cover)` 又用**可能相对的** `cover` 覆盖回去；Twitter 忽略相对 URL，前面的绝对化在这里被撤销，只剩 `og:image` 是对的。
9. `ArticleDetail.vue:844` — 默认分享图写死 `/og-image.webp`，而 `utils/pageMeta.js` 与 `server/src/routes/share.js` 统一用 `/og-image.png`。同一份「默认配图」在两个模块各写一遍，已经出现分叉。
10. `ArticleDetail.vue:824-884` — 自建 `setMeta/setByName/applyJsonLd/canonical` 与 `@/utils/pageMeta` 的 `applyPageMeta` 职责完全重叠（列表页用的正是后者），且自建版缺 `og:site_name`；同一项目两套 head 写入实现，是 meta 反复回归的温床。
11. `ArticleDetail.vue:999-1012` 与 `:1059-1063` — 「正文末尾 − 视口高」这一个公式被独立实现两遍（进度与断点各一份）。当前数值一致，但任何一处调整（例如给正文加 `padding-bottom`）都会让进度与断点口径分叉。
12. `ArticleDetail.vue:1168-1207` — `IntersectionObserver` 回调里把 `computeActiveHeading`（1148-1158）的逻辑整段重写了一遍；而 `onScroll` 每帧已经在算同一个值，观察器本身是冗余的，只会额外增加一次全标题 `getBoundingClientRect` 遍历。
13. `ArticleDetail.vue:710` — 导出用的 `/^# (?!#)/gm` 不识别代码围栏，正文里 shell/Python 的 `# 注释` 会被改成 `## `，导出的 Markdown 代码块内容被改坏；`renderMarkdown` 那条路有 `demoteH1` 的 HTML 级处理，导出这条路没有。
14. `ArticleDetail.vue:967-984` — 全局 ←/→ 直接 `router.push`，既不判 `e.metaKey/ctrlKey/altKey`（macOS `Cmd+←` 是后退，会同时触发跳上一篇），也不排除正文里可横向滚动的代码块与抽屉内元素，等于把方向键从页面手里抢走。
15. `ArticleDetail.vue:560-565` — 字数用自写正则统计，而 109 行的阅读时长走 `utils/wordStats` 的 `readingMinutes`，同一条元信息里两个数字不同源；项目已有 `countWords`，这里等于第二套口径。
16. `ArticleDetail.vue:717-721` 与 `:735` — 同一份 `content` 被 `renderMarkdown`、`extractToc` 各解析一遍，`readingTime`、`wordCount` 又各扫一遍；长文首屏有 4 次全量文本遍历，且都没有在 `content` 未变时复用。
17. `ArticleDetail.vue:788` — `restoreScroll()` 紧跟 `nextTick` 执行，此时封面与正文图片尚未 `load`，文档高度未定型，比例落点会偏；没有任何图片加载完成后的重算或二次校正（断点续读在图片多的文章上不准）。
18. `ArticleDetail.vue:307-330` — 移动端目录抽屉既无 `role="dialog"`/`aria-modal`，也没有把焦点移入或做焦点陷阱，打开后 Tab 仍走背后页面；`@click` 遮罩关闭可用键盘 ESC（971），但焦点始终在外面，读屏不会被告知「出现了一个目录」。
19. `ArticleDetail.vue:134` — 模板里直接 `$event.target.closest('.detail-cover').classList.add(...)` 改 DOM，视图层承担了本属于组件的状态；一旦包裹结构变化 `closest` 返回 `null`，这里会在事件处理器里抛 `TypeError`。
20. `web/src/views/site/ArticleList.vue:317-319` — 同一段「每页条数：URL 参数优先」注释连续写了两遍（逐字重复），是迭代中没删的残留。
21. `ArticleList.vue:333-334` 与 `:570-571` — 两处都写 `{ ...route.query, page: undefined }` 然后再 `delete q.page`；`undefined` 键本就等于不存在，前一行是死写法，还多一次对象展开。
22. `ArticleList.vue:507` — `applySearch` 删除 `category` 与 `tag`，与 476-488 行「分类/标签能力不该被前端点击挡掉」的论断自相矛盾：关键词这一维依然是破坏性的，而 `emptyTitle`（370-386）却按「分类 + 标签 + 关键词」三维叠加生成文案，代码承认的组合在点击路径上根本到不了。
23. `ArticleList.vue:489-501` — 点击当前已选中的 chip 也会 `router.push` 同一 query，产生冗余导航（Vue Router 会拒绝并告警），用户看到的是「点了没反应」。
24. `ArticleList.vue:255` — 分页 nav 在 `loading`/`loadFailed` 分支之外，只判 `total > pageSize`；加载失败时沿用旧 `total`，错误提示与分页条同时出现，点页码又会发新请求，状态自相矛盾。
25. `ArticleList.vue:671-676` — 首屏 `await Promise.allSettled([...])` 之后才 `load()`；`allSettled` 只挡 reject 不挡慢，分类或标签接口慢时正文列表被一起拖住，整页停在骨架屏——673 行注释宣称的「不能拖死」只兑现了一半。
26. `ArticleList.vue:147` — 骨架固定 `:count="3"`，而 `pageSize` 可为 8/16/32；32 条时加载完成会有一次明显的高度跳变。
27. `ArticleList.vue:202-207` — 卡片封面是 `background-image` 的 `<div>` 且只挂了 `aria-label`，没有 `role="img"`，多数读屏不会把它当替代文本；同时没有 `loading="lazy"`，一屏 8–32 张封面全部立刻请求。
28. `ArticleList.vue:170` — 序号 `padStart(2,'0')` 在超过 99 条时错位（第 100 篇显示 `100`，第 1 篇显示 `01`），且这是全站连续序号而非条目 id，翻页时读者容易误读为「第 1 页第一条」。
29. `ArticleList.vue:180`/`:215` — 标题与摘要用 `v-html` 注入 `highlight()` 结果，当前安全完全依赖 `highlightKeyword`「先匹配、再逐段转义」的实现顺序；把安全边界放在一个字符串工具里，任何一次「先转义后匹配」的重构都会直接变成 XSS。
30. `ArticleList.vue:646-648` — canonical 把 `sort`、`pageSize`、`page` 一并拼进 `path`，于是 `?sort=hot` 与 `?sort=latest`、`?pageSize=16` 与 `8` 各自拥有一个规范地址；643 行注释的目标是消除重复内容，这里反而制造了同一批文章的多个 canonical。
31. `ArticleList.vue:688-696` — 用裸 `let suppressPageSizeChange` 抑制 `@change`，正确性依赖「`select` 的 change 在赋值后同步触发」这一浏览器时序；目前成立，但没有注释之外的保证，换成异步组件或 `v-model.lazy` 就会静默回到第 1 页。
32. `ArticleList.vue:240-249` — 空态的两个动作按钮都挂 `v-if="hasFilter"`；全站零文章且无筛选时，`.empty-actions` 渲染成空容器，空态没有任何出口（连「随便看看」都没有）。
33. `ArticleList.vue:68-108` — 分类与标签 chip 组没有 `role="group"`/`aria-labelledby`，`filter-label` 只是视觉文字；同一页 44 行的视图切换却写了 `role="group" aria-label`，规范只落在一处。
34. `ArticleList.vue:142` 与 `:154` — `role="status" aria-live="polite"` 会播报「加载失败」，`role="alert"` 的错误块再播一次；同一次失败被打断两次。
35. `ArticleList.vue:585-600` — `randomArticle` 的 `catch` 为空，后端 `404 暂无文章` 时按钮只把文案从「随便看看」闪回原文，用户不知道发生了什么（拦截器只为 `code!==0` 的 200 响应弹提示，404 走 reject 分支不弹）。

## 小结

1. 这两页是「站点入口」的读写边界：所有数据都经 `@/api` 的同一 axios 实例，统一携带 `X-Pass/X-Fp/X-Timestamp/X-Nonce/X-Sig`，正文在响应拦截器里解密。页面只消费 `{code,data}` 契约，不接触票据、密钥或签名，因此反爬强度完全由 `api/index.js` 与 `server/src/routes/articles.js` 决定，本区不是防线。
2. `ArticleDetail.vue` 的职责远超「渲染详情」：它还写 `document.head`（title/meta/canonical/JSON-LD）、改 `<html data-focus>`、操作 `localStorage` 三类键与 `body` 滚动锁。它因此是全站副作用最集中的视图，也是 meta/SEO 反复回归的根因——`utils/pageMeta.js` 已有统一实现，只有列表页在用。
3. `ArticleList.vue` 的设计核心是「URL 即状态」：筛选/排序/分页/每页条数全在 `route.query`，computed 派生、`watch(filterKey)` 单点触发 `load`。其正确性依赖两个隐性契约——`filterKey` 必须是字符串（不能是数组 getter），`load` 里的 `router.replace` 必须写 `page` 而不触发该 watcher。
4. 两页共享同一套并发模型：模块级 `loadSeq` 递增 + 过期响应丢弃，`finally` 里只在「仍是最新」时落 `loading`；详情页还额外把次要数据（`neighbors`/`related`）包在独立 try/catch 里降级，主次分离是这一区的正确做法。
5. 分页协议与后端强耦合：`pageSize` 只允许 8/16/32，落在服务端 `[1,50]` 的夹取范围内；越界页码由前端递归纠正到末页（服务端只夹 `[1,10000]` 不按 `total` 纠正），这条修正是必要的，但也意味着「末页」的真相只在前端。
6. 边界之外的部分都不在本区：评论（`CommentSection`）、AI 问答（`AskAi`）、图片灯箱（`ImageLightbox`）、本地书签/历史/复制限制/阅读偏好（`utils/*`）均只被调用与传参；浮层通过 `#float-dock` 这个 DOM 节点与 `Layout` 协作，双入口（`index.html`/`home.html`）各自提供该节点，因此本区没有入口差异判断。
