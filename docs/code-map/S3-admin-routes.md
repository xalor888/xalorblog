# S3-admin-routes — 管理后台全部接口

### server/src/routes/admin.js（2770 行）

**职责**：单文件承载管理后台的全部 REST 接口（74 条），挂载在 `app.use(`${api}/${config.adminPath}`, adminRouter)` 的秘钥路径下；覆盖文章 / 手记 / 分类 / 标签 / 评论 / 友链 / 留言的 CRUD 与批量审核、仪表盘统计、站点设置导入导出、审计日志、图片上传与孤儿清理、安全中心（封禁/配置/规则测试）、以及 AI 写作助手（工具定义、SSE 对话、Wikimedia 搜图、外链图转存、站内检索）。

**中间件与认证**
- `router.use(authRequired)`（30）：JWT + `x-fp` 指纹 + `sessions` 表三重校验，`req.user` 即 JWT payload（`sub` 为用户 id 字符串、`username`、`role`、`fp`）。
- 角色闸（32-35）：`req.user.role !== 'admin'` 直接 `403 {"code":1,"message":"访问被拒绝"}`，绕过 `utils/response.fail` 的 `code/message/data` 契约手写响应。
- 文件级无 `try/catch` 的统一异常处理；每个 handler 各自捕获并 `fail(res, msg, 500)`，因此所有 500 都丢掉原始错误（无 `console.error`，唯 2045 行例外）。

**项目内依赖**：`../db`（knex，`client: mysql2`，`pool.max = 10`、`acquireTimeoutMillis = 10000`、`dateStrings: true`）、`../config`（`uploadDir`、`adminPath`）、`../utils/response`（`ok`/`fail`/`notFound`）、`../utils/slugify`、`../middleware/auth`、`../utils/datetime`（`localDateTimeStr`/`localDateStr`）、`../utils/markdownText`、`../utils/sanitize`（`cleanText`/`cleanLine`/`cleanMarkdown`/`safeUrl`/`safeEmail`（导入未用）/`escapeLike`/`safeCover`）、`../middleware/ipGuard`（`securityStats`/`ban`/`unban`）、`../middleware/gate`（`verifyTicket`）、`../utils/securitySettings`（`getConfig`/`saveConfig`/`isValidIpOrCidr`）、`../middleware/waf`（`RULE_INDEX`/`scanText`（未用）/`scanAll`）、`../utils/settings`（`saveSettings`/`getAllSettings`/`ALLOWED_KEYS`）、`../utils/notes`（`parseImages`/`serializeImages`/`buildExcerpt`/`noteSummary`）、`./stats`（`invalidateReadingCache`，只清内存 `readingCache`）。
**函数内 lazy require**：`../utils/crypto`（`encryptPayload`）、`../utils/aiModeration`（`moderateComment`）、`../utils/notifyMail`（`send`/`smtpReady`/`enabled`）、`../utils/aiClient`（`chatOnce`/`streamChat`/`getAiConfig`）、`../utils/webSearch`、`../utils/stripExif`、`./notes`（`noteContentKey`）、`multer`/`path`/`fs`/`crypto`/`net`。

**关键局部函数**
- `toBool(value, fallback)`（804）：`true/'true'/1/'1'` 与 `false/'false'/0/'0'` 双向归一，其余回退默认。
- `isValidDateTime(value)`（810）：严格 `YYYY-MM-DD HH:mm:ss` 正则 + `new Date` 逐字段回比（本地时区），拒绝 `2024-02-31`。
- `validHexColor(color)`（799）：非 `#RRGGBB` 一律静默替换成 `#e4573d`。
- `collectReferencedUploads()`（1851）：六路 `pluck`（`articles.cover`、`articles.content`、`settings.value`、`links.avatar`、`notes.content`、`notes.images`）后用 `/\/uploads\/([A-Za-z0-9._-]+)/g` 抽文件名，返回 `Set`。上传列表、单删、孤儿清理三处共用。
- `AI_TOOLS`（2085）：20 个 function-calling 工具，含 `set_content`/`append_content`/`replace_selection`/`insert_at_cursor` 等写正文、`set_tags`/`set_category`/`set_cover`/`set_slug`/`set_options` 元数据、`search_images`/`search_web`/`list_articles`/`read_article`/`list_comments`/`list_messages`/`link_article` 检索，以及 `save_draft` 与 `publish`。
- `loadSiteBrief()`（2320）：`categories(30)` / `tags(80)` / 最近 10 篇（`slug`+`title`+`status`）拼成站点简报注入 system prompt。
- `buildWriterSystemPrompt(context, site, systemPrompt, ctxChars=6000)`（2336）：自定义 `systemPrompt` 只替换「角色与文风」层，工具说明与文章上下文保留；`selection` 截 3000、`summary` 500、`_compression` 800。
- `compressHistory(messages, keep, cfg)`（2397）：被挤出窗口的旧对话压成 ≤150 字纪要交给 `chatOnce(maxTokens: 300)`，失败 `catch(() => '')` 降级为无纪要。
- `trimChatMessages(messages, turns=24)`（2428）：倒序取最近 N 条，`user` 4000、`assistant.content` 4000、`tool_calls` 最多 8 个且 `arguments` 24000、`tool` 内容 8000，最后清掉找不到配对 `assistant.tool_calls` 的孤儿 `tool` 消息。
- `riskyImageSource(raw)`（2551）：仅 https、禁 userinfo、禁 `localhost/.local/.internal`、禁 IPv6 字面量、禁 IPv4 字面量（粗粒度，不做网段判别）。
- `searchWikimediaImages(query)`（2486）：Commons `gsrnamespace=6`、`gsrlimit=16`、`iiurlwidth=800`，过滤非 https、`svg|tif|tiff|pdf|djvu`、`width<600`，最多 9 条，9 秒 `AbortController` 超时，异常返回 `[]`。

