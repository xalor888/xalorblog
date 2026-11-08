# W2-web-utils-security —— 前端安全/凭证工具

范围：`web/src/utils/` 下 10 个安全与凭证相关模块，共 918 行，逐文件通读。契约部分已对照 `server/src/middleware/gate.js`、`server/src/middleware/formToken.js`、`server/src/routes/anti.js`、`web/src/api/index.js` 核实，不依据注释自述。

### web/src/utils/pass.js（245 行）

- **职责**：通行证票据的完整生命周期——PoW 换票、8 分钟滑动续期、跨刷新/跨标签页复用、服务端判废后重取。
- **导出**：`ensurePass()`、`getTicket()`、`forceRefresh()`、再导出 `DEFAULT_ENC_SALT as ENC_SALT`。模块级私有状态：`ticket`、`ticketTime`、`inFlight`（单飞 Promise）、`renewTimer`。
- **实际逻辑**：
  - `readRaw/writeRaw/dropRaw` 对任何 storage 操作 try/catch，隐私模式退化为纯内存。
  - `persist()` 把 `{t: ticket, ts: ticketTime, s: getEncSalt()}` 同时写 `sessionStorage['xalor_pass_v1']` 与 `localStorage['xalor_pass_keep_v1']`；键名故意与 `secureStorage` 的键区分，避免被「迁移后清除 localStorage」逻辑删掉。
  - `parseRecord()` 校验 `rec.t` 是含 `.` 的字符串（票据形如 `ts.jti.sig`）且 `Date.now()-rec.ts < TICKET_TTL`(10min)；不合法即丢弃。
  - `readPersisted()` 先本标签页、再跨标签页副本，命中后回填一份到 sessionStorage；两份都坏才双删。
  - `raw(path, options)`：自建 `fetch`（不走 axios，避免 `api/index.js → pass.js` 循环依赖），头为 `X-Fp`（await 指纹）、有票时 `X-Pass`、非 GET 时 `X-Timestamp`、有 body 时 `Content-Type: application/json`；`AbortController` 10 秒超时；`credentials: 'same-origin'`；`res.status>=400 || data.code!==0` 抛 `Error(data.message || '安全通道建立失败')` 并挂 `err.status`。
  - `acquire()`：`GET /anti/puzzle` → `solvePow(prefix, difficulty)` → `POST /anti/ticket {id, solution}`；收到 `enc_salt` 先 `applyEncSalt`，再落 `ticket`、`persist()`、`scheduleRenew()`。
  - `renew()`：`POST /anti/renew {}` 免 PoW 续签；任何异常回落 `forceRefresh()`（重走 PoW）。
  - `scheduleRenew()`：`remain = RENEW_AT(8min) - (now - ticketTime)`，过点则延后 `RENEW_GRACE`(3s)，避免与首屏请求爆发同刻。
  - `ensurePass()`：内存票据未满 10 分钟直接 resolve；否则复用 `inFlight`，`finally` 清空。**模块加载时**立即执行一次 `readPersisted()` 并在命中时 `applyEncSalt(rec.s)` + `scheduleRenew()`。
- **项目内依赖**：`./fingerprint`(`getFingerprint`)、`./pow`(`solvePow`)、`./encSalt`(`applyEncSalt`/`getEncSalt`/`DEFAULT_ENC_SALT`)。
- **后端契约**：`GET /api/anti/puzzle` → `{code:0, data:{id, prefix, difficulty}}`（`anti.js:42-50`）；`POST /api/anti/ticket` → `data:{token, ttl:600000, renew_at:480000, enc_salt}`（`anti.js:63-67`）；`POST /api/anti/renew` → `data:{token, ttl, enc_salt}`（`anti.js:81-82`）。`/anti/ticket|renew` 都要求 `X-Fp` 通过 `isValidFp`（hex 哈希），否则 403「设备指纹无效」；`/anti/puzzle` 限流 10 次/15s，`ticket|renew` 20 次/分。
- **UI/交互**：无 UI。全流程静默，PoW 期间页面只会「请求迟迟不返回」，没有骨架/进度提示（`solvePow` 的 `onProgress` 在此未被使用）。
- **副作用与失败模式**：导入即读写 storage 并注册定时器（模块副作用不纯，SSR/测试环境导入就会动 `globalThis`）；换票/续期各写两处存储；PoW、网络、429 任一失败都以 `Error` 抛出并让所有 await `ensurePass()` 的请求一起失败，没有降级路径；票据从 localStorage 恢复时不校验指纹是否仍然匹配。

