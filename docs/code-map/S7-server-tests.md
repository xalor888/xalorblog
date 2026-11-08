# S7 · 服务端测试套件

统一是手写 assert（`passed/failed/failures` + `assert(name, cond, extra)`），无 jest/mocha。`package.json:17` 的 `test` 用 `&&` 串 15 个"无 DB"套件；`test:all` 走 `test/run.js`（先 DELETE `ip_bans`、重置 `users.totp_*`、清本机 comments/messages/links/notes，再重启服务，跑 16 个 HTTP 套件）。故"能起"≠"能在链里跑"。

### server/test/sanitize.test.js（137 行）

职责：`src/utils/*` 清洗函数的放行/拒绝契约总表。
实际行为：`safeEmail` 拒 `\r\n` 注入与空/非字符串；`safeUrl` 双表锁 SSRF——拒 `localhost.`、`.internal`、`.lan`、`.home`、点分十进制 `2130706433`、`0x7f000001`、`0177.0.0.1`、`127.1`、`user:pass@`、`javascript:`/`data:`、`localtest.me`/`lvh.me`/`127.0.0.1.nip.io`，放行 `https://example.com`；`safeCover` 只认 `/logo.png`、`/uploads/<name>`、`https://`，拒 `/uploads/../logo.png` 与 `" onerror=`；`cleanMarkdown` 留 fenced code 与 `<div>`、剥 `script`/`iframe`；`plainText` 出 `标题 正文链接`；`slugify` 保留中文、冲突给 `test-1`；`matchesCidr` 含 `::ffff:` 映射；`formToken.issueToken/verifyToken` 绑 `x-fp`+`ua`+`ip`+路径，跨路径/换指纹均失败；`antiSpam` 第 4 条链接 `ok:false`；`localModeration('免费代刷网')>=20`；`stripExif` 用自建 JPEG 验 APP1 被摘且 SOI/图像数据保留。
依赖：utils/{sanitize,securitySettings,notifyMail,aiModeration,markdownText,slugify,ownerBadge,antiSpam,stripExif}、routes/articles、middleware/formToken。
数据：`shouldCountView` 5 分钟设备窗（首次 true → 同设备 false → 换 article 独立）；bad case 以 `process.exit(1)` 退。
副作用：require routes/articles 会拉起 config（`src/config.js:31-39`，`DB_PASSWORD` 缺失/短于 16/默认值直接 throw），"无 DB"仍需配置。

### server/test/feed.test.js（37 行）

职责：锁 RSS HTML 白名单，防 Markdown 变 XSS 载体。
实际行为：一次喂 `<script>`、`onerror` 的 `<img>`、`javascript:` 锚、`<iframe>`，四类全消而合法 `href="https://example.com"` 保留；关键一条是 `mdToHtml('[bad](//evil.example)')` 后 `evil.example` 必须消失（协议相对 URL 也要拦，只拦 `javascript:` 的实现会漏）。
依赖：routes/feed（`sanitizeRssHtml`、`mdToHtml(baseUrl)`）。

### server/test/requestGuard.test.js（206 行）

职责：mock `req/res` 驱动 `refererRequired`/`timestampRequired` 的拒绝分支——这些分支在 HTTP 集成里不可达（CORS 先拦外域、gate 先拦无签名）。
实际行为：旁路只认 `req.sigVerified`（`gateWriteRequired` 验签后写入），裸 `X-Sig: deadbeef` 仍 403，为核心回归；拒绝消息统一 `'来源不合法'`；拒 `Origin:null`、双头不一致、后缀伪装 `localhost:5173.evil.com`（精确 host 匹配）、非法 URL；放行 `localhost:5173`、`127.0.0.1:8080`、`[::1]:8080`。时间戳缺头/非数字 → `'请求时间戳缺失'`，±31 分钟 → `'请求已过期，请刷新页面'`，±29 放行（窗 ±30 min）。E 段用真实 `gate.issueTicket` 票据按 `hmac(token,"POST|/comments|ts|bodyHash|jti|nonce")` 自签，断言 `sigVerified===true`；伪签名 403 且不写标记。F 段验证读请求 `gateRequired` 同样要签名。
依赖：`./client`（`hmac`/`sha256hex`）、middleware/{requestGuard,gate}。
数据：`FP='a'.repeat(64)`、Chrome126 UA、403 三种消息。失败模式：`mockRes` 只实现 `status/json`，中间件改用 `res.end` 会崩在调用处。

