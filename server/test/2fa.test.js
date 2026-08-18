/**
 * 两步验证（TOTP 2FA）端到端测试
 * 流程：登录 → 生成密钥 → 错误验证码被拒 → 正确验证码启用 →
 *       启用后登录需验证码（缺失/错误被拒，正确通过）→ 同码重放被拒 →
 *       等待跨步后关闭 2FA（恢复初始状态）
 * 注意：TOTP 防重放表记录最近成功步，连续用例必须使用不同步数的验证码
 * 前置：干净 IP + admin/admin123
 */
const c = require('./client');
const { generateSecret, verifyCode, currentStep } = require('../src/utils/totp');
// totp.js 仅导出 generateSecret/verifyCode/otpauthUri/currentStep；
// base32 解码与 HOTP 计算在此内联实现（RFC 4648 / RFC 4226，与 totp.js 算法一致）
function base32Decode(input) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secretBuffer, counter) {
  const crypto = require('crypto');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuffer).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

/** 计算指定偏移步的验证码（offset=0 当前步，-1 前一步，+1 下一步） */
function totpAt(secret, offset = 0) {
  return hotp(base32Decode(secret), currentStep() + offset);
}

/** 等待 31~61 秒（跨过 ≥1 个 TOTP 步长），返回新步的验证码 */
async function waitForNewStep(secret) {
  const remain = 30000 - (Date.now() % 30000) + 31000;
  await new Promise((r) => setTimeout(r, remain));
  return totpAt(secret, 1); // 新步 +1 容差覆盖
}

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function suite() {
  console.log('\n=== 1. 登录并获取会话 ===');
  const ticket = await c.getTicket();
  const fp = 'a'.repeat(64);
  const loginHdr = { 'X-Fp': fp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
  let r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, ticket, headers: loginHdr });
  assert('管理员登录', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  const token = r.body.data.token;
  const path = (await c.req('GET', '/api/anti/admin-path', { ticket, silent: true })).body.data.path;
  const authHeaders = { Authorization: 'Bearer ' + token, 'X-Fp': fp };

  console.log('\n=== 2. 生成 TOTP 密钥 ===');
  r = await c.req('POST', '/api/auth/2fa/setup', { body: {}, ticket, headers: authHeaders });
  assert('无当前密码生成密钥被拒', r.status === 400, `status=${r.status} ${r.body && r.body.message}`);
  r = await c.req('POST', '/api/auth/2fa/setup', { body: { password: 'admin123' }, ticket, headers: authHeaders });
  assert('生成密钥', r.status === 200 && /^[A-Z2-7]{32}$/.test(r.body.data.secret), `status=${r.status} ${r.body && r.body.message}`);
  const secret = r.body.data.secret;

  console.log('\n=== 3. 错误验证码被拒 ===');
  r = await c.req('POST', '/api/auth/2fa/verify', { body: { code: '000000' }, ticket, headers: authHeaders });
  assert('错误验证码被拒', r.status === 400, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 4. 正确验证码启用 2FA（消费当前步 S） ===');
  r = await c.req('POST', '/api/auth/2fa/verify', { body: { code: totpAt(secret) }, ticket, headers: authHeaders });
  assert('正确验证码启用成功', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 4b. 已启用后 setup 必须提供当前动态码 ===');
  r = await c.req('POST', '/api/auth/2fa/setup', { body: { password: 'admin123' }, ticket, headers: authHeaders });
  assert('无动态码重新生成密钥被拒', r.status === 400, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 5. 启用后登录需验证码 ===');
  // 无验证码登录被拒（计入一次认证失败积分）
  r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, ticket, headers: loginHdr });
  assert('无验证码登录被拒', r.status === 401, `status=${r.status} ${r.body && r.body.message}`);
  // 正确验证码（下一步 S+1，避开 S 的重放记录）登录成功
  const okCode = totpAt(secret, 1);
  r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123', totp_code: okCode }, ticket, headers: loginHdr });
  assert('正确验证码登录成功', r.status === 200 && r.body.data.token, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 6. 验证码防重放（同一步码二次使用被拒） ===');
  r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123', totp_code: okCode }, ticket, headers: loginHdr });
  assert('TOTP 重放被拒', r.status === 401, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 7. 关闭 2FA（等待跨步避开重放记录） ===');
  const closeCode = await waitForNewStep(secret);
  r = await c.req('POST', '/api/auth/2fa/disable', { body: { code: closeCode }, ticket, headers: authHeaders });
  assert('正确验证码关闭 2FA', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 8. 关闭后免验证码登录 ===');
  r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, ticket, headers: loginHdr });
  assert('关闭后免验证码登录', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
