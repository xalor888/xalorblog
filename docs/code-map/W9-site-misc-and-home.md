# W9-site-misc-and-home

分区范围：博客站次要页（关于 / 归档 / 收藏 / 足迹 / 404 / 标签）+ 个人主页全部视图（首页 / 布局 / 手记列表 / 手记详情 / 404）。全部 11 个文件逐行读完，行数以实际文件为准。

### web/src/views/site/About.vue（211 行）

- 职责：站点「关于我」页，展示个人卡片（头像/站名/简介/四项站点统计/社交 chip）+ 由设置项 `about_content` 渲染的 Markdown 正文。
- 结构：`<script setup>` 单一组件，无 props/emit。状态全部来自 `useSiteStore()`：`settings`（`site_name`/`site_desc`/`avatar`/`about_content`/`social_github`/`social_weibo`/`social_email`）与 `stats`；本地只有两个 computed（`socials`、`aboutHtml`）。
- 实际逻辑：`socials` 用正则 `/^https?:\/\/github\.com\/?$/i` 排除「只填了 github 根地址」的占位值，其余项无条件入列表；`aboutHtml = addImgAttrs(renderMarkdown(about_content || 默认文案))`，`renderMarkdown` 内部先 `demoteH1`/补表格 scope 再 `DOMPurify.sanitize`，所以 `v-html` 是净化后的产物；`watchEffect` 同时写 `document.title` 与 `applyPageMeta({path:'/about', site})`，因为读了 `site.settings.site_name`，设置异步到达后会再跑一次。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/stores/site`、`@/utils/markdown`（`renderMarkdown`/`addImgAttrs`）、`@/utils/format`（`formatNumber`）、`@/utils/pageMeta`。
- 后端约定：本页不发自己的请求，数据由 `site.init()` → `settingsApi.get()`（`GET /api/settings`）与 `statsApi.summary()`（`GET /api/stats/summary`）取回，两者都走带票据的 axios 实例（`X-Pass`/`X-Fp`/`X-Sig`/`X-Timestamp`/`X-Nonce`，`api/index.js:54-91`），且都不在 `GATE_SKIP` 白名单内 → 首访要等 PoW。返回体：设置项平铺对象；统计为 `{article_count, comment_count, total_pv, total_uv, today_pv, today_uv}`。
- UI/交互：未用任何 Element Plus 组件；`v-reveal` 滚动揭示、`fade-up` 入场、`social-chip` 圆角描边、`profile-stats` 虚线分隔；外链统一 `target="_blank" rel="noopener noreferrer"`。
- 副作用/失败模式：`site.init()` 在 setup 顶层裸调（75 行），内部靠 `loaded` 幂等；设置/统计失败被 store 吞掉（`stores/site.js:15-17`、`31-33`），页面会把统计渲染成 `0`，正文回落到默认「关于我」文案——看起来像真实内容而非失败态。

### web/src/views/site/Archive.vue（354 行）

- 职责：按「年 → 月 → 日」时间线浏览全部已发布文章。
- 结构：`groups`（后端原始分组）→ `yearGroups`（按 `month` 前 4 位归并并汇总 `count`）；`totalArticles` 求和 `items.length`；`scrollToYear` 用 `querySelector('[data-year="…"]')` + `scrollIntoView`。
- 实际逻辑：`onMounted` 调 `articleApi.archive()`，失败进空 catch（提示由拦截器统一弹）；`yearGroups.length > 3` 才渲染年份快捷导航；每个月一条 `tl-bar-fill`，宽度 = `Math.max(8, round(count/max*100))`，`max` 每次调用都重新对整个 `groups` 求 `Math.max`。模板把年份写成 `h2`、月份写成 `h3`，条形图整块 `aria-hidden="true"`，属于有意做的标题层级与去重朗读。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/api`（`articleApi`）、`@/stores/site`、`@/utils/pageMeta`。
- 后端约定：`GET /api/articles/archive`（带票据+签名，`articleApi.archive`），返回 `ok(res, list)`，`list = [{month:'YYYY-MM', count, items:[{id,title,slug,views,day:'DD'}]}]`，仅 `status='published'`，`published_at` 为空时用 `created_at` 兜底、两者皆空则跳过（`server/src/routes/articles.js:386-414`）。页面不做分页、不做二次排序，完全信后端顺序。
- UI/交互：无 Element Plus；`timeline::before` 竖线 + 年/月节点圆点；条目 hover 变色、`tl-views` 默认 `opacity: 0` hover 才显形；`tl-title` 单行省略。
- 副作用/失败模式：请求失败 → 空白时间线且「共 0 篇文章」，没有任何失败文案或重试；`scrollToYear` 未考虑固定导航高度，年份标题会滚到导航条下面。