### server/test/likeGuard.test.js（45 行）

职责：声称直测点赞键语义（"换 fp 不可绕"）。
实际行为：首次 true、紧跟同 `(ip,aid)` false、`aid+1` true、`LIKE_WINDOW>=8000`、另一 IP 对同 `aid` true。`canLike(ip, articleId)` 键为 `ip:articleId`，值 `now+LIKE_WINDOW`（`src/routes/articles.js:16-23`，=10000ms）。
依赖：routes/articles（连带 config/knex）。数据：`203.0.113.7`/`aid=42`/`198.51.100.9`。副作用：写模块内 `likeGuard` Map，顺序即状态。

### server/test/scrapeGuard.test.js（52 行）

职责：刮取窗的两维——独立篇数与同篇命中数——各自触发 `reason:'scrape'`。
实际行为：`MAX_UNIQUE=12` 时第 13 篇拒；`MAX_HITS=24` 时第 24 次仍 `ok`、第 25 次拒；不同 IP 窗口独立；同 IP 轮换 12 个 fp 仍计入窗（键只含 IP）。每段前 `resetScrapeGuard()`。
依赖：middleware/scrapeGuard。副作用：纯内存 Map，进程退出即失。

### server/test/contentCrypto.test.js（33 行）

职责：按篇密钥——同票≠同密钥，解不开一律返回 `null` 不抛错。
实际行为：同票同 slug 可解、换 `'other'` 为 null、不带 slug 为 null、`encA!==encB`、换票 null；`encryptPayload(plain,ticket)` 旧格式（无篇密钥）仍可解，兼容分支显式保留。
依赖：utils/crypto（内部取 `config.security.encSalt`）。数据：`ticket="<ts>.deadbeefcafebabe.sig"`（`ts.jti.sig`）。

### server/test/notesCrypto.test.js（46 行）

职责：手记复用文章加密但密钥换 `note:<id>`，专防命名空间漏写撞车。
实际行为：`noteContentKey(1)==='note:1'`；同票同手记可解、换手记 null、无密钥 null、换票 null；双向隔离（文章密钥解不开手记密文，反之亦然）；把密文 base64 解码断言不含明文片段 `个人主页`。
依赖：utils/crypto、routes/notes（`noteContentKey`，`src/routes/notes.js:28`）。

### server/test/homeSummary.test.js（98 行）

职责：`/api/home/summary` 是唯一免票读接口，把暴露面锁成字段白名单。
实际行为：顶层键集合与 `SUMMARY_FIELDS` **完全相等**；无 `site_url`、有 `icp`；深扫序列化结果不得含 `ai_api_key`/`websearch_api_key`/`ai_system_prompt` 及其值；`stats.note_count===7`、`article_count` 为 number；`recent_posts` 只带 `cover,id,published_at,slug,summary,title`、`links` 只带 `avatar,description,id,name,url`、`hero` 恰好 greeting/quote/role/status、`social` 恰好 email/extra/github/weibo。`about_excerpt` 空则截 `about_content`，显式值优先。`parseSocialExtra`：非数组/坏 JSON → `[]`、缺 label 或 url 丢弃、超 8 条截断、`javascript:`/`data:`/`//evil.com` 全丢、http(s) 留。`runningDays` 非法值回落 2024-01-01。
依赖：routes/home（`buildSummary`/`parseSocialExtra`/`runningDays`/`SUMMARY_FIELDS`）。数据：settings 夹具塞入 `sk-should-never-leak`、`tvly-…`、`secret prompt`。

### server/test/browserCrypto.test.js（71 行）

