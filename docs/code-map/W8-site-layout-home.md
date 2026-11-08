# W8-site-layout-home — 博客站布局 / 首页 / 留言 / 友链

覆盖 4 个文件、合计 3740 行（Layout 1510、Home 1035、Messages 787、Links 408），均按行完整读完。

### web/src/views/site/Layout.vue（1510 行）

**职责**：博客站唯一的站点级外壳 —— 顶栏（液态玻璃导航 + 滚动进度条）、公告胶囊、`<router-view>` 过渡容器、四列页脚、右下角 `#float-dock` 工具栈、全局搜索与快捷键帮助的挂载点；同时承担全站站点数据初始化、PV 上报、WebSite JSON-LD 注入与"打开页面"级别的无障碍/焦点策略。

**状态与结构**：`scrolled`/`showTop`/`scrollPercent`（rAF 节流的滚动派生值）、`mobileOpen`（抽屉）、`announcementClosed`（公告记忆）、`scrollTicking`（模块级节流位）、`hamburgerRef`/`shortcutHelpRef`。`accentLabel` 由 `THEME_COLORS` 反查当前主题色中文名供 `aria-label` 使用；`isHome` = `route.path === '/'`，`navOverlay` = 首页且未滚动。

**实际逻辑**（非命名复述）：
- 公告：`localStorage['xalor_announcement_hidden']` 存 `{text, at}`；`watch(immediate)` 在设置到达的第一帧同步判定，只有"文案相同且未超 3 天（`ANNOUNCEMENT_HIDE_DAYS`）"才隐藏，改文案自动重现；旧版纯文本记录解析失败即视为未关闭。
- 关闭态/复制态：`watch(site.settings.allow_copy) → setGlobalCopyAllowed(v)`（immediate），把全站复制开关下推给 `utils/copyGuard`，文章页再叠加单篇开关。
- 滚动：`onScroll` 用 `scrollTicking` + `rAF` 收敛，写入 `scrolled`(>24px)、`showTop`(>480px)、`scrollPercent`（`scrollY / (scrollHeight - innerHeight)`，`max<=0` 时归 0）。进度环用 `RING_R=18.5 / RING_C=2πr`，`ringOffset = C*(1-p/100)`。
- 抽屉：`watch(mobileOpen)` 调 `lockBodyScroll/unlockBodyScroll`（计数锁）；`openMobile` 在 `nextTick` 后把焦点送到第一个 `.mobile-link`，`closeMobile(restoreFocus)` 默认把焦点还给汉堡按钮；`watch(route.path)` 改变即关。
- 键盘：`Escape` 关抽屉；`Ctrl/Cmd+K` → `openSearch()`（`preventDefault` 后派发 `window` 事件 `xalor-open-search`）；`/` 仅在 target 非 `INPUT/TEXTAREA/contentEditable` 时生效。
- 跳转主内容：`skipToMain` 只做 `#main-content.focus({preventScroll})` + `scrollIntoView`，不碰 URL —— 因为 hash 路由会把 `#main-content` 当成路由。
- 页脚年份：`footer.replace(/©\s*\d{4}/, 当年)`，无配置时回落 `© 年份 站名`。
- 启动序列：`await site.init()` → `warmFormToken()`（预热 /comments、/messages、/links 三张表单令牌）→ `requestIdleCallback`（无则 2s）预取 6 个路由 chunk → `statsApi.record()` **然后** `site.fetchStats()`（顺序刻意：先计数再读汇总）→ `applyWebSiteLd()` 写入/复用 `#jsonld-website`。卸载时移除监听、删除该 script、`resetBodyScroll()`。

**项目内依赖**：`@/components/ui/XIcon.vue`、`SearchModal.vue`、`ShortcutHelp.vue`、`@/components/site/AmbientParticles.vue`、`@/stores/theme`(含 `THEME_COLORS`)、`@/stores/site`、`@/utils/siteLinks`(`homeUrl`)、`@/api`(`statsApi`)、`@/utils/format`、`@/utils/formToken`、`@/utils/scrollLock`、`@/utils/copyGuard`。

