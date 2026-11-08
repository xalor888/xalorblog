# W3-web-utils-content · 前端渲染与内容工具

> 覆盖 `web/src/utils/` 下 15 个模块，逐行读完。共同前提：这些模块**都不直接发请求**、都不依赖 Element Plus；凡涉及后端处均经 `web/src/api/index.js` 的 axios 实例——每条请求自动带 `X-Fp`（指纹）、`X-Pass`（PoW 票据）、JWT（后台）、`X-Timestamp`/`X-Nonce`/`X-Sig`（HMAC-SHA256，key=ticket，消息 `METHOD|path|ts|sha256(body)|jti|nonce`），响应 `{code,message,data}` 由拦截器拆包（`code!==0` 直接 reject，只有真实 HTTP 状态才带 `e.response.status`）。

### web/src/utils/markdown.js（521 行）

- **职责**：Markdown → 可 `v-html` 的安全 HTML，并补代码块高亮/复制、表格/任务列表/图片/标题的可访问性语义。
- **关键导出**：`renderMarkdown`、`extractToc`、`addHeadingIds`、`addImgAttrs`、`initMarkdownInteractions`；内部 `annotateTaskItems`/`addTableScopes`/`demoteH1`/`headingText`/`imgNameFromSrc`/`parseImgAttrs`/`copyToClipboard`/`legacyCopy`/`showCopyResult`/`resetCopyButton` 与 `copyTimers`(WeakMap)。
- **实际逻辑**：`renderMarkdown` = `marked.parse` → `annotateTaskItems`（复选框补 `aria-label`，先 `decodeEntities` 再转义避免二次转义）→ `demoteH1`（正文 h1 降 h2 并打 `data-demoted="1"`）→ `addTableScopes`（`th[scope=col]`、table 加 `tabindex="0"`）→ `DOMPurify.sanitize`；**标题 id 与图片属性不在此处**，由调用方另拼。高亮只注册 22 个语言（`hljs/lib/core`），未知语言走 `escapeHtml`。`extractToc` 用 `marked.lexer` 遍历（递归 blockquote/list/list_item）取 depth 2–4，编号 `heading-${index}`，与 `addHeadingIds` 的计数顺序约定一致；词法异常回退行正则。复制链路 `writeText` → 失败落 `execCommand('copy')`，两者都返回真实布尔，1.6s 复位，播报交给独立 `role=status`。
- **项目内依赖**：`marked`、`highlight.js`（按需语言包）、`dompurify`；引用方 App.vue、ArticleDetail、ArticleList、About、AskAi、NoteDetail、ArticleEdit/NoteEdit/AiPanel/Settings。
- **后端接口约定**：无。输入是 `articles.content`/`notes.content`/`settings.about_content`，正文本已在 api 拦截器内按票据派生密钥解密。
- **UI/交互要点**：无 Element Plus；自研 `div.code-block` 头部（圆点 + 语言标签）+ `button[data-copy]` + `span.code-copy-status.sr-only[role=status]`；事件委托挂 `document`；标题加 `tabindex="-1"` 便于 TOC 脚本聚焦。
- **副作用与失败模式**：顶层**全局**改 `marked` 配置与 renderer、全局注册 DOMPurify `afterSanitizeAttributes`（剥 `style` 内 `url(...)`、外链补 `rel="nofollow noopener ugc"`、站内补 `noopener`）；外链判定依赖 `window.location.hostname`，无 window 环境会抛。

### web/src/utils/highlight.js（41 行）

- **职责**：搜索关键词高亮的唯一实现（列表页与搜索弹层共用）。
- **关键导出**：`escHtml`、`highlightKeyword`。
- **实际逻辑**：`trim` 关键词，空则只转义；正则元字符全量转义后 `new RegExp('(k)','gi')`，`split` 带捕获组、奇数位为命中段，执行「原文匹配 → 逐段转义 → 命中包 `<mark>` → join」，因此 `A & B` 能命中。
- **项目内依赖**：无。使用者 `components/ui/SearchModal.vue`、`views/site/ArticleList.vue`。
- **后端接口约定**：无；搜索数据来自 `/search`，这里只渲染 `keyword`。
- **UI/交互要点**：产物是 `<mark>` 片段，样式由宿主 scoped CSS 决定；不截断、不限命中数。
- **副作用与失败模式**：无全局状态；单字符关键词在长正文里会产出上千 `<mark>`；多词关键词按整串匹配不分词，换行/多空格处漏高亮。

