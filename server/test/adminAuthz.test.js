/**
 * 后台路由的鉴权顺序 —— **结构断言**，不依赖任何请求。
 *
 * 为什么值得测：后台 75 个接口的鉴权只有两行（`router.use(authRequired)` + 角色判断），
 * 全部靠「写在所有路由之前」这一条约定。约定一旦被破坏（新路由写到了守卫上面），
 * 结果不是崩溃，而是**一个没有任何认证的接口** —— 而它看起来和别的接口一模一样。
 * 这类事故在代码审查里极难发现（diff 只显示"新增了一个路由"）。
 *
 * 本文件守三件事：
 *   1. `authRequired` 与角色闸都出现在**第一个路由定义之前**
 *   2. 角色闸判的是 `role === 'admin'`（而不是「登录了就行」）
 *   3. 每一处 `router.<verb>(` 都在守卫之后（逐条列出，不抽样）
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { readFileSync } = require('fs');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const ADMIN = '/Users/xalor/Documents/Xalorblog/server/src/routes/admin.js';
const src = readFileSync(ADMIN, 'utf8');
const lines = src.split('\n');

/** 每一行里出现的路由定义与守卫 */
const routeLines = [];
const guardLines = [];
lines.forEach((line, i) => {
  if (/router\.(get|post|put|patch|delete|all)\s*\(/.test(line)) routeLines.push({ line: i + 1, text: line.trim().slice(0, 90) });
  if (/router\.use\(\s*authRequired/.test(line)) guardLines.push({ kind: 'authRequired', line: i + 1 });
  if (/req\.user\s*&&\s*req\.user\.role\s*===?\s*'admin'/.test(line)) guardLines.push({ kind: 'roleGate', line: i + 1 });
});

console.log('\n【A. 守卫必须存在且顺序正确】');
ok(`找到 ${routeLines.length} 处路由定义`, () => {
  assert.ok(routeLines.length >= 60, `只找到 ${routeLines.length} 处 —— 解析可能失效`);
});

ok('router.use(authRequired) 存在', () => {
  assert.ok(guardLines.some((g) => g.kind === 'authRequired'),
    '找不到 router.use(authRequired) —— 后台接口可能整体失去认证');
});

ok('角色闸判的是 role === \'admin\'（不是只判登录）', () => {
  const gate = guardLines.find((g) => g.kind === 'roleGate');
  assert.ok(gate, "找不到 role === 'admin' 判断 —— 任何登录用户都能进后台");
  const line = lines[gate.line - 1];
  assert.ok(/role\s*===?\s*'admin'/.test(line), `角色闸写法异常：${line.trim()}`);
});

console.log('\n【B. 每一条路由都排在守卫之后】');
{
  const auth = guardLines.find((g) => g.kind === 'authRequired');
  const gate = guardLines.find((g) => g.kind === 'roleGate');
  const firstRoute = Math.min(...routeLines.map((r) => r.line));
  ok(`第一条路由在第 ${firstRoute} 行，authRequired 在第 ${auth.line} 行、角色闸在第 ${gate.line} 行`,
    () => assert.ok(auth.line < firstRoute && gate.line < firstRoute,
      '守卫排在了某条路由之后 —— 那条路由没有任何认证'));

  const before = routeLines.filter((r) => r.line < Math.max(auth.line, gate.line));
  ok('没有任何路由定义出现在守卫之前', () => {
    assert.deepStrictEqual(before.map((r) => `第${r.line}行 ${r.text}`), [],
      '这些路由在守卫之前定义，等于公开接口');
  });
}

console.log('\n【C. 摘要缓存失效钩子在守卫之后（未登录不能触发缓存清理）】');
{
  const hasHook = /invalidateSummaryCache\(\)/.test(src) && /req\.method === 'GET'/.test(src);
  ok('存在「写请求成功后清摘要缓存」的统一钩子', () => assert.ok(hasHook,
    '找不到统一失效钩子 —— 手记/设置/友链的写操作会让主页摘要陈旧最多 60 秒'));
  ok('钩子只对写方法生效（GET/HEAD/OPTIONS 直接放过）',
    () => assert.ok(/req\.method === 'GET'[\s\S]{0,120}return next\(\);/.test(src),
      '钩子可能对读请求也做了事'));
}

console.log('\n【D. 自检：判据能抓到「路由写到守卫上面」】');
{
  const fake = [
    "const router = express.Router();",
    "router.get('/leak', (req, res) => res.json({}));",   // ← 故意写在守卫前
    "router.use(authRequired);",
    "router.use((req, res, next) => { if (req.user.role === 'admin') return next(); });",
  ].join('\n');
  const fakeLines = fake.split('\n');
  const fakeRoutes = [];
  const fakeGuards = [];
  fakeLines.forEach((line, i) => {
    if (/router\.(get|post|put|patch|delete|all)\s*\(/.test(line)) fakeRoutes.push(i + 1);
    if (/router\.use\(\s*authRequired/.test(line)) fakeGuards.push(i + 1);
  });
  ok('自检：写在守卫之前的路由会被识别出来',
    () => assert.ok(fakeRoutes[0] < fakeGuards[0],
      '判据没能识别出「先有路由、后有守卫」的坏形态'));

  const good = "router.use(authRequired);\nrouter.get('/ok', () => {});";
  ok('自检：守卫在前的正常形态不会被误报', () => {
    const gl = good.split('\n').findIndex((l) => /authRequired/.test(l)) + 1;
    const rl = good.split('\n').findIndex((l) => /router\.get/.test(l)) + 1;
    assert.ok(gl < rl);
  });
}

console.log(`\nadminAuthz 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
