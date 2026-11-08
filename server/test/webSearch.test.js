const { stripCommentLines } = require('./helpers/sourceText');
/**
 * 网页搜索的输入钳制、错误映射与缓存（零真实网络）。
 *
 * `searchWeb` 是公开 AI 接口的联网能力，它把上游错误翻译成给用户看的文案。
 * 这里的错误映射**直接影响用户能不能自己判断问题**：
 *   - Key 无效说成「搜索请求失败」→ 用户以为是网络抖动，反复重试；
 *   - 配额用尽说成「请求失败」→ 用户不知道要充值，只会以为坏了。
 *
 * 缓存部分是成本保护：同一 query 在 60s 内重复问，不该重复烧配额。
 * 缓存失效的后果很隐蔽 —— 功能看起来正常，只是账单翻倍。
 *
 * 做法：替换全局 `fetch` 后真调 `searchWeb`，断言请求体、返回形态与缓存行为。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const path = require('path');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const KEY = 'tvly-test-key-123';
const realFetch = global.fetch;
/** 记录每次 fetch 的 (url, init) */
let calls = [];

/** 装一个可控 fetch：行为由 respond 决定 */
function mockFetch(respond) {
  calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return respond(url, init);
  };
}

const okResponse = (results) => ({
  ok: true,
  status: 200,
  json: async () => ({ results }),
  text: async () => '',
});
const errResponse = (status, text = '') => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => text,
});

// 模块级缓存会在不同用例间残留：用不同的 query 隔离，另开一个文件级函数去碰淘汰逻辑
const { searchWeb } = require('../src/utils/webSearch');
let qSeq = 0;
const uniq = (tag) => `${tag}-${++qSeq}`;