职责：用 `webcrypto` 复刻浏览器 AES-GCM，证明布局 `iv(12)|tag(16)|ct` 与"把 iv 拼进密文"必失败。
实际行为：`HMAC-SHA256(encSalt, ticket[|articleKey])` 派生 32 字节 → AES-GCM；`ct||tag` 解回原文；`iv||ct||tag` 必须抛错（负向断言证明偏移是真的）。
依赖：`crypto.webcrypto`、utils/crypto、`src/config`。数据：`tagLength:128`、明文 `# hello\n正文`。

### server/test/moderationPolicy.test.js（76 行）

职责：审核分层——归一化、变体垃圾必进待审/拒绝级、正常技术零误伤。
实际行为：`normalizeForSpam` 全角折叠、去零宽 `\u200B`、同形折叠（`ⅴ∨ν→vvv`）、**删全部空白**、大小写折叠；`assertFlagged` 判 `>=PENDING_SCORE`、`assertHits` 只判 reasons 含检测点、`assertClean` 判 `<PENDING_SCORE`。命中：插空格、全角、`搜索薇信`、`加∨信`、零宽断词、`微信号：abc_12345`、`@spam_deal_01`（"联系方式引流"）、`example.shop` 裸域名。叠加用例 `刷单…加微信号…领红包` 必 `>=REJECT_SCORE`。零误伤含 `watchEffect`、`vuejs.org`、`3.14`。
依赖：utils/aiModeration（`localModeration`/`normalizeForSpam`/`PENDING_SCORE`/`REJECT_SCORE`）。风险：只做方向性断言，权重调整仅能被"是否越线"捕获。

### server/test/allowWords.test.js（133 行）

职责：`allowWords` 是硬拒层唯一出口，锁**位置语义**——豁免词须与被命中词重叠或直接相邻。
实际行为：`setConfigForTest({customSensitiveWords:['垃圾','加微信','博彩'], allowWords:['回收']})`（内存注入不落库），六条用例对 `checkSensitive` 结果做集合相等：`垃圾回收机制→[]`、`垃圾回收，加微信领取→['加微信']`、`…博彩网站推荐→['博彩']`、`垃圾处理技术讨论→['垃圾']`、`加微信领取优惠→['加微信']`、`回收站里全是垃圾→['垃圾']`。再直测 `isAllowedText`：相邻 true、隔一标点 false、豁免词在前不相邻 false、无命中词 false、不传 matchedWord 退化为"是否含豁免词"。另验空 allowWords 不豁免、豁免词两次只有一处相邻仍豁免。
依赖：utils/{securitySettings,antiSpam}。数据：`process.env.DB_PASSWORD` 第 46 行补 `'test-only-placeholder-16'`。副作用：内存配置改后不恢复，同进程后续套件继承。

### server/test/waf-fixtures.test.js（95 行）

职责：语料驱动回归——每条规则必有必命中样本，真人内容必放行，抽样验评分。
实际行为：`attack.json` 113 条逐条断言 `hits` 含该 `id`；`pl2` 样本临时 `paranoiaLevel:2` 再恢复 1；`runCase` 三态——`c.body` 直扫、`c.key`+`c.value` 走 `scanRequestBody`、否则 `scanAll(value, scope||'query', keyword?{skipGroups:['SSRF']}:{})`。覆盖率门禁遍历 `RULE_INDEX`（107 条）要求全被覆盖并反向校验 ID 合法。`benign.json` 36 条按 `verdict`：`clean` 零命中、`monitor` 需 `0<score<THRESHOLD`（`anomalyThreshold` 默认 5）。抽样验单条 SQLi 过阈、`admin'--` 不过阈、正常中文零命中。
依赖：middleware/waf、utils/securitySettings、`./waf/fixtures/{attack,benign}.json`。

### server/test/readingStats.test.js（230 行）

