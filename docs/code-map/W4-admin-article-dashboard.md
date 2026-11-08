# W4 · 后台：文章编辑 / 文章列表 / 概览 / AI 面板

> 分区范围：`web/src/views/admin/` 下 4 个视图。全部逐行读完（1220 / 669 / 963 / 1015 行，无跳读）。
> 后台所有请求统一走「秘钥路径 + 三重票据」：`/api/<adminKey>/...`，请求头 `Authorization: Bearer <JWT>`、`X-Pass: <PoW 票据>`、`X-Fp: <指纹>`、`X-Timestamp`、`X-Nonce`、`X-Sig`；`X-Sig = HMAC-SHA256(key=ticket, "METHOD|path|ts|sha256(JSON body)|jti|nonce")`，`path` 为**剥掉 `/api` 前缀后**的路径（`web/src/utils/signedFetch.js:42-68`、`web/src/api/index.js:18-91`）。响应统一信封 `{code, message, data}`，axios 拦截器把 `data` 直接返回并在 `content_enc` 时用票据解密正文。

---

### web/src/views/admin/ArticleEdit.vue（1220 行）

**职责**：单页写作台——新建/编辑文章的表单、Markdown 分栏编辑与预览、封面/标签/分类/发布设置、本地草稿自动保存，并作为 AI 面板的「可被改写的目标页面」注册 applier。

**结构 / 状态 / props**：无 props、无 emits，靠 `route.params.id` 派生 `editingId`，同一组件复用 `articles/new` 与 `articles/:id/edit` 两个路由（Layout 用 `:key="route.path"` 强制重建，避免换篇复用旧实例）。`form` 是单个 `ref` 对象（title/slug/category_id/tags/cover/summary/content/is_top/allow_comment/allow_copy/status/published_at）；另有 `mode`(write|preview)、`categories`、`allTags`、`uploading|savingDraft|publishing`、`articleStatus`（服务端真实状态）、`dirty`、`autosavedAt`、`coverBroken`。计算属性：`editingId`、`previewHtml`、`wordCount`、`readingMinutes`。

**实际逻辑**（非名字复述）：
- 载入：`categoryApi.list()` / `tagApi.list()` 失败不阻塞；有 `editingId` 时 `articleApi.adminDetail(id)`，失败或 `content_decrypt_failed` 直接 `return`（避免把空表单误当"内容丢了"），成功后 `assignForm()` 回填并 `clearDraft()`；新文章走 `restoreDraft()` 读 sessionStorage 并弹确认。
- `assignForm()` 用 `suppressWatch` + `await nextTick()` 屏蔽「程序赋值 → 标记已修改」的误判，是 `watch(form, …, deep)` 的必要补丁。
- 自动保存：任意表单变更 → `scheduleAutosave()` 立即 `dirty=true`，2s 防抖后 `writeSessionValue('xalor_draft_<id|new>')`；键按文章分桶，卸载时 `clearTimeout` 并注明「延迟求值的 DRAFT_KEY 会读到新 editingId」这一真实坑。
- Markdown 工具栏：`mdTools` 11 项，`insertMd()` 通过 `document.querySelector('.md-editor textarea')` 取原生 textarea 的 `selectionStart/End`，改 `form.content` 后在 `requestAnimationFrame` 里回填选区。
- 图片三入口：工具栏选择文件、`Ctrl+V` 粘贴截图（`onEditorPaste`，命中图片即 `preventDefault`）、`el-upload` 的 `:http-request` 上传封面；三者都走 `uploadApi.upload(file)` → `POST /upload`（FormData），返回 `{url, filename}`，正文用 `![图片](url)` 插入到 `selectionStart`。
- 保存：`save(data)` 校验标题/正文非空 → 组 payload（`slug`、`published_at` 空值转 `undefined`）→ 有 id 走 `PUT /articles/:id`，否则 `POST /articles` → `clearDraft()`、提示、跳回列表。`publish()` 在 `articleStatus !== 'published'` 时弹确认，AI 代发布带 `skipConfirm`。
- AI 桥接：`watch` 用「轻量签名」把 `type:'article'` 上下文（content 截断 8000 字）推给 `setAiContext`；`setAiApplier` 实现 13 个动作（set_title/set_content/append_content/replace_selection/insert_at_cursor/set_summary/set_tags/set_category/set_cover/set_options/save_draft/publish/set_slug），改内容前先 `snap()` 压撤销快照；`replace_selection` 在偏移失效时退化为 `indexOf` 查找。
- 快捷键：window 级 `keydown` → Ctrl/Cmd+S 存草稿、Ctrl/Cmd+Enter 发布；`beforeunload` 与 `onBeforeRouteLeave` 双守卫都读 `dirty`。

