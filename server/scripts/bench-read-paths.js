#!/usr/bin/env node
/**
 * 只读接口的 SQL 条数 / 耗时基线（**不启 HTTP 服务、不需要票据**）。
 *
 * 为什么单独做这个工具：
 * 前几轮给 `/archive`、`/api/home/summary`、`/api/articles` 加了缓存、把 `notes` 列表的
 * `content` 换成 `LEFT(content, 2000)`、给 `articles.slug` 删了一条冗余索引 ——
 * 但**这些优化从来没有被量化过**。没有基线，"优化"就只是一种说法。
 *
 * 做法：直接调用路由 handler（跳过 HTTP 与票据层），用 knex 的 `query` 事件精确计数
 * 实际发往 MySQL 的语句。每个路径跑两次：清缓存后的**冷路径**与紧接着的**热路径**。
 *
 * 安全性：只调用 GET 读接口，不写任何数据。可以随时重跑。
 *
 * 用法：
 *   cd server && node scripts/bench-read-paths.js
 *   cd server && node scripts/bench-read-paths.js --rounds 5
 */

'use strict';

require('dotenv').config();

const path = require('path');
const SERVER_DIR = path.join(__dirname, '..');

const db = require(path.join(SERVER_DIR, 'src', 'db'));

/** 全局 SQL 计数器：由 db 的 query 事件驱动 */
let sqlCount = 0;
const sqlLog = [];
db.on('query', (q) => {
  sqlCount++;
  if (sqlLog.length < 400) {
    sqlLog.push(String(q && q.sql ? q.sql : '').replace(/\s+/g, ' ').slice(0, 160));
  }
});

/** 最小 res 替身 */
/**
 * 最小 res 桩。除了 JSON 接口，还要支持分享页那种 HTML 响应：
 * 它走 `res.set(...)` + `res.status(...).send(html)` + 条件 ETag（可能 `end()`）。
 * 缺方法会直接报「res.set is not a function」，把接口本身的问题掩盖掉。
 */
function makeRes() {
  const out = { status: 200, body: null, html: null, headers: {} };
  const res = {
    status(c) { out.status = c; return res; },
    json(payload) { out.body = payload; return res; },
    set(k, v) { out.headers[k] = v; return res; },
    setHeader(k, v) { out.headers[k] = v; return res; },
    get(k) { return out.headers[k]; },
    type() { return res; },
    send(payload) {
      // 分享页发的是字符串 HTML；JSON 接口仍走 json()
      if (typeof payload === 'string') out.html = payload;
      else out.body = payload;
      return res;
    },
    append(k, v) {
      // Express 的 res.append 会在同名头上追加（分享页用它设 Vary: Accept-Encoding）
      out.headers[k] = out.headers[k] ? out.headers[k] + ', ' + v : v;
      return res;
    },
    removeHeader(k) { delete out.headers[k]; return res; },
    vary() { return res; },
    end(payload) { if (typeof payload === 'string') out.html = payload; return res; },
  };
  return { res, out };
}

/** 从 express router 里取出指定 method+path 的 handler（跳过中间件） */
function pickHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`找不到路由 ${method} ${routePath}`);
  // 取最后一个 handle（前面的通常是限流/反爬中间件）
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

