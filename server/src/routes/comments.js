const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { ok, fail, notFound } = require('../utils/response');
const { cleanText, cleanLine, safeUrl, safeEmail } = require('../utils/sanitize');
const { honeypotCheck } = require('../middleware/antiBot');
const { formTokenRequired } = require('../middleware/formToken');
const { localDateTimeStr } = require('../utils/datetime');
const { antiSpam } = require('../utils/antiSpam');
const { send: sendNotify } = require('../utils/notifyMail');
const { getAdminNicknames } = require('../utils/ownerBadge');
const { report } = require('../middleware/ipGuard');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

/** 仅当昵称命中管理员保留名时才要求登录，避免过期 token 阻断普通访客评论 */
function requireAuthForReservedName(req, res, next) {
  const nick = String((req.body && req.body.nickname) || '').trim().toLowerCase();
  if (!nick) return next();
  return getAdminNicknames()
    .then((admins) => (admins.has(nick) ? authRequired(req, res, next) : next()))
    .catch(() => next());
}

// 评论读取限流（浏览评论）：每 IP 每分钟 60 次
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '读取过于频繁，请稍后再试' },
});

// 评论提交限流（防刷屏）：每 IP 每分钟 6 次
const postLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '评论太频繁了，请稍后再发' },
});

/**
 * 拉平评论树：给定列表，构建 parent_id 关联的嵌套结构
 * 深度防护：树高上限 MAX_TREE_DEPTH —— 恶意构造的超深引用链
 * （如 1 万层楼中楼）会导致 JSON 序列化栈溢出 / 客户端递归渲染崩溃；
 * 超深节点提升为根节点，数据不丢且渲染树高受限。
 */
const MAX_TREE_DEPTH = 10;

function buildCommentTree(rows, order = 'asc') {
  const map = {};
  const roots = [];
  const depth = {};
  for (const r of rows) {
    r.children = [];
    map[r.id] = r;
  }
  for (const r of rows) {
    const parent = r.parent_id && map[r.parent_id];
    if (parent) {
      const d = (depth[parent.id] || 0) + 1;
      if (d <= MAX_TREE_DEPTH) {
        depth[r.id] = d;
        parent.children.push(r);
        continue;
      }
    }
    // 父评论缺失（孤儿）或层级超限 → 提升为根，保证可见且树高有界
    roots.push(r);
  }
  // 根评论按时间排序（默认最早在前，可切最新）；子评论始终按时间正序保持对话连贯
  const sortByTime = (list) =>
    list.sort((a, b) => {
      const diff = new Date(a.created_at) - new Date(b.created_at);
      return order === 'desc' ? -diff : diff;
    });
  const walk = (list) => {
    for (const item of list) {
      if (item.children.length) walk(item.children);
    }
  };
  const rootsSorted = sortByTime(roots);
  rootsSorted.forEach((r) => walk([r]));
  return rootsSorted;
}

/** 最新评论（首页展示）：最近 6 条已审核评论，含所属文章链接 */
router.get('/recent', readLimiter, async (req, res) => {
  try {
    const rows = await db('comments as cm')
      .join('articles as a', 'cm.article_id', 'a.id')
      .where('cm.status', 'approved')
      .where('a.status', 'published')
      .orderBy('cm.created_at', 'desc')
      .limit(6)
      .select('cm.id', 'cm.nickname', 'cm.content', 'cm.created_at', 'a.slug as article_slug', 'a.title as article_title');
    return ok(res, rows.map((r) => ({
      id: r.id,
      nickname: r.nickname,
      content: String(r.content || '').slice(0, 60),
      created_at: r.created_at,
      article_slug: r.article_slug,
      article_title: r.article_title,
    })));
  } catch (e) {
    return fail(res, '获取最新评论失败', 500);
  }
});

/** 某篇文章的评论（公开，仅已审核）。邮箱仅用于服务端通知，绝不进入公开响应。 */
router.get('/article/:articleId', readLimiter, async (req, res) => {
  try {
    const articleId = Number(req.params.articleId);
    if (!Number.isInteger(articleId) || articleId <= 0) return fail(res, '参数不合法');
    const article = await db('articles').where('id', articleId).where('status', 'published').select('id').first();
    if (!article) return notFound(res, '文章不存在');
    // 排序参数：asc=最早在前（默认）/ desc=最新在前；仅影响根评论顺序
    const order = req.query.sort === 'desc' ? 'desc' : 'asc';
    const [rows, admins] = await Promise.all([
      db('comments')
        .where('article_id', articleId)
        .where('status', 'approved')
        .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]) // 同秒评论按 id 稳定排序
        .select('id', 'parent_id', 'nickname', 'website', 'content', 'likes', 'created_at'),
      getAdminNicknames(),
    ]);
    const tree = buildCommentTree(
      rows.map((r) => ({
        ...r,
        is_admin: admins.has(String(r.nickname || '').trim().toLowerCase()),
      })),
      order
    );
    return ok(res, tree);
  } catch (e) {
    return fail(res, '获取评论失败', 500);
  }
});

/** 发表评论（honeypot + 签名令牌防机器人） */
router.post('/', postLimiter, honeypotCheck, formTokenRequired, requireAuthForReservedName, async (req, res) => {
  try {
    const { article_id, parent_id = null, nickname, email = '', website = '', content } = req.body;
    const numericArticleId = Number(article_id);
    if (!Number.isInteger(numericArticleId) || numericArticleId <= 0) return fail(res, '参数不合法');
    if (!nickname || !nickname.trim()) return fail(res, '昵称不能为空');
    if (!content || !content.trim()) return fail(res, '评论内容不能为空');

    // 反垃圾：敏感词 + 链接数量限制
    const spam = antiSpam(String(content || ''), 1);
    if (!spam.ok) {
      report(req.ip, 'spam', `POST ${req.path}`);
      return fail(res, spam.reason, 400);
    }

    // 重复内容检测：同一 IP 30 分钟内提交过完全相同的内容 → 拒绝
    const dup = await db('comments')
      .where('ip', req.ip || '')
      .where('content', content.trim())
      .where('created_at', '>', localDateTimeStr(new Date(Date.now() - 30 * 60 * 1000)))
      .first('id');
    if (dup) return fail(res, '内容重复，请勿重复提交', 429);

    const article = await db('articles').where('id', numericArticleId).where('status', 'published').select('id', 'allow_comment', 'title').first();
    if (!article) return notFound(res, '文章不存在');
    if (!article.allow_comment) return fail(res, '该文章已关闭评论');

    // parent 校验：必须存在、属于同一篇文章，且深度归一化（最多两层楼中楼）
    let finalParent = parent_id == null ? null : Number(parent_id);
    if (finalParent != null && !Number.isInteger(finalParent)) {
      return fail(res, '参数不合法');
    }
    if (finalParent != null) {
      const parent = await db('comments')
        .where('id', finalParent)
        .select('id', 'parent_id', 'article_id')
        .first();
      if (!parent || parent.article_id !== numericArticleId) {
        finalParent = null; // 无效 parent 降级为顶层评论，避免孤儿挂载
      } else if (parent.parent_id) {
        // parent 本身是子回复：挂到根评论 —— 但祖父评论必须同样属于本文，
        // 防恶意构造 parent.parent_id 指向其他文章的评论
        const grand = await db('comments')
          .where('id', parent.parent_id)
          .select('article_id')
          .first();
        finalParent = grand && grand.article_id === numericArticleId ? parent.parent_id : null;
      }
    }

    const cleanContent = cleanText(content, 2000);
    const cleanNickname = cleanLine(nickname, 50);
    const cleanEmail = safeEmail(email, 100);
    const cleanWebsite = safeUrl(website, 200);
    if (!cleanNickname) return fail(res, '昵称不能为空');
    if (!cleanContent) return fail(res, '评论内容不能为空');

    // 博主昵称保留：匿名访客不能冒充管理员昵称领取“博主”标识
    const admins = await getAdminNicknames();
    if (admins.has(String(cleanNickname).trim().toLowerCase()) && (!req.user || req.user.role !== 'admin')) {
      return fail(res, '该昵称已被占用，请更换后重试', 403);
    }

    // 是否进入待审：站点开启「评论审核」后新评论默认 pending
    const { getAllSettings } = require('../utils/settings');
    const settings = await getAllSettings();
    let status = settings.comment_moderation ? 'pending' : 'approved';

    // AI 审核：本地规则 + 可选 LLM 二判
    // rejected → 直接拒绝并计 spam 信誉；pending → 强制进入待审；approved → 交审核开关
    const { moderateComment } = require('../utils/aiModeration');
    const verdict = await moderateComment(cleanContent, cleanNickname, cleanWebsite);
    if (verdict.action === 'rejected') {
      // 垃圾评论计 spam 信誉（累计触发 IP 封禁）
      report(req.ip, 'spam', `AI-REJECT ${verdict.reason}`);
      return fail(res, '评论内容包含广告或违规信息，请修改后重试', 400);
    }
    if (verdict.action === 'pending') {
      status = 'pending';
    }
    // AI 标记原因入库（后台可见，辅助人工复核）
    const aiReason = verdict.action === 'approved' ? '' : String(verdict.reason || '').slice(0, 120);

    const id = await db('comments').insert({
      article_id: numericArticleId,
      parent_id: finalParent,
      nickname: cleanNickname,
      email: cleanEmail,
      website: cleanWebsite,
      content: cleanContent,
      ip: req.ip || '',
      status,
      ai_reason: aiReason,
    });

    const row = await db('comments')
      .where('id', id[0])
      .select('id', 'parent_id', 'nickname', 'website', 'content', 'likes', 'created_at')
      .first();
    row.is_admin = admins.has(String(row.nickname || '').trim().toLowerCase());
    // 审核开关状态随响应下发：前端据此提示（避免提示"成功"但内容未显示）
    row.moderated = status === 'pending';

    // 异步通知站长（不阻塞响应；未配置 SMTP 时静默跳过；正文截断防超长邮件）
    const notifyText = cleanContent.length > 300 ? `${cleanContent.slice(0, 300)}…` : cleanContent;
    sendNotify(`新评论：${cleanNickname}`, `${cleanNickname} 留言：\n\n${notifyText}\n\n时间：${new Date().toLocaleString('zh-CN')}`).catch(() => {});

    // 回复通知：被回复者留过邮箱则异步通知其有人回复（邮箱仅服务端使用、从不下发前端；
    // 自我回复跳过；send 内部再做格式校验 + CRLF 清洗）
    if (finalParent != null) {
      const replied = await db('comments').where('id', finalParent).select('email', 'nickname').first();
      if (replied && replied.email && String(replied.email).toLowerCase() !== String(cleanEmail || '').toLowerCase()) {
        const { send } = require('../utils/notifyMail');
        send(
          `有人回复了你的评论`,
          `${cleanNickname} 回复了你在《${article.title}》下的评论：\n\n${notifyText}\n\n（如不想再收到此类通知，可在评论时留空邮箱）`,
          replied.email
        ).catch(() => {});
      }
    }

    return ok(res, row, status === 'pending' ? '评论已提交，等待审核后展示' : '评论成功');
  } catch (e) {
    return fail(res, '发表评论失败', 500);
  }
});

// 评论点赞防刷：仅 IP 维度（X-Fp 可轮换伪造，不能作为防刷键；超限计信誉）
const commentLikeGuard = new Map();
const C_LIKE_WINDOW = 10 * 1000;

function canCommentLike(ip, commentId) {
  const key = `${ip}:${commentId}`;
  const now = Date.now();
  const expireAt = commentLikeGuard.get(key) || 0;
  if (now < expireAt) return false;
  commentLikeGuard.set(key, now + C_LIKE_WINDOW);
  if (commentLikeGuard.size > 5000) {
    for (const [k, t] of commentLikeGuard) {
      if (t < now) commentLikeGuard.delete(k);
    }
    while (commentLikeGuard.size > 4000) {
      const oldest = commentLikeGuard.keys().next().value;
      if (oldest === undefined) break;
      commentLikeGuard.delete(oldest);
    }
  }
  return true;
}

/** 评论点赞（防刷：10 秒内同一 IP 只能赞一次；仅已审核评论可赞） */
router.post('/:id/like', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const ip = req.ip || 'unknown';
    if (!canCommentLike(ip, id)) {
      report(ip, 'rate', `LIKE-FLOOD /comments/${id}`);
      return res.status(429).json({ code: 1, message: '点赞太频繁了，请稍后再试' });
    }
    const row = await db('comments as cm')
      .join('articles as a', 'cm.article_id', 'a.id')
      .where('cm.id', id)
      .where('cm.status', 'approved')
      .where('a.status', 'published')
      .select('cm.id', 'cm.status', 'a.status as article_status')
      .first();
    if (!row) return notFound(res, '评论不存在');
    await db('comments').where('id', id).increment('likes', 1);
    const updated = await db('comments').where('id', id).select('likes').first();
    return ok(res, { likes: updated ? Number(updated.likes) : 1 });
  } catch (e) {
    return fail(res, '点赞失败', 500);
  }
});

module.exports = router;
