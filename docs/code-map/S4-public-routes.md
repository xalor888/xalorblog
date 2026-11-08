# S4 · 公共 API 路由（server/src/routes/）

17 个文件逐个 read 至 EOF，标题行数与文件总行数一致。全部挂在 `app.js` 的 `api` 前缀下；除 `GATE_SKIP`（`server/src/app.js:270`：`/anti`、`/health`、`/rss.xml`、`/sitemap.xml`、`/robots.txt`、`/share/`、`/share-page`、`/home/summary`）外，读请求需 `x-pass` 票据，写请求另加 `X-Sig` + Referer + 时间戳。下文不再重复这一前提。

### server/src/routes/articles.js（436 行）

- 职责：博客文章的公开读面（列表/详情/相邻/相关/随机/归档）与点赞写接口。
- 路由行为：`GET /` 硬编码 `status='published'`（`?status=draft` 被忽略），支持 `category`（分类 slug）、`tag`（先反查 `article_tags`）、`keyword`（`escapeLike` 后 LIKE `title`/`summary`）、`sort=latest|hot|commented`；`commented` 额外 leftJoin `comments` 按 `COUNT(cm.id)` 排序，计数改用 `countDistinct('a.id')`、groupBy 只加在数据查询上。`/slug/:slug` 返回 `a.*` + 分类三列 + 标签 + 评论数，正文经 `encryptPayload(content, x-pass, slug)` 变 AES-GCM 密文（无票据则 `content:''`），并用 `noteArticleRead` 计刮取、`shouldCountView` 计浏览。`/neighbors/:id`、`/related/:id` 用 `COALESCE(published_at, created_at)` 统一时间轴；`/related` 三级回退（同分类→同标签→最新）凑 4 条。`/random` 按总数 1000 分档：小库 `RAND()`，大库随机 offset。`/archive` 取全部已发布文章在内存按 `YYYY-MM` 分组。`POST /:id/like` 经 `canLike` 后自增并回读。
- 依赖：`db`、`utils/response`、`utils/crypto`、`utils/sanitize`、`middleware/ipGuard`、`middleware/scrapeGuard`。
- 数据：`articles`(slug/title/summary/content/cover/is_top/views/likes/published_at/created_at/category_id/status)、`categories`、`tags`、`article_tags`、`comments`。内存 `likeGuard`（`ip:articleId`，10s，>5000 清到 4000）、`viewGuard`（`ip:fp:articleId`，5min，>10000 清到 8000）。导出 `canLike`/`LIKE_WINDOW`/`shouldCountView` 供 notes 与测试复用。
- 失败：catch 统一 500；参数非法 400、不存在 404、超频 429 并 `report(ip,'rate'|'spam')` 计信誉。两个 Map 为进程内状态。

### server/src/routes/auth.js（397 行）

- 职责：管理员登录、会话管理、改密、TOTP 2FA。
- 机制：`/login` 先强制 `x-fp` 为 64 位十六进制（否则 400），再用 `reserveLoginAttempt` 在**同一同步临界区**先 `checkLock` 后 `recordFail`，把 IP 键（`ipKeyGenerator(ip,56)`，IPv6 聚到 /56）与账号键（有 user 用 `user-id:<id>`，否则 `user-name:<NFKC 小写>`）各计一次，堵住 bcrypt 期 TOCTOU；用户不存在时对 `FAKE_HASH` 同成本比较防时序枚举；`MAX_FAILS=5`、`LOCK_MS=5min`、第 10 次起翻倍；账号锁定回 401 同形文案，IP 锁定回 429 带剩余秒。开 TOTP 后必须带 `totp_code`，`verifyCode` 配 `totpReplay`（`u<id>`→步数）防重放。成功则清两条记录并回 `is_default_pwd`。`/me`、`/sessions`（标 `current`）、`DELETE /sessions/:jti`（拒撤当前）、`/logout`、`/logout-all`（`exceptJti`）均走 `authRequired`。`PUT /password` 验旧密码 + `passwordPolicy`（按 UTF-8 字节 8–72，拒全数字/全字母/常见弱密码/含用户名）后，事务化改密并撤销全部会话。2FA：`/setup` 要当前密码、已启用时 409，只写 `totp_secret` 不动 `totp_enabled`；`/verify`、`/disable` 成功后事务化 `updateSecurityStateAndRevoke` 并回 `relogin_required`。
- 依赖：`db`、`middleware/auth`、`utils/sanitize`、`utils/totp`、`middleware/ipGuard`、`ipKeyGenerator`。
- 数据：`users`(id/username/password/nickname/avatar/role/totp_secret/totp_enabled)、`sessions`、`audit_logs`、`loginFails` Map。
- 失败：`logAuditEvent` 全程 fire-and-forget，审计缺失不可见；`updateSecurityStateAndRevoke` 在"一条会话都没撤销"时抛 `SESSION_REVOKE_FAILED` 使事务回滚，对外表现为 500。`router.securityTest` 挂在导出对象上供白盒测试。

