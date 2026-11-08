# S5 · server/src/utils 服务端工具库

> 覆盖 `server/src/utils/` 全部 18 个文件，逐行读完。所有行号均指该文件当前内容。

### server/src/utils/aiClient.js（251 行）

**职责**：OpenAI 兼容协议的 LLM 客户端，向 SSE 转发层提供流式对话、向短任务提供一次性回复。

**关键导出**
- `getAiConfig()`：读 `getAllSettings()`（60s 缓存），按「后台设置 > `config.ai`（`AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL`）> 内置 `https://api.openai.com/v1` + `gpt-4o-mini`」三级回落；对 `ai_temperature`(0–2→默认 0.7)、`ai_max_tokens`(256–8192→4096)、`ai_system_prompt`(≤3000 字)、`ai_ctx_chars`(1000–100000→20000)、`ai_ctx_turns`(6–200→48)、`ai_ctx_compress` 做二次钳制；`ready = !!apiKey && isUsableBase(baseUrl)`。
- `isUsableBase()`：生产仅 `https:`；非生产额外放行 `http://127.0.0.1|localhost[:port]`，用于本地网关调试。这是「SSRF 链」的唯一守门点。
- `parseSse(body)`：手写 SSE 解析器，跳过空行/`:` 注释/非 `data:` 行，坏 JSON 静默丢弃，`[DONE]` 直接 return，`finally` 里 `reader.cancel()` 释放上游连接。
- `streamChat({messages,tools,maxTokens,signal})`：`stream:true`，有 `tools` 时附 `tool_choice:'auto'`；`AbortController` + `TIMEOUT_MS=90000` 定时器，并把调用方 `signal`（客户端断开）桥接进来。工具分片按 `tc.index` 累积到 `Map`，**流结束后**才统一产出 `{type:'tool',id,name,args,raw}`，`id` 缺失用 `tc_<ts>_<rand>` 兜底；末尾产出 `{type:'usage'}`。
- `chatOnce({messages,maxTokens=512})`：非流式，只取 `choices[0].message.content` 字符串，无内容返回 `''`。

**依赖**：`../config`、`./settings`。

**契约/常量**：`TIMEOUT_MS=90000`；错误码 `AI_NOT_CONFIGURED` / `AI_UPSTREAM`（附 `err.status`）/ `AI_NO_STREAM`；上游非 2xx 时把响应体截 160 字塞进 message。

**副作用与失败模式**：`fetch` 无重试；超时/中止以原生 `AbortError` 抛出不带 `code`，与上游错误不可区分；每次调用都重新解析一遍配置（依赖 settings 的 60s 缓存）。

### server/src/utils/aiModeration.js（335 行）

**职责**：评论/留言双层审核——本地规则打分 + 可选 LLM 二判，输出 `approved|pending|rejected`。

**关键导出**
- `normalizeForSpam()`：小写 → 去零宽/双向控制符 → 全角折半角（`！-～` 减 `0xFEE0`）→ `[√∨νⅴ]` 折成 `v` → 去全部空白。仅用于评分，不改入库原文。
- `localModeration(content,nickname,website)`：加权累加——广告词 ×20、辱骂词 ×30、敏感词 ×25、攻击意图 ×30（均含昵称）；外链 ≥2 时 ×15、单链 +5；裸域名 ×10；手机号 +20、疑似 QQ（正文 <60 字）+10；引流话术（加V/搜索薇信/`tg号:`/`@handle`）+20；连续 8+ 非字母数字非中文 +15；大写占比 >0.7 +5；`(.)\1{5,}` +10；网站字段有 URL 且无链 +5；提示注入特征（`ignore previous`/`忽略以上`/`system prompt`/`回复…approved`）+30。返回 `{score, reasons[:5]}`。
- `countHits()`：拉丁词（`/^[a-z0-9+]+$/`）用 `(?<![a-z0-9])w(?![a-z0-9])` 词边界，中文词用 `includes`。
- `llmModeration(text, ai)`：全局令牌桶（`LLM_RATE_MAX=30`/60s，`llmReserve`/`llmRelease`），8s 超时，`max_tokens:8, temperature:0`，system prompt 要求只输出一个判定词；响应体流式读取上限 `MAX_BODY=4096`；输出剥离非 A–Z 后严格匹配，异常一律 `PENDING`。未配置 key、非 https、超限、非 2xx、超时均返回 `null`。
- `moderateComment(content,nickname,website,{forceLlm,failClosed})`：`ai_moderation===false` 时 `failClosed?pending:approved`；`score>=REJECT_SCORE(60)` 直接 rejected；`score>=PENDING_SCORE(30)` 或 `forceLlm===true` 才调 LLM；LLM 返回 `null` 时**一律 pending**（fail-closed）。

