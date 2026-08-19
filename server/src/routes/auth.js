const express = require('express');
const bcrypt = require('bcryptjs');
const { ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { signToken, authRequired, revokeSession, revokeUserSessions, listSessions } = require('../middleware/auth');
const { cleanLine } = require('../utils/sanitize');
const { report } = require('../middleware/ipGuard');
const { generateSecret, verifyCode, otpauthUri } = require('../utils/totp');

const router = express.Router();

// 等时假比较哈希：用户不存在时也执行同成本 bcrypt，防时序侧信道枚举用户名
const FAKE_HASH = bcrypt.hashSync('timing-equalizer', 12);

// 默认初始密码（seed 数据），登录后前端提示修改
const DEFAULT_PASSWORD = 'admin123';

// TOTP 防重放表：key=userId -> 最近成功步数
const totpReplay = new Map();

/** 登录密码强度校验（弱密码直接拒绝） */
const COMMON_PASSWORDS = new Set([
  '123456', '12345678', '123456789', 'password', 'admin123', 'admin1234',
  'admin888', 'admin8888', '1234567890', 'qwerty', 'abc123', '111111',
  '123123', 'iloveyou', '654321', '666666', '888888', '000000',
  'a123456', 'aa123456', 'woaini1314', 'password1', 'passw0rd',
]);

function passwordPolicy(password, username = '') {
  // bcrypt 截断单位是字节而非字符：72 字符的多字节密码（中文/emoji）可达 216 字节
  // 被 bcrypt 截断 → 长尾不同的密码可碰撞。按 UTF-8 字节数校验（≥8B 且 ≤72B）
  if (typeof password !== 'string') return '密码长度需在 8-72 位之间';
  const pwBytes = Buffer.byteLength(password, 'utf8');
  if (pwBytes < 8 || pwBytes > 72) return '密码长度需在 8-72 位之间';
  if (/^\d+$/.test(password)) return '密码不能全是数字';
  if (/^[a-zA-Z]+$/.test(password)) return '密码不能全是字母';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return '密码过于常见，请换一个';
  if (username && password.toLowerCase().includes(String(username).toLowerCase())) return '密码不能包含用户名';
  return '';
}

// 登录事件审计（成功/失败均入库，供安全中心追溯）
async function logAuditEvent(username, action, detail, ip, fp) {
  try {
    await db('audit_logs').insert({
      user_id: 0,
      username: String(username || 'unknown').slice(0, 50),
      action: `AUTH ${action}`.slice(0, 120),
      detail: String(detail || '').slice(0, 200),
      ip: String(ip || '').slice(0, 64),
      fp: String(fp || '').slice(0, 128),
    });
  } catch (e) { /* 审计失败不影响登录流程 */ }
}

// 登录失败锁定：IP + 用户名双维度，指数退避
const loginFails = new Map(); // key -> { count, lockedUntil }
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

function lockKey(kind, value) {
  return `${kind}:${value}`;
}

/**
 * 登录风控 IP 键与 express-rate-limit 保持一致：IPv6 默认聚合到 /56，
 * 防止同一前缀轮换海量地址绕过 5 分钟锁定与信誉封禁。
 */
function loginIpKey(ip) {
  try {
    return ipKeyGenerator(String(ip || 'unknown'), 56);
  } catch (e) {
    return String(ip || 'unknown');
  }
}

/** 不存在账号的稳定锁键；已存在账号一律使用权威 user.id，服从数据库排序规则 */
function loginAccountKey(user, cleanUser) {
  if (user && user.id !== undefined && user.id !== null) return lockKey('user-id', String(user.id));
  const canonical = String(cleanUser || '').normalize('NFKC').toLocaleLowerCase('en-US');
  return lockKey('user-name', canonical);
}

function checkLock(key) {
  const rec = loginFails.get(key);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return Math.ceil((rec.lockedUntil - now) / 1000);
  }
  // 锁定已到期，或普通失败记录超时（1h 无更新）→ 顺带清理，防 Map 长期驻留
  if (rec.lockedUntil && now >= rec.lockedUntil) {
    loginFails.delete(key);
  } else if (!rec.lastAt || now - rec.lastAt > 3600e3) {
    loginFails.delete(key);
  }
  return 0;
}