### server/src/routes/comments.js（335 行）

- 职责：评论读取、发表、点赞，含评论树构建与 AI 审核落库。
- 路由行为：`/recent` 取最近 6 条 approved 且文章已发布的评论（正文截 60 字）。`/article/:articleId` 校验文章后取全部 approved，`buildCommentTree` 用 `parent_id` 建树，树高上限 `MAX_TREE_DEPTH=10`，超深或孤儿提为根；根按 `sort=asc|desc` 排、子节点保持时间正序；`is_admin` 由 `getAdminNicknames()` 命中判定。`POST /` 链为 `postLimiter(6/min)`→`honeypotCheck`→`formTokenRequired`→`requireAuthForReservedName`，随后 `antiSpam`（敏感词+链接数）、文章存在性与 `allow_comment`、parent 合法性与"最多两层楼中楼"归一化（祖父须同文章，否则降级顶层）、`cleanText/cleanLine/safeEmail/safeUrl` 清洗、同 IP 30 分钟内同内容查重（对清洗后的值查，注释解释过为何不能用原始输入）、管理员昵称保留、`moderateComment` 定 `status`，入库后写审计、异步发站长与被回复者通知（邮箱上下行隔离）。`POST /:id/like` 用独立 `commentLikeGuard`（10s/IP）后自增。
- 依赖：`utils/sanitize`、`middleware/antiBot`、`middleware/formToken`、`utils/datetime`、`utils/antiSpam`、`utils/notifyMail`、`utils/ownerBadge`、`middleware/ipGuard`、`middleware/auth`、`utils/settings`、`utils/aiModeration`、`middleware/audit`（后四者行内 require）。
- 数据：`comments`(article_id/parent_id/nickname/email/website/content/ip/status/ai_reason/likes/created_at)、`articles`、`settings.comment_moderation`。
- 失败：参数/内容非法 400、昵称占用 403、文章不存在 404、重复 429、点赞超频 429；AI 拒绝时**故意**回 200 且与正常提交同形（落 `status='rejected'`，前台只查 approved）；邮件 `.catch(()=>{})` 全吞。

### server/src/routes/feed.js（469 行）

- 职责：RSS / sitemap / robots，按 Host 在"主页域（手记）"与"博客域（文章）"间分派。
- 机制：`conditionalSend` 手算 sha1(body) 前 24 位作强 ETag，配 `max-age=30` 与 `res.append('Vary','Host')`（append 是为保住 gzip 的 `Accept-Encoding`）；`cached()` 是 30s 进程内缓存，键 `rss`/`rss:home`/`sitemap`/`sitemap:home`；`baseSiteUrl` 优先 `settings.site_url`/`home_site_url`，否则由 req 推导。博客 RSS 取 20 篇，出 `<category>`（标签）、`<enclosure>`+`<media:thumbnail>`（封面）、`content:encoded`（仅 `rss_full_content===true`，经 `mdToHtml`→`sanitizeRssHtml`→`demoteH1`），guid 用 `xalor-blog:post:<slug>`。主页 RSS 只出手记摘要（`noteSummary`），正文不进订阅源。sitemap 博客版出首页/归档/标签/关于/收藏/友链/留言 + 有已发布文章的分类（`whereExists`）+ 全部文章 `/share/:slug`；主页版出首页 + 手记列表。`robotsTxt` 两版都先 `Disallow: <apiPrefix>/` 再逐条 `Allow:`，并注释了"不要写 `/#/` 规则"的原因。
- 依赖：`db`、`config.apiPrefix`、`utils/settings`、`utils/markdownText`、`utils/siteHost`、`utils/notes`、`sanitize-html`。导出 `robotsTxt`/`sanitizeRssHtml`/`mdToHtml`。
- 数据：`articles`、`article_tags`、`tags`、`categories`、`notes`、`settings`(site_*/avatar/og_image/rss_full_content)。`feed.js:38` 的 `cache` 对象同时承载值与 `key+'At'` 时间戳。
- 失败：RSS/sitemap 异常回 500 纯文本并 `console.error`，不降级空 feed；`toRfc822` 遇非法时间回退"当前时间"。