**项目内依赖**：`@/components/ui/XIcon.vue`；`@/api`（articleApi/categoryApi/tagApi/uploadApi）；`@/utils/markdown`（`renderMarkdown`，内部 marked + hljs + DOMPurify 净化，与前台详情页同一渲染管线）；`@/utils/wordStats`（`countWords`/`readingMinutes`）；`@/utils/adminPath`（`adminHref`）；`@/utils/aiBridge`（`setAiContext/setAiApplier/setAiSelection/pushAiUndo/resetAiBridge/aiSelection`）；`@/utils/secureStorage`（`migrateLegacyPrefix/readSessionValue/writeSessionValue/removeStoredValue`）；`vue-router` 的 `useRoute/useRouter/onBeforeRouteLeave`；`element-plus` 的 `ElMessage/ElMessageBox`。

**接口约定**：`GET /categories`、`GET /tags`（公开读接口，仍带签名头）；`GET /articles/admin/:id` → `data` 含 `content`(AES-GCM 密文)、`content_enc`、`content_key`、`tags`(名称数组)，拦截器解密后置 `content_decrypt_failed`；`POST /articles` / `PUT /articles/:id` 接受 `{title, slug, category_id, tags[], cover, summary, content, is_top, allow_comment, allow_copy, status, published_at}`，服务端做 cleanLine/cleanMarkdown/slugify/分类存在性校验，`status` 仅 `draft|published`；`POST /upload`。

**UI / 交互**：Element Plus 用了 `el-button`(loading)、`el-input`(textarea)、`el-select`(multiple/filterable/allow-create)、`el-date-picker`(datetime)、`el-switch`、`el-upload`；自研的是吸顶玻璃顶栏、`编辑/预览` 胶囊 tab、图标工具栏、字数统计、封面裂图提示（`@error` 置 `coverBroken`）、右栏 sticky 设置面板；响应式断点 1180px 合单栏、720px 收窄顶栏并压缩编辑器高度。

**副作用与失败模式**：注册 3 个全局监听（beforeunload/keydown/selectionchange）并在卸载时移除；写 sessionStorage；改 `document.title`。失败路径：分类接口失败只 toast 不阻塞；文章加载失败/解密失败直接 return，页面停在空壳；上传失败静默（依赖拦截器 toast）；保存失败返回 `false` 但 `publish()` 已把 `publishing` 置真。

---

### web/src/views/admin/ArticleManage.vue（669 行）

**职责**：后台文章列表——筛选/排序/分页、行内发布·置顶·复制·删除、多选批量操作、全量备份导出与分片导入。

**结构 / 状态**：`list/loading/page/pageSize(10)/total/keyword/status('all')/categoryId/sortBy('latest')/categories`，批量侧 `selection/tableRef/batchActionLoading`，导入导出侧 `exporting/importing/importInput`，`duplicatingId` 单飞锁，`isMobile` 来自 `useIsMobile()`（820px 断点、单例 matchMedia）。

