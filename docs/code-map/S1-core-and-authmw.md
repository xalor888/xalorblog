# S1 · 服务端骨架与认证/闸门中间件

覆盖 10 个文件，逐行读完（app 456 / config 144 / db 68 / server 92 / antiBot 70 / audit 64 / auth 210 / fetchMeta 16 / formToken 119 / gate 544 行）。

---

### server/src/app.js（456 行）

**职责**：Express 唯一装配点，中间件顺序本身就是安全模型。

**导出**：只有 `app` 实例，行为全靠 `app.use/get`。按装配顺序的实际作用：

1. `X-Request-Id`（41-46）：外部头匹配 `^[A-Za-z0-9-]{8,64}$` 则透传，否则 `randomUUID()`；写回响应头，供 500 日志关联。
2. 压缩（56-77）：追加 `Vary: Accept-Encoding`；`HEAD` 或不含 `gzip` 直接放行；劫持 `res.send`，对 `string` 且 `length>=1024`、非 304 的响应做 `gzipSync`，压不更小就放弃。
3. 安全头（82-111）：helmet 关 CSP/COEP、`frameguard: deny`、`hsts: false`；自写 HSTS 仅当 `req.secure` 或 `x-forwarded-proto=https`，值含 `includeSubDomains; preload`；另设 `Permissions-Policy`、`Referrer-Policy: strict-origin-when-cross-origin`、`COOP: same-origin`、`X-Permitted-Cross-Domain-Policies: none`。
4. 方法白名单（114-121）：`GET/HEAD/POST/PUT/DELETE/OPTIONS`，其余 405 + `Allow`。
5. Host 校验（124-139）：剥离 `[]`/端口/尾点后必须落在 `config.allowedHosts`，否则 `report(ip,'waf','HOST 头不合法')` + 403；无通配、无子域语义。
6. 超时（145-158）：每请求 30s 定时器，未 `writableEnded` 则尽力回 408 并 `socket.destroy()`；`finish/close` 清理；另设 `res.setTimeout(30s)`。
7. CORS（164-175）：`!origin || origin==='null' || 白名单` 放行，否则抛 `new Error('不允许的跨域来源')` 由末尾 handler 转 403；`allowedHeaders` 显式列出 `X-Pass/X-Fp/X-Sig/X-Timestamp/X-Nonce/X-Enc/X-Hp-Field`。
8. body（177-178）：`json` 与 `urlencoded({extended:true})` 各 2MB。
9. 限流（181-220）：`apiPrefix` 上 120/min（超限记 `rate` 分 + 429）；`strictLimiter` 20/min；`uploadsLimiter` 120/min。
10. API 响应头（194-202）：`no-store`、`CSP: default-src 'none'; frame-ancestors 'none'`、`CORP: same-origin`。
11. `/uploads` 静态（224-244）：`dotfiles:deny`、`index:false`、`CORP: cross-origin`、`max-age=604800, immutable`，`.svg` 强制 `image/svg+xml` + `attachment`；**刻意排到 WAF/ipGuard 之前**。
12. `waf`（247）→ `ipGuard`（250）→ `fetchMetaGuard`（255）。
13. 闸门（271-296）：`GATE_SKIP=['/anti','/health','/rss.xml','/sitemap.xml','/robots.txt','/share/','/share-page','/home/summary']` 前缀命中即跳过；`OPTIONS` 放行；`GET`+搜索引擎 UA → `verifyCrawlerIp`，失败记 `FAKE-CRAWLER` 分并 403；空 UA 403（不记分）；`GET/HEAD` 走 `gateRequired`，其余 `gateWriteRequired`；整段 `try/catch` 异常回 403 防悬挂。
14. 写防护（299-308）：`audit`；非 `GATE_SKIP` 的 `POST/PUT/DELETE` 依次 `refererRequired → timestampRequired`。
15. 根路径 SEO（311-348）：`/robots.txt` 直调 `robotsTxt(req)` 并 `Vary: Host`（DB 挂则 `Disallow: /`）；`/sitemap.xml`、`/rss.xml` 用 `rewriteToApiPrefix` 就地改写 `req.url`（不重入路由器，避免中间件双跑与空前缀自递归）；`/.well-known/security.txt`（347-366）读 `social_email` 作 Contact，`Expires` 恒为当前 +365 天。
16. 路由挂载（369-418）：`/health` 与 `${api}/health`；`${api}/anti`（无外层限流）；`/auth`+`strictLimiter`；`/articles`、`/notes`、`/categories`、`/tags`、`/stats`、`/ai`、`/hitokoto` 各带 `antiBot`（前四者另加 `readLimiter`）；`/home`、`/comments`、`/settings` 无外层防护（限流在路由内）；`/links`、`/messages` 带 `strictLimiter`；`${api}/${config.adminPath}` → `adminRouter`；`${api}`+`rssLimiter(12/min)` → `feedRouter`、`${api}`+`shareLimiter(40/min)` → `shareRouter`。
17. 404（421-428）：`recordMiss` 命中 403，否则 404，**两者同 body**，`no-store`。
18. 错误处理（432-454）：按 `不允许的跨域来源`（403，只 warn 不记分）、`LIMIT_FILE_SIZE`（400「5MB」）、`LIMIT_UNEXPECTED_FILE`/`仅支持图片文件`（400）、`entity.too.large`（413 + `rate` 分）、`entity.parse.failed`（400 + `waf` 分）分支；余下 500 并打印 `rid`。

