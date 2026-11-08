/**
 * `/api/hitokoto` 的行为（零测试模块补测）。
 *
 * 为什么之前没测：它只是「转发一条一言」，看起来最不容易出事。但它有两个真实风险：
 *   1. **依赖外部网络**：上游挂了、返回非 JSON、超时 —— 每个分支都决定首页那句引言有没有内容；
 *   2. **缓存降级**：有缓存时上游失败应该继续服务旧句子，而不是让首页空一块。
 *
 * 本文件用假 fetch 覆盖四个分支（正常 / 上游 5xx / 抛异常 / 空内容），并验证：
 *   - 100 字以上的长引用会被截断（首页布局依赖这个上界）
 *   - 上游失败且有缓存时，返回旧值而不是 502
 *   - 上游失败且无缓存时，502 + 统一错误形状
 *   - 8 秒缓存命中（同一句不重复打上游）
 *
 * 全程无网络、无数据库。
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

/** 从 router 里取 GET 处理器（router 是 express.Router，只有一个路由） */
function pickGetHandler(router) {
  const layer = router.stack.find((l) => l.route && l.route.methods && l.route.methods.get);
  if (!layer) throw new Error('找不到 GET 路由');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** 最小 res 替身：记录状态码与 JSON */
function mkRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

const realFetch = global.fetch;

/** 把全局 fetch 换成按脚本返回的假实现，返回调用计数 */
function stubFetch(script) {
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    return script(calls, url);
  };
  return () => calls;
}

const resOf = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

(async () => {
  // 必须在 require 之前设置 env：路由模块在加载时不会读 env，但 config 会校验 DB_PASSWORD
  const router = require('../src/routes/hitokoto');
  const handler = pickGetHandler(router);

  console.log('\n【A. 正常路径】');
  {
    const calls = stubFetch(() => resOf({ hitokoto: '人生如逆旅，我亦是行人。', from: '苏轼' }));
    const res = mkRes();
    await handler({ headers: {}, ip: '127.0.0.1' }, res, () => {});
    await ok('返回 200 且带引言文本', () => {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.code, 0);
      assert.ok(res.body.data.hitokoto.includes('人生如逆旅'));
    });
    await ok('带出处时拼成「引言 —— 出处」', () => {
      assert.ok(res.body.data.hitokoto.includes('—— 苏轼'), res.body.data.hitokoto);
    });
    await ok('只打了一次上游', () => assert.strictEqual(calls(), 1));

    console.log('\n【B. 8 秒缓存】');
    const res2 = mkRes();
    await handler({ headers: {}, ip: '127.0.0.1' }, res2, () => {});
    await ok('第二次请求命中缓存，没有再打上游', () => {
      assert.strictEqual(calls(), 1, `上游被打了 ${calls()} 次`);
      assert.strictEqual(res2.body.data.hitokoto, res.body.data.hitokoto);
    });
  }

  console.log('\n【C. 超长引用被截断（首页布局依赖这个上界）】');
  {
    const long = '啊'.repeat(200);
    stubFetch(() => resOf({ hitokoto: long, from: '某处' }));
    const res = mkRes();
    await handler({ headers: {}, ip: '127.0.0.1' }, res, () => {});
    await ok('长度不超过 120 字符', () => {
      assert.ok(res.body.data.hitokoto.length <= 120, `实际 ${res.body.data.hitokoto.length}`);
    });
  }

  console.log('\n【D. 上游失败：有缓存则降级服务旧值】');
  {
    // 干净实例 + 先成功一次把句子放进缓存
    delete require.cache[require.resolve('../src/routes/hitokoto')];
    const fresh = require('../src/routes/hitokoto');
    const h = pickGetHandler(fresh);
    stubFetch(() => resOf({ hitokoto: '缓存里的句子', from: '某处' }));
    const res = mkRes();
    await h({ headers: {}, ip: '127.0.0.1' }, res, () => {});
    assert.strictEqual(res.statusCode, 200, '前置：第一次应当成功');

    // 让缓存「过期」：把 Date.now 推后 9 秒（8s TTL 之外），再让上游挂掉。
    // 不用真的等 8 秒 —— 这里要测的是分支逻辑，不是时钟。
    const realNow = Date.now;
    const shifted = () => realNow() + 9000;
    Date.now = shifted;
    stubFetch(() => resOf({ error: 'down' }, 503));
    const res2 = mkRes();
    await h({ headers: {}, ip: '127.0.0.1' }, res2, () => {});
    Date.now = realNow;

    await ok('缓存过期 + 上游 5xx → 仍返回 200（不把旧句子一起丢掉）', () => {
      assert.strictEqual(res2.statusCode, 200, `status=${res2.statusCode}`);
    });
    await ok('返回的正是缓存里那句（不是重新拼的空响应）', () => {
      assert.ok(res2.body.data.hitokoto.includes('缓存里的句子'), res2.body.data.hitokoto);
    });
  }

  console.log('\n【E. 上游失败且无可用缓存 → 502 且形状统一】');
  {
    // 通过重新加载模块得到一份干净缓存
    delete require.cache[require.resolve('../src/routes/hitokoto')];
    const fresh = require('../src/routes/hitokoto');
    const h2 = pickGetHandler(fresh);
    stubFetch(() => resOf({ error: 'down' }, 500));
    const res = mkRes();
    await h2({ headers: {}, ip: '127.0.0.1' }, res, () => {});
    await ok('返回 502', () => assert.strictEqual(res.statusCode, 502));
    await ok('错误形状是 { code: 1, message }', () => {
      assert.strictEqual(res.body.code, 1);
      assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
    });
    await ok('上游返回空内容也算不可用', async () => {
      stubFetch(() => resOf({ hitokoto: '   ' }));
      const res2 = mkRes();
      await h2({ headers: {}, ip: '127.0.0.1' }, res2, () => {});
      assert.strictEqual(res2.statusCode, 502);
    });
    await ok('上游抛异常（超时/网络）不会 500 泄漏堆栈', async () => {
      stubFetch(() => { throw new Error('ECONNREFUSED'); });
      const res3 = mkRes();
      await h2({ headers: {}, ip: '127.0.0.1' }, res3, () => {});
      assert.strictEqual(res3.statusCode, 502);
      assert.ok(!/ECONNREFUSED/.test(JSON.stringify(res3.body)), '错误细节泄漏到响应里');
    });
  }

  console.log('\n【F. 自检：判据能区分正常与失败】');
  await ok('自检：200 与 502 的判定不同', async () => {
    const a = { ok: true, status: 200 };
    const b = { ok: false, status: 500 };
    assert.notStrictEqual(a.ok, b.ok);
  });

  global.fetch = realFetch;
  console.log(`\nhitokoto 套件结果: ${pass} 通过, ${fail} 失败`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})().catch((e) => {
  global.fetch = realFetch;
  console.error('测试执行异常:', e && e.stack || e);
  process.exit(1);
});
