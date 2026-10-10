/**
 * 手记公开接口（个人主页的「朋友圈」时间线）
 *
 * 防护与文章详情同级：
 * - 列表（GET /）与详情（GET /:id）都挂在闸门之后（票据 + X-Sig + nonce，见 app.js）
 * - 列表**只出摘要字段**，正文仅通过详情接口以 AES-GCM 密文下发，
 *   密钥 = HMAC(ENC_SALT, 票据|note:<id>) —— 直接复用 utils/crypto.js
 * - 详情走正文刮取窗（与文章共用 noteArticleRead 分桶，键为 note:<id>）
 * - 点赞沿用文章的 IP 维度防刷（canLike），窗口内重复点赞 429 并计信誉
 */

const express = require('express');
const db = require('../db');
const { ok, fail, notFound } = require('../utils/response');
const { encryptPayload } = require('../utils/crypto');
const { report } = require('../middleware/ipGuard');
const { noteArticleRead } = require('../middleware/scrapeGuard');
const { noteSummary, parseImages } = require('../utils/notes');
// 与文章共用同一个 IP 维度点赞防刷表（键为 `${ip}:${key}`，note: 前缀不冲突）
const { canLike } = require('./articles');

const router = express.Router();

const MAX_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE = 10;

/** 手记详情的内容密钥标识：note:<id>，与文章的 slug 命名空间隔离 */
function noteContentKey(id) {
  return `note:${id}`;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > 4294967295) return 0;
  return id;
}

/** 手记列表（公开，仅摘要）：置顶优先，其后按发布时间倒序 */
router.get('/', async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page) || 1));
    const rawSize = parseInt(req.query.pageSize);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number.isInteger(rawSize) ? rawSize : DEFAULT_PAGE_SIZE)
    );

    const base = db('notes').where('status', 'published');
    const countRow = await base.clone().count('* as cnt').first();
    const total = Number(countRow?.cnt || 0);

    const rows = await base
      .clone()
      .select(
        'id', 'content', 'images', 'excerpt', 'mood', 'location',
        'likes', 'is_pinned', 'status', 'published_at', 'created_at', 'updated_at'
      )
      .orderBy([
        { column: 'is_pinned', order: 'desc' },
        { column: 'published_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    // noteSummary 会截取正文生成摘要，但返回对象里不含 content（字段白名单在 utils/notes.js）
    return ok(res, {
      list: rows.map(noteSummary),
      pagination: {
        page,
        pageSize,
        total,
        has_more: page * pageSize < total,
      },
    });
  } catch (e) {
    return fail(res, '获取手记失败', 500);
  }
});

/** 手记详情：正文以 AES-GCM 密文下发（密钥 = HMAC(盐, 票据|note:<id>)） */
router.get('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, '参数不合法');

    const row = await db('notes').where('id', id).where('status', 'published').first();
    if (!row) return notFound(res, '手记不存在');

    // 只统计持票读者（搜索引擎爬虫走免闸门通道，正文为空，不应被刮取窗误伤）
    if (req.headers['x-pass']) {
      const scrape = noteArticleRead(req.ip, req.headers['x-fp'], noteContentKey(id));
      if (!scrape.ok) {
        report(req.ip, 'rate', `SCRAPE /notes/${id}`);
        return res.status(429).json({ code: 1, message: '阅读过于频繁，请稍后再试' });
      }
    }

    const pass = String(req.headers['x-pass'] || '');
    const contentKey = noteContentKey(id);
    const encrypted = pass ? encryptPayload(row.content, pass, contentKey) : '';

    return ok(res, {
      ...noteSummary(row),
      // 详情必须给出**完整图片数组**（九宫格与灯箱都依赖它）；
      // noteSummary 只带 cover/image_count —— 那是给列表省流量的字段白名单。
      images: parseImages(row.images),
      content: encrypted,
      content_enc: !!encrypted,
      content_key: contentKey,
    });
  } catch (e) {
    return fail(res, '获取手记失败', 500);
  }
});

/** 点赞（写请求：票据 + 签名 + 同源 Referer + 时间戳） */
router.post('/:id/like', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, '参数不合法');
    const ip = req.ip || 'unknown';
    // 防刷键含 note: 前缀：与文章 id 空间隔离，同一 IP 对同一条手记 10 秒内只能赞一次
    if (!canLike(ip, noteContentKey(id))) {
      report(ip, 'rate', `LIKE-FLOOD /notes/${id}`);
      return fail(res, '点赞太频繁啦，歇一会儿再点吧', 429);
    }
    const row = await db('notes').where('id', id).select('id', 'status').first();
    if (!row || row.status !== 'published') return notFound(res, '手记不存在');
    await db('notes').where('id', id).increment('likes', 1);
    const updated = await db('notes').where('id', id).select('likes').first();
    return ok(res, { likes: updated ? Number(updated.likes) : 0 });
  } catch (e) {
    return fail(res, '点赞失败', 500);
  }
});

module.exports = router;
module.exports.noteContentKey = noteContentKey;