### web/src/views/site/Bookmarks.vue（143 行）

- 职责：本地收藏列表（localStorage 快照），带「失效条目」只标记不删除的存活校验。
- 结构：`bookmarks = ref(getBookmarks())`、`staleSlugs = ref(new Set())`、`checking`；`toArticle(b)` 把快照补成 `ArticleCard` 需要的形状（`views`/`comment_count`/`likes`/`is_top`/`tags` 兜底）。
- 实际逻辑：`pruneStale()` 串行遍历收藏，先查 `getCachedStatus(slug)`（24h TTL），未命中才 `await articleApi.detail(slug)`，仅 `e.response.status === 404` 记 `setCachedStatus(slug,'gone')` 并塞进 `gone`；网络错误不缓存。收尾 `staleSlugs.value = gone`（不动列表本身）。`remove(id)` 用 `removeBookmark(id)` 的返回值覆盖本地列表；`clearAll()` 走 `ElMessageBox.confirm` 二次确认后 `clearBookmarks()`。`onBookmarksChange` 监听 `storage` 事件做跨标签页同步，`onUnmounted` 解绑。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/components/site/ArticleCard.vue`、`@/utils/bookmark`（`getBookmarks`/`removeBookmark`/`clearBookmarks`/`onBookmarksChange`）、`@/stores/site`、`@/utils/pageMeta`、`@/api`（`articleApi`）、`@/utils/slugCheck`（`getCachedStatus`/`setCachedStatus`）。
- 后端约定：只用 `GET /api/articles/slug/:slug`（`articleApi.detail`）当存活探针；该接口需要票据+签名，返回整篇（含 AES-GCM 解密后的 `content`，解密失败置 `content_decrypt_failed`），并且**会给文章 `views` +1**（同 IP+指纹 5 分钟窗口内只计一次，`server/src/routes/articles.js:210-218`）。
- UI/交互：`ElMessage.success` 轻提示、`ElMessageBox.confirm` 确认框（warning 型）；失效条目替代 `ArticleCard` 渲染 `bm-stale-note`（`role="note"` + `EyeOff` 图标）；清空按钮带 `aria-label`（含条数），单条删除按钮用 `title` 而非 `aria-label`；样式复用 `@/styles/list-page.css`。
- 副作用/失败模式：进页即发最多 100 个串行详情请求（收藏上限 100），既刷浏览量又拖慢首屏；组件卸载后循环不中断；`staleSlugs` 在删除/清空后不重置。

### web/src/views/site/History.vue（135 行）

- 职责：本机阅读足迹（localStorage，同一 slug 只留一条、上限 20），与收藏页同构，同样做「只标记不删除」的存活校验。
- 结构：`history = ref(getHistory())`、`staleSlugs`、`checking`、`toArticle()` 兜底字段；`remove(slug)`/`clearAll()`；`onHistoryChange` 同步。
- 实际逻辑：与 `Bookmarks.vue` 几乎逐行同构（缓存短路 → `articleApi.detail` → 仅 404 记 gone）；差别只在主键（足迹用 `slug`）、文案与空态图标（`History`）。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/components/site/ArticleCard.vue`、`@/utils/history`、`@/api`（`articleApi`）、`@/utils/slugCheck`、`@/stores/site`、`@/utils/pageMeta`。
- 后端约定：同 `Bookmarks.vue`（`GET /api/articles/slug/:slug` 作探针，副作用同样是 `views` +1）；足迹本身**不上传**，无写接口。
- UI/交互：`ElMessageBox.confirm`（确认按钮文案「确定清空」）、`ElMessage.success`；`v-reveal="'stagger'"` 交错入场；空态给 `/articles` 出口；样式同样 `@import '@/styles/list-page.css'`。
- 副作用/失败模式：同 `Bookmarks`（串行探针、卸载不取消、`staleSlugs` 不复位、失败无重试入口）；`clearAll` 取消时走 catch 直接 return，逻辑本身正确。