**后端接口约定**：`POST {VITE_API_PREFIX||/api}/stats/record`、`GET /stats/summary`（经 store）。两者都由 `api/index.js` 拦截器统一附加 `X-Fp`、`X-Pass`（票据）、`Authorization`(后台 JWT，有则带)、`X-Timestamp`/`X-Sig`/`X-Nonce`（`HMAC(ticket, method|path|ts|bodyHash|jti|nonce)`）；无票据时先走 `ensurePass()` 做 PoW 建通道。响应必须是 `{code:0, data}`，拦截器把 `data` 直接返回，非 0 走 reject + 去重 toast。RSS 是静态 `GET /api/rss.xml`。

**UI/交互**：Element Plus 只用 `el-popover`（主题色，4 列 12 色色板，`popper-class="theme-popover"`），其余全部自研。过渡 `page`(显式 `{enter:260,leave:240}`，避免后台标签页帧冻结卡死)、`drawer`、`ticker-slide`、`pop`。可访问性投入较重：`aria-expanded/aria-controls/aria-label`（汉堡、主题色按钮含当前色名）、`aria-hidden` 装饰层、`tabindex="-1"` 的 `<main>`、公告关闭按钮 44×44 热区（视觉圆点 22px，负 margin 抵消）、`prefers-reduced-motion` 下挪动位移只留 0.12s 淡入淡出。响应式断点 900px（隐藏横向导航、显示汉堡/抽屉、页脚 2 列）、560px（隐藏站名文字、页脚 1 列）。

**运行期副作用/失败模式**：`site.init()` 内部吞异常 → 设置为空时导航/页脚回落到硬编码默认值（站名、GitHub、邮箱）；统计失败静默保留旧值；`Teleport to="#float-dock"` 依赖 `index.html:71`/`home.html:55` 的静态容器，缺失则该块直接不渲染；搜索依赖 `SearchModal` 监听 `xalor-open-search`，而 `Ctrl+K` 在组件未挂载时靠本文件的 window 监听兜底。

### web/src/views/site/Home.vue（1035 行）

**职责**：博客首页 —— 全屏头图玻璃卡（打字机标语 + GitHub/邮箱/阅读文章三个 CTA + 三项数字滚动），下面 `#home-feed` 两列：左侧 8 篇 `ArticleCard`（variant=`feed`、headingLevel=2）+ 失败/空/骨架三态，右侧粘性侧栏（作者卡、分类、热门/热议切换、最新评论、全站阅读统计、标签云）。

**状态与结构**：`articles/categories/tags/hotArticles/recentComments`、`hotSort`、`total`、`loading`、`homeError`、`typed/typedFull`（打字机）、`display`（滚动数字）。`feedArticles` 仅是 `articles` 的 computed 直传；`githubHref/mailHref` 与 Layout 同款回落逻辑。定时器全部放模块级：`typeTimer`(setInterval)、`hitokotoRetry`(setTimeout)、`typingAlive`、`heroTicking`、`heroRafId`。

**实际逻辑**：
- `watchEffect` 写 `document.title`（`站名 · slogan`）并调 `applyPageMeta({description, path:'/', site: site.settings})`；首页故意不传 `title`，避免"站名 · 站名"。
- `loadHome` 用 `Promise.allSettled` 并发 5 个请求（文章 8 篇、分类、标签、热门 5 篇、最近评论），逐个按 `status==='fulfilled'` 落值；`homeError` 只在**前四个全部 rejected** 时为真。
- 数字滚动 `runCountUps`：`animateNumber` 以 `1-(1-t)^3` 缓动 + rAF 逐帧写入，三个指标各错开 140ms；`prefers-reduced-motion` 时直接赋值。
- 打字机：`typeText` 用 42ms 的 `setInterval` 逐字显示，到末尾后按 `full.length>40 ? 36 : 28` 个 tick 停顿再逐字删除；`hold` 时停在满串。`startTyping` 串行播两行 `INTRO_LINES`，之后 `playNextHitokoto` 进入"取一言 → 打字 → 删除 → 再取"的循环；取空则 6s 后重试，reduced-motion 下改为 8s 直接换文本。
- 视差：`applyHeroParallax` 先把 `heroTicking` 复位再判空，`scrollY > innerHeight` 时直接返回（省掉不可见写入），写入 `scale(1.08) translate3d(0, y*0.18px, 0)`；reduced-motion 下复位为 `scale(1.08)` 且不再计算。