function recordFail(key) {
  const rec = loginFails.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  rec.lastAt = Date.now();
  if (rec.count >= MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOCK_MS * (rec.count >= 2 * MAX_FAILS ? 2 : 1);
  }
  loginFails.set(key, rec);
  // 最终保险：Map 仍超限时全量清理已解锁条目（正常路径下 checkLock 已自愈）
  if (loginFails.size > 5000) {
    const now = Date.now();
    for (const [k, v] of loginFails) {
      const unlocked = !v.lockedUntil || v.lockedUntil < now;
      if (unlocked) loginFails.delete(k);
    }
    // 攻击者可制造大量“仍锁定”的用户名，超限时按最旧丢弃到安全水位
    while (loginFails.size > 4000) {
      const oldest = loginFails.keys().next().value;
      if (oldest === undefined) break;
      loginFails.delete(oldest);
    }
  }
}

/** 在一个无 await 的临界区内检查并预占 IP/账号尝试，堵住 bcrypt 并发 TOCTOU。 */
function reserveLoginAttempt(ipFailKey, accountFailKey) {
  const ipRemain = checkLock(ipFailKey);
  if (ipRemain) return { ok: false, scope: 'ip', remain: ipRemain };
  const accountRemain = checkLock(accountFailKey);
  if (accountRemain) return { ok: false, scope: 'account', remain: accountRemain };
  recordFail(ipFailKey);
  recordFail(accountFailKey);
  return { ok: true };
}

/**
 * 敏感认证状态必须与“撤销该用户全部会话”在同一事务内提交。
 * 当前请求已经通过 authRequired，因此正常情况下至少会撤销当前会话；
 * 若并发登出导致一条也未撤销，则回滚账号变更，避免返回失败但旧令牌仍可用。
 */
async function updateSecurityStateAndRevoke(userId, changes) {
  return await db.transaction(async (trx) => {
    await trx('users').where('id', userId).update(changes);
    const revoked = await revokeUserSessions(userId, { executor: trx });
    if (revoked < 1) {
      const err = new Error('当前会话未能撤销');
      err.code = 'SESSION_REVOKE_FAILED';
      throw err;
    }
    return revoked;
  });
}

/** 登录（暴力破解防护：IP+用户名双重锁定 + 指纹绑定） */
router.post('/login', async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    const { username, password } = req.body;
    const cleanUser = cleanLine(username, 50);

    // 设备指纹前置校验：正常浏览器由前端生成 64 位十六进制指纹，
    // 无头脚本/直连工具不带指纹 → 提前拒绝（避免无效 bcrypt 计算与审计噪声）
    const fp = String(req.headers['x-fp'] || '');
    if (!/^[a-f0-9]{64}$/i.test(fp)) {
      report(ip, 'auth', 'POST /auth/login NO-FP');
      return res.status(400).json({ code: 1, message: '设备指纹缺失，请刷新页面后重试' });
    }

    if (!cleanUser || typeof password !== 'string' || !password) {
      return fail(res, '请输入用户名和密码');
    }
    // bcrypt 截断按字节：多字节密码字符数 ≤72 但字节数可能超限 → 字节级拒绝
    if (Buffer.byteLength(password, 'utf8') > 72) return fail(res, '密码长度不正确');

    const user = await db('users').where('username', cleanUser).first();
    // 锁键必须与权威账号一致：MySQL utf8mb4_unicode_ci 下 ADMIN/ádmin 等
    // 可能命中同一行，使用原始输入作键会产生多个独立计数器。
    const ipFailKey = lockKey('ip', loginIpKey(ip));
    const accountFailKey = loginAccountKey(user, cleanUser);

    // 检查与预占在同一个同步临界区完成，随后才进入异步 bcrypt。
    const reservation = reserveLoginAttempt(ipFailKey, accountFailKey);
    if (!reservation.ok && reservation.scope === 'ip') {
      report(ip, 'auth', 'POST /auth/login');
      return res.status(429).json({ code: 1, message: `登录失败过多，请 ${reservation.remain} 秒后再试` });
    }
    if (!reservation.ok) {
      // 账号锁定返回与“凭据错误”同形，避免攻击者通过状态差异枚举有效用户名
      return res.status(401).json({ code: 1, message: '用户名或密码错误' });
    }

    // 防时序枚举：用户不存在时对固定哈希做同成本比较（响应时间一致）
    const matched = user
      ? await bcrypt.compare(password, user.password)
      : await bcrypt.compare(password, FAKE_HASH);
    if (!matched) {
      report(ip, 'auth', 'POST /auth/login');
      logAuditEvent(cleanUser, 'LOGIN_FAIL', '用户名或密码错误', ip, req.headers['x-fp']);
      const rec = loginFails.get(accountFailKey);
      const left = MAX_FAILS - (rec?.count || 0);
      return fail(res, left > 0 ? `用户名或密码错误，剩余 ${left} 次尝试` : '用户名或密码错误', 401);
    }

    // 两步验证：已启用 TOTP 的账号必须附带动态验证码
    if (user.totp_enabled) {
      const code = typeof req.body.totp_code === 'string' ? req.body.totp_code.trim() : '';
      const pass = verifyCode(user.totp_secret, code, totpReplay, `u${user.id}`);
      if (!pass) {
        report(ip, 'auth', 'POST /auth/login (2FA)');
        logAuditEvent(cleanUser, 'LOGIN_FAIL', '两步验证码错误', ip, req.headers['x-fp']);
        return fail(res, '两步验证码错误', 401);
      }
    }

    const token = await signToken(user, req);
    loginFails.delete(ipFailKey);
    loginFails.delete(accountFailKey);
    // 检测是否仍在使用默认初始密码
    let isDefaultPwd = false;
    try {
      isDefaultPwd = await bcrypt.compare(DEFAULT_PASSWORD, user.password);
    } catch (e) { /* 忽略 */ }
    logAuditEvent(cleanUser, 'LOGIN_OK', '登录成功', ip, req.headers['x-fp']);
    return ok(res, {
      token,
      is_default_pwd: isDefaultPwd,
      user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, role: user.role },
    }, '登录成功');
  } catch (e) {
    return fail(res, '登录失败', 500);
  }
});