### web/src/utils/wordStats.js（130 行）

- **职责**：全站字数与阅读时长的唯一口径，取代原先三处各写一份的实现。
- **关键导出**：`CN_WPM=350`、`EN_WPM=250`、`stripMarkdown`、`countWords`、`readingMinutes`、`aggregateReading`。
- **实际逻辑**：`stripMarkdown` 依次去代码块/行内代码/图片/链接语法并把 `#>*_~-` 换空格（与 `server/src/utils/markdownText.js` 的 `plainText` 逐行同语义）；`countWords` 用 `CJK_RE`（含扩展 A）与 `WORD_RE` 分别数中英，返回 `{cn,en,total}`，`opts.raw` 供编辑器按原文计数；`readingMinutes` 合并 `cn/350+en/250` 后一次性 `ceil`，`minOne` 只给展示层；`aggregateReading` 单遍汇总 `total_articles/total_words/avg_words/longest/total_reading_minutes`（总量一次性取整）。
- **项目内依赖**：无。使用者 `utils/format.js`、`views/admin/ArticleEdit.vue`、`web/scripts/test-word-stats.mjs`。
- **后端接口约定**：无直接调用；口径需与 `/stats/reading` 对齐，实际未对齐（见观察）。
- **UI/交互要点**：纯函数、无渲染，Node 可跑（`test:scripts` 直接驱动）。
- **副作用与失败模式**：`content` 缺失按 0；不解 HTML 实体（`&amp;` 计入英文词）；`-`/`_` 被当空格，`vite-plugin-vue` 拆成 3 词。

### web/src/utils/readingPrefs.js（105 行）

- **职责**：阅读偏好（字号/行距/版心/字体/沉浸）的解析-夹取-步进-持久化，storage 由调用方注入以便测试。
- **关键导出**：`FONT_SIZE{14,20,16}`、`LINE_HEIGHT{1.5,2.4,1.9,0.15}`、`READ_WIDTH{620,980,760,60}`、`STORAGE_KEYS`、`load*/step*/save*` 各五组、`charsPerLine`。
- **实际逻辑**：`readRaw/writeRaw` 用 try/catch 包住 localStorage；`clampNumber` 先排除 `''`/`null`/`undefined`（避开 `Number('')===0`）、再 `Number.isFinite` 滤 `NaN`/`Infinity`、最后夹区间；行距两位取整防 `1.9000000000000001`；`loadFontStyle` 只认 `'serif'`；`step*` 到边界返回原值；`charsPerLine=round(width/fontSize)`（不含内边距/字距，属估算）。
- **项目内依赖**：无。唯一使用者 `views/site/ArticleDetail.vue`（读值、变更时 `save*`、展示「每行约 N 字」）。
- **后端接口约定**：无（纯 localStorage，键前缀 `xalor_`）。
- **UI/交互要点**：无 Element Plus；宿主用 `div.rt-group` + 原生 `button.rt-btn`（`aria-label`+`title`），当前值以 `span.rt-value` 文本呈现。
- **副作用与失败模式**：存储不可用时静默不记忆；`step*` 的「到边界」信号未被调用方使用（只做 `dim`）。

### web/src/utils/pageMeta.js（145 行）

- **职责**：SEO/社交分享元信息的统一出口，一次设置整组。
- **关键导出**：`applyPageMeta`、`siteOrigin`、`absoluteUrl`；内部 `resolveSettings`/`upsertMeta`/`setMetaByName`。
- **实际逻辑**：`resolveSettings` 兼容两种入参（Pinia store 读 `.settings`，或直接 settings）；`siteOrigin` 取 `site_url||domain`、无协议补 `https://`、失败回落 `location.origin`；`absoluteUrl` 只绝对化站内相对路径；`og:*` 写 `property`、`twitter:*` 全部写 `name`（注释记录了「写成 property 等于不存在」）；标题缺省时**写站名**而非跳过，避免 SPA 残留；`og:url` 缺 `path` 时取 `location.hash.slice(1)`，canonical 复用同一 URL。
- **项目内依赖**：无。13 个页面调用（site 的 Home/ArticleList/Archive/Tags/About/Links/Bookmarks/History/Messages 与 home 的 Home/Notes/NoteDetail）。
- **后端接口约定**：读 `/api/settings` 的 `site_name`、`site_url`/`domain`、`og_image`（公开只读接口，`server_tz_offset_min` 同批下发；保存走秘钥路径）。
- **UI/交互要点**：无组件；直接操作 `document.head` 的 `meta[property]`/`meta[name]`/`link[rel=canonical]`，所有 `content` 截 300 字符。
- **副作用与失败模式**：`<head>` 只增不删，跨路由靠写覆盖；`description` 原样截断不剥 Markdown；默认图 `png` 与 `webp` 并存。