**依赖**：`../config`；函数内 `require('./settings')` 以规避静态循环依赖。

**契约/常量**：阈值 `AI_REJECT_SCORE=60` / `AI_PENDING_SCORE=30`；词库 `AD_KEYWORDS`/`ABUSE_KEYWORDS`/`PORN_KEYWORDS`/`ATTACK_KEYWORDS`；开关 `ai_moderation`、`ai_llm_moderation`。

**副作用与失败模式**：令牌桶是进程内内存态（多进程各自 30/min）；`llmCalls` 数组随调用增长（按时间窗裁剪）；LLM 不可用时整条链路降级为 pending，留言场景等于「全站先审」。

### server/src/utils/antiSpam.js（77 行）

**职责**：硬拒层——高置信敏感词命中即拒 + 链接数上限，作为 AI 评分层之前的廉价闸门。

**关键导出**
- `checkSensitive(text)`：`SENSITIVE_WORDS`（加微信/加qq/vx/weixin、博彩/六合彩、套现/办证/代开发票、色情/裸聊/约炮、seo优化/百度推广…）拼接 `securitySettings.getCustomWords()`；拉丁词走 `escapeRegExp` + 词边界，中文词 `includes`；命中后再问 `securitySettings.isAllowedText(text, word)` 决定是否豁免。
- `countLinks(text)`：`https?://\S+` 与裸 `www.` 域名都计数。
- `antiSpam(text, maxLinks=3)`：返回 `{ok, reason}`，超链接数时 reason 带实际个数与上限。

**依赖**：`./securitySettings`（同步读内存配置）。

**副作用与失败模式**：无异常抛出路径（`escapeRegExp` 正是为防止自定义词 `c++` 让 `new RegExp` 抛错把接口打成 500）；每个敏感词都要做一次正则/`includes` + 一次豁免扫描，词库增长是线性成本。

### server/src/utils/crypto.js（52 行）

**职责**：文章正文的 AES-256-GCM 加解密，密钥与「通行证票据 + 篇目标识」绑定。

**关键导出**
- `keyMaterial(passTicket, articleKey)`：`ticket` 或 `ticket|articleKey`。
- `deriveKey()`：`HMAC-SHA256(key=config.security.encSalt, msg=keyMaterial)`，`ENC_SALT` 生产环境强制 ≥16 字符且不得为默认值（在 `config.js` 抛错）。
- `encryptPayload()`：返回 `base64(iv(12)|tag(16)|ciphertext)`。
- `decryptPayload()`：长度 <28 直接 `null`；`try/catch` 吞掉所有异常返回 `null`（正常流程由前端解密，此函数是服务端备用）。

**契约**：`ALGO='aes-256-gcm'`、`IV_LEN=12`、`TAG_LEN=16`。

**副作用**：纯函数，无 IO；失败与「票据错误」「密文损坏」不可区分。

### server/src/utils/datetime.js（35 行）

**职责**：固定 `Asia/Shanghai` 的站点日历，避免服务器 `TZ=UTC` 把「今天」算错一天。

**关键导出**：`zonedParts()`（`Intl.DateTimeFormat('en-CA', {hourCycle:'h23'})` 拆成 parts）、`localDateStr()`→`YYYY-MM-DD`、`localDateTimeStr()`→`YYYY-MM-DD HH:mm:ss`、常量 `SITE_TZ`。

**副作用**：无。每次调用都新建 `DateTimeFormat`（无缓存实例）。

### server/src/utils/markdownText.js（18 行）

**职责**：Markdown → 纯文本，供 RSS 摘要与分享页 OG 描述复用（注释说明是为了消除 `feed.js`/`share.js` 的重复实现）。

**关键导出**：`plainText(md)`——去围栏代码块、行内代码反引号、图片、链接保留文字、再把 `[#>*_~-]` 全替换成空格、压缩空白。

