# S2 — IP 信誉、请求守卫、反刮取、WAF 引擎与规则集

覆盖 5 个文件、共 1571 行。定位：`app.js` 全局中间件链的「应用层对抗」层（WAF → 信誉闸门 → 写请求来源校验），加两层独立的内存态检测器（正文刮取窗、规则数据层）。

---

### server/src/middleware/ipGuard.js（501 行）

**职责**：把各类恶意行为折算成信誉积分，过阈自动封禁，并把封禁与安全事件持久化到 MySQL（`ip_bans` / `audit_logs`），内存是运行时权威。

- **关键导出与真实行为**
  - `report(ip, type, path)`（262-321）：先 `decay()` 再取 `securitySettings.getConfig()`；可信 IP 直接返回 `false`（不记分不封禁）；`reputationKey()` 归一键；封禁期内重复上报只 `logEvent` 并返回 `false`（防叠加）。否则 `score += weights[type]`、`strikes += 1`；`score >= banScore` 时做累犯老化（距 `lastBanUntil` 超 `banCountResetDays` 天则 `banCount = 0`）→ `banCount += 1` → `duration = min(baseBanMs * 2^(banCount-1), maxBanMs)` → 清空 `score`、写 `banUntil/lastBanUntil/lastBanReason` → `logEvent('ban')` + `persistBan()` + 可选邮件。返回「本次是否触发封禁」而非「是否记分」。
  - `ban(ip, minutes=43200, reason)`（325-346）：管理员封禁，不累积积分、不入老化逻辑，直接 `banCount += 1` 并写盘；白名单与本机地址拒绝；最短 60 秒。
  - `isBanned(ip)`（349-364）：白名单短路；命中 `banUntil > now` 返回 `true`；已过期则清 `banUntil` 并对 DB 发起**未 await 的** `deletePersistedBan()`。
  - `banRemain(ip)`（367-371）→ 秒；`getScore(ip)`（374-379，被 `gate.js:12` 用于自适应 PoW 难度）；`isBannedNow`（382-384）是 `isBanned` 的纯别名。
  - `ipGuard(req,res,next)`（395-407）：`${apiPrefix}/anti` 前缀直接放行（反爬引导通道），其余 `isBanned` → `Retry-After` 秒数 + `403 {code:1,message:'访问被拒绝'}`。
  - `securityStats()`（410-486）：面板数据。`banned[]{ip,remain,strikes,banCount,reason}`、`events`（DB 最近 50 条 + 内存最近 50 条）、`event_total`、`type_counts`。计数口径：`dbCounts`（近 7 天 `action LIKE 'SEC-EVENT%'` 分组计数）+ `persistQueue` 中尚未 flush 的部分，`ban`/`unban` 合并为 `ban`。
  - `loadPersistedBans()`（176-259）：`banned_until > now` 的 `ip_bans` 行 → 按 `reputationKey` 聚合（`ban_count` 取 max、`banned_until` 取 max）→ 灌入 `records`；旧版精确 IPv6 键写入 `legacyBanKeys` 并在事务里折叠成规范键；loopback 历史行不恢复。
  - `logEvent`（82-86）→ 环形缓冲 300 条 + `queuePersist`；`queuePersist/flushPersist`（97-126）累计 100 条或 30 秒批量 `INSERT`。