### web/src/views/site/NotFound.vue（222 行）

- 职责：博客站 404 兜底页，提供四个出口（首页 / 文章列表 / 随机一篇 / 站内搜索）。
- 结构：`loadingRandom`、`searchKeyword`；`doSearch()` 把关键词塞进 `/articles?keyword=`（空词退化成 `/articles`）；`randomArticle()` 调 `articleApi.random()` 后 `router.push('/article/'+slug)`。
- 实际逻辑：`onMounted` 手动 `document.createElement('meta')` 注入 `robots=noindex,nofollow` 并打 `id="nf-robots-noindex"`，`onUnmounted` 精确移除；注释明确说明**故意不做倒计时跳转**（跳走会让四个出口失效）。`watchEffect` 只写 `document.title`。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/api`（`articleApi`）、`@/stores/site`、`vue-router`（`useRouter`）。
- 后端约定：`GET /api/articles/random`（带票据+签名），成功返回单篇文章对象（至少 `slug`）；失败/429 由拦截器提示。
- UI/交互：`role="search"` 表单 + `aria-label="站内搜索"` + `maxlength=50`；`nf-float` 问号装饰动画；随机按钮 `:disabled` 与文案切换（`找一篇…`）；`nf-code` 渐变大字；`prefers-reduced-motion` 未处理该装饰动画。
- 副作用/失败模式：`randomArticle` 在「响应成功但没有 slug」时静默无动作且不提示；本页不调 `applyPageMeta`，进入 404 时 head 里会留着上一页的 `og:url`/`canonical`，与全站「meta 统一出口」的约定不一致。

### web/src/views/site/Tags.vue（165 行）

- 职责：标签云，按文章数分四档字重。
- 结构：`tags = ref([])`；`weightClass(count)` 用 `count / max` 的比值归档到 `xl/lg/md/sm`；零文章标签走 `v-if="!tag.article_count"` 分支渲染成 `span`（`is-empty` + `aria-label="…，暂无文章"`），其余渲染 `router-link` 到 `/articles?tag=slug`。
- 实际逻辑：`onMounted` 里 `tags.value = await tagApi.list()`，失败空 catch。`weightClass` 每次调用都重新 `Math.max(...tags.value.map(...))`。
- 项目内依赖：`@/api`（`tagApi`）、`@/stores/site`、`@/utils/pageMeta`（无 XIcon）。
- 后端约定：`GET /api/tags`（带票据+签名），返回数组，元素至少含 `{id, name, slug, article_count}`（`article_count` 为 0 表示无已发布文章）。
- UI/交互：纯 CSS 云（`flex-wrap` + 四档 `font-size/font-weight`），hover `translateY(-3px) scale(1.04)` 并反白；空标签 `opacity: .5`、`cursor: default` 且显式覆写 hover 反馈；`v-reveal` 整块入场。
- 副作用/失败模式：请求失败 → 空云 + 「共 0 个标签」，无失败态；`weight-1` 类名在样式表中不存在（见观察）。

### web/src/views/home/Home.vue（529 行）

- 职责：个人主页首页（名片 + 最近手记 + 最近文章 + 友链/关于双卡）。
- 结构：`useHomeStore()` 的 `summary` 派生 `siteName`/`siteDesc`/`avatar`/`hero`/`social`/`stats`/`runningDays`/`aboutExcerpt`/`links`/`recentPosts`；本地状态 `notes`/`notesLoading`/`notesFailed`；`STATUS` 常量把 `hero.status` 映射成 `is-online|busy|away|offline` + 中文文案，未知值回落 `online`。
- 实际逻辑：`loadNotes()` 调 `noteApi.list({page:1,pageSize:6})`（走闸门，票据未就绪会短暂等待，于是手记区后于名片出现）；`onLike(note)` 以「抛异常即失败」契约交给 `NoteCard`，成功就回写 `note.likes`；`retry()` 同时 `home.load(true)` 与 `loadNotes()`；模板用 `home.failed` 区分「加载失败」与「后台没填」：失败时隐藏 `hero-meta` 显示重试按钮，`aboutText` 改成「内容加载失败，请点击上方重试。」。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/components/home/NoteCard.vue`、`@/stores/home`、`@/api`（`noteApi`）、`@/utils/siteLinks`（`blogUrl`）、`@/utils/format`（`timeAgo`）、`@/utils/pageMeta`。
- 后端约定：① `GET /api/home/summary` —— **免票**裸 `fetch`（`api/homePublic.js`，8s 超时、`credentials:'same-origin'`、不带 `X-Pass`/`X-Sig`），返回 `{site_name, site_desc, avatar, announcement, icp, home_site_url, hero:{greeting,role,quote,status}, since_date, running_days, about_excerpt, social:{github,weibo,email,extra}, links[], stats:{article_count,note_count}, recent_posts[]}`（`server/src/routes/home.js:80-113`，服务端另有 60 次/分钟独立限流 + antiBot）。② `GET /api/notes?page&pageSize`（票据+X-Sig，正文 AES-GCM 由响应拦截器解密）。③ `POST /api/notes/:id/like` → `{likes}`（服务端 IP+指纹防刷）。
- UI/交互：无 Element Plus 组件；`sg-liquid` 玻璃名片、骨架屏 `shimmer`、`prefers-reduced-motion` 关掉骨架动画；触摸目标对 `.block-more` 用 `min-height:40px` + 负 margin 撑到 40px；`overflow-wrap:anywhere` 防长串撑宽；`duo` 在无友链时切单列；封面 `loading="lazy"` + `alt=""`。
- 副作用/失败模式：`watchEffect` 里写 `document.title`/meta（设置到达后再触发一次）；`onMounted` 各拉一次 summary 与手记；手记区失败只降级成一句文案（无重试按钮），名片区失败才有重试；`hero.status` 缺失会被伪装成「在线」。