职责：`GET /api/stats/reading` 契约脱离 DB 锁死，并强制前后端字数口径一致。
实际行为：`countWords`——空/null 0、纯中文逐字、纯英文按词、`Vue3使用`=3、`#` 不计、链接只算锚文本、图片 0、fenced code 0、行内 code 留字。`buildReadingStats`——空库 `longest===null`、`avg_words===0` 非 NaN、字段恰五个；非数组/含 null 降级；草稿全排除；混排只留 published；并列最长留先出现者；全空正文仍计篇且 `longest.words===0`。时长对**总量** `ceil`：1→1、350→1、351→2、701→3，并用"100 篇×10 字→3 分钟"反证逐篇取整（会得 100）。投影：缺 `status` 一律不计（宁可 0 篇不混草稿），`READING_FIELDS` 须含 status 且恰为 `['content','slug','status','title']`。末段 `await import('../../web/src/utils/wordStats.js')` 对 17 条语料比对 `countWords` vs `web.countWords().total`、`WORDS_PER_MINUTE` vs `web.CN_WPM`、`buildReadingStats` vs `web.aggregateReading`。
数据：`WORDS_PER_MINUTE=350`、`longest={title,slug,words}`；需 Node 支持 `file:` ESM。

### server/test/cacheInvalidation.test.js（82 行）

职责：静态扫描源码，断言每个文章写入路径都调了 `invalidateReadingCache()`（漏调的代价是"发布后统计旧 60 秒"，运行时不可观测）。
实际行为：读 `admin.js`/`stats.js` 文本；断言 stats 导出该函数且体内同时 `readingCache=null` 与 `readingCacheAt=0`；断言 admin 引入 `./stats`；对 7 个路由签名（`post('/articles'`、`put('/articles/:id'`、`duplicate`、`delete('/articles/:id'`、`batch-delete`、`batch-update`、`admin/import`）各切片到下一个 `\nrouter.`，要求片内含该调用；末尾确认 `summaryCache` 未被误删。
数据：`READING_TTL=60*1000`；实测 admin 共 8 处调用（`admin.js:229,316,389,406,426,460,498,600`），测试只锁 7 个路由窗口。依赖：`fs`/`path`，只读不 require，故不触发 config。

### server/test/routeEdgeCases.test.js（75 行）

职责：三处"数据正常时测不出"的边界——LIKE 通配符、归档伪分组、邻居 NULL 时间轴。
实际行为：`escapeLike('_')==='\\_'`、`'%'`、`'\\'`、普通文本原样；`ai.js` `search_site_articles` 分支 900 字符窗口内须有 `const like = \`%${escapeLike(`（否则传 `_` 会退化成"最近 5 篇"）；归档投影须含 `created_at`、分组键 `String(r.published_at || r.created_at || '')`、空值 `if (!dayStr) continue;`（防 `String(null)==='null'` 造 `month:"null"`）；`/neighbors` 须 `curAt = cur.published_at || cur.created_at` 且 `COALESCE(published_at, created_at)` 至少 4 处（实测 6）。
依赖：fs/path、utils/sanitize、routes/{articles,ai}（只读文本）。

### server/test/waf.test.js（219 行）

职责：HTTP 层 WAF/闸门/限流/封禁联合验收，按**分数预算**排顺序：零积分拒绝在前、攻击载荷在后、末尾断言已封禁。
实际行为：`Origin: evil.com` → 403 `'不允许的跨域来源'`；`Origin:null` 穿到业务层 → 403 `'缺少安全令牌'`；无来源无签名 → 403 `'请求签名无效'`；`Sec-Fetch-Site: cross-site`（含大写）→ 403 `'请求被拒绝'`，`same-origin/same-site/none/缺头` → 403 `'访问被拒绝'`（闸门兜底），GET 不受限；RSS 前 12 次 200、第 13 次 429（12/min）；`TRACE`/`PATCH` 405；`CL:5`+`TE: chunked` 400；前 3 条（SQLi/XSS/遍历）须以 WAF 专属 `'请求被拒绝'` 命中，之后 12 条通用、4 条嵌套 body、4 条数组/重复/嵌套 query、4 条原型污染键、6 条编码、19 条深度绕过（注释混淆、`%0d%0a`、宽字节、`${jndi:…}`、XXE、OGNL、`${IFS}`）只断言 403；蜜罐 `/admin`/`/.env`/`/.git/config`/`/wp-login.php`/`/actuator` 首个严格 `404+'访问被拒绝'`、余 403/404；末条 `Googlebot` 拉 `/robots.txt` 也 403。
副作用：真实累计信誉（3/次，阈值 10）并封 15 分钟，绝不能与其它套件同 IP 混跑。