**副作用**：无。

### server/src/utils/notes.js（77 行）

**职责**：手记（notes）的字段白名单与图片序列化，供公开路由、主页摘要、主页版 feed、后台共用。

**关键导出**
- `parseImages(raw)`：字符串走 `JSON.parse` 并过滤非字符串项，脏值降级 `[]`。
- `serializeImages(input)`：逐项 `safeCover(String(item ?? ''))`，去空、截断到 `MAX_NOTE_IMAGES=9`，返回 JSON 字符串。
- `buildExcerpt(content, len=200)`：`plainText().slice(0, len)`。
- `noteSummary(row)`：**绝不含 content**（正文只在详情接口以 AES-GCM 密文下发），输出 `id/excerpt/cover(=images[0])/image_count/mood/location/likes/is_pinned/status/published_at(=published_at||created_at)/created_at/updated_at`。

**依赖**：`./markdownText`、`./sanitize`。

**契约**：`MAX_NOTE_IMAGES=9`、`EXCERPT_LEN=200`；表 `notes`（字段名即上述键）。

### server/src/utils/notifyMail.js（134 行）

**职责**：站长邮件通知（评论/留言提醒），未配置 SMTP 时静默跳过。

**关键导出**
- `smtpReady()`：`host && user && pass` 且拼接串不含 CR/LF（防头注入）。
- `enabled()`：`smtpReady() && cfg.to`。
- `foldByBytes(text, maxBytes=990)`：按 **UTF-8 字节**折行，遇多字节字符整字前移，保证 RFC 5322 的 998 octets 上限（中文一行约 330 字）。
- `sanitizeForSmtp(s)`：压平 CR/LF → 按字节折行 → 去掉折行后行首空白。
- `safeSubject(s)`：压平换行后按字节截到 45 字节（≤15 汉字），为 RFC 2047 encoded-word 的 75 字符上限留空间；截半字符时 `while` 回退。
- `send(subject, text, to)`：收件人优先级 `to` → `NOTIFY_EMAIL` → `SMTP_USER`，都不过格式校验就 `resolve(false)`；强制 `requireTLS`（`SMTP_REQUIRE_TLS!=0`）、`secure` 由 `SMTP_SECURE=1` 或端口 465 推断，三个 15s 超时；成功/失败都 `close()`，Promise **永不 reject**。

**环境变量**：`SMTP_HOST/PORT/USER/PASS/SECURE/REQUIRE_TLS`、`NOTIFY_EMAIL`（模块加载时一次性读取）。

**副作用**：每次发信新建 transporter（无连接池）；错误被 `.catch(()=>{})` 吞掉且不记录日志。

### server/src/utils/ownerBadge.js（25 行）

**职责**：按管理员昵称识别「博主」发言，供评论/留言公开接口复用。

**关键导出**：`getAdminNicknames()`（查 `users` 表 `role='admin'` 的 `nickname`，小写去空格，60s 内存缓存）、`isOwnerNickname(nickname)`（同样归一化后查 `Set`）。

**依赖**：`../db`（表 `users`，字段 `role`/`nickname`）。

**副作用**：进程内缓存 `adminCache/adminCacheAt`；查询失败时 Promise 拒绝且不更新时间戳，每次调用都会重查。

### server/src/utils/response.js（14 行）

**职责**：统一 API 响应壳。

**关键导出**：`ok(res,data=null,message='ok')` → `{code:0,message,data}`；`fail(res,message='请求失败',status=400,data=null)` → `res.status(status).json({code:1,message,data})`；`notFound(res,message='资源不存在')` → 404 `{code:1,message}`。

**契约**：`code=0` 成功、`code=1` 失败；HTTP 状态与业务码分离，401/403/429 等由调用方通过 `fail` 的 `status` 指定。

### server/src/utils/sanitize.js（139 行）

**职责**：输入清洗总闸——文本去标签、URL/邮箱/封面校验、LIKE 转义、Markdown 正文高危标签剔除。