### web/src/utils/pow.js（99 行）

- **职责**：SHA-256 前导零工作量证明求解器，用批处理 + 事件循环让步把算力换算成不卡渲染的等待。
- **导出**：仅 `solvePow(prefix, difficulty, onProgress)`。
- **实际逻辑**：模块级 `ENCODER = new TextEncoder()` 复用；`BATCH_TARGET_MS=4`、`MIN_BATCH=64`、`MAX_BATCH=8192`、`EWMA_ALPHA=0.3`。`sha256LeadingZeros(text, difficulty)` 直接检查 digest 字节——整字节 `fullBytes` 必须全 0，残余 `remain` 位用 `bytes[fullBytes] >> (8-remain)` 判高位，省掉 hex 转换。`solvePow` 每轮：回调 `onProgress(nonce)` → 构造 `batchSize` 个 `nonce+i` → `Promise.all` 并发 `crypto.subtle.digest` → `findIndex(Boolean)` 命中即 `String(nonce+idx)` 返回 → 未命中 `nonce += batchSize` → 用本批耗时算吞吐 `measured`，EWMA 平滑后把 `batchSize` 反算到 ~4ms → `await yieldToLoop()`。`yieldToLoop` 用单例 `MessageChannel`（不受 `setTimeout` 嵌套 4ms 钳制），无 `MessageChannel` 时退化为 `setTimeout(r, 0)`。`nonce > 0xffffffff` 抛「PoW 求解失败」。
- **项目内依赖**：无（仅 `crypto.subtle`、`MessageChannel`、`performance`）。
- **后端契约**：`difficulty` 由服务端下发（`gate.js:16-17` 的 `config.security.powDifficulty`；`gate.js:145` 对可疑指纹升到 `powDifficultyMax`，并按 IP 信誉 `adaptiveDifficulty` 加分）；`prefix` 是 12 字节随机 hex；nonce 拼接格式为 `prefix + ':' + n`，服务端 `gate.js:184` 以同格式 `sha256hex` 复算并 `digestHasLeadingZeros`。
- **UI/交互**：无组件、无 DOM 访问；靠 MessageChannel 让步维持 rAF。
- **副作用与失败模式**：`crypto.subtle` 在非安全上下文（http 非 localhost）为 `undefined` → 首个 digest 直接 TypeError，`ensurePass` 失败、全站请求失败；`Promise.all` 不早退，命中后同批剩余哈希仍会跑完；单例 channel 的 `port1.onmessage` 每批重写，两个并发求解器会互相覆盖 resolve。
- **注释/实测值**：文件头 1-18 行记录了原实现（128 次/批 + `setTimeout(0)`，2.6 万 h/s，难度 20 约 40s）与现实现（46.7 万 h/s，约 2.2s）、以及与 `scheduler.yield()`、混合让步方案的 rAF 间隔对比，属带测量依据的性能说明。

### web/src/utils/signedFetch.js（69 行）