**实际逻辑**：
- `load(p)` 组装 `{page, pageSize, keyword, status, category_id, sort}` 调 `articleApi.adminList`，把 `res.list` / `res.pagination.total` 写回并回写 `page`；无空值兜底。
- 导出：`ensurePass()` → `getCachedAdminPath()` → `signedFetch('/api/<key>/articles/admin/export')`（原生 fetch 绕开 JSON 拦截器）→ `blob()` → 从 `Content-Disposition` 正则取文件名 → `downloadBlob`。
- 导入：`.json` 扩展名 → `JSON.parse(file.text())` → 校验 `meta.type === 'articles-backup'` 且 `articles` 为数组 → 二次确认（文案写明"按 slug 合并、已存在跳过"）→ 每 300 篇一片调 `articleApi.importBackup(slice)`，累加 `imported/skipped` 后 `load(1)`。
- 行内：`publish` 只发 `{status:'published'}`；`toggleTop` 复用 `batchUpdate([id], 'top'|'untop')` 并就地翻转 `row.is_top`；`duplicate` 后直接跳新草稿的编辑页；`remove` 在"删的是本页最后一篇且非首页"时回退一页。
- 批量：`publish`（本地先过滤 draft）/`add-tag`/`set-category`/`set-category+0`（移出分类）/`top`/`untop`/`batchDelete`，动作名与后端 `action` 白名单一一对应；`set-category` 用 `ElMessageBox.prompt` 让管理员手打分类名，再在前端 `toLowerCase()` 里匹配 `categories`，匹配不到即中止。

**项目内依赖**：`@/components/ui/XIcon.vue`；`@/api`（articleApi/categoryApi）；`@/utils/format`（`formatDate`）；`@/utils/adminPath`（`adminHref`、`getCachedAdminPath`，分成两条 import）；`@/utils/pass`（`ensurePass`）；`@/utils/signedFetch`；`@/composables/useMedia`（`useIsMobile`）；`@/utils/download`（`downloadBlob`）；`@element-plus/icons-vue`（`Search`）。

**接口约定**：`GET /articles/admin/list?page&pageSize&keyword&status&category_id&sort` → `{list[], pagination:{page,pageSize,total}}`，行含 `id/title/slug/cover/status/is_top/views/likes/published_at/created_at/updated_at/category_name/tags[]/comment_count`（`content` 显式置 `undefined`，列表不带正文）。`GET /articles/admin/export` 返回 JSON 附件 `articles-backup-YYYY-MM-DD.json`，结构 `{meta:{type:'articles-backup',version:2,count},articles:[…]}`。`POST /articles/admin/import` 收 `{items:[…]}`，单片上限 300，按 slug 查重、分类/标签按名 find-or-create。`POST /articles/batch-update` 收 `{ids,action,…extra}`（`publish|draft|top|untop|set-category{categoryId}|add-tag{tagName}`，ids ≤ 500）。另有 `POST /articles/batch-delete`、`POST /articles/:id/duplicate`、`DELETE /articles/:id`。

**UI / 交互**：`el-input`(prefix-icon/clearable)、4 个 `el-select`、`el-table`（stripe、`v-loading` 且只在空列表时显示、`type="selection"`、封面缩略图用 `background-image` 并 hover 放大、`is_top`/`draft` 用 `el-tag`、更新时间晚于发布时间标黄 `upd-stale`、操作列 `fixed="right"` 且窄屏解固定）、`el-pagination`（固定 10 条、无 page-size 切换、无跳页）、条件渲染的批量操作条。移动端断点只在 CSS 里用 700px。

**副作用与失败模式**：文件选择器 `input` 读取本地备份并整份 `JSON.parse`（无体积上限，几百 MB 备份会卡死主线程）；导出用原生 fetch 不走统一错误处理；导入分片串行，任一分片失败即中断且已完成分片不回滚、界面不显示已完成数量。

---

### web/src/views/admin/Dashboard.vue（963 行）

**职责**：后台首页数据总览——统计卡、待审队列、安全概览、PV/UV 趋势、分类分布、互动双柱、热门文章 TOP5、最新动态时间线。

**结构 / 状态**：`dashboard` 单 ref 装整个 `/stats/dashboard` 响应（trend/by_category/interact_trend/pending/counts/total_articles/top_articles/recent_comments/recent_messages/recent_articles），`security` 单独装 `/security` 的 `{event_total, banned[]}`，`rangeDays`（7/14/30，localStorage `xalor_dash_range` 记忆）、`refreshing` 单飞锁。派生：`pending/trend/byCategory/topArticles/trendEmpty/interactTrend/interactEmpty/maxInteract/maxPv/maxCount/trendPoints/pvLine/uvLine/trendLabels/today/counts/statCards/recentItems`。

