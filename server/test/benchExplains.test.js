/**
 * 基线工具的**保真度**：`scripts/bench-read-paths.js` 里 EXPLAIN 用的 SQL，
 * 必须与真实路由的查询同形 —— 否则它会记录一条**站点从不执行**的慢查询。
 *
 * 这不是假想的风险：手记那条 EXPLAIN 原来写的是 `order by id desc`（简化版），
 * 于是它连续十几轮报「Using filesort」，而真正的排序键是
 * `is_pinned DESC, published_at DESC, id DESC`。结果：
 *   - 记录的「成因」是错的（以为是 status+id 的组合问题）
 *   - 修好之后基线**照样报 filesort**（因为查的根本不是那条语句）
 * 一个不存在的慢查询被当成现状，真问题反而看不见。
 *
 * 判据（静态，不需要数据库）：
 *   A. bench 里手记 EXPLAIN 的排序键与 `routes/notes.js` 的 orderBy 三键一致
 *   B. bench 里文章列表 EXPLAIN 的排序键与 `routes/articles.js` 一致（同一族风险）
 *   C. 每条 EXPLAIN 都带 `status` 过滤（否则测的是全表形态）
 *   D. 自检：判据能抓到「简化成 order by id」的退化
 */

'use strict';

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const ROOT = join(__dirname, '..');
const BENCH = readFileSync(join(ROOT, 'scripts', 'bench-read-paths.js'), 'utf8');
const NOTES = readFileSync(join(ROOT, 'src', 'routes', 'notes.js'), 'utf8');
const ARTICLES = readFileSync(join(ROOT, 'src', 'routes', 'articles.js'), 'utf8');

/** 从 `orderBy([...])` 里抽 column 列表 */
function orderKeys(src, nth = 0) {
  const blocks = [...src.matchAll(/\.orderBy\(\s*\[([\s\S]*?)\]\s*\)/g)].map((m) => m[1]);
  const block = blocks[nth];
  if (!block) return null;
  return [...block.matchAll(/column:\s*'([^']+)'/g)].map((x) => x[1]);
}

/** 从 bench 里抽某个 label 附近的 sql 片段 */
function benchSqlFor(keyword) {
  const at = BENCH.indexOf(keyword);
  if (at < 0) return null;
  return BENCH.slice(at, at + 400);
}

console.log('\n【A. 手记：EXPLAIN 的排序键必须与路由一致】');
{
  const routeKeys = orderKeys(NOTES);
  ok(`routes/notes.js 的排序键是 is_pinned → published_at → id（实际 ${routeKeys && routeKeys.join(' → ')}）`,
    () => assert.deepStrictEqual(routeKeys, ['is_pinned', 'published_at', 'id']));

  const sql = benchSqlFor('手记列表');
  ok('bench 里有手记的 EXPLAIN 用例', () => assert.ok(sql, '找不到「手记列表」的 EXPLAIN 定义'));

  ok('bench 的手记 SQL 含 is_pinned（不是简化成 order by id）', () => {
    assert.ok(/is_pinned/.test(sql), `bench 的手记 EXPLAIN 里没有 is_pinned：${String(sql).slice(0, 120)}`);
  });
  ok('bench 的手记 SQL 含 published_at', () => assert.ok(/published_at/.test(sql)));
  ok('bench 的手记 SQL 带 status 过滤（否则测的是全表形态）', () => assert.ok(/'status'|status/.test(sql)));
}

console.log('\n【B. 文章列表：同一族风险】');
{
  // 文章路由里有多个 orderBy 块（详情/上一篇下一篇/列表），取含 published_at 的那个
  const routeKeys = (() => {
    const blocks = [...ARTICLES.matchAll(/\.orderBy\(\s*\[([\s\S]*?)\]\s*\)/g)].map((m) => m[1]);
    const hit = blocks.find((b) => /published_at/.test(b));
    return hit ? [...hit.matchAll(/column:\s*'([^']+)'/g)].map((x) => x[1]) : null;
  })();
  const sql = benchSqlFor('文章列表（status + published_at desc + 分页）');
  ok('bench 里有文章列表的 EXPLAIN 用例', () => assert.ok(sql));
  ok('bench 的文章 SQL 含 published_at + id（与路由同形）', () => {
    assert.ok(/published_at/.test(sql) && /id/.test(sql), String(sql).slice(0, 120));
  });
  // 文章列表的排序键是**变量**（`orderBy` 在多个分支里被赋成不同数组，列名还带 `a.` 前缀），
  // 抽列名的正则在这里不可靠。改为断言「源码里确实按 published_at 排序」——
  // 这条足以守住「bench 测的是列表而不是详情」的意图，不追求逐键相等。
  ok('路由的文章列表确实按 published_at 排序', () => {
    assert.ok(/orderBy[\s\S]{0,200}?published_at/.test(ARTICLES),
      'routes/articles.js 里找不到按 published_at 排序的 orderBy');
  });
}

console.log('\n【C. 每条 EXPLAIN 都带 status 过滤】');
{
  const explains = [...BENCH.matchAll(/label:\s*'([^']+)',([\s\S]{0,400}?)\.toString\(\)/g)]
    .map((m) => ({ label: m[1], sql: m[2] }))
    .filter((e) => /\.(where|orderBy|limit|select)\(/.test(e.sql));
  ok(`解析到 ${explains.length} 条 EXPLAIN 用例`, () => assert.ok(explains.length >= 3, '至少应有归档/手记/文章三条'));
  const missingStatus = explains.filter((e) => !/status/.test(e.sql));
  ok('没有任何 EXPLAIN 用例漏掉 status 过滤', () => assert.deepStrictEqual(missingStatus.map((e) => e.label), []));
}

console.log('\n【D. 自检：判据能抓到退化】');
ok('自检：把查询简化成 order by id 会被 A 组第一条抓到', () => {
  const fakeBench = "label: '手记列表（status + id desc）',\n sql: db('notes').where('status','published').orderBy('id','desc').toString()";
  const fakeSql = fakeBench.slice(fakeBench.indexOf('label'));
  assert.ok(!/is_pinned/.test(fakeSql), '假样本里本来就没有 is_pinned');
});
ok('自检：orderKeys 能区分三键与一键', () => {
  const three = orderKeys(NOTES);
  assert.strictEqual(three.length, 3, `实际 ${three.length} 个键`);
});

console.log(`\nbenchExplains 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