### server/src/routes/share.js（314 行）

- 职责：给爬虫与搜索引擎提供"服务端可渲染、带完整 OG/JSON-LD"的真实 HTML：`/share/:slug` 与 `/share-page/:page?`。
- 机制：`conditionalSendHtml` 同款（sha1 ETag + `max-age=300` + `append Vary: Host`）。文章页区分两个 URL：`rawShareUrl`（`/#/article/<slug>`，给人，用于 meta refresh 与按钮）与 `rawSelfUrl`（`/api/share/<slug>`，给机器，用于 `og:url` 与 canonical），注释记录了曾混用导致 OG 自相矛盾。配图回退链 `cover→og_image→avatar→/og-image.png`，全绝对化。JSON-LD 用 `JSON.stringify` 后把 `<` 换 `\u003c` 防 `</script>` 截断。静态页用 `STATIC_PAGES` 白名单（首页/archive/tags/about/bookmarks/links/messages/articles/notes），canonical 带 `?category=`，该值经 `encodeURIComponent` 拼 URL、经 `esc` 拼 HTML。
- 依赖：`db`、`config.apiPrefix`、`utils/settings`、`utils/markdownText`、`crypto`。
- 数据：`articles`(title/content/summary/cover/published_at)、`categories.name`、`settings`(site_url/site_name/site_desc/avatar/og_image/author/nickname)。
- 失败：两条路由各自 catch → 500 文本；未命中回 404 完整 HTML + `noindex,nofollow`（刻意不带 ETag/缓存头）。

### server/src/routes/stats.js（270 行）

- 职责：PV/UV 访问统计与全站阅读统计（总字数、篇均、最长篇、累计分钟）。
- 机制：`/record` 用 `day:ip:fp` 的 sha256 前 32 位写 `visit_uv`，靠 `.onConflict(['day','h']).ignore()` 判新增 UV，且必须 `Number(inserted[0])>0` 而非数组长度（注释解释了 MySQL `INSERT IGNORE` 返回 `[0]` 的坑）；`visits` 用 `.onConflict('day').merge()` 原子自增；PV 有 10s/IP 闸；`uvSeen` 是"已计过"快路径，6h 清一次、超 20 万按最旧丢到 15 万；写完立刻清 `summaryCache`。`/reading` 读全部已发布文章正文，`plainText` 去 Markdown 噪音后按 CJK 逐字 + 拉丁词串计数（`CJK_PATTERN` 覆盖基本区/扩展A/兼容汉字，与前端 `wordStats.js` 同区间），总时长对总量一次性 `ceil(/350)`，60s 缓存，`invalidateReadingCache` 已接进 `admin.js` 的 8 处写路径。`/summary` 并发 4 查询（总 PV/UV、今日、文章数、评论数），60s 缓存。
- 依赖：`db`、`utils/response`、`utils/datetime`、`utils/markdownText`。导出 `buildReadingStats`/`countWords`/`WORDS_PER_MINUTE`/`READING_TTL`/`READING_FIELDS`。
- 数据：`visits`(day unique/pv/uv)、`visit_uv`(day,h unique)、`articles`(title/slug/content/status/published_at)。阈值 `350`、`60s`、`10s`、`6h`。
- 失败：catch → 500；`uvSeen`/`pvGuard`/两个 cache 均为进程内状态。

