/**
 * 域名识别 + 本地时间格式化（零 DB、零服务）。
 *
 * 这两个模块看着琐碎，但都是**一处错、全站错**的类型：
 *
 * - `siteHost.requestHost` 决定「主页域还是博客域」。它错了，sitemap / RSS / robots
 *   就会互相串台 —— 博客的 sitemap 里出现手记、主页的 robots 指向博客的 Sitemap 行。
 *   而且这种错**不会报错**，只会在搜索引擎那边慢慢体现（收录到错误域名下）。
 * - `datetime` 决定所有落库时间与展示时间。时区错一小时，归档分组、今日访问、
 *   锁定剩余秒数全部跟着错，而本地开发（UTC+8 机器）与服务器（可能 UTC）表现不同，
 *   属于「本地测不出来」的典型。
 *
 * 两者此前都是零测试引用（`grep -rl siteHost test/` 为空）。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { requestHost, isHomeHost, resolveBaseUrl } = require('../src/utils/siteHost');
const { localDateStr, localDateTimeStr, zonedParts, SITE_TZ } = require('../src/utils/datetime');
const config = require('../src/config');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const req = (host) => ({ headers: host === undefined ? {} : { host }, protocol: 'https', get: () => host });

console.log('=== A. requestHost 归一化 ===');
{
  ok('普通域名原样', requestHost(req('blog.example.com')) === 'blog.example.com');
  ok('大写折小写', requestHost(req('BLOG.Example.COM')) === 'blog.example.com');
  ok('去掉端口', requestHost(req('blog.example.com:8080')) === 'blog.example.com');
  ok('去掉末尾点（FQDN 形式）', requestHost(req('example.com.')) === 'example.com', requestHost(req('example.com.')));
  ok('多个末尾点也去掉', requestHost(req('example.com..')) === 'example.com');
  ok('空 Host 返回空串', requestHost(req('')) === '');
  ok('缺失 headers 不抛错', requestHost({}) === '' && requestHost(null) === '');

  // IPv6：方括号是 Host 头的语法要求，比对前必须剥掉，否则永远匹配不上
  ok('IPv6 去方括号与端口', requestHost(req('[::1]:3000')) === '::1', requestHost(req('[::1]:3000')));
  ok('IPv6 无端口', requestHost(req('[2001:db8::1]')) === '2001:db8::1');
  ok('未闭合方括号不抛错', typeof requestHost(req('[::1')) === 'string');

  // 这条容易写成 split(':')[0] 的后果：IPv6 会被切成 "[" 或 ""
  ok('IPv6 不会因为按冒号切分而损坏',
    requestHost(req('[::1]:3000')) === '::1' && requestHost(req('[::1]:3000')) !== '[');
}

console.log('\n=== B. isHomeHost：未配置时必须恒为 false ===');
{
  const saved = config.homeSiteHost;
  try {
    // 未配置 = 只有一个站（一律按博客版返回）。这条错了，单站部署会突然开始
    // 返回主页版 sitemap，而主页版里只有手记 —— 博客文章从 sitemap 里消失。
    config.homeSiteHost = '';
    ok('未配置 HOME_SITE_HOST 时，任何 Host 都判为非主页域',
      isHomeHost(req('xalor.cn')) === false && isHomeHost(req('')) === false);

    config.homeSiteHost = 'xalor.cn';
    ok('精确匹配才命中', isHomeHost(req('xalor.cn')) === true);
    ok('带端口仍命中', isHomeHost(req('xalor.cn:443')) === true);
    ok('大小写不敏感', isHomeHost(req('XALOR.CN')) === true);
    ok('末尾点仍命中', isHomeHost(req('xalor.cn.')) === true);
    ok('子域不命中（blog.xalor.cn ≠ xalor.cn）',
      isHomeHost(req('blog.xalor.cn')) === false);
    ok('前缀相似不命中（notxalor.cn 不该算）',
      isHomeHost(req('notxalor.cn')) === false);
    ok('后缀相似不命中（xalor.cn.evil.com 不该算）',
      isHomeHost(req('xalor.cn.evil.com')) === false);
  } finally {
    config.homeSiteHost = saved;
  }
}

console.log('\n=== C. resolveBaseUrl ===');
{
  ok('显式配置优先', resolveBaseUrl(req('internal:3000'), 'https://blog.example.com') === 'https://blog.example.com');
  ok('显式配置去掉尾斜杠',
    resolveBaseUrl(req('h'), 'https://blog.example.com///') === 'https://blog.example.com');
  ok('显式配置去空白',
    resolveBaseUrl(req('h'), '  https://blog.example.com  ') === 'https://blog.example.com');
  ok('空配置回落到协议 + Host',
    resolveBaseUrl(req('blog.example.com'), '') === 'https://blog.example.com');
  ok('null 配置同样回落', resolveBaseUrl(req('a.com'), null) === 'https://a.com');
}

console.log('\n=== D. datetime 格式与站点时区 ===');
{
  ok('SITE_TZ 已定义', typeof SITE_TZ === 'string' && SITE_TZ.length > 0, SITE_TZ);

  const d = new Date('2026-03-15T04:05:06Z');
  ok('localDateStr 是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(localDateStr(d)), localDateStr(d));
  ok('localDateTimeStr 是 YYYY-MM-DD HH:mm:ss',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(localDateTimeStr(d)), localDateTimeStr(d));
  ok('两者日期部分一致',
    localDateTimeStr(d).slice(0, 10) === localDateStr(d));

  // 时区必须真的生效：UTC 与站点时区不同时，日期串必须等于站点时区的那一天
  const parts = zonedParts(d);
  ok('zonedParts 返回 6 个字符串字段（Intl 给的是字符串，不是数字）',
    ['year', 'month', 'day', 'hour', 'minute', 'second'].every((k) => typeof parts[k] === 'string'),
    JSON.stringify(parts));
  ok('localDateStr 与 zonedParts 的年月日一致',
    localDateStr(d) === `${parts.year}-${parts.month}-${parts.day}`,
    `${localDateStr(d)} vs ${JSON.stringify(parts)}`);
  ok('localDateTimeStr 与 zonedParts 完全一致',
    localDateTimeStr(d) === `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`);

  ok('不传参数时使用当前时间（不抛错）',
    /^\d{4}-\d{2}-\d{2}$/.test(localDateStr()) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(localDateTimeStr()));
}

console.log('\n=== E. datetime 的日期边界（跨日/跨月/跨年） ===');
{
  // 用站点时区的偏移量反推：在站点时区里造一个「当天 00:00:00」
  const cases = [
    { label: '跨年', y: 2025, m: 12, d: 31 },
    { label: '闰年 2 月 29', y: 2024, m: 2, d: 29 },
    { label: '平年 3 月 1（紧邻 2 月 28）', y: 2025, m: 3, d: 1 },
    { label: '12 月 31 → 1 月 1', y: 2026, m: 12, d: 31 },
  ];
  for (const c of cases) {
    const iso = `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}T12:00:00Z`;
    const got = localDateStr(new Date(iso));
    ok(`${c.label}：日期串仍是合法格式`,
      /^\d{4}-\d{2}-\d{2}$/.test(got), `${iso} → ${got}`);
  }

  // 午夜边界：同一瞬间在不同时区可能分属两天，这里只断言"结果与 zonedParts 自洽"
  const midnight = new Date('2026-03-15T16:00:00Z');
  const p = zonedParts(midnight);
  const num = (v) => Number(v);
  ok('午夜附近的日期与时分自洽（不会出现 24 点或 0 月）',
    num(p.month) >= 1 && num(p.month) <= 12
    && num(p.day) >= 1 && num(p.day) <= 31
    && num(p.hour) >= 0 && num(p.hour) <= 23,
    JSON.stringify(p));
  // UTC 16:00 = 上海次日 00:00 —— 这条锁住「按站点时区而不是服务器时区」
  ok('UTC 16:00 在上海是次日零点（时区真的生效，不是服务器本地时区）',
    localDateStr(midnight) === '2026-03-16', localDateStr(midnight));
}

console.log('\n=== F. 非法输入必须抛错，而不是静默产出 1970 ===');
{
  const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

  // 这是本轮修的隐患：`Intl.formatToParts(null)` 会把 null 当成时间戳 0，
  // 于是 localDateStr(row.published_at) 在字段为 NULL 时**静默返回 1970-01-01**，
  // 没有异常、没有日志 —— 而 published_at 在「导入备份」路径上确实允许为 NULL。
  ok('localDateStr(null) 抛错（否则会静默得到 1970-01-01）', throws(() => localDateStr(null)));
  ok('localDateStr(0) 抛错（数字时间戳同样被拒）', throws(() => localDateStr(0)));
  ok('localDateStr(非法 Date) 抛错', throws(() => localDateStr(new Date('nope'))));
  ok('localDateTimeStr(字符串) 抛错（避免隐式转数字）', throws(() => localDateTimeStr('2026-01-01')));
  ok('zonedParts(非法 Date) 抛错', throws(() => zonedParts(new Date('nope'))));

  // undefined 是**例外**：走默认参数 = 当前时间，这是有意的语义
  ok('localDateStr(undefined) 返回今天（不传就是现在）',
    /^\d{4}-\d{2}-\d{2}$/.test(localDateStr(undefined)));

  // 错误信息要说人话：调用方一眼能看出该判空
  let msg = '';
  try { localDateStr(null); } catch (e) { msg = e.message; }
  ok('错误信息提示了「传数据库字段前先判空」', /判空|null/.test(msg), msg.slice(0, 60));
  ok('抛的是 TypeError 而不是 RangeError（语义是"类型不对"）',
    (() => { try { localDateStr(null); return false; } catch (e) { return e instanceof TypeError; } })());
}

console.log(`\nhostAndTime 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
