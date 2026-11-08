# S8-test-harness — 集成测试执行器与客户端

覆盖 4 个文件：`server/test/run.js`、`server/test/client.js`、`server/test/reset-env.js`、`server/test/waf-fuzz.js`。这一分区不含断言本身，只含"怎么把服务拉起来、怎么冒充浏览器说话、怎么清环境、怎么喂攻击载荷"。

### server/test/run.js（165 行）

**职责**：集成测试总调度器——先用 mysql 客户端清持久化状态，再按端口杀掉旧服务、以 detached 方式重启 `src/server.js`，随后逐个套件串行执行，每个套件前重做一次"清库 + 重启"，最后收尾再清一次，让环境回到可 `npm run dev` 的状态。

**关键函数**

- `resolveMysql()`（14-22）：`MYSQL_BIN` 环境变量优先，否则用 `command -v mysql` / `where mysql` 探测，失败兜底返回裸 `mysql`。只影响可执行文件路径，不含账号密码。
- `run(cmd)`（41-49）：`execSync` 封装的壳命令执行器，`cwd` 固定 `serverDir`、`timeout: 15000`，**失败只打印首行错误并返回空串**，不抛、不累计失败。
- `main()`（51-66）：三步——① `RESET_SQL` 清库；② 非 `TEST_NO_RESTART` 时 `restartServer()`；③ 非 `TEST_SKIP_WAIT` 时 `waitServer()`，然后 `runTests()`。
- `restartServer()`（68-105）：Windows 走 `netstat -ano | findstr :3000 | findstr LISTENING` 取 pid 再 `taskkill /F`；POSIX 走 `lsof -ti :3000`，逐个 `process.kill(pid,'SIGKILL')`，**排除 `process.pid` 与 `process.ppid`**，再 `execSync('sleep 0.5')` 等端口释放。然后 `openSync(test-run.log,'a')`，`spawn('node',['src/server.js'],{detached:true, stdio:['ignore',out,out], env:{...process.env}})` 并 `unref()`，返回 child.pid。注释明确不在脚本里硬编码 `DB_PASSWORD`：`src/config.js` 对空值、占位值、<16 字符都会 `throw`，所以只透传外部环境，未设置时由 dotenv 读 `server/.env`。
- `waitServer()`（107-123）：Promise + 递归 `setTimeout(wait,500)` 轮询 `http://127.0.0.1:3000/api/health`，deadline 15s 写死，单次请求 `setTimeout(3000)` 主动 `destroy()`，超时只 `console.error` 后 **resolve**（不 reject）。
- `runTests()`（125-163）：默认 16 个套件，顺序为 `admin → 2fa → session → lockout → journey → waf → falsePositive → requestGuard → likeGuard → sanitize → feed → scrapeGuard → contentCrypto → browserCrypto → notes → security`；`process.argv[2]` 可指定单个文件。每套件前（首个套件除外）重跑 SET SQL + `restartServer()` + `waitServer()` + 500ms 静置；`security.test.js`/`2fa.test.js` 超时 240s，其余 60s；`execSync('node test/'+s,{stdio:'inherit'})` 失败被 `catch` 吞掉继续下一个。收尾再执行一次清库，非 `TEST_NO_RESTART` 时重启并等就绪。

**依赖**：Node 内置 `child_process`/`path`/`fs`/`http`；外部二进制 `mysql`；项目侧只通过子进程启动 `src/server.js`，不 require 任何项目模块。

**重要数据**

- 表与列：`ip_bans`（全删）、`users.totp_secret`/`users.totp_enabled`（置 NULL/false）、`comments.ip`、`messages.ip`、`links.url`、`notes.content`（`LIKE '%[NOTETEST]%'`）。
- 清库 IP 三元组：`'::1'`、`'127.0.0.1'`、`'::ffff:127.0.0.1'`；测试友链固定 `https://example.com`。
- 环境变量：`MYSQL_BIN`、`TEST_NO_RESTART`、`TEST_SKIP_WAIT`；库名硬编码 `xalor_blog`、账号硬编码 `-u root`（无密码）。
- 契约：健康探针 `GET /api/health`；端口 3000；日志文件 `server/test-run.log`（追加）。