### server/test/falsePositive.test.js（242 行）

职责：误杀回归——真人内容放行、攻击载荷拦截，并验"通用/监控 UA 放行、favicon 风暴不封、可信 IP 让 WAF 不记分"。
实际行为：`scanText` 12 条放行（`select…from` 散文、`#1 标题 41 期`、`online=1`、`concat(a,b)`、`localhost` 昵称、`JavaScript:从入门到放弃`、带端口 URL、`1e5=100000`、`#4a90d9`、`${name}` 模板串）+ SSRF 字段限定（body 非 URL 上下文不查内网）；20 条按 `hit.group` 断言（SQL/XSS/CMD/MISC/TRAVERSAL）；`RULE_INDEX` ID 唯一且带 note/group；审核 5 放行（含 `VxWorks` 不命中 `vx`）、3 条 `>=30`；`antiSpam` 链接 1/3 放行 4 拒；guard ±29 放行、±31 拒；默认配置六组全开、`disabledRules` 空、`banCountResetDays===30`。HTTP：curl/python-requests 拉 RSS 200、UptimeRobot 200、sqlmap 403、`?online=1` 与散文 200、15 次 favicon 404 后仍 200；管理段登录取 `admin-path`、`/security/config`、`/security/test`（base64 `text_b64`）、非法 CIDR 400、未知规则 ID 400、白名单 `127.0.0.1`/`::1`/`::ffff:127.0.0.1` 后连打 6 次 SQLi 仍 200、清空。
副作用：白名单段恢复调用不在 `finally`，中断后本机 IP 会持续免积分。

### server/test/2fa.test.js（139 行）

职责：TOTP 全生命周期：生成密钥 → 错码拒 → 正码启用 → 旧会话撤销 → 带码登录 → 重放拒 → 跨步关闭 → 关闭后免码。
实际行为：`/api/auth/2fa/setup` 无密码 400、有密码返回 `/^[A-Z2-7]{32}$/`；`verify` `000000` 400、当前步码 200；已启用再 setup → **409**；无码登录 401、正码 200；同码二次 401（防重放表记最近成功步）；`disable` 新步码 200；关闭后免码 200。文件内联 RFC 4648 base32 解码与 RFC 4226 HOTP（HMAC-SHA1、动态截断、`%1000000`），`totpAt(secret,±1)` 取邻步，`waitForNewStep` 真等到 `(current+2)*30000+1000`。
数据：30s 步长、`users.totp_secret/totp_enabled`（`run.js` 重置依赖这两列）。副作用：真 sleep × 2；中断会留下已启用 2FA，使后续登录全要验证码。

### server/test/admin.test.js（179 行）

职责：后台冒烟——认证、指纹绑定、闸门、CRUD 闭环、上传安全、设置备份往返。
实际行为：登录 200 且 `code===0` 拿 JWT；换 `X-Fp` → 401/403（票据先 403，伪造票据则 JWT 指纹比对 401）；无票据后台 403；9 个列表端点逐一 200，文章导出断言 `meta.type==='articles-backup'`（回归"导出被 `/:id` 吃掉"），设置导出是**裸 JSON**；审计 `keyword=LOGIN` 能找到登录；前台 7 端点 + RSS + Sitemap；详情 `content_enc===true`、无票据 403；PV 两连发 `pv_counted` true→false（10 秒窗）；CRUD：建草稿（预占 slug）→ 前台不可见 / `?status=draft` 枚举不到 / 详情与 related 均 404 → 发布 → 可见且加密 → 改标题 → 删除 → 不可见。上传：1×1 PNG 通过并可静态访问；PNG 改 `.jpg` 名 400（magic bytes）；含 `<script>` 的 SVG 400；`shell.php` 400；末尾删文件。设置：改名 → 导出 → 恢复 → 导入 → 断言 `备份测试站` → 再恢复。
副作用：写真实数据（文章、站点名、上传文件），中断留脏；`r` 复用使断言顺序敏感。

### server/test/lockout.test.js（78 行）