**实际逻辑**：
- `loadAll()`：`await getAdminPath()`（确保秘钥路径就绪）→ `statsApi.dashboard(days)` → `securityApi.overview()` → 动态 `import('@/stores/admin')` 并 `fetchPending()` 同步侧栏红点。整体一个 try/catch，任一步失败后续步骤跳过。
- 图表全部手算：`TW=320/TH=150` 固定坐标系，`trendPoints` 按索引均分 x、按 `maxPv` 归一到 y，`pvLine/uvLine` 拼 `polyline@points` 字符串；`trendLabels` 从 N 天里抽 7 个下标（首/尾 + 等步长 round）。
- 互动双柱用 CSS 百分比高度（`intBarHeight` 以 `maxInteract` 归一，非零最小 4%）。
- `statCards` 7 张（文章总数/草稿/总浏览量/今日 PV/今日 UV/评论/留言），`formatNum` 做 万/亿 缩写；「今日 PV/UV」取 `trend` 末位元素。
- `recentItems` 把评论/留言/文章三类合并，按 `new Date(created_at)` 倒序取前 10；文章条目链到前台 `/article/<slug>` 并 `target=_blank`，评论/留言条目链到对应管理页。

**项目内依赖**：`@/components/ui/XIcon.vue`；`@/api`（statsApi/securityApi）；`@/utils/adminPath`（`adminHref`、`getAdminPath`）；`@/utils/format`（`timeAgo`）；运行时动态 `@/stores/admin`。

**接口约定**：`GET /stats/dashboard?days=7|14|30`（服务端夹在 7..90，`admin.js:1479`）→ `data` 含 `trend[{day,pv,uv}]`（按天补零、升序，末位=今天）、`by_category[{name,count}]`（含"未分类"）、`interact_trend[{day,comments,messages}]`（同样按 days 补零）、`pending{comments,links,messages}`、`counts{drafts,views,comments,messages}`、`total_articles`、`today_visit{pv,uv}`、`top_articles[]`、`recent_comments/messages/articles[]`。`GET /security` → `{banned[],events[],event_total,type_counts,pass_valid,server_time}`（`event_total` 实为**近 7 天** SEC-EVENT 计数，`middleware/ipGuard.js:443-497`）。

**UI / 交互**：`component :is` 动态把有 `link` 的统计卡渲染成 `router-link`（无 link 的渲染 `div`）；`--sc` 自定义属性给每张卡上色；`router-link` 悬浮箭头渐显；SVG 趋势图带 `role="img" aria-label` 与每点 `<title>` 提示；范围切换三按钮无 `aria-pressed`；`grid` 自适应 + 980px 折单列。

**副作用与失败模式**：写 localStorage（范围记忆）；`onMounted(loadAll)`，无轮询、无 keep-alive 刷新；`securityApi` 失败被同一 catch 吞掉，`security` 保持初始 `{event_total:0,banned:[]}`——界面照常渲染"0 已拦截 / 稳定"。

---

### web/src/views/admin/AiPanel.vue（1015 行）

**职责**：常驻后台右侧的 AI 写作助手抽屉——SSE 流式对话、工具调用回执、把模型动作落到当前页面表单、图片搜索/转存、撤销。

**结构 / 状态**：`props.open`（布尔，控制 `transform: translateX` 与 `visibility`）+ `emit('close')`；`messages[]`（user / assistant，assistant 上挂 `content/applied[]/images/articleList/articleRead/webResults/tool_calls/tool_results/streaming`）、`draft`、`pending`、`aiReady(null|bool)`、`modelName`、`listEl`、`controller`(AbortController)、`readyTimer`；`MAX_ROUNDS=4`。`quickActions` 依 `aiContext.type === 'article'` 出现 6 个芯片（润色所选/续写/生成标题/摘要/标签/搜索封面），"润色所选"以 `aiSelection.text` 非空为启用条件。