### web/src/utils/slugCheck.js（67 行）

- **职责**：收藏/足迹页「文章是否还存在」探测结果的共享缓存（24h TTL，只缓存 `ok`/`gone`）。
- **关键导出**：`getCachedStatus`、`setCachedStatus`、`clearStatusCache`；键 `xalor_slug_check`，值 `{[slug]:{status,ts}}`。
- **实际逻辑**：读失败或非普通对象回 `{}`；条目缺 `ts` 或超 TTL 返 `null`；只认两个合法状态。写时只接受这两值，写入后先按 TTL 过滤，再 `slice(-200)` 截断。
- **项目内依赖**：无。使用者 `views/site/History.vue:103`、`views/site/Bookmarks.vue:78`（两处 `pruneStale` 串行逐条探测）。
- **后端接口约定**：调用方用 `articleApi.detail(slug)` → `GET /api/articles/slug/:slug`（带签名与票据）；不存在时服务端 `notFound` 返 **HTTP 404**，据此记 `gone`；该接口同时 +1 浏览量（同 IP+指纹 5 分钟去重）并计入反爬阅读配额，超限 429。
- **UI/交互要点**：无组件；失效项只标记不删除，渲染为不可点击卡片。
- **副作用与失败模式**：写 localStorage 失败静默；`'ok'` 缓存 24h 内不复查，文章下线后收藏最长一天仍可点。

### web/src/utils/format.js（94 行）

- **职责**：日期/相对时间/数字/阅读时长的展示格式化。
- **关键导出**：`timeAgo`、`formatDate`、`formatDateTime`、`readingTime`、`formatNumber`、`setServerTzOffset`；内部 `parseServerTime`/`rel` 与模块级 `serverTzOffset`。
- **实际逻辑**：`parseServerTime` 把无时区的服务器本地时间串按 UTC 解析，再加 `serverTzOffset` 分钟换算绝对时刻；`rel` 分档 `刚刚/<分钟/<小时/<天/<30天/日期`；`formatNumber` 万进 `w`、千进 `k`、非正归 `0`；`readingTime` 委托 `readingMinutes(content,{minOne:true})`。
- **项目内依赖**：`./wordStats`。被 `stores/site.js`（注入时区偏移）与 20 个组件引用。
- **后端接口约定**：偏移来自 `/api/settings.server_tz_offset_min`（`server/src/routes/settings.js:31` 现算）；时间字段一律无时区后缀。
- **UI/交互要点**：无组件；输出纯字符串，`title`/`datetime` 由宿主补。
- **副作用与失败模式**：`serverTzOffset` 是可变单例，设置后不触发已渲染相对时间重算；已带 `Z`/`±hh:mm` 的输入仍叠加偏移；`Date` 入参在长跨度分支会被字符串切片。

### web/src/utils/siteLinks.js（26 行）

- **职责**：双入口（blog 的 index.html 与 home 的 home.html，hash 路由）的跨站基址拼装。
- **关键导出**：`BLOG_URL`、`HOME_URL`（`VITE_BLOG_URL`/`VITE_HOME_URL`，默认 `https://blog.xalor.cn`、`https://xalor.cn`，尾部斜杠被 trim）、`blogUrl`、`homeUrl`。
- **实际逻辑**：去前导 `/` 后拼 `${BASE}/#/${p}`；空路径返 `${BASE}/`。
- **项目内依赖**：无。使用者 site/Layout、home/Layout、home/Home。
- **后端接口约定**：无；值来自构建期环境变量，与 `server/src/config.js` 的 `HOME_SITE_HOST`/`home_site_url` 是两套独立配置。
- **UI/交互要点**：产出 `<a href>` 绝对地址，跨站即整页刷新。
- **副作用与失败模式**：不做 `encodeURIComponent`；传已带 `#` 或查询串会拼出 `/#//...`。