职责：登录爆破防护——非法输入不计数、错误累积、正确重置、5 次连错锁定、锁定期正码也拒。
实际行为：`tryLogin` 每次换**新 IP**（`192.0.2.<n>` + `X-Forwarded-For` + 派生 fp + 独立票据），5 次失败仍锁定 ⇒ 锁定键是账号而非 IP；空密码与 100 字符密码 400；4 次错误 401 且文案不含"剩余"；统一 `'用户名或密码错误'`；第 5 次换正确密码 200（计数重置）；再 4 错 + 第 5 错仍 401（`recordFail` 本请求设锁，`checkLock` 在其前），下一请求命中锁 → 401；锁定期正码 401。
副作用：注释明说会触发 IP 信誉封禁、须单独跑，但仍列在 `run.js` 主链，隔离靠套件间重置。

### server/test/session.test.js（77 行）

职责：多设备会话——列表、撤销他人、撤销后 401、登出、登出后 401、重登恢复。
实际行为：两次登录得 A/B，先 `logout-all` 清历史以保证 `sessions.length===2` 精确；列表含 `current` 与 `jti`；`DELETE /api/auth/sessions/<jti>` 后 B 后台 401、A 仍 200；`logout` 后 A 401；重登可用。
副作用：`logout-all` 清空全部会话。

### server/test/journey.test.js（98 行）

职责：真人全链路——浏览 → 解密阅读 → 互动 → 发现 → SEO → 后台 → 站长回复。
实际行为：统计 `total_pv>=0`、设置断言 `server_tz_offset_min` 是 number（前端相对时间依赖）；详情取 `content`+`content_key`，`decryptPayload` 解出含"欢迎"；`formPost` 发评论/留言/友链（内部 seed→2 秒→签名）；搜索 `Vue`、归档非空；RSS `<item>`、Sitemap `<urlset>`、分享页 `og:title`；后台仪表盘 `total_articles>0`+安全中心+审计；末段发带唯一标记留言 → 后台按 `keyword` 查 id → 回复 → 前台读到 `reply==='站长已回复'`（回归"新建库缺列"）。
数据：种子 slug `welcome-to-xalor-blog`、`article_id:1`、`https://example.com`（`run.js` 专门 DELETE 该 url 避"防重复申请"）。

### server/test/notes.test.js（206 行）

职责：主页/手记端到端 + "一套后端两个域名"的 Host 派发契约。
实际行为：无票据 `/api/notes`、`/api/notes/1` 均 403；`/api/home/summary` 免票 200 且深扫无密钥/无 `content`/`notes`；建已发布/草稿/含非法图三种，断言 `images` 中 `javascript:alert(1)` 被清洗、**前台详情返回完整 images 数组**（九宫格/灯箱只认它）；列表不含草稿、无 `content`、有 `excerpt`/`image_count`；详情 `content_key==='note:<id>'`、密文≠明文、用 `HMAC-SHA256(ENC_SALT, ticket|note:<id>)` 可解、换条解不开、草稿 404；点赞首次 200、窗内 429；`ALLOWED_HOSTS` 含 `xalor.cn` 时断言 `CORS_ORIGINS` 必须同含、并以 `Origin: https://xalor.cn` 点赞成功；`/api/notes/abc` 与越界 id 均 400；SEO：主页域 sitemap 含 `/share-page/notes`、博客域不含、主页 robots 含"个人主页"、两者 `Vary: Host`、主页 RSS 是手记版；`home_since_date` 提交 `null` 必须清成 `''`；末尾 `batch-delete` 清四条。
数据：`MARK='[NOTETEST]'`（`run.js` 用 `LIKE '%[NOTETEST]%'` 兜底）、`ENC_SALT=process.env.TEST_ENC_SALT||'xalor-content-v1'`。副作用：写真实手记与设置。

### server/test/security.test.js（263 行）

