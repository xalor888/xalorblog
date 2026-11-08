const { stripCommentLines } = require('./helpers/sourceText');
/**
 * 后台仪表盘缓存（零 DB、零服务）。
 *
 * `/stats/dashboard` 一次并发 18 条聚合查询（4 个 count、3 个分组、2 个 sum），
 * 是全站最贵的读接口；使用场景却是「管理员打开看一眼」，15 秒内的重复请求
 * （刷新 / 切标签页 / 前端多个视图各拉一次）拿不到任何新信息。
 *
 * 这组断言锁四件事：
 *   A. 写入后能命中；
 *   B. 过期即失效（用注入时钟，不真等 15 秒）；
 *   C. 手动失效清空全部（给「改完立刻要看」的调用点用）；
 *   D. 上限淘汰是「最旧先出」，且不同 role/days 的组合互不串。
 *
 * 缓存是纯内存基础设施，最容易出的错是「键设计漏维度 → 串数据」和
 * 「过期判断写反 → 永远命中」。两者都不会报错，只会显示旧数字。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const {
  readDashboardCache, writeDashboardCache, invalidateDashboardCache, DASHBOARD_TTL,
} = require('../src/routes/admin');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

invalidateDashboardCache();
const realNow = Date.now;
/** 把时钟钉在 t0，之后的 ±ms 都相对 t0 —— 不真等 15 秒 */
function at(t0, offsetMs, fn) {
  Date.now = () => t0 + offsetMs;
  try { return fn(); } finally { Date.now = realNow; }
}

console.log('=== A. 写入后命中 ===');
{
  const t0 = 1_700_000_000_000;
  at(t0, 0, () => writeDashboardCache('admin|14', { total_articles: 6 }));
  ok('TTL 是 15 秒', DASHBOARD_TTL === 15 * 1000, String(DASHBOARD_TTL));
  ok('刚写入即可读到', at(t0, 1000, () => readDashboardCache('admin|14'))?.total_articles === 6);
  ok('未写过的 key 返回 null',
    at(t0, 1000, () => readDashboardCache('admin|30')) === null);
}

console.log('\n=== B. 过期即失效（边界两侧都验） ===');
{
  const t0 = 1_700_000_100_000;
  at(t0, 0, () => writeDashboardCache('admin|7', { marker: 'old' }));
  ok('TTL-1ms 仍命中（不能提前过期）',
    at(t0, DASHBOARD_TTL - 1, () => readDashboardCache('admin|7'))?.marker === 'old');
  ok('恰好 TTL 时过期（>= 而不是 >）',
    at(t0, DASHBOARD_TTL, () => readDashboardCache('admin|7')) === null);
  ok('过期后再读仍为 null（不是偶发）',
    at(t0, DASHBOARD_TTL + 1, () => readDashboardCache('admin|7')) === null);
}

console.log('\n=== C. 手动失效 ===');
{
  const t0 = 1_700_000_200_000;
  at(t0, 0, () => {
    writeDashboardCache('admin|14', { a: 1 });
    writeDashboardCache('editor|14', { b: 2 });
  });
  at(t0, 0, () => invalidateDashboardCache());
  ok('失效后 admin 读不到', at(t0, 0, () => readDashboardCache('admin|14')) === null);
  ok('失效后 editor 也读不到（全清，不是只清当前角色）',
    at(t0, 0, () => readDashboardCache('editor|14')) === null);
}

console.log('\n=== D. 键维度隔离 + 上限淘汰 ===');
{
  const t0 = 1_700_000_300_000;
  at(t0, 0, () => invalidateDashboardCache());
  at(t0, 0, () => {
    writeDashboardCache('admin|7', { days: 7, role: 'admin' });
    writeDashboardCache('admin|14', { days: 14, role: 'admin' });
    writeDashboardCache('editor|7', { days: 7, role: 'editor' });
  });
  ok('同 role 不同 days 不串',
    at(t0, 0, () => readDashboardCache('admin|7'))?.days === 7
    && at(t0, 0, () => readDashboardCache('admin|14'))?.days === 14);
  ok('同 days 不同 role 不串',
    at(t0, 0, () => readDashboardCache('editor|7'))?.role === 'editor');

  // 上限：写满 128 条后再写一条，最旧的应被淘汰
  at(t0, 0, () => invalidateDashboardCache());
  at(t0, 0, () => {
    for (let i = 0; i < 128; i++) writeDashboardCache(`role${i}|14`, { i });
    writeDashboardCache('newest|14', { i: 999 });
  });
  ok('超过上限时最旧的一条被淘汰',
    at(t0, 0, () => readDashboardCache('role0|14')) === null);
  ok('新写入的仍在（淘汰选的是最旧，不是最新的）',
    at(t0, 0, () => readDashboardCache('newest|14'))?.i === 999);
  ok('未超上限的中间项仍在',
    at(t0, 0, () => readDashboardCache('role64|14'))?.i === 64);
}

console.log('\n=== E. 源码契约：命中时不能先跑 18 条查询 ===');
{
  const fs = require('fs');
  const path = require('path');
  const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8'));
  const win = (src.match(/router\.get\('\/stats\/dashboard'[\s\S]{0,1200}/) || [''])[0];
  ok('先读缓存再进入 Promise.all（顺序不能反）',
    win.indexOf('const cached = readDashboardCache(cacheKey)') > -1
    && win.indexOf('const cached = readDashboardCache(cacheKey)') < win.indexOf('Promise.all('));
  ok('命中即 return ok(res, cached)（不进入查询）',
    /if \(cached\) return ok\(res, cached\);/.test(win));
  ok('查询结束后写缓存（否则永远不命中）',
    /writeDashboardCache\(cacheKey, payload\);/.test(src));
  ok('缓存 key 含 role 与 days',
    /\$\{\(req\.user && req\.user\.role\) \|\| 'anon'\}\|\$\{days\}/.test(src));
}

invalidateDashboardCache();

/* ============================================================
 * 附加：/api/home/summary 的缓存（同样的 TTL 模式，另一处热路径）
 * ============================================================ */
console.log('\n=== F. home summary 缓存 ===');
{
  const { invalidateSummaryCache, SUMMARY_TTL } = require('../src/routes/home');
  const fs = require('fs');
  const path = require('path');
  const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'home.js'), 'utf8'));
  const win = (src.match(/router\.get\('\/summary'[\s\S]{0,1400}/) || [''])[0];

  ok('TTL 是 60 秒（与 stats/archive 同一取舍）', SUMMARY_TTL === 60 * 1000, String(SUMMARY_TTL));
  ok('先查缓存再进 SQL（顺序不能反，否则缓存无意义）',
    win.indexOf('if (summaryCache && Date.now() - summaryCacheAt < SUMMARY_TTL)')
      < win.indexOf('Promise.all('));
  ok('命中即返回，不进入查询', /return ok\(res, summaryCache\);/.test(win));
  ok('查询后写缓存', /summaryCache = payload;/.test(src) && /summaryCacheAt = Date\.now\(\);/.test(src));

  // 限流必须在缓存之后（中间件顺序）：缓存是给正常访客省成本，不能靠它绕过限流
  ok('限流中间件仍在路由签名里（缓存不替代限流）',
    /router\.get\('\/summary', summaryLimiter, antiBot,/.test(src));

  ok('invalidateSummaryCache 可调用且不抛错', (invalidateSummaryCache(), true));
}

console.log(`\ndashboardCache 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