**关键导出**
- `sliceSafe(s,maxLen)`：按 UTF-16 码元截断，末尾若为孤立高位代理（`[\uD800-\uDBFF]$`）再退一个码元，防 `Buffer.from` 时被替换成 U+FFFD。
- `cleanText(input,maxLen=2000)`：`sanitize-html` 关掉全部标签与属性后 `trim` + `sliceSafe`。
- `cleanLine(input,maxLen=100)`：`cleanText` 后压平换行。
- `safeUrl(input,maxLen=500)`：仅 `http:`/`https:`；拒绝内嵌 `user:pass`、`localhost` 与 `.local/.localhost/.localdomain/.internal/.lan/.home`、`localtest.me/lvh.me/nip.io/sslip.io`（DNS rebinding）、含 `:` 的 IPv6 字面量、含 `%`、纯数字/`0x` 主机；再做 IPv4 保留段判断（0/8、10/8、127/8、169.254/16、172.16/12、192.168/16、100.64/10、≥224）。
- `safeEmail(input,maxLen=100)`：`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`。
- `escapeLike(input)`：转义 `\ % _`，防 LIKE 通配符把查询放大成全表扫描。
- `safeCover(input)`：只认 `/logo.png`、`/uploads/<[A-Za-z0-9._-]+>`，其余走 `safeUrl`。
- `cleanMarkdown(input,maxLen=100000)`：`allowedTags:false` + `allowedAttributes:false`（保留一般 HTML，交给前端 DOMPurify），叠加 `nonTextTags` 与 `exclusiveFilter` 真正丢弃 `script/iframe/object/embed/applet/style` 整帧。

**常量**：`MARKDOWN_BAD_TAGS`。

**副作用**：纯函数；`cleanMarkdown` 的信任边界完全落在展示层。

### server/src/utils/securitySettings.js（436 行）

**职责**：安全中心（WAF/信誉/封禁/自定义词库）的统一配置源——默认值来自代码与 `TRUSTED_IPS`，覆盖值存 `security_config` 表单行 JSON，读路径全同步内存缓存。

**关键导出**
- `getConfig()`：未加载时踢一次异步 `reload()`，**立即返回当前 cache**（首次调用拿到的是默认值）。
- `reload()`：读 `security_config`（`id='config'`，`data` JSON）→ `mergeValid(DEFAULT_CONFIG, parsed)`；异常吞掉，`loaded=true`。
- `saveConfig(patch)`：`mergeValid(getConfig(), patch)` → `insert().onConflict('id').merge()` 整体覆盖 → 同步更新 cache。
- `mergeValid(base,patch)`：从 `cloneDefaults()` 起步，先逐字段吸收 `base` 的合法值，再叠加 `patch` 出现的键；数值按 `NUMERIC_RANGES` 取整钳制（`scanThreshold 3–100`、`paranoiaLevel 1–3`、`anomalyThreshold 3–20`、`banScore 5–100`、`weights.* 1–20`、`baseBanMinutes 1–1440`、`maxBanHours 1–720`、`banCountResetDays 0–365`）；列表按 `LIST_LIMITS` 截断（`disabledRules 200`、`trustedIps 50`、`customSensitiveWords 100`、`allowWords 100`），规则 ID 必须匹配 `/^[A-Z]+-\d{1,3}$/`，IP 必须过 `isValidIpOrCidr`。
- `matchesCidr(entry, ip)` / `parseIpWithPrefix` / `ip4ToBytes` / `ip6ToBytes`：自实现 CIDR 匹配，含 `::ffff:1.2.3.4` 尾段展开与 IPv4↔IPv4-mapped 互通，位掩码按 8 位一段推进；`cidrCache` 上限 500 后整体清空。
- `isTrustedIp(ip)`：`::ffff:` 前缀归一后先做字符串全等，再走 CIDR。
- `isAllowedText(text, matchedWord)`：把豁免词与命中词的所有出现位置枚举出来，只有两区间 `gap===0`（重叠或紧邻）才豁免该次命中；`matchedWord` 缺省时退化为「文本是否含任一豁免词」。
- `getCustomWords()`、`setConfigForTest()`（仅测试）、`DEFAULT_CONFIG`/`NUMERIC_RANGES`/`LIST_LIMITS` 导出。

**表/字段**：`security_config(id='config', data, updated_at)`。

**副作用**：`cache` 是模块级可变对象且被直接返回（调用方可改）；`setConfigForTest` 只改本进程。