**副作用/失败模式**：SIGKILL 任何监听 3000 的进程；spawn 出的服务进程脱离父进程存活；每次重启泄漏一个 fd（`out` 永不 close）；mysql 超时或套件超时都只留一行日志，进程退出码基本恒为 0；服务启动失败时现象是"服务启动超时"（来自 15s deadline），真正的报错只落在 `test-run.log`。

### server/test/client.js（196 行）

**职责**：反爬/反机器人链路的浏览器替身——指纹 → PoW 解题 → 换票据 → 逐请求 HMAC 签名 → 解包 JSON 响应；给各套件提供统一的 `req/getTicket/getFormToken/formPost/uploadFile/asBotUA`。

**关键导出与行为**

- 常量：`BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000'`（注释解释为何不走 `localhost`：macOS 双栈下 Happy Eyeballs 可能换协议族导致 `req.ip` 突变、票据 IP 绑定校验 403 → 间歇失败）；`UA` 固定 Chrome/126 桌面 UA；`fp = process.env.TEST_FP || 'a'.repeat(64)`，模块级可变。
- `sha256hex(s)` / `hmac(key,data)`（15-23）：`sha256` hex 与 `HMAC-SHA256` hex，后者正是票据签名的 key 形式（key 为 ticket 明文）。
- `req(method,path,{body,headers,ticket,silent,ua})`（25-64）：构造 `URL(BASE+path)`，默认头 `User-Agent`/`X-Fp`；有 body 时补 `Content-Type: application/json` 并 `JSON.stringify`。带 `ticket` 时生成 `ts=Date.now()`、`nonce`（两段 base36 拼接，12+4 位）、`bodyHash=sha256hex(data||'{})'`，`sigPath = path.replace(/^\/api(?=\/)/,'').split('?')[0]`，签名串为 `${METHOD}|${sigPath}|${ts}|${bodyHash}|${ticket.split('.')[1]}|${nonce}`，注入 `X-Pass`/`X-Timestamp`/`X-Nonce`/`X-Sig`。响应累计字符串、尝试 `JSON.parse`（失败置 `null` 保留 `raw`）；`silent` 为假且状态码 ≥400 时打印一行截断 160 字符的诊断；超时 10s 后 `destroy(new Error('timeout'))`；返回 `{status, headers, body, raw}`。
- `digestHasLeadingZeros(hexDigest,bits)`（67-75）：按字节校验前导零，长度不足 32 字节直接 false，余数位用右移掩码，bit 语义与前端/服务端一致。
- `getTicket(forceFp,customUa,extraHeaders)`（78-101）：`GET /api/anti/puzzle` 取 `{id,prefix,difficulty}`；从 0 递增枚举 `i`，命中 `sha256(prefix+':'+i)` 前导零 = difficulty 即解；再 `POST /api/anti/ticket`（附 `Origin`/`Referer: http://localhost:5173`）取 `data.token`。任一步非 200/缺字段即 `throw`。
- `getFormToken(ticket,forPath,options)`（104-113）：`GET /api/anti/seed?for=...`，返回 `{token, hp_field}` 整体（供 `formPost` 用）。
- `formPost(path,body,ticket,opts)`（169-189）：`forPath = (opts.forPath||path).replace(/^\/api/,'')`；先领 seed，等 `opts.minInterval||2100` ms 模拟人类填写；body 合并 `form_token`；`opts.fillHoneypot` 时把蜜罐字段填成 `http://spam.example.com` 并附 `X-Hp-Field` 头（对应 `src/middleware/formToken.js` 的 403 判定）。
- `uploadFile(path,fileBuffer,filename,mime,ticket,extraHeaders)`（126-166）：手写 multipart，boundary `----XalorTest+rand`；**签名时 bodyHash 固定按 `sha256hex('{}')`**，因为服务端 `verifySig` 用 `JSON.stringify(req.body||{})`，multer 解析前 `req.body` 为空对象；超时 15s。返回结构同 `req`（无 `<400` 日志）。
- `get/post/asBotUA`：`get` 是薄封装（见观察），`post` 直通 `req`，`asBotUA` 只换 UA、不带票据与指纹（用于测扫描器硬拦）。