### web/src/utils/history.js（90 行）

- **职责**：本机阅读足迹（被动记录、去重、上限 20）。
- **关键导出**：`getHistory`、`addHistory`、`removeHistory`、`clearHistory`、`HISTORY_KEY`、`onHistoryChange`。
- **实际逻辑**：`readList` 解析失败或非数组返 `[]`，并过滤无 `slug` 的脏项；`addHistory` 组快照（`id/slug/title/summary/cover/category_name/category_color/published_at/ts`），按 slug 去重后 `[entry,...list]`；`save` 前 `slice(0,20)`；`onHistoryChange` 监听 `storage`（`e.key===null` 视为 `clear()`）并返回解绑函数。
- **项目内依赖**：无。使用者 `views/site/ArticleDetail.vue:763`、`views/site/History.vue`。
- **后端接口约定**：无（纯本地）；有效性另行按 slug 探测。
- **UI/交互要点**：无组件；与收藏同一心智模型，入口在页脚。
- **副作用与失败模式**：隐私模式写入静默失败；不跨设备；快照与文章后续改名/换分类不同步。

### web/src/utils/copyGuard.js（67 行）

- **职责**：按「全站开关 + 单篇开关」决定是否拦截选中/右键/图片拖拽，默认放行。
- **关键导出**：`setGlobalCopyAllowed`、`setArticleCopyAllowed`、`clearArticleCopyScope`；模块级 `globalAllowed`/`articleAllowed`/`articleScope`/`installed`。
- **实际逻辑**：`isCopyAllowed()=globalAllowed&&(!articleScope||articleAllowed)`；`apply()` 在需要拦截时以**捕获阶段**把 `selectstart`/`contextmenu`/`dragstart` 挂到 `document`，否则解绑；`onBlock` 放行 `INPUT`/`TEXTAREA`/`contentEditable`，`dragstart` 仅拦 `IMG`。
- **项目内依赖**：无。使用者 `site/Layout.vue:375`（watch `settings.allow_copy`）、`ArticleDetail.vue:733`、`:1235`（卸载清作用域）。
- **后端接口约定**：读 `/api/settings.allow_copy` 与文章 `allow_copy`（DB 默认 `true`，后台 `admin.js` 写）。
- **UI/交互要点**：无组件；纯事件层守卫，无 `user-select` 样式、无提示文案。
- **副作用与失败模式**：模块级单例，作用域靠手动清理；只覆盖三个事件。

### web/src/utils/bookmark.js（85 行）

- **职责**：本地文章收藏（无账号，上限 100）。
- **关键导出**：`getBookmarks`、`isBookmarked`、`addBookmark`、`removeBookmark`、`clearBookmarks`、`BOOKMARK_KEY`、`onBookmarksChange`。
- **实际逻辑**：`getBookmarks` 解析失败或非数组返 `[]`（不校验单条字段）；`isBookmarked` 按 `id` 严格比较；`addBookmark` 去重后 `unshift` 快照、写盘 `slice(0,100)`，**但 return 未截断的 list**；`removeBookmark` 过滤后写盘并返回新列表；`onBookmarksChange` 与 history 同构。
- **项目内依赖**：无。使用者 `ArticleDetail.vue`（按 `isBookmarked` 切按钮态）、`Bookmarks.vue`（`removeBookmark` 返回值直接赋给列表）。
- **后端接口约定**：无；字段形状对齐文章详情返回（含 `tags`）。
- **UI/交互要点**：无组件；跨标签页靠 `storage` 事件（当前页不触发，避免自激）。
- **副作用与失败模式**：隐私模式静默降级；脏数据会渲染出 `undefined` 链接。

### web/src/utils/download.js（33 行）

