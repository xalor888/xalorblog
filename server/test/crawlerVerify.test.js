/**
 * 爬虫 FCrDNS 核验（零真实 DNS —— 替换 `dns.promises` 的方法）。
 *
 * 这段逻辑决定「声明的搜索引擎爬虫能不能免掉 PoW 票据闸门」。判错的方向代价极不对称：
 *
 *   放行一个假爬虫（fail-open）→ 任何人把 UA 改成 `Googlebot/2.1` 就白拿全部只读接口，
 *      PoW 闸门形同虚设。源码注释里记录过这次真实事故：`dns.reverse` 对没有 PTR 的 IP
 *      立刻 ENOTFOUND，3ms 返回 `{ ok:true, degraded:true }`，于是免票通过。
 *   拒绝一个真爬虫（fail-closed）→ 搜索引擎抓不到内容，可见于站长后台，能自查。
 *
 * 所以断言的重点是**拒绝侧**：伪造域名、无 PTR、DNS 故障、未登记的 UA，全部必须拒绝。
 * 以及一条容易被忽略的：PTR 指向官方域还不够，**正向解析必须回原 IP**（FCrDNS 的本质）。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const dnsPromises = require('dns').promises;

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 必须在 require gate 之前替换（gate 里 `const dns = require('dns').promises` 拿的是同一对象，
// 所以即使它已经 require 过，改这个对象的方法也生效 —— 但为保险仍在前面做）
const realReverse = dnsPromises.reverse;
const realLookup = dnsPromises.lookup;

const { verifyCrawlerIp, hostnameInOfficialDomain, normalizeHostname, normalizeIpAddress, CRAWLER_RULES } =
  require('../src/middleware/gate');

/** 装一个可控 DNS */
function mockDns({ reverse, lookup }) {
  dnsPromises.reverse = reverse || (async () => { throw Object.assign(new Error('query ENOTFOUND'), { code: 'ENOTFOUND' }); });
  dnsPromises.lookup = lookup || (async () => { throw new Error('no lookup'); });
}
function restoreDns() {
  dnsPromises.reverse = realReverse;
  dnsPromises.lookup = realLookup;
}