### server/src/utils/settings.js（278 行）

**职责**：站点设置读写（`settings` 表 key/value），后台设置项的唯一白名单与校验中心。

**关键导出**
- `DEFAULT_SETTINGS`：约 40 键——站点名/描述/公告/页脚/about/avatar/`og_image`/`site_url`/社交三件套、`comment_moderation`/`message_moderation`、`ai_*`（`moderation`/`llm_moderation`/`base_url`/`model`/`api_key`/`temperature`/`max_tokens`/`system_prompt`/`ctx_chars`/`ctx_turns`/`ctx_compress`）、`websearch_*`、`allow_copy`/`rss_full_content`/`copyright_text`/`icp`，以及主页域 `home_site_url`/`home_hero_*`/`home_status`/`home_since_date`/`home_social_extra`/`home_about_excerpt`。
- `ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS))`——**默认表就是写入白名单**，不在其中的键在 `saveSettings` 里被 `continue` 静默丢弃。
- `getAllSettings()`：`settings` 表全量读，逐行 `JSON.parse`；`BOOL_KEYS` 归一到布尔（`true/'true'/1/'1'`），非布尔非字符串值 `String()` 后截 5000 字；解析失败时布尔键落 `false`、其余取原始字符串；结果 `{...DEFAULT_SETTINGS, ...map}` 缓存 60s。
- `saveSettings(entries)`：逐键校验后单事务批量 upsert（注释说明是为了把「键数 × RTT」压成一次事务）。校验包括：`site_url`/`home_site_url` 走 `safeUrl` 且禁 query/hash；`home_status` 枚举钳制；`home_since_date` 严格 `YYYY-MM-DD`；`home_social_extra` 必须 JSON 数组、≤8 条、逐项 `label≤30` + `safeUrl` 后**重新序列化**；`avatar` 走 `safeCover`；`og_image` 允许 `/` 开头的站内绝对路径（禁 `..`）或 `safeUrl`；`social_github/weibo` 必须 `https?://`；`social_email` 禁空格与 `<>`；`ai_base_url` 必须 `https://`；`ai_api_key`/`websearch_api_key` 空值或全 `*` 视为「不修改」、`__CLEAR__` 进 `clears` 走 DELETE、长度 8–300；`ai_temperature` 0–2、`ai_max_tokens` 256–8192、`ai_ctx_chars` 1000–100000、`ai_ctx_turns` 6–200；`websearch_provider` 仅 `tavily`；字符串落库前截断（`about_content` 50000，其余 5000）。

**表/字段**：`settings(key, value, updated_at)`；写入值一律 `JSON.stringify`。

**副作用**：保存后置空本地缓存再重读；`value===null` 归一为 `''`（适配 el-date-picker 清空）。

### server/src/utils/siteHost.js（37 行）

**职责**：双域名（`blog.xalor.cn` / `xalor.cn`）识别与站点基址推导。

**关键导出**：`requestHost(req)`（取 `headers.host` 小写、去端口/去 IPv6 方括号/去末尾点）、`isHomeHost(req)`（与 `config.homeSiteHost`（`HOME_SITE_HOST`）严格相等；未配置恒 `false`）、`resolveBaseUrl(req, configured)`（优先显式配置并去尾斜杠，否则 `req.protocol + req.get('host')`）。

**副作用**：无。

### server/src/utils/slugify.js（22 行）

**职责**：生成文章/页面 URL slug。

**关键导出**：`slugify(text, existing=[])`——小写、空白转 `-`、剔除 `[^a-z0-9\u4e00-\u9fa5-]`、压缩连续 `-`、去首尾 `-`；空结果回退 `post-<Date.now()>`；超 80 字符截断；与 `existing` 冲突时追加 `-1`、`-2`…直到不冲突。

**副作用**：纯函数；`existing` 由调用方提供，函数自身不查库。

### server/src/utils/stripExif.js（59 行）

**职责**：上传前剥离 JPEG 的 EXIF（GPS/设备/时间），保留 APP2 ICC 与图像数据，纯 Buffer 实现无依赖。

**关键导出**：`stripExif(buf)`——非 `FFD8` 或长度 <4 原样返回；按段结构遍历，跳过 `FFE1`，`FF01`/`FFD0-FFD9` 视为无长度独立标记，遇 `FFDA`（SOS）后整段熵编码数据原样拷贝并返回；任何非法段/越界/长度 <2 一律**回退原 Buffer**。

