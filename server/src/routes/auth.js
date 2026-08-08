const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { signToken, authRequired, revokeSession, listSessions } = require('../middleware/auth');
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
  }
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

    const ipRemain = checkLock(lockKey('ip', ip));
    if (ipRemain) {
      report(ip, 'auth', 'POST /auth/login');
      return res.status(429).json({ code: 1, message: `登录失败过多，请 ${ipRemain} 秒后再试` });
    }
    if (cleanUser) {
      const userRemain = checkLock(lockKey('user', cleanUser));
      if (userRemain) {
        return res.status(429).json({ code: 1, message: `登录失败过多，请 ${userRemain} 秒后再试` });
      }
    }

    if (!cleanUser || typeof password !== 'string' || !password) {
      return fail(res, '请输入用户名和密码');
    }
    // bcrypt 截断按字节：多字节密码字符数 ≤72 但字节数可能超限 → 字节级拒绝
    if (Buffer.byteLength(password, 'utf8') > 72) return fail(res, '密码长度不正确');

    const user = await db('users').where('username', cleanUser).first();
    // 防时序枚举：用户不存在时对固定哈希做同成本比较（响应时间一致）
    const matched = user
      ? await bcrypt.compare(password, user.password)
      : await bcrypt.compare(password, FAKE_HASH);
    if (!matched) {
      recordFail(lockKey('ip', ip));
      if (cleanUser) recordFail(lockKey('user', cleanUser));
      report(ip, 'auth', 'POST /auth/login');
      logAuditEvent(cleanUser, 'LOGIN_FAIL', '用户名或密码错误', ip, req.headers['x-fp']);
      const rec = loginFails.get(lockKey('ip', ip));
      const left = MAX_FAILS - (rec?.count || 0);
      return fail(res, left > 0 ? `用户名或密码错误，剩余 ${left} 次尝试` : '用户名或密码错误', 401);
    }

    // 两步验证：已启用 TOTP 的账号必须附带动态验证码
    if (user.totp_enabled) {
      const code = typeof req.body.totp_code === 'string' ? req.body.totp_code.trim() : '';
      const pass = verifyCode(user.totp_secret, code, totpReplay, `u${user.id}`);
      if (!pass) {
        recordFail(lockKey('ip', ip));
        if (cleanUser) recordFail(lockKey('user', cleanUser));
        report(ip, 'auth', 'POST /auth/login (2FA)');
        logAuditEvent(cleanUser, 'LOGIN_FAIL', '两步验证码错误', ip, req.headers['x-fp']);
        return fail(res, '两步验证码错误', 401);
      }
    }

    loginFails.delete(lockKey('ip', ip));
    if (cleanUser) loginFails.delete(lockKey('user', cleanUser));

    const token = await signToken(user, req);
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
    await revokeSession(target);
    return ok(res, null, '会话已撤销');
  } catch (e) {
    return fail(res, '撤销会话失败', 500);
  }
});

/** 退出登录：撤销当前会话 */
router.post('/logout', authRequired, async (req, res) => {
  try {
    await revokeSession(req.jti);
    return ok(res, null, '已退出登录');
  } catch (e) {
    return fail(res, '退出失败', 500);
  }
});

/** 退出所有设备：撤销除当前外的全部会话 */
router.post('/logout-all', authRequired, async (req, res) => {
  try {
    const sessions = await listSessions(req.user.sub);
    for (const s of sessions) {
      if (s.jti !== req.jti) await revokeSession(s.jti);
    }
    logAuditEvent(req.user.username, 'LOGOUT_ALL', `已撤销 ${sessions.length - 1} 个其他会话`, req.ip, req.headers['x-fp']);
    return ok(res, null, '已退出其他设备');
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
    await db('users').where('id', user.id).update({ password: hash });
    // 撤销其他会话，仅保留当前
    try {
      const sessions = await listSessions(user.id);
      for (const s of sessions) {
        if (s.jti !== req.jti) await revokeSession(s.jti);
      }
    } catch (e) { /* 忽略 */ }
    logAuditEvent(user.username, 'CHANGE_PASSWORD', '修改密码', req.ip, req.headers['x-fp']);
    return ok(res, null, '密码修改成功');
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
    const secret = generateSecret(32);
    await db('users').where('id', req.user.sub).update({ totp_secret: secret, totp_enabled: false });
    logAuditEvent(req.user.username, '2FA_SETUP', '生成两步验证密钥', req.ip, req.headers['x-fp']);
    // 2FA 状态变更：撤销其他全部会话，强制重新登录（防攻击者已持会话时被静默旁路）
    const sessions = await listSessions(req.user.sub);
    for (const s of sessions) if (s.jti !== req.jti) await revokeSession(s.jti);
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
    await db('users').where('id', user.id).update({ totp_enabled: true });
    logAuditEvent(req.user.username, '2FA_ENABLE', '启用两步验证', req.ip, req.headers['x-fp']);
    // 2FA 状态变更：撤销其他全部会话，强制重新登录
    const sessions = await listSessions(user.id);
    for (const s of sessions) if (s.jti !== req.jti) await revokeSession(s.jti);
    return ok(res, null, '两步验证已启用');
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
    await db('users').where('id', user.id).update({ totp_secret: null, totp_enabled: false });
    logAuditEvent(req.user.username, '2FA_DISABLE', '关闭两步验证', req.ip, req.headers['x-fp']);
    // 2FA 状态变更：撤销其他全部会话，强制重新登录
    const sessions = await listSessions(user.id);
    for (const s of sessions) if (s.jti !== req.jti) await revokeSession(s.jti);
    return ok(res, null, '两步验证已关闭');
  } catch (e) {
    return fail(res, '关闭失败', 500);
  }
});

module.exports = router;