### web/src/views/home/Layout.vue（507 行）

- 职责：个人主页外壳：skip-link、吸顶导航（本地路由 + 跨站链接 + 主题/RSS/汉堡）、`router-view` 页过渡、页脚品牌/链接/统计/备案、`#float-dock` 浮层（主题 + 回到顶部）。
- 结构：`localItems`（const：`/` 首页 exact、`/notes` 手记）、`crossItems`（computed，指向 `blogUrl('articles'|'links'|'about')`）；`avatar`/`siteName`/`siteDesc`/`socialGithub`（正则只放行 `https://github.com/xxx`）/`socialEmail`/`stats`/`runningDays`/`icp`/`footerText`。
- 实际逻辑：`isActive(item)` 自己判活跃（`exact` 比 `route.path === '/'`，否则 `startsWith`），注释说明不能用 `router-link-active`（`/notes` 下两个都会亮）；`onScroll` 用 `requestAnimationFrame` + `ticking` 节流写 `scrolled`（>16px）与 `showTop`（>480px）；`skipToMain` 只聚焦 `#home-main` 不改 hash（hash 路由下锚点会被当导航）；`onMounted` 调 `home.load()`、`onUnmounted` 解绑 scroll。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/stores/theme`、`@/stores/home`、`@/utils/siteLinks`（`blogUrl`）；`#float-dock` 容器来自 `web/home.html:55`。
- 后端约定：自身不发请求，summary 由 `useHomeStore().load()` → 免票 `GET /api/home/summary`；页脚备案号 `icp` 外链 `beian.miit.gov.cn`；RSS 直连 `/api/rss.xml`。
- UI/交互：`Teleport to="#float-dock"` 并入全局浮层栈；`transition name="drawer"` / `"page"`（`mode="out-in"`、240/200ms）；`<main id="home-main" tabindex="-1">`；`aria-expanded` 在汉堡按钮上；`prefers-reduced-motion` 关掉三组过渡。
- 副作用/失败模式：`home.load()` 与三个页面各自再调一次（store 幂等，但四处重复）；summary 失败时页脚统计整块隐藏、站名回落 `Xalor`；抽屉无 Escape/遮罩/焦点管理，键盘用户打开后焦点留在汉堡上。