### server/src/routes/home.js（163 行）

- 职责：个人主页首屏摘要，全站唯一**有意免票**的读接口。
- 机制：`buildSummary` 是唯一组装点，逐字段白名单挑选（站点名/描述/头像/公告/icp/home_site_url、hero 四字段、`runningDays`、about 摘要、social、6 条友链、文章与手记计数、5 篇最近文章），从设计上杜绝"spread settings 带出 `ai_api_key`"。`parseSocialExtra` 把 JSON 降级为数组并二次校验 `^https?://`、截 label 30/url 300、上限 8 条。`runningDays` 校验 `YYYY-MM-DD`，非法回 2024-01-01，差值 ≤0 回 1。路由叠 `summaryLimiter(60/min)` + `antiBot`，超限 `report(ip,'rate','HOME-SUMMARY 高频读取')`。
- 依赖：`db`、`utils/response`、`utils/settings`、`utils/markdownText`、`middleware/antiBot`、`middleware/ipGuard`。导出 `buildSummary`/`parseSocialExtra`/`runningDays`/`SUMMARY_FIELDS`。
- 数据：`settings`(home_*/social_*/about_content/announcement/icp/avatar)、`links`(approved)、`articles`(published)、`notes`(published)。`LINKS_PREVIEW=6`、`POSTS_PREVIEW=5`、`ABOUT_EXCERPT_LEN=200`。
- 失败：无缓存，每次 4 条 SQL + `getAllSettings`；DB 异常回 500，主页壳整体空掉（无静态兜底）。

### server/src/routes/ai.js（252 行）

- 职责：读者就当前文章提问的 SSE 流式问答，本区唯一外呼大模型/搜索的接口。
- 机制：`askLimiter` 20 次/小时/IP + `inflight` 每 IP 并发 1；`buildSystemPrompt` 把正文截到 `MAX_ARTICLE_CHARS=8000`，并明确"工具查不到就说没有"；工具仅 `search_site_articles`（`escapeLike` + 5 条）与按 `websearch_enabled===true` 条件注入的 `search_web`。`trimHistory` 只留最近 `MAX_HISTORY=6` 条、单条截 1200 字。工具循环 `for round<=MAX_TOOL_ROUNDS(2)`，用**原始参数串** `t.raw` 回放 `assistant.tool_calls`，工具服务端执行后以 `tool` 角色回灌（截 4000 字），文本边收边 `send({type:'text'})`；`req.on('close')` 触发 `AbortController.abort()`。
- 依赖：`db`、`utils/aiClient`(streamChat/getAiConfig)、`utils/sanitize`、`utils/settings`、`utils/webSearch`（行内）。
- 数据：`articles`(slug/status/title/content)、`settings`(ai_*/websearch_*)。SSE 事件 `text`/`status`/`error`/`done`；`AI_NOT_CONFIGURED` → "本站还没开启 AI 问答"。
- 失败：SSE 头与 `inflight` 自增都在 try 之外，该段抛错会永久占住该 IP 的唯一并发槽；最后一轮若模型仍返 `tool_calls` 会被静默丢弃且无收尾回答；无心跳，长回答可能被反代空闲超时切断。

### server/src/routes/notes.js（139 行）

- 职责：手记时间线的列表/详情/点赞，防护规格与文章详情同级。
- 机制：列表只出 `noteSummary`（白名单在 `utils/notes.js`，绝不含 content），`is_pinned` 优先 + 发布时间倒序，`pageSize` 上限 20；详情以 `noteContentKey(id)='note:<id>'` 作命名空间，正文 `encryptPayload(content, x-pass, 'note:<id>')`，且**只对带 `x-pass` 的请求**走刮取窗；`parseId` 卡在 `1..4294967295`。点赞直接复用 `articles.js` 的 `canLike`，键加 `note:` 前缀与文章 id 空间隔离。
- 依赖：`db`、`utils/response`、`utils/crypto`、`middleware/ipGuard`、`middleware/scrapeGuard`、`utils/notes`、`./articles`。导出 `noteContentKey`。
- 数据：`notes`(content/images/excerpt/mood/location/likes/is_pinned/status/published_at/created_at/updated_at)。
- 失败：非法 400、不存在 404、超频 429，其余 500；详情用完整 `images` 覆盖列表的 `cover/image_count`（九宫格依赖）。