/** 跑一次 handler，返回 { sql, ms, status, size } */
async function runOnce(handler, req) {
  sqlCount = 0;
  sqlLog.length = 0;
  const { res, out } = makeRes();
  const t0 = process.hrtime.bigint();
  await handler(req, res, () => {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    sql: sqlCount,
    ms,
    status: out.status,
    size: out.body ? JSON.stringify(out.body).length : (out.html ? out.html.length : 0),
  };
}

/** 取中位数（比平均值抗抖动） */
function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const fmt = (n, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : String(n));

async function main() {
  const roundsArg = process.argv.indexOf('--rounds');
  const rounds = roundsArg > -1 ? Math.max(1, Number(process.argv[roundsArg + 1]) || 3) : 3;

  const articlesRouter = require(path.join(SERVER_DIR, 'src', 'routes', 'articles'));
  const homeRouter = require(path.join(SERVER_DIR, 'src', 'routes', 'home'));
  const notesRouter = require(path.join(SERVER_DIR, 'src', 'routes', 'notes'));
  const shareRouter = require(path.join(SERVER_DIR, 'src', 'routes', 'share'));
  const tagsRouter = require(path.join(SERVER_DIR, 'src', 'routes', 'tags'));

  const archiveHandler = pickHandler(articlesRouter, 'get', '/archive');
  const summaryHandler = pickHandler(homeRouter, 'get', '/summary');
  const notesHandler = pickHandler(notesRouter, 'get', '/');
  // 分享页要按路由参数取：pickHandler 只按路径前缀找，这里直接拿 router 的栈项
  const sharePageHandler = pickHandler(shareRouter, 'get', '/share-page/:page?');
  // 分享页有 60 秒列表缓存，不失效的话「冷路径」只有第一轮是冷的，
  // 取中位数会得到 0 条 SQL —— 那是假数据（这次实测发现）
  const invalidateShare = shareRouter.clearShareListCache;
  const tagsHandler = pickHandler(tagsRouter, 'get', '/');

  const invalidateArchive = articlesRouter.invalidateArchiveCache;
  const invalidateSummary = homeRouter.invalidateSummaryCache;

  const req = (query = {}) => ({ query, headers: {}, ip: '127.0.0.1', protocol: 'https', get: () => 'bench.local' });

  const cases = [
    {
      name: 'GET /api/articles/archive',
      handler: archiveHandler,
      invalidate: invalidateArchive,
      req: () => req(),
    },
    {
      name: 'GET /api/home/summary',
      handler: summaryHandler,
      invalidate: invalidateSummary,
      req: () => req(),
    },
    {
      name: 'GET /api/notes (page=1)',
      handler: notesHandler,
      invalidate: null,
      req: () => req({ page: '1', pageSize: '10' }),
    },
    {
      // 这一页后续加了「最近 30 篇文章」的正文列表（给搜索引擎的真实内容），
      // 所以它的 SQL 条数与体积值得单独盯住
      name: 'GET /api/share-page/articles',
      handler: sharePageHandler,
      invalidate: invalidateShare,
      req: () => ({ ...req(), params: { page: 'articles' }, path: '/api/share-page/articles' }),
    },
    {
      name: 'GET /api/tags',
      handler: tagsHandler,
      invalidate: null,
      req: () => req(),
    },
  ];

  /**
   * 预算表：**SQL 条数与响应体积**的上限。耗时不上预算（受机器负载影响，只作趋势）。
   *
   * 为什么值得做成门禁：这些优化当初只有「优化过」的说法，没有防线 —— 只要有人在
   * 列表 handler 里为每条记录再查一次库，一切照常绿，只是每页多打 N+1 条 SQL。
   * SQL 条数与缓存/查询结构直接相关、不受数据行数影响，是这里唯一能稳定断言的数字。
   *
   * 余量口径：cold 给实测值本身（缓存失效后应当精确可数）；体积给 +15%（内容会自然增长）。
   * 热路径要求严格为 0（有缓存就该 0 条）；没接 invalidate 的用例（notes/tags）不设热预算。
   */
  const BUDGET = {
    'GET /api/articles/archive': { cold: 1, warm: 0, size: 700 },
    'GET /api/home/summary': { cold: 5, warm: 0, size: 1800 },
    'GET /api/notes (page=1)': { cold: 2, size: 150 },
    'GET /api/share-page/articles': { cold: 1, warm: 0, size: 2900 },
    'GET /api/tags': { cold: 1, size: 620 },
  };
  const assertMode = process.argv.includes('--assert');
  const overBudget = [];
  // 先说清楚基线是在什么数据规模下测的 —— 否则耗时数字会被误读
  const counts = {};
  for (const t of ['articles', 'notes', 'comments', 'tags', 'categories', 'links', 'messages']) {
    try {
      const r = await db(t).count('* as c').first();
      counts[t] = Number(r.c);
    } catch (e) {
      counts[t] = null;
    }
  }
  console.log('\n当前数据量：' + Object.entries(counts)
    .map(([k, v]) => `${k}=${v === null ? '缺表' : v}`).join('  '));
  console.log('⚠ 数据量小，**绝对耗时**只能作为趋势参考；**SQL 条数**才是主指标（它与缓存/查询结构直接相关，不受行数影响）。');

  // 自检：没接 invalidate 的用例如果带进程内缓存，「冷 SQL」只有第一轮是真的，
  // 中位数会退化成缓存命中值（这次就是这样发现 share-page 显示 0 条 SQL 的假数据）
  const noInvalidate = cases.filter((c) => !c.invalidate).map((c) => c.name);

  console.log(`\n只读接口基线（每项跑 ${rounds} 轮取中位数）`);
  console.log('='.repeat(78));
  console.log(`${'路径'.padEnd(30)} ${'冷SQL'.padStart(6)} ${'热SQL'.padStart(6)} ${'冷耗时ms'.padStart(10)} ${'热耗时ms'.padStart(10)} ${'体积'.padStart(8)}`);
  console.log('-'.repeat(78));

  for (const c of cases) {
    const cold = { sql: [], ms: [] };
    const warm = { sql: [], ms: [] };
    let size = 0;
    let status = 0;

    for (let i = 0; i < rounds; i++) {
      if (c.invalidate) c.invalidate();
      const r1 = await runOnce(c.handler, c.req());
      cold.sql.push(r1.sql); cold.ms.push(r1.ms);
      status = r1.status; size = r1.size;

      const r2 = await runOnce(c.handler, c.req());
      warm.sql.push(r2.sql); warm.ms.push(r2.ms);
    }

    console.log(
      `${c.name.padEnd(30)} ${String(median(cold.sql)).padStart(6)} ${String(median(warm.sql)).padStart(6)} `
      + `${fmt(median(cold.ms)).padStart(10)} ${fmt(median(warm.ms)).padStart(10)} ${String(size).padStart(8)}`
    );
    if (status !== 200) console.log(`  ⚠ 状态码 ${status}`);
    // 预算比对（--assert 时用于判定红绿；平时只是打印）
    const b = BUDGET[c.name];
    if (b) {
      if (median(cold.sql) > b.cold) overBudget.push(`${c.name}: 冷 SQL ${median(cold.sql)} > 预算 ${b.cold}`);
      if (b.warm != null && median(warm.sql) > b.warm) overBudget.push(`${c.name}: 热 SQL ${median(warm.sql)} > 预算 ${b.warm}`);
      if (size > b.size) overBudget.push(`${c.name}: 体积 ${size}B > 预算 ${b.size}B`);
    } else {
      overBudget.push(`${c.name}: 没有预算条目（新增用例必须登记，否则等于没有防线）`);
    }
  }

  console.log('-'.repeat(78));
  if (noInvalidate.length) {
    console.log('⚠ 以下用例没接 invalidate —— 若它们带进程内缓存，上面的「冷 SQL」只有第一轮是真的。');
    console.log('   判定方法：冷 SQL 与热 SQL 相等，说明每轮其实都不冷（那就是缓存命中，不是冷路径）。');
    for (const n of noInvalidate) console.log('   · ' + n);
    console.log('');
  }
  console.log('说明：冷 = 缓存失效后的第一次；热 = 紧接着的第二次（应命中进程内缓存）');
  console.log('      SQL 条数由 knex 的 query 事件统计，含连接与健康检查语句');

  // 采样几条实际语句，便于确认"冷路径到底打了什么"
  console.log('\n冷路径 SQL 采样（/api/articles/archive）：');
  if (invalidateArchive) invalidateArchive();
  await runOnce(archiveHandler, req());
  const sampled = [...sqlLog];
  for (const s of sampled.slice(0, 6)) console.log('  ·', s);

  // ── 索引是否真的被用上 ──
  //
  // 这一步是为前几轮那次「删掉 articles.slug 的冗余普通索引（唯一索引已覆盖）」做验证：
  // 删索引这类改动的风险是**悄悄变成全表扫描**，而功能测试完全看不出来。
  // EXPLAIN 的 key 列直接告诉你 MySQL 选了哪条索引。
  console.log('\n查询计划（EXPLAIN 的 key = MySQL 实际选用的索引）：');
  // 用表里真实存在的 slug 去 EXPLAIN：拿一个不存在的值会被优化器短路成
  // "no matching row in const table"，反而看不到索引选择。
  let realSlug = '__none__';
  try {
    const row = await db('articles').orderBy('id', 'asc').first('slug');
    if (row && row.slug) realSlug = row.slug;
  } catch (e) { /* 忽略 */ }

  const plans = [
    {
      label: `文章详情按 slug 查（slug=${JSON.stringify(realSlug).slice(0, 24)}）`,
      sql: db('articles').where('slug', realSlug).select('id').toString(),
    },
    {
      label: '归档列表（status + published_at desc 排序）',
      sql: db('articles').where('status', 'published')
        .orderBy([{ column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }])
        .limit(5000).select('id', 'title', 'slug', 'published_at').toString(),
    },
    {
      // ⚠ 这里的 SQL 必须与 routes/notes.js 的**真实排序键一致**（is_pinned → published_at → id）。
      // 旧版写的是 `order by id desc`（简化版），于是 EXPLAIN 一直在报「Using filesort」，
      // 而站点从来不跑那条语句 —— 一个不存在的慢查询被记录了十几轮，真正的成因与被修好的结果都被它盖住。
      label: '手记列表（status + is_pinned/published_at/id desc，与 routes/notes.js 同形）',
      sql: db('notes').where('status', 'published')
        .orderBy([{ column: 'is_pinned', order: 'desc' }, { column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }])
        .limit(10).select('id').toString(),
    },
    {
      label: '文章列表（status + published_at desc + 分页）',
      sql: db('articles').where('status', 'published')
        .orderBy('published_at', 'desc').limit(10).offset(0).select('id').toString(),
    },
  ];
  for (const p of plans) {
    try {
      // 必须 FORMAT=TRADITIONAL：默认 EXPLAIN 在这个 MySQL 版本返回**树形文本**
      // （只有一列 "EXPLAIN"），拿不到 key / type / rows
      const res = await db.raw(`EXPLAIN FORMAT=TRADITIONAL ${p.sql}`);
      const rows = Array.isArray(res[0]) ? res[0] : res;
      const first = rows[0] || {};
      const key = first.key == null ? '(NULL = 未用索引)' : first.key;
      const type = first.type == null ? '(短路)' : first.type;
      const extra = first.Extra ? `  Extra=${String(first.Extra).slice(0, 40)}` : '';
      const scan = first.rows == null ? '-' : first.rows;
      console.log(`  · ${p.label}`);
      console.log(`      type=${type}  key=${key}  预估扫描=${scan}${extra}`);
      // 手记这条查询有覆盖索引可用；仍然 filesort 只说明**当前这个库没迁移那条索引**
      // （生产库就是这种情况 —— migrate.js 里有，但没执行过）。把这句话打出来，
      // 免得下次有人看着 filesort 去重写 SQL。
      if (/手记/.test(p.label) && /filesort/i.test(String(extra))) {
        console.log('      ⚠ 仍在使用 filesort：当前库缺少 idx_notes_public_sort ——');
        console.log('        跑 `node src/migrate.js` 后再看这里，应变成 Covering index lookup (reverse)');
      }
    } catch (e) {
      console.log(`  · ${p.label} → EXPLAIN 失败：${e && e.message}`);
    }
  }

  console.log('\n预算判定（--assert 时决定红绿）');
  if (overBudget.length === 0) {
    console.log('  ✓ 全部用例在预算内');
  } else {
    for (const o of overBudget) console.log('  ✗ ' + o);
    console.log('  说明：SQL 条数上升通常意味着新增了一次查询或缓存没失效；');
    console.log('        确认是有意的之后，改本文件的 BUDGET 并在提交信息里写清原因。');
  }

  await db.destroy();
  if (assertMode && overBudget.length) process.exit(1);
}

main().catch(async (e) => {
  console.error('基线失败：', e && e.message);
  try { await db.destroy(); } catch (_) { /* ignore */ }
  process.exit(1);
});