- **项目内依赖**：`../config`（`apiPrefix`、`security.alertOnBan`、`adminPath` 未用）、`../db`（Knex，`db.fn.now()`、事务）、`express-rate-limit` 的 `ipKeyGenerator`、`../utils/securitySettings`（`getConfig`/`isTrustedIp`）、惰性 `../utils/notifyMail`。
- **重要数据**
  - 表 `ip_bans`：`ip varchar(64) PRIMARY`、`banned_until`、`ban_count int default 1`、`reason varchar(120)`、`updated_at`（`migrate.js:303-309`，`onConflict('ip').merge()` 依赖主键唯一）。
  - 表 `audit_logs`：`user_id`(0)、`username='security'`、`action='SEC-EVENT <type>'`(≤120)、`detail`(≤200)、`ip`(≤64)、`fp=''`、`created_at`；`action` 承载事件类型，`detail` 缺失时回落到 `path`。
  - 常量：`FALLBACK_WEIGHTS={honeypot:6,waf:3,auth:3,rate:2,scan:2,spam:1}`、`FALLBACK_BAN_SCORE=10`、基础封禁 15min / 上限 24h、`DECAY_MS=30min`、`REPUTATION_MAX=50000`、`REPUTATION_FLOOR=40000`、`BAN_COUNT_RESET_MS=30d`、`EVENTS_MAX=300`、`PERSIST_BATCH_MAX=100`、`PERSIST_INTERVAL=30s`。运行期实际权重/阈值以 `securitySettings` 为准（`banScore=10`、`baseBanMinutes=15`、`maxBanHours=24`、`banCountResetDays=30`）。
  - 环境变量：`TRUSTED_IPS`（经 securitySettings 解析，支持 CIDR）。
  - 状态码契约：仅 `403`（封禁），附 `Retry-After` 秒。
- **副作用与失败模式**：内存 `Map` 是唯一判定源，重启丢失未落库事件与积分（仅封禁有表）；`persistBan/persist/delete` 全部 `.catch(()=>{})` 静默；`flushPersist` 失败后把批次回填到队尾并 `slice(-100)`（丢最旧）；`loadPersistedBans` 用 `dbLoaded` 只尝试一次，DB 启动竞态即永久降级为纯内存；`decay()` 由请求驱动，无流量则不衰减；封禁触发时每封一次调用一次 `notifyMail.send`（内部无 SMTP 时 resolve(false)）。

---

### server/src/middleware/requestGuard.js（85 行）

**职责**：写请求的来源与新鲜度校验——Referer/Origin 同源、`X-Timestamp` 在窗口内；定位为纵深防御而非主防线。

- **关键导出与真实行为**
  - `refererRequired`（40-71）：`req.sigVerified === true` 直接 `next()`（签名已验证视为更强证明）；`Origin: null` 只 `console.warn` 不拒绝；`Origin`/`Referer` 同时存在则用 `safeHost()` 取名比 host，不一致 → `403 来源不合法`；最终 host 必须命中 `PROD_ORIGIN_HOSTS`（由 `config.allowedHosts` 派生，12 行，模块加载期快照）或 `DEV_ORIGIN_HOSTS=['localhost','127.0.0.1','::1']`，否则 `403 来源不合法`。
  - `timestampRequired`（74-83）：`Number(req.headers['x-timestamp'])` 非 `Number.isFinite` → `403 请求时间戳缺失`；`|now - ts| > TIMESTAMP_WINDOW` → `403 请求已过期，请刷新页面`。
  - `safeHost`（20-26）：`new URL()` 事后 `hostname.toLowerCase()` 并剥 `[]`；解析失败返回 `''`（因此 `http://` 畸形头落到空 host 被 66-69 行拒绝）。
  - `isAllowedOriginHost`（29-32）：生产域名 ∪ 本地开发两张表的并集判断。
- **项目内依赖**：`../config`（`allowedHosts`）。
- **重要数据**：`TIMESTAMP_WINDOW = 30 * 60 * 1000`；状态码契约仅 `403`，响应体 `{code:1,message}` 中文分三类（来源不合法 / 时间戳缺失 / 已过期）。
- **副作用与失败模式**：无内存态、无 I/O，纯函数式判定；`console.warn` 是唯一副作用；对 `Origin` 为字面 `null` 的请求只记日志（但随后仍会因取不到 host 而 403）。

---

### server/src/middleware/scrapeGuard.js（61 行）

**职责**：单会话短窗口内读太多不同正文时判定为刮取，供文章/手记详情路由拒绝（429）并计信誉。