**副作用**：纯函数，不落盘。

### server/src/utils/totp.js（138 行）

**职责**：RFC 6238 TOTP 两步验证，纯 `crypto` 实现。

**关键导出**
- `generateSecret(length=32)`：`randomBytes(ceil(len*5/8))` 后按 5-bit 分组映射 `A–Z2–7`（32 字符 = 160bit）。
- `base32Decode(input)`：过滤非字母表字符后按位重组。
- `hotp(secretBuffer, counter)`：`HMAC-SHA1` + 动态截断（末字节低 4 位取 offset），`% 10^6` 补零。
- `currentStep(now)`：`floor(now/1000/30)`。
- `otpauthUri(secret, account, issuer='Xalor Blog')`：带 `algorithm/digits/period` 的 `otpauth://totp/...`。
- `verifyCode(secret, code, replayGuard, guardKey)`：`/^\d{6}$/` 前置校验，`WINDOW=1` 遍历 `step-1..step+1`；命中后若传了 `replayGuard`+`guardKey`，用 `Map<key, Set<step>>` 拒绝同步长重放，单键只保留 `current-s>2` 的步数，`size>5000` 时全表清扫。

**常量**：`STEP=30`、`DIGITS=6`、`WINDOW=1`、`BASE32_ALPHABET`。

**副作用**：`replayGuard` 是调用方持有的内存态，重启即失效。

### server/src/utils/webSearch.js（88 行）

**职责**：Tavily 网页搜索适配器，供 AI 助手的 `search_web` 工具。

**关键导出**：`searchWeb(query, {apiKey='', maxResults=5})`——query 截 400 字；key 取 `apiKey` 或 `config.websearch.apiKey`（`WEBSEARCH_API_KEY`）；60s 同词缓存（`Map`，`CACHE_MAX=200`）；`POST https://api.tavily.com/search`，9s 超时，`max_results` 钳在 1–10，`search_depth:'basic'`、`include_answer/images:false`；结果归一化为 `{title≤200, url≤500, snippet(空白压缩后≤400)}` 并过滤空 title/url；401/403 与 432 有专门文案；返回 `{ok, results, error?, cached?}`，永不抛错。

**副作用**：模块级 `cache`；淘汰按 `cache.keys().next()`（插入序）。

## 观察

**死代码 / 重复实现**
- `server/src/utils/sanitize.js:62` 与 `:66-78`：`:62` 的 `/^[\d.]+$/` 已经把**所有** IPv4 字面量主机判死返回 `''`，后面 66–78 行整套「0/8、10/8、127/8、169.254、172.16/12、192.168、100.64/10、≥224」保留段判断以及 `parts.some(p=>p>255)` 永远不会执行——注释（`:64-65`）声称按段过滤，实际是「任何 IP 直链 URL 一律拒绝」，友链指向 IP 站点会被静默判非法。
- `server/src/utils/antiSpam.js:13-25` 与 `server/src/utils/aiModeration.js:26-37,48-50`：两份高度重叠的词库（博彩/套现/办证/代开发票/色情/裸聊/约炮/援交）各自维护、权重不同（硬拒 vs 25 分），改一处不会同步另一处。
- `server/src/utils/antiSpam.js:28` 与 `server/src/utils/aiModeration.js:64`：`LATIN_WORD_RE` 逐字重复定义。
- `server/src/utils/aiClient.js:129`：`maxTokens || ai.maxTokens || 2048` 的 `2048` 分支不可达（`getAiConfig` 的 `maxTokens` 恒有值 256–8192），且与 `:47` 的默认 4096 自相矛盾。
- `server/src/utils/securitySettings.js:213-312`：`mergeValid` 里 base 段（`:217-260`）与 patch 段（`:263-310`）是同一套校验逻辑抄了两遍，加字段必须改两处，漏一处就是「部分提交被静默忽略」。
- `server/src/utils/stripExif.js:45`：`marker !== 0xe1` 跳过的是**全部** APP1，而 APP1 同时承载 XMP（`ns.adobe.com/xap/1.0/`，其中也有 GPS），注释只写「EXIF 段」。