### web/src/views/home/NoteDetail.vue（343 行）

- 职责：单条手记详情（作者头、正文、图片区、点赞/复制链接）。
- 结构：`note`/`loading`/`notFound`/`failedHint`/`liked`/`liking`/`copied`/`lightboxRef`；`avatar`/`authorName` 取自 summary；`images` 过滤假值；`rendered = addImgAttrs(renderMarkdown(note.content))`。
- 实际逻辑：`load(id)` 先清 `note`/`notFound`，catch 里按 status 分流（404 → `notFound`；429 → 「阅读过于频繁，请稍等一会儿再试。」；其它 → 通用文案）；模板用 `loading` → `notFound` → `!note`（失败分支，避免 `note.published_at` 抛渲染异常）→ `article` 四级 `v-if` 链；`onLike` 前置 `liking/liked` 双闸并回写 `data.likes`；`onBodyClick` 用 `e.target.closest('img')` 交给 `ImageLightbox.open(src, alt)`；`copyLink` 写 `window.location.href` 并 1.8s 后复位 `copied`；`watch(() => route.params.id)` 处理同组件内切换。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/components/ui/ImageLightbox.vue`、`@/components/home/NoteImages.vue`、`@/api`（`noteApi`）、`@/stores/home`、`@/utils/markdown`、`@/utils/format`（`formatDateTime`）、`@/utils/pageMeta`。
- 后端约定：`GET /api/notes/:id`（票据 + `X-Sig`；`content_enc` 时由拦截器用**请求时那张票据**解密，密钥取 `content_key || slug`，失败置 `content_decrypt_failed` 并清空正文）；`POST /api/notes/:id/like` → `{likes}`。
- UI/交互：`sg-liquid` 卡片、骨架屏、`na-tag` 展示 `location`/`mood`、`na-pin` 置顶标记；解密失败单独出 `decrypt-warn` 而不是空白正文；点赞按钮 `:disabled="liking"` + `.liked` 配色；`aria-label` 缺省（按钮靠文字）。
- 副作用/失败模式：`watchEffect` 在 `note === null` 时提前 return → head 里留上一条手记的 `og:*`；`document.title` 在 161/164 行重复赋同一值；失败后 `failedHint` 不复位；剪贴板只有 `navigator.clipboard` 一条路径且失败静默。

### web/src/views/home/Notes.vue（190 行）

- 职责：手记时间线列表，带「加载更多」分页。
- 结构：`list`/`page`/`pageSize=10`/`hasMore`/`loading`/`failed`；`avatar`/`authorName` 来自 summary。
- 实际逻辑：`fetchPage(p)` 请求后 `p === 1 ? rows : [...list, ...rows]`，`page` 只在成功后推进（注释明确「失败时若已推进会跳过一整页」），`hasMore = data?.pagination?.has_more ?? rows.length === pageSize`；首屏失败清空列表并置 `failed`，追加页失败只置 `failed=false` 保留已有内容；`loadMore()` 有 `loading || !hasMore` 双闸；`onLike` 与首页同一契约。
- 项目内依赖：`@/components/ui/XIcon.vue`、`@/components/home/NoteCard.vue`、`@/api`（`noteApi`）、`@/stores/home`、`@/utils/pageMeta`。
- 后端约定：`GET /api/notes?page=1&pageSize=10`（票据+X-Sig），返回 `{list, pagination:{page, pageSize, total, has_more}}`（`server/src/routes/notes.js:69-73`）；列表项含 `excerpt`/`cover`/`image_count`/`mood`/`location`/`likes`/`is_pinned` 等卡片字段，不含正文。
- UI/交互：骨架屏（`loading && !list.length` 才显示，保证追加时不闪）、`more-btn` 加载时 `spin` 图标 + 「加载中…」、末尾「没有更多了」；`prefers-reduced-motion` 关掉 `shimmer`/`spin`；`<h1>手记</h1>` + `page-badge`。
- 副作用/失败模式：首屏失败只显示「加载失败，请刷新页面重试」文字（没有重试按钮）；`document.title` 由 `watchEffect` 写死 `手记 · 站名`，与路由守卫的 `meta.title` 双写。

### web/src/views/home/NotFound.vue（66 行）

- 职责：个人主页 404 兜底（纯展示 + 两个出口）。
- 结构：模板 + 作用域样式，**没有 `<script>` 块**：无 props、无状态、无 API、无副作用。
- 实际逻辑：仅 `<router-link to="/">` 与 `<router-link to="/notes">` 两个出口；样式复用 `.home-container`/`sg-liquid` 与主题变量。
- 项目内依赖：无（连 `XIcon` 都没用），依赖 `router/routes-site-home.js:16-21` 把 `/:pathMatch(.*)*` 挂到 `home-not-found`。
- 后端约定：无。
- UI/交互：`nf-card` 居中卡片、`nf-btn.primary` 主按钮；无 `aria-*` 需求项，也无标题层级以外的语义。
- 副作用/失败模式：不设 `document.title`（只能拿到守卫给的静态 `siteName`）、不写 canonical/`og:*`、不注入 `noindex`——主页 404 可被搜索引擎收录。

## 观察

1. `web/src/views/site/Bookmarks.vue:77` —— 注释写「足迹上限 20」，收藏实际上限是 100（`web/src/utils/bookmark.js:7` `MAX = 100`），从 `History.vue` 复制过来没改，读注释会误判限流压力的量级。
2. `web/src/views/site/Bookmarks.vue:82`、`web/src/views/site/History.vue:107` —— 用 `articleApi.detail` 当存活探针：该接口(1) 会 `views +1`（`server/src/routes/articles.js:210-218`），(2) 返回解密后的整篇正文；于是一次进收藏/足迹页最多发出 100/20 个串行重请求，并把被收藏文章的阅读量刷高。
3. `web/src/views/site/Bookmarks.vue:78-79`、`web/src/views/site/History.vue:103-104` —— 缓存命中 `gone` 就直接跳过探测；而同一段注释（`Bookmarks.vue:93-96`）说「文章恢复后读者自己决定去留」，实际上文章恢复后 24 小时内仍显示「不可访问」，策略与注释矛盾。
4. `web/src/views/site/Bookmarks.vue:101-105`、`web/src/views/site/History.vue:126-129` —— `pruneStale` 的串行循环没有取消机制，组件卸载后仍会继续发完剩余请求（用户切页/后退后仍在后台打接口）。
5. `web/src/views/site/Bookmarks.vue:119-138` —— 单条删除与「清空全部」都只改列表，不清 `staleSlugs`；同一 slug 被重新收藏后，在下次挂载前会立刻显示成「不可访问」。
6. `web/src/views/site/History.vue:60-124` 与 `web/src/views/site/Bookmarks.vue:71-138` —— `pruneStale`/`toArticle`/清空交互近乎逐行重复（约 60 行），两份实现各自演化会重演本次注释漂移。
7. `web/src/views/site/NotFound.vue:47-50` —— 只写 `document.title`，没有调 `applyPageMeta`；SPA 的 `<head>` 只有一份，404 页会沿用它上一页写入的 `og:url`/`canonical`，指向一个真实存在的页面。
8. `web/src/views/site/NotFound.vue:67-81` —— `randomArticle` 在「请求成功但没有 `slug`」时静默结束，`finally` 只把按钮复位；用户点「随便看看」看不出发生了什么（拦截器只覆盖错误分支）。
9. `web/src/views/site/Archive.vue:80-83` —— `scrollToYear` 用 `scrollIntoView({block:'start'})`，没有 `scroll-margin-top`；年份标题会停在吸顶导航下沿被遮住（导航高度 62px）。
10. `web/src/views/site/Archive.vue:340-353` —— `.tl-views` 默认 `opacity: 0` 仅 hover 显形：触屏与键盘用户永远看不到阅读数，读屏却仍会朗读它，视觉与语义不一致。
11. `web/src/views/site/Archive.vue:113-116` —— `barWidth` 在 `v-for` 里被每个月调用一次，每次都对整个 `groups` 重算 `Math.max`，复杂度 O(月数²)；把 `max` 提成一次 computed 即可。
12. `web/src/views/site/Tags.vue:19` —— `class="cloud-item is-empty weight-1"` 中的 `weight-1` 在样式表里不存在（只有 `weight-sm/md/lg/xl`），是死类名；零文章标签因此没有字号档位的语义。
13. `web/src/views/site/Tags.vue:17-24` —— 用 `aria-label` 描述一个不可聚焦、无 `role` 的 `span`，多数读屏不会朗读该标签；既然正文里已写「# 名称 0」，`aria-label` 更像装饰而非保障。
14. `web/src/views/site/Tags.vue:61-68` —— `weightClass` 每次渲染都重算 `Math.max(...tags.value.map(...))`，标签多时是 O(n²) 的纯浪费（与 #11 同类）。
15. `web/src/views/site/About.vue:19-22` —— 统计失败时直接渲染 `0`（`site.stats` 的 catch 在 `stores/site.js:31-33` 被吞），而 `web/src/views/home/Home.vue:31-39` 对同一类「0 会误导访客」的问题专门做了隐藏 + 重试；同一份数据两种口径。
16. `web/src/views/site/About.vue:66-67` —— `social_weibo`/`social_email` 拼进 `href` 前没有协议校验，而 `web/src/views/home/Layout.vue:174-177` 对 github 做了正则、`Home.vue:136-142` 对 extra 做了协议过滤；服务端 `server/src/utils/settings.js:203-205` 有校验，所以这是「纵深防御少一层」而非可直接利用的洞。
17. `web/src/views/site/About.vue:75` —— `site.init()` 在 setup 顶层裸调，而博客布局 `web/src/views/site/Layout.vue:545` 已经 `await site.init()`；靠 store 的 `loaded` 幂等，但页面与布局产生了隐式顺序依赖。
18. `web/src/views/site/About.vue:47` —— 「浏览器标签页标题」注释下面没有对应代码（紧跟 store 声明），是遗留注释。
19. `web/src/views/home/Home.vue:134-142` —— 注释称「这里再过滤一次协议」，实际只过滤 `social.extra`；模板 17/20 行的 `social.github`/`social.email` 原样进 `href`，注释与代码不一致。
20. `web/src/views/home/Home.vue:154-161` —— `STATUS[hero.status] || STATUS.online`：后台把状态清空或填了非法值时，名片会显示绿色「在线」；把缺失数据伪装成真实状态，与同文件「失败不显示 0」的严谨取向相反。
21. `web/src/views/home/Home.vue:196-205` —— `watchEffect` 里 `const siteName` 遮蔽了 130 行的同名 computed，且传 `site: { settings: { site_name } }` 丢掉 `site_url`/`og_image`；`applyPageMeta` 只能退回 `location.origin` 与默认图。
22. `web/src/views/home/Notes.vue:25` —— 首屏失败只给「加载失败，请刷新页面重试」文字，没有重试按钮；首页 `Home.vue:37-39` 有按钮，同站两套失败体验。
23. `web/src/views/home/NoteDetail.vue:160-163` —— `note === null` 时提前 `return`，既不写 `og:*` 也不清旧值：从手记 A 打开一条已删除的手记 B，head 里留的仍是 A 的 `og:title`/`og:url`；161 与 164 行还是同一句 `document.title` 的重复赋值。
24. `web/src/views/home/NoteDetail.vue:87,121-133` —— 点赞态只存组件内 `liked`，不落 localStorage；对比 `ArticleDetail` 会写 `xalor_liked_<id>`，这里刷新后按钮回到未赞，只能靠服务端 5 分钟窗口兜底。
25. `web/src/views/home/NoteDetail.vue:140-146` —— 复制链接只有 `navigator.clipboard` 一条路径，失败静默；`ArticleDetail` 有 `execCommand` 兜底 + toast，两者能力不对等。
26. `web/src/views/home/NoteDetail.vue:97-115` —— `load()` 不复位 `failedHint`，429 → 刷新失败 → 网络错误时，用户会先看到上一轮的「阅读过于频繁」文案。
27. `web/src/views/home/NoteDetail.vue:233-241` —— `.na-tag` 被拆成两个同名规则块（先 `overflow-wrap`，再 `display/gap/padding/background`），可合并。
28. `web/src/views/home/Layout.vue:42-44,48-66` —— 移动抽屉缺 `aria-controls`、Escape 关闭、遮罩、焦点转移与滚动锁；博客布局 `web/src/views/site/Layout.vue:45,117,517` 五项俱全，两入口无障碍能力不对等。
29. `web/src/views/home/Layout.vue:32-38` —— 导航里的主题按钮只有 `title` 没有 `aria-label`（同文件汉堡按钮有），且与 `120-131` 行浮层的主题按钮功能完全重复，键盘用户会 Tab 到两个语义相同的控件。
30. `web/src/views/home/Layout.vue:39` —— RSS 写死 `/api/rss.xml`，绕开 `VITE_API_PREFIX`（`web/src/api/index.js:10`）；一旦按环境改前缀，这条链接与页脚 RSS 一起失效。
31. `web/src/views/home/Layout.vue:165-169` —— `crossItems` 用 `computed` 包一个只依赖模块常量的数组，无响应式依赖；`const` 即可，`computed` 只是每帧多一层缓存检查。
32. `web/src/views/home/NotFound.vue:1-66`（无 `script`）—— 主页 404 不设 title/meta、不注入 `noindex`，而博客 404（`web/src/views/site/NotFound.vue:83-95`）两者都做了；主页兜底页会被收录。
33. `web/src/views/home/Layout.vue:203-208` 与 `Home.vue:206-210`、`Notes.vue:108-111`、`NoteDetail.vue:172-175` —— `home.load()` 在布局与三个页面各调一次；此刻靠 `stores/home.js:15` 的 `if (summary.value && !force) return` 兜住，但任何一处改成 `load(true)` 就会立刻变成双请求。
34. `web/src/views/site/Archive.vue:76`、`Tags.vue:55`、`Bookmarks.vue:55`、`History.vue:56`、`home/Notes.vue:104`、`home/NoteDetail.vue:168` —— canonical/`og:url` 由无 hash 的 `path` 拼出（`pageMeta.js:135-137`），而两个入口都是 hash 路由（`router/factory.js:17`、`utils/siteLinks.js:16-19`）：用户实际分享的是 `/#/archive`，canonical 却是 `/archive`；是否可用取决于托管层有没有 catch-all 回退。

