/**
 * 认证会话管理测试
 * 流程：登录 ×2 → 会话列表 → 撤销另一会话 → 被撤销 token 失效 → 当前会话仍有效 →
 *       登出 → 登出后 token 失效 → 重新登录（恢复状态）
 * 前置：干净 IP + admin/admin123（不修改密码）
 */
const c = require('./client');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function suite() {
  console.log('\n=== 1. 双设备登录 ===');
  const ticket = await c.getTicket();
  const fp = 'a'.repeat(64);
  const loginHdr = { 'X-Fp': fp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
  const login = async () => {
    const r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, ticket, headers: loginHdr });
    return r.status === 200 ? r.body.data.token : null;
  };
  const tokenA = await login();
  const path = (await c.req('GET', '/api/anti/admin-path', { ticket, silent: true })).body.data.path;
  const base = '/api/' + path;
  const hA = { Authorization: 'Bearer ' + tokenA, 'X-Fp': fp };
  // 清理历史会话（其他测试套件可能残留），保证后续计数精确
  let r = await c.req('POST', '/api/auth/logout-all', { body: {}, ticket, headers: hA, silent: true });
  assert('清理历史会话', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  const tokenB = await login();
  assert('设备 A 登录', !!tokenA);
  assert('设备 B 登录', !!tokenB);
  const hB = { Authorization: 'Bearer ' + tokenB, 'X-Fp': fp };

  console.log('\n=== 2. 会话列表（应含 2 个活跃会话） ===');
  r = await c.req('GET', '/api/auth/sessions', { ticket, headers: hA, silent: true });
  const sessions = r.body.data;
  assert('会话列表 2 个', r.status === 200 && sessions.length === 2, `status=${r.status} count=${sessions.length}`);
  const currentA = sessions.find((s) => s.current);
  const otherB = sessions.find((s) => !s.current);
  assert('当前会话标记正确', !!currentA && !!otherB, JSON.stringify(sessions.map(s => ({ jti: s.jti.slice(0, 8), current: s.current }))));

  console.log('\n=== 3. 撤销设备 B 会话 ===');
  r = await c.req('DELETE', '/api/auth/sessions/' + otherB.jti, { ticket, headers: hA, silent: true });
  assert('撤销成功', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  // 设备 B 的 token 应失效（401）
  r = await c.req('GET', base + '/articles/admin/list', { ticket, headers: hB, silent: true });
  assert('被撤销 token 失效（401）', r.status === 401, `status=${r.status} ${r.body && r.body.message}`);
  // 设备 A 仍有效
  r = await c.req('GET', base + '/articles/admin/list', { ticket, headers: hA, silent: true });
  assert('设备 A 会话仍有效', r.status === 200, `status=${r.status}`);

  console.log('\n=== 4. 登出设备 A ===');
  r = await c.req('POST', '/api/auth/logout', { body: {}, ticket, headers: hA, silent: true });
  assert('登出成功', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', base + '/articles/admin/list', { ticket, headers: hA, silent: true });
  assert('登出后 token 失效（401）', r.status === 401, `status=${r.status}`);

  console.log('\n=== 5. 重新登录恢复状态 ===');
  const tokenC = await login();
  assert('重新登录成功', !!tokenC);
  const hC = { Authorization: 'Bearer ' + tokenC, 'X-Fp': fp };
  r = await c.req('GET', base + '/articles/admin/list', { ticket, headers: hC, silent: true });
  assert('新会话可用', r.status === 200, `status=${r.status}`);

  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
