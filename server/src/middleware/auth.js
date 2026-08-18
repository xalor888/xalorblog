/**
 * JWT 认证 v2（企业级会话安全）
 * - 标准 claims：jti / iss / aud / iat / nbf / exp
 * - 设备指纹绑定：令牌签发时的指纹必须与每次请求一致
 * - 服务端会话表：可撤销、可枚举、防重放
 * - 登录后写入 sessions 表（jti 即会话 ID）
 */

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

const ISSUER = 'xalor-blog';
const AUDIENCE = 'xalor-web';

/**
 * 检查 sessions 表是否可用
 * @returns {Promise<boolean>} true=可用（须执行会话校验） false=表不存在（初始状态，纯 JWT 降级）
 * @throws 非预期查询异常（连接中断等）由调用方按 fail-closed 处理 —— 会话撤销能力不可静默失效
 */
async function sessionTableReady() {
  return await db.schema.hasTable('sessions');
}

/** 生成 JWT（含会话记录） */
async function signToken(user, req) {
  const jti = require('crypto').randomBytes(12).toString('hex');
  const fp = String(req.headers['x-fp'] || '').slice(0, 128);
  const expiresIn = config.jwt.expiresIn;
  const token = jwt.sign(
    {
      sub: String(user.id),
      jti,
      iss: ISSUER,
      aud: AUDIENCE,
      fp,
      username: user.username,
      role: user.role,
      nickname: user.nickname,
      // nbf 略早于 iat，避免时钟偏差导致拒登
      nbf: Math.floor(Date.now() / 1000) - 5,
    },
    config.jwt.secret,
    { expiresIn }
  );

  // 写会话表（表缺失时跳过，不影响登录）
  try {
    const decoded = jwt.decode(token);
    const expMs = decoded && decoded.exp ? decoded.exp * 1000 : Date.now() + 7200e3;
    await db('sessions').insert({
      jti,
      user_id: user.id,
      fp,
      ip: req.ip || '',
      ua: String(req.headers['user-agent'] || '').slice(0, 255),
      expires_at: new Date(expMs),
    }).catch(() => {});
    // 会话上限：每用户最多保留 20 个活跃会话，超出撤销最旧的
    // （防会话表无限膨胀；同时清理已过期会话）
    const now = db.fn.now();
    await db('sessions')
      .where('user_id', user.id)
      .where((q) => q.where('revoked', true).orWhere('expires_at', '<', now))
      .del()
      .catch(() => {});
    const activeCount = await db('sessions').where('user_id', user.id).where('revoked', false).count('* as cnt').first().catch(() => null);
    if (activeCount && Number(activeCount.cnt) > 20) {
      const overflow = await db('sessions')
        .where('user_id', user.id)
        .where('revoked', false)
        .orderBy('created_at', 'asc')
        .limit(Number(activeCount.cnt) - 20)
        .pluck('jti')
        .catch(() => []);
      if (overflow.length) {
        await db('sessions').whereIn('jti', overflow).update({ revoked: true }).catch(() => {});
      }
    }
  } catch (e) { /* 表缺失静默降级 */ }

  return token;
}

/** 认证中间件：JWT + 指纹 + 服务端会话三重校验 */
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ code: 1, message: '未登录，请先登录' });
  }
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, { issuer: ISSUER, audience: AUDIENCE });
  } catch (e) {
    return res.status(401).json({ code: 1, message: '登录已过期，请重新登录' });
  }

  // 设备指纹一致性校验：令牌签发指纹必须与当前请求一致
  // 注意：不能「双方都为空才放行」—— 攻击者去掉 X-Fp 头即可绕过；
  // 必须要求请求方提供与签发时一致的指纹
  const curFp = String(req.headers['x-fp'] || '').slice(0, 128);
  if (!curFp || (payload.fp && payload.fp !== curFp)) {
    return res.status(401).json({ code: 1, message: '登录设备发生变化，请重新登录' });
  }

  // 服务端会话校验：已撤销/过期即拒绝
  // 安全原则：校验异常一律 fail-closed（拒绝请求），仅「表不存在」的初始状态允许纯 JWT 降级
  let sessionTableOk = false;
  try {
    sessionTableOk = await sessionTableReady();
  } catch (e) {
    console.error('[auth] 会话表检查异常，拒绝请求（fail-closed）：', e && e.message);
    return res.status(401).json({ code: 1, message: '会话校验失败，请重新登录' });
  }
  if (sessionTableOk) {
    try {
      const session = await db('sessions').where('jti', payload.jti).first();
      if (!session) return res.status(401).json({ code: 1, message: '会话不存在，请重新登录' });
      if (session.revoked) return res.status(401).json({ code: 1, message: '会话已注销，请重新登录' });
      if (Number(session.user_id) !== Number(payload.sub)) {
        return res.status(401).json({ code: 1, message: '会话校验失败，请重新登录' });
      }
      if (new Date(session.expires_at).getTime() < Date.now()) {
        return res.status(401).json({ code: 1, message: '会话已过期，请重新登录' });
      }
    } catch (e) {
      console.error('[auth] 会话查询异常，拒绝请求（fail-closed）：', e && e.message);
      return res.status(401).json({ code: 1, message: '会话校验失败，请重新登录' });
    }
  }

  // 角色等账号信息以数据库为准：防止 JWT 中的旧 role 在降权后继续生效
  let userRow;
  try {
    userRow = await db('users').where('id', payload.sub).select('id', 'username', 'nickname', 'role').first();
  } catch (e) {
    console.error('[auth] 用户信息查询异常，拒绝请求（fail-closed）：', e && e.message);
    return res.status(401).json({ code: 1, message: '会话校验失败，请重新登录' });
  }
  if (!userRow) return res.status(401).json({ code: 1, message: '用户不存在，请重新登录' });

  req.user = {
    ...payload,
    role: userRow.role,
    username: userRow.username,
    nickname: userRow.nickname,
  };
  req.jti = payload.jti;
  req.authed = true;
  next();
}

/** 撤销指定会话 */
async function revokeSession(jti, userId = null) {
  let ok = false;
  try {
    ok = await sessionTableReady();
  } catch (e) { return false; }
  if (!ok) return false;
  try {
    let query = db('sessions').where('jti', jti);
    if (userId !== null && userId !== undefined) {
      query = query.where('user_id', userId);
    }
    await query.update({ revoked: true });
    return true;
  } catch (e) {
    return false;
  }
}

/** 列出用户全部会话 */
async function listSessions(userId) {
  let ok = false;
  try {
    ok = await sessionTableReady();
  } catch (e) { return []; }
  if (!ok) return [];
  try {
    return await db('sessions')
      .where('user_id', userId)
      .orderBy('created_at', 'desc')
      .select('jti', 'fp', 'ip', 'ua', 'revoked', 'expires_at', 'created_at');
  } catch (e) {
    return [];
  }
}

module.exports = { signToken, authRequired, revokeSession, listSessions };