**依赖**：仅 Node 内置 `http`/`crypto`；无项目 require，但与 `src/middleware/gate.js`（票据格式 `ts.jti.sig`、签名串顺序、`req.path` 去 `/api` 规则）、`src/routes/anti.js`（puzzle/ticket/seed 字段名）、`src/middleware/formToken.js`（`hp_field`、`x-hp-field`）形成隐式契约。

**重要数据**：环境变量 `TEST_BASE`、`TEST_FP`；路径 `/api/anti/puzzle`、`/api/anti/ticket`、`/api/anti/seed?for=`；超时 10000/15000ms；间隔 2100ms；PoW 枚举上限 5000 万；蜜罐值 `http://spam.example.com`。响应契约 `{code:1,message}` 失败体、成功体 `{data:{...}}`。

**副作用/失败模式**：`getTicket` 是纯 CPU 同步循环（阻塞事件循环）；错误信息只带原始 body、不带 method/path；无票据缓存、无重试，票据过期或 IP 漂移只能靠上层重跑；`fp`/`BASE` 在模块加载时定值。

### server/test/reset-env.js（67 行）

**职责**：`run.js` 的手动版——清封禁/TOTP/测试评论/测试友链 → 按端口杀旧服务 → 重启并写 `server-run.log` → 轮询 `/api/health` 直到就绪或 15s 超时退出。

**关键流程**：顶层顺序执行，无 async 主函数。`resolveMysql()` 与 run.js 完全同构（重复实现）。SQL 只有一条 `-e`：`DELETE FROM ip_bans; UPDATE users SET totp_secret=NULL, totp_enabled=false; DELETE FROM comments WHERE ip='::1'; DELETE FROM links WHERE url='https://example.com';`。杀进程分支：Windows `taskkill /F /PID`，POSIX `lsof -ti :3000` 逐个 `SIGKILL`。随后 `openSync('server-run.log','a')`、`spawn('node',['src/server.js'],{detached:true})` + `unref()`。等待段复用 run.js 的递归 `http.get` 写法，但探针是 `http://localhost:3000/api/health`，超时走 `process.exit(1)`。

**依赖**：`child_process`/`path`/`fs`/`http`；外部 `mysql`；子进程 `src/server.js`。

**重要数据**：同上表名列，但仅 `comments.ip='::1'`；日志文件 `server-run.log`；端口 3000；`MYSQL_BIN` 支持。

**副作用/失败模式**：SQL 失败只 `console.error` 仍继续重启（脏库上继续调试）；杀进程不排除自身/父进程；超时 `process.exit(1)` 时已 spawn 的服务仍在运行；日志与 run.js 分裂成两个文件；`out` fd 不关闭。

### server/test/waf-fuzz.js（188 行）

**职责**：进程内直调 `require('../src/middleware/waf').waf`，用假 `req` 把 78 条攻击载荷 × 17 种编码变体（共 1326 次）喂给 WAF，统计"拦截/放行"，把放行项打印成疑似绕过清单。

**关键函数/数据**

- 编码器（9-19）：`enc1/enc2/enc3` 单/双/三层 `encodeURIComponent`；`ent` 把 `<>"'&` 转十进制实体；`uesc` 把小写/大写字母转 `\uXXXX`；`full` 把字母数字做 `+0xfee0` 全角化；`hexCase` 随机大小写；`parseOnce` 用 `decodeURIComponent` 模拟 qs 解一次。
- `variants(payload)`（21-41）：返回 17 个变体——原文、1/2/3 层编码、HTML 实体、Unicode 转义、全角、全角+编码、双层编码+随机大小写、实体×(enc1/enc2/组合)、转义+编码，以及把空白替换成 `\t`/`\n`/`\v`/字面 `\\t`。
- 载荷池：`SQL_PAYLOADS` 21 条（union/布尔/堆叠/延时/outfile/注释绕过/`0x` 编码等）、`XSS_PAYLOADS` 15 条（含 `mglyph` 变形、`data:` URI、双写 `<scr<script>ipt>`）、`TRAVERSAL_PAYLOADS` 7 条（含 `%c0%af`、`%00`、`%252f`）、`CMD_PAYLOADS` 10 条（`;`/`|`/反引号/`$()`/`$IFS`/裸 `id`）、`SSRF_PAYLOADS` 11 条（十进制/八进制/十六进制 IP、`[::1]`、`[::ffff:127.0.0.1]`、元数据地址、`file://`/`gopher://`）、`OTHER_PAYLOADS` 14 条（Log4Shell、XXE、SSTI `{{7*7}}`、SpEL、CRLF 注入、`__proto__` 污染、`@type`、JSP 表达式）。
- `mkReq(searchValue)`（135-147）：假请求只暴露 `query.search`（已 `parseOnce`）、`ip:'127.0.0.99'`、`method:'GET'`、`path:'/api/articles'`、`originalUrl`、Chrome UA、`body:{}`。
- `run()`（149-186）：扁平化 6 类载荷 → 逐变体构造假 req 与最小 `res`（`set`/`status().json`），以 `next()` 是否被调用作为"放行"判据；统计 `total/blocked`，放行项压入 `misses` 后统一打印，全拦则打印"全部拦截 ✓"。

**依赖**：`../src/middleware/waf`（只取 `{ waf }`）；间接依赖 `waf-rules.js`、`ipGuard.report`、`securitySettings`。

**重要数据**：`res.status(403).json({code:1,message:'访问被拒绝'})` 等为服务端拒绝体（本文件用 mock 吞掉）；阈值/规则来自 `securitySettings`（`anomalyThreshold` 默认 5）；固定假 IP `127.0.0.99`；变体总数 78×17=1326。

**副作用/失败模式**：`waf()` 每次命中都会 `report(ip,'waf',...)`（`src/middleware/waf.js:472+`），同进程内同一假 IP 的信誉分会累加；无 DB/网络写入（除 ipGuard 内存态）；脚本无退出码语义——即使大量放行也 `exit 0`。

## 观察

1. `server/test/run.js:134-136` — 空 `if` 分支是死代码：注释说首个套件无需重启，但空块可整体删掉；副作用是单套件模式下仍会二次清库+重启，白付 2-4s。
2. `server/test/run.js:128-130` — 默认套件清单只有 16 个，仓库里还有 `allowWords/cacheInvalidation/homeSummary/moderationPolicy/notesCrypto/readingStats/routeEdgeCases/waf-fixtures` 8 个未纳入，它们只存在于 `package.json` 的 `npm test` 串联脚本；"全量集成"名不副实，尤其 `waf-fixtures.test.js`（RULE_INDEX 覆盖率门禁）在真实服务链路下跑不到。
3. `server/test/run.js:46-48`、`149-151` — 两处 `catch` 都只打印一行，`main().catch` 之外的失败全部被吞，进程退出码恒为 0，CI 无法用退出码判定红绿。
4. `server/test/run.js:148` — `execSync` 的 timeout 终止的是 shell，被 `node test/x.test.js` 派生的孙进程可能存活并继续打 3000 端口；长套件（240s）超时后下一轮 `restartServer` 才顺手清掉它，期间日志/状态会串。
5. `server/test/run.js:93` — 每次重启 `openSync` 一个 fd 交给 spawn 且永不 `close`，16+ 次重启即 16+ 个泄漏句柄；`test-run.log` 也没有轮转，长期跑会无限增长。
6. `server/test/run.js:112-116` — `waitServer` 只要求"拿到响应"就 resolve，不校验 `res.statusCode`；服务因 DB 未迁移/配置缺失返回 5xx 时同样打印"服务就绪"，后续套件在坏环境里得出误导性结论。
7. `server/test/run.js:79-87` — 按端口 SIGKILL 任意监听进程，仅排除自身与 `ppid`；开发者自己开的 `npm run dev`（父进程是 shell，不是本脚本）会被无声杀掉。
8. `server/test/run.js:31-39` — 清库假设 `mysql -u root` 无密码、库名写死 `xalor_blog`，与 `src/config.js` 的 `DB_*` 环境变量体系脱节；也没有 `MYSQL_PWD`/`DB_NAME` 注入点，非本机默认配置的环境直接失败（且失败被 46 行吞掉）。
9. `server/test/run.js:31-39` — 清了 `ip_bans/users.totp_*/comments/messages/links/notes`，但不清 `sessions`（登录态在 DB，服务重启不失效）、`gate_tickets`（持久化票据会跨套件恢复，见 `gate.js` 的 `loadPersistedTickets`）、`security_config` 与信誉表 → 跨套件污染仍然存在，注释宣称的"环境隔离"不完整。
10. `server/test/client.js:116-118` — `get()` 的三目表达式写反语义：`opts` 为票据字符串时 `{...opts}` 把字符摊成数字键，`opts.silent` 恒 `undefined`；为对象时只保留 `ticket` 丢掉 `headers`。全仓 grep 无 `c.get(` 调用，属于带 bug 的死导出。
11. `server/test/client.js:87-90` — PoW 求解是同步 5000 万次循环，每次迭代重建哈希/Buffer 并阻塞事件循环；`difficulty` 会随 IP 信誉自适应升到 `POW_DIFF_MAX`，且 `getTicket` 不做票据缓存，每个套件反复支付这笔 CPU（直接推高 60s 套件超时风险）。
12. `server/test/client.js:94` — `Origin`/`Referer` 硬编码 `http://localhost:5173`，与 `src/app.js` 的 `allowedOrigins` 绑定；换端口/域名测试时表现为"票据签发失败"的笼统错误，不指向 CORS。
13. `server/test/client.js:41` — 签名把 jti 取成 `ticket.split('.')[1]`，硬耦合 `gate.js:196` 的 `token = ts.jti.sig` 结构；一旦票据格式加字段（如版本前缀），全部请求静默 403 且没有断言能定位。
14. `server/test/client.js:104-113` — `getFormToken` 不做 `/api` 剥离与尾斜杠归一（`formPost` 在 170 行做了），单独调用时 `for` 与 `formTokenRequired` 计算的 `baseUrl+path` 不一致，签发即失效。
15. `server/test/client.js:192-194` — `asBotUA` 只换 UA：不带 `X-Fp`、不带票据，只能覆盖"扫描器 UA 硬拦"，无法表达"合法票据 + 异常 UA"这类更贴近真实的组合场景（`security.test.js` 用它做爬虫判定）。
16. `server/test/reset-env.js:25` — 与 `run.js:31-39` 的 `RESET_SQL` 语义漂移：只删 `comments.ip='::1'`（漏 `127.0.0.1`/`::ffff:127.0.0.1`）、不清 `messages`、不清 `notes` 的 `[NOTETEST]`，手动重置后仍会撞"重复内容检测"与列表断言。
17. `server/test/reset-env.js:40-46` — 杀端口进程时没有 run.js:83 那样的自身/父进程保护，误杀面更大；`process.exit(1)`（59 行）只结束等待循环，已 spawn 的服务继续在后台跑且只写进 `server-run.log`。
18. `server/test/reset-env.js:60` — 探活走 `localhost`，与 `client.js:8-11` 明确记录的 `::1`/`127.0.0.1` 抖动问题自相矛盾（run.js:113 用的是 `127.0.0.1`），史上"就绪但后续 403"的隐性来源。
19. `server/test/waf-fuzz.js:171-176` — 注释称"仅当原始载荷含攻击关键字才算绕过"，代码对每次放行无条件 `misses.push`，于是 `id`、`${7*7}`、`{{7*7}}` 这类本就无害的样本混进"放行明细"，判别力被稀释。
20. `server/test/waf-fuzz.js:135-147` — 假请求固定 `ip:'127.0.0.99'`，而 `waf()` 每次命中都 `report()` 到 `ipGuard`；同进程 1326 次请求会让该 IP 信誉分单调上升，后段样本可能因前段积分被拦，拦截率既不可复现也不可归因。
21. `server/test/waf-fuzz.js:149-178` — 用单请求二值模型（`next()` 调用与否）判定，忽略 `waf.js` 的异常评分语义：单条 warning/notice 命中"只计分不拦"是设计行为（默认阈值 5），却被计成"放行/绕过"，指标口径与实现相反。
22. `server/test/waf-fuzz.js:17-19` — `parseOnce` 先解一层，再交给 `waf` 的 `decodeLevel1/decodeLevel2` 解两层，`enc2` 变体等于被解三次，比真实 `express+qs`（解一层 + 引擎两层）更"深度归一"，拦截率偏乐观，编码绕过类结论不可信。
23. `server/test/waf-fuzz.js:15` — `hexCase` 用 `Math.random` 扰动大小写，同一命令两次运行结果不同，不能作为可复现门禁；`variants` 里 `full()`（14 行）对纯符号载荷（`$(id)`、`../../../etc/passwd`）是恒等变换，17 个变体中存在重复项，1326 这个分母含重复样本。
24. `server/test/waf-fuzz.js:6` — 直调中间件绕过 `src/app.js` 的 CORS/body parser/限流/gate 顺序，假 `req` 还缺 `baseUrl`/`socket`、假 `res` 缺 `removeHeader`/`type`；`waf` 一旦增加对这些属性的依赖，本文件会静默失真而不是报错。
25. `server/test/waf-fuzz.js:4` — 有用法注释，但全仓（含 `package.json`、`run.js`、无 CI 目录）无任何引用，事实上未纳入回归；规则库演进后这份基线会腐化，且它的"0 退出码"让它即便跑也进不了门禁。