### server/src/routes/messages.js（142 行）

- 职责：留言板公开列表与提交。
- 机制：`GET /` 只取 approved，`pageSize` 上限 50，`is_admin` 同评论；`POST /` 链为 `postLimiter(6/min)`→`honeypotCheck`→`formTokenRequired`→`requireAuthForReservedName`，随后昵称保留、`antiSpam`、同 IP 30 分钟同内容查重、`moderateComment(...,{forceLlm:true,failClosed:true})`（与评论不同：留言全过 LLM，AI 未启用转 pending 而非直发），入库 + 审计 + 异步邮件（正文带 AI 判定结论）。
- 依赖：`utils/sanitize`、`middleware/antiBot`、`middleware/formToken`、`utils/datetime`、`utils/antiSpam`、`utils/ownerBadge`、`middleware/ipGuard`、`middleware/auth`、`utils/settings`、`utils/aiModeration`、`middleware/audit`、`utils/notifyMail`。
- 数据：`messages`(nickname/email/content/ip/status/ai_reason/reply/replied_at/created_at)、`settings.message_moderation`。响应只回 `{moderated}` + 文案，不回 id/status。
- 失败：rejected 与 pending 对外文案完全一致，刻意不区分。

### server/src/routes/links.js（69 行）

- 职责：友链公开列表与申请。
- 机制：`GET /` 取 approved，按 `sort desc, id asc`；`POST /` 叠 `linkLimiter(5/min)`+`honeypotCheck`+`formTokenRequired`，用 `cleanLine/safeUrl/safeCover/cleanText/safeEmail` 分别清洗名称/网址/头像/描述/邮箱，按 `url` 查 pending 与 approved 分别提示，入库固定 `status:'pending'` 并异步邮件通知站长。
- 依赖：`utils/sanitize`、`middleware/antiBot`、`middleware/formToken`、`utils/notifyMail`（行内）。
- 数据：`links`(name/url/avatar/description/email/status/sort/created_at)。
- 失败：清洗后名/址为空 400、重复 400、其余 500；通知失败被吞。

### server/src/routes/settings.js（38 行）

- 职责：公开只读站点设置（保存接口在秘钥路径下的 admin 路由）。
- 机制：`getAllSettings()` 后解构剔除 `ai_api_key`/`websearch_api_key` 再展开，追加三个派生布尔 `mail_notify`(`smtpReady()`)、`ai_llm_ready`（有 key 且 baseUrl 是 https）、`websearch_ready`，以及 `server_tz_offset_min = new Date().getTimezoneOffset()` 供前端校正相对时间。
- 依赖：`utils/response`、`utils/settings`、`utils/notifyMail`、`config`。
- 数据：`settings` 全表（除两个密钥键）；密钥回落顺序为 后台设置 > `.env`。
- 失败：catch → 500；本身无缓存，靠 `getAllSettings` 内 60s 缓存兜住。

### server/src/routes/categories.js（24 行）

- 职责：分类列表 + 每类已发布文章数。
- 机制：`leftJoin articles` 时把 `a.status='published'` 写进 **on 条件**（`andOn`）而非 where，保证空分类仍出现；`groupBy` 覆盖全部非聚合列（兼容 ONLY_FULL_GROUP_BY），`count('a.id as article_count')` 后 `Number()` 归一。
- 依赖：`db`、`utils/response`。
- 数据：`categories`(id/name/slug/description/color/sort)、`articles`(category_id/status)。
- 失败：catch → 500；无分页、无缓存。

### server/src/routes/tags.js（25 行）

- 职责：标签云 + 每标签已发布文章数，按文章数倒序。
- 机制：`tags→article_tags→articles` 两次 leftJoin，同样把 `a.status='published'` 写进 on 条件；`orderBy('article_count','desc')` 依赖 MySQL 可按聚合别名排序。
- 依赖：`db`、`utils/response`。
- 数据：`tags`(id/name/slug)、`article_tags`、`articles`；返回无 `description`（分类有）。
- 失败：catch → 500；无缓存。

