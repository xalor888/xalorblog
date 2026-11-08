/**
 * 登录锁定的**分级策略**单元测试（不启服务、不连库）。
 *
 * 为什么需要这一层：`lockout.test.js` 是集成套件（要 3000 端口 + 数据库），
 * 而「第 4 次错误就被信誉封禁抢先成 403」这个缺陷之所以长期没被发现，
 * 正是因为离线套件里没有一条断言盯着「锁定 → 封禁」的**顺序**。
 *
 * 这里直接驱动 `routes/auth.js` 暴露的 `securityTest` 钩子（它导出的就是生产用的
 * reserveLoginAttempt / recordFail 链路），断言三件事：
 *   1. 第 1-4 次尝试只是普通失败，不触发信誉计分（ipReachedLock=false）；
 *   2. 第 5 次才跨过阈值（true）；
 *   3. 第 6 次进入 IP 锁定（ok=false + scope='ip' + 剩余秒数），而不是被封禁。
 * 若有人把「每次失败都 report」改回来，第 1 条会立刻红 —— 这是本文件存在的全部理由。
 */

// config.js 在 require 期就校验 DB_PASSWORD；本套件不连库，给一个合规占位值。
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { securityTest } = require('../src/routes/auth');

const { reserveLoginAttempt, loginIpKey, loginAccountKey, resetLoginFails } = securityTest;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const IP = '203.0.113.9'; // TEST-NET-3 文档保留地址
const ipKey = loginIpKey(IP);
const accountKey = loginAccountKey(null, 'nobody');

console.log('=== A. 第 1-4 次：普通失败，不计信誉 ===');
resetLoginFails();
for (let i = 1; i <= 4; i++) {
  const r = reserveLoginAttempt(ipKey, accountKey);
  ok(`第 ${i} 次：允许尝试（ok=true）`, r.ok === true, JSON.stringify(r));
  ok(`第 ${i} 次：未跨过锁定阈值（因此不会 report 信誉分）`, r.ipReachedLock === false, `ipReachedLock=${r.ipReachedLock}`);
}

console.log('\n=== B. 第 5 次：跨阈值（本次仍是 401，下个请求才锁定）===');
const fifth = reserveLoginAttempt(ipKey, accountKey);
ok('第 5 次：仍允许走到密码校验（ok=true）', fifth.ok === true, JSON.stringify(fifth));
ok('第 5 次：ipReachedLock=true（这是唯一该记分的时刻）', fifth.ipReachedLock === true, `ipReachedLock=${fifth.ipReachedLock}`);

console.log('\n=== C. 第 6 次：IP 锁定（429 语义），不是封禁（403 语义）===');
const sixth = reserveLoginAttempt(ipKey, accountKey);
ok('第 6 次：被拒绝（ok=false）', sixth.ok === false, JSON.stringify(sixth));
ok('第 6 次：拒绝原因是 IP 维度锁定（scope=ip）', sixth.scope === 'ip', `scope=${sixth.scope}`);
ok('第 6 次：带剩余秒数（调用方据此拼「请 N 秒后再试」）', Number(sixth.remain) > 0 && Number(sixth.remain) <= 300, `remain=${sixth.remain}`);

console.log('\n=== D. 不同账号共享同一个 IP 锁键（家庭/办公出口的真实形态）===');
resetLoginFails();
let reached = 0;
for (let i = 1; i <= 5; i++) {
  // 每次换一个账号：账号维度各自计数，IP 维度累加
  const r = reserveLoginAttempt(ipKey, loginAccountKey(null, `user${i}`));
  if (r.ipReachedLock) reached += 1;
}
ok('5 个不同账号各错 1 次 → IP 维度恰好跨阈值 1 次', reached === 1, `reached=${reached}`);
const afterMulti = reserveLoginAttempt(ipKey, loginAccountKey(null, 'user6'));
ok('第 6 个账号：IP 已锁定（锁键与账号无关）', afterMulti.ok === false && afterMulti.scope === 'ip', JSON.stringify(afterMulti));

console.log('\n=== E. 阈值周期：第 10 次再跨一次（用于封禁升级，不是每次失败都记）===');
resetLoginFails();
const flags = [];
// 第 6-10 次必须在锁定过期后才会走到这里；测试里直接清空锁表模拟「5 分钟后再犯」
for (let i = 1; i <= 5; i++) flags.push(reserveLoginAttempt(ipKey, accountKey).ipReachedLock);
resetLoginFails();
for (let i = 1; i <= 5; i++) flags.push(reserveLoginAttempt(ipKey, accountKey).ipReachedLock);
ok(
  '阈值每 5 次触发一次：两个周期各恰好 1 次、其余为 false',
  flags.filter(Boolean).length === 2 && flags[4] === true && flags[9] === true,
  JSON.stringify(flags)
);

resetLoginFails();
console.log(`\nloginLockPolicy 套件结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