**实际逻辑**：
- `checkReady()`：`ensurePass()` → `GET /ai/status` → `data.ready/model`；异常分支挂 6s 间隔、最多 5 次的重试定时器。
- 一次用户指令 = `send()` → `runTurn()` 最多 4 轮：每轮 `streamOnce()` 打开 `POST /ai/chat`（body 为 `buildHistory()` 全量历史 + `currentContext()`），逐块解析 `data: {...}\n\n`；`type:'text'` 追加正文，`type:'action'` 立刻 `handleTool()` 执行并把 `tool_calls`/`role:'tool'` 结果压进同一气泡；`type:'error'` 终止本轮。只要本轮产生过 `tool_results` 就继续下一轮（模型看着结果接着说话）。
- `handleTool()` 的读类工具直接打后台接口：`/ai/images?q=`（Wikimedia 搜图）、`/ai/web-search?q=`（校验 `code===0`）、`/ai/articles?keyword=&limit=10`、`/ai/article?slug=`、`/ai/comments`、`/ai/messages`、`/ai/save-image`(POST `{url}`)；写类工具（改标题/正文/摘要/标签/分类/封面/快捷键/草稿/发布/插入链接）统一走 `applyAiAction(name,args)` 交给页面 applier，成功则把 `{label,snapshotId}` 记到气泡的 `applied[]`。
- 撤销：`canUndoTag()` 只让 `snapshotId === aiUndoTopId()` 的那个标签显示撤销钮（防跨栈错位），`undoOne()` 调 `undoAiLast()` 并把标签置 `undone`。
- 图片：`useAsCover()` 先把缩略图 `POST /ai/save-image` 转存到 `/uploads/ai/…` 再 `set_cover`；`insertImage()` 直接把远程 URL 以 Markdown 插入光标处。

**项目内依赖**：`@/components/ui/XIcon.vue`；`@/utils/signedFetch`；`@/utils/pass`（`ensurePass`）；`@/utils/markdown`（`renderMarkdown`）；`@/utils/aiBridge`（`aiContext/aiSelection/applyAiAction/undoAiLast/aiUndoTopId`）；`@/utils/adminPath`（`getCachedAdminPath/adminHref`）；`element-plus`（`ElMessage`）。由 `views/admin/Layout.vue:111` 以 `<AiPanel :open="aiOpen" @close="aiOpen = false" />` 挂载。

**接口约定**：`GET /ai/status` → `{ready, model}`；`POST /ai/chat`（`Accept: text/event-stream`）→ SSE，帧类型 `text|action|usage|error|done`，`action` 帧带 `{id,name,args,raw}`；`GET /ai/images?q=` → `{images:[{url,thumb,title,license,creator}]}`；`GET /ai/web-search?q=` → 失败时 `code!==0` 且带 message（受站点设置 `websearch_enabled` + Key 双门控）；`POST /ai/save-image` → `{path:'/uploads/ai/x.png'}`，服务端只允许 https、拒绝 IP 字面量与跳转（SSRF 防护）；`/ai/articles`、`/ai/article`、`/ai/comments`、`/ai/messages` 均为只读检索，`article` 返回正文前 8000 字。

**UI / 交互**：固定右侧抽屉（`width: min(440px, 94vw)`、`z-index: var(--z-modal)`、玻璃底 + `backdrop-filter`，收起时靠 `visibility: hidden` 顺带消掉阴影残边）；未配置模型时占位卡 + 直达设置页；消息区 Markdown 渲染（`v-html` 经 DOMPurify）；图片卡片 2 列网格、`loading="lazy"` + `referrerpolicy="no-referrer"`；站内文章列表可点选自动填入输入框；动作标签为胶囊 + 撤销小圆钮；输入区 `Enter` 发送（`@keydown.enter.exact.prevent`），生成中变"停止"按钮。

**副作用与失败模式**：非 2xx（含网关 403）被渲染成气泡文案；`stop()` 直接 `abort()`；`scrollToEnd()` 每次 `nextTick` 后强拉到底，用户手动上翻时会被拽回；卸载只清 `readyTimer`，不动 `messages`。

---

## 观察