**依赖**：`./config`、18 个 `./routes/*`、`./middleware/{antiBot,waf,formToken,requestGuard,gate,ipGuard,audit,fetchMeta}`、`./utils/settings`（懒 require）；`feed` 被 require 两次（模块缓存）。

**数据**：限流 120/min、20/min、40/30s、12/min、40/min、120/min；body 2MB；超时 30s；状态码 200/304/400/403/405/408/413/429/500，业务体统一 `{code:1,message}`。

**副作用/失败**：全局替换 `res.send`；错误分支写 IP 信誉；CORS 拒绝靠字符串匹配；`/uploads` 早于 WAF 意味着被封 IP 仍可取图。

---

### server/src/config.js（144 行）

**职责**：dotenv + 全部参数 + 启动即失败的强制校验。

**导出**：`isProd`、`port`、`listenHost`、`trustProxy`、`apiPrefix`、`db`、`jwt`、`uploadDir`、`allowedHosts`、`homeSiteHost`、`corsOrigins`、`adminPath`、`security`、`ai`、`websearch`。

- `resolveListenHost`：默认 `127.0.0.1`，拒 >253 字符或含 `\s/?#`。
- `resolveTrustProxy`：默认 `loopback`；`0/false/off/none`→`false`；**拒绝 `true` 与数字跳数**（抛错）；多值按逗号切。
- `DB_PASSWORD` 硬校验：必填、非 `xalor2026`/`CHANGE_ME_STRONG_PASSWORD`/`__REPLACE_WITH_A_STRONG_RANDOM_PASSWORD__`、≥16 字符，否则**加载即抛**。
- `resolveSecret`：记忆化；生产要求 `JWT_SECRET`≥32，开发 `randomBytes(48).hex`。
- `apiPrefix`：剥尾部全部 `/`；`jwt.expiresIn` 默认 `2h`。
- `allowedHosts`：默认 `localhost,127.0.0.1,::1`；`homeSiteHost` 去空白/剥方括号/小写，空=不派发主页版 SEO；`corsOrigins` 默认 6 个 5173/4173。
- `adminPath`：`HMAC(JWT_SECRET,'admin-secret-path')` hex 前 12 位；`ADMIN_PATH` 存在则清洗为 `[a-zA-Z0-9_-]` 并截 16。
- `security`：`ticketTtl 10min`、`renewWindow 8min`、`powDifficulty`（生产 20/开发 16，夹 12..24）、`powDifficultyMax`（24，夹 16..28）、`puzzleTtl 60s`、`sigWindow 5min`、`encSalt`（生产 ≥16 且不得为 `xalor-content-v1`）。
- `ai`：`enabled`（`AI_MODERATION!=='false'`）、`apiKey/baseUrl/model`、`rejectScore 60`、`pendingScore 30`；`websearch.apiKey`。

**环境变量**：`NODE_ENV/PORT/LISTEN_HOST/TRUST_PROXY/API_PREFIX/DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/JWT_SECRET/JWT_EXPIRES_IN/ALLOWED_HOSTS/HOME_SITE_HOST/CORS_ORIGINS/ADMIN_PATH/POW_DIFFICULTY/POW_DIFFICULTY_MAX/ENC_SALT/AI_MODERATION/AI_API_KEY/AI_BASE_URL/AI_MODEL/AI_REJECT_SCORE/AI_PENDING_SCORE/WEBSEARCH_API_KEY`。