- **职责**：统一 `Blob` 下载（集中原本 10 处各写一遍的写法）。
- **关键导出**：`downloadBlob(blob, filename)`。
- **实际逻辑**：`createObjectURL` → 造隐藏 `a[download]` → 挂 body → `click()` → 立即移除 → `setTimeout(revokeObjectURL,10000)`，延迟释放以避开「click 后同步 revoke 导致读取落空」。
- **项目内依赖**：无。使用者 9 个后台管理页 + `ArticleDetail.vue:713`（导出 `.md`）。
- **后端接口约定**：无（只消费 axios 已取回的 `Blob`；导出接口本身仍走签名与票据）。
- **UI/交互要点**：无组件；提示由调用方 `ElMessage` 弹。
- **副作用与失败模式**：10s 定时器无取消句柄；`filename` 不净化；极老浏览器不支持 `download` 时会导航到 blob URL。

### web/src/utils/localDraft.js（51 行）

- **职责**：评论/留言草稿的读写与过期清理（防抖交给调用方）。
- **关键导出**：`saveDraft`、`loadDraft`、`clearDraft`；键由调用方传，值 `{content,at}`，TTL 24h。
- **实际逻辑**：内容 trim 后为空即 `removeItem`（不留空占位）；读时要求 `at` 未过期且 `content` 为非空字符串，否则删键返 `''`；解析异常分支单独再删一次键（注释记录了「清理语句走不到」的实测）。
- **项目内依赖**：无。使用者 `components/site/CommentSection.vue`、`views/site/Messages.vue`。
- **后端接口约定**：无；提交仍走评论/留言接口（签名 + 审核）。
- **UI/交互要点**：无组件；恢复时机与是否覆盖当前输入由宿主决定。
- **副作用与失败模式**：TTL 判断无下界，未来时间戳会让草稿永不过期；键无命名空间约定。

### web/src/utils/scrollLock.js（29 行）

- **职责**：可嵌套计数的 `body` 滚动锁（抽屉/TOC/灯箱/搜索弹层可同时持有）。
- **关键导出**：`lockBodyScroll`、`unlockBodyScroll`、`resetBodyScroll`；模块级 `locks`/`previous`。
- **实际逻辑**：首次加锁记下原 `overflow` 并置 `hidden`；计数归零才写回并清空 `previous`；`unlock` 为 0 时直接 return；`resetBodyScroll` 强制归零并清 `overflow`。
- **项目内依赖**：无。使用者 ImageLightbox、ShortcutHelp、SearchModal、`site/Layout.vue:325/592`、`ArticleDetail.vue:472/1234`。
- **后端接口约定**：无。
- **UI/交互要点**：只改 `body.style.overflow`，不加 `padding-right`/`scrollbar-gutter`，也没有 `position:fixed` 方案。
- **副作用与失败模式**：与 Element Plus 自带 `lock-scroll` 互不知情；`Layout` 的路由级 reset 会连带清掉仍合法持有的锁。

### web/src/utils/aiBridge.js（105 行）

- **职责**：后台 AI 面板 ↔ 当前编辑页的桥（上下文 / 选区 / 动作执行 / 单步撤销）。
- **关键导出**：`aiContext`、`aiSelection`（模块级 `ref`）、`setAiContext`、`setAiSelection`（选区截 4000 字）、`setAiApplier`、`pushAiUndo`（栈上限 12，返回自增 id）、`undoAiLast`、`aiUndoTopId`、`aiCanUndo`、`applyAiAction`、`resetAiBridge`。
- **实际逻辑**：`applyAiAction` 记调用前栈顶 id，调用 applier（可 async）后比较栈顶是否变化：变了返回 `{label,snapshotId}`，否则 `snapshotId=0`（如「保存草稿」不可撤销）；未注册返 `null`，抛错/拒绝也返 `null`。`undoAiLast` 取栈顶执行 `restore()`（失败只丢弃该条）并返回 label。
- **项目内依赖**：`vue` 的 `ref`/`computed`。使用者 `admin/ArticleEdit.vue`、`admin/AiPanel.vue`（`applyAiAction` 十余处、按 `aiUndoTopId()` 判定可撤销标签）。
- **后端接口约定**：本身不发请求；AI 调用走后台接口（JWT+签名），返回动作名（`insert_at_cursor`/`set_cover`/`set_tags`/`set_category` 等）由 applier 落地。
- **UI/交互要点**：无 Element Plus；面板用 `!!aiSelection.value?.text` 切换「润色选区」，用快照 id 与标签比对决定撤销按钮归属。
- **副作用与失败模式**：单例，卸载必须 `resetAiBridge()` 否则旧 applier/闭包残留；`snapshotSeq` 永不重置；applier 异常被完全吞掉。