## 小结

- 这 11 个文件是两个入口的「非文章详情」页面层：博客侧 6 页全是只读接口 + localStorage 的组合，没有写后端的能力；主页侧只有 `NoteDetail`/`Notes`/`Home` 打手记接口，`Layout` 与 `NotFound` 是纯壳。
- 数据分层很清楚：站点级元信息走 `useSiteStore`（设置 + 统计，需票据），主页首屏走 `useHomeStore`（免票裸 fetch，8s 超时），手记走 `noteApi`（票据 + `X-Sig` + 按条 AES-GCM），收藏/足迹完全不上行（localStorage 快照 + 24h 存活缓存）。签名与票据逻辑全部集中在 `api/index.js`，页面层只消费「抛异常即失败」的契约。
- 边界上最容易出事的不是渲染，而是「用读接口做校验」：`articleApi.detail` 既是闸门接口、又会计浏览量、还返回解密全文，被收藏/足迹页当成探针串行调用，是本区最大风险点。
- SEO/meta 是全站统一出口（`utils/pageMeta`），但本区有 6 处传了无 hash 的 `path`、2 处（`site/NotFound`、`home/NotFound`）完全不走这套出口，加上主页 3 页用 `{ settings: { site_name } }` 的降级对象丢掉了 `site_url`/`og_image` —— 分享卡片与 canonical 的正确性依赖托管层回退规则，属于需要单独验收的一块。
- 无障碍投入不均衡：博客侧做得细（标题层级、`aria-hidden` 去重朗读、skip-link、抽屉的 Escape/遮罩/焦点/滚动锁），主页侧只到 skip-link 与 `aria-expanded`，抽屉与重复主题按钮是明显缺口。
- 代码重复集中在两处：`Bookmarks`/`History` 的校验与清空逻辑（约 60 行），以及两个 `Layout` 里主题/页脚/浮层的同类实现；后者受双入口约束可以理解，前者建议抽成 `composables/useStaleCheck`，顺带统一「缓存命中 gone 后文章恢复」的语义。
