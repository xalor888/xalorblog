const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { cleanText, cleanLine, safeUrl, safeEmail } = require('../utils/sanitize');
const { honeypotCheck } = require('../middleware/antiBot');
const { formTokenRequired } = require('../middleware/formToken');

const router = express.Router();

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

/** 申请友链（honeypot + 签名令牌防机器人） */
router.post('/', honeypotCheck, formTokenRequired, async (req, res) => {
  try {
    const { name, url, avatar = '', description = '', email = '' } = req.body;
    const cleanName = cleanLine(name, 80);
    const cleanUrl = safeUrl(url, 300);
    const cleanAvatar = safeUrl(avatar, 500);
    const cleanDesc = cleanText(description, 200);
    const cleanEmail = safeEmail(email, 100);
    if (!cleanName) return fail(res, '名称不能为空');
    if (!cleanUrl) return fail(res, '请填写合法的网址');
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