## 观察

1. `web/src/utils/format.js:29-31` —— 已带 `Z`/`±hh:mm` 的输入仍无条件 `+offset*60*1000`，二次换算（+8 服务器上再早 8 小时）；条件分支只用来决定「补不补 Z」，没用来决定「加不加偏移」。
2. `web/src/utils/format.js:64` —— `.replace(/-/g,'-')` 是空操作；同时 `String(Date).slice(0,10)` 会得到 `Wed Jan 01`，而 `:57` 正好把原始 `time` 透传给 `formatDate`，`Date` 入参在 ≥30 天分支必然显示垃圾。
3. `web/src/utils/format.js:74-76` —— 注释仍写「中文按 300 字/分钟」，实际用 `wordStats.CN_WPM=350`，按注释核对数字必然对不上。
4. `web/src/utils/wordStats.js:89` —— `aggregateReading` 在 `web/src` 内零调用（只有测试用），且 `ceil(cn/350+en/250)` 与真正展示的 `server/src/routes/stats.js:123` `ceil(totalWords/350)` 不同口径：英文占比高的文章，详情页与首页「全站阅读时长」仍会对不上。
5. `web/src/utils/slugCheck.js:56-57` —— `slice(-200)` 依赖对象插入序，重新命中的旧 slug 不会后移而先被淘汰；纯数字 slug（`server/src/utils/slugify.js:7` 允许）还会被当整数键排到最前。
6. `web/src/utils/slugCheck.js:12` + `server/src/routes/articles.js:214-218` —— 探活用 `detail()`，而它会 +1 浏览量（同 IP+指纹 5 分钟去重）并计入反爬阅读配额，超限 429；一次进收藏页最多 20 个带签名+票据的串行请求。
7. `web/src/views/site/History.vue:100-121` 与 `web/src/views/site/Bookmarks.vue:70-96` —— `pruneStale` 两份逐字重复（连「只标记不删除」的长注释都一样），只抽了缓存层；`highlight.js:1-13` 批评的正是这类同缺陷副本。
8. `web/src/utils/bookmark.js:45-47` —— `save(list.slice(0,MAX))` 却 `return list`，可返 101 条；唯一读返回值的 `ArticleDetail.vue:554` 恰好忽略它，属潜伏 bug。
9. `web/src/utils/bookmark.js:9-16` 与 `web/src/utils/history.js:23` —— 同构模块读取策略不一致：足迹过滤无 `slug` 脏项，收藏不过滤，篡改 storage 后收藏页会渲染 `undefined` 链接、`key` 冲突。
10. `web/src/utils/markdown.js:300` —— 所有 h1 降级标题共用 `id="heading-demoted"`，正文两个 `# 标题` 即产生重复 id，锚点只命中第一个且 HTML 不合法。
11. `web/src/utils/markdown.js:259-270` 与 `:291-307` —— `extractToc` 只收 lexer 的 heading token（不进 `html` token），`addHeadingIds` 却对渲染后每个 `<h2-4>` 计数；正文写一处原生 `<h2>` 就让 TOC 整体错位一位，正是 `:196-199` 记录的回归同类。
12. `web/src/utils/markdown.js:104` 与 `ArticleDetail.vue:720`/`NoteDetail.vue:95`/`NoteEdit.vue:130`/`About.vue:72` 对比 `ArticleEdit.vue:408`/`Settings.vue:486`/`AskAi.vue:39`/`AiPanel.vue:31` —— 标题 id 与图片兜底靠调用方手动串 `addImgAttrs(addHeadingIds(...))`，预览与对话只调 `renderMarkdown`，同一份 Markdown 两套可访问性行为，且顺序约定只有注释没有测试。
13. `web/src/components/site/AskAi.vue:39`、`web/src/views/admin/AiPanel.vue:31` —— 模板表达式里直接调 `renderMarkdown(...)`，每次重渲染都重跑 `marked.parse` + `DOMPurify.sanitize`，流式输出时相当于每帧全文净化。
14. `web/src/utils/markdown.js:499-520` —— `initMarkdownInteractions` 不返回 disposer、也没有 `installed` 保护，HMR 或二次调用会让一次点击触发两次剪贴板写入与两套定时器。
15. `web/src/utils/copyGuard.js:16` —— 只拦 `selectstart`/`contextmenu`/`dragstart`；键盘选择（Shift+方向键、Ctrl+A）+ Ctrl+C 与 `copy`/`cut` 事件都不在路径上，「关掉复制」对键盘用户不成立，却被当作全站能力开关呈现。
16. `web/src/utils/scrollLock.js:9-11` —— 只改 `overflow`、不补滚动条宽度，桌面端开抽屉时正文横向抖动；与 Element Plus 的 `lock-scroll` 各管一份 `body.style.overflow`，谁后解锁谁生效。
17. `web/src/utils/readingPrefs.js:78-93` 与 `ArticleDetail.vue:177-200` —— `step*` 到边界返回原值的本意是让调用方提示/禁用，宿主只加 `dim` 类：不 `disabled`、无 `aria-disabled`、无播报，连点上界时读屏与键盘用户毫无反馈。
18. `web/src/utils/pageMeta.js:40` 与 `home/Home.vue:200-204`、`Notes.vue:101-106`、`NoteDetail.vue:165-170` —— `siteOrigin` 只认 `site_url`/`domain`，服务端的 `home_site_url` 无人使用；主页三页干脆只传 `{settings:{site_name}}`，代价是后台 `og_image` 在主页域永不生效。
19. `web/src/utils/pageMeta.js:122` 与 `ArticleDetail.vue:844` —— 默认分享图一处 `.png`、一处 `.webp`，`index.html` 又是 `.webp`；`:120-121` 刚写完「两处各写一个，迟早一边改另一边忘」，这里是第三份。
20. `web/src/utils/pageMeta.js:116` 与 `views/home/NoteDetail.vue:167` —— `description` 直接截 300 字符不剥 Markdown，手记把 `content` 原文塞入，分享卡片会带 `##`、`**`、图片语法。
21. `web/src/utils/localDraft.js:30` —— TTL 只有上界没有下界，未来时间戳（时钟回拨、手改 storage）会让草稿永不过期，与「24 小时后清理」相反。
22. `web/src/utils/highlight.js:19` —— `escHtml` 导出但全项目零引用（内部自用），是 dead export；`:29-40` 对单字符关键词无命中上限。