**副作用**：`dotenv.config()` 改写 `process.env`；任何 require config 的脚本都必须提供合规 `DB_PASSWORD`；开发环境随机 secret 使重启后 JWT/票据/表单令牌/`adminPath` 全变。

---

### server/src/db.js（68 行）

**职责**：唯一 knex/mysql2 池，并在每条新连接上固定字符集、会话时区与严格 SQL 模式。

- `localTimezone()`：`-getTimezoneOffset()` 现算 `±HH:mm`，供连接 `timezone` 与 `SET SESSION time_zone` 共用。
- 连接：`charset:'utf8mb4'`（注释解释排序规则不能填此处，否则建表 DDL 会 `Unknown character set`）、`multipleStatements:false`、`dateStrings:true`、`connectTimeout 10000`、`flags:['-LOCAL_FILES']`。
- 池：`min 0 / max 10`、`idle 30s`、`acquire/create/destroy 各 10s`。
- `afterCreate`：串行 `SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci` → `SET SESSION time_zone='±HH:mm'`（每连接重算，绕开 DST 导致模块级偏移过期）→ `SET SESSION sql_mode="STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"`，任一步失败 `done(err, conn)`。

**数据**：默认库 `xalor_blog`、用户 `xalor`、3306；`sessions/users/audit_logs/ip_bans/gate_tickets/visits/visit_uv` 全走此池。

**副作用/失败**：每新连接 3 次额外往返；`SET NAMES` 失败仍把连接交回池（库默认排序规则静默生效）；池上限 10 是全站并发天花板。

---

### server/src/server.js（92 行）

**职责**：进程入口：先恢复持久化状态再监听，并挂定时清理、优雅退出、进程兜底。

- `require.main !== module` 时只导出 `app`，不监听。
- `main()`：`loadPersistedBans()` → `loadPersistedTickets()` → `securitySettings.reload().catch(()=>{})`，全在 `listen` 之前，避免启动窗口读到默认安全配置。
- 每 6h（`.unref()`）并行清理：过期 `sessions`、撤销超 24h `sessions`、过期 `ip_bans`、90 天前 `audit_logs`、730 天前 `visits`+`visit_uv`、`purgeExpiredTickets()`；计数非零才打印。
- `listen(config.port, config.listenHost)`，打印 IPv6 带括号地址、API 前缀、`/#/${adminPath}`、PoW 难度。
- 服务端超时：`requestTimeout 20s`、`headersTimeout 15s`、`keepAliveTimeout 5s`、`maxHeadersCount 60`。
- `shutdown`：`server.close` → `db.destroy()` → `exit(0/1)`，`closeIdleConnections?.()`，15s 兜底强退；监听 `SIGINT/SIGTERM`。
- `uncaughtException`/`unhandledRejection`：打印后 `exit(1)`，交给外部重启。

**依赖**：`./app`、`./config`、`./db`、`ipGuard.loadPersistedBans`、`gate.loadPersistedTickets/purgeExpiredTickets`、`utils/datetime.localDateStr`、`utils/securitySettings`。

**数据**：保留期 24h/90 天/730 天，清理周期 6h；字段 `expires_at/revoked/created_at/banned_until/day`。

**副作用/失败**：清理异常静默跳过；任一未处理 rejection 直接退出进程。

---

### server/src/middleware/antiBot.js（70 行）

**职责**：最廉价的「UA 像不像浏览器」过滤 + 读接口节流 + 固定名蜜罐。

- `BOT_PATTERNS`（12-23）24 段：脚本/客户端（`python-requests`、`curl/`、`okhttp`、`axios/`、`ab/`…）、无头（`playwright`、`headless`、`webdriver`…）、采集（`spider`、`semrush`、`gptbot`、`ccbot`…）。
- `isBotUserAgent`：空 UA→true；`isSearchBot` 先放行；命中模式→true；不含任何 `BROWSER_HINTS`（mozilla/chrome/safari/edge/firefox/opera）→true。
- `antiBot`：非 `GET` 直接放行；判为 bot 则 403。`readLimiter` 30s/40 次。`honeypotCheck`：`website_url` 有值即 403。

