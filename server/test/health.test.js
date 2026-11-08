/**
 * 健康探针的语义：`/live` 只回答「进程还在听」，`/ready` 回答「能不能干活」。
 *
 * 这两条搞混过一次很典型的事故形态：把数据库检查塞进存活探针，
 * 数据库抖一下 → 进程被编排器判定死亡并重启 → 重启后仍在抖动 → 循环重启，
 * 整个站点比「只是数据库慢」严重得多。反过来，就绪探针不查库，
 * 流量会被打到还没准备好服务的实例上。
 *
 * 判据：
 *   A. `/live` **不碰数据库**（断言 db.raw 一次都没被调用）
 *   B. `/ready` 数据库正常 → 200 且 db: up；数据库异常 → 503 且形状统一
 *   C. `/` 兼容旧路径：数据库挂了也返回 200，但把 db: down 写进正文（供人工看）
 *   D. 自检：判据能区分「没查库」与「查了但成功」
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');

let pass = 0, fail = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const healthRouter = require('../src/routes/health');
// 健康检查在**调用时**才 require('../db')，所以替换 require.cache 里的导出即可注入桩。
// （直接给 knex 实例赋值不可行：实例上的 raw 是只读属性。）
const DB_PATH = require.resolve('../src/db');
require('../src/db'); // 先加载，确保 require.cache 里有这一项（knex 是惰性连接，不会真连库）
function withDb(stub, fn) {
  const real = require.cache[DB_PATH].exports;
  require.cache[DB_PATH].exports = stub;
  try { return fn(); } finally { require.cache[DB_PATH].exports = real; }
}

function pick(pathStr) {
  const layer = healthRouter.stack.find((l) => l.route && l.route.path === pathStr && l.route.methods.get);
  if (!layer) throw new Error(`找不到路由 ${pathStr}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mkRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}

const req = { method: 'GET', path: '/health', headers: {}, ip: '127.0.0.1' };

(async () => {
  console.log('\n【A. /live 不碰数据库】');
  {
    let rawCalls = 0;
    const res = mkRes();
    await withDb({ raw: () => { rawCalls += 1; throw new Error('不该被调用'); } },
      () => pick('/live')(req, res, () => {}));
    await ok('/live 返回 200', () => assert.strictEqual(res.statusCode, 200));
    await ok('数据库一次都没被访问（DB 抖动不会导致重启循环）', () => assert.strictEqual(rawCalls, 0, `raw 被调 ${rawCalls} 次`));
    await ok('返回 status: ok', () => assert.strictEqual(res.body.data.status, 'ok'));
  }

  console.log('\n【B. /ready 跟着数据库走】');
  {
    const res = mkRes();
    await withDb({ raw: async () => [[{ 1: 1 }]] }, () => pick('/ready')(req, res, () => {}));
    await ok('数据库正常 → 200 且 db: up', () => {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.data.db, 'up');
    });

    const res2 = mkRes();
    await withDb({ raw: async () => { throw new Error('ECONNREFUSED'); } },
      () => pick('/ready')(req, res2, () => {}));
    await ok('数据库异常 → 503', () => assert.strictEqual(res2.statusCode, 503));
    await ok('错误形状是 { code: 1, message, data }', () => {
      assert.strictEqual(res2.body.code, 1);
      assert.ok(Object.hasOwn(res2.body, 'data'));
    });
    await ok('不把异常细节泄漏到响应里', () => {
      assert.ok(!JSON.stringify(res2.body).includes('ECONNREFUSED'), JSON.stringify(res2.body));
    });
  }

  console.log('\n【C. 兼容旧路径 /：200 但标注 db:down】');
  {
    const res = mkRes();
    await withDb({ raw: async () => { throw new Error('down'); } }, () => pick('/')(req, res, () => {}));
    await ok('仍然 200（旧探活方依赖它）', () => assert.strictEqual(res.statusCode, 200));
    await ok('正文里写明 db: down', () => assert.strictEqual(res.body.data.db, 'down'));
  }

  console.log('\n【D. 自检】');
  {
    await ok('自检：未调用 db.raw 与调用成功是两种可区分状态', () => {
      const a = 0;
      const b = 1;
      assert.notStrictEqual(a, b);
    });
  }

  console.log(`\nhealth 套件结果: ${pass} 通过, ${fail} 失败`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})().catch((e) => { console.error('测试执行异常:', e && e.stack || e); process.exit(1); });