- **关键导出与真实行为**
  - `noteArticleRead(ip, fp, slug)`（34-49）：按 IP 分桶 `{hits, slugs:Map, start}`；超过 `WINDOW_MS` 重置窗口；每次 `hits += 1` 并 `slugs.set(slug, now)`；`slugs.size > MAX_UNIQUE(12)` 或 `hits > MAX_HITS(24)` 返回 `{ok:false, reason:'scrape'}`，否则 `{ok:true}`。**新增桶时才** `prune()`。
  - `readerKey(ip)`（14-17）：只按 IP（`String(ip||'unknown')`），显式忽略指纹。
  - `resetScrapeGuard()`（51-53）：测试用清空。
- **项目内依赖**：无（纯内存模块，被 `routes/articles.js:203`、`routes/notes.js:92` require）。调用方在 `!ok` 时 `report(req.ip,'rate',...)` + `429`；两处均以 `req.headers['x-pass']` 存在为前置，搜索引擎爬虫走免票通道因而不进桶。
- **重要数据**：`WINDOW_MS=45s`、`MAX_UNIQUE=12`、`MAX_HITS=24`、`MAX_KEYS=8000`（淘汰至 6000）；阈值判定是 `>`，即第 12 个不同 slug 仍放行、第 13 个开始拒绝。
- **副作用与失败模式**：纯内存、重启清零；超阈后仍持续写 `slugs`；淘汰按 `Map` 插入序（建桶顺序），非 LRU；`articles` 与 `notes` 共用同一 IP 桶（`note:` 前缀只区分 slug 值，不区分计数器）。

---

### server/src/middleware/waf.js（657 行）

**职责**：应用层 WAF 引擎——多视图解码 + 规则评分 + 行为检测（蜜罐/扫描器 UA/404 爆破/UA 轮换/JSON 炸弹/请求走私），命中联动 `ipGuard.report`，按累计分过阈才 403。

- **关键导出与真实行为**
  - 变换流水线：`decodeLevel1`（41-47，`+`→空格后 `decodeURIComponent`）、`decodeLevel2`（49-79，二次 URL 解码 + HTML 实体/数字实体 + `\uXXXX` + IE `%uXXXX` + `\t\n` 字面转义→空格 + 全角 U+FF01–FF5E→半角 + U+3000 + 最多 3 轮循环解码）、`buildVariants`（83-90，原文/一层/深度三层，去重后返回）。
  - `scanSegments`（145-152）+ `SCAN_*`（113-121）：>4000 字符的值切重叠窗（步长 3488，重叠 512，最多 16 段），逐字覆盖上界 `SCAN_FULL_COVER = 56320`；超出部分不扫但整值判可疑（`TRUNCATED_RULE_ID='WAF-TRUNCATED'`，critical=5，236-245 行）。
  - `scopeGroups`（97-109）：按 `sec.groups` 生成激活组顺序 SQL→XSS→TRAVERSAL→CMD→SSRF→MISC；SSRF 仅 `query`/`path`。
  - `prepareScan`（155-166）：按段分别构建变体（避免跨段解码假命中）+ 一次性 `disabled` Set。
  - `runGroupRules`（169-199）：`zones` 面过滤 → `pl > paranoiaLevel` 跳过 → `disabledRules` 跳过 → `skipGroups` 用 `RULE_INDEX[id].group` 比对（而非 ID 前缀）→ 对每个变体 `rule.re.test(v)`，首命中即 `break` 并记录 `{id,group,note,sev,score,pl,variant}`。
  - `scanAll(text, scope, {urlKey, skipGroups, truncationLimit})`（216-255）：超长判定 + 各组规则 + 非 body 面的 `crlfCheck`（202-210，`MSC-CRLF` error=4）；返回 `{hits, score}`。`scanText`（261-264）取首命中，`detectAttack`（267-270）返回组名。
  - `scanRequestBody`（303-342）：递归 `walk`，键名自身也扫，值走 `scanAll(...,'body')`；豁免来自 `PARAM_EXEMPT_GROUPS`（`Object.hasOwn` 取自有属性）；`URL_FIELD_RE` 命中且无豁免时对 body 补开 SSRF；豁免字段的合法长度上限放到 `BODY_FIELD_MAX_LEN=100000`；`scanned` 上限 200 个字符串、命中 >32 提前返回。
  - 行为检测：`isScannerUA`（275-279，子串匹配 60+ 工具/爬虫标识）、`isInAppBrowserUA`（281-285，仅用于放宽 UA 长度到 2048）、`trackUaRotation`（370-393，5 分钟 ≥6 个不同 UA，且 `markUaReportedOnce`（406-410）保证跨阈值只上报一次）、`bodyShapeSafe`（418-433，深度 20/数组 1000/键 1000）、`trackMiss`（435-455，30 秒窗口 ≥`scanThreshold`）。
  - `waf(req,res,next)`（463-618）判定顺序：`Cache-Control: no-store` → 方法白名单（403）→ CL+TE 走私（400）/重复头（400）→ URL >8KB（403）→ 单头 >8KB（403）→ 头数 >60（403）→ 蜜罐（剥 `apiPrefix` 后命中且非 `/${adminPath}` 前缀，404）→ 扫描器 UA（403）→ UA 超长（403）/UA 轮换（只记分）→ query 键 >200（403）→ path（`/slug/*` 段归一化）/query/header/body 全量扫描 → 键名注入一票 403 → `score >= anomalyThreshold` 403 → 低分只 `logEvent('waf-mon')`。
  - `recordMiss(ip, path)`（631-643）：404 处理器用，静态资源/根/`robots.txt`/`sitemap.xml`/`rss.xml` 与 `MISS_EXEMPT_RE`（350-362，favicon/图标/manifest/`.well-known`/feed/health）不计；过阈 `report(ip,'scan')` 并返回 `true`（`app.js:424-426` 因此把 404 升级成 403）。
  - 导出聚合（645-657）：`waf, scanText, scanAll, detectAttack, recordMiss, isScannerUA, scanRequestBody` + 再导出 `HONEYPOT_SET/RULE_INDEX/RULE_GROUPS/SEVERITY_SCORE`；`admin.js:20` 与 `test/waf-fixtures.test.js:14` 均从本文件取规则元数据。