**依赖**：`./gate.isSearchBot`（单向）。**数据**：`30000/40`、`website_url`。

**副作用/失败**：只挂部分路由、不拦写；字符串包含判定可被 UA 伪造绕过；内存计数不跨实例。

---

### server/src/middleware/audit.js（64 行）

**职责**：把已认证用户的成功写操作与系统决策写入 `audit_logs`。

- `summarize`（12-23）：非对象/数组返回空；遍历白名单 `title/name/status/nickname/username/content`，`key=值.slice(0,40)`，整体截 160。
- `audit`（26-48）：仅写方法；`res.on('finish')` 中 `statusCode<400 && req.user` 才 insert：`user_id=Number(sub||0)`、`username` 50、`action="METHOD baseUrl+path"` 120、`detail=summary`、`ip` 64、`fp=X-Fp` 128，`.catch(()=>{})`。
- `logSystemAction`：同表 `user_id 0`、`fp ''`、`username` 默认 `system`，失败静默。

**依赖**：`../db`。**数据**：表 `audit_logs`（`user_id/username/action/detail/ip/fp/created_at`），长度上限 50/120/160/64/128。

**副作用/失败**：写入不 await，优雅退出时可能丢末条；路径在 finish 时现算（已被子路由改写）；不记响应码与耗时。

---

### server/src/middleware/auth.js（210 行）

**职责**：JWT + 设备指纹 + 服务端会话表三重校验，并提供签发、撤销、枚举。

- 常量 `ISSUER='xalor-blog'`、`AUDIENCE='xalor-web'`。
- `sessionTableReady()`：`db.schema.hasTable('sessions')`，异常上抛由调用方 fail-closed。
- `signToken`：`jti=randomBytes(12).hex`、`fp=X-Fp` 128；签 `{sub,jti,iss,aud,fp,username,role,nickname,nbf:now-5}`；`hasTable` 缺表抛 `SESSION_STORE_UNAVAILABLE`；插入 `sessions{jti,user_id,fp,ip,ua(255),expires_at(由 exp 反推)}`；删该用户 `revoked=true OR expires_at<now`；活跃数 >20 时按 `created_at asc` 把溢出 jti 置 revoked。一次登录最多 6 次往返。
- `authRequired`（97-170）：取 Bearer（缺失 401 未登录）→ `jwt.verify({issuer,audience})`（失败 401 过期）→ 指纹 `!payload.fp || !curFp || 不等` 即 401（不许双方为空）→ `hasTable` 异常 401、缺表 **503**（明确拒绝纯 JWT 降级）→ 查 `sessions`：无行/`revoked`/`user_id!==sub`/双向 fp 不一致/`expires_at` 过期各自 401，查询异常 401 → 查 `users{id,username,nickname,role}`，异常或缺失 401 → `req.user='{...payload, DB 的 role/username/nickname}'`、`req.jti`、`req.authed=true`。
- `revokeSession(jti, userId|null)`：缺表抛错，`WHERE jti AND revoked=false [AND user_id]` 置 revoked，返回是否命中。
- `revokeUserSessions(userId,{exceptJti,executor=db})`：可换事务 executor，用于改密/2FA 变更。
- `listSessions`：按 `created_at desc` 返回 `jti/fp/ip/ua/revoked/expires_at/created_at`。

**依赖**：`../config`、`../db`。**数据**：`sessions`、`users`；会话上限 20；401/503 契约。

**副作用/失败**：每个已认证请求固定 3 次查询（`hasTable`+`sessions`+`users`）；token 内的 `role/nickname` 不再被信任但残留在载荷里；签发时不校验 `fp` 是否合法。

---

### server/src/middleware/fetchMeta.js（16 行）

**职责**：用浏览器自动发的 `Sec-Fetch-Site` 做零成本 CSRF 前置过滤。

非写方法放行；头为空（旧浏览器/脚本）放行交给签名兜底；`same-origin|same-site|none` 放行；`cross-site` 403 `{code:1,message:'请求被拒绝'}`。无依赖、无状态；`same-site` 放行意味着两个兄弟域互可信。

---

### server/src/middleware/formToken.js（119 行）

**职责**：为评论/留言/友链签发绑定「指纹+UA+路径」的一次性 HMAC 令牌并附动态蜜罐名。