- **职责**：绕开 axios 拦截器的签名 `fetch`，供后台导出（CSV/JSON）与 AI 接口这类需要拿原始 `Response`/流的地方使用。
- **导出**：仅 `signedFetch(url, {method, body, headers, signal})`，返回未解析的 `Response`。
- **实际逻辑**：`jti = ticket.split('.')[1]`；`nonce = randomHex(16)`；`bodyHash = sha256Hex(typeof body==='string' ? body : JSON.stringify(body ?? {}))`（空 body 等价 `'{}'`）；`msg = [METHOD, sigPath(url), ts, bodyHash, jti, nonce].join('|')`；`sig = HMAC-SHA256(key=ticket, msg)`。`sigPath` 先切掉 `?` 之后，再把 `VITE_API_PREFIX` 前缀剥掉（`path.slice(prefix.length) || '/'`），以对齐服务端的「挂载点相对路径」。头齐全：`Authorization`、`X-Pass`、`X-Fp`、`X-Timestamp`、`X-Nonce`、`X-Sig`，有 body 时补 `Content-Type`，`...headers` 允许调用方覆盖。
- **项目内依赖**：`./pass`(`getTicket`)、`./fingerprint`(`getFingerprint`)、`./authSession`(`getAuthToken`)。
- **后端契约**：`gate.verifySig`（`gate.js:305-331`）——`X-Timestamp` 必须 10~13 位且 `|now-t| ≤ SIG_WINDOW`；`bodyHash = sha256hex(JSON.stringify(req.body || {}))`；`path = decodeURIComponent(req.path)`；`expect = HMAC(ticket.token, [METHOD, path, t, bodyHash, jti, nonce])`，`timingSafeEqual` 比对后 `consumeNonce`（一次性，`/^[a-zA-Z0-9]{8,64}$/`）。
- **UI/交互**：无 UI；调用方为 `AskAi.vue`、`Settings.vue`、`CommentManage.vue`、`MessageManage.vue`、`ArticleManage.vue`、`AuditManage.vue`、`AiPanel.vue` 的导出/流式逻辑，各自判断 `resp.ok` 并自行拼 `Blob`。
- **副作用与失败模式**：不解析响应、不抛业务错误；没有超时（与 axios 的 20s 形成反差）；不处理 401/403/429，也不会 `forceRefresh` 后重试，票据恰在导出瞬间被续期替换时导出静默失败。

### web/src/utils/formToken.js（86 行）

- **职责**：按提交路径缓存 `/anti/seed` 签发的表单令牌与动态蜜罐字段名，并保证「签发后 ≥2.1s 才提交」。
- **导出**：`getFormTokenInfo(forPath, {silent})`、`getFormToken`（旧调用兼容，只返回 token）、`getHpField`、`refreshFormToken`、`warmFormToken`。
- **实际逻辑**：`cachedByPath: Map<path,{token,hpField,ts}>`、`fetchingByPath: Map<path,Promise>`；`TOKEN_MAX_AGE=5min`、`MIN_SUBMIT_AGE=2100`。`tokenIssuedAt` 解析令牌首段（服务端格式 `ts.nonce.sig`）拿签发时间；`waitUntilReady` 计算 `2100 - (now - issued)` 并 `sleep`。命中缓存（未超 5 分钟）返回 `waitUntilReady(cached)`；有 in-flight 复用其 Promise，否则 `request.get('/anti/seed', {params:{for}, silent})`，`hpField = data.hp_field || 'hp_website'`，写入缓存并在 `finally` 清 in-flight。`refreshFormToken` 按路径或全量清缓存。`warmFormToken` 仅在 `useSiteStore().loaded` 为真时预热 `/comments`、`/messages`、`/links` 三条路径，失败静默。
- **项目内依赖**：`@/api`（axios 实例）、`@/stores/site`(`useSiteStore`)。
- **后端契约**：`GET /api/anti/seed?for=/comments` → `data:{token, min_interval:2000, ttl:600000, hp_field}`（`anti.js:92-97`）；令牌 `HMAC(secret, fp|ua|path|ts|nonce)`，`formTokenRequired` 校验路径/指纹/UA 且 nonce 一次性消费；蜜罐名由服务端按 `X-Fp|path|now.slice(0,8)` 派生为 `hp_` + 8 个字母。提交侧另有 `X-Hp-Field` 头声明（调用方 `CommentSection.vue:396`、`Messages.vue:382`、`Links.vue:163`），服务端在自身 `expectedHp` 之外再按该头二次判定。
- **UI/交互**：本身不渲染；约定调用方把 `form[hpField]` 渲染成真实用户看不见/不会填的输入框（`CommentSection.vue:59-60`），提交时把 `hpField` 作为 `X-Hp-Field` 发出。`silent` 选项透传给 axios 配置，配合 `api/index.js` 的 `silent` 分支抑制 429 提示。
- **副作用与失败模式**：`warmFormToken` 一次触发 3 个并发 `seed` 请求；任何新路径的首次提交会被 `sleep` 2.1 秒（预热命中则不阻塞）；`useSiteStore()` 在无 Pinia 上下文调用会抛错；失败重试时 `fetchingByPath` 未清的历史 Promise 可能被复用。

