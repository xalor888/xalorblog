const express = require('express');
const { ok, fail } = require('../utils/response');
const { issuePuzzle, verifyPow, issueTicket, renewTicket, verifyTicket, isValidFp } = require('../middleware/gate');
const { issueToken, honeypotFieldName } = require('../middleware/formToken');
const rateLimit = require('express-rate-limit');
const config = require('../config');

const router = express.Router();

// 挑战签发限流：每 IP 每 15 秒 10 次（正常用户每次取票只需 1 次挑战；多标签页同时唤醒也富余）
const puzzleLimiter = rateLimit({
  windowMs: 15 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '操作过于频繁，请稍后再试' },
});

// 票据签发/续期/后台路径限流：每 IP 每分钟 20 次。
// 真正想防的是「批量取票抓站」，而不是正常浏览——正常一次完整加载只消耗 1 张票据。
const issueLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '操作过于频繁，请稍后再试' },
});

// 表单令牌（seed）单独限流：每 IP 每分钟 60 次。
// 它曾是 ticketLimiter 的一部分（4 接口共用 10 次/分钟）——而前端每次加载就要
// 给 评论/留言/友链 各发 1 个 seed，唤醒/多标签页/连续刷新时轻易打爆共享额度，
// 把正常访客误伤成「操作过于频繁」。表单令牌对内容抓取没有价值，可以给得宽松。
const seedLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '操作过于频繁，请稍后再试' },
});

/** 获取 PoW 挑战（前端需完成工作量证明后换取票据） */
router.get('/puzzle', puzzleLimiter, (req, res) => {
  try {
    const puzzle = issuePuzzle(req);
    return ok(res, puzzle, 'ok');
  } catch (e) {
    return fail(res, '挑战签发失败', 500);
  }
});

/** 提交 PoW 求解结果，换取通行证票据 */
router.post('/ticket', issueLimiter, (req, res) => {
  try {
    const fp = String(req.headers['x-fp'] || '').slice(0, 128);
    // 指纹格式强制：必须是十六进制哈希（脚本直接构造任意字符串的伪造成本提高）
    if (!isValidFp(fp)) {
      return fail(res, '设备指纹无效', 403);
    }
    const result = verifyPow(req, req.body);
    if (!result.ok) return fail(res, result.reason, 403);
    const issued = issueTicket(req.ip || 'unknown', fp, String(req.headers['user-agent'] || '').slice(0, 120), 0, true);
    return ok(res, {
      token: issued.token,
      ttl: 600000,
      renew_at: 480000,
      enc_salt: config.security.encSalt,
    }, 'ok');
  } catch (e) {
    return fail(res, '票据签发失败', 500);
  }
});

/** 滑动续期：旧票据有效期内免 PoW 续签 */
router.post('/renew', issueLimiter, (req, res) => {
  try {
    const fp = String(req.headers['x-fp'] || '').slice(0, 128);
    if (!isValidFp(fp)) {
      return fail(res, '设备指纹无效', 403);
    }
    const result = renewTicket(req);
    if (!result.ok) return fail(res, result.reason, 403);
    return ok(res, { token: result.token, ttl: 600000, enc_salt: config.security.encSalt }, 'ok');
  } catch (e) {
    return fail(res, '续期失败', 500);
  }
});

/** 表单安全令牌（绑定指纹/UA/目标接口路径 + 随机蜜罐字段名） */
router.get('/seed', seedLimiter, (req, res) => {
  try {
    const forPath = String(req.query.for || '').replace(/\s/g, '').slice(0, 60);
    const token = issueToken(req, forPath);
    return ok(res, {
      token,
      min_interval: 2000,
      ttl: 600000,
      hp_field: honeypotFieldName(req, forPath),
    }, 'ok');
  } catch (e) {
    return fail(res, '令牌签发失败', 500);
  }
});

/** 管理后台秘钥路径（由 JWT_SECRET 派生的随机段，每个实例不同）
 *  要求持有有效通行证票据 —— 未完成 PoW 的脚本/爬虫拿不到后台地址 */
router.get('/admin-path', issueLimiter, (req, res) => {
  if (!verifyTicket(req).ok) {
    return fail(res, '访问被拒绝', 403);
  }
  return ok(res, { path: config.adminPath }, 'ok');
});

module.exports = router;