- **项目内依赖**：`./ipGuard`（`report`、`logEvent`）、`../config`（`apiPrefix`、`adminPath`）、`../utils/securitySettings`、`./waf-rules`（8 个导出全用）。
- **重要数据**：表/环境变量无直接读写（事件经 ipGuard 落 `audit_logs`）。关键配置键：`groups.*`、`disabledRules[]`、`scannerUaBlock`、`honeypotEnabled`、`scan404Enabled`、`scanThreshold=12`、`paranoiaLevel=1`、`anomalyThreshold=5`；严重度权重 critical=5/error=4/warning=3/notice=2，故单条 critical 即达默认阈值。`CHECK_HEADERS=['cookie','x-forwarded-for','x-real-ip','referer','x-requested-with','x-auth-token','authorization']`。状态码：`400`（走私/重复头）、`403`（其余全部拒绝）、`404`（蜜罐，与 `app.js:427` 的真 404 同体 `{code:1,message:'访问被拒绝'}`）。
- **副作用与失败模式**：三张内存 `Map`（`scanTracker`/`uaTracker`，加 ipGuard 的 `records`）无持久化；`report` 只加分不阻断，阻断由本层的 `403` 完成；解码全在 try/catch 内（畸形 `%` 不抛）；规则正则无超时保护，成本靠分块/视图去重/`MAX_SCANNED_VALUES` 约束；`res.set('Cache-Control','no-store')` 对全链生效（与 `app.js:194-202` 重复设置）。

---

### server/src/middleware/waf-rules.js（267 行）

**职责**：纯数据层——规则数组、严重度权重、规则索引、参数豁免表、UA/蜜罐清单，不含任何逻辑分支。