**逻辑/契约缺陷**
- `server/src/utils/stripExif.js:27-30`：`FF00` 分支只 `i += 1`，下一步仍落在 `0x00` 上，`buf[i] !== 0xff` 立刻 `return buf`（`:24`）。注释「从下一字节继续解析」与代码不符，正确应为 `i += 2`；后果是段间出现填充字节的 JPEG 直接整份回退，EXIF 原样保留却无人知晓。
- `server/src/utils/settings.js:51-52` 注释写「正文 6000 字 / 历史 24 条」，`server/src/utils/aiClient.js:52-54` 实际默认 20000 字 / 48 轮——文档与代码不一致，后台不填时行为与注释描述不同。
- `server/src/utils/notes.js:18`：`parseImages` 对已是数组的输入 `return raw` 直接放行，跳过字符串分支里的类型过滤；`noteSummary` 的 `cover`/`image_count` 因此可能来自非字符串项（对象/数字），与 `serializeImages` 的严格清洗不对称。
- `server/src/utils/notes.js:63`：`noteSummary` 无条件带出 `status`，草稿/待审状态是否外泄全看调用方是否额外过滤，工具函数无兜底。
- `server/src/utils/response.js:10-12`：`notFound` 不带 `data`，而 `ok`/`fail` 恒带；前端统一读 `res.data.xxx` 会在 404 分支拿到 `undefined`。
- `server/src/utils/totp.js:19-34`：`offset>3` 时读 `bytes[byteIndex+1]`，长度非 8 的倍数即越界（得 `undefined`→位运算 0），不抛错但**静默降熵**；默认 32 字符恰好不触发。
- `server/src/utils/slugify.js:1` 注释称「拼音/英文原样保留」，代码无任何拼音转换，中文原样留在 slug（`:7`），URL 里实际是百分号编码——注释与实现不符。
- `server/src/utils/webSearch.js:37-40`：缓存键只有 `query`，忽略 `maxResults` 与 `apiKey`；先以 `maxResults=5` 查询后再要 10 条，命中缓存仍只返回 5 条（缓存命中路径没有 `slice`）。

**安全 / 可靠性隐患**
- `server/src/utils/sanitize.js:129-136`：`allowedAttributes:false` + `allowVulnerableTags:true` 意味着 `onclick=`、`href="javascript:"` 等属性会**原样入库**，安全完全押在前端 DOMPurify 上；一旦 `rss_full_content`（`settings.js:64`）打开或任何消费方直接渲染，就是存储型 XSS 通道。
- `server/src/utils/sanitize.js:136`：`cleanMarkdown` 用 `slice(0,maxLen)` 而非 `sliceSafe`，恰好违反 `:7-16` 自己写下的「不许切断代理对」结论——正文 10 万码元截断处若落在 emoji 中间，会产生入库即损坏的孤立代理。
- `server/src/utils/securitySettings.js:180-183`：`getConfig()` 首次调用只「踢一下」异步 `reload()` 就返回默认值，进程刚启动的一批请求 WAF 用的是默认配置（若站长把 `paranoiaLevel`/`anomalyThreshold` 调严过，这段窗口是放行的）。
- `server/src/utils/securitySettings.js:185-197`：`reload()` 无论 DB 是否失败都置 `loaded=true`，一次性抖动即把默认值固化到下次显式 `reload()`；更糟的是随后 `saveConfig()`（`:323-324`）以这份默认值为 base 合并写回，会把库里的白名单/词库/阈值整体覆盖成默认。
- `server/src/utils/securitySettings.js:386`：`isAllowedText(text)` 在不传 `matchedWord` 时仍是「文本含任一豁免词就放行」的旧语义，`:346-379` 那一大段注释论证的严格相邻语义只对传了命中词的调用方生效——新调用点漏传即回到可绕过的老漏洞。
- `server/src/utils/antiSpam.js:49`：每个命中词都同步调 `isAllowedText`，其对每条命中位置 × 每个豁免词做双层 `indexOf`（`securitySettings.js:389-408`），词库 100×100 即每请求上万次扫描。
- `server/src/utils/ownerBadge.js:13,22`：博主身份**只按昵称**判定，访客填上管理员昵称即可拿到「博主」标记；60s 缓存无主动失效，改名后判定最长滞后 60s。
- `server/src/utils/notifyMail.js:127-130`：`.catch(() => { resolve(false) })` 既不打日志也不返回原因，SMTP 认证失败/被拒信/超时在业务层全部表现为「没收到邮件」，线上无法定位。
- `server/src/utils/notifyMail.js:13-21`：`cfg` 在模块加载时快照，改环境变量须重启；`:105-114` 每次发信新建 transporter，无连接池。
- `server/src/utils/siteHost.js:31-35`：`site_url` 未配置时基址直接取 `req.protocol + req.get('host')`，Host 头可被伪造，会污染 RSS/Sitemap/分享页的绝对链接（一旦被爬虫缓存则扩散）。
- `server/src/utils/siteHost.js:12-22`：无方括号的 IPv6 Host 被 `split(':')[0]` 截断；未归一 `www.`，`www.xalor.cn` 会落进博客版分支。
- `server/src/utils/crypto.js:15-19`：`ticket + '|' + articleKey` 裸分隔符拼接，`('a|b','')` 与 `('a','b')` 派生同一密钥；票据字符集不限制即密钥空间碰撞。
- `server/src/utils/aiModeration.js:202-228`：`clearTimeout(timer)` 只在 `fetch` 成功后执行，`:269` 的 catch 不清理——每次网络失败都留一个 8s 定时器。
- `server/src/utils/aiClient.js:136-142`：90s 定时器覆盖**整个流**，长文超过 90s 会在流中途 abort；`AbortError` 不带 `code`，上层无法区分超时与上游 5xx。
- `server/src/utils/settings.js:274`：只置空**本进程**缓存，多实例部署下其余进程最长 60s 仍读旧值（`ai_moderation` 等安全开关同样滞后）。
- `server/src/utils/webSearch.js:70-75`：上游 `url` 未过 `safeUrl` 就进工具消息，`javascript:` 或内网地址被原样喂给 LLM。