### web/src/utils/crypto.js（54 行）

- **职责**：用 WebCrypto 解密服务端下发的 AES-GCM 正文密文。
- **导出**：`decryptContent(payload, ticket = null, articleKey = '')`。
- **实际逻辑**：`useTicket = ticket || getTicket()`，缺一即返回 `''`；`atob` → `Uint8Array`；长度 `< 28`（12 IV + 16 tag）返回 `''`；切 `iv=raw[0..12)`、`tag=raw[12..28)`、`data=raw[28..)`；`deriveKey` 先 `importKey('raw', ENC_SALT, HMAC-SHA256)`，对 `String(ticket) + (articleKey ? '|'+articleKey : '')` 求 HMAC 得 32 字节，再导入为 **仅 decrypt** 的 AES-GCM key；最后把 `ciphertext || tag` 拼成连续 buffer 交给 `subtle.decrypt({name:'AES-GCM', iv, tagLength:128})`，`TextDecoder` 出明文。
- **项目内依赖**：`./pass`(`getTicket`)、`./encSalt`(`getEncSalt`)。
- **后端契约**：与 `server/src/utils/crypto.js` 同构：`key = HMAC-SHA256(ENC_SALT, ticket|articleKey)`，密文 base64 布局 `iv(12)|tag(16)|ciphertext`；盐由 `/anti/ticket|renew` 的 `enc_salt` 下发（`pass.js:163/181`），篇级密钥用于笔记（`notes.js` 用 `note:<id>` 形态的 articleKey）。
- **UI/交互**：无 UI；由 `api/index.js:143` 在响应拦截器里统一调用，并把失败标记成 `content_decrypt_failed` 交给页面。
- **副作用与失败模式**：`catch` 全吞返回 `''`，密钥/盐/密文任一不匹配都表现为「正文空白」，没有日志与错误码；`atob` 只接受标准 base64，遇到 base64url 会抛异常并被吞掉。

### web/src/utils/encSalt.js（15 行）

- **职责**：保存用于派生 AES 密钥的 HMAC 盐，构建期给默认值，运行期可被票据响应覆盖。
- **导出**：`DEFAULT_ENC_SALT`（`import.meta.env.VITE_ENC_SALT || 'xalor-content-v1'`）、`getEncSalt()`、`applyEncSalt(salt)`。
- **实际逻辑**：模块级 `let current = DEFAULT_ENC_SALT`；`applyEncSalt` 只接受 `string`，`trim()` 后长度必须落在 8–128，否则静默忽略（不抛错、不返回布尔）。
- **项目内依赖**：无。
- **后端契约**：需与 `config.security.encSalt`（`server/src/config.js:120-123`，生产环境强制非默认值且 ≥16 字符）一致；不一致时 `crypto.js` 解不出正文。
- **UI/交互**：无。
- **副作用与失败模式**：全局单点可变状态，被 `pass.js` 在换票/续期/恢复副本时写入；`applyEncSalt` 的静默拒绝让「服务端下发了 6 字符盐」这种配置错误表现为正文空白而非显式报错。

### web/src/utils/secureStorage.js（113 行）

