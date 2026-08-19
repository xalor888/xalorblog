/**
 * 登录爆破防护测试
 * 流程：非法输入拒绝（不计数）→ 4 次错误密码（计数累积，剩余提示）→
 *       正确密码成功（计数重置）→ 5 次连续错误触发锁定 →
 *       锁定期内正确密码也被拒
 * 注意：本套件会触发 IP 信誉封禁（登录失败计 AUTH 积分），
 *       但 /auth/login 在 ipGuard 豁免列表内，锁定测试仍可完成。
 *       必须单独运行（会污染后续测试的 IP 状态）。
 * 前置：干净 IP + admin/admin123
 */
const c = require('./client');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function suite() {
  console.log('\n=== 1. 非法输入拒绝（不计失败计数） ===');
  let xffCounter = 1;
  const loginHdr = { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
  const tryLogin = async (password, username = 'admin') => {
    const testIp = `192.0.2.${xffCounter++}`;
    const testFp = xffCounter.toString(16).padStart(2, '0').repeat(32);
    const ticket = await c.getTicket(testFp, undefined, { 'X-Forwarded-For': testIp });
    return c.req('POST', '/api/auth/login', {
      body: { username, password },
      ticket,
      headers: { ...loginHdr, 'X-Fp': testFp, 'X-Forwarded-For': testIp },
      silent: true,
    });
  };

  let r = await tryLogin('');
  assert('空密码被拒（400）', r.status === 400, `status=${r.status}`);
  r = await tryLogin('x'.repeat(100));
  assert('超长密码被拒（400）', r.status === 400, `status=${r.status}`);

  console.log('\n=== 2. 4 次错误密码（计数累积 1→4） ===');
  for (let i = 0; i < 4; i++) {
    r = await tryLogin('wrong-pass-' + i);
    assert(`第 ${i + 1} 次错误被拒（401）`, r.status === 401, `status=${r.status} ${r.body && r.body.message}`);
  }
  assert('剩余尝试次数提示（剩余 1 次）', /剩余 1 次/.test(r.body.message || ''), r.body && r.body.message);

  console.log('\n=== 3. 第 5 次正确密码 → 成功（计数重置） ===');
  r = await tryLogin('admin123');
  assert('正确密码成功', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 4. 5 次连续错误 → 触发锁定 ===');
  for (let i = 0; i < 4; i++) {
    r = await tryLogin('brute-' + i);
    assert(`第 ${i + 1} 次错误被拒`, r.status === 401, `status=${r.status}`);
  }
  // 第 5 次失败：recordFail 此刻设置锁定，本请求返回 401（checkLock 在其之前执行）
  r = await tryLogin('brute-5');
  assert('第 5 次错误仍 401（锁定已设置）', r.status === 401, `status=${r.status} ${r.body && r.body.message}`);
  // 下一次请求才命中锁定
  r = await tryLogin('brute-6');
  assert('后续请求触发账号锁定（401）', r.status === 401, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 5. 锁定期内正确密码也被拒 ===');
  r = await tryLogin('admin123');
  assert('锁定期正确密码 401', r.status === 401, `status=${r.status} ${r.body && r.body.message}`);

  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