**性能**
- `server/src/utils/datetime.js:6-15`：每次调用都新建 `Intl.DateTimeFormat`（构造开销远大于 `format`），而它被请求级路径频繁调用；模块级缓存一个 formatter 即可。
- `server/src/utils/aiModeration.js:81-92`：`countHits` 对每个拉丁词每次调用都 `new RegExp`，约 60 个词 × 每条评论，正则编译成本落在请求热路径上。

## 小结

1. 这 18 个文件是整个后端的「无状态内核」：不定义路由、不写业务表结构，只提供加密、审核、清洗、配置、时间、TOTP 这些被 `routes/` 与中间件反复调用的原子能力，任何默认值/阈值改动都会横向扩散到评论、留言、AI 助手、RSS 与双域名链路。
2. 配置有两条通道且语义不同：`settings.js` 异步 TTL 缓存 + 写白名单（缺键静默丢弃）；`securitySettings.js` 同步内存缓存 + 默认值深合并（缺字段回落默认），因服务每请求都读的 WAF/信誉路径而必须同步。
3. 信任边界集中：`sanitize.js` 负责入库前收敛，`cleanMarkdown` 主动把属性过滤让渡给前端 DOMPurify；`crypto.js` 的密钥绑定只提高批量抓取成本而非访问控制；`ownerBadge.js` 是展示性标识而非权限。
4. 外部依赖面窄但都在热路径：LLM、Tavily、SMTP 全部自带超时并**永不向业务层抛错**，统一降级为 `null`/`false`/`pending`——可用性优先，代价是故障不可观测（尤其 `notifyMail` 静默吞异常）。
5. 审核是分层 fail-closed 的：`antiSpam` 硬拒高置信词 → `aiModeration.localModeration` 打分 → 中分/`forceLlm` 才进 LLM → LLM 不可用一律 pending。这条链路的下限由 `securitySettings.isAllowedText` 的相邻语义和 `settings.ai_moderation` 开关共同决定，也是本区最容易因「少传一个参数」而整体失效的位置。
6. 最需复核的三处：`sanitize.js` 的 IPv4 段判断整块不可达（策略与注释不符）；`securitySettings.reload()` 失败即固化默认值，并可能被 `saveConfig` 写回覆盖库配置；`stripExif.js` 的 `FF00` 分支使 EXIF 剥离静默失效。
