/**
 * HTTP 契约的边界形态 —— 「错误也是 API」。
 *
 * 这些状态码此前只在实现里出现过（app.js 的 405/413/400 分支），
 * 没有一条测试真的发过这种请求。它们的价值在于：**客户端与运维靠它们判断发生了什么**。
 *   - 405 没有 `Allow` 头 → 客户端不知道该用什么方法
 *   - 413 被写成 500 → 监控把「用户传太大」算成服务端故障
 *   - 非法 JSON 返回 500 → 前端无法区分「我写错了」与「服务器坏了」
 *   - 未知路径返回 HTML 错误页 → 前端 JSON 解析直接抛，掩盖真实原因
 *
 * 前置：已 seed（admin/admin123）+ 干净 IP + DB_NAME 以 `_scratch` 结尾。
 */

const c = require('./client');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

/** 统一形状：{code:1, message:string, data:null|...} */
const shaped = (r) => !!(r.body && typeof r.body.code === 'number' && typeof r.body.message === 'string' && Object.hasOwn(r.body, 'data'));

async function suite() {
  console.log('\n=== 1. 不支持的方法 → 405 + Allow 头 ===');
  {
    // TRACE 不在白名单里（这是最该被拒的一种：可被用于 XST）
    const r = await c.req('TRACE', '/api/articles', { silent: true });
    assert('TRACE 被拒（405）', r.status === 405, `status=${r.status}`);
    assert('带 Allow 头，且列出的方法不含 TRACE', !!r.headers.allow && !r.headers.allow.includes('TRACE'),
      String(r.headers.allow));
    assert('错误形状统一', shaped(r), JSON.stringify(r.body || {}));
  }

  console.log('\n=== 2. 非法 JSON → 400（不是 500） ===');
  {
    const r = await c.req('POST', '/api/comments', { headers: { 'Content-Type': 'application/json' }, rawBody: '{bad json', silent: true });
    assert('返回 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body || {}).slice(0, 80)}`);
    assert('形状统一', shaped(r), JSON.stringify(r.body || {}));
    assert('文案说明是请求格式问题（不是「服务器开小差」）', /格式|不合法/.test(r.body.message), r.body.message);
  }

  console.log('\n=== 3. 超大请求体 → 413（不是 500） ===');
  {
    // express.json limit 2mb；这里发 ~3MB 的合法 JSON
    const big = JSON.stringify({ content: 'x'.repeat(3 * 1024 * 1024) });
    const r = await c.req('POST', '/api/comments', { headers: { 'Content-Type': 'application/json' }, rawBody: big, silent: true });
    assert('返回 413', r.status === 413, `status=${r.status}`);
    assert('形状统一', shaped(r), JSON.stringify(r.body || {}).slice(0, 120));
  }

  console.log('\n=== 4. 未知路径 → 404 且仍是 JSON ===');
  {
    const ticket = await c.getTicket();
    const r = await c.req('GET', '/api/definitely-not-a-route-' + Date.now(), { ticket, silent: true });
    assert('返回 404', r.status === 404, `status=${r.status}`);
    assert('响应是 JSON 而不是 HTML 错误页', shaped(r), String(r.raw || '').slice(0, 80));
  }

  console.log('\n=== 5. 健康探针的两种语义（线上排障最常用） ===');
  {
    const r1 = await c.req('GET', '/api/health/live', { silent: true });
    assert('/health/live 不需要票据且 200', r1.status === 200, `status=${r1.status}`);
    const r2 = await c.req('GET', '/api/health/ready', { silent: true });
    assert('/health/ready 200 且 db:up（测试库可用）',
      r2.status === 200 && r2.body && r2.body.data && r2.body.data.db === 'up',
      `status=${r2.status} body=${JSON.stringify(r2.body || {}).slice(0, 80)}`);
  }

  console.log('\n=== 6. 响应头：错误响应也必须带安全头 ===');
  {
    const r = await c.req('GET', '/api/definitely-not-a-route-2', { silent: true });
    assert('X-Content-Type-Options: nosniff', r.headers['x-content-type-options'] === 'nosniff', String(r.headers['x-content-type-options']));
    assert('X-Frame-Options: DENY', r.headers['x-frame-options'] === 'DENY', String(r.headers['x-frame-options']));
    assert('带 X-Request-Id（错误也能被追踪）', /^[A-Za-z0-9-]{8,64}$/.test(String(r.headers['x-request-id'] || '')),
      String(r.headers['x-request-id']));
  }

  console.log(`\nhttpContract 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

suite().catch((e) => {
  console.error('套件异常:', e && e.stack || e);
  process.exitCode = 1;
});