### server/src/routes/hitokoto.js（42 行）

- 职责：代理 `v1.hitokoto.cn` 的一言，给前台随机文案。
- 机制：8s 进程内缓存；`AbortController` + 5s 定时器控制上游；`formatQuote` 拼"句子 —— 出处"并截 120 字；上游非 2xx 或空文本 → 502；异常时若有旧缓存则**降级返回旧值**。
- 依赖：`utils/response`；全局 `fetch`（Node 18+），无第三方 HTTP 库。
- 数据：`UPSTREAM`、`CACHE_MS=8000`、超时 5000ms。
- 失败：无 in-flight 去重；502 文案固定。

### server/src/routes/health.js（34 行）

- 职责：存活/就绪/兼容三种探针。
- 机制：`/live` 不碰库；`/ready` 执行 `db.raw('SELECT 1')`，失败 503；`/` 是旧路径，把 DB 状态塞进 `data.db`（`up`/`down`）但**始终 200**，附 ISO 时间。
- 依赖：`utils/response`；`../db` 在函数内行内 require（避开启动顺序/循环依赖）。
- 数据：无表；契约 `{status,db,time}`。
- 失败：`/` 在 DB 挂掉时仍 200，拿它当健康检查的负载均衡不会摘流量。

### server/src/routes/anti.js（113 行）

- 职责：闸门引导面——签发 PoW 挑战、以解答换票据、票据续期、表单令牌、后台秘钥路径。
- 机制：`/puzzle` 15s/10 次调 `issuePuzzle`；`/ticket` 20/min，强制 `isValidFp(x-fp)` 后 `verifyPow`，成功则 `issueTicket(ip,fp,ua,0,true)` 并回 `{token,ttl:600000,renew_at:480000,enc_salt}`；`/renew` 仅在 `RENEW_WINDOW` 内免 PoW 续签；`/seed` 单独限流 60/min（注释解释了为何从 ticket 限流拆出：前端一次加载要给评论/留言/友链各取一个 seed），回 `{token,min_interval:2000,ttl:600000,hp_field}`，`hp_field` 是随机蜜罐字段名；`/admin-path` 要求 `verifyTicket` 通过才回 `config.adminPath`。
- 依赖：`middleware/gate`(issuePuzzle/verifyPow/issueTicket/renewTicket/verifyTicket/isValidFp)、`middleware/formToken`、`config`(`apiPrefix`/`security.encSalt`/`adminPath`)。
- 数据：无表；三个限流器（10/15s、20/min、60/min）。
- 失败：各分支 try/catch 转 500 或 403；挑战一次性（`puzzles.delete(id)`），失败重试须重取。

## 观察