- **关键导出与真实行为**
  - `SEVERITY_SCORE`（18）：`{critical:5,error:4,warning:3,notice:2}`（注释说 CRS 同权重，实际 CRS 是 5/4/3/2 的 critical/error/warning/notice）。
  - 规则工厂 `R(id,re,note,sev='error',pl=1,zones=null)`（22）与 `NET_ONLY=['query','path','header']`（23）。
  - 六个规则组共 **107 条**：`SQL` 31 条（UNION/SLEEP/BENCHMARK/`@@version`/`information_schema`/`into outfile`/堆叠/注释混淆…）、`XSS` 24 条（`<script`/事件处理器/伪协议/`data:text/html`/`srcdoc`/`formaction`/`attributeName`/实体与 `\u` 编码…）、`TRAVERSAL` 10 条（`../`、`%2e%2e`、`%c0%ae` 超长 UTF-8、双编码、空字节…）、`CMD` 11 条（反引号/`$()`/`${}` 仅网络面，`;`/`|`/`&&`/`||` 接命令 + `${IFS}` + `/dev/tcp` + `chmod`）、`SSRF` 11 条（回环/10/192.168/172.16-31/169.254/十六进制/十进制/八进制变形/非 HTTP 协议/云元数据）、`MISC` 20 条（XXE、JNDI、FastJSON、OGNL/SpEL、`__proto__`、SSTI、Java 反序列化链）。
  - `RULE_GROUPS`（164-171）→ `RULE_INDEX`（174-177）由循环生成 `{id,group,note,sev,pl}`，是引擎做组归属与安全中心禁用校验的唯一权威（`admin.js:2028` 用它过滤非法规则 ID）。
  - `PARAM_EXEMPT_GROUPS`（184-204）：18 个 body 键 → 豁免组数组（`content/about_content/title/summary/description/name/site_*/announcement/footer/social_*/avatar/color/ip/form_token`），当前每个键都列满六组。
  - `URL_FIELD_RE`（207）：`url|link|site|website|homepage|callback|redirect|next|target|src|href|source|domain|host|feed|icon|logo|image|img|cover|avatar|webhook|endpoint|origin` 前缀匹配，用于给 body 补充 SSRF 扫描。
  - `SCANNER_UA_PATTERNS`（210-226）：扫描器（sqlmap/nuclei/ffuf…）+ 无头浏览器（headless/webdriver/selenium/phantomjs）+ AI/SEO 爬虫（claudebot/gptbot/bytespider/ahrefs/semrush/shodan/censys…）共约 90 条子串。
  - `INAPP_BROWSER_MARKERS`（228-235）：微信/QQ/支付宝/UC/夸克/飞书/微博/知乎/抖音/各厂商浏览器，仅用于 UA 长度豁免。
  - `HONEYPOT_PATHS`（237-256）：约 120 条（`/wp-admin`、`/.env`、`/.git`、`/backup.sql`、`/actuator`、`/swagger`、`/phpmyadmin`、`/api/admin`、`/cve-2017`…）。
- **项目内依赖**：无（叶子模块，仅被 `waf.js` 与测试引用）。
- **重要数据**：无表、无环境变量；`pl` 分层是唯一可调档次（1 默认 / 2 高误杀面 / 3 预留但当前无规则使用）。
- **副作用与失败模式**：模块加载即构建 `RULE_INDEX`，同 ID 重复会静默覆盖（依赖 `test/waf-fixtures.test.js:58-64` 的覆盖率门禁发现缺口）；`pl3` 档存在配置区间（`securitySettings` 允许 1-3）但无规则，调到 3 不产生任何新检测。

---

## 观察

**装配与可达性**