- `SECRET=jwt.secret+':anti-token-v2'`、`TOKEN_TTL 60min`、`USED: Map<nonce,exp>`、`USED_MAX 3000`；`sign()` 取 `HMAC-SHA256` hex 前 32 位。
- `issueToken(req,path)`：`ts.nonce(randomBytes(6)).sig`，签名输入 `fp|ua|path|ts|nonce`。
- `verifyToken`：三段 → 数值 ts → 重算 + `timingSafeEqual`（先比长度）→ `now-ts>60min` → `USED` 未过期即「已被使用」→ 表满先清过期、仍满则**拒绝**（「系统繁忙」）→ 记录 nonce。
- `honeypotFieldName`：种子 `X-Fp||req.ip`，`HMAC(SECRET+':hp', seed|path|Date.now().slice(0,8))`，生成 `hp_`+8 字母。
- `formTokenRequired`：取 `req.body.form_token`；`forPath=(baseUrl+path)` 去 `apiPrefix` 与尾斜杠；签名不过 403（文案用 `reason`）；随后**始终**校验当前窗口派生名，另外 `X-Hp-Field` 声明的名字若与派生名不同且该字段有值也 403。

**依赖**：`../config`。**数据**：60min、3000、`hp_`、头 `X-Hp-Field`、字段 `form_token`。

**副作用/失败**：`USED` 纯内存（重启丢单次语义、多实例不共享）；表满对全体 fail-closed；蜜罐派生窗口由 `Date.now().slice(0,8)` 决定，实际约 100 秒。

---

### server/src/middleware/gate.js（544 行）

**职责**：反爬主闸门：PoW 挑战、票据签发/验签/续期、写请求签名与 nonce 防重放、搜索引擎 FCrDNS 核验；内存 Map 为运行时权威，`gate_tickets` 只负责重启恢复。

- 常量：`SECRET=jwt.secret+':gate-v2'`、`VERSION='v2'`、`POW_DIFF/POW_DIFF_MAX`、`TICKET_TTL 10min`、`RENEW_WINDOW 8min`、`PUZZLE_TTL 60s`、`SIG_WINDOW 5min`、`MAX_RENEWS 10`、`FP_RE=/^[a-f0-9]{32,128}$/`。
- `digestHasLeadingZeros(hex,bits)`：整字节判零 + 剩余 bit 右移判定，与前端求解器同语义。
- `puzzles: Map<id,{ts,prefix,ip,fp,ua,diff}>`（上限 5000，超限先删过期、无过期才删最旧）；`issuedJti: Map<jti,{ts,renews}>`（20000，回落 18000，超 `TICKET_TTL*2` 可清）。
- `normalizeClientIp`：小写、剥 `::ffff:`；`clientIp(req)` 基于 `req.ip`。
- `adaptiveDifficulty(ip)`：`POW_DIFF + min(POW_DIFF_MAX-POW_DIFF, floor(getScore(ip)/4))`。
- `trackFpIp(fp,ip)`：1h 窗口内记录同指纹见过的 IP 集（阈值 3、上限 20000、超限先清过期再按插入序删到 75%），**仅跨过阈值的瞬间返回 true**；`isFpFlagged` 只看集合大小 ≥3。
- `issuePuzzle`：12 字节前缀 + 8 字节 id；跨阈值时 `report(ip,'rate','FP-IP-POOL')`；`diff = isFpFlagged ? POW_DIFF_MAX : adaptiveDifficulty(req.ip)`；返回 `{id,prefix,difficulty}`。
- `verifyPow`：取 id 后**立即删除挑战**；过期、UA 不一致、`fp` 不一致、`solution` 不合 `/^[a-zA-Z0-9]+$/` 或 >64、`sha256(prefix+':'+solution)` 前导零不足（按签发时 `diff`）各自返回带文案的失败。
- `issueTicket(ip,fp,ua,renews=0,persist=false)`：`sig=HMAC(VERSION|fp|ua|ts|jti)`，返回 `{token,jti,ts}`；**ip 形参未参与签名**。`persistTicket` 用 `onConflict('jti').merge` 写 `gate_tickets{jti,issued_at,renews,expires_at=ts+TICKET_TTL*2}`，失败静默降级纯内存。
- `loadPersistedTickets`/`purgeExpiredTickets`：启动灌回未过期票据（含 `renews`）并打印条数；删过期行，异常返 0。
- `verifyTicket`：`X-Pass` 三段 → jti 必须在 `issuedJti` → 重算 `HMAC(VERSION|fp|ua|ts|jti)` + `timingSafeEqual` → `|now-ts|>TICKET_TTL` 失败；**不比对 IP**。
- `consumeNonce`：`/^[a-zA-Z0-9]{8,64}$/`；已存在未过期=重放；`usedNonces` 上限 8000，满且清理后仍满则拒绝。
- `verifySig`：`X-Timestamp` 需 `^\d{10,13}$` 且窗口 5min；`bodyHash=sha256(JSON.stringify(req.body||{}))`；`path=decodeURIComponent(req.path)`（解码失败保留原样，兼容中文 slug）；签名输入 `method|path|t|bodyHash|jti|nonce`，key 为票据串本身；`timingSafeEqual` 通过后再 `consumeNonce`。**query 不参与签名**。
- `gateRequired`：验票失败 403「访问被拒绝」；非 HEAD 还需验签，失败 403「请求签名无效」；写 `req.passTicket`、`req.sigVerified`。`gateWriteRequired`：验票 + 强制验签，同上。
- `renewTicket`：验票 → 超 `RENEW_WINDOW` 要求重算 → `renews+1 > MAX_RENEWS` 也要求重算 → 续新票（`persist=true`）。
- `SEARCH_BOT_RE`：`googlebot|bingbot|baiduspider|sogou|360spider|yandex|duckduckbot|smider|bytespider|petalbot|yisou`。
- `verifyCrawlerIp`：按 `CRAWLER_RULES`（8 条：`googlebot.com/google.com`、`search.msn.com`、`baidu.com/baidu.jp`、`sogou.com`、`yandex.*`、`duckduckgo.com`、`bytedance.com/toutiao.com`、`aspiegel.com/petalbot.com/huawei.com`）匹配 family，未匹配直接拒绝；缓存键 `family|归一化IP`，TTL 1h、上限 5000；`dns.reverse` 取 PTR → 只留官方域候选 → 逐个 `dns.lookup(all:true)` 正向确认回原 IP；PTR 有但无官方域 → 缓存 false 并拒绝；DNS 异常/无 PTR → **不缓存**、warn、`{ok:false,checked:false,degraded:true}`（508-522 行保留修正 fail-open 的说明）。所有 DNS 经 `dnsWithTimeout` 3s 超时。