- **职责**：会话级存储封装——敏感值只写 `sessionStorage`，并把旧版留在 `localStorage` 的值一次性迁入后立即删除。
- **导出**：`readSessionValue`、`writeSessionValue`、`removeStoredValue`、`migrateLegacyKeys`、`migrateLegacyPrefix`、`clearStoredPrefix`。
- **实际逻辑**：`getStorage(name)` 用 `globalThis[name]` 取 storage 并 try/catch（隐私模式抛错返回 null）；`read/write/remove` 全部容错。`readSessionValue`：session 有值 → 顺手 `remove(local, key)` 并返回；否则读 local，缺失返回 `''`，存在则写 session、删 local、返回旧值（即使 session 写失败本次仍可用）。`writeSessionValue`：先删 local 副本，空值则删 session 并返回 `true`，否则 `write`。`removeStoredValue` 双删。`migrateLegacyKeys(keys)` 对每个键调一次 `readSessionValue`。`migrateLegacyPrefix(prefix)`：先遍历 `localStorage.length/key(i)` 收集所有匹配前缀的键，再逐个迁移（先收集后改，避免边遍历边删导致跳项）。`clearStoredPrefix(prefix)` 对 session 与 local 各做一次「收集后删除」。
- **项目内依赖**：无（被 `authSession.js`、`fingerprint.js`、`main.js`、`main-home.js`、`ArticleEdit.vue` 使用）。
- **后端契约**：无。
- **UI/交互**：无。
- **副作用与失败模式**：`readSessionValue` 带写副作用（迁移）与删除副作用，读操作不幂等；`write()` 用 `!!storage` 当成功标志，`setItem` 因配额/隐私模式失败时无法与「storage 不存在」区分；被 `pass.js:71-72` 刻意绕开的 localStorage 策略在此处是「读了就删」。

### web/src/utils/authSession.js（56 行）

- **职责**：JWT 与缓存用户对象的会话级存取，登出时连带清理未发布草稿。
- **导出**：`getAuthToken()`、`getCachedAuthUser()`、`setAuthSession(token, user)`、`setCachedAuthUser(user)`、`clearAuthSession()`、`clearAdminDrafts()`。
- **实际逻辑**：键 `xalor_token`、`xalor_user`；`memoryToken`/`memoryUser` 作为 sessionStorage 不可用时的当前页兜底。`getAuthToken` 惰性读并缓存；`getCachedAuthUser` 惰性读 + `JSON.parse`，解析失败即 `removeStoredValue(USER_KEY)` 并返回 null；`setAuthSession` 双写内存与 session（user 非对象则存空串）；`clearAuthSession` 清内存 + `removeStoredValue` 双键；`clearAdminDrafts` 清 `xalor_draft_` 前缀（`clearStoredPrefix`）。
- **项目内依赖**：`./secureStorage.js`（四个函数）。
- **后端契约**：`Authorization: Bearer <token>`（`api/index.js:82` 仅在有 token 时设置；`signedFetch.js:57` 无条件设置）。
- **UI/交互**：无；被 `stores/auth.js`（37 行附近与 `clearAdminDrafts` 组合）、`api/index.js` 的 401 分支（动态 import `stores/auth` 后 `clearSession()`）间接驱动。
- **副作用与失败模式**：`clearAuthSession` 不重置 Pinia 内的其他缓存（由调用方补），也不清 `xalor_admin_path`；`setAuthSession` 忽略 `writeSessionValue` 的返回值，持久化失败对 UI 不可见。

### web/src/utils/fingerprint.js（101 行）

- **职责**：采集 Canvas/WebGL/硬件/环境特征，SHA-256 成 64 位 hex 作为设备指纹，供票据与令牌绑定。
- **导出**：`getFingerprint()`。
- **实际逻辑**：`canvasFingerprint` 建 240×60 canvas，固定字体 `14px Arial`、固定填充与两段文本（`Xalor-Blog-Fingerprint-7f3a`、`xalor.site secure`），`toDataURL().slice(0,4000)`；异常返回 `'canvas:unavailable'`。`webglFingerprint` 取 `WEBGL_debug_renderer_info` 的 `UNMASKED_VENDOR_WEBGL|UNMASKED_RENDERER_WEBGL`，用后立刻 `WEBGL_lose_context.loseContext()` 释放上下文。`collectRaw` 以 `'|||'` 拼入：UA、`language`、`languages.join(',')`、`platform`、`hardwareConcurrency`、`screen WxHxcolorDepth`、`devicePixelRatio`、时区偏移、canvas、webgl、`!!window.chrome`、`maxTouchPoints`、`!!navigator.webdriver`、`Intl` 时区名。`getFingerprint` 三级缓存：内存 `cached` → 单飞 `pending` → `sessionStorage['xalor_fp_v3']`（用 `/^[0-9a-f]{64}$/i` 校验）→ 都未命中才重算并写回。
- **项目内依赖**：`./secureStorage`(`readSessionValue`/`writeSessionValue`)。
- **后端契约**：作为 `X-Fp` 头；服务端 `isValidFp` 要求十六进制哈希，票据签名 `HMAC([VERSION, fp, ua, ts, jti])` 内含 fp（`gate.js:265`），指纹变化即票据作废；表单令牌同样绑定 fp。
- **UI/交互**：无 UI；`getFingerprint` 在 `api/index.js` 的每个请求拦截器里被 await（有缓存，实际只算一次）。
- **副作用与失败模式**：创建 canvas/WebGL 上下文（首算有几十毫秒开销）；`sessionStorage` 被禁时每个标签页刷新都重算；任何 `crypto.subtle` 缺失直接 reject，连带票据获取失败。

### web/src/utils/adminPath.js（80 行）

- **职责**：从服务端取「由 JWT_SECRET 派生的后台秘钥路径」，缓存后供路由跳转与接口拼装。
- **导出**：`getAdminPath()`、`getCachedAdminPath()`、`adminHref(seg)`、`refreshAdminPath()`。
- **实际逻辑**：`sanitizePath` 白名单 `[a-zA-Z0-9_-]` 并截 16 位；模块加载时用 try/catch 从 `localStorage['xalor_admin_path']` 读入并清洗到 `cached`。`getAdminPath` 命中 `cached` 直接 resolve，有 `pending` 则复用，否则 `pending = (async () => { ... })()`：动态 `import('@/api')` 取 axios 默认导出 → `request.get('/anti/admin-path')` → 清洗 `data.path` → 非空则写 `cached` 与 localStorage → `finally` 清 `pending`；任何错误返回 `''`。`adminHref(seg)` 在未知路径时返回 `/_` 或 `/_/seg` 占位。`refreshAdminPath` 清 `cached` + localStorage 后重取。
- **项目内依赖**：动态 `@/api`（避免与 `api/index.js → adminPath.js` 的静态循环依赖）；被 `router/factory.js`、`stores/admin.js`、`Layout.vue`、`Dashboard.vue`、`Login.vue`、`ArticleManage.vue`、`NoteManage.vue`、`NoteEdit.vue`、`AiPanel.vue`、`Settings.vue` 等 20 余处消费。
- **后端契约**：`GET /api/anti/admin-path`，必须持有效票据（`anti.js:105-108`，`verifyTicket` 失败即 403「访问被拒绝」）；返回 `data:{path}`；该路由挂 `issueLimiter`（20 次/分）。请求经 axios，因此自动带 `X-Fp/X-Pass/X-Timestamp/X-Sig`。
- **UI/交互**：无渲染；`adminHref` 决定后台侧边栏与卡片链接的 URL 形态（`Layout.vue:24`、`Dashboard.vue:32-73`）。`router/factory.js:56-59` 对占位 `/_` 与失效旧路径做 `refreshAdminPath` 兜底，属隐式契约。
- **副作用与失败模式**：模块加载即读 localStorage；成功即持久化到 localStorage（无 TTL）；失败返回空串且不缓存负结果，路由守卫随后会再次请求。

## 观察