**项目内依赖**：`@/components/ui/XIcon.vue`、`@/components/site/ArticleCard.vue`、`@/components/ui/SkeletonList.vue`、`@/api`(`articleApi/categoryApi/tagApi/commentApi/hitokotoApi`)、`@/stores/site`、`@/utils/format`、`@/utils/pageMeta`、`@/assets/hero-1600.webp`、`@/assets/hero.webp`。

**后端接口约定**：`GET /articles?pageSize=8` → `{list, pagination:{total,...}}`；`GET /categories` → 数组（含 `slug/name/color/article_count`）；`GET /tags` → 数组（`slug/name`）；`GET /articles?pageSize=5&sort=hot|commented`（服务端 `articles.js` 支持 `latest|hot|commented`）；`GET /comments/recent` → 数组（`id/nickname/content/article_slug`）；`GET /hitokoto`（`silent:true`，失败不弹 toast）。全部经签名拦截器，默认带票据与 HMAC 头。

**UI/交互**：无 Element Plus 组件，全自研。`--hero-h` 用 `100svh`（以 `100vh` 兜底，防移动端地址栏把 CTA 顶出首屏），`image-set` 按 1x/2x 切 1600/2560 WebP；`type-caret` 闪烁光标；热门/热议两个小胶囊 tab（命中区 32px，640px 断点再放大）；标签云 `slice(0,18)`、评论 `slice(0,5)`；断点 960px 单列 + 侧栏 `order:2` 且取消 sticky、640px 收窄 hero。可访问性：`aria-label="站点横幅"`、装饰层 `aria-hidden`、`prefers-reduced-motion` 关掉 `drift` 动画与光标闪烁。

**运行期副作用/失败模式**：单接口失败被 `allSettled` 吞掉，页面表现为空态而不是错误态；`setHotSort` 先改标题态再发请求，失败无回滚；`hitokoto` 全程静默；滚动监听在 `await site.init()` + `loadHome()` 之后才挂，首屏期间视差不存在；`onUnmounted` 清理了 interval/timeout/rAF 与 scroll 监听，但没有 `document.title`/meta 的还原（依赖下一页覆写）。

### web/src/views/site/Messages.vue（787 行）

**职责**：留言板 —— 昵称/邮箱/正文表单（含表情面板、草稿、字符计数、字段级错误、快捷键提交）+ 分页留言列表（管理员徽标、站长回复）+ 加载更多。

**状态与结构**：`messages/page/pageSize=12/total`、`submitting`（表单提交中）、`loading`（加载更多）、`listLoading`/`listFailed`（首屏与失败态，刻意与 `loading` 分离）、`hasMore`、`form{nickname,email,content}`、`hpField`、`showEmoji`、`fieldErrors{nickname,content}`、`nicknameRef`/`contentRef`；模块级 `savedName`(localStorage `xalor_mname`)、`savedEmail`(`readSessionValue('xalor_memail')`)、`draftTimer`。