**重要数据与契约**
- 表：`articles`（`title/slug/summary/content/cover/category_id/status/is_top/views/likes/allow_comment/allow_copy/published_at`）、`notes`（`content/images/excerpt/mood/location/likes/is_pinned/status/published_at`）、`categories`（`name/slug/description/color/sort`）、`tags`、`article_tags`、`comments`（`status/ai_reason/parent_id/nickname/email/ip`）、`links`（`status/sort/avatar/url`）、`messages`（`status/ai_reason/reply/replied_at/email`）、`visits`（`day/pv/uv`）、`settings`、`audit_logs`（`user_id/username/action/detail/ip/fp`）。
- 枚举：`status ∈ {draft, published}`（文章/手记）、`{pending, approved, rejected}`（评论/友链/留言）。
- 状态码：`ok` → `200 {code:0,message,data}`；`fail` 默认 `400`，服务端错误显式 `500`，`notFound` → `404`；`/ai/save-image` 用 `413`（超 5MB）、`415`（mime 不支持）、`502`（源站异常/跳转被拒）。
- 阈值/上限：文章正文 `cleanMarkdown(…, 100000)`、手记 20000、`summary` 500/导入 300、标题 200、标签名 50、分类名 50、`description` 255、回复 2000、CSV 导出各 `limit(1000)`、批量操作与 `approve-all` 上限 500/1000、分页 `page ≤ 10000`、`pageSize ≤ 100`、`days ∈ [7,90]`、封禁 `[5, 525600]` 分钟（默认 30 天）、上传 5MB/单文件、AI 搜图上限 9 张、SSE 保留 24 条对话。
- 文章正文加密下发：`GET /articles/admin/:id` 读 `x-pass` 请求头，`encryptPayload(row.content, pass, row.slug)`，并回传 `content_key: row.slug`、`content_enc`；手记用 `noteContentKey(id)`（`note:${id}`）。
- 导出契约：文章备份 `type: 'articles-backup', version: 2`（含 `views/likes/published_at`）；CSV 统一 `\ufeff` BOM + `\r\n`，`esc()` 对 `^[=+\-@\t\r]` 前置单引号防公式注入，状态中文化 `pending/approved/rejected → 待审核/已通过/已拒绝`。
- 环境变量：本文件不直接读 `process.env`，SMTP 判据在 `notifyMail.smtpReady()`（缺 `SMTP_HOST/SMTP_USER/SMTP_PASS` 时 400 提示）。

