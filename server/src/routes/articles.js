const express = require('express');
const db = require('../db');
const { ok, fail, notFound } = require('../utils/response');
const { encryptPayload } = require('../utils/crypto');
const { escapeLike } = require('../utils/sanitize');
const { report } = require('../middleware/ipGuard');

const router = express.Router();

// 点赞防刷：内存记录 { ip:articleId -> 过期时间戳 }
// 注意：防刷键不能依赖 X-Fp —— 指纹只是格式校验的字符串，脚本可任意轮换
// （同一 IP 换 fp 即获新键，窗口形同虚设）。以 IP 为唯一防刷维度 + 超限计信誉：
// 换 IP 刷榜需要代理池成本，且 429 后积分累积 → 自动封禁
const likeGuard = new Map();
const LIKE_WINDOW = 10 * 1000; // 10 秒内同一 IP 对同一文章只能赞一次

function canLike(ip, articleId) {
  const key = `${ip}:${articleId}`;
  const now = Date.now();
  const expireAt = likeGuard.get(key) || 0;
  if (now < expireAt) return false;
  likeGuard.set(key, now + LIKE_WINDOW);
  // 定期清理，防止内存无限增长
  if (likeGuard.size > 5000) {
    for (const [k, t] of likeGuard) {
      if (t < now) likeGuard.delete(k);
    }
  }
  return true;
}

/** 取文章的标签列表 */
async function getTagsMap(articleIds) {
  if (!articleIds.length) return {};
  const rows = await db('article_tags as at')
    .join('tags as t', 'at.tag_id', 't.id')
    .whereIn('at.article_id', articleIds)
    .select('at.article_id', 't.id', 't.name', 't.slug');
  const map = {};
  for (const r of rows) {
    (map[r.article_id] = map[r.article_id] || []).push({ id: r.id, name: r.name, slug: r.slug });
  }
  return map;
}

/** 组装文章列表行 */
async function decorateArticles(rows) {
  const ids = rows.map((r) => r.id);
  const tagsMap = await getTagsMap(ids);
  const counts = await db('comments')
    .whereIn('article_id', ids)
    .where('status', 'approved')
    .groupBy('article_id')
    .select('article_id')
    .count('* as cnt');
  const countMap = {};
  for (const c of counts) countMap[c.article_id] = Number(c.cnt);

  return rows.map((r) => ({
    ...r,
    tags: tagsMap[r.id] || [],
    comment_count: countMap[r.id] || 0,
    content: undefined, // 列表不返回正文
  }));
}

// ============ 公开接口 ============

/** 文章列表：支持 page/pageSize/category/tag/keyword/status/sort(latest|hot|commented) */
router.get('/', async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page) || 1)); // page 上限防超大 offset 拖慢查询
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 10));
    // 参数类型防御：数组/嵌套参数（?tag[]=...）强制取首项字符串，
    // 防 Knex 对数组值 where 抛错导致 500（Knex 3.x 单列比较不接受数组）
    const qs = (v) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
    const category = qs(req.query.category);
    const tag = qs(req.query.tag);
    const keyword = qs(req.query.keyword);
    const status = qs(req.query.status) || 'published';
    const sort = qs(req.query.sort) || 'latest';

    const base = db('articles as a')
      .leftJoin('categories as c', 'a.category_id', 'c.id')
      .where('a.status', status);

    if (category) base.andWhere('c.slug', category);
    if (keyword) {
      const kw = escapeLike(String(keyword).slice(0, 50));
      base.andWhere((b) => {
        b.where('a.title', 'like', `%${kw}%`)
          .orWhere('a.summary', 'like', `%${kw}%`)
          .orWhere('a.content', 'like', `%${kw}%`);
      });
    }

    let idsQuery;
    if (tag) {
      // 通过标签过滤：先查出文章 id
      idsQuery = db('article_tags as at')
        .join('tags as t', 'at.tag_id', 't.id')
        .where('t.slug', tag)
        .pluck('at.article_id');
    }

    // 排序：latest 最新 / hot 最热（浏览量）/ commented 最多评论
    let orderBy;
    if (sort === 'hot') {
      orderBy = [{ column: 'a.is_top', order: 'desc' }, { column: 'a.views', order: 'desc' }, { column: 'a.published_at', order: 'desc' }];
    } else if (sort === 'commented') {
      base
        .leftJoin('comments as cm', function () {
          this.on('cm.article_id', 'a.id').andOn('cm.status', '=', db.raw('?', ['approved']));
        })
        .groupBy('a.id');
      orderBy = [{ column: 'a.is_top', order: 'desc' }, { column: db.raw('COUNT(cm.id)'), order: 'desc' }, { column: 'a.published_at', order: 'desc' }];
    } else {
      orderBy = [{ column: 'a.is_top', order: 'desc' }, { column: 'a.published_at', order: 'desc' }];
    }

    const [total, ids, rows] = await Promise.all([
      // commented 模式有 groupBy，用 countDistinct 保证计数正确
      sort === 'commented'
        ? base.clone().countDistinct('a.id as cnt').first()
        : base.clone().count('a.id as cnt').first(),
      idsQuery || Promise.resolve(null),
      base.clone()
        .select(
          'a.id', 'a.title', 'a.slug', 'a.summary', 'a.cover', 'a.is_top', 'a.views', 'a.likes',
          'a.published_at', 'a.created_at', 'a.category_id',
          'c.name as category_name', 'c.slug as category_slug', 'c.color as category_color'
        )
        .orderBy(orderBy)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    let list = rows;
    if (ids) {
      const idSet = new Set(ids.map(Number));
      list = rows.filter((r) => idSet.has(r.id));
    }

    const decorated = await decorateArticles(list);
    return ok(res, {
      list: decorated,
      pagination: { page, pageSize, total: Number(total.cnt || 0) },
    });
  } catch (e) {
    return fail(res, '获取文章列表失败', 500);
  }
});

// 浏览量防刷：同一 IP+设备对同一文章 5 分钟内只计一次
const viewGuard = new Map();
const VIEW_WINDOW = 5 * 60 * 1000;

function shouldCountView(ip, fp, articleId) {
  const key = `${ip}:${fp}:${articleId}`;
  const now = Date.now();
  const expireAt = viewGuard.get(key) || 0;
  if (now < expireAt) return false;
  viewGuard.set(key, now + VIEW_WINDOW);
  if (viewGuard.size > 10000) {
    for (const [k, t] of viewGuard) {
      if (t < now) viewGuard.delete(k);
    }
  }
  return true;
}

/** 文章详情（按 slug） */
router.get('/slug/:slug', async (req, res) => {
  try {
    const row = await db('articles as a')
      .leftJoin('categories as c', 'a.category_id', 'c.id')
      .where('a.slug', req.params.slug)
      .select(
        'a.*', 'c.name as category_name', 'c.slug as category_slug', 'c.color as category_color'
      )
      .first();
    if (!row) return notFound(res, '文章不存在');

    // 浏览量 +1（防刷窗口内不重复计数）
    const ip = req.ip || 'unknown';
    const fp = String(req.headers['x-fp'] || '').slice(0, 128);
    let viewCounted = true;
    if (shouldCountView(ip, fp, row.id)) {
      await db('articles').where('id', row.id).increment('views', 1);
    } else {
      viewCounted = false;
    }

    const tagsMap = await getTagsMap([row.id]);
    const commentCount = await db('comments')
      .where('article_id', row.id).where('status', 'approved').count('* as cnt').first();

    // 正文加密传输：仅持有通行证票据的浏览器可解密
    const pass = String(req.headers['x-pass'] || '');
    const encrypted = pass ? encryptPayload(row.content, pass) : '';

    return ok(res, {
      ...row,
      content: encrypted,
      content_enc: !!encrypted,
      views: row.views + (viewCounted ? 1 : 0),
      tags: tagsMap[row.id] || [],
      comment_count: Number(commentCount.cnt || 0),
    });
  } catch (e) {
    return fail(res, '获取文章失败', 500);
  }
});

/** 上一篇 / 下一篇 */
router.get('/neighbors/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const cur = await db('articles').where('id', id).where('status', 'published').select('published_at').first();
    if (!cur) return notFound(res, '文章不存在');
    const [prev, next] = await Promise.all([
      // 同秒发布的文章也互为邻居（时间 <=/>= + 排除自身 + id 作为并列 tiebreaker）
      db('articles')
        .where('status', 'published').where('published_at', '<=', cur.published_at).whereNot('id', id)
        .orderBy([{ column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }])
        .select('id', 'title', 'slug').first(),
      db('articles')
        .where('status', 'published').where('published_at', '>=', cur.published_at).whereNot('id', id)
        .orderBy([{ column: 'published_at', order: 'asc' }, { column: 'id', order: 'asc' }])
        .select('id', 'title', 'slug').first(),
    ]);
    return ok(res, { prev, next });
  } catch (e) {
    return fail(res, '获取相邻文章失败', 500);
  }
});

/**
 * 相关文章（三级回退，保证非空推荐）：
 * 1. 同分类文章
 * 2. 不足 4 篇补同标签文章（标签取当前文章全部）
 * 3. 仍不足补最新文章（未分类文章也有推荐，不再恒为空）
 */