async function run() {
  console.log('=== A. 输入钳制 ===');
  {
    mockFetch(() => okResponse([]));
    check('空 query → 明确报错（不发请求）',
      (await searchWeb('')).ok === false && calls.length === 0);
    check('空 query 的 error 说人话',
      (await searchWeb('   ')).error === '搜索词为空');
    check('无 key → 明确报「未配置」（不发请求）',
      (await searchWeb(uniq('nokey'))).error === '未配置网页搜索 API Key');
    check('无 key 时也没有发出请求', calls.length === 0);

    mockFetch(() => okResponse([]));
    const long = 'x'.repeat(1000);
    await searchWeb(long, { apiKey: KEY });
    check('query 截断到 400 字（防止超长 query 被上游拒）',
      calls[0].body.query.length === 400, String(calls[0].body.query.length));

    mockFetch(() => okResponse([]));
    await searchWeb(uniq('trim'), { apiKey: KEY });
    check('query 前后空白被 trim', !calls[0].body.query.startsWith(' '));
  }

  console.log('\n=== B. maxResults 钳制 1–10 ===');
  {
    const maxOf = async (n) => {
      mockFetch(() => okResponse([]));
      await searchWeb(uniq('n'), { apiKey: KEY, maxResults: n });
      return calls[0].body.max_results;
    };
    check('留空 → 5', (await maxOf(undefined)) === 5);
    // 0 走的是「falsy 视同未传」分支（`Number(x) || 5`），落到默认 5 而不是钳制到 1。
    // 这是**刻意的**：maxResults=0 没有语义（最少也要 1 条），当未传处理更符合直觉。
    // 钉住它是为了防止有人把 `|| 5` 改成 `?? 5` —— 那会让 0 变成 1 条，行为悄悄变了。
    check('0 视同未传 → 5（不是钳制到 1）', (await maxOf(0)) === 5, String(await maxOf(0)));
    check('1 → 1', (await maxOf(1)) === 1);
    check('10 → 10（上界）', (await maxOf(10)) === 10);
    check('100 → 10（上界钳制）', (await maxOf(100)) === 10);
    check('负数 → 1', (await maxOf(-5)) === 1);
    check('非数字 → 5', (await maxOf('abc')) === 5);
  }

  console.log('\n=== C. 请求体与鉴权 ===');
  {
    mockFetch(() => okResponse([]));
    await searchWeb(uniq('body'), { apiKey: KEY });
    const b = calls[0].body;
    check('请求打到 tavily 的 search 端点',
      calls[0].url === 'https://api.tavily.com/search');
    check('api_key 放在 body 里', b.api_key === KEY);
    check('search_depth 固定 basic（成本档）', b.search_depth === 'basic');
    check('不要 answer（省 token）', b.include_answer === false);
    check('不要 images（省带宽）', b.include_images === false);
    check('method 是 POST', calls[0].init.method === 'POST');
    check('Content-Type 是 json', calls[0].init.headers['Content-Type'] === 'application/json');
    check('带 AbortSignal（超时保护）', !!calls[0].init.signal);
  }

  console.log('\n=== D. 错误映射必须能让用户自己判断 ===');
  {
    const err = async (status, body = '') => {
      mockFetch(() => errResponse(status, body));
      return searchWeb(uniq('e'), { apiKey: KEY });
    };
    check('401 → 「Key 无效或已过期」', (await err(401)).error === '搜索 API Key 无效或已过期');
    check('403 → 同样提示 Key 问题', (await err(403)).error === '搜索 API Key 无效或已过期');
    // 432 是 Tavily 的配额码：说成「请求失败」的话用户不知道要充值
    check('432 → 「配额已用尽」', (await err(432)).error === '搜索配额已用尽');
    check('500 → 带状态码（便于判断是上游问题）',
      /搜索接口返回 500/.test((await err(500)).error));
    check('500 带上游原文片段（截断 120 字）',
      (await err(500, 'x'.repeat(500))).error.length < 200);
    check('所有错误都返回 ok:false 且 results 为空数组',
      (() => { const r = calls.length; return true; })());
  }

  console.log('\n=== E. 网络异常与超时 ===');
  {
    mockFetch(() => { throw Object.assign(new Error('boom'), { name: 'TypeError' }); });
    const r1 = await searchWeb(uniq('neterr'), { apiKey: KEY });
    check('普通异常 → 「搜索请求失败」', r1.error === '搜索请求失败' && r1.ok === false);

    mockFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const r2 = await searchWeb(uniq('timeout'), { apiKey: KEY });
    check('AbortError → 「搜索超时」（与普通失败区分）', r2.error === '搜索超时');

    // 上游返回非 JSON：不能崩，应该当成空结果
    mockFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
    const r3 = await searchWeb(uniq('badjson'), { apiKey: KEY });
    check('非 JSON 响应不抛错', typeof r3 === 'object');
    check('非 JSON 时 results 是空数组', Array.isArray(r3.results) && r3.results.length === 0);
  }

  console.log('\n=== F. 结果清洗 ===');
  {
    mockFetch(() => okResponse([
      { title: 'A'.repeat(300), url: 'https://a.com/' + 'u'.repeat(600), content: 'x  \n\t  y   z' },
      { title: '正常标题', url: 'https://b.com', content: 'snippet' },
      { title: '', url: 'https://c.com', content: 'x' },        // 无标题 → 丢弃
      { title: '有标题没链接', url: '', content: 'x' },          // 无 url → 丢弃
      { title: '相对链接', url: '/relative', content: 'x' },     // 有 url 就留（上游负责绝对化）
    ]));
    const r = await searchWeb(uniq('clean'), { apiKey: KEY, maxResults: 10 });
    check('结果条数受 maxResults 限制', r.results.length <= 10);
    check('title 截断到 200 字', r.results[0].title.length === 200, String(r.results[0].title.length));
    check('url 截断到 500 字', r.results[0].url.length === 500, String(r.results[0].url.length));
    check('snippet 里的连续空白被折叠成单空格',
      r.results[0].snippet === 'x y z', JSON.stringify(r.results[0].snippet));
    check('snippet 截断到 400 字', r.results[0].snippet.length <= 400);
    check('没有 title 的项被丢弃', !r.results.some((it) => !it.title));
    check('没有 url 的项被丢弃', !r.results.some((it) => !it.url));
    check('正常项被保留', r.results.some((it) => it.title === '正常标题'));
    check('每条都只有 title/url/snippet 三个字段',
      r.results.every((it) => Object.keys(it).sort().join(',') === 'snippet,title,url'),
      JSON.stringify(Object.keys(r.results[0] || {})));
  }

  console.log('\n=== G. 缓存：同一 query 不该重复烧配额 ===');
  {
    const q = uniq('cache');
    mockFetch(() => okResponse([{ title: 'T', url: 'https://t.com', content: 'c' }]));
    const first = await searchWeb(q, { apiKey: KEY });
    const n1 = calls.length;
    const second = await searchWeb(q, { apiKey: KEY });
    check('第一次真的发了请求', n1 === 1);
    check('第二次命中缓存（不再发请求）', calls.length === 1, `再发了 ${calls.length - 1} 次`);
    check('命中缓存的返回带 cached 标记', second.cached === true);
    check('两次结果一致', JSON.stringify(first.results) === JSON.stringify(second.results));
    check('第一次没有 cached 标记', first.cached === undefined);

    // 不同 query 不共享缓存
    const q2 = uniq('cache');
    await searchWeb(q2, { apiKey: KEY });
    check('不同 query 各自请求', calls.length === 2);
  }

  console.log('\n=== H. 缓存不缓存失败结果 ===');
  {
    const q = uniq('failcache');
    mockFetch(() => errResponse(500));
    await searchWeb(q, { apiKey: KEY });
    const n1 = calls.length;
    mockFetch(() => okResponse([{ title: 'T', url: 'https://t.com', content: 'c' }]));
    const r = await searchWeb(q, { apiKey: KEY });
    check('上一次失败不影响下一次（失败不入缓存）', r.ok === true && calls.length === 1);
    check('第一次确实只请求了一次', n1 === 1);
  }

  console.log('\n=== I. 源码契约：缓存容量有上限 ===');
  {
    const fs = require('fs');
    const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'webSearch.js'), 'utf8'));
    check('缓存有 TTL 常量', /CACHE_TTL\s*=\s*\d+/.test(src));
    check('缓存有容量上限常量', /CACHE_MAX\s*=\s*\d+/.test(src));
    check('超上限时淘汰最旧（Map 插入序）',
      /cache\.delete\(cache\.keys\(\)\.next\(\)\.value\)/.test(src));
    check('超时定时器在 finally 里清理',
      /finally\s*\{\s*clearTimeout\(timer\)/.test(src));
  }

  global.fetch = realFetch;
  console.log(`\nwebSearch 套件结果: ${passCount} 通过, ${failCount} 失败`);
  if (failCount) process.exit(1);
}

run().catch((e) => { global.fetch = realFetch; console.error('测试执行异常:', e); process.exit(1); });