## 小结

1. 这四个文件构成"服务生命周期 + 协议仿真"层，不含断言：`run.js` 管进程与数据库状态机，`client.js` 是唯一懂反爬协议（PoW / 票据 / HMAC 签名 / 表单令牌 / 蜜罐）的客户端，`reset-env.js` 是它的手动降级版，`waf-fuzz.js` 是绕开 HTTP 的规则探针。
2. 边界在 HTTP 与进程之间：`client.js` 之后的一切（路由、限流、封禁、审计）由各 `*.test.js` 断言；这层只保证"请求合法且被服务端当作真实浏览器"，合法性依赖 `gate.js` 的私有格式（`ts.jti.sig`、签名串顺序、路径去前缀规则），属强耦合的隐性契约。
3. 环境是共享的、破坏性的：所有套件共用 `xalor_blog` 与 3000 端口，靠"每套件清库 + 重启"制造隔离；清库面（`ip_bans/totp/comments/messages/links/notes`）未覆盖 `sessions`、`gate_tickets`、`security_config`，隔离是近似而非严格。
4. 失败语义是"软"的：错误几乎全部被 `catch` 吞成一行日志，`waitServer` 不校验状态码，`waf-fuzz` 无退出码语义——这套 harness 适合人工观察，不适合作为 CI 红绿判据。
5. 两套互不重叠的测试入口并存：`npm test`（15 个离线套件，无服务）与 `npm run test:all`（`run.js` 的 16 个集成套件），交集以外的 8 个文件只在离线链路，`waf-fuzz.js` 两条链路都不在。
6. 该分区最脆弱的一环是 `waf-fuzz.js`：它测的是"WAF 单函数在理想假 req 上的二值反应"，既忽略评分模型与信誉累积，又不被任何脚本调用，因此它能给出的结论只有"某条规则对某个变体是否命中"，不能支撑"绕过率"这种整体判断。