- `server/src/middleware/requestGuard.js:46` — `req.sigVerified === true` 在默认装配下恒为真：`app.js:291` 对所有非 `GATE_SKIP` 写请求强制 `gateWriteRequired`，而 `gate.js:362` 验签成功即置位；`app.js:304` 又把 `GATE_SKIP` 路径排除在 `refererRequired` 之外，因此 `Origin/Referer` 判定在本仓库里不可达，实际只剩 `timestampRequired` 生效。
- `server/src/middleware/requestGuard.js:54` — `Origin: null` 只 warn 后继续，但 `safeHost('null')` 抛错返回空串，随后 67 行仍 `403`；注释「不再直接拒绝…避免误杀」与实际行为相反（该分支同样受上一条影响而不可达）。
- `server/src/middleware/waf.js:470` — 方法白名单与 `app.js:114-121` 完全重复，且 `app.js` 在前先返回 `405 方法不允许`，本文件这段在生产链路是死代码；两处状态码不一致（405 vs 403 + 计分）。
- `server/src/middleware/waf.js:267` — `detectAttack` 仅被注释称为「测试/调试用」，`src/` 内无调用点，属兼容性死代码。
- `server/src/middleware/ipGuard.js:382` — `isBannedNow` 是 `isBanned` 的纯别名，全仓无引用。
- `server/src/app.js:247` — `waf` 挂在 `ipGuard` 之前，被封禁 IP 的每个请求仍要付全量特征扫描成本后才被 403；把 `ipGuard` 前移可直接省掉这部分 CPU。

**逻辑与安全**

- `server/src/middleware/waf.js:118` — 重叠量 512 的前提是「所有带长度上界的规则最长 60/80」，但 `XSS-04`(`waf-rules.js:66`) 与 `XSS-24`(`:86`) 的 `[^>]*` 无上界：构造 `<div ` + 600 字符填充 + ` onload=alert(1)>` 恰好跨 3488 边界时会被切成两段而漏检。
- `server/src/middleware/waf.js:326` — 豁免只按「键名」判、不限制深度也不绑定端点，`{"wrap":{"content":"<script>…"}}"` 同样被豁免；与 `waf-rules.js:183` 注释「嵌套子对象不受豁免影响」的表述容易被读成相反。
- `server/src/middleware/waf-rules.js:198` — `avatar` 同时在 `PARAM_EXEMPT_GROUPS`（豁免 `SSRF`）与 `URL_FIELD_RE`（`:207`，明确视为 URL 字段）里，两处数据互相抵消：该字段永远不会走 SSRF 规则。
- `server/src/middleware/waf-rules.js:251` — `/api/admin`、`/api/login`、`/api/token` 等蜜罐项在默认 `API_PREFIX=/api` 下永不可达：`waf.js:508-511` 先把前缀剥掉，514 行的两次 `HONEYPOT_SET.has()` 用的都是剥后值。
- `server/src/middleware/waf-rules.js:57` — `SQL-31`（`/\* … \*/` 内联注释）是 `pl1` + `error`(4)，而同类「技术讨论常见形态」的 `SQL-20/24/27` 都放在 `pl2`；搜索词里出现一次 `/*x*/` 再加任意一条 `warning` 就过阈 403，分级口径不一致。
- `server/src/middleware/waf.js:435` — `trackMiss` 没有 `markUaReportedOnce` 式的「跨阈值只报一次」，过 12 次 404 后同窗口内**每个** 404 都 `report('scan')`（权重 2）；同一文件 `:392-410` 刚为 UA 轮换修过同类问题，两处口径不一致。
- `server/src/middleware/ipGuard.js:311` — `config.security.alertOnBan` 在 `config.js:106-128` 与全仓都不存在，`!== false` 恒真，告警开关无法关闭；未配 SMTP 时仅靠 `notifyMail.send` 内部 `resolve(false)` 兜底（`utils/notifyMail.js:99`），且每次封禁都新建 transporter。
- `server/src/middleware/ipGuard.js:325` — `ban()`（管理员手动封禁）不做 `banCountResetDays` 老化，且同样 `banCount += 1`；攻击者被手动封一次后，下一次自动违规直接翻倍（30 分钟起）。
- `server/src/middleware/ipGuard.js:177` — `dbLoaded = true` 写在 `try` 之前、异常被 `:256` 空 catch 吞掉：DB 未就绪时持久化封禁在**该进程生命周期内永久不加载**，无重试、无日志。
- `server/src/middleware/ipGuard.js:361` — `isBanned` 这条读路径上发起未 await 的 `DELETE`，到期 IP 首次被探测时并发请求会重复删同一行；读路径混写库。
- `server/src/middleware/ipGuard.js:476` — 注释写「去重合并」，实现只是 `persisted + memory` 拼接：已落库事件同时在 DB 与内存环形缓冲里，面板会出现重复条目；且 DB 50 条整体排在内存事件之前，与 `:442` 「按时间倒序合并」不符。
- `server/src/middleware/ipGuard.js:122` — flush 失败把批次回填队尾后 `slice(-100)`，正在排队的新事件会把旧批次挤出丢弃（取证数据静默丢失），且失败后不重排定时器，无流量则永不落库。
- `server/src/middleware/ipGuard.js:283` — `weights[type] ?? FALLBACK_WEIGHTS.rate` 让未知类型一律按 `rate` 计；而 `securitySettings` 的 `weights`（`:36`）没有 `scan` 键、`NUMERIC_RANGES` 也没有 `weights.scan`，404 扫描权重虽在 `FALLBACK` 里存在却无法配置。
- `server/src/middleware/ipGuard.js:69` — `decay()` 由请求驱动且每次衰减后重置 `updatedAt`：空闲 5 小时的记录只减半一次，`DECAY_MS` 注释的「每 30 分钟衰减一半」只在持续有流量时近似成立。
- `server/src/middleware/scrapeGuard.js:44` — 超阈后仍无条件 `slugs.set()`：45 秒窗口内单 IP 的 Map 随请求数线性增长，高频刮取时构成内存放大面。
- `server/src/middleware/scrapeGuard.js:14` — 只按 IP 分桶，`articles.js:203` 与 `notes.js:92` 共用同一桶，`note:` 只前缀了 slug；读 12 篇文章再读手记会立刻撞 `MAX_UNIQUE`，多标签正常读者更易误伤。
- `server/src/middleware/scrapeGuard.js:19` — `prune` 只在新建桶时触发、按 `Map` 插入序淘汰，攻击者用大量 IP 轮换即可把正在累积的真实桶挤出（无 LRU）。