**实际逻辑**：
- 草稿：`saveDraft/loadDraft`（`utils/localDraft`，key `xalor_mdraft`），`watch(content)` 800ms 防抖落盘；`beforeunload` 与 `onUnmounted` 都 `flushDraft()`；进入页面时若 24h 内有非空草稿则回填并 400ms 后提示。
- `load()` 自带 try/catch，失败置 `listFailed`（拦截器已弹 toast，这里只负责页面态）；`loadMore()` 用局部游标 `next = page+1`，请求成功后才推进 `page`，避免失败跳页。
- `submit()`：trim 后做两条必填校验 → 有错则同时 `ElMessage.warning` + `nextTick` 后 `focusFirstError()`（把焦点送到第一个出错字段，配合 `aria-describedby` 让读屏念出错误）→ `getFormTokenInfo('/messages')` 拿 `{token, hpField}` 并更新 `hpField` → `POST` 时 body 带 `[动态蜜罐名]`（空值）与 `form_token`，头部再带 `X-Hp-Field` 声明该字段名 → 按 `res.moderated` 区分"等待审核"与"成功"文案 → 记忆昵称、会话内存邮箱、清草稿、`refreshFormToken('/messages')`、`page=1; await load()`。
- 头像：`avatarColor(nickname)` 以 `h*31+charCode` 散列到 6 组渐变。
- 表情插入：按 `selectionStart/End` 在光标处拼接并在 `rAF` 后复位光标；`showEmoji` 偏好写 `localStorage['xalor_emoji_open']`（与评论区共用）。

**项目内依赖**：`@/components/ui/XIcon.vue`、`SkeletonList.vue`、`EmojiPicker.vue`、`@/api`(`messageApi`)、`@/utils/formToken`(`getFormTokenInfo/refreshFormToken/getHpField`)、`@/utils/format`(`timeAgo`)、`@/utils/secureStorage`、`@/utils/localDraft`、`@/utils/pageMeta`、`@/stores/site`，以及 `element-plus` 的 `ElMessage`。

**后端接口约定**：`GET /messages?page&pageSize` → `{list:[{id,nickname,content,reply,replied_at,created_at,is_admin}], pagination:{page,pageSize,total}}`（服务端 `messages.js` 只返回 `status='approved'`，`is_admin` 由昵称命中管理员名单得出）。`POST /messages` body `{nickname,email,content,[hpField],form_token}` + header `X-Hp-Field`，中间件链 `限流(6/min) → honeypotCheck → formTokenRequired → 保留昵称鉴权`，返回 `{moderated:boolean}`；403 的语义包括令牌过期/令牌已用/蜜罐命中/昵称占用，400/429 覆盖敏感词、重复内容与频率。表单令牌与路径强绑定、服务端 10 分钟过期、`min_interval=2000`，前端缓存 5 分钟并强制等满 2100ms 才提交。

**UI/交互**：表单是原生 `input/textarea`（非 Element Plus 表单），只用 `ElMessage` 做 toast。可访问性较完整：`aria-label`、`:aria-invalid`、`:aria-describedby` 指向错误段落、错误段 `role="alert"`、表情按钮 `:aria-pressed`、`kbd` 提示在 `(hover:none)` 下隐藏、焦点环显式补 `:focus-visible`（注释说明 scoped 特指度压过全局规则）。蜜罐字段用 `left:-9999px` 隐藏且 `tabindex="-1"`/`aria-hidden`。骨架、失败态（含重试按钮）、空态三态分离，列表用 `v-reveal="'stagger'"` 交错入场。

**运行期副作用/失败模式**：提交没有重入守卫（`submitting` 只 disable 按钮），`Ctrl+Enter` 连按可重复 POST；403 分支只刷令牌不重试；offset 分页在有新留言通过审核时会重复/漏条；恢复草稿的 `setTimeout` 未在卸载时清理。

### web/src/views/site/Links.vue（408 行）

**职责**：友链页 —— 已通过友链的卡片网格（头像失败降级为首字母渐变）+ 友链申请表单。

**状态与结构**：`links`、`submitting`、`listLoading`、`listFailed`、`failedAvatars`(`ref(new Set())`)、`form{name,url,avatar,email,description}`、`hpField`、`mailNotify`（`site.settings.mail_notify`）。