- `web/src/views/admin/ArticleEdit.vue:310`：`form.status` 初始化后再也没被写过（载入时只写 `articleStatus`），而 `:642` 又把它当上下文发给 AI——编辑一篇**已发布**文章时上报的 `status` 恒为 `draft`。
- `web/src/views/admin/ArticleEdit.vue:441,446`：字数用 `raw: true`（保留 Markdown 与代码块），阅读分钟同样 `raw: true`，而详情页 `readingTime()`（`utils/format.js:84`）走默认的 `stripMarkdown`；`:443-446` 的注释却断言"编辑器说 10 分钟、详情页说 9 分钟是 bug"——注释与代码正相反。
- `web/src/views/admin/ArticleEdit.vue:349`：`writeSessionValue()` 的返回值被丢弃（`secureStorage.js:60-69` 在配额超限/隐私模式下返回 `false` 不抛错），`autosavedAt` 照旧显示"已自动保存"——用户会以为稿子已落盘。
- `web/src/views/admin/ArticleEdit.vue:479,488`：`slug: form.slug || undefined`、`published_at: … || undefined`，清空输入后字段变 `undefined` 被 JSON 丢弃，后端 `admin.js:274,287` 只在非空时改——因此"清空 slug"不会重新生成（占位文案"留空自动生成"只在新建时成立），也清不掉已设的发布时间。
- `web/src/views/admin/ArticleEdit.vue:91`：`el-date-picker` 用 `v-if` 挂条件，草稿（无 `published_at`）根本看不到发布时间输入，而后端支持手动排期（`admin.js:286-290`）——想定时发布必须先"发布"再改时间。
- `web/src/views/admin/ArticleEdit.vue:781-789`：window 级快捷键不判断 `e.target`，焦点在标题框、日期输入、AI 面板 textarea 时按 Ctrl+S / Ctrl+Enter 都会触发存草稿/发布（后者还会弹确认）。
- `web/src/views/admin/ArticleEdit.vue:472-475` + `:765` + `AiPanel.vue:336`：标题/正文为空时 `save()` 返回 `false`，`publish()` 把它当"页面不支持"一并 `null` 返回，AI 侧因此提示"当前页面不支持这个操作"，把校验失败误报成能力缺失。
- `web/src/views/admin/ArticleEdit.vue:626-636`：上下文签名用 `[title, summary, category_id, cover, slug, status, tags.join(','), content.length].join('')`，无分隔符且正文只取长度——字段边界变化可能拼出同一个字符串，命中时 `setAiContext` 不刷新，模型继续用旧正文。
- `web/src/views/admin/ArticleEdit.vue:6,43-44,138`：返回键、封面删除键是可聚焦的纯图标 `button`，只有 `title` 没有 `aria-label`；`编辑/预览` 用 button + `.active` 类表达状态，没有 `role="tablist"/aria-selected"`——键盘与读屏都读不出当前模式。
- `web/src/views/admin/ArticleEdit.vue:855-863`（配合 `:1201`）：`.ed-kbd` 的样式与窄屏隐藏规则都在，但模板里没有任何 `ed-kbd` 元素——死 CSS。
- `web/src/views/admin/ArticleEdit.vue:226`：工具栏插入写死 `document.querySelector('.md-editor textarea')`；预览模式下该 textarea 只是 `v-show` 隐藏仍在 DOM 里，插入会成功但用户在预览区看不到任何变化。
- `web/src/views/admin/ArticleEdit.vue:183`：`watchEffect` 被 import 但从未调用（只出现在 `:318` 注释里）——无效导入。
- `web/src/views/admin/ArticleEdit.vue:326-333`：`document.title` 只写不复位，卸载后标题停在"… · 管理后台"，直到其它页面覆盖。
- `web/src/views/admin/ArticleManage.vue:21,172`：「未分类」选项 `value=0`，但请求参数是 `category_id: categoryId.value || undefined`，`0` 被折叠成 `undefined` → 选"未分类"实际返回全部文章（后端 `admin.js:51` 是支持 `'0'` 的）。
- `web/src/views/admin/ArticleManage.vue:366,383,400,431,457,485,512`：批量动作只 `selection.value = []`，没有像 `clearSelection()`（`:350-353`，其注释已明确记录"只清副本复选框仍勾着"）那样调 `tableRef.clearSelection()`；`load()` 失败或表格未按 `row-key` 重建时会重现批量栏消失而复选框仍勾选的矛盾态。
- `web/src/views/admin/ArticleManage.vue:653`：CSS 断点是 700px，而列裁剪依据 `useIsMobile()` 是 820px（`composables/useMedia.js:4` 还注明"与各视图媒体查询保持一致"）——701~820px 之间列已按窄屏砍掉，工具栏仍是横排，出现半截响应式。
- `web/src/views/admin/ArticleManage.vue:175-176`：`res.list` / `res.pagination.total` 无兜底，响应结构异常时异常在 `try/finally` 内抛出后只留 unhandled rejection，表格静默停在旧数据。
- `web/src/views/admin/ArticleManage.vue:197-199`：导出只 `await ensurePass()` 再 `getCachedAdminPath()`，没有 `await getAdminPath()`（`Dashboard.vue:304` 就有）；缓存为空时 URL 退化成 `/api//articles/…`，而后台路径未加载时 `adminGet` 会直接 reject（`api/index.js:236-239`）——三个兄弟视图对这一前置条件的假设不一致。
- `web/src/views/admin/ArticleManage.vue:238`：只校验 `meta.type` 与 `articles` 数组，`meta.version`（服务端写的是 2）无人读取；老版本备份会被无差别喂给 v2 导入器。
- `web/src/views/admin/ArticleManage.vue:261-266`：导入按 300 篇串行分片，中途失败时已完成分片已入库却既不回滚也不汇报进度，`imported/skipped` 就地丢弃，用户只能靠重新导入（靠 slug 查重兜底）。
- `web/src/views/admin/ArticleManage.vue:143-144`：同一个 `@/utils/adminPath` 被写成两条 import 语句——冗余。
- `web/src/views/admin/Dashboard.vue:299-316`：`loadAll` 一个 catch 吞掉全部错误，`securityApi.overview()` 失败时 `security` 保持初值，页面依旧渲染"已拦截 0 / 封禁 0 / 防护状态 稳定"——把取数失败伪装成健康状态（`:76` 的第三张卡尤其危险）。
- `web/src/views/admin/Dashboard.vue:76`：`security.event_total ? '实时' : '稳定'` 里 `event_total` 是**近 7 天累计**（`middleware/ipGuard.js:443-497`），只要历史上被扫过一次就永远显示"实时"，与"当前防护状态"无关。
- `web/src/views/admin/Dashboard.vue:257`：今天 PV/UV 从 `trend` 末位推导，忽略服务端专为此准备的 `today_visit` 字段（`admin.js:1579`）——两条口径目前靠"补零后末位必为今天"隐式对齐，后端一改补零顺序就会错。
- `web/src/views/admin/Dashboard.vue:132,211`：注释写"互动趋势：近 14 天"，但 `interact_trend` 随 7/14/30 一起变（`admin.js:1555`），卡片标题也没标天数——注释与运行行为不一致。
- `web/src/views/admin/Dashboard.vue:271,275-276`：草稿/评论/留言三张统计卡的链接不带任何筛选参数，`ArticleManage.vue` 也没引入 `useRoute` 读 query——点"草稿 12"落到全量列表，卡的语义断在半路。
- `web/src/views/admin/Dashboard.vue:108-110,245-255`：日期标签只取 7 个下标生成文本，却用 `justify-content: space-between` 等距铺开，而数据点 x 是按索引线性的——天数 ≠7 时中间标签与圆点不对齐。
- `web/src/views/admin/AiPanel.vue:99`：`XIcon name="RotateCcw"` 未在 `components/ui/XIcon.vue:12-45` 的显式映射里，组件对未知名字静默回退 `Activity`（`:52-54`）——撤销钮显示成心电图，且无任何告警。
- `web/src/views/admin/AiPanel.vue:219-229`：`signedFetch` 对 403/500 **不抛错**，`res.json()` 拿到 `code:1` 后 `d = {}` → `aiReady=false`，直接落成"尚未配置模型"；而重试定时器只挂在 `catch` 分支，响应体失败永不重试——闸门/票据问题被伪装成"没配模型"。
- `web/src/views/admin/AiPanel.vue:340`：`JSON.stringify(result).slice(0, 8000)` 直接按字符截断，`/ai/article` 返回的 8000 字正文 + 包装后必然被切，模型收到的是**半截非法 JSON**。
- `web/src/views/admin/AiPanel.vue:507-513`：`defineExpose({ reset })` 没有任何调用方（`Layout.vue:111` 挂载时没有 `ref`，全仓 grep 无 `aiPanel` 引用）——切换文章后对话与 `tool_calls` 历史仍在，`buildHistory()`（`:254-269`）会把上一篇的正文/标题继续发给模型。
- `web/src/views/admin/AiPanel.vue:346`：只有 `checkReady` 调过 `ensurePass()`，`runTurn`/`handleTool` 都不再续票；票据在对话中途过期时，下一轮 SSE 或任一读工具直接 403，界面只显示"会话已失效，刷新页面后重试"。
- `web/src/views/admin/AiPanel.vue:473`：`insertImage` 插入的是远程原图 URL，与 `useAsCover`（`:449-469`，先 `save-image` 转存再写 `set_cover`）的策略相反——正文热链外站图片、可超 5MB，源站改链即成死图。
- `web/src/views/admin/AiPanel.vue:399-423`：`MAX_ROUNDS` 用尽后静默退出，若第 4 轮仍只有工具调用，气泡里只剩标签没有结论，用户不知道还有后续，也没有"继续"入口。
- `web/src/views/admin/AiPanel.vue:2-9,18,123-136`：抽屉无 `role="dialog"`/`aria-modal`，打开后不转移焦点、不响应 Esc，流式消息区无 `aria-live`——读屏用户既不知道面板开了，也听不到生成内容。
- `web/src/views/admin/AiPanel.vue:19-20,619-627`：`<div v-if="!messages.length" class="ai-empty"></div>` 是空容器，配对样式 `.ai-empty-tip` 全文件无使用者——空态实际是一片空白。