**性能与成本**

- `server/src/middleware/waf.js:162` — 变体去重用 `variants.includes(v)`（全字符串比较），最坏 48 个 4000 字符视图 ≈ 千万级字符比较/值；配合 107 条规则 × 最多 48 视图、`MAX_SCANNED_VALUES=200`，单请求正则执行上界达百万量级。
- `server/src/middleware/waf.js:192` — 命中路径上做 `variants.indexOf(v)`，循环里本就有下标，纯属 O(n) 浪费，且同值多命中时重复计算。
- `server/src/middleware/waf.js:590` — `scanRequestBody` 返回的 `score` 与 `scanned` 都无消费者（`:599` 直接用 `hits` 重算），成本统计字段未接线。
- `server/src/middleware/waf.js:236` — 超长判定的 `hits` 在 `:336` 的 `hits.length > 32` 早退下可能被截断，面板 `topIds` 只反映前若干条命中（请求判定不受影响，因早已过阈）。
- `server/src/middleware/waf.js:614` — 低分命中 `logEvent('waf-mon')` 会经 `queuePersist` 落 `audit_logs`：监控噪声与管理员操作日志同表、同 90 天清理策略（`server.js:39`），高频可疑扫描可在审计表堆行。
- `server/src/middleware/waf.js:580` — 头部只扫前 2000 字符（上限 8192），尾部特征免检；属成本取舍但契约未在注释中写明。
- `server/src/middleware/ipGuard.js:183` — `.limit(REPUTATION_MAX)` 复用了内存表的硬上限常量（50000），两个语义耦合：调内存水位会连带改动启动恢复条数。

**注释与代码不一致**