**运行期副作用与失败模式**
- 事务：创建/更新文章（含标签重建）、复制、单删/批删文章、批删评论、删分类、删标签、合并标签、批量发布补 `published_at`、导入、清空审计日志后的补写。手记与留言的写操作全在事务外。
- 每次文章写操作后调 `invalidateReadingCache()` 清空进程内阅读统计缓存（文章 229/316/389/406/426/460/498/600），手记写操作一处未调。
- 同步 FS：`upload` 里 `mkdirSync`/`readFileSync`（整文件校验 magic、SVG 全文转字符串）、`writeFileSync`（EXIF 重写）、`/uploads/list` 对每个文件两次 `statSync`、`cleanup-orphans` 逐个 `unlinkSync`——全部阻塞事件循环。
- 全表 `pluck`：`slugify` 的 `existing` 参数在创建/更新/复制/导入/标签/分类共 14 处取全表 slug（`db('articles').pluck('slug')` 等），随数据量线性增长。
- 未捕获 async：`/security/unban`（1979）、`/security/ban`（1987）、`/ai/articles`（2613）、`/ai/web-search`（2636）、`/ai/article`（2647）、`/ai/comments`（2669）、`/ai/messages`（2686）等 handler 是 `async` 但无 `try/catch`，Express 4.19 不会接管 reject，DB/网络异常时请求悬挂直至客户端超时。
- 内存态：`ban/unban` 改 `ipGuard` 的 `records` Map 并异步落库；`getConfig` 由 `securitySettings` 缓存；`getAllSettings` 有 60s 缓存（`/settings/export`、`/ai/web-search` 都读缓存，最长 60s 陈旧）。
- SSE：`/ai/chat` 先 `setHeader` + `flushHeaders` 再校验入参，所以错误也走 200 + `data: {"type":"error"}`；`req.on('close')` 中止上游；`send()` 吞掉写失败；`finally` 必定 `res.end()`。
- 失败模式：multer 错误 `next(err)` 交 app 全局错误中间件；`ER_DUP_ENTRY` 在文章/分类上单独映射为业务提示，其余写操作统一 500。

## 观察

1. `admin.js:2081` 注释「只提供『改内容』的工具，发布权永远在人手上（没有 publish）」与 `admin.js:2299` 的 `publish` 工具直接矛盾；`admin.js:2084` 又写「写正文 ×6 + 元数据 ×4 + 检索 ×3」，而 `AI_TOOLS` 实际 20 个，注释与代码三处不一致。
2. `admin.js:212` 创建文章 `for (const name of tags)`：`tags` 仅在 `undefined` 时默认 `[]`，传字符串 `"vue,js"` 会按字符迭代，创建出 `v/u/e/,/j/s` 六个单字标签；更新路径 `admin.js:296` 有 `Array.isArray(tags)` 守卫，创建路径漏了。
3. `admin.js:526`/`561` 导入时 `content` 只校验长度、原样入库，绕过了创建/更新用的 `cleanMarkdown(content, 100000)`（`admin.js:179`/`256`）；从备份文件恢复即把未过滤的 `<script>`/`<iframe>` 写回正文列。
4. `admin.js:207`/`258`/`564` 封面走 `safeCover`，其站内白名单正则是 `^\/uploads\/[A-Za-z0-9._-]+$`（`utils/sanitize.js:109`，单段无子目录），而 `/ai/save-image` 返回的是 `/uploads/ai/<name>`（`admin.js:2603`）——AI 转存的图无法被设为封面，会被静默降级为空字符串，前端表现为「选了图但封面没变」。
5. `admin.js:1856` 引用提取正则 `/\/uploads\/([A-Za-z0-9._-]+)/g` 遇到 `/uploads/ai/x.png` 只会捕获 `ai`；加上 `admin.js:1888` 的 `readdirSync` 只列顶层且 `statSync().isFile()` 过滤，`/uploads/ai/` 整目录既不出现在文件管理页，也不参与「被引用」判定，孤儿清理也扫不到。
6. `admin.js:1798` SVG 危险模式只枚举 `onload/onerror/onbegin/onend/onrepeat`，`<svg onfocus=alert(1) tabindex=0>`、`onclick=`、`onmouseover=` 都能通过校验；`javascript:` 规则救不了不带协议的 `alert()`。
7. `admin.js:397` `router.delete('/articles/:id', async (req, res) => {  try {` — 花括号与 `try` 挤在同一行且多余空格，格式异常；同函数内删除不存在的 id 仍返回「文章已删除」（无 `notFound`），语义上是有意的幂等，但与 `PUT /articles/:id` 的 404 契约不一致。
8. `admin.js:427`/`751`/`1090`/`1218`/`1233`/`1449`/`1465` 批量接口一律返回 `safeIds.length` 而非数据库真实 `affected`，删除/更新不存在的 id 也报告成功条数。
9. `admin.js:239` 注释写「任一方不存在：回滚且标记未合并」，但标签合并的事务回调只是 `return`（knex 会正常提交空事务），并没有 rollback；注释与行为不符。
10. `admin.js:1113` 评论「全部通过」不检查 `ai_reason`，而同构的留言接口 `admin.js:1380` 明确跳过 AI 标记项；两套审核流语义分叉，评论里被引擎标记的内容会被一键放行。
11. `admin.js:1150` 友链列表 `select('*')` 且无分页/上限，`admin.js:1291`-`1329` 留言列表却分页；友链数量增长后一次性返回全部字段。
12. `admin.js:2010` `/security/audit` 用 `catch { return ok(res, []) }` 把 DB 异常伪装成「没有日志」，安全排查时可能误判为日志为空。
13. `admin.js:1630` 设置导出剔除 `ai_system_prompt`，但 `admin.js:1645` 的 `ALLOWED_KEYS` 允许导入它——备份/恢复不对称，导入自己的备份会静默丢掉人设提示词。
14. `admin.js:1479` `days` 未取整：`?days=8.5` 通过钳制后 `for (let i = 0; i < days; i++)` 跑 9 次，`since` 用小数天算偏移，趋势数组长度与 SQL 区间错位半天。
15. `admin.js:1482` 仪表盘一次性 `Promise.all` 发出 18 条查询（含 `SUM(views)`、三张表 count、`DATE(created_at)` 分组），而连接池 `max = 10`、`acquireTimeoutMillis = 10000`（`db.js`）——并发管理页会把部分查询排到超时，且全程无缓存。
16. `admin.js:1031`/`1311`/`1724` 三份完全相同的 `esc()` CSV 转义、`admin.js:1037`/`1317` 两份 `statusZh`——同一逻辑复制三遍，改一处易漏两处。
17. `admin.js:1766`-`1769` 在上传 handler 内重新 `require('multer'/'path'/'fs'/'../config')`，其中 `config` 在 `admin.js:10` 已模块级引入，此处同名遮蔽，属冗余死代码；`admin.js:1836` 的 `readFileSync` 把 5MB 上限的全图读进内存两次（校验 + EXIF）。
18. `admin.js:69` 查询未选 `content`，`admin.js:98` 又写 `content: undefined` ——JSON 序列化时该键被丢弃，纯无用行。
19. `admin.js:799` 非法颜色不报错而是静默换成品牌橙 `#e4573d`；管理员改色时输入错误会被「吃掉」，无任何反馈。同类静默还有 `admin.js:1618` `saveSettings` 对白名单外键的丢弃（`/settings` PUT 返回成功但字段未存）。
20. `admin.js:1476` 在 handler 内再次 `require('../utils/datetime')` 解构 `localDateTimeStr`，与 `admin.js:14` 的模块级导入重复并遮蔽。
21. 死代码：`admin.js:16` 同时引入 `safeUrl`、`safeEmail`，`admin.js:20` 引入 `scanText`，三者在全文均无调用点（`safeUrl` 只出现在 `admin.js:563` 的注释里，实际由 `safeCover` 内部兜底）。
22. 全文无 `TODO`/`FIXME` 标记；风险集中在「注释宣称的安全性质」与实际实现不符（观察 1、2、9、13）。