职责：安全回归主套件——闸门/PoW、签名与重放、点赞防刷、续期上限、表单令牌单次性、蜜罐、响应头、方法白名单、UA 轮换、爬虫 UA、Host 校验、封禁生效。
实际行为：无票读写 403；`getTicket` 完成 PoW；伪造 `X-Sig` 403；同 nonce 两次 → 第二次 403 `'请求签名无效'`；点赞首次 200、10 秒内 429；进程内直测 gate：续期成功 10 次、第 11 次 `reason==='需要重新验证'`、新链计数独立；表单令牌复用 403 且消息含 `'已被使用'`；蜜罐字段被填 403；robots 与 `security.txt` 200；响应头 `X-Frame-Options: DENY`、`Referrer-Policy`、`nosniff`、`CORP: same-origin`、`no-store`、无 `X-Powered-By`；未知 API 与 `/uploads/` 同形拒绝；`TRACE`/`PATCH` 405；HEAD 带票 200、无票 403；6 个浏览器 UA 前 5 个 200、第 6 个不 5xx，且跨阈值后持续轮换**不应**封禁（NAT 出口回归）；`sqlmap/nikto/GPTBot` 在 RSS 403；`Host: evil.com` 403；末条 robots 也 403。
数据：`MAX_RENEWS=10`、`ticketLimiter 10/min`、`UA_DIFF_THRESHOLD≈6`、权重（UA 9 / Host 3 / WAF 3 / rate 2）、阈值 10、封 15 分钟；`sleep(40000)`+`sleep(2300)` 跨窗口。

## 观察

1. `server/test/sanitize.test.js:94` — 条件是 `getAdminNicknames().then(...)` 返回的 Promise，恒真；该条永不失败，失败也无人 await。
2. `server/test/likeGuard.test.js:28-29` — `canLike` 实际只收 `(ip, articleId)`（`src/routes/articles.js:18`），两条"换 fp 仍受限"根本没传指纹；即便把 fp 重新并进键仍会通过。
3. `server/test/likeGuard.test.js:35-36` — 注释承认窗口过期无法观测，退化为断言常量 `>=8000`；"过期后恢复"零覆盖，判定方向写反不会红。
4. `server/test/allowWords.test.js:49`、`:118` — `const db = null;` 与 `finally { if (db) … }` 是死代码，易让人误以为本套件连库。
5. `server/test/readingStats.test.js:227-230` — 同步 `if (failed)` 在异步 IIFE（171-226）完成前执行，读到的是同步段计数；该块为死代码，而 IIFE 无 `.catch`，`import()` 失败会成为未捕获拒绝。
6. `server/test/readingStats.test.js:214` — `map((r)=>({...r, content: r.content}))` 是恒等映射，无作用。
7. `server/test/admin.test.js:92` — `assert('首次 PV 计入', r.status===200 && …)` 中 `r` 已被第二次请求覆盖；首个响应状态从未断言，首次 500、二次 200 也能过。
8. `server/test/security.test.js:41` — `r.status !== 403` 把 500 也算"合法签名通过"，成功路径只排除了签名拒绝一种失败。
9. `server/test/security.test.js:72`、`:82` — 两小节都编号 `4b`（点赞防刷 / 续期链），日志无法凭编号定位。
10. `server/test/security.test.js:202` — 第 6 个 UA 只断言 `<500`，200 与 403 都算过，"检测生效"与"完全未触发"不可区分。
11. `server/test/notes.test.js:25` — 解密盐取 `TEST_ENC_SALT` 并回落 `'xalor-content-v1'`，服务端读 `ENC_SALT`（`src/config.js:119-126`，生产禁用默认值）；本地配了自定义盐而忘同步，"密文可解密"会以被测代码之名失败。
12. `server/test/waf-fixtures.test.js:63` — 覆盖率门禁给 `id==='MSC-CRLF'` 开例外，而它不在 `RULE_INDEX`；未注册规则可借语料"合法"存在，反向校验有缺口。
13. `server/test/waf-fixtures.test.js:33` — `THRESHOLD` 在加载时取一次且 `Number(...)||5` 把合法 `0` 当缺省；套件内改阈值不反映到 `monitor` 判定。
14. `server/test/cacheInvalidation.test.js:69-71` — 判定是"片段含该调用文本"，注释里写一行也算通过；反之把失效抽进 helper（更稳）会让它红。
15. `server/test/cacheInvalidation.test.js:47-55` — 7 条路由签名硬编码 `async` 与单引号，改非 async 或双引号会以"路由存在=false"失败，锁的是排版不是缓存。
16. `server/test/routeEdgeCases.test.js:53`、`:56`、`:63` — 断言对象是源码字面形态（select 字符串、变量名 `curAt`、正则 `if \(!dayStr\) continue;`），改名/加括号即红，而"漏 select created_at"本可用行为测试覆盖。
17. `server/test/scrapeGuard.test.js:29-32` — 循环内不 assert，只有末次判定；`r` 跨段复用，若 `MAX_HITS` 变 0/1，循环不执行，断言会继承第 23 行的"被拒"结果而假通过。
18. `server/test/notes.test.js:177`、`:182` — 断言 robots 含中文"个人主页"、RSS 含"手记"是文案耦合；配合 `:166-168` 的"ALLOWED_HOSTS 不含则整段跳过"，默认 CI 下 Host 派发契约实际未被验证。
19. `server/test/admin.test.js:159-169` — 用真实 `site_name` 做导出/导入往返，恢复不在 `finally`；`:182` 的提前 return 会把站点名留在"备份测试站"。
20. `server/test/lockout.test.js:60-64` — "第 5 次仍 401（锁定已设置）"与普通密码错误同形同文案，断言无法区分是否设锁，证据只来自下一条。
21. `server/test/2fa.test.js:51-60` — 真等到 `(current+2)*30000+1000`，单次最长约 61 秒、两处调用，套件下限 1-2 分钟，且要求本机与服务端时钟一致。
22. `server/test/contentCrypto.test.js:24` — "换票"用 `'0.other.sig'` 同时换了 ts 与 sig；密钥材料只含 `jti`，未单独覆盖"仅换 jti"的最小差异。
23. `server/test/falsePositive.test.js:133-136` — 把默认配置值写死（`banCountResetDays===30`、`disabledRules` 空、六组全开），调策略会让"误杀回归"变红，混淆了配置契约与误杀两个关注点。
24. `server/package.json:17` 与 `server/test/allowWords.test.js:46` — 15 个"无 DB"套件里只有 allowWords 补了 `DB_PASSWORD` 占位；sanitize/browserCrypto/contentCrypto/notesCrypto/homeSummary 经 require 触发 `src/config.js:31-39` 的 throw，无 `.env` 机器上会崩在 require 而非断言。