## 小结

1. **位置**：这 4 个文件是后台「内容生产 → 内容治理 → 数据回看 → AI 辅助」的主干。`ArticleEdit` 是唯一能写 `content/slug/category_id/tags` 的表单，`ArticleManage` 是唯一能批量改状态/置顶/分类/标签与整站备份的入口，两者共用 `/articles*` 与 `/articles/admin/*` 的后台秘钥路径接口；`Dashboard` 只读 `/stats/dashboard` 与 `/security`；`AiPanel` 挂在 `Layout` 上，是所有后台页共享的常驻浮层，它自身不改数据，必须靠页面注册的 `aiBridge` applier 落地。
2. **边界**：视图层严格不碰业务规则——标题/正文/摘要清洗、slug 唯一化、分类存在性、批量动作白名单、导入的 300 篇上限与 slug 白名单都在 `server/src/routes/admin.js`；前端只做"必填 + 长度"这类廉价校验，因此**任何绕过本页面的调用都不会被前端拦住**，前端提示不能当作服务端契约。
3. **安全模型**：本分区的所有请求依赖 `X-Pass` PoW 票据 + HMAC `X-Sig` + JWT + 秘钥路径四层，导出接口因需落盘走 `signedFetch` 重算签名而非 axios；AI 面板额外受 `/ai/status` 的"是否配置模型"与站点设置 `websearch_enabled` 门控。真正的内容安全边界在 `renderMarkdown` 的 DOMPurify 净化（编辑器预览与前台详情共用同一管线）与服务端 `safeCover`/`riskyImageSource` 的 SSRF 校验。
4. **状态一致性是这块最脆的地方**：`form.status` 与服务端 `articleStatus` 两套状态、`trend` 末位与服务端 `today_visit` 两套今日口径、`selection` 副本与 el-table 内部选中集两套选中态，都是"看起来一致、实际靠约定同步"的结构。
5. **错误可见性普遍不足**：三个视图都用"拦截器已弹过 toast"当兜底（`catch (e) { /* 拦截器已提示 */ }`），于是 `Dashboard` 的失败会渲染成健康态、`AiPanel` 的 403 会渲染成"未配置模型"、`ArticleManage` 的导入半途失败只剩一句通用提示——本分区没有一处把"失败"与"零值/空态"在 UI 上区分开。
6. **可维护性线索**：注释质量很高（记录了 TDZ、el-table 选中副本、SSRF 重定向、签名 body 二次序列化等真实坑），但存在"注释声称的保证与代码相反"（阅读时长口径）、"注释描述了未落地的修复"（批量后未 `clearSelection`）、"死代码/死样式/死 API"（`ed-kbd`、`ai-empty-tip`、`reset()`、`watchEffect`、`meta.version`）三类漂移，后续改动应以代码与运行时为准。
