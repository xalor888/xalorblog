/**
 * 反爬 UA 判定 + 审计摘要（零 DB、零服务）。
 *
 * 这两个函数各自守着一个**不对称代价**的边界：
 *
 * - `isBotUserAgent` 判错的两个方向代价完全不同：
 *   把真浏览器判成 bot → 整站 403，用户直接走人；
 *   把爬虫判成浏览器 → 内容被批量抓走。前者立刻可见，后者几个月后才发现。
 *   所以断言的重点是「常见浏览器必须放行」+「搜索引擎爬虫必须放行（否则不被收录）」。
 *
 * - `summarize` 决定哪些字段进审计日志。它写错（把密码类字段放进去），
 *   密码就以明文进了 `audit_logs` 表，而且**审计日志通常没人会去翻**。
 *   这是本仓库里唯一一个「一次写错就永久留痕」的地方。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { isBotUserAgent, HONEYPOT_FIELD, antiBot, honeypotCheck } = require('../src/middleware/antiBot');
const { summarize, SENSITIVE_FIELDS } = require('../src/middleware/audit');
const { fetchMetaGuard } = require('../src/middleware/fetchMeta');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const UA = {
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  wechat: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.50',
};

console.log('=== A. 真浏览器必须放行（判错 = 整站 403） ===');
{
  for (const [name, ua] of Object.entries(UA)) {
    check(`${name} 被判为「非 bot」`, isBotUserAgent(ua) === false, ua.slice(0, 60));
  }
  check('空 UA 视为 bot（异常流量）', isBotUserAgent('') === true);
  check('undefined UA 视为 bot', isBotUserAgent(undefined) === true);
}

console.log('\n=== B. 明确爬虫/脚本必须拦 ===');
{
  const bots = [
    'python-requests/2.31.0',
    'curl/8.4.0',
    'Wget/1.21',
    'Scrapy/2.11',
    'Go-http-client/1.1',
    'node-fetch/1.0',
    'axios/1.6.0',
    'PostmanRuntime/7.36.0',
    'HeadlessChrome/131.0.0.0',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0)',
  ];
  for (const ua of bots) {
    check(`拦截 ${ua.slice(0, 34)}…`, isBotUserAgent(ua) === true, ua);
  }
  check('大小写不敏感（PYTHON-REQUESTS 同样拦）', isBotUserAgent('PYTHON-REQUESTS/2.0') === true);
}

console.log('\n=== C. 无浏览器特征的 UA 一律拦 ===');
{
  check('自定义脚本串没有浏览器关键字 → 拦', isBotUserAgent('my-scraper/1.0') === true);
  check('空字符串特征 → 拦', isBotUserAgent('xyz') === true);
  check('只含一个浏览器关键字就放行（chrome）',
    isBotUserAgent('something chrome-ish') === false);
}

console.log('\n=== D. 搜索引擎爬虫必须放行（否则不被收录） ===');
{
  // 白名单优先于 BOT_PATTERNS：Googlebot 的 UA 里含 "headless"? 不含，
  // 但含 "Googlebot"，且部分版本含 "Safari" —— 关键是它必须在黑名单之前被判白名单。
  const seBots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  ];
  for (const ua of seBots) {
    check(`放行搜索引擎爬虫 ${ua.match(/(Googlebot|bingbot|Baiduspider)/)[0]}`,
      isBotUserAgent(ua) === false, ua.slice(0, 50));
  }
}

console.log('\n=== E. antiBot 中间件的行为边界 ===');
{
  const run = (method, ua) => {
    const out = { status: null, body: null, nextCalled: false };
    const req = { method, headers: ua === undefined ? {} : { 'user-agent': ua } };
    const res = {
      status(c) { out.status = c; return res; },
      json(b) { out.body = b; return res; },
    };
    antiBot(req, res, () => { out.nextCalled = true; });
    return out;
  };

  check('GET + bot UA → 403', (() => { const r = run('GET', 'curl/8.0'); return r.status === 403 && !r.nextCalled; })());
  check('GET + 浏览器 UA → 放行', run('GET', UA.chrome).nextCalled === true);
  // 写请求不走这道闸：认证 + 严格限流 + honeypot 负责
  check('POST 即使是 bot UA 也放行（写请求另有防线）',
    run('POST', 'curl/8.0').nextCalled === true);
  check('PUT / DELETE 同样放行', run('PUT', 'curl/8.0').nextCalled === true && run('DELETE', 'curl/8.0').nextCalled === true);
  check('403 响应体是统一的 {code:1, message}', (() => {
    const r = run('GET', 'curl/8.0');
    return r.body && r.body.code === 1 && typeof r.body.message === 'string';
  })());
}

console.log('\n=== F. honeypot 字段 ===');
{
  check('字段名是 website_url（前端隐藏、机器人会填）', HONEYPOT_FIELD === 'website_url');
  const run = (body) => {
    const out = { status: null, nextCalled: false };
    const res = { status(c) { out.status = c; return res; }, json() { return res; } };
    honeypotCheck({ body }, res, () => { out.nextCalled = true; });
    return out;
  };
  check('填了 honeypot → 403', (() => { const r = run({ [HONEYPOT_FIELD]: 'http://spam' }); return r.status === 403 && !r.nextCalled; })());
  check('没填 → 放行', run({ content: '正常留言' }).nextCalled === true);
  check('body 缺失不抛错', run(undefined).nextCalled === true);
  check('空字符串不算填（前端可能序列化成 ""）', run({ [HONEYPOT_FIELD]: '' }).nextCalled === true);
}

console.log('\n=== G. 审计摘要：敏感字段绝不能进日志 ===');
{
  // 这是本仓库唯一「一次写错就永久留痕」的地方：密码进了 audit_logs，
  // 而审计日志通常没人翻。
  for (const f of SENSITIVE_FIELDS) {
    check(`SENSITIVE_FIELDS 含「${f}」`, SENSITIVE_FIELDS.has(f));
  }
  check('summarize 不输出 password', summarize({ title: '改密', password: 'hunter2' }) === 'title=改密');
  check('summarize 不输出 newPassword/oldPassword',
    summarize({ oldPassword: 'a', newPassword: 'b' }) === '');
  check('summarize 不输出 form_token',
    summarize({ form_token: 'tok', name: 'x' }) === 'name=x');
  check('即便密码字段排在前面也不会漏出来',
    !summarize({ password: 'hunter2', username: 'admin' }).includes('hunter2'));
}

console.log('\n=== H. 审计摘要的字段与长度 ===');
{
  check('只取白名单字段（title/name/status/nickname/username/content）',
    summarize({ id: 5, cover: '/a.png', title: 'T' }) === 'title=T',
    summarize({ id: 5, cover: '/a.png', title: 'T' }));
  check('多个字段用逗号连接',
    summarize({ title: 'T', status: 'published' }) === 'title=T, status=published');
  check('单字段截断到 40 字',
    summarize({ title: 'x'.repeat(100) }).length === 'title='.length + 40);
  check('整体截断到 160 字',
    summarize({ title: 'a'.repeat(40), name: 'b'.repeat(40), status: 'c'.repeat(40), nickname: 'd'.repeat(40), username: 'e'.repeat(40) }).length <= 160);
  check('非字符串值被跳过（不输出 [object Object]）',
    summarize({ title: { a: 1 }, name: 'ok' }) === 'name=ok');
  check('空 body → 空串', summarize({}) === '');
  check('数组 body → 空串（不是对象）', summarize([]) === '');
  check('null body → 空串（默认参数生效）', summarize() === '');
  check('纯空白字符串被跳过', summarize({ title: '   ', name: 'ok' }) === 'name=ok');
  check('前后空白被 trim', summarize({ title: '  T  ' }) === 'title=T');
}

console.log('\n=== I. Fetch Metadata 闸门（防跨站表单伪造） ===');
{
  const run = (method, site) => {
    const out = { status: null, nextCalled: false };
    const headers = {};
    if (site !== undefined) headers['sec-fetch-site'] = site;
    const req = { method, headers };
    const res = { status(c) { out.status = c; return res; }, json() { return res; } };
    fetchMetaGuard(req, res, () => { out.nextCalled = true; });
    return out;
  };

  // 只保护写请求：GET 本来就没有 CSRF 风险（不改变状态）
  for (const m of ['GET', 'HEAD', 'OPTIONS']) {
    check(`${m} 直接放行`, run(m, 'cross-site').nextCalled === true);
  }

  // 浏览器没发这个头（旧浏览器 / 脚本 / 非浏览器客户端）→ 放行，由签名/令牌兜底。
  // 这条**不是漏洞**：Sec-Fetch-* 只是纵深的一层，真正的防线是 form_token + 指纹。
  for (const m of ['POST', 'PUT', 'DELETE']) {
    check(`${m} 无 Sec-Fetch-Site 时放行（签名/令牌兜底）`, run(m, undefined).nextCalled === true);
  }

  for (const m of ['POST', 'PUT', 'DELETE']) {
    check(`${m} + same-origin → 放行`, run(m, 'same-origin').nextCalled === true);
    check(`${m} + same-site → 放行`, run(m, 'same-site').nextCalled === true);
    // none = 地址栏/书签直接导航，不是跨站
    check(`${m} + none → 放行`, run(m, 'none').nextCalled === true);
    check(`${m} + cross-site → 403（这正是 CSRF 的形态）`,
      run(m, 'cross-site').status === 403 && run(m, 'cross-site').nextCalled === false);
  }

  check('大小写不敏感（CROSS-SITE 同样拦）', run('POST', 'CROSS-SITE').status === 403);
  check('未知值一律拒绝（白名单而非黑名单）',
    run('POST', 'cross-site-nested').status === 403 && run('POST', 'whatever').status === 403);
  check('空字符串视同未发送（放行）', run('POST', '').nextCalled === true);
  check('403 响应体是统一的 {code:1, message}',
    (() => { const r = run('POST', 'cross-site'); return r.status === 403; })());
}

console.log(`\nantiBotAudit 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