/** 每个用例用不同 IP，避免 1 小时缓存串味 */
let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq % 250}`;

const GOOGLE_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

async function run() {
  console.log('=== A. 域名边界（防伪造的核心） ===');
  {
    const yes = ['googlebot.com', 'crawl.googlebot.com', 'some.deep.googlebot.com', 'GOOGLEBOT.COM', 'googlebot.com.'];
    for (const h of yes) check(`命中 ${h}`, hostnameInOfficialDomain(h, 'googlebot.com') === true);

    const no = [
      ['evil-googlebot.com', '前缀伪装'],
      ['googlebot.com.evil', '后缀伪装'],
      ['notgooglebot.com', '无点边界'],
      ['googlebot.co', '截断域'],
      ['.googlebot.com', '前导点（畸形 PTR）'],
      ['goo glebot.com', '含空白'],
      ['googlebot.com/x', '含斜杠'],
      ['', '空串'],
      [null, 'null'],
    ];
    for (const [h, why] of no) {
      check(`拒绝 ${JSON.stringify(h)}（${why}）`, hostnameInOfficialDomain(h, 'googlebot.com') === false);
    }

    check('多域爬虫任一官方域命中即可',
      hostnameInOfficialDomain('crawl.yandex.net', 'yandex.ru') === false
      && hostnameInOfficialDomain('crawl.yandex.net', 'yandex.net') === true);
  }

  console.log('\n=== B. 归一化 ===');
  {
    check('normalizeHostname 折小写并去末尾点', normalizeHostname('  Crawl.GoogleBot.COM.  ') === 'crawl.googlebot.com');
    check('normalizeIpAddress 折小写', normalizeIpAddress('2001:DB8::1') === normalizeIpAddress('2001:db8::1'));
    check('IPv4 原样', normalizeIpAddress('203.0.113.7') === '203.0.113.7');
    check('非法输入不抛错', typeof normalizeIpAddress('') === 'string');
  }

  console.log('\n=== C. 未登记的爬虫 UA 一律拒绝（fail-closed） ===');
  {
    mockDns({});
    const cases = [
      ['TotallyFakeBot/1.0', '完全没听说过的 bot'],
      ['Mozilla/5.0 (compatible; SomeSpider/1.0)', '通用 spider（无官方域可核验）'],
      ['', '空 UA'],
      ['Mozilla/5.0 Chrome/131', '普通浏览器 UA'],
    ];
    for (const [ua, why] of cases) {
      const r = await verifyCrawlerIp(freshIp(), ua);
      check(`拒绝「${why}」`, r.ok === false, JSON.stringify(r));
      check(`「${why}」的 checked 为 false（说明连核验都没开始）`, r.checked === false);
    }
  }

  console.log('\n=== D. 真实的 FCrDNS 通过路径 ===');
  {
    const ip = freshIp();
    mockDns({
      reverse: async () => ['crawl.googlebot.com'],
      lookup: async () => [{ address: ip, family: 4 }],
    });
    const r = await verifyCrawlerIp(ip, GOOGLE_UA);
    check('PTR 在官方域 + 正向解析回原 IP → 放行', r.ok === true, JSON.stringify(r));
    check('checked 为 true', r.checked === true);
  }

  console.log('\n=== E. FCrDNS 的本质：PTR 对了但正向不回原 IP，必须拒绝 ===');
  {
    const ip = freshIp();
    mockDns({
      reverse: async () => ['crawl.googlebot.com'],
      lookup: async () => [{ address: '198.51.100.99', family: 4 }], // 不是来源 IP
    });
    const r = await verifyCrawlerIp(ip, GOOGLE_UA);
    check('PTR 合理但正向解析指向别处 → 拒绝（这正是 FCrDNS 要防的）',
      r.ok === false, JSON.stringify(r));
    check('checked 仍为 true（核验确实做了）', r.checked === true);
  }

  console.log('\n=== F. PTR 不在官方域 → 拒绝并缓存 ===');
  {
    const ip = freshIp();
    mockDns({
      reverse: async () => ['attacker.example.com'],
      lookup: async () => [{ address: ip, family: 4 }],
    });
    const r1 = await verifyCrawlerIp(ip, GOOGLE_UA);
    check('PTR 是别的域 → 拒绝', r1.ok === false);
    // 第二次应命中缓存（不再查 DNS）—— 用一个会抛错的 reverse 验证真的没查
    mockDns({ reverse: async () => { throw new Error('不该被调用'); } });
    const r2 = await verifyCrawlerIp(ip, GOOGLE_UA);
    check('失败结果被缓存 1 小时（第二次不再查 DNS）', r2.ok === false && r2.cached === true,
      JSON.stringify(r2));
  }

  console.log('\n=== G. 无 PTR / DNS 故障 → fail-closed 拒绝（这是那次事故的回归测试） ===');
  {
    // 曾经的实现是 fail-open：dns.reverse 立刻 ENOTFOUND 时返回 { ok:true, degraded:true }，
    // 于是改个 UA 就白拿只读接口。这条断言钉住它不许回退。
    const ip1 = freshIp();
    mockDns({
      reverse: async () => { throw Object.assign(new Error('query ENOTFOUND'), { code: 'ENOTFOUND' }); },
    });
    const r1 = await verifyCrawlerIp(ip1, GOOGLE_UA);
    check('无 PTR（ENOTFOUND）→ 拒绝', r1.ok === false, JSON.stringify(r1));
    check('标记为 degraded（便于运维区分「确定伪造」与「无法核验」）', r1.degraded === true);

    const ip2 = freshIp();
    mockDns({
      reverse: async () => { throw Object.assign(new Error('query ETIMEOUT'), { code: 'ETIMEOUT' }); },
    });
    const r2 = await verifyCrawlerIp(ip2, GOOGLE_UA);
    check('DNS 超时 → 拒绝', r2.ok === false);

    const ip3 = freshIp();
    mockDns({
      reverse: async () => { throw new Error('resolver boom'); },
    });
    const r3 = await verifyCrawlerIp(ip3, GOOGLE_UA);
    check('解析器故障 → 拒绝', r3.ok === false);

    // 反向有结果但正向全失败
    const ip4 = freshIp();
    mockDns({
      reverse: async () => ['crawl.googlebot.com'],
      lookup: async () => { throw new Error('forward failed'); },
    });
    const r4 = await verifyCrawlerIp(ip4, GOOGLE_UA);
    check('PTR 有但正向解析失败 → 拒绝', r4.ok === false);
  }

  console.log('\n=== H. 多域名 / 多个 PTR 的处理 ===');
  {
    const ip = freshIp();
    mockDns({
      // 第一个不在官方域，第二个在 —— 只要有一个通过就该放行
      reverse: async () => ['other.example.com', 'crawl.googlebot.com'],
      lookup: async (host) => (host === 'crawl.googlebot.com'
        ? [{ address: ip, family: 4 }]
        : []),
    });
    const r = await verifyCrawlerIp(ip, GOOGLE_UA);
    check('多个 PTR 里只要有一个能通过 FCrDNS 就放行', r.ok === true, JSON.stringify(r));
  }

  console.log('\n=== I. 大小写与 UA 变体 ===');
  {
    const ip = freshIp();
    mockDns({
      reverse: async () => ['CRAWL.GoogleBot.COM'], // 大写
      lookup: async () => [{ address: ip, family: 4 }],
    });
    const r = await verifyCrawlerIp(ip, 'Mozilla/5.0 (compatible; GOOGLEBOT/2.1)');
    check('PTR 大写 + UA 大写仍能通过', r.ok === true, JSON.stringify(r));

    // bingbot 命中规则表 → 会**发起** DNS 核验。注意不能拿 `checked` 判这件事：
    // 那个字段表达的是「有没有核验成」（DNS 失败时是 false），不是「有没有尝试」。
    // 用 spy 数调用次数才是准确的判据。
    const ip2 = freshIp();
    let reverseCalls = 0;
    dnsPromises.reverse = async () => { reverseCalls++; throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
    dnsPromises.lookup = async () => { throw new Error('unused'); };
    const r2 = await verifyCrawlerIp(ip2, 'Mozilla/5.0 (compatible; bingbot/2.0)');
    check('bingbot 命中规则表 → 真的发起了 DNS 反向查询（spy 计数）',
      reverseCalls === 1, `reverse 被调用 ${reverseCalls} 次`);
    check('bingbot 查不到 PTR → 同样 fail-closed',
      r2.ok === false && r2.degraded === true, JSON.stringify(r2));

    // 对照：普通浏览器 UA 根本不该触发 DNS
    const ip3 = freshIp();
    let browserReverseCalls = 0;
    dnsPromises.reverse = async () => { browserReverseCalls++; return []; };
    await verifyCrawlerIp(ip3, 'Mozilla/5.0 Chrome/131');
    check('普通浏览器 UA 不触发 DNS（省掉每次请求的查询开销）',
      browserReverseCalls === 0, `reverse 被调用 ${browserReverseCalls} 次`);
  }

  console.log('\n=== J. 规则表本身 ===');
  {
    check('CRAWLER_RULES 已导出且非空', Array.isArray(CRAWLER_RULES) && CRAWLER_RULES.length > 0,
      String(CRAWLER_RULES.length));
    check('每条规则都有 family / keyword / domains',
      CRAWLER_RULES.every((r) => r.family && r.keyword && Array.isArray(r.domains) && r.domains.length > 0));
    check('keyword 全是小写（UA 比对前会 toLowerCase）',
      CRAWLER_RULES.every((r) => r.keyword === r.keyword.toLowerCase()));
    check('family 不重复（缓存键按 family 隔离）',
      new Set(CRAWLER_RULES.map((r) => r.family)).size === CRAWLER_RULES.length);
    check('官方域不含前导点或通配符',
      CRAWLER_RULES.every((r) => r.domains.every((d) => !d.startsWith('.') && !d.includes('*'))));
  }

  restoreDns();
  console.log(`\ncrawlerVerify 套件结果: ${passCount} 通过, ${failCount} 失败`);
  if (failCount) process.exit(1);
}

run().catch((e) => { restoreDns(); console.error('测试执行异常:', e); process.exit(1); });