- `server/src/middleware/requestGuard.js:4` — 头注释写「±5 分钟窗口」，`:74` 函数注释同样写 ±5 分钟，实际 `:17` `TIMESTAMP_WINDOW = 30 分钟`；且 `gate.js:21,309` 已用 `security.sigWindow`（5 分钟）校验同一请求头，本中间件的 30 分钟永远更宽松。
- `server/src/middleware/requestGuard.js:75` — `Number(...)` 接受 `1.7e12`、`0x…`、带空格等形态，`gate.js:307` 用 `/^\d{10,13}$/` 严格校验，同一请求头两套解析口径。
- `server/src/middleware/waf.js:142` — 注释称「`cleanMarkdown` 上限 50000」，实际 `BODY_FIELD_MAX_LEN=100000`（`:301`）、`admin.js:179` 与 `sanitize.js:125` 默认值均为 100000，50000 是陈旧数字。
- `server/src/middleware/waf.js:636` — 手写豁免 `'/robots.txt'`、`'/sitemap.xml'`、`'/rss.xml'` 与 `MISS_EXEMPT_RE`（`:357-360`）重复声明同一批路径，两条豁免通道需同步维护。
- `server/src/middleware/scrapeGuard.js:35` — `readerKey(ip, fp)` 声明两参但函数只收一个，`fp` 由调用方照传（`articles.js:203`）却完全不参与，接口噪音。
- `server/src/middleware/waf.js:645` — `waf.js` 再导出 `RULE_INDEX/RULE_GROUPS/SEVERITY_SCORE/HONEYPOT_SET`，`admin.js:20`、`test/waf-fixtures.test.js:14` 因此从引擎而非数据层取规则元数据，依赖方向绕行。
- `server/src/middleware/waf-rules.js:181` — 注释强调「按组裁剪」是数据化的收益，但 18 个键全部列满六组（等于旧的整键豁免），该能力当前没有被使用，复制粘贴错一组的风险却是实的。

---

## 小结

1. 这五个文件构成一条**分层的抗滥用带**：`waf`（特征/行为，命中即计分或硬拦）→ `ipGuard`（把散落各处的 `report()` 汇总成积分与封禁）→ `requestGuard`（写请求来源/新鲜度）→ `scrapeGuard`（正文读取节奏）；规则文本全部下沉到 `waf-rules.js`，引擎只做调度与评分。
2. **权威在内存，持久化只是冷启动快照**：`records` / `buckets` / `scanTracker` / `uaTracker` 四张表重启即清零；只有 `ip_bans`（封禁）与 `audit_logs`（`SEC-EVENT *` 事件）落地，而 `loadPersistedBans` 只尝试一次且异常静默。
3. **拒绝响应是统一契约**：`403 {code:1,message:'访问被拒绝'}` 覆盖封禁、WAF、Host 校验与 404 升级，蜜罐用 `404` 与真 404 同体（`app.js:427`）——路由存在性不可从响应体枚举；仅请求走私/重复头用 `400`，方法不支持用 `405`。
4. **与相邻分区的接口很窄**：对 `gate.js` 只暴露 `getScore`（自适应 PoW 难度）与 `sigVerified` 旁路；对路由层只暴露 `report`/`ban`/`unban`/`securityStats`/`noteArticleRead`/`recordMiss`；对 `admin.js` 暴露 `RULE_INDEX` 与 `scanAll`（安全中心规则测试器）。
5. **边界在 `/uploads` 与爬虫放行通道**：静态上传目录挂在 `waf` 之前（`app.js:224`）不付扫描成本，`/api/anti*` 免信誉封禁（`ipGuard.js:400`）、`GATE_SKIP` 免票据并跳过 `refererRequired`，这三处是有意开口，也是本层防护的真实缺口所在。
6. **成本约束靠常量而非超时**：分块 16×4000、变体 ≤3、单请求 ≤200 个字符串、单值 >100KB 判可疑——全部是经验阈值；任一规则写出无上界的 `.*` 式正则（如 `XSS-04`）都会同时放大 CPU 与漏检面，改动规则必须回跑 `test/waf-fixtures.test.js` 的覆盖率与良性语料门禁。