**实际逻辑**：`load()` 一次性取全量友链（无分页），try/catch 置 `listFailed`；模板按 `l.avatar && !failedAvatars.has(l.id)` 渲染 `<img>`，`@error` 时把 id 塞进 Set 让首字母兜底接管；`submit()` 只做两条必填（名称/地址）的 `ElMessage.warning` 早退，然后同样走 `getFormTokenInfo('/links')` → 动态蜜罐字段 + `X-Hp-Field` + `form_token`，`email` 仅在 `mail_notify` 开启时上报；成功后清空表单并 `refreshFormToken('/links')`。

**项目内依赖**：`@/components/ui/XIcon.vue`、`SkeletonList.vue`、`@/api`(`linkApi`)、`@/utils/formToken`、`@/stores/site`、`@/utils/pageMeta`、`element-plus`(`ElMessage`)。

**后端接口约定**：`GET /links` → **数组**（`[{id,name,url,avatar,description,sort}]`，仅 `status='approved'`，按 `sort desc, id asc`）。`POST /links` body `{name,url,avatar,email,description,[动态蜜罐],form_token}` + `X-Hp-Field`，限流 5/min，服务端 `cleanLine/safeUrl/safeCover/safeEmail` 二次清洗；无返回值依赖（只用成功/失败）。

**UI/交互**：两列卡片（`<a target="_blank" rel="noopener noreferrer nofollow">`），hover 才浮现右上角外链箭头；申请区用 `h2` 而不是 `h3` 修正 h1→h3 跳级（注释明说）；`(max-width:640px)` 单列。无 Element Plus 表单组件，同用 `ElMessage`。

**运行期副作用/失败模式**：申请区不是 `<form>`，`type="url"/type="email"` 的原生校验不会触发、Enter 不提交；`<label>` 未与输入框关联；提交同样无重入守卫；头像 URL 来自申请人填写，访客浏览即向第三方域名发起请求。

## 观察

