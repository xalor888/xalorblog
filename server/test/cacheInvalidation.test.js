/**
 * 缓存失效契约
 *
 * 背景：`GET /api/stats/reading` 会读全部已发布文章的 mediumtext 正文，
 * 因此按 60s TTL 缓存结果。缓存本身没问题，**问题在于失效**：
 * 后台改了文章（发布 / 改正文 / 删文章 / 批量操作 / 导入）之后，
 * 那个数字最多要 60 秒才跟上。用户刚发完文章，主页统计还是旧值 ——
 * 这类「看起来像 bug 的延迟」是最不值得留下的。
 *
 * 这个测试不需要 DB、不需要起服务：它断言的是「每个写入路径都调用了失效」。
 * 静态断言而不是运行时断言，是因为漏掉某个写入路径的代价正好是「静默延迟」——
 * 运行时很难观测到（要精确卡在 TTL 边界上）。
 *
 * 用法：node test/cacheInvalidation.test.js
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];
function assert(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` | ${extra}` : ''));
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const adminSrc = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
const statsSrc = fs.readFileSync(path.join(__dirname, '../src/routes/stats.js'), 'utf8');

console.log('=== stats.js：提供失效入口 ===');
assert('导出了 invalidateReadingCache', /module\.exports\.invalidateReadingCache\s*=/.test(statsSrc));
assert('失效函数同时清值与时间戳（只清一个会留下半新半旧状态）',
  /function invalidateReadingCache\(\)\s*\{[\s\S]{0,160}?readingCache\s*=\s*null[\s\S]{0,160}?readingCacheAt\s*=\s*0/.test(statsSrc));

console.log('\n=== admin.js：每个写入路径都要失效 ===');
assert('admin.js 引入了 invalidateReadingCache',
  /require\([\'"]\.\/stats[\'"]\)/.test(adminSrc) || /invalidateReadingCache[\s\S]{0,40}require/.test(adminSrc),
  '未引入就无法调用，缓存会一直陈旧');

// 逐个写入路由检查：在端点处理函数体内（到下一个 router. 之前）必须出现失效调用。
const WRITE_ROUTES = [
  { name: '创建文章 POST /articles', sig: "router.post('/articles', async" },
  { name: '更新文章 PUT /articles/:id', sig: "router.put('/articles/:id', async" },
  { name: '复制文章 POST /articles/:id/duplicate', sig: "router.post('/articles/:id/duplicate', async" },
  { name: '删除文章 DELETE /articles/:id', sig: "router.delete('/articles/:id', async" },
  { name: '批量删除 POST /articles/batch-delete', sig: "router.post('/articles/batch-delete', async" },
  { name: '批量操作 POST /articles/batch-update', sig: "router.post('/articles/batch-update', async" },
  { name: '导入 POST /articles/admin/import', sig: "router.post('/articles/admin/import', async" },
];

for (const route of WRITE_ROUTES) {
  const at = adminSrc.indexOf(route.sig);
  assert(`${route.name}：路由存在`, at !== -1);
  if (at === -1) continue;
  // 取该路由到下一个顶层 router. 声明之间的窗口，检查是否调用了失效
  const nextRoutes = ['router.post(', 'router.put(', 'router.delete(', 'router.get('];
  let end = adminSrc.length;
  for (const r of nextRoutes) {
    const i = adminSrc.indexOf(`\n${r}`, at + route.sig.length);
    if (i !== -1 && i < end) end = i;
  }
  const body = adminSrc.slice(at, end);
  assert(`${route.name}：调用了 invalidateReadingCache()`,
    /invalidateReadingCache\(\)/.test(body),
    '改完文章后阅读统计要立刻跟上，不能等 60s TTL');
}

console.log('\n=== 其它缓存不受影响 ===');
// summary 缓存有自己的既有失效策略，这里只确认我们没有误伤它
assert('summary 缓存仍然存在（没被误删）', /summaryCache/.test(statsSrc));

console.log(`\ncacheInvalidation 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