/** 当前用户信息 */
router.get('/me', authRequired, async (req, res) => {
  try {
    const user = await db('users').where('id', req.user.sub).first();
    if (!user) return fail(res, '用户不存在', 404);
    return ok(res, { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, role: user.role });
  } catch (e) {
    return fail(res, '获取用户信息失败', 500);
  }
});

/** 我的会话列表 */
router.get('/sessions', authRequired, async (req, res) => {
  try {
    const sessions = await listSessions(req.user.sub);
    return ok(res, sessions.map((s) => ({
      ...s,
      current: s.jti === req.jti,
    })));
  } catch (e) {
    return fail(res, '获取会话列表失败', 500);
  }
});

/** 撤销指定会话（登出其他设备） */
router.delete('/sessions/:jti', authRequired, async (req, res) => {
  try {
    const target = req.params.jti;
    if (target === req.jti) return fail(res, '不能撤销当前会话，请使用退出登录', 400);
    const revoked = await revokeSession(target, req.user.sub);
    if (!revoked) return fail(res, '会话不存在或已撤销', 404);
    return ok(res, null, '会话已撤销');
  } catch (e) {
    return fail(res, '撤销会话失败', 500);
  }
});

/** 退出登录：撤销当前会话 */
router.post('/logout', authRequired, async (req, res) => {
  try {
    const revoked = await revokeSession(req.jti, req.user.sub);
    if (!revoked) return fail(res, '当前会话已失效，请重新登录', 409);
    return ok(res, null, '已退出登录');
  } catch (e) {
    return fail(res, '退出失败', 500);
  }
});

/** 退出所有设备：撤销除当前外的全部会话 */
router.post('/logout-all', authRequired, async (req, res) => {
  try {
    const revoked = await revokeUserSessions(req.user.sub, { exceptJti: req.jti });
    logAuditEvent(req.user.username, 'LOGOUT_ALL', `已撤销 ${revoked} 个其他会话`, req.ip, req.headers['x-fp']);
    return ok(res, { revoked }, '已退出其他设备');
  } catch (e) {
    return fail(res, '操作失败', 500);
  }
});

/** 修改密码（修改后撤销全部会话，强制重新登录） */
router.put('/password', authRequired, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return fail(res, '请输入旧密码和新密码');
    }
    const user = await db('users').where('id', req.user.sub).first();
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return fail(res, '旧密码错误', 400);
    const policyMsg = passwordPolicy(newPassword, user.username);
    if (policyMsg) return fail(res, policyMsg, 400);
    const hash = await bcrypt.hash(newPassword, 12);
    await updateSecurityStateAndRevoke(user.id, { password: hash });
    logAuditEvent(user.username, 'CHANGE_PASSWORD', '修改密码', req.ip, req.headers['x-fp']);
    return ok(res, { relogin_required: true }, '密码修改成功，请重新登录');
  } catch (e) {
    return fail(res, '修改密码失败', 500);
  }
});