## 小结

1. 这是整个后端的**写入面与信任面中枢**：只有它能把 `draft` 变 `published`、能改站点设置、能封禁 IP、能清审计日志，因此 `authRequired + role==='admin'` 的两道闸（30-35）是整个系统权限模型的实际收口点，任何绕过都等价于全站失守。
2. 它的边界是**秘钥路径前缀 + 三重认证**，而非「后台语义」：文件内不做任何 IP 白名单或二次口令，`/security` 的 `pass_valid`（1970）只做展示；真正的路径不可枚举性依赖 `config.adminPath` 与 app 层挂载顺序。
3. 内容写路径的清洗是不均匀的：创建/更新走 `cleanMarkdown`，导入走裸字符串（观察 3），封面上限被 `safeCover` 的单段正则卡住（观察 4）。这条不对称是「备份恢复」这条少用路径上最现实的存储型 XSS 入口。
4. 批处理与统计接口以「一次请求多查询、全表 pluck、无缓存」换取实现简单：18 条并行查询撞 10 连接池（观察 15）、14 处全表 slug 读取、`collectReferencedUploads` 每次扫全部正文列——数据量上来后，后台首屏与上传管理会先于前台变慢。
5. AI 写作助手把「模型能做什么」完全编码在 `AI_TOOLS` + system prompt 里，但发布权已被代码交出去（`publish`，观察 1），注释里的安全承诺（「发布权永远在人手上」）不再成立；工具执行实际发生在前端，服务端只负责流式转发与工具白名单声明。
6. 与其它分区的接口关系：`invalidateReadingCache`（`./stats`）是文章写操作向下游统计缓存发出的唯一信号，手记的增删改（610-793）一处未调，阅读统计因此最多陈旧 60 秒；封禁既改 `ipGuard` 的内存 Map 又落库，`/security` 同时呈现内存与持久化两套视图；审计写入由 `middleware/audit` 在 `app.use(api, audit)` 处统一完成，本文件只在清空日志时手工补一条 `AUDIT_CLEAR`。