1. `web/src/utils/pass.js:71-72` —— 票据与 `enc_salt` 被写入 `localStorage`（`xalor_pass_keep_v1`），而同目录 `secureStorage.js:47-49` 的既定策略是「读到 localStorage 副本就删除」。同一仓库两套相反的敏感数据策略，`pass.js:12-15` 只在注释里自认「有意放宽」，没有统一的策略出口。
2. `web/src/utils/pass.js:236-242` —— 恢复副本时只用 `applyEncSalt`，不校验 `X-Fp` 是否仍与票据匹配。换外接屏或浏览器缩放后 `devicePixelRatio/screen` 变化 → 指纹变而票据不变，首屏若干请求先吃 403，只能等 `api/index.js:189-200` 的闸门错误分支重试，10 分钟有效期内不会自愈。
3. `web/src/utils/pass.js:207-218` —— `ensurePass` 无超时、无降级：`solvePow` 因非安全上下文缺 `crypto.subtle` 而拒绝时，所有 await 它的请求一同失败，页面表现为全站空白而无专门提示。
4. `web/src/utils/pow.js:33-42` —— `yieldChannel` 是模块单例且每批重写 `port1.onmessage`；两个并发 `solvePow` 会互相覆盖 `resolve`，先挂起的那个 promise 永远不被唤醒。当前仅 `pass.js:212` 单飞调用所以未暴露，属潜在死等。
5. `web/src/utils/pow.js:81-83` —— `Promise.all` 全批算完才 `findIndex`，命中后同批剩余最多 8192 次哈希照跑，等于每次求解多烧最多一批算力。
6. `web/src/utils/pow.js:67` —— `onProgress` 参数在仓库内无任何调用方（`pass.js:157` 只传两个实参），进度能力是死参数，用户侧 PoW 期间完全无反馈。
7. `web/src/utils/signedFetch.js:12-33` —— `randomHex`/`sha256Hex`/`hmacHex` 与 `web/src/api/index.js:30-52` 是逐行重复的两份实现，签名算法（含 `bodyHash` 口径）任何改动都要同步两处，漏一处即全量导出 403。
8. `web/src/utils/signedFetch.js:35-40` —— `sigPath` 依赖 `VITE_API_PREFIX` 剥前缀，但调用方写死 `/api/${key}/...`（如 `web/src/views/admin/CommentManage.vue:267`、`ArticleManage.vue:199`）。一旦把前缀改成随机串，签名的 path 与服务端 `req.path` 不一致，导出必然失败。
9. `web/src/utils/signedFetch.js:57` —— 无条件发 `Authorization: Bearer ${getAuthToken()}`，未登录时是 `"Bearer "`；`api/index.js:82` 则只在有 token 时才加该头，两处对「空凭据」的处理不一致。
10. `web/src/utils/signedFetch.js:53-68` —— 没有超时、不解析业务码、不处理 401/403/429，也不像 axios 侧那样 `forceRefresh` 后重试一次；票据在导出请求在途时被续期替换，导出会静默失败而调用方只能看到 `!resp.ok`。
11. `web/src/utils/formToken.js:5-7` —— 注释称「服务端令牌 10 分钟过期」，而 `server/src/middleware/formToken.js:19` 的 `TOKEN_TTL` 是 60 分钟；真正导致「首次提交必失败」的是 nonce 一次性消费（`formToken.js:71-72` 自己的注释写了「已消费」），注释给错了失效原因。
12. `web/src/utils/formToken.js:7-8` —— `MIN_INTERVAL=2s`/`MIN_SUBMIT_AGE=2100` 的前提在服务端不存在：`min_interval:2000` 只是 `server/src/routes/anti.js:95` 回传的字段，全仓无任何入口校验它。这 2.1 秒是纯粹无后端依据的体验损耗。
13. `web/src/utils/formToken.js:72-75` —— `refreshFormToken` 只删 `cachedByPath`，不清 `fetchingByPath`；提交失败后立刻重试时可能复用到正在飞的旧令牌 promise，等于「刷新」无效。
14. `web/src/utils/formToken.js:47` —— 回落名 `'hp_website'` 与 `server/src/middleware/formToken.js:79-92` 派生的 `hp_` + 8 字母不同族；服务端先按自己算出的 `expectedHp` 查 body，只有 `X-Hp-Field` 二次判定能兜住回落名，一旦调用方漏发该头，蜜罐对填了可见字段的机器人即失效。
15. `web/src/utils/crypto.js:51-53` —— 异常全吞返回 `''`，盐/票据/密文任一不匹配都表现为正文空白，本文件无日志、无错误原因，只能靠 `api/index.js:149-155` 的 `content_decrypt_failed` 布尔区分，排查成本高。
16. `web/src/utils/crypto.js:36` —— `atob` 只接受标准 base64；服务端若改用 base64url（`-_`）会在这里抛异常并被吞掉，风险点没有测试或断言覆盖。
17. `web/src/utils/encSalt.js:13` —— `applyEncSalt` 只校验长度 8–128，不校验字符集或熵，且被拒时静默；盐是模块级全局，多个标签页各自 `applyEncSalt` 会在票据切换窗口内短暂不一致。
18. `web/src/utils/secureStorage.js:25-32` —— `write()` 返回 `!!storage`，storage 存在但 `setItem` 抛错（配额满/Safari 隐私）时无法与成功区分；`authSession.js:37-38` 又丢弃该返回值，于是「以为已持久化、实际只在内存」的情况完全静默。
19. `web/src/utils/authSession.js:15-17` —— `if (!memoryToken)` 使空串永远视为「未缓存」，未登录状态下每次调用都重走 `readSessionValue` 的迁移读路径，每个请求两次多余存储访问。
20. `web/src/utils/authSession.js:46-51` —— 登出只清 `xalor_token`/`xalor_user`，不清 `adminPath.js:45` 写入的 `xalor_admin_path`；同机换人后后台秘钥路径仍在 localStorage 里，等于把「防爬秘钥」这一层白送给下一个使用者。
21. `web/src/utils/fingerprint.js:58-59` —— `screen.*` 与 `devicePixelRatio` 计入指纹，而票据签名硬绑指纹（`server/src/middleware/gate.js:265`）；外接屏、窗口拖动到另一 DPI 屏、浏览器缩放都会造成「设备没变但指纹变」，与 2 号问题叠加成周期性 403。
22. `web/src/utils/fingerprint.js:63-65` —— `!!window.chrome`、`!!navigator.webdriver` 是 UA 级信号，脚本一行即可伪造，对自动化收益有限；代价是给真实 Firefox/Safari 用户制造稳定差异位，属于隐私成本换不到强防护的取舍。
23. `web/src/utils/adminPath.js:14`、`adminPath.js:45` —— 后台秘钥路径被写入 localStorage 且无 TTL，与本仓 `secureStorage.js` 全篇「敏感数据只留 sessionStorage」的约定正面冲突；任何 XSS 都能直接读走后台入口，而它的设计目的恰恰是隐藏后台入口。
24. `web/src/utils/adminPath.js:41-48` —— 服务端返回空/非法 `path` 时既不缓存也不记录，`getAdminPath()` 每次调用都会重新请求；路由守卫与页面多处会并发/连续调用，叠加 `anti.js:21-31` 的 20 次/分限流，可能把自己打成 429。