- `server/src/routes/feed.js:262-268` — 主页 RSS 每条手记的 `<link>` 与 `<guid>` 都是同一个 `/api/share-page/notes`，20 条 item 共享一个 guid；阅读器按 guid 去重，订阅者实际只见一条。
- `server/src/routes/articles.js:13-16` 与 `:169-171` 自相矛盾：注释断言"防刷键不能依赖 X-Fp，脚本可任意轮换"，浏览量去重键却正是 `${ip}:${fp}:${articleId}`，同 IP 换 fp 即可无限 `views+1`。
- `server/src/routes/stats.js:179-196` — UV 去重同样含客户端可控的 `x-fp`，而 `visit_uv` 唯一键是 `(day,h)`，轮换 fp 每次都插新行，单机即可刷高 UV（PV 有 10s 闸，UV 没有对应闸）。
- `server/src/routes/share.js:24-46` 与 `:65` — ETag 在"查库 + 拼整页"之后才计算，而这条路由没有缓存；`11-22` 行注释声称加了 ETag 就不必"每次都要查库并重新拼 HTML"，实际只省带宽。
- `server/src/routes/share.js:244` 与 `:267` — `siteName` 已 `esc()` 一次，拼进 `fullTitle` 时又 `esc()` 一次；站点名含 `&` 会输出 `&amp;amp;` 并显示成 `&amp;`。
- `server/src/routes/stats.js:73` 与 `:78-79` — 注释写"正则字面量写在函数体内：每次求值都是新对象"，实际 `CJK_PATTERN` 是模块级 `const` 且带 `/g`；行为侥幸正确（`match`/`replace` 都重置 `lastIndex`），但注释与代码相反。
- `server/src/routes/stats.js:221` — 在 `let summaryCache`（`:230`）声明前赋值，靠"模块已求值完"侥幸成立；把该行挪进顶层调用即炸，属隐性顺序依赖。
- `server/src/routes/stats.js:123` 与 `web/src/utils/wordStats.js:79` — 后端是 `ceil(总字数/350)`，前端是 `ceil(cn/350+en/250)`；纯中文一致，英文偏多时同一篇文章两边分钟数不同（字数本身已对齐）。
- `server/src/routes/comments.js:80-84` — `walk()` 递归遍历整棵树但无任何副作用或排序动作，子节点顺序完全由 SQL 的 `created_at asc` 决定；纯死代码，注释却称"子评论始终按时间正序"由它保证。
- `server/src/routes/comments.js:280` — AI 判 `rejected` 时 `row.moderated=true`，但 message 取 `status==='pending'?'等待审核':'评论成功'`，于是"评论成功"与 `moderated:true` 并存，前端按 message 提示即自相矛盾。
- `server/src/routes/messages.js:17-23` 与 `comments.js:18-24` — `requireAuthForReservedName` 是逐字重复的两份实现，将来给保留名加规则必然只改一处。
- `server/src/routes/messages.js:35` — 留言列表没有任何限流器，而评论的 `/recent`、`/article/:id` 都有 60/min；这是本区唯一"无节流 + `pageSize` 50 + 深 offset"的公开分页接口。
- `server/src/routes/articles.js:69` — `content: undefined` 是空操作：select 里本就没有 content，且 `undefined` 在 JSON 序列化时会被丢弃；"列表不返回正文"的保证来自 select，不是这一行。
- `server/src/routes/articles.js:259-262` — `COALESCE(published_at, created_at)` 把列包进函数，`published_at` 索引失效，上一篇/下一篇各一次全表扫，是详情页最贵的一对查询。
- `server/src/routes/articles.js:388-391` — `/archive` 一次把全部已发布文章拉进内存分组，无分页、无缓存、无上限；本区唯一没有 LIMIT 的列表。
- `server/src/routes/auth.js:14` — `bcrypt.hashSync('timing-equalizer', 12)` 在 require 期同步跑完，启动被阻塞数百毫秒。
- `server/src/routes/auth.js:219` — 每次登录成功都额外跑一次 12 轮 bcrypt 判"是否默认密码"，登录成本翻倍；改密时写一个布尔列即可省掉。
- `server/src/routes/auth.js:117-121` — `loginFails` 超 4000 条时按插入顺序丢最旧，可能丢掉仍在锁定窗口内的键；注释自承"攻击者可制造大量仍锁定的用户名"，即锁定可被键洪泛绕过。
- `server/src/routes/auth.js:390-395` — `router.securityTest` 挂在导出对象上，虽未注册成路由，但任何 require 该模块的代码都能 `resetLoginFails()` 清空锁定表；测试钩子与生产导出不必共用一个对象。
- `server/src/routes/ai.js:142-155` — `inflight` 自增与 SSE 头都写在 `try` 之外，该段任何抛错都走不到 `release()`，该 IP 的唯一并发槽永久占满，后续请求全 429 且无法自愈。
- `server/src/routes/ai.js:201-207` — `round===MAX_TOOL_ROUNDS` 时无条件 `break`，若模型此刻仍返 `tool_calls`，调用被静默丢弃且无收尾回答，读者只看到半截文本加一个 `done`。
- `server/src/routes/home.js:124` — 免票接口无缓存，每次 4 条 SQL + `getAllSettings`；同类"前台高频、结果不敏感"的接口在 `stats.js` 配了 60s 缓存，这里缺一层，等于拿限流当缓存用。
- `server/src/routes/settings.js:24` — 敏感键用**排除法**（解构剔除两个 key）而非白名单，`settings` 表将来新增密钥键会自动随公开接口下发；同仓库 `home.js:75` 用的恰是白名单，两套口径并存。同一响应还带 `ai_base_url`/`ai_model`/`ai_llm_ready`，泄露模型端点与"是否配好"。
- `server/src/routes/health.js:25-32` — `/` 在数据库不可用时仍 200（`db:'down'` 藏在 body），把 `/` 配成健康检查的负载均衡永不摘流量。
- `server/src/routes/feed.js:292-293` — 自制缓存键只有 `rss`/`rss:home`，而 `baseSiteUrl` 在 `site_url` 未配置时由 `req` 推导；此时第二个 Host 在 30s 内会拿到第一个 Host 的绝对链接，同时响应头又声明 `Vary: Host`，语义自相矛盾。
- `server/src/routes/feed.js:30` 与 `share.js:42` — `if-none-match` 用严格相等比较，`W/"..."` 或逗号分隔多值一律不命中 304，弱校验客户端退化成全量下载。
- `server/src/routes/notes.js:52-64` — 列表把 `content`（mediumtext）一起 select 出来，只为 `excerpt` 为空时生成 200 字摘要；每页 20 条即读 20 篇全文，是本区最重的一次列表读。
- `server/src/routes/share.js:256` — `category` 不做存在性校验就进 canonical、`og:url` 与标题，`/share-page/articles?category=<任意值>` 会生成无限多"各自合法"的可索引页，属软重复内容。
- `server/src/routes/links.js:46-50` — 重复申请只挡 `pending`/`approved`，`rejected` 状态下同一 URL 可无限重复提交，每次都插一行 pending 并给站长发一封邮件。
- `server/src/routes/anti.js:62-67` 与 `:106-110` — `enc_salt` 与 `adminPath` 只需一张 PoW 票据（成本极低）即可取得：前者让正文 AES-GCM 的密钥材料对任何解出 PoW 的客户端公开，后者让后台路径失去"隐蔽性"收益。两者是既有设计（`gate.js` 注释亦承认"仍不是访问控制"），安全边界只能落在 JWT + 密码上。

