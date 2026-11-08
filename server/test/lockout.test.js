/**
 * 登录爆破防护测试
 * 流程：非法输入拒绝（不计数）→ 4 次错误密码（计数累积，文案不泄露剩余次数）→
 *       正确密码成功（计数重置）→ 同一 /56 出口连续 5 次错误 → 第 6 次起 429 →
 *       固定单 IP 的同一路径（验证不会被 IP 信誉封禁抢先成 403）→ 锁定期内正确密码也被拒
 * 注意：本套件会消耗 IP 信誉分（每跨过一个锁定周期记一次），用 TEST-NET 保留地址，
 *       不污染真实客户端；`/auth/login` 在 ipGuard 豁免列表外，但正常段不会攒到封禁阈值。
 *       必须单独运行（会污染后续测试的 IP/账号锁定状态）。
 * 前置：干净 IP + admin/admin123
 *
 * 两个维度的锁键不同，理解这一点才能读懂断言：
 *   - IP 维度按 /56 聚合（loginIpKey → ipKeyGenerator(ip, 56)）
 *   - 账号维度用数据库里的 user.id（不存在则为规范化后的用户名）
 * 账号维度的拒绝故意与「密码错误」同形（401 + 同一文案），防用户名枚举；
 * 因此**唯一能证明锁真的设上了**的可观察信号是 IP 维度的 429 + 剩余秒数。
 *
 * 2026-11-01 修复前后的关键差异（第 6 段专门钉这件事）：
 *   修复前每次密码错误都 report(ip,'auth')（权重 3，banScore=10）→ 第 4 次即被封禁，
 *   固定 IP 根本走不到第 5 次锁定，用户看到 403「访问被拒绝」；
 *   修复后 1-4 次不记分、第 5 次记一次、第 6 次起 429 —— 可恢复的那一层终于可见。
 * 第 4 段仍用「同一 /56 下不同 /64」：它验证的是**锁键的聚合语义**（运营商换地址），
 * 与第 6 段验证的「分级顺序」互补。
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
  const loginHdr = { Origin: c.TEST_ORIGIN, Referer: `${c.TEST_ORIGIN}/` };
  // 指纹按出口 IP 派生：同一地址在整段流程里保持同一指纹，
  // 免得「同 IP 换指纹」被反爬当成另一件事，污染锁定判定
  const fpFor = (ip) => Buffer.from('fp:' + ip).toString('hex').padEnd(64, '0').slice(0, 64);
  const tryLogin = async (password, username = 'admin', ipOverride) => {
    const testIp = ipOverride || `192.0.2.${xffCounter++}`;
    const testFp = fpFor(testIp);
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
    assert(`第 ${i + 1} 次错误不泄露剩余次数`, !/剩余/.test(r.body.message || ''), r.body && r.body.message);
  }
  assert('失败文案统一', r.body && r.body.message === '用户名或密码错误', r.body && r.body.message);

  console.log('\n=== 3. 第 5 次正确密码 → 成功（计数重置） ===');
  r = await tryLogin('admin123');
  assert('正确密码成功', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 4. 同一 /56 出口 5 次连续错误 → 触发锁定 ===');
  // 2001:db8:abcd:1200::/56 是同一个 IP 锁键（/56），每个 n 落在不同的 /64 上（信誉互不叠加）
  const bruteIp = (n) => `2001:db8:abcd:${(0x1200 + n).toString(16)}::${n}`;
  for (let i = 1; i <= 4; i++) {
    r = await tryLogin('brute-' + i, 'admin', bruteIp(i));
    assert(`第 ${i} 次错误被拒（401，未达锁定阈值）`, r.status === 401, `status=${r.status} ${r.body && r.body.message}`);
  }
  // 第 5 次失败：本请求内 checkLock 通过、随后 recordFail 把计数推到 MAX_FAILS 并置锁 → 本次仍是 401
  r = await tryLogin('brute-5', 'admin', bruteIp(5));
  assert('第 5 次错误仍 401（本次请求内才置锁，checkLock 先于 recordFail）', r.status === 401, `status=${r.status} ${r.body && r.body.message}`);
  // 第 6 次起：checkLock 在密码校验之前命中 IP 维度锁定 → 429，与「密码错误 401」可区分
  r = await tryLogin('brute-6', 'admin', bruteIp(6));
  const lockMsg = (r.body && r.body.message) || '';
  assert('第 6 次请求命中 IP 维度锁定（429，不是 401）', r.status === 429, `status=${r.status} ${lockMsg}`);
  assert('锁定文案含「N 秒后再试」（唯一能区分「已锁定」与「密码错」的信号）', /登录失败过多，请 \d+ 秒后再试/.test(lockMsg), lockMsg);
  const remainSec = Number((lockMsg.match(/(\d+) 秒后再试/) || [])[1]);
  assert('剩余秒数为正且不超过 LOCK_MS(5 分钟)', remainSec > 0 && remainSec <= 300, `remain=${remainSec}`);

  console.log('\n=== 5. 锁定期内正确密码也被拒 ===');
  // 同一 /56 出口：IP 锁定在 bcrypt 之前生效，正确密码也进不去
  r = await tryLogin('admin123', 'admin', bruteIp(7));
  assert('锁定期内正确密码仍被拒（429，IP 锁定先于密码校验）', r.status === 429, `status=${r.status} ${r.body && r.body.message}`);
  // 换一个干净 /56：命中账号维度锁定 —— 故意与「密码错误」同形，不泄露锁定状态
  r = await tryLogin('admin123', 'admin', '2001:db8:dead:1::7');
  assert(
    '账号维度锁定期间换出口正确密码也被拒（401 且文案与密码错误同形，防用户名枚举）',
    r.status === 401 && r.body && r.body.message === '用户名或密码错误',
    `status=${r.status} ${r.body && r.body.message}`
  );

  console.log('\n=== 6. 固定 IP：第 6 次必须是 429，不能被信誉封禁抢先 403 ===');
  // 这一段是 2026-11-01 修复的回归钉子。
  // 修复前：每次密码错误都 report(ip,'auth')（权重 3），banScore=10 → 第 4 次就把 IP 封禁，
  // 于是固定 IP 永远走不到第 5 次锁定，用户看到的是 403「访问被拒绝」而不是
  // 429「请 N 秒后再试」—— 可恢复、可解释的那一层被更粗暴的一层盖掉了。
  // 修复后：1-4 次 401（不记分）、第 5 次 401+一次记分、第 6 次 429。
  //
  // 用不存在的账号 'nobody'：admin 账号在第 4 段已经锁定，账号维度的 401 会先于
  // IP 锁定返回，掩盖本段要验证的东西（IP 维度的 429）。账号维度独立计数，正好隔离。
  const fixedIp = '192.0.2.240'; // TEST-NET-1 文档保留地址，不会命中任何真实客户端
  for (let i = 1; i <= 4; i++) {
    r = await tryLogin('fixed-wrong-' + i, 'nobody', fixedIp);
    assert(
      `固定 IP 第 ${i} 次错误：401（未达阈值，且未被信誉封禁抢先）`,
      r.status === 401,
      `status=${r.status} ${r.body && r.body.message}`
    );
  }
  r = await tryLogin('fixed-wrong-5', 'nobody', fixedIp);
  assert('固定 IP 第 5 次错误：仍 401（本次请求内才置锁）', r.status === 401, `status=${r.status}`);
  r = await tryLogin('fixed-wrong-6', 'nobody', fixedIp);
  assert(
    '固定 IP 第 6 次错误：429 锁定（这是分级风控的关键信号）',
    r.status === 429,
    `status=${r.status} ${r.body && r.body.message}`
  );
  assert('固定 IP 第 6 次错误：不是 403（未被 IP 信誉封禁抢先）', r.status !== 403, `status=${r.status}`);
  const fixedMsg = (r.body && r.body.message) || '';
  assert('固定 IP 的 429 带剩余秒数', /登录失败过多，请 [1-9]\d* 秒后再试/.test(fixedMsg), fixedMsg);
  r = await tryLogin('admin123', 'nobody', fixedIp);
  assert('固定 IP 锁定期内：正确密码也 429（不是 401，也不是 403）', r.status === 429, `status=${r.status}`);

  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });

