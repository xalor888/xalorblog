const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { cleanText, cleanLine, safeEmail } = require('../utils/sanitize');
const { honeypotCheck } = require('../middleware/antiBot');
const { formTokenRequired } = require('../middleware/formToken');
const { localDateTimeStr } = require('../utils/datetime');
const { antiSpam } = require('../utils/antiSpam');
const { getAdminNicknames } = require('../utils/ownerBadge');
const { report } = require('../middleware/ipGuard');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

/** 仅当昵称命中管理员保留名时才要求登录，避免过期 token 阻断普通访客留言 */
function requireAuthForReservedName(req, res, next) {
  const nick = String((req.body && req.body.nickname) || '').trim().toLowerCase();
  if (!nick) return next();
  return getAdminNicknames()
    .then((admins) => (admins.has(nick) ? authRequired(req, res, next) : next()))
    .catch(() => next());
}

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
        .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
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
router.post('/', postLimiter, honeypotCheck, formTokenRequired, requireAuthForReservedName, async (req, res) => {
  try {
    const { nickname, email = '', content } = req.body;
    const cleanContent = cleanText(content, 2000);
    const cleanNickname = cleanLine(nickname, 50);
    const cleanEmail = safeEmail(email, 100);
    if (!cleanNickname) return fail(res, '昵称不能为空');
    if (!cleanContent) return fail(res, '留言内容不能为空');

    // 博主昵称保留：匿名访客不能冒充管理员昵称领取“博主”标识
    const admins = await getAdminNicknames();
    if (admins.has(String(cleanNickname).trim().toLowerCase()) && (!req.user || req.user.role !== 'admin')) {
      return fail(res, '该昵称已被占用，请更换后重试', 403);
    }

    // 反垃圾：敏感词 + 链接数量限制
    const spam = antiSpam(String(content || ''), 1);
    if (!spam.ok) {
      report(req.ip, 'spam', `POST ${req.path}`);
      return fail(res, spam.reason, 400);
    }

    // 重复内容检测：同一 IP 30 分钟内提交过完全相同的内容 → 拒绝
    // 与入库值（清洗后的 cleanContent）比较，原始输入含 &/< 等时永远查不中
    const dup = await db('messages')
      .where('ip', req.ip || '')
      .where('content', cleanContent)
      .where('created_at', '>', localDateTimeStr(new Date(Date.now() - 30 * 60 * 1000)))
      .first('id');
    if (dup) return fail(res, '内容重复，请勿重复提交', 429);

    // 是否进入待审：站点开启「留言先审后发」后 AI 通过的留言仍需人工确认
    const { getAllSettings } = require('../utils/settings');
    const settings = await getAllSettings();

    // AI 审核（与评论共用引擎：本地规则 + LLM 二判）。
    // 留言板策略——全部由 AI 审核：
    //   forceLlm：所有非拒绝内容都过一遍 LLM（本地低分免检直批是垃圾直发漏洞）
    //   failClosed：AI 层未启用时转人工待审，不允许零审核直接发布
    const { moderateComment } = require('../utils/aiModeration');
    const verdict = await moderateComment(cleanContent, cleanNickname, '', { forceLlm: true, failClosed: true });

    // 拒绝 → 静默隔离：照常入库（status='rejected'，前台永远只查 approved），
    // 对发帖人返回与普通留言一致的 200 响应——不给探测接口行为的机会，
    // 同时后台可完整回看 AI 拦下的内容并恢复误杀
    let status;
    if (verdict.action === 'rejected') {
      report(req.ip, 'spam', `AI-REJECT ${verdict.reason}`);
      status = 'rejected';
    } else if (verdict.action === 'pending') {
      status = 'pending';
    } else {
      status = settings.message_moderation ? 'pending' : 'approved';
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
    // 自动审核决定写入审计日志（此前 AI 拦下的内容不留任何痕迹）
    const { logSystemAction } = require('../middleware/audit');
    logSystemAction(
      'AI-MODERATION 留言',
      `verdict=${verdict.action} score=${verdict.score} reason=${verdict.reason} content=${cleanContent.slice(0, 60)}`,
      req.ip || '',
      cleanNickname
    );
    // 异步通知站长（不阻塞响应；未配置 SMTP 时静默跳过；正文截断防超长邮件）
    const { send } = require('../utils/notifyMail');
    const notifyText = cleanContent.length > 300 ? `${cleanContent.slice(0, 300)}…` : cleanContent;
    send(`新留言：${cleanNickname}`, `${cleanNickname} 留言：\n\n${notifyText}\n\nAI 判定：${verdict.action}（${verdict.reason}）\n时间：${new Date().toLocaleString('zh-CN')}`).catch(() => {});
    const published = status === 'approved';
    return ok(res, { moderated: !published }, published ? '留言成功' : '留言已提交，审核通过后展示');
  } catch (e) {
    return fail(res, '留言失败', 500);
  }
});

module.exports = router;
