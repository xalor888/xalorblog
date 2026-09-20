const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { cleanText, cleanLine, safeUrl, safeCover, safeEmail } = require('../utils/sanitize');
const { honeypotCheck } = require('../middleware/antiBot');
const { formTokenRequired } = require('../middleware/formToken');

const router = express.Router();

// 友链申请限流：每 IP 每分钟 5 次（防高频脚本提交）
const linkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '申请太频繁了，请稍后再试' },
});

/** 已通过的友链（公开） */
router.get('/', async (req, res) => {
  try {
    const rows = await db('links')
      .where('status', 'approved')
      .orderBy([{ column: 'sort', order: 'desc' }, { column: 'id', order: 'asc' }])
      .select('id', 'name', 'url', 'avatar', 'description', 'sort');
    return ok(res, rows);
  } catch (e) {
    return fail(res, '获取友链失败', 500);
  }
});

/** 申请友链（限流 + honeypot + 签名令牌防机器人） */
router.post('/', linkLimiter, honeypotCheck, formTokenRequired, async (req, res) => {
  try {
    const { name, url, avatar = '', description = '', email = '' } = req.body;
    const cleanName = cleanLine(name, 80);
    const cleanUrl = safeUrl(url, 300);
    const cleanAvatar = safeCover(avatar);
    const cleanDesc = cleanText(description, 200);
    const cleanEmail = safeEmail(email, 100);
    if (!cleanName) return fail(res, '名称不能为空');
    if (!cleanUrl) return fail(res, '请填写合法的网址');

    // 防重复申请（同 URL 待审核或已存在）
    const existing = await db('links').where('url', cleanUrl).first('id', 'status');
    if (existing) {
      if (existing.status === 'pending') return fail(res, '该网址的友链申请正在审核中，请勿重复提交', 400);
      if (existing.status === 'approved') return fail(res, '该友链已收录，无需重复申请', 400);
    }

    await db('links').insert({
      name: cleanName,
      url: cleanUrl,
      avatar: cleanAvatar,
      description: cleanDesc,
      email: cleanEmail,
      status: 'pending',
    });
    // 异步通知站长（不阻塞响应；未配置 SMTP 时静默跳过）
    const { send } = require('../utils/notifyMail');
    send('新友链申请', `站点「${cleanName}」申请友情链接：\n\n${cleanUrl}\n\n描述：${cleanDesc}\n\n（后台可审核通过或拒绝）`).catch(() => {});
    return ok(res, null, '友链申请已提交，等待审核');
  } catch (e) {
    return fail(res, '申请失败', 500);
  }
});

module.exports = router;