## 小结

1. 这 10 个模块构成前端的「准入门槛层」：`pow.js` 交算力、`pass.js` 换票据并续期、`fingerprint.js` 提供绑定维度、`signedFetch.js`/`api/index.js` 用票据做 HMAC 签名，四者缺一，所有经过 `gateRequired` 的读写接口都会被 403 拦住。
2. 与后端形成两条独立的信任链：票据链（`X-Fp` + `X-Pass` + `X-Sig`，`gate.js`）与表单令牌链（`formToken.js` 的 `ts.nonce.sig` + 动态蜜罐名，`middleware/formToken.js`），前者管读与写，后者只管三个公开表单提交；两条链都用「指纹 + UA + 一次性 nonce」而非 IP，避免 Cloudflare 双栈误杀。
3. 内容加密的密钥不在前端常驻：`crypto.js` 每次从 `encSalt` 与当前票据现算 `HMAC → AES-GCM` 密钥，且只导入 `decrypt` 权限，所以前端无法伪造密文；代价是票据轮换与解密之间有时序耦合（`api/index.js:62` 用 `config._ticket` 记录请求时票据来规避）。
4. 边界上是纯浏览器侧模块：全部依赖 `fetch`/`crypto.subtle`/`MessageChannel`/`document`，没有 Node 兜底，在非安全上下文（http 非 localhost）下整层会失效——这是部署约束，不是可选优化。
5. `secureStorage.js` + `authSession.js` 是唯一的会话数据出口，但 `pass.js`（票据）、`adminPath.js`（后台路径）两个模块刻意绕过它写 localStorage，形成三套并存的持久化策略；这是本区最结构性的一致性问题，也是 2/20/23 三条问题的共同根源。
6. 可测性较弱：`decryptContent` 吞异常、`applyEncSalt` 静默拒绝、`getAdminPath` 失败返回空串，三处「静默失败」使配置错误（盐不一致、后台路径变更）在运行期只表现为空白正文或反复请求，缺少可观测信号。