router.get('/related/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const cur = await db('articles').where('id', id).select('category_id').first();
    if (!cur) return notFound(res);

    const FIELDS = ['a.id', 'a.title', 'a.slug', 'a.cover', 'a.views', 'a.published_at', 'c.name as category_name', 'c.color as category_color'];
    const baseSelect = (q) => q.select(...FIELDS);

    let rows = [];
    // 1. 同分类（NULL 分类跳过——NULL = NULL 永不匹配）
    if (cur.category_id) {
      rows = await baseSelect(
        db('articles as a')
          .leftJoin('categories as c', 'a.category_id', 'c.id')
          .where('a.status', 'published')
          .whereNot('a.id', id)
          .where('a.category_id', cur.category_id)
          .orderBy('a.published_at', 'desc')
          .limit(4)
      );
    }

    // 2. 补同标签（无分类/同分类不足时）
    if (rows.length < 4) {
      const tagRows = await db('article_tags').where('article_id', id).pluck('tag_id');
      if (tagRows.length) {
        const extra = await baseSelect(
          db('articles as a')
            .join('article_tags as at', 'a.id', 'at.article_id')
            .leftJoin('categories as c', 'a.category_id', 'c.id')
            .where('a.status', 'published')
            .whereNot('a.id', id)
            .whereIn('at.tag_id', tagRows)
            .whereNotIn('a.id', rows.map((r) => r.id))
            .groupBy('a.id')
            .orderBy('a.published_at', 'desc')
            .limit(4 - rows.length)
        );
        rows = rows.concat(extra);
      }
    }

    // 3. 兜底补最新
    if (rows.length < 4) {
      const extra = await baseSelect(
        db('articles as a')
          .leftJoin('categories as c', 'a.category_id', 'c.id')
          .where('a.status', 'published')
          .whereNot('a.id', id)
          .whereNotIn('a.id', rows.map((r) => r.id))
          .orderBy('a.published_at', 'desc')
          .limit(4 - rows.length)
      );
      rows = rows.concat(extra);
    }
    return ok(res, rows);
  } catch (e) {
    return fail(res, '获取相关文章失败', 500);
  }
});

/** 随机一篇已发布文章（「随便看看」发现入口）
 * 两阶段实现：文章数少时直接 RAND()；超过 1000 篇改用随机 offset
 * （RAND() 会全表排序，大数据量下性能劣化；随机 offset 摊平成本） */
router.get('/random', async (req, res) => {
  try {
    const cnt = await db('articles').where('status', 'published').count('* as c').first();
    const total = Number(cnt.c || 0);
    if (total === 0) return notFound(res, '暂无文章');
    let row;
    if (total <= 1000) {
      row = await db('articles')
        .where('status', 'published')
        .orderByRaw('RAND()')
        .select('slug', 'title')
        .first();
    } else {
      // 随机 offset：两次轻查询替代全表排序（offset 上限防护防越界）
      const offset = Math.floor(Math.random() * total);
      row = await db('articles')
        .where('status', 'published')
        .orderBy('id', 'asc')
        .select('slug', 'title')
        .offset(Math.min(offset, total - 1))
        .first();
    }
    if (!row) return notFound(res, '暂无文章');
    return ok(res, row);
  } catch (e) {
    return fail(res, '获取随机文章失败', 500);
  }
});

/** 归档：按年月分组 */
router.get('/archive', async (req, res) => {
  try {
    const rows = await db('articles')
      .where('status', 'published')
      .orderBy('published_at', 'desc')
      .select('id', 'title', 'slug', 'published_at', 'views');
    const groups = {};
    for (const r of rows) {
      const dayStr = String(r.published_at).slice(0, 10); // YYYY-MM-DD（dateStrings 直接返回）
      const key = dayStr.slice(0, 7); // YYYY-MM
      (groups[key] = groups[key] || []).push({
        id: r.id, title: r.title, slug: r.slug, views: r.views,
        day: dayStr.slice(8, 10),
      });
    }
    const list = Object.entries(groups).map(([month, items]) => ({ month, count: items.length, items }));
    return ok(res, list);
  } catch (e) {
    return fail(res, '获取归档失败', 500);
  }
});

/** 点赞（服务端防刷：IP + 设备指纹） */
router.post('/:id/like', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const ip = req.ip || 'unknown';
    if (!canLike(ip, id)) {
      report(ip, 'rate', `LIKE-FLOOD /articles/${id}`);
      return fail(res, '点赞太频繁啦，歇一会儿再点吧', 429);
    }
    await db('articles').where('id', id).increment('likes', 1);
    const row = await db('articles').where('id', id).select('likes').first();
    return ok(res, { likes: row ? row.likes : 0 });
  } catch (e) {
    return fail(res, '点赞失败', 500);
  }
});

module.exports = router;
module.exports.canLike = canLike;
module.exports.LIKE_WINDOW = LIKE_WINDOW;
