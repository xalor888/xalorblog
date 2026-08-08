/**
 * 反爬签名令牌（Form Token）v2
 * 1. 前端加载表单时调用 /api/anti/seed 获取签名令牌
 * 2. 令牌 = HMAC(secret, ip + fp + ua + ts + nonce + path)
 *    —— 绑定设备指纹与 UA，令牌脱离浏览器上下文即失效
 * 3. 校验：
 *    - 签名正确（constant-time，防伪造）
 *    - IP / 指纹 / UA / 路径全匹配（防盗用）
 *    - 新鲜度：10 分钟过期
 *    - 最小间隔：2 秒内提交判定为机器人（人类填表不可能这么快）
 *    - 单次使用（nonce 一次性消费，到期自动清理）
 * 4. 随机蜜罐字段：字段名每次动态派生，爬虫无法预知
 */

const crypto = require('crypto');
const config = require('../config');

const SECRET = config.jwt.secret + ':anti-token-v2';
const TOKEN_TTL = 10 * 60 * 1000;
const MIN_INTERVAL = 2000;
const USED = new Map(); // nonce -> expiresAt
const USED_MAX = 3000;

function sign(str) {
  return crypto.createHmac('sha256', SECRET).update(str).digest('hex').slice(0, 32);
}

function normUa(ua) {
  return String(ua || '').slice(0, 120);
}

/** 签发令牌 ts.nonce.sig（绑定 ip/fp/ua/路径） */
function issueToken(req, path = '') {
  const ip = req.ip || 'unknown';
  const fp = String(req.headers['x-fp'] || '').slice(0, 128);
  const ua = normUa(req.headers['user-agent']);
  const ts = Date.now();
  const nonce = crypto.randomBytes(6).toString('hex');
  const sig = sign([ip, fp, ua, path, ts, nonce].join('|'));
  return `${ts}.${nonce}.${sig}`;
}

/** 验证令牌 */
function verifyToken(req, token, path = '') {
  if (typeof token !== 'string') return { ok: false, reason: '缺少安全令牌' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: '安全令牌无效' };
  const [tsStr, nonce, sig] = parts;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return { ok: false, reason: '安全令牌无效' };

  const ip = req.ip || 'unknown';
  const fp = String(req.headers['x-fp'] || '').slice(0, 128);
  const ua = normUa(req.headers['user-agent']);
  const expect = sign([ip, fp, ua, path, ts, nonce].join('|'));
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: '安全令牌校验失败' };
  }

  const now = Date.now();
  if (now - ts > TOKEN_TTL) return { ok: false, reason: '安全令牌已过期，请刷新页面' };
  if (now - ts < MIN_INTERVAL) return { ok: false, reason: '提交过快，疑似机器人' };

  const exp = USED.get(nonce);
  if (exp) {
    if (exp > now) return { ok: false, reason: '安全令牌已被使用' };
    USED.delete(nonce);
  }
  USED.set(nonce, now + TOKEN_TTL);
  if (USED.size > USED_MAX) {
    const n = Date.now();
    for (const [k, e] of USED) {
      if (e < n) USED.delete(k);
    }
  }
  return { ok: true };
}

/** 随机蜜罐字段名（基于指纹+路径+时间窗口派生，爬虫无法预知） */
const HONEYPOT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function honeypotFieldName(req, path = '') {
  const seed = String(req.headers['x-fp'] || req.ip || 'unknown');
  const digest = crypto
    .createHmac('sha256', SECRET + ':hp')
    .update(`${seed}|${path}|${Date.now().toString().slice(0, 8)}`)
    .digest('hex');
  let name = 'hp_';
  for (let i = 0; i < 8; i++) {
    name += HONEYPOT_ALPHABET[parseInt(digest.substr(i * 2, 2), 16) % HONEYPOT_ALPHABET.length];
  }
  return name;
}

/** 表单令牌中间件（绑定当前请求路径 + 随机蜜罐字段校验） */
function formTokenRequired(req, res, next) {
  const token = req.body?.form_token;
  // 归一化目标路径：baseUrl(挂载前缀) + path，去掉 /api 前缀与尾部斜杠
  // 与 seed 签发的 for 参数保持一致
  const forPath = (req.baseUrl + req.path)
    .replace(config.apiPrefix, '')
    .replace(/\/+$/, '');
  const result = verifyToken(req, token, forPath);
  if (!result.ok) {
    return res.status(403).json({ code: 1, message: result.reason || '提交被拒绝' });
  }
  // 随机蜜罐字段校验：真实用户看不到该字段（前端动态渲染时填充空值）
  const hpField = req.headers['x-hp-field'] || '';
  if (hpField && req.body && req.body[hpField]) {
    return res.status(403).json({ code: 1, message: '提交被拒绝' });
  }
  next();
}

module.exports = { issueToken, verifyToken, formTokenRequired, honeypotFieldName };