1. `web/src/views/site/Layout.vue:9-14` —— 注释称"用 role/tabindex 让它仍可被 Tab 到"，但模板里的跳转链接既无 `role` 也无 `tabindex`，且 `href="#main-content"` 仍保留：中键/Ctrl+点击绕开 `@click.prevent`，URL 会真的变成 `#main-content`。
2. `web/src/views/site/Layout.vue:449` —— `let scrollTicking` 声明在 `onScroll`（437 行）之后，靠 setup 顺序执行才不 TDZ；把它上移可消除这类隐性时序依赖。
3. `web/src/views/site/Layout.vue:53,145,253` 与 `:70,147,250` —— 搜索与主题切换各有三处入口（顶栏、移动抽屉、右下 dock），行为一致但状态提示文案分散在三处，改一处易漏。
4. `web/src/views/site/Layout.vue:196,214,256` —— RSS 链接三处硬编码 `/api/rss.xml`，而接口前缀是可配置的 `VITE_API_PREFIX`（`web/src/api/index.js:11`），改前缀后这三处会 404。
5. `web/src/views/site/Layout.vue:757-776` —— `.brand-mark` / `.brand-mark.sm` 没有对应节点（模板只用 `.brand-mark-img`），属死 CSS。
6. `web/src/views/site/Layout.vue:1259-1263` —— `.footer-powered em` 无对应 `<em>`（模板 239 行是纯文本"Designed with care · Vue 3"），死 CSS。
7. `web/src/views/site/Layout.vue:528-529` —— 注释断言"实测只派发 1 次"，实际 `SearchModal.vue:317` 也监听同一 `Ctrl+K`，事件冒泡 document→window 会走两条路径；不出问题是靠 `SearchModal.vue:216` 的幂等守卫，注释结论对、归因不完整。
8. `web/src/views/site/Layout.vue:545` + `web/src/views/site/Home.vue:445` + `web/src/stores/site.js:65` —— `init()` 只判 `loaded`、没有 in-flight Promise 去重，Layout 与 Home 的 `onMounted` 会并发跑两轮 settings/stats/reading。
9. `web/src/views/site/Home.vue:386-390` —— `homeError` 要求文章/分类/标签/热门四个请求"全部" rejected，只挂 `/articles` 时页面显示"还没有文章，等待第一篇诞生"，把接口故障说成空站，与 Messages/Links 已修正的口径相反。
10. `web/src/views/site/Home.vue:39-44` —— 错误块没有 `role="alert"`（`Messages.vue:101`、`Links.vue:15` 都有），读屏用户听不到"加载失败"。
11. `web/src/views/site/Home.vue:139-150` —— 注释写"dt 在前 dd 在后…DOM 顺序保持语义"，代码是 `<dd>` 在 `<dt>` 之前：注释与实现相反，`dl` 的子项顺序也不符合规范。
12. `web/src/views/site/Home.vue:229-234` —— `setHotSort` 先改 `hotSort` 再发请求，`.catch(() => null)` 后无回滚，失败时标题已变"热议"、列表仍是热门数据。
13. `web/src/views/site/Home.vue:218` —— `feedArticles = computed(() => articles.value)` 无任何派生逻辑，是多余抽象层（模板可直接用 `articles`）。
14. `web/src/views/site/Home.vue:844-846` —— `.author-card h2` 无对应节点（模板 68 行是 `h3`）：死 CSS，同时侧栏首标题从 h1 直落 h3。
15. `web/src/views/site/Home.vue:450` —— 滚动监听挂在 `await site.init()` 与 `loadHome()` 之后，首屏加载完成前头图视差完全不生效。
16. `web/src/views/site/Home.vue:504-507` —— 只写 `image-set(...)`、无 `-webkit-` 前缀也无位图兜底，旧 Safari 上整条 `background-image` 失效，只剩 `background-color`。
17. `web/src/views/site/Messages.vue:210-211` —— 两条 `import` 写在文件中部（ESM 合法但破坏可读性），而 `applyPageMeta` 早在 169 行就被调用，靠提升才能工作。
18. `web/src/views/site/Messages.vue:355-404` —— `submit()` 没有 `if (submitting.value) return`，`Ctrl+Enter` 连按会重复 POST（`submitting` 只负责 disable 按钮）。
19. `web/src/views/site/Messages.vue:398` —— 403 分支只 `refreshFormToken` 不重试；且正则 `/疑似机器人|提交过快/` 与后端实际文案（`server/src/routes/messages.js:32,41` 的"太频繁"、"提交被拒绝"）不匹配，判断基本恒真。
20. `web/src/views/site/Messages.vue:293-308` —— `loadMore` 用 offset 分页且不按 id 去重，期间有新留言通过审核会整体位移，导致重复或漏条。
21. `web/src/views/site/Messages.vue:216-220` —— 恢复草稿后 400ms 的 `ElMessage` 未在 `onUnmounted` 清理，快速离开页面时提示会飘到别的路由上。
22. `web/src/views/site/Messages.vue:241-243,312` —— 用 `document.querySelector('.msg-form textarea')` 取元素，而 334 行已有 `contentRef`：同一组件两套取元素方式，DOM 结构一变就静默失效。
23. `web/src/views/site/Messages.vue:104` —— `class="search-btn retry-btn"` 里的 `.search-btn` 在本文件与全局 `main.css` 均无定义，属残留类名。
24. `web/src/views/site/Links.vue:46-66` —— `<label>` 没有 `for`、`input` 没有 `id`/`aria-label`：点标签不聚焦，读屏拿不到字段名。
25. `web/src/views/site/Links.vue:1-84` —— 全页没有 `<form>`，`type="url"`/`type="email"` 的原生校验永远不会执行，Enter 也不提交，URL 合法性完全交给服务端 `safeUrl`。
26. `web/src/views/site/Links.vue:113,23` —— `failedAvatars` 是 `ref(new Set())` 并直接 `.add()`，靠 ref 深响应代理才触发更新；换成 `shallowRef` 会静默失效，属隐性依赖。
27. `web/src/views/site/Links.vue:272-284` —— `.link-go` 只在 `:hover` 出现，卡片没有 `:focus-visible` 规则，键盘用户看不到"外链"提示。
28. `web/src/views/site/Links.vue:321-336` —— `.field-input` 设 `outline:none` 只换边框色、无焦点环（`Messages.vue:478-482` 已补 `:focus-visible`），键盘可见性不一致。
29. `web/src/views/site/Links.vue:386-407` —— 与 `web/src/views/site/Messages.vue:630-651` 是同一份 `.list-error .retry-btn` 样式复制；同理 `hp-field` 隐藏样式两份（`Messages.vue:585-593` / `Links.vue:345-353`），应提到全局。
30. `web/src/views/site/Messages.vue:257-271` 与 `web/src/views/site/Links.vue:118-132` —— `avatarColor` 连 6 组渐变调色都完全相同；`Layout.vue:418-426` 与 `Home.vue:219-227` 的 `githubHref/mailHref` 同样重复，缺一个共享 util。
31. `web/src/views/site/Messages.vue:169` 与 `web/src/views/site/Links.vue:106` —— 一处传 `site.settings`、一处传 site store，靠 `utils/pageMeta.js:30` 的 `resolveSettings` 同时兼容，属未写明的隐式契约。
32. `web/src/views/site/Links.vue:23` —— 头像 `src` 来自申请人填写的任意 URL 且无 `referrerpolicy`，访客打开友链页就会向第三方域名发请求（IP/referrer 泄露，可被当统计探针）。
33. `web/src/views/site/Messages.vue:78` —— 计数预警阈值 1800 与 `maxlength=2000`、服务端 `cleanText(content,2000)` 是三处各自硬编码的数字。
34. `web/src/views/site/Messages.vue:197,372` —— `hpField` 先由缓存 `getHpField` 取、提交前又覆盖一次；若 `getFormTokenInfo` 因为 5 分钟缓存命中而返回旧 `hpField`，而服务端蜜罐名按"指纹+路径+8 位时间片"滚动派生（`server/src/middleware/formToken.js:81-91`），跨时间片提交存在字段名与当前窗口不一致的窗口，只能靠服务端"检查声明的 header 字段"兜住。