**依赖**：`../config`、`./ipGuard`（`getScore`、懒 require 的 `report`）、`../db`（懒 require）、`ipKeyGenerator`。**数据**：表 `gate_tickets`；头 `X-Pass/X-Fp/X-Sig/X-Timestamp/X-Nonce`；池 5000/20000/8000/5000；阈值 3·1h。

**副作用/失败**：`usedNonces/puzzles/trackFpIp/爬虫缓存` 重启全丢；多实例时 `issuedJti` 不共享 → 票在别的实例一律「通行证无效」；三个池饱和后均 fail-closed。

---

## 观察

1. `server/src/app.js:29` — `formTokenRequired` 引入未用（真正使用在 `routes/comments.js:144`、`messages.js:58`、`links.js:34`），死导入会让人误判闸门链已有表单令牌。
2. `server/src/app.js:53`+`59` — 注释称「仅压缩文本类响应」，代码只判 `typeof body==='string' && length>=1024`，无 `Content-Type` 过滤，也不处理 `gzip;q=0`。
3. `server/src/app.js:62` — `body.length` 是 UTF-16 码元数，1023 个中文≈3KB 就被当「小响应」跳过压缩，与 1KB 阈值语义不符。
4. `server/src/app.js:67` — `gzipSync` 在事件循环上同步压最大 2MB JSON，高并发下是直接 CPU 抢占点。
5. `server/src/app.js:145-158`+`server/src/server.js:61` — 应用层 30s 定时器与 Node `requestTimeout=20s` 重叠，慢速 body 场景 20s 就由 Node 回 408，应用层 408 分支几乎不可能触发；两处阈值应统一。
6. `server/src/app.js:167` — CORS 放行 `origin==='null'`，而 `null` 是任何 `data:`/沙箱 iframe 都能声明的可伪造来源，等于向不透明来源开放跨域读。
7. `server/src/app.js:224`+`247` — `/uploads` 排在 `waf`/`ipGuard` 之前，被封禁 IP 仍可持续拉图片带宽；注释只解释了「省扫描成本」。
8. `server/src/app.js:417-418` — `app.use(`${api}`, rssLimiter, feedRouter)` 的限流器对所有未被前面路由吃掉的 `${api}` 请求生效，404 探测会先烧 RSS 配额并拿 429，导致 `app.js:424` 的 `recordMiss`（阈值 12 次/30s，见 `middleware/waf.js:347`、`utils/securitySettings.js:28`）难以被喂满。
9. `server/src/app.js:177`+`271` — body 解析各 2MB 排在闸门之前，无票请求也能让服务端完成整段 JSON 解析。
10. `server/src/app.js:373-387` — `antiBot` 挂在闸门之后：带 `curl/` 的脚本必须先解 PoW 才会被 403，顺序颠倒可省掉恶意流量的一次 HMAC 校验与哈希。
11. `server/src/config.js:82` — `allowedHosts` 默认仅 `localhost,127.0.0.1,::1` 且不支持通配/子域：生产漏配 `ALLOWED_HOSTS` 会全站 403，配了又必须逐条列出 `xalor.cn`、`blog.xalor.cn`、`www`。
12. `server/src/config.js:46-57` — 开发环境 secret 每进程随机，重启即让 JWT/票据/表单令牌失效，且 `adminPath`（100-104）同步变化，前端缓存的秘钥路径立刻 404。
13. `server/src/config.js:100-104` — `adminPath` 只有 48 bit，且 `/api/anti/admin-path` 会发给任何持票者（`server/src/routes/anti.js:106`），只能算不可枚举，不能当访问控制。
14. `server/src/db.js:31` — `multipleStatements:false` 是 mysql2 默认值，「最后一层保险」属冗余；`36-37` 行注释写「拒绝除零、严格模式」而该行只是 `flags:['-LOCAL_FILES']`，真正的 `sql_mode` 在 59 行，注释与代码错位。
15. `server/src/db.js:52-61` — `SET NAMES` 失败仍 `done(err, conn)` 把连接交回池，排序规则按库默认静默生效且无日志。
16. `server/src/server.js:88-91` — `unhandledRejection` 直接退出进程：任何路由漏写 `.catch` 的一次 DB 异常都会让整站重启。
17. `server/src/middleware/auth.js:34`+`114` — 签发时不校验 `X-Fp` 是否存在/格式；前端漏发会得到一个 `fp` 为空、此后必然被判「设备发生变化」的死 token。
18. `server/src/middleware/auth.js:113-116` — 指纹取自客户端可写的 `X-Fp`，绑定强度等同「token + 一个约定头」，只能挡住不经意的复制。
19. `server/src/middleware/auth.js:22`+`122` — 每个已认证请求都跑一次 `hasTable('sessions')`（information_schema 查询），加两次业务查询共 3 次往返，而池上限仅 10（`db.js:42`），是后台接口的固定开销，完全可以启动时缓存。
20. `server/src/middleware/audit.js:16` — `SENSITIVE_FIELDS.has(key)` 位于白名单循环内、而白名单无敏感键，永不成立（注释自称「为未来扩展」），是死代码。
21. `server/src/middleware/audit.js:33` — 路径在 `res.on('finish')` 用 `req.baseUrl+req.path` 现算，此时已被子路由改写（实测得 `/api/comments/` 这类挂载拼接且带尾斜杠），不是原始 URL。
22. `server/src/middleware/antiBot.js:37` — 放行条件是「UA 含 mozilla/chrome/safari 之一」，`curl -A "Mozilla/5.0"` 即通过；`app.js:373` 的「反爬」注释容易高估其强度。
23. `server/src/middleware/formToken.js:4`+`37` — 头注释称签名含 `ip`，实际输入只有 `fp|ua|path|ts|nonce`（31 行注释自认不绑 IP），文档与实现矛盾。
24. `server/src/middleware/formToken.js:20`+`67-74` — `USED` 纯内存：重启丢一次性语义（60min 内可重放），表满对全体 403「系统繁忙」，多实例互不可见。
25. `server/src/middleware/formToken.js:85` — 蜜罐名种子取 `Date.now().slice(0,8)`，13 位毫秒截前 8 位即 **100 秒**换窗，与 60min TTL 语境不符；且名字本就由 `/api/anti/seed` 明文下发，随机化几乎无防护价值。
26. `server/src/middleware/gate.js:4`+`198` — 头注释称票据绑定「IP+指纹+UA」，签名输入只有 `VERSION|fp|ua|ts|jti`，`issueTicket` 的 `ip` 形参完全未用，`verifyTicket` 也不比对 IP。
27. `server/src/middleware/gate.js:139`+`168-191` — `puzzles` 存了 `ip`，`verifyPow` 从不读它（且先删挑战再校验），冗余字段会误导「有 IP 绑定」的判断。
28. `server/src/middleware/gate.js:312-324` — 签名输入不含 query（`req.path` 已剥离 query），nonce 单次使用压住重放但「签名覆盖范围」的直觉与实现不符。
29. `server/src/middleware/gate.js:294-300`+`149-163` — `usedNonces`/`puzzles`/`issuedJti` 三个全局池饱和即 fail-closed，挑战池还会驱逐未过期条目：分布式刷挑战/刷 nonce 可让正常用户被拒，属共享资源型 DoS 面。
30. `server/src/middleware/gate.js:507-522`+`server/src/app.js:277` — 爬虫 UA 分支在验票之前执行，而「无 PTR/DNS 超时」路径不写缓存：匿名请求只要带 `User-Agent: Googlebot` 就能让服务端每次做 `dns.reverse` 甚至吃满 3 秒超时链。
31. `server/src/middleware/gate.js:272` — `Math.abs(now-ts) > TICKET_TTL` 允许未来时间戳（偏差内），与其它「只接受过去窗口」的校验不一致。
32. `server/src/middleware/gate.js:410`+`69-73` — 爬虫核验用 `ipKeyGenerator(ip,128)`、票据用自写 `normalizeClientIp`（只剥 `::ffff:`、不做 IPv6 前缀聚合），两套归一化并存，同一 IPv6 客户端可能落到不同信誉/缓存键。
33. `server/src/middleware/gate.js:79` — 注释写「最高 6 档」，按默认 `20/24` 实际只有 4 档增量；`POW_DIFFICULTY=12` 时又变成 12 档，注释与配置语义脱钩。