## 小结

1. 这 15 个模块是前端「内容层」：`markdown` 管渲染与可访问性，`highlight`/`wordStats`/`readingPrefs` 管呈现口径，`pageMeta` 管 SEO；`bookmark`/`history`/`localDraft`/`copyGuard`/`scrollLock`/`aiBridge` 是纯本地状态与交互守卫，其余四个是横切工具。
2. 边界清晰：没有一个模块直接发请求。后端只通过 `/settings` 下发的字段与调用方自己的 API（`slugCheck` 借用 `articleApi.detail`）出现；签名、票据、正文解密全沉在 `api/index.js`，所以这里的失败模式是「本地存储坏值」与「DOM 副作用」，不是网络。
3. 单例状态是这层的结构性特征：`format.serverTzOffset`、`copyGuard` 三个布尔、`scrollLock.locks`、`aiBridge` 上下文与撤销栈、`marked`/`DOMPurify` 全局配置，全靠调用方挂载/卸载时手动设置与复位，漏一处即跨页残留。
4. 口径统一只做了一半：字数与单篇阅读时长已收敛到 `wordStats`，但首页统计取服务端单一 350 口径，`aggregateReading` 成了只有测试在用的死实现；日期注释停留在 300，默认分享图仍有三份。
5. 可访问性投入真实且细节充分（表头 `scope`、任务项 `aria-label`、复制 `role=status`、标题 `tabindex=-1`、图片兜底），但覆盖面被 `renderMarkdown` 与两处补丁的拆分割裂，预览/对话/关于页拿不到同等处理。
6. 真正的风险不在注入（净化、分段转义、`rel` 加固都到位），而在「客户端承诺」：复制守卫可被键盘绕过、`slugCheck` 的探活会真实消耗反爬配额并 +1 浏览量、`scrollLock` 与 Element Plus 抢同一份 `body.style`。