## 小结

1. 这 17 个文件构成 `/api` 下"内容与引导"的公开面：真正免票的仅 `GATE_SKIP` 那 8 个前缀，其余读要票据、写要票据 + 签名 + Referer + 时间戳；路由层只决定"放行后怎么组装"，鉴权全部下沉到 `middleware/gate.js`。
2. 内容防护是三段式：PoW 票据（`anti.js`→`gate.js`）→ 阅读频率闸（`scrapeGuard`，文章与手记共用分桶）→ 正文 AES-GCM（`utils/crypto`，密钥 = HMAC(盐, 票据|slug|note:id)）。`articles.js` 与 `notes.js` 是这套机制的唯二消费方，其余路由只读元数据。
3. 写接口共用一条流水线：`express-rate-limit`→`honeypotCheck`→`formTokenRequired`→`antiSpam`→`aiModeration`→`ipGuard` 信誉。评论与留言是同一流水线的两份实现（中间件与清洗逻辑重复），差异只在留言强制 `forceLlm + failClosed`。
4. 公开查询的安全底线是"状态硬编码"：列表/详情/计数一律写死 `status='published'` 或 `'approved'`，从不让客户端传 `status`；SQL 全走 knex 参数化，唯一需手工转义的是 LIKE 通配符（`escapeLike`），articles/ai/admin 三处已统一。
5. 本区可用性依赖大量进程内状态：`likeGuard`、`viewGuard`、`uvSeen`、`pvGuard`、`loginFails`、`totpReplay`、`inflight`、feed 缓存、`summaryCache`、`readingCache`。多进程（pm2 cluster）或多实例部署下，限流、去重、锁定时长与缓存一致性全部按进程分裂——这是比单个 bug 更结构性的边界。
6. 边界之外：`admin.js`（写面）、`middleware/gate.js`、`middleware/ipGuard.js`、`utils/aiModeration.js`、`utils/aiClient.js` 不在本区；本区所有"为什么挡住了"的结论都以它们为前提。