## 小结

1. 这四个文件构成博客站"公共骨架 + 三个公开页面"层：Layout 是唯一常驻组件，承担导航/页脚/公告/浮层、站点数据初始化、PV 上报与 per-page meta 之外的全局无障碍策略；三个页面都只是 Layout 的 `<router-view>` 子节点，自身不重复外壳。
2. 横切能力的入口都压在 Layout：`site.init()`、`warmFormToken()`、路由 chunk 预取、复制守卫下推、JSON-LD 注入。任何"全站都该有"的行为都应在这里落地，而不是在页面里各写一份。
3. 后端契约统一走 `api/index.js` 的签名实例（票据 + 指纹 + HMAC + 非对称解码），页面侧只认 `{code:0,data}`；唯二需要额外协议的是表单类接口 —— `/anti/seed` 签发的 `token`（绑定路径、10 分钟 TTL、`min_interval=2000`）与随机蜜罐字段名，缺少 `form_token` 或命中蜜罐即 403。
4. 三个页面的失败态处理并不齐：Messages/Links 已把"接口挂了"与"内容为空"分开并给重试入口，Home 仍要求四个请求全挂才算失败，等于把首页降级成"空站"。
5. 明显的重复实现集中在三处：`avatarColor`、`githubHref/mailHref`、`.list-error .retry-btn` + `hp-field` 样式；表单提交链路（取令牌 → 动态蜜罐 → 错误态 → 刷令牌）也几乎可以抽成一个 composable。
6. 边界：本区不含文章列表/详情/归档/标签、后台、路由与 store 定义；Layout 依赖的 `stores/site`、`api` 拦截器、`utils/formToken`、`utils/scrollLock` 均为已有约定，本区只消费不定义。