---

## 小结

- `app.js` 的中间件顺序就是安全模型：`压缩 → 安全头 → Host/方法 → CORS → body → 限流 → 静态 → WAF → IP 信誉 → Fetch Metadata → PoW 票据/签名 → 审计 → Referer/时间戳 → 路由`。任何插到 `waf`/`ipGuard`/闸门之前的路由（典型是 `/uploads`）都等于自愿放弃这些防护。
- 访问控制是三张网叠加：`gate.js` 的 PoW 票据 + `X-Sig`（挡爬虫与重放）、`formToken.js` 的一次性 HMAC + 蜜罐（挡表单批量提交）、`auth.js` 的 JWT + 指纹 + `sessions`（管后台身份）。三者密钥都从 `config.jwt.secret` 派生，**轮换 JWT_SECRET 会同时作废票据、表单令牌、adminPath 与全部会话**。
- 闸门状态（票据 jti、挑战、nonce、指纹-IP、爬虫核验、表单 nonce、IP 信誉）都是进程内存 + 局部落库；`gate_tickets`/`ip_bans` 只解决重启不丢，不解决多实例共享——这套骨架隐含「单进程 + 单 MySQL」，横向扩容会直接破坏票据与限流语义。
- 分区边界：本区只负责「进入业务逻辑之前」的一切，以及把身份放进 `req.user`；不涉及业务表结构、正文 AES-GCM（路由层做）、上传校验细节、管理端授权粒度。`config.adminPath` 属本区，但它只是不可枚举路径。
- 整体姿态是 fail-closed（缺会话表 503、DNS 不可核验拒绝、池满拒绝、指纹不符 401），代价是单点资源耗尽会放大成对全体用户的拒绝，池阈值（3000/5000/8000/20000）需与实际流量一起复核。
- 配置层对密钥是启动即崩（`DB_PASSWORD` 强度、生产 `JWT_SECRET`/`ENC_SALT`、`TRUST_PROXY` 禁跳数），但 `ALLOWED_HOSTS` 与 `CORS_ORIGINS` 默认只含本地，是本套代码最容易被误部署的两个点。