## 小结

- 三层防线：纯函数契约（sanitize/feed/两套 crypto/browserCrypto/homeSummary/readingStats/moderationPolicy/allowWords/waf-fixtures）→ 中间件分支（requestGuard/likeGuard/scrapeGuard）→ HTTP 端到端（waf/falsePositive/2fa/admin/lockout/session/journey/notes/security）。前两层可无服务跑，第三层依赖 `test/client.js` 的 PoW 换票+签名，并共享会真实封禁的 IP 信誉状态机。
- 最可信的是语义断言：requestGuard（`sigVerified` 旁路）、allowWords（相邻性）、readingStats（前后端对齐）、homeSummary（白名单+深扫）、两套 crypto（命名空间隔离），重构不误红。
- 最脆弱的是源码文本断言（cacheInvalidation、routeEdgeCases）：能防"漏调失效""漏兜底"这类静默缺陷，代价是格式化即红、注释即可骗过。
- 多处断近似永真：`sanitize:94`、`likeGuard:28-29`、`security:41`、`security:202`、`lockout:60-64`。它们占着"关键安全回归"的位置却无判定力，是最该补的五处。
- 环境耦合强于注释宣称：`npm test` 仍要 `DB_PASSWORD`（观察 24）；2fa/security 用真 sleep 跨 TOTP 步长与限流窗；waf/security/lockout 污染 IP 信誉与锁定，须靠 `run.js` 的 `ip_bans`/`totp_*` 重置才能重跑。
- 边界：只覆盖单后端双域名的派发与闸门（`Vary: Host`、sitemap/robots 分版），不覆盖前端渲染、CDN 与真实反代（`X-Forwarded-For` 仅模拟），也不覆盖密钥轮换与历史密文迁移。