// ============ 两步验证（TOTP 2FA） ============

/** 我的两步验证状态 */
router.get('/2fa/status', authRequired, async (req, res) => {
  try {
    const user = await db('users').where('id', req.user.sub).select('totp_enabled').first();
    return ok(res, { enabled: !!(user && user.totp_enabled) });
  } catch (e) {
    return fail(res, '获取状态失败', 500);
  }
});

/** 生成新密钥（启用前的第一步；每次调用都会轮换旧密钥） */
router.post('/2fa/setup', authRequired, async (req, res) => {
  try {
    const user = await db('users').where('id', req.user.sub).first();
    // 首次启用或重新生成都必须验证当前密码：防仅持会话者替账号绑定自己控制的 TOTP
    const password = String(req.body.password || '');
    const passwordOk = user && (await bcrypt.compare(password, user.password));
    if (!passwordOk) return fail(res, '当前密码错误', 400);
    // 已启用时禁止直接轮换：先 disable（会撤销全部会话）再重新登录 setup，
    // 避免在一个仍有效的会话中悄悄替换第二因素。
    if (user && user.totp_enabled) {
      return fail(res, '请先关闭两步验证，再重新设置', 409);
    }
    const secret = generateSecret(32);
    // setup 只写入待验证密钥，尚未改变启用状态，因此保留当前会话，
    // 让客户端能紧接着调用 verify；verify 成功后才事务化撤销全部会话。
    await db('users').where('id', req.user.sub).update({ totp_secret: secret, totp_enabled: false });
    logAuditEvent(req.user.username, '2FA_SETUP', '生成两步验证密钥', req.ip, req.headers['x-fp']);
    return ok(res, {
      secret,
      uri: otpauthUri(secret, String(req.user.username || 'admin')),
    }, '请使用身份验证器应用扫码');
  } catch (e) {
    return fail(res, '生成密钥失败', 500);
  }
});

/** 验证验证码并启用两步验证 */
router.post('/2fa/verify', authRequired, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return fail(res, '请输入 6 位验证码');
    const user = await db('users').where('id', req.user.sub).first();
    if (!user.totp_secret) return fail(res, '请先生成密钥', 400);
    if (!verifyCode(user.totp_secret, code, totpReplay, `u${user.id}`)) {
      report(req.ip, 'auth', 'POST /auth/2fa/verify');
      return fail(res, '验证码错误', 400);
    }
    await updateSecurityStateAndRevoke(user.id, { totp_enabled: true });
    logAuditEvent(req.user.username, '2FA_ENABLE', '启用两步验证', req.ip, req.headers['x-fp']);
    return ok(res, { relogin_required: true }, '两步验证已启用，请重新登录');
  } catch (e) {
    return fail(res, '启用失败', 500);
  }
});

/** 关闭两步验证（需提供当前动态验证码） */
router.post('/2fa/disable', authRequired, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return fail(res, '请输入 6 位验证码');
    const user = await db('users').where('id', req.user.sub).first();
    if (!user.totp_enabled) return fail(res, '两步验证未启用', 400);
    if (!verifyCode(user.totp_secret, code, totpReplay, `u${user.id}`)) {
      report(req.ip, 'auth', 'POST /auth/2fa/disable');
      return fail(res, '验证码错误', 400);
    }
    await updateSecurityStateAndRevoke(user.id, { totp_secret: null, totp_enabled: false });
    logAuditEvent(req.user.username, '2FA_DISABLE', '关闭两步验证', req.ip, req.headers['x-fp']);
    return ok(res, { relogin_required: true }, '两步验证已关闭，请重新登录');
  } catch (e) {
    return fail(res, '关闭失败', 500);
  }
});

// 小范围白盒测试钩子：验证锁键规范化与同步预占，不暴露为 HTTP API。
router.securityTest = {
  loginIpKey,
  loginAccountKey,
  reserveLoginAttempt,
  resetLoginFails: () => loginFails.clear(),
};

module.exports = router;
