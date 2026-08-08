const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { ok, fail, notFound } = require('../utils/response');
const { cleanText, cleanLine, safeEmail } = require('../utils/sanitize');
const { honeypotCheck } = require('../middleware/antiBot');
const { formTokenRequired } = require('../middleware/formToken');
const { localDateTimeStr } = require('../utils/datetime');
const { antiSpam } = require('../utils/antiSpam');
const { getAdminNicknames } = require('../utils/ownerBadge');
const { report } = require('../middleware/ipGuard');

const router = express.Router();

// 留言提交限流（防刷屏）：每 IP 每分钟 6 次（与评论同标准）
const postLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '留言太频繁了，请稍后再发' },
});

/** 留言列表（公开，仅已审核） */
router.get('/', async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page) || 1)); // page 上限防超大 offset 拖慢查询
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const base = db('messages').where('status', 'approved');
    const [total, rows, admins] = await Promise.all([
      base.clone().count('id as cnt').first(),
      base.clone().select('id', 'nickname', 'content', 'reply', 'replied_at', 'created_at')
        .orderBy('created_at', 'desc')
        .limit(pageSize).offset((page - 1) * pageSize),
      getAdminNicknames(),
    ]);
    const list = rows.map((r) => ({
      ...r,
      is_admin: admins.has(String(r.nickname || '').trim().toLowerCase()),
    }));
    return ok(res, { list, pagination: { page, pageSize, total: Number(total.cnt || 0) } });
  } catch (e) {
    return fail(res, '获取留言失败', 500);
  }
});

/** 发表留言（限流 + honeypot + 签名令牌防机器人） */
router.post('/', postLimiter, honeypotCheck, formTokenRequired, async (req, res) => {
  try {
    const { nickname, email = '', content } = req.body;
    const cleanContent = cleanText(content, 2000);
    const cleanNickname = cleanLine(nickname, 50);
    const cleanEmail = safeEmail(email, 100);
    if (!cleanNickname) return fail(res, '昵称不能为空');
    if (!cleanContent) return fail(res, '留言内容不能为空');

    // 反垃圾：敏感词 + 链接数量限制
    const spam = antiSpam(String(content || ''), 1);
    if (!spam.ok) {
      report(req.ip, 'spam', `POST ${req.path}`);
      return fail(res, spam.reason, 400);
    }

    // 重复内容检测：同一 IP 30 分钟内提交过完全相同的内容 → 拒绝
    const dup = await db('messages')
      .where('ip', req.ip || '')
      .where('content', content.trim())
      .where('created_at', '>', localDateTimeStr(new Date(Date.now() - 30 * 60 * 1000)))
      .first('id');
    if (dup) return fail(res, '内容重复，请勿重复提交', 429);

    // 是否进入待审：站点开启「留言审核」后新留言默认 pending
    const { getAllSettings } = require('../utils/settings');
    const settings = await getAllSettings();
    let status = settings.message_moderation ? 'pending' : 'approved';

    // AI 审核（与评论共用引擎：本地规则 + 可选 LLM 二判）
    const { moderateComment } = require('../utils/aiModeration');
    const verdict = await moderateComment(cleanContent, cleanNickname, '');
    if (verdict.action === 'rejected') {
      report(req.ip, 'spam', `AI-REJECT ${verdict.reason}`);
      return fail(res, '留言内容包含广告或违规信息，请修改后重试', 400);
    }
    if (verdict.action === 'pending') {
      status = 'pending';
    }
    // AI 标记原因入库（后台可见，辅助人工复核）
    const aiReason = verdict.action === 'approved' ? '' : String(verdict.reason || '').slice(0, 120);

    await db('messages').insert({
      nickname: cleanNickname,
      email: cleanEmail,
      content: cleanContent,
      ip: req.ip || '',
      status,
      ai_reason: aiReason,
    });
    // 异步通知站长（不阻塞响应；未配置 SMTP 时静默跳过；正文截断防超长邮件）
    const { send } = require('../utils/notifyMail');
    const notifyText = cleanContent.length > 300 ? `${cleanContent.slice(0, 300)}…` : cleanContent;
    send(`新留言：${cleanNickname}`, `${cleanNickname} 留言：\n\n${notifyText}\n\n时间：${new Date().toLocaleString('zh-CN')}`).catch(() => {});
    return ok(res, { moderated: status === 'pending' }, status === 'pending' ? '留言已提交，等待审核后展示' : '留言成功');
  } catch (e) {
    return fail(res, '留言失败', 500);
  }
});

/** AI 复核（误拒恢复/复核）：重跑本地审核引擎，更新状态与标记
 * 管理接口：要求登录 + 管理员角色（未认证调用此前可被利用反复触发 LLM 二判消耗资源） */
router.post('/:id/re-ai', require('../middleware/auth').authRequired, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return fail(res, '无权限', 403);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const row = await db('messages').where('id', id).select('id', 'nickname', 'content').first();
    if (!row) return notFound(res, '留言不存在');
    const { moderateComment } = require('../utils/aiModeration');
    const verdict = await moderateComment(row.content, row.nickname, '');
    const newStatus = verdict.action === 'rejected' ? 'rejected' : verdict.action === 'pending' ? 'pending' : 'approved';
    await db('messages').where('id', id).update({
      status: newStatus,
      ai_reason: verdict.action === 'approved' ? '' : String(verdict.reason || '').slice(0, 120),
    });
    return ok(res, { status: newStatus }, `AI 复核完成：${verdict.action === 'approved' ? '判定通过' : verdict.action === 'pending' ? '进入待审' : '仍判拒绝'}`);
  } catch (e) {
    return fail(res, 'AI 复核失败', 500);
  }
});

module.exports = router;
