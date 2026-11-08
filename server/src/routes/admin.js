/**
 * 管理后台 API 路由（全部挂载在秘钥路径 /api/<adminPath>/ 之下）
 * 所有写操作与管理列表接口都隐藏在由 JWT_SECRET 派生的秘钥路径内，
 * 公共前缀下探测不到任何后台接口 —— 与前台 404 同形，路由存在性不可枚举。
 * 所有路由统一要求 JWT + 指纹 + 服务端会话三重认证。
 */

const { REVIEW_STATUS, REVIEW_STATUS_ZH, ARTICLE_STATUS, isOneOf } = require('../utils/enums');
const express = require('express');
const { extractUploadRefs, UPLOAD_REF_SQL_LIKE } = require('../utils/uploads');
const asyncGuard = require('../utils/asyncGuard');
const db = require('../db');
const config = require('../config');
const { ok, fail, notFound } = require('../utils/response');
const { slugify, uniqueSlug } = require('../utils/slugify');
const { authRequired } = require('../middleware/auth');
const { localDateTimeStr } = require('../utils/datetime');
const { plainText } = require('../utils/markdownText');
const { cleanText, cleanLine, cleanMarkdown, safeUrl, safeEmail, escapeLike, safeCover } = require('../utils/sanitize');
const { securityStats, ban, unban } = require('../middleware/ipGuard');
const { verifyTicket } = require('../middleware/gate');
const { getConfig, saveConfig, isValidIpOrCidr } = require('../utils/securitySettings');
const { RULE_INDEX, scanText, scanAll } = require('../middleware/waf');
const { saveSettings, getAllSettings, ALLOWED_KEYS } = require('../utils/settings');
const { parseImages, serializeImages, buildExcerpt, noteSummary } = require('../utils/notes');
// 阅读统计缓存失效：任何「文章内容 / 发布状态变了」的写操作之后都要调用，
// 否则主页与侧栏的字数、阅读时长最多陈旧 60 秒（cacheInvalidation.test.js 锁死全部路径）。
const { invalidateReadingCache } = require('./stats');
const { invalidateSummaryCache } = require('./home');

const router = express.Router();

// 统一认证：本路由下的全部接口都要求已登录
router.use(authRequired);
// 角色纵深：仅管理员角色可访问后台（当前系统无其他角色，为未来扩展留闸）
router.use((req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ code: 1, message: '访问被拒绝', data: null });
});

/**
 * 主页摘要缓存：**任何成功的后台写请求之后都清一次**。
 *
 * 为什么用一条钩子而不是在每个 handler 里手写一行：`/api/home/summary` 的缓存里
 * 装着文章数、手记数、最近文章与友链（60 秒 TTL）。后台有 20 多个写点，逐个加
 * 「失效调用」漏一处就是长期脏数据，而且**漏了也没有任何现象**——只能靠人记得。
 * 这里按「方法 + 状态码」判定，新增路由自动覆盖，漏不掉。
 *
 * 代价是偶尔多清一次（比如改了个无关配置）。个人站这个量级下，比脏缓存便宜得多。
 */
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode < 400) invalidateSummaryCache();
  });
  return next();
});

// ============ 文章 ============

/** 后台文章列表（含草稿，可筛选状态） */
router.get('/articles/admin/list', async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page) || 1)); // page 上限防超大 offset 拖慢查询
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const { keyword, status, category_id, sort } = req.query;
    const base = db('articles as a')
      .leftJoin('categories as c', 'a.category_id', 'c.id')
      .modify((b) => {
        if (status && status !== 'all') b.where('a.status', status);
        // 分类筛选（整数校验防注入；0=未分类）
        const cid = Number(category_id);
        if (category_id !== undefined && String(category_id).trim() === '0') b.whereNull('a.category_id');
        else if (category_id && Number.isInteger(cid) && cid > 0) b.where('a.category_id', cid);
        if (keyword) {
          const kw = escapeLike(String(keyword).slice(0, 50));
          b.where((q) => q.where('a.title', 'like', `%${kw}%`).orWhere('a.content', 'like', `%${kw}%`));
        }
      });
    // 排序：latest 默认（创建）/ updated 最近更新 / views 浏览量
    const orderBy =
      sort === 'updated'
        ? [{ column: 'a.updated_at', order: 'desc' }, { column: 'a.id', order: 'desc' }]
        : sort === 'views'
          ? [{ column: 'a.views', order: 'desc' }, { column: 'a.id', order: 'desc' }]
          : [{ column: 'a.created_at', order: 'desc' }, { column: 'a.id', order: 'desc' }];

    const [total, rows] = await Promise.all([
      base.clone().count('a.id as cnt').first(),
      base.clone()
        .select('a.id', 'a.title', 'a.slug', 'a.cover', 'a.status', 'a.is_top', 'a.views', 'a.likes',
          'a.published_at', 'a.created_at', 'a.updated_at', 'c.name as category_name')
        .orderBy(orderBy)
        .limit(pageSize).offset((page - 1) * pageSize),
    ]);

    // 标签与评论数装饰
    const ids = rows.map((r) => r.id);
    const tagRows = ids.length
      ? await db('article_tags as at')
          .join('tags as t', 'at.tag_id', 't.id')
          .whereIn('at.article_id', ids)
          .select('at.article_id', 't.id', 't.name', 't.slug')
      : [];
    const tagMap = {};
    for (const r of tagRows) {
      (tagMap[r.article_id] = tagMap[r.article_id] || []).push({ id: r.id, name: r.name, slug: r.slug });
    }
    const commentCounts = ids.length
      ? await db('comments').whereIn('article_id', ids).where('status', 'approved')
          .groupBy('article_id').select('article_id').count('* as cnt')
      : [];
    const countMap = {};
    for (const c of commentCounts) countMap[c.article_id] = Number(c.cnt);

    const list = rows.map((r) => ({
      ...r,
      tags: tagMap[r.id] || [],
      comment_count: countMap[r.id] || 0,
      content: undefined,
    }));
    return ok(res, { list, pagination: { page, pageSize, total: Number(total.cnt || 0) } });
  } catch (e) {
    return fail(res, '获取文章失败', 500);
  }
});

/** 全量文章备份导出（JSON：含正文/标签/分类，用于数据迁移与灾难恢复）
 * 注意：必须定义在 /articles/admin/:id 之前 —— Express 按注册顺序匹配，
 * 否则 ":id" 会吞掉 "export"，导致导出接口永远返回「参数不合法」 */
router.get('/articles/admin/export', async (req, res) => {
  try {
    const rows = await db('articles').orderBy('id', 'asc');
    const ids = rows.map((r) => r.id);
    const tagRows = ids.length
      ? await db('article_tags as at')
          .join('tags as t', 'at.tag_id', 't.id')
          .whereIn('at.article_id', ids)
          .select('at.article_id', 't.name')
      : [];
    const tagMap = {};
    for (const r of tagRows) (tagMap[r.article_id] = tagMap[r.article_id] || []).push(r.name);
    const catIds = [...new Set(rows.map((r) => r.category_id).filter(Boolean))];
    const catRows = catIds.length
      ? await db('categories').whereIn('id', catIds).select('id', 'name', 'slug')
      : [];
    const catMap = {};
    for (const c of catRows) catMap[c.id] = { name: c.name, slug: c.slug };
    const data = {
      meta: {
        app: 'Xalorblog', type: 'articles-backup', version: 2,
        exported_at: new Date().toISOString(), count: rows.length,
      },
      articles: rows.map((r) => ({
        id: r.id, title: r.title, slug: r.slug, summary: r.summary, content: r.content,
        cover: r.cover, status: r.status, is_top: !!r.is_top, views: r.views, likes: r.likes,
        category: r.category_id ? catMap[r.category_id] : null,
        tags: tagMap[r.id] || [],
        published_at: r.published_at, created_at: r.created_at, updated_at: r.updated_at,
      })),
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="articles-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.send(JSON.stringify(data));
  } catch (e) {
    return fail(res, '导出失败', 500);
  }
});

/** 后台单篇详情（编辑用，含加密正文） */
router.get('/articles/admin/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const row = await db('articles').where('id', id).first();
    if (!row) return notFound(res, '文章不存在');
    const tagRows = await db('article_tags as at')
      .join('tags as t', 'at.tag_id', 't.id')
      .where('at.article_id', row.id)
      .select('t.id', 't.name');
    const pass = String(req.headers['x-pass'] || '');
    const { encryptPayload } = require('../utils/crypto');
    const encrypted = pass ? encryptPayload(row.content, pass, row.slug) : '';
    return ok(res, {
      ...row,
      content: encrypted,
      content_enc: !!encrypted,
      content_key: row.slug,
      tags: tagRows.map((t) => t.name),
    });
  } catch (e) {
    return fail(res, '获取文章失败', 500);
  }
});

/** 创建文章 */
router.post('/articles', async (req, res) => {
  try {
    const { title, content, summary, cover, category_id, tags = [], status = 'draft', is_top = false, allow_comment = true, allow_copy = true } = req.body;
    const cleanTitle = cleanLine(title, 200);
    const cleanContent = cleanMarkdown(content, 100000);
    if (!cleanTitle) return fail(res, '标题不能为空');
    if (!cleanContent) return fail(res, '正文不能为空');
    const cleanStatus = status === 'published' ? 'published' : 'draft';
    const cleanIsTop = toBool(is_top, false);
    const cleanAllowComment = toBool(allow_comment, true);
    const cleanAllowCopy = toBool(allow_copy, true);

    // 边界场景：引用的分类已被删除（如另一管理员同时操作）→ 明确拒绝而非写入孤儿 ID
    // 非数值（如 "abc"）显式 400：Number() 得 NaN 直接进查询会变成 500
    let cleanCategoryId = null;
    if (category_id) {
      cleanCategoryId = Number(category_id);
      if (!Number.isInteger(cleanCategoryId) || cleanCategoryId <= 0) return fail(res, '所选分类不合法');
      const cat = await db('categories').where('id', cleanCategoryId).first('id');
      if (!cat) return fail(res, '所选分类不存在，请刷新页面后重试');
    }

    const slug = await uniqueSlug('articles', req.body.slug || cleanTitle);
    /**
     * 发布时间：与 PUT 同一口径（合法的显式时间优先），否则「发布取当前、草稿置 NULL」。
     *
     * 原来这里**完全忽略** body.published_at，于是新建文章时在右侧填的「发布时间」
     * 会被静默丢弃 —— 同一个表单，新建与编辑两种结果，用户只会觉得「有时候不生效」。
     * 注意 null/'' 不覆盖默认值：新建草稿本来就该是 NULL、新建发布本来就该是当前时间，
     * 只有「显式给了合法时间」才用它（想清空请走 PUT，那里有明确的 null 契约）。
     */
    let published_at = cleanStatus === 'published' ? localDateTimeStr() : null;
    const rawPublishedAt = req.body.published_at;
    if (rawPublishedAt !== undefined && rawPublishedAt !== null && String(rawPublishedAt).trim() !== '') {
      if (!isValidDateTime(rawPublishedAt)) return fail(res, '发布时间不是有效日期');
      published_at = String(rawPublishedAt);
    }

    // 事务：文章正文与标签关联原子落库（标签中途失败整体回滚，杜绝半成品文章）
    const trx = await db.transaction();
    let id;
    try {
      [id] = await trx('articles').insert({
        title: cleanTitle, slug, content: cleanContent,
        summary: cleanText(summary || plainText(cleanContent).slice(0, 150), 500),
        cover: safeCover(cover), category_id: cleanCategoryId,
        status: cleanStatus, is_top: cleanIsTop, allow_comment: cleanAllowComment, allow_copy: cleanAllowCopy,
        published_at,
      });

      for (const name of tags) {
        const t = cleanLine(name, 50);
        if (!t) continue;
        const existing = await trx('tags').where('name', t).first();
        let tagId;
        if (existing) {
          tagId = existing.id;
        } else {
          [tagId] = await trx('tags').insert({ name: t, slug: await uniqueSlug('tags', t, { conn: trx }) });
        }
        await trx('article_tags').insert({ article_id: id, tag_id: tagId }).onConflict(['article_id', 'tag_id']).ignore();
      }
      await trx.commit();
    } catch (e) {
      await trx.rollback();
      throw e;
    }
    invalidateReadingCache();
    return ok(res, { id }, '文章创建成功');
  } catch (e) {
    // 并发创建同标题/同 slug 时的唯一约束冲突：给出明确提示而非笼统 500
    if (e.code === 'ER_DUP_ENTRY') {
      return fail(res, '链接地址已存在，请更换标题后重试');
    }
    return fail(res, '创建文章失败', 500);
  }
});

/* ---------- PUT /articles/:id 的「清空语义」解析（纯函数） ----------
 *
 * 缺陷背景：`published_at` 与 `slug` 原来都写成「有值才改」——
 *   - `published_at: ''` 被 `typeof === 'string' && published_at` 挡掉 → 旧时间纹丝不动；
 *   - `slug: ''` 被 `if (slug)` 挡掉 → 旧地址纹丝不动，占位文案「留空自动生成」
 *     只在新建时成立。
 * 结果就是「清空」这个动作在前端看起来成功了（200 + 写库成功），实际什么都没发生。
 *
 * 两端契约（前端 ArticleEdit.vue 与本函数必须一致）：
 *
 * | 前端传值                                  | 行为                                   |
 * |-------------------------------------------|----------------------------------------|
 * | 字段**不出现**（undefined / 无该 key）     | 保持库里的原值（老语义，不能破坏）      |
 * | `published_at: null` 或 `''`（含纯空白）   | 置为 NULL（草稿 / 未排期）              |
 * | `published_at: 'YYYY-MM-DD HH:mm:ss'`      | 合法则写入；非法字符串 → 400 + debug 日志 |
 * | `published_at`: 数字/布尔/对象等非字符串    | 忽略 + 保持原值 + debug 日志（老语义）   |
 * | `slug: ''` / 纯空白 / `null`               | 按标题重新生成（slugify + 去重）        |
 * | `slug: 'xxx'`                              | slugify 归一化 + 去重后写入（老语义）    |
 * | `slug`: 数字/布尔/对象等非字符串            | 忽略 + 保持原值 + debug 日志            |
 *
 * 有一处刻意不按「非法值一律忽略」：**非空但格式非法的日期字符串**仍然 400。
 * 那是既有校验，前端靠这条提示让用户改日期；改成静默忽略会让「我明明填了日期，
 * 保存后却消失了」这个更糟的现象出现 —— 与本次要修的 bug 同型。
 *
 * 为什么抽成纯函数：这段失败方式是「静默不生效」（HTTP 200、落库成功、值不变），
 * 只有真实 MySQL + 三重认证的登录态才能驱动 PUT 路由，离线套件跑不起那套栈。
 * 抽出来后用真实调用钉住每条语义（test/articlePatchContract.test.js），
 * 路由只负责「取行 → 交给它 → 落库 → 回传结果值」。
 *
 * @param {object} body    请求体（未清洗；非对象按空对象处理）
 * @param {object} current 库里当前行（用到 title / slug / status / published_at）
 * @param {object} opts    { existingSlugs, now, log }
 *        existingSlugs 必须**已排除本文自身** —— 老语义里自己的 slug 不与自己冲突。
 * @returns {{ patch: object, changed: object, error: string|null }}
 *        changed 只记录真正接受的改动：{ slug?: string, published_at?: 'set'|'cleared', status?: string }
 */
function resolveArticlePatch(body, current = {}, opts = {}) {
  const src = body && typeof body === 'object' ? body : {};
  const cur = current && typeof current === 'object' ? current : {};
  const existingSlugs = Array.isArray(opts.existingSlugs) ? opts.existingSlugs : [];
  const nowStr = typeof opts.now === 'string' && opts.now ? opts.now : localDateTimeStr();
  const log = typeof opts.log === 'function' ? opts.log : defaultArticlePatchLog;

  const patch = {};
  const changed = {};
  // 必须用 hasOwnProperty：`=== undefined` 无法区分「没传这个字段」与「显式传了 null」——
  // 而这两个在本次契约里语义正好相反（不动 vs 清空）。
  const has = (key) => Object.prototype.hasOwnProperty.call(src, key);

  // ---- status：发布状态（含「首次发布补当前时间」的老语义） ----
  if (has('status') && src.status !== undefined) {
    if (!isOneOf(ARTICLE_STATUS, src.status)) {
      return { patch, changed, error: '非法状态' };
    }
    if (src.status !== cur.status) {
      patch.status = src.status;
      changed.status = src.status;
      if (src.status === 'published' && !cur.published_at) {
        patch.published_at = nowStr;
        changed.published_at = 'set';
      }
    }
  }

  // ---- published_at：手动排期 / 清空排期 ----
  // 放在 status 之后：用户显式清空时，必须压掉上面「首次发布补当前时间」的结果。
  if (has('published_at') && src.published_at !== undefined) {
    const v = src.published_at;
    if (v === null || (typeof v === 'string' && v.trim() === '')) {
      patch.published_at = null;
      changed.published_at = 'cleared';
    } else if (typeof v === 'string') {
      if (!isValidDateTime(v)) {
        log(`published_at 不是有效日期，已拒绝并保持原值：${JSON.stringify(v)}`);
        return { patch, changed, error: '发布时间不是有效日期' };
      }
      patch.published_at = v;
      changed.published_at = 'set';
    } else {
      log(`published_at 类型不支持（${typeof v}），已忽略并保持原值`);
    }
  }

  // ---- slug：自定义地址 / 清空后按标题重生成 ----
  if (has('slug') && src.slug !== undefined) {
    const v = src.slug;
    const cleared = v === null || (typeof v === 'string' && v.trim() === '');
    if (cleared) {
      // 排序：标题也可能在同一次请求里被改，优先用新标题
      const newTitle = has('title') ? cleanLine(src.title, 200) : '';
      const base = newTitle || String(cur.title || '');
      const next = slugify(base, existingSlugs);
      patch.slug = next;
      changed.slug = next;
      log(`slug 被清空 → 按标题重新生成：${next}`);
    } else if (typeof v === 'string') {
      const next = slugify(v, existingSlugs);
      patch.slug = next;
      changed.slug = next;
    } else {
      log(`slug 类型不支持（${typeof v}），已忽略并保持原值`);
    }
  }

  return { patch, changed, error: null };
}

/** 契约相关的 debug 日志：排查「为什么我传的值没存上」时唯一的线索。
 *  用 console.debug（Node 下走 stdout），不引入日志依赖、不污染业务错误日志。 */
function defaultArticlePatchLog(message) {
  console.debug(`[admin:article-patch] ${message}`);
}

/** 更新文章 */
router.put('/articles/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const row = await db('articles').where('id', id).first();
    if (!row) return notFound(res, '文章不存在');

    const { title, content, summary, cover, category_id, tags, is_top, allow_comment, allow_copy } = req.body;
    // 契约相关的字段（status / published_at / slug）不进解构：它们由 resolveArticlePatch 统一解析
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = { updated_at: db.fn.now() };
    if (title !== undefined) {
      // 空标题显式 400：cleanLine('') 得空串，直接落库触发 notNullable → 500
      const cleanTitle = cleanLine(title, 200);
      if (!cleanTitle) return fail(res, '标题不能为空');
      patch.title = cleanTitle;
    }
    if (content !== undefined) patch.content = cleanMarkdown(content, 100000);
    if (summary !== undefined) patch.summary = cleanText(summary, 500);
    if (cover !== undefined) patch.cover = safeCover(cover);
    if (category_id !== undefined) {
      // 非数值（如 "abc"）显式 400：NaN 进查询会变成 500
      let cleanCategoryId = null;
      if (category_id) {
        cleanCategoryId = Number(category_id);
        if (!Number.isInteger(cleanCategoryId) || cleanCategoryId <= 0) return fail(res, '所选分类不合法');
        // 边界场景：引用的分类已被删除 → 明确拒绝而非写入孤儿 ID
        const cat = await db('categories').where('id', cleanCategoryId).first('id');
        if (!cat) return fail(res, '所选分类不存在，请刷新页面后重试');
      }
      patch.category_id = cleanCategoryId;
    }
    if (is_top !== undefined) patch.is_top = toBool(is_top, row.is_top);
    if (allow_comment !== undefined) patch.allow_comment = toBool(allow_comment, row.allow_comment);
    if (allow_copy !== undefined) patch.allow_copy = toBool(allow_copy, row.allow_copy);
    // status / published_at / slug 三个字段是「清空语义」的争议点，统一交给纯函数解析
    // （契约表在 resolveArticlePatch 上方）。这里只负责：查一次去重整备列表 → 合并 patch。
    const slugTouched = Object.prototype.hasOwnProperty.call(body, 'slug') && body.slug !== undefined;
    // 只有真正在动 slug 时才查一次（免得改正文也白搭一次 pluck）
    const existingSlugs = slugTouched ? await db('articles').whereNot('id', id).pluck('slug') : [];
    const { patch: resolved, changed, error: patchError } = resolveArticlePatch(body, row, { existingSlugs });
    if (patchError) return fail(res, patchError, 400);
    Object.assign(patch, resolved);
    // 事务：正文更新与标签重建原子执行（中途失败整体回滚）
    const trx = await db.transaction();
    try {
      await trx('articles').where('id', id).update(patch);

      if (Array.isArray(tags)) {
        await trx('article_tags').where('article_id', id).del();
        for (const name of tags) {
          const t = cleanLine(name, 50);
          if (!t) continue;
          let tagRow = await trx('tags').where('name', t).first();
          let tagId;
          if (tagRow) {
            tagId = tagRow.id;
          } else {
            [tagId] = await trx('tags').insert({ name: t, slug: await uniqueSlug('tags', t, { conn: trx }) });
          }
          await trx('article_tags').insert({ article_id: id, tag_id: tagId }).onConflict(['article_id', 'tag_id']).ignore();
        }
      }
      await trx.commit();
    } catch (e) {
      await trx.rollback();
      throw e;
    }
    invalidateReadingCache();
    // 回传**结果值**而不是 null（本次契约的一部分）：
    //   ① slug 被清空时是由后端按标题重新生成的，前端不知道新值 —— 不回传就会出现
    //      「输入框空着、真实地址却是别的」，用户下一次保存又会触发一次重生成；
    //   ② published_at 被清空时必须回传 null，前端才能把日期框同步清掉，
    //      也才能区分「后端收到 null（清空）」与「后端没收到这个字段（保持原值）」。
    // 老调用方（如 ArticleManage 的批量发布只读 code/message）不读 data，新增字段不影响它们。
    return ok(res, {
      id,
      slug: changed.slug !== undefined ? changed.slug : (row.slug || ''),
      published_at: changed.published_at ? (patch.published_at ?? null) : (row.published_at ?? null),
      status: changed.status !== undefined ? changed.status : row.status,
    }, '文章更新成功');
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return fail(res, '链接地址已存在，请更换 slug 或标题后重试');
    }
    return fail(res, '更新文章失败', 500);
  }
});

/** 复制文章：克隆为新草稿（标题加"副本"后缀、slug 重新生成、阅读/点赞归零），标签一并复制 */
router.post('/articles/:id/duplicate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const row = await db('articles').where('id', id).first();
    if (!row) return notFound(res, '文章不存在');
    const tagRows = await db('article_tags').where('article_id', id).pluck('tag_id');
    const newId = await db.transaction(async (trx) => {
      // 标题去重：已有副本时追加递增序号（「（副本）」「（副本 2）」「（副本 3）」…）
      //
      // ⚠ 不能只数「以（副本）开头」的数量。原实现是
      //   count(title LIKE '原标题（副本）%')，然后拿 count+1 当序号 ——
      // 第二次复制时标题变成「原标题（副本 2）」，它**不再**以「原标题（副本）」开头
      // （中间多了一个空格和数字），于是 count 永远停在 1，第 3、4、5 次
      // 全都生成同一个「原标题（副本 2）」。实测连按 4 次得到
      // [副本, 副本 2, 副本 2, 副本 2]。slug 因为有 slugify 兜底没撞，
      // 所以列表里只有标题重复 —— 更难被发现。
      //
      // 正解：把已存在的**全部**同族标题取回来，解析出各自用掉的序号，
      // 取最大值 +1。这样与历史数据也兼容（哪怕早年手工改过标题）。
      const baseTitle = cleanLine(row.title, 190);
      const prefix = `${baseTitle}（副本`;
      const existing = await trx('articles')
        .where('title', 'like', `${prefix.replace(/[%_\\]/g, '\\$&')}%`)
        .pluck('title');
      // 「（副本）」记作 1，「（副本 N）」记作 N
      let maxSeq = 0;
      for (const t of existing) {
        const m = String(t).match(/（副本(?: (\d+))?）\s*$/);
        if (!m) continue;
        const n = m[1] ? Number(m[1]) : 1;
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
      const seq = maxSeq + 1;
      const title = seq === 1
        ? `${baseTitle}（副本）`.slice(0, 200)
        : `${cleanLine(row.title, 186)}（副本 ${seq}）`.slice(0, 200);
      const [aid] = await trx('articles').insert({
        title,
        slug: await uniqueSlug('articles', title, { conn: trx }),
        summary: row.summary || '',
        content: row.content || '',
        cover: row.cover || '',
        category_id: row.category_id,
        status: 'draft',
        is_top: false,
        allow_comment: row.allow_comment,
        allow_copy: row.allow_copy,
        views: 0,
        likes: 0,
        published_at: null,
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
      if (tagRows.length) {
        await trx('article_tags')
          .insert(tagRows.map((tid) => ({ article_id: aid, tag_id: tid })))
          .onConflict(['article_id', 'tag_id'])
          .ignore();
      }
      return aid;
    });
    invalidateReadingCache();
    return ok(res, { id: newId }, '已复制为新草稿');
  } catch (e) {
    return fail(res, '复制失败', 500);
  }
});

/** 删除文章（显式清理评论与标签关联，与数据库外键 CASCADE 双保险） */
router.delete('/articles/:id', async (req, res) => {  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    // 事务：子数据清理 + 主删除原子提交，中途失败整体回滚（防半删状态）
    await db.transaction(async (trx) => {
      await trx('article_tags').where('article_id', id).del();
      await trx('comments').where('article_id', id).del();
      await trx('articles').where('id', id).del();
    });
    invalidateReadingCache();
    return ok(res, null, '文章已删除');
  } catch (e) {
    return fail(res, '删除文章失败', 500);
  }
});

/** 批量删除文章（事务原子性，与单删同语义） */
router.post('/articles/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择要删除的文章');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db.transaction(async (trx) => {
      await trx('article_tags').whereIn('article_id', safeIds).del();
      await trx('comments').whereIn('article_id', safeIds).del();
      await trx('articles').whereIn('id', safeIds).del();
    });
    invalidateReadingCache();
    return ok(res, { deleted: safeIds.length }, `已删除 ${safeIds.length} 篇文章`);
  } catch (e) {
    return fail(res, '批量删除失败', 500);
  }
});

/** 批量操作：发布/草稿/置顶 */
router.post('/articles/batch-update', async (req, res) => {
  try {
    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择文章');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    const patch = {};
    if (action === 'publish') {
      // 仅对尚未发布过的文章补 published_at，避免覆盖原始发布时间
      // 事务保证补时间与状态更新原子生效（中途失败不会留下"有发布时间的草稿"）
      const trx = await db.transaction();
      try {
        const needDate = await trx('articles')
          .whereIn('id', safeIds)
          .whereNull('published_at')
          .pluck('id');
        if (needDate.length) {
          await trx('articles').whereIn('id', needDate).update({ published_at: localDateTimeStr() });
        }
        await trx('articles').whereIn('id', safeIds).update({ status: 'published', updated_at: db.fn.now() });
        await trx.commit();
      } catch (e) {
        await trx.rollback();
        throw e;
      }
      invalidateReadingCache();
      return ok(res, { affected: safeIds.length }, `已发布 ${safeIds.length} 篇文章`);
    }
    else if (action === 'draft') patch.status = 'draft';
    else if (action === 'top') patch.is_top = true;
    else if (action === 'untop') patch.is_top = false;
    else if (action === 'set-category') {
      // 批量设置分类：整数校验 + 存在性校验（0 = 移出分类）
      const cid = Number(req.body.categoryId);
      if (!Number.isInteger(cid) || cid < 0) return fail(res, '请选择分类');
      if (cid > 0) {
        const cat = await db('categories').where('id', cid).first('id');
        if (!cat) return fail(res, '所选分类不存在');
      }
      patch.category_id = cid > 0 ? cid : null;
    }
    else if (action === 'add-tag') {
      // 批量追加标签：查找或创建标签，为选中文章批量关联（已存在自动忽略）
      const tagName = cleanLine(req.body.tagName, 50);
      if (!tagName) return fail(res, '请提供标签名');
      let tagRow = await db('tags').where('name', tagName).first();
      let tagId;
      if (tagRow) {
        tagId = tagRow.id;
      } else {
        [tagId] = await db('tags').insert({ name: tagName, slug: await uniqueSlug('tags', tagName) });
      }
      await db('article_tags')
        .insert(safeIds.map((aid) => ({ article_id: aid, tag_id: tagId })))
        .onConflict(['article_id', 'tag_id'])
        .ignore();
      patch.updated_at = db.fn.now();
      await db('articles').whereIn('id', safeIds).update(patch);
      return ok(res, { affected: safeIds.length }, `已为 ${safeIds.length} 篇文章添加标签「${tagName}」`);
    }
    else return fail(res, '未知操作');
    patch.updated_at = db.fn.now();
    await db('articles').whereIn('id', safeIds).update(patch);
    invalidateReadingCache();
    return ok(res, { affected: safeIds.length }, `已更新 ${safeIds.length} 篇文章`);
  } catch (e) {
    return fail(res, '批量操作失败', 500);
  }
});

/**
 * 文章备份导入（合并语义，分片调用）：
 * 按 slug 查重跳过已存在（不覆盖）；分类/标签按名称查找或创建。
 * 单片上限 300 篇 —— 低于 WAF JSON 炸弹防护的数组长度上限与 body 体积上限，
 * 且仅接收秘钥路径 + 三重认证请求，安全防线零改动。
 */
router.post('/articles/admin/import', async (req, res) => {
  try {
    const items = (req.body || {}).items;
    if (!Array.isArray(items) || !items.length) return fail(res, '导入内容为空');
    if (items.length > 300) return fail(res, '单次导入不得超过 300 篇');
    let imported = 0;
    let skipped = 0;
    await db.transaction(async (trx) => {
      for (const it of items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          skipped += 1;
          continue;
        }
        const title = cleanLine(it.title, 200);
        if (!title) { skipped += 1; continue; }
        // 备份是外部输入（导出的 JSON 会被下载、改过、再传回来），必须与创建/更新
        // 同等清洗，否则恢复路径成为唯一绕过点：content 原样入库就把 <script> /
        // <iframe> 直接写回正文列（存储型 XSS，前台渲染即执行）。
        const rawContent = String(it.content || '');
        if (!rawContent) { skipped += 1; continue; }
        if (rawContent.length > 100000) { skipped += 1; continue; }
        // 与创建（上方 POST /articles）和更新（PUT /articles/:id）完全同一个函数、
        // 同一个上限：内联事件属性（onerror/onload）也一并由它按相同规则处理，
        // 三条写入路径因此产出一致的净化结果，不再有「哪条路径更宽松」的差异。
        const content = cleanMarkdown(rawContent, 100000);
        if (!content) { skipped += 1; continue; }
        // 导入 slug 与创建/更新保持一致的白名单清洗（slugify 输出等价：
        // 小写字母/数字/中文/连字符，≤80）—— 脏 slug（含 / . .. 空格等）若直接
        // 入库会污染 URL 面（分享页路径分裂），此处不符即回退自动生成
        const rawSlug = String(it.slug || '').slice(0, 80);
        const slug = /^[a-z0-9\u4e00-\u9fa5-]+$/i.test(rawSlug) ? rawSlug : '';
        if (slug) {
          const exist = await trx('articles').where('slug', slug).first('id');
          if (exist) { skipped += 1; continue; }
        }
        // 分类：按名称查找或创建
        let category_id = null;
        if (it.category && typeof it.category === 'object' && it.category.name) {
          const cname = cleanLine(it.category.name, 50);
          if (!cname) {
            category_id = null;
          } else {
          let cat = await trx('categories').where('name', cname).first('id');
          if (!cat) {
            const [cid] = await trx('categories').insert({
              name: cname,
              slug: await uniqueSlug('categories', cname, { conn: trx }),
            });
            cat = { id: cid };
          }
          category_id = cat.id;
          }
        }
        const now = db.fn.now();
        const [aid] = await trx('articles').insert({
          title,
          slug: slug || await uniqueSlug('articles', title, { conn: trx }),
          summary: cleanLine(it.summary, 300),
          content,
          // 封面：允许站内相对路径（/uploads/xxx.png，本站导出格式），
          // 其余必须通过 safeUrl（http/https + 非内网 + 无危险协议）
          cover: safeCover(it.cover),
          status: it.status === 'published' ? 'published' : 'draft',
          is_top: toBool(it.is_top, false),
          views: Math.max(0, Math.min(9999999, Number(it.views) || 0)),
          likes: Math.max(0, Math.min(9999999, Number(it.likes) || 0)),
          category_id,
          published_at: isValidDateTime(String(it.published_at || '')) ? it.published_at : null,
          created_at: isValidDateTime(String(it.created_at || '')) ? it.created_at : now,
          updated_at: now,
        });
        // 标签：按名称查找或创建
        const tagNames = Array.isArray(it.tags)
          ? [...new Set(it.tags.map((t) => {
              if (t == null) return '';
              const raw = typeof t === 'object' ? t.name : t;
              return cleanLine(raw, 50);
            }).filter(Boolean))]
          : [];
        const tagIds = [];
        for (const tn of tagNames) {
          let tag = await trx('tags').where('name', tn).first('id');
          if (!tag) {
            const [tid] = await trx('tags').insert({ name: tn, slug: await uniqueSlug('tags', tn, { conn: trx }) });
            tag = { id: tid };
          }
          tagIds.push(tag.id);
        }
        if (tagIds.length) {
          await trx('article_tags')
            .insert(tagIds.map((tid) => ({ article_id: aid, tag_id: tid })))
            .onConflict(['article_id', 'tag_id'])
            .ignore();
        }
        imported += 1;
      }
    });
    invalidateReadingCache();
    return ok(res, { imported, skipped }, `导入完成：新增 ${imported} 篇，跳过 ${skipped} 篇`);
  } catch (e) {
    return fail(res, '导入失败', 500);
  }
});

// ============ 手记（个人主页） ============

/** 后台手记列表（含草稿，可筛选状态/关键词） */
router.get('/notes/admin/list', async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const { keyword, status, sort } = req.query;
    const base = db('notes').modify((b) => {
      if (status && status !== 'all') b.where('status', status);
      if (keyword) {
        const kw = escapeLike(String(keyword).slice(0, 50));
        b.where((q) => q.where('content', 'like', `%${kw}%`).orWhere('excerpt', 'like', `%${kw}%`));
      }
    });
    const countRow = await base.clone().count('* as cnt').first();
    const total = Number(countRow?.cnt || 0);
    const orderBy =
      sort === 'oldest'
        ? [{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]
        : [{ column: 'is_pinned', order: 'desc' }, { column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }];
    const rows = await base
      .clone()
      .select(
        'id', 'content', 'images', 'excerpt', 'mood', 'location',
        'likes', 'is_pinned', 'status', 'published_at', 'created_at', 'updated_at'
      )
      .orderBy(orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    // 列表仍走 noteSummary 白名单（含摘要），仅额外附带正文供后台预览/编辑；
    // 后台整体在鉴权 + 秘钥路径之内，与前台免票接口的暴露面无关
    return ok(res, {
      list: rows.map((r) => ({ ...noteSummary(r), content: r.content })),
      pagination: { page, pageSize, total },
    });
  } catch (e) {
    return fail(res, '获取手记列表失败', 500);
  }
});

/** 后台手记详情（正文按篇加密下发，前端解密后编辑） */
router.get('/notes/admin/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const row = await db('notes').where('id', id).first();
    if (!row) return notFound(res, '手记不存在');
    const { encryptPayload } = require('../utils/crypto');
    const { noteContentKey } = require('./notes');
    const pass = String(req.headers['x-pass'] || '');
    const contentKey = noteContentKey(id);
    const encrypted = pass ? encryptPayload(row.content, pass, contentKey) : '';
    return ok(res, {
      ...row,
      images: parseImages(row.images),
      content: encrypted,
      content_enc: !!encrypted,
      content_key: contentKey,
    });
  } catch (e) {
    return fail(res, '获取手记失败', 500);
  }
});

/** 创建手记 */
router.post('/notes', async (req, res) => {
  try {
    const { content, images = [], mood = '', location = '', excerpt = '', status = 'draft', is_pinned = false } = req.body || {};
    const cleanContent = cleanMarkdown(content, 20000);
    if (!cleanContent) return fail(res, '手记内容不能为空');
    const cleanStatus = status === 'published' ? 'published' : 'draft';
    const [id] = await db('notes').insert({
      content: cleanContent,
      images: serializeImages(images),
      excerpt: cleanText(excerpt, 500) || buildExcerpt(cleanContent),
      mood: cleanLine(mood, 40),
      location: cleanLine(location, 80),
      likes: 0,
      is_pinned: toBool(is_pinned, false),
      status: cleanStatus,
      published_at: cleanStatus === 'published' ? localDateTimeStr() : null,
    });
    return ok(res, { id }, '手记已创建');
  } catch (e) {
    return fail(res, '创建手记失败', 500);
  }
});

/** 更新手记 */
router.put('/notes/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const row = await db('notes').where('id', id).first();
    if (!row) return notFound(res, '手记不存在');

    const { content, images, mood, location, excerpt, status, is_pinned } = req.body || {};
    const patch = { updated_at: db.fn.now() };
    if (content !== undefined) {
      const cleanContent = cleanMarkdown(content, 20000);
      if (!cleanContent) return fail(res, '手记内容不能为空');
      patch.content = cleanContent;
      if (excerpt === undefined) patch.excerpt = buildExcerpt(cleanContent);
    }
    if (images !== undefined) patch.images = serializeImages(images);
    if (excerpt !== undefined) patch.excerpt = cleanText(excerpt, 500);
    if (mood !== undefined) patch.mood = cleanLine(mood, 40);
    if (location !== undefined) patch.location = cleanLine(location, 80);
    if (is_pinned !== undefined) patch.is_pinned = toBool(is_pinned, false);
    if (status !== undefined) {
      const cleanStatus = status === 'published' ? 'published' : 'draft';
      patch.status = cleanStatus;
      // 首次发布才补发布时间，避免编辑既有已发布手记时把时间刷新到当下
      if (cleanStatus === 'published' && !row.published_at) patch.published_at = localDateTimeStr();
    }
    await db('notes').where('id', id).update(patch);
    return ok(res, null, '手记已更新');
  } catch (e) {
    return fail(res, '更新手记失败', 500);
  }
});

/** 删除手记 */
router.delete('/notes/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    await db('notes').where('id', id).del();
    return ok(res, null, '手记已删除');
  } catch (e) {
    return fail(res, '删除手记失败', 500);
  }
});

/** 批量删除手记 */
router.post('/notes/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择要删除的手记');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db('notes').whereIn('id', safeIds).del();
    return ok(res, { deleted: safeIds.length }, `已删除 ${safeIds.length} 条手记`);
  } catch (e) {
    return fail(res, '批量删除失败', 500);
  }
});

/** 批量操作：发布/草稿/置顶/取消置顶 */
router.post('/notes/batch-update', async (req, res) => {
  try {
    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择手记');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');

    if (action === 'pin' || action === 'unpin') {
      await db('notes').whereIn('id', safeIds).update({ is_pinned: action === 'pin', updated_at: db.fn.now() });
      return ok(res, null, action === 'pin' ? '已置顶' : '已取消置顶');
    }
    if (action !== 'publish' && action !== 'draft') return fail(res, '不支持的操作');

    if (action === 'publish') {
      // 事务：补发布时间与状态更新原子生效（与文章批量发布同一语义）
      const trx = await db.transaction();
      try {
        const needDate = await trx('notes').whereIn('id', safeIds).whereNull('published_at').pluck('id');
        if (needDate.length) {
          await trx('notes').whereIn('id', needDate).update({ published_at: localDateTimeStr() });
        }
        await trx('notes').whereIn('id', safeIds).update({ status: 'published', updated_at: trx.fn.now() });
        await trx.commit();
      } catch (e) {
        await trx.rollback();
        throw e;
      }
    } else {
      await db('notes').whereIn('id', safeIds).update({ status: 'draft', updated_at: db.fn.now() });
    }
    return ok(res, null, action === 'publish' ? '已发布' : '已转为草稿');
  } catch (e) {
    return fail(res, '批量操作失败', 500);
  }
});

// ============ 分类 ============

/** 分类颜色白名单：必须为 #RRGGBB 十六进制（与前端校验一致；防止任意字符串
 * 经 CSS 变量注入额外声明 —— 管理员虽为信任方，纵深仍应收紧） */
function validHexColor(color) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#e4573d';
}

/** 布尔值归一化：兼容 true/'true'/1/'1'，非法值回退默认 */
function toBool(value, fallback) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function isValidDateTime(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return false;
  const d = new Date(value.replace(' ', 'T'));
  return d.getFullYear() === Number(m[1])
    && d.getMonth() + 1 === Number(m[2])
    && d.getDate() === Number(m[3])
    && d.getHours() === Number(m[4])
    && d.getMinutes() === Number(m[5])
    && d.getSeconds() === Number(m[6]);
}

/** 创建分类 */
router.post('/categories', async (req, res) => {
  try {
    const { name, description = '', color = '#e4573d', slug } = req.body;
    const cleanName = cleanLine(name, 50);
    if (!cleanName) return fail(res, '分类名称不能为空');
    await db('categories').insert({
      name: cleanName,
      slug: await uniqueSlug('categories', slug || cleanName),
      description: cleanLine(description, 255), color: validHexColor(color),
    });
    return ok(res, null, '分类创建成功');
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return fail(res, '分类名称已存在');
    return fail(res, '创建分类失败', 500);
  }
});

/** 更新分类 */
router.put('/categories/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const { name, description, color, slug, sort } = req.body;
    const patch = {};
    if (name !== undefined) {
      // 传了 name 就必须清洗后仍非空。
      // 原来这里直接 patch.name = cleanLine(name, 50) ——
      // 传空串会得到一个 name:'' 的 patch 并照常 update，
      // 分类名于是可以被改成空白，前台分类列表出现无名条目。
      // （创建接口有 `if (!cleanName) return fail(...)`，更新接口漏了同一道检查。）
      const cleanName = cleanLine(name, 50);
      if (!cleanName) return fail(res, '分类名称不能为空');
      patch.name = cleanName;
    }
    if (description !== undefined) patch.description = cleanLine(description, 255);
    if (color !== undefined) patch.color = validHexColor(color);
    if (slug) {
      patch.slug = await uniqueSlug('categories', slug, { excludeId: id });
    } else if (name !== undefined && patch.name) {
      patch.slug = await uniqueSlug('categories', patch.name, { excludeId: id });
    }
    // 排序值（0-100 整数）：前台展示顺序
    if (sort !== undefined) {
      const n = Number(sort);
      if (!Number.isInteger(n) || n < 0 || n > 100) return fail(res, '排序值需为 0-100 的整数');
      patch.sort = n;
    }
    await db('categories').where('id', id).update(patch);
    return ok(res, null, '分类更新成功');
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return fail(res, '分类名称已存在');
    return fail(res, '更新分类失败', 500);
  }
});

/** 删除分类（事务：解除文章关联 + 删除，原子提交防半删） */
router.delete('/categories/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    await db.transaction(async (trx) => {
      await trx('articles').where('category_id', id).update({ category_id: null });
      await trx('categories').where('id', id).del();
    });
    return ok(res, null, '分类已删除，相关文章已移至未分类');
  } catch (e) {
    return fail(res, '删除分类失败', 500);
  }
});

// ============ 标签 ============

/** 创建标签 */
router.post('/tags', async (req, res) => {
  try {
    const name = cleanLine(req.body.name, 50);
    if (!name) return fail(res, '标签名称不能为空');
    const existing = await db('tags').where('name', name).first();
    if (existing) return fail(res, '标签已存在');
    await db('tags').insert({ name, slug: await uniqueSlug('tags', name) });
    return ok(res, null, '标签创建成功');
  } catch (e) {
    return fail(res, '创建标签失败', 500);
  }
});

/** 删除标签（事务：清理关联 + 删除，原子提交防半删） */
router.delete('/tags/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    await db.transaction(async (trx) => {
      await trx('article_tags').where('tag_id', id).del();
      await trx('tags').where('id', id).del();
    });
    return ok(res, null, '标签已删除');
  } catch (e) {
    return fail(res, '删除标签失败', 500);
  }
});

/** 合并标签：将 from 的文章关联转移至 to（重复自动忽略），随后删除 from。
 * 场景：同义/误建标签去重（如「Vue」「Vue3」合并） */
router.post('/tags/merge', async (req, res) => {
  try {
    const fromId = Number(req.body.from_id);
    const toId = Number(req.body.to_id);
    if (!Number.isInteger(fromId) || fromId <= 0 || !Number.isInteger(toId) || toId <= 0) {
      return fail(res, '参数不合法');
    }
    if (fromId === toId) return fail(res, '不能合并到自身');
    let merged = null;
    await db.transaction(async (trx) => {
      const from = await trx('tags').where('id', fromId).first('id', 'name');
      const to = await trx('tags').where('id', toId).first('id', 'name');
      if (!from || !to) return; // 任一方不存在：回滚且标记未合并
      const articleIds = await trx('article_tags').where('tag_id', fromId).pluck('article_id');
      await trx('article_tags').where('tag_id', fromId).del();
      if (articleIds.length) {
        await trx('article_tags')
          .insert(articleIds.map((aid) => ({ article_id: aid, tag_id: toId })))
          .onConflict(['article_id', 'tag_id'])
          .ignore();
      }
      await trx('tags').where('id', fromId).del();
      merged = { from: from.name, to: to.name };
    });
    if (!merged) return fail(res, '标签不存在', 404);
    return ok(res, null, `已将「${merged.from}」合并至「${merged.to}」`);
  } catch (e) {
    return fail(res, '合并标签失败', 500);
  }
});

// ============ 评论 ============

/** 后台评论列表（含待审核） */
router.get('/comments/admin/list', async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page) || 1)); // page 上限防超大 offset 拖慢查询
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const { status, keyword, ai_only, article_id } = req.query;

    const base = db('comments as c')
      .join('articles as a', 'c.article_id', 'a.id')
      .modify((b) => {
        if (status && status !== 'all') b.where('c.status', status);
        // 按文章筛选（整数校验防注入）
        const aid = Number(article_id);
        if (article_id && Number.isInteger(aid) && aid > 0) b.where('c.article_id', aid);
        // 仅看 AI 标记的评论（复核/批量处理入口）
        if (ai_only === '1') {
          b.whereNotNull('c.ai_reason').where('c.ai_reason', '!=', '');
        }
        // 关键词搜索：昵称/内容/文章标题（LIMIT 50 防超长输入 + 通配符转义）
        if (keyword) {
          const kw = escapeLike(String(keyword).slice(0, 50));
          b.where((q) => {
            q.where('c.nickname', 'like', `%${kw}%`)
              .orWhere('c.content', 'like', `%${kw}%`)
              .orWhere('a.title', 'like', `%${kw}%`);
          });
        }
      });

    const [total, rows] = await Promise.all([
      base.clone().count('c.id as cnt').first(),
      base.clone()
        .leftJoin('comments as p', 'p.id', 'c.parent_id')
        .select('c.id', 'c.article_id', 'c.parent_id', 'c.nickname', 'c.email', 'c.content',
          'c.status', 'c.likes', 'c.created_at', 'c.ip', 'c.ai_reason', 'a.title as article_title', 'a.slug as article_slug',
          'p.nickname as parent_nickname')
        .orderBy([{ column: 'c.created_at', order: 'desc' }, { column: 'c.id', order: 'desc' }])
        .limit(pageSize).offset((page - 1) * pageSize),
    ]);
    return ok(res, { list: rows, pagination: { page, pageSize, total: Number(total.cnt || 0) } });
  } catch (e) {
    return fail(res, '获取评论失败', 500);
  }
});

/** 评论全量导出 CSV（审核备份/分析；最近 1000 条，尊重当前筛选；公式注入防护） */
router.get('/comments/admin/export', async (req, res) => {
  try {
    const { status, keyword, ai_only, article_id } = req.query;
    const base = db('comments as c')
      .leftJoin('articles as a', 'c.article_id', 'a.id')
      .modify((b) => {
        if (status && status !== 'all') b.where('c.status', status);
        const aid = Number(article_id);
        if (article_id && Number.isInteger(aid) && aid > 0) b.where('c.article_id', aid);
        if (ai_only === '1') {
          b.whereNotNull('c.ai_reason').where('c.ai_reason', '!=', '');
        }
        if (keyword) {
          const kw = escapeLike(String(keyword).slice(0, 50));
          b.where((q) => {
            q.where('c.nickname', 'like', `%${kw}%`)
              .orWhere('c.content', 'like', `%${kw}%`)
              .orWhere('a.title', 'like', `%${kw}%`);
          });
        }
      });
    const rows = await base
      .orderBy([{ column: 'c.created_at', order: 'desc' }, { column: 'c.id', order: 'desc' }])
      .limit(1000)
      .select('c.id', 'c.nickname', 'c.email', 'c.content', 'c.status', 'c.ai_reason', 'c.created_at', 'a.title as article_title');
    const esc = (s) => {
      const str = String(s ?? '');
      const safe = /^[=+\-@\t\r]/.test(str.trimStart()) ? `'${str}` : str;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    // 状态中文化（导出可读性）
    const statusZh = REVIEW_STATUS_ZH;
    const header = ['ID', '昵称', '邮箱', '内容', '状态', 'AI 标记', '时间', '文章'].map(esc).join(',');
    const lines = rows.map((r) =>
      [r.id, r.nickname, r.email, r.content, statusZh[r.status] || r.status, r.ai_reason, r.created_at, r.article_title].map(esc).join(',')
    );
    const csv = '\ufeff' + [header, ...lines].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="comments-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (e) {
    return fail(res, '导出失败', 500);
  }
});

/** 审核评论 */
router.put('/comments/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const { status } = req.body;
    if (!isOneOf(REVIEW_STATUS, status)) return fail(res, '非法状态');
    await db('comments').where('id', id).update({ status });
    return ok(res, null, '评论状态已更新');
  } catch (e) {
    return fail(res, '更新评论失败', 500);
  }
});

/** 删除评论（显式清理子回复，与数据库外键 CASCADE 双保险） */
router.delete('/comments/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    await db('comments').where('parent_id', id).del();
    await db('comments').where('id', id).del();
    return ok(res, null, '评论已删除');
  } catch (e) {
    return fail(res, '删除评论失败', 500);
  }
});

/** 批量删除评论（显式清理子回复，事务保护） */
router.post('/comments/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择要删除的评论');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db.transaction(async (trx) => {
      await trx('comments').whereIn('parent_id', safeIds).del();
      await trx('comments').whereIn('id', safeIds).del();
    });
    return ok(res, { deleted: safeIds.length }, `已删除 ${safeIds.length} 条评论`);
  } catch (e) {
    return fail(res, '批量删除失败', 500);
  }
});

/** 批量审核评论 */
router.post('/comments/batch-status', async (req, res) => {
  try {
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择评论');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    if (!isOneOf(REVIEW_STATUS, status)) return fail(res, '非法状态');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db('comments').whereIn('id', safeIds).update({ status });
    return ok(res, { affected: safeIds.length }, `已更新 ${safeIds.length} 条评论`);
  } catch (e) {
    return fail(res, '批量操作失败', 500);
  }
});

/** 全部通过（审核工作流提速）：当前待审评论一键通过（上限 1000，防超大事务） */
router.post('/comments/approve-all', async (req, res) => {
  try {
    const pendingIds = await db('comments')
      .where('status', 'pending')
      .limit(1000)
      .pluck('id');
    if (!pendingIds.length) return ok(res, { affected: 0 }, '暂无待审评论');
    const affected = await db('comments').whereIn('id', pendingIds).update({ status: 'approved' });
    return ok(res, { affected }, `已通过 ${affected} 条待审评论`);
  } catch (e) {
    return fail(res, '操作失败', 500);
  }
});

/** AI 复核：挂在秘钥后台路径下，避免公网枚举 /comments/:id/re-ai */
router.post('/comments/:id/re-ai', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const row = await db('comments').where('id', id).select('id', 'nickname', 'content', 'website').first();
    if (!row) return notFound(res, '评论不存在');
    const { moderateComment } = require('../utils/aiModeration');
    const verdict = await moderateComment(row.content, row.nickname, row.website || '');
    const newStatus = verdict.action === 'rejected' ? 'rejected' : verdict.action === 'pending' ? 'pending' : 'approved';
    await db('comments').where('id', id).update({
      status: newStatus,
      ai_reason: verdict.action === 'approved' ? '' : String(verdict.reason || '').slice(0, 120),
    });
    return ok(res, { status: newStatus }, `AI 复核完成：${verdict.action === 'approved' ? '判定通过' : verdict.action === 'pending' ? '进入待审' : '仍判拒绝'}`);
  } catch (e) {
    return fail(res, 'AI 复核失败', 500);
  }
});

// ============ 友链 ============

/** 后台友链列表 */
router.get('/links/admin/list', async (req, res) => {
  try {
    const { status, keyword } = req.query;
    const base = db('links').modify((b) => {
      if (status && status !== 'all') b.where('status', status);
      if (keyword && String(keyword).trim()) {
        const kw = escapeLike(String(keyword).slice(0, 50));
        b.where((q) => {
          q.where('name', 'like', `%${kw}%`)
            .orWhere('url', 'like', `%${kw}%`)
            .orWhere('description', 'like', `%${kw}%`);
        });
      }
    });
    const rows = await base.orderBy([{ column: 'sort', order: 'asc' }, { column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).select('*');
    return ok(res, rows);
  } catch (e) {
    return fail(res, '获取友链失败', 500);
  }
});

/** 审核友链 */
router.put('/links/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const { status, sort } = req.body;
    const patch = {};
    if (status !== undefined) {
      if (!isOneOf(REVIEW_STATUS, status)) return fail(res, '非法状态');
      patch.status = status;
    }
    // 排序值钳制（0-100，防恶意写入超范围值破坏排序稳定性）
    if (sort !== undefined) {
      const n = Number(sort);
      if (!Number.isFinite(n)) return fail(res, '排序值不合法');
      patch.sort = Math.min(100, Math.max(0, Math.round(n)));
    }
    if (Object.keys(patch).length === 0) return fail(res, '无更新内容');
    await db('links').where('id', id).update(patch);
    return ok(res, null, '友链状态已更新');
  } catch (e) {
    return fail(res, '更新友链失败', 500);
  }
});

/** 删除友链 */
router.delete('/links/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    await db('links').where('id', id).del();
    return ok(res, null, '友链已删除');
  } catch (e) {
    return fail(res, '删除友链失败', 500);
  }
});

/** 批量更新友链状态 */
router.post('/links/batch-status', async (req, res) => {
  try {
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择要操作的友链');
    if (!isOneOf(REVIEW_STATUS, status)) return fail(res, '非法状态');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db('links').whereIn('id', safeIds).update({ status });
    return ok(res, { updated: safeIds.length }, `已更新 ${safeIds.length} 条友链状态`);
  } catch (e) {
    return fail(res, '批量更新失败', 500);
  }
});

/** 批量删除友链 */
router.post('/links/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择要删除的友链');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db('links').whereIn('id', safeIds).del();
    return ok(res, { deleted: safeIds.length }, `已删除 ${safeIds.length} 个友链`);
  } catch (e) {
    return fail(res, '批量删除失败', 500);
  }
});

/** 全部通过（友链审核提速）：当前待审友链一键通过（上限 1000） */
router.post('/links/approve-all', async (req, res) => {
  try {
    const pendingIds = await db('links')
      .where('status', 'pending')
      .limit(1000)
      .pluck('id');
    if (!pendingIds.length) return ok(res, { affected: 0 }, '暂无待审友链');
    const affected = await db('links').whereIn('id', pendingIds).update({ status: 'approved' });
    return ok(res, { affected }, `已通过 ${affected} 个待审友链`);
  } catch (e) {
    return fail(res, '操作失败', 500);
  }
});

// ============ 留言 ============

/** 后台留言列表（分页，防留言量增长后一次加载全量） */
router.get('/messages/admin/list', async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page) || 1)); // page 上限防超大 offset 拖慢查询
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const { status, ai_only, keyword } = req.query;
    const base = db('messages')
      .modify((b) => {
        if (status && status !== 'all') b.where('status', status);
        // 仅看 AI 标记（复核/批量处理入口）
        if (ai_only === '1') {
          b.whereNotNull('ai_reason').where('ai_reason', '!=', '');
        }
        if (keyword) {
          const kw = escapeLike(String(keyword).slice(0, 50));
          b.where((q) => {
            q.where('nickname', 'like', `%${kw}%`)
              .orWhere('content', 'like', `%${kw}%`);
          });
        }
      });
    const [total, rows] = await Promise.all([
      base.clone().count('id as cnt').first(),
      base.clone()
        .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
        .select('*')
        .limit(pageSize).offset((page - 1) * pageSize),
    ]);
    return ok(res, { list: rows, pagination: { page, pageSize, total: Number(total.cnt || 0) } });
  } catch (e) {
    return fail(res, '获取留言失败', 500);
  }
});

/** 留言全量导出 CSV（审核备份；最近 1000 条，尊重当前筛选；公式注入防护） */
router.get('/messages/admin/export', async (req, res) => {
  try {
    const { status, ai_only, keyword } = req.query;
    const base = db('messages').modify((b) => {
      if (status && status !== 'all') b.where('status', status);
      if (ai_only === '1') {
        b.whereNotNull('ai_reason').where('ai_reason', '!=', '');
      }
      if (keyword) {
        const kw = escapeLike(String(keyword).slice(0, 50));
        b.where((q) => {
          q.where('nickname', 'like', `%${kw}%`)
            .orWhere('content', 'like', `%${kw}%`);
        });
      }
    });
    const rows = await base
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(1000)
      .select('id', 'nickname', 'email', 'content', 'status', 'ai_reason', 'created_at');
    const esc = (s) => {
      const str = String(s ?? '');
      const safe = /^[=+\-@\t\r]/.test(str.trimStart()) ? `'${str}` : str;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    // 状态中文化（导出可读性）
    const statusZh = REVIEW_STATUS_ZH;
    const header = ['ID', '昵称', '邮箱', '内容', '状态', 'AI 标记', '时间'].map(esc).join(',');
    const lines = rows.map((r) =>
      [r.id, r.nickname, r.email, r.content, statusZh[r.status] || r.status, r.ai_reason, r.created_at].map(esc).join(',')
    );
    const csv = '\ufeff' + [header, ...lines].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="messages-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (e) {
    return fail(res, '导出失败', 500);
  }
});

/** 审核留言 */
router.put('/messages/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const { status } = req.body;
    if (!isOneOf(REVIEW_STATUS, status)) return fail(res, '非法状态');
    await db('messages').where('id', id).update({ status });
    return ok(res, null, '留言状态已更新');
  } catch (e) {
    return fail(res, '更新失败', 500);
  }
});

/** 回复留言（站长回复）：回复时自动通过审核；清空回复传 reply='' 即可 */
router.put('/messages/:id/reply', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    // 契约：显式传 reply='' 表示清空已发布的回复（replied_at 一并置空）
    if (req.body.reply === '') {
      const affected = await db('messages').where('id', id).whereNotNull('reply').where('reply', '!=', '').update({ reply: '', replied_at: null });
      if (!affected) return notFound(res, '留言不存在或暂无回复');
      return ok(res, null, '回复已清空');
    }
    const reply = cleanText(req.body.reply, 2000);
    if (!reply) return fail(res, '回复内容不能为空');
    const row = await db('messages').where('id', id).select('nickname', 'email', 'content').first();
    if (!row) return notFound(res, '留言不存在');
    await db('messages').where('id', id).update({
      reply,
      replied_at: db.fn.now(),
      status: 'approved',
    });
    // 异步通知留言作者（与评论回复通知同标准：留过邮箱才发、正文截断、
    // 未配置 SMTP 静默跳过；邮箱仅服务端使用从不下发前端）
    if (row.email) {
      const notifyText = reply.length > 300 ? `${reply.slice(0, 300)}…` : reply;
      const { send } = require('../utils/notifyMail');
      send('你的留言已被回复', `站长回复了你的留言：\n\n${notifyText}\n\n原留言：${String(row.content || '').slice(0, 100)}`, row.email).catch(() => {});
    }
    return ok(res, null, '回复已发布');
  } catch (e) {
    return fail(res, '回复失败', 500);
  }
});

/** 全部通过（留言审核提速）：当前待审留言一键通过（上限 1000）。
 *  带 AI 标记的留言不随「全部通过」放行——被引擎怀疑过的内容应逐条人工判断 */
router.post('/messages/approve-all', async (req, res) => {
  try {
    const pendingIds = await db('messages')
      .where('status', 'pending')
      .limit(1000)
      .pluck('id');
    if (!pendingIds.length) return ok(res, { affected: 0, skipped: 0 }, '暂无待审留言');
    const flagged = await db('messages')
      .whereIn('id', pendingIds)
      .whereNotNull('ai_reason')
      .where('ai_reason', '!=', '')
      .pluck('id');
    const allowIds = pendingIds.filter((id) => !flagged.includes(id));
    const affected = allowIds.length
      ? await db('messages').whereIn('id', allowIds).update({ status: 'approved' })
      : 0;
    return ok(
      res,
      { affected, skipped: flagged.length },
      affected
        ? `已通过 ${affected} 条，跳过 AI 标记 ${flagged.length} 条`
        : `无可直接通过的留言（AI 标记 ${flagged.length} 条需逐条处理）`
    );
  } catch (e) {
    return fail(res, '操作失败', 500);
  }
});

/** AI 复核：挂在秘钥后台路径下，避免公网枚举 /messages/:id/re-ai */
router.post('/messages/:id/re-ai', async (req, res) => {
  try {
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

/** 删除留言 */
router.delete('/messages/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    await db('messages').where('id', id).del();
    return ok(res, null, '留言已删除');
  } catch (e) {
    return fail(res, '删除留言失败', 500);
  }
});

/** 批量删除留言 */
router.post('/messages/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择要删除的留言');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db('messages').whereIn('id', safeIds).del();
    return ok(res, { deleted: safeIds.length }, `已删除 ${safeIds.length} 条留言`);
  } catch (e) {
    return fail(res, '批量删除失败', 500);
  }
});

/** 批量修改留言状态（通过/拒绝/待审核） */
router.post('/messages/batch-status', async (req, res) => {
  try {
    const { ids, status } = req.body || {};
    if (!isOneOf(REVIEW_STATUS, status)) return fail(res, '状态不合法');
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择要操作的留言');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db('messages').whereIn('id', safeIds).update({ status });
    return ok(res, { updated: safeIds.length }, `已更新 ${safeIds.length} 条留言状态`);
  } catch (e) {
    return fail(res, '批量更新失败', 500);
  }
});

// ============ 统计 / 设置 ============

/* ---------- 仪表盘缓存 ----------
 * 一次请求并发 18 条聚合查询（含 4 条 count、3 条分组、2 条 sum），是全站最贵的读接口。
 * 而它的使用场景是「管理员打开看一眼」—— 15 秒内的重复请求（刷新、切标签页、
 * 前端 3 个视图各拉一次）没有任何新信息。
 *
 * 为什么不做主动失效：admin.js 有 8 处写操作，各接一条失效调用看起来对称，
 * 但漏一处就是「改完不生效」且无法测；15 秒 TTL 的代价是「最多晚 15 秒看到变化」，
 * 对仪表盘完全可以接受。需要立刻刷新时调 invalidateDashboardCache()。
 *
 * key 含 role：现在只有一个 admin 角色，但把 role 写进 key 是零成本的，
 * 将来加编辑角色时不会串数据。key 也含 days（7-90，最多 84 个组合）。
 */
const DASHBOARD_TTL = 15 * 1000;
const DASHBOARD_CACHE_MAX = 128;
const dashboardCache = new Map(); // key -> { at, data }

function readDashboardCache(key) {
  const rec = dashboardCache.get(key);
  if (!rec) return null;
  if (Date.now() - rec.at >= DASHBOARD_TTL) {
    dashboardCache.delete(key);
    return null;
  }
  return rec.data;
}

function writeDashboardCache(key, data) {
  if (!dashboardCache.has(key) && dashboardCache.size >= DASHBOARD_CACHE_MAX) {
    // 插入序淘汰最旧的一条：days 的取值空间有限（84），正常永远碰不到上限
    const oldest = dashboardCache.keys().next().value;
    if (oldest !== undefined) dashboardCache.delete(oldest);
  }
  dashboardCache.set(key, { at: Date.now(), data });
}

/** 立即失效（测试、以及将来任何需要「改完立刻看到」的调用点） */
function invalidateDashboardCache() {
  dashboardCache.clear();
}

/** 后台仪表盘数据 */
router.get('/stats/dashboard', async (req, res) => {
  try {
    const { localDateStr, localDateTimeStr } = require('../utils/datetime');
    const today = localDateStr();
    // 时间范围可配置（7-90 天，默认 14）
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const since = localDateStr(new Date(Date.now() - (days - 1) * 24 * 3600 * 1000));

    const cacheKey = `${(req.user && req.user.role) || 'anon'}|${days}`;
    const cached = readDashboardCache(cacheKey);
    if (cached) return ok(res, cached);

    const [trend, byCategory, pendingComments, pendingLinks, pendingMessages, total, topArticles, recentComments, recentMessages, recentArticles, commentTrend, messageTrend, draftCount, totalViews, totalComments, totalMessages, todayVisits, uncategorized] = await Promise.all([
      db('visits')
        .whereBetween('day', [since, today])
        .orderBy('day', 'asc')
        .select('day', 'pv', 'uv'),
      db('categories as c')
        .leftJoin('articles as a', function () {
          this.on('a.category_id', 'c.id').andOn('a.status', '=', db.raw('?', ['published']));
        })
        .groupBy('c.id', 'c.name')
        .select('c.name')
        .count('a.id as cnt'),
      db('comments').where('status', 'pending').count('* as cnt').first(),
      db('links').where('status', 'pending').count('* as cnt').first(),
      db('messages').where('status', 'pending').count('* as cnt').first(),
      db('articles').count('* as cnt').first(),
      // 热门文章 TOP 5（按浏览量，相同按发布时间）
      db('articles')
        .where('status', 'published')
        .orderBy([{ column: 'views', order: 'desc' }, { column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }])
        .limit(5)
        .select('id', 'title', 'slug', 'views', 'likes', 'published_at'),
      // 最新动态：最近 5 条评论（含所属文章标题）
      db('comments as cm')
        .leftJoin('articles as a', 'cm.article_id', 'a.id')
        .orderBy([{ column: 'cm.created_at', order: 'desc' }, { column: 'cm.id', order: 'desc' }])
        .limit(5)
        .select('cm.id', 'cm.nickname', 'cm.content', 'cm.status', 'cm.created_at', 'a.title as article_title'),
      // 最新动态：最近 5 条留言
      db('messages').orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(5).select('id', 'nickname', 'content', 'status', 'created_at'),
      // 最新动态：最近 5 篇文章
      db('articles').where('status', 'published').orderBy([{ column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(5).select('id', 'title', 'slug', 'published_at'),
      // 互动趋势：近 days 天评论/留言数（按天聚合，图表展示）
      db('comments')
        .where('created_at', '>=', localDateTimeStr(new Date(Date.now() - (days - 1) * 24 * 3600 * 1000)))
        .groupBy(db.raw('DATE(created_at)'))
        .select(db.raw('DATE(created_at) as day'))
        .count('* as cnt'),
      db('messages')
        .where('created_at', '>=', localDateTimeStr(new Date(Date.now() - (days - 1) * 24 * 3600 * 1000)))
        .groupBy(db.raw('DATE(created_at)'))
        .select(db.raw('DATE(created_at) as day'))
        .count('* as cnt'),
      db('articles').where('status', 'draft').count('* as cnt').first(),
      db('articles').sum('views as v').first(),
      db('comments').count('* as cnt').first(),
      db('messages').count('* as cnt').first(),
      db('visits').where('day', today).first('pv', 'uv'),
      db('articles').where('status', 'published').whereNull('category_id').count('* as cnt').first(),
    ]);

    const trendMap = {};
    for (const r of trend) {
      const day = String(r.day || '').slice(0, 10);
      if (!day) continue;
      trendMap[day] = { day, pv: Number(r.pv) || 0, uv: Number(r.uv) || 0 };
    }
    const fullTrend = [];
    for (let i = 0; i < days; i++) {
      const d = localDateStr(new Date(Date.now() - (days - 1 - i) * 24 * 3600 * 1000));
      fullTrend.push(trendMap[d] || { day: d, pv: 0, uv: 0 });
    }

    const payload = {
      trend: fullTrend,
      // 分类分布（含未分类条目，便于发现未归类文章）
      by_category: (() => {
        const list = byCategory.map((r) => ({ name: r.name, count: Number(r.cnt) }));
        const uncat = Number(uncategorized.cnt || 0);
        if (uncat > 0) list.push({ name: '未分类', count: uncat });
        return list;
      })(),
      // 互动趋势：近 days 天补零对齐
      interact_trend: (() => {
        const cMap = {}; const mMap = {};
        for (const r of commentTrend) cMap[String(r.day || '').slice(0, 10)] = Number(r.cnt);
        for (const r of messageTrend) mMap[String(r.day || '').slice(0, 10)] = Number(r.cnt);
        const out = [];
        for (let i = 0; i < days; i++) {
          const d = localDateStr(new Date(Date.now() - (days - 1 - i) * 24 * 3600 * 1000));
          out.push({ day: d, comments: cMap[d] || 0, messages: mMap[d] || 0 });
        }
        return out;
      })(),
      pending: {
        comments: Number(pendingComments.cnt || 0),
        links: Number(pendingLinks.cnt || 0),
        messages: Number(pendingMessages.cnt || 0),
      },
      total_articles: Number(total.cnt || 0),
      // 数据总览：草稿/浏览量/评论/留言/今日访问（统计卡片用）
      counts: {
        drafts: Number(draftCount.cnt || 0),
        views: Number(totalViews.v || 0),
        comments: Number(totalComments.cnt || 0),
        messages: Number(totalMessages.cnt || 0),
      },
      today_visit: todayVisits ? { pv: todayVisits.pv || 0, uv: todayVisits.uv || 0 } : { pv: 0, uv: 0 },
      top_articles: topArticles.map((a) => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        views: a.views,
        likes: a.likes,
        published_at: a.published_at,
      })),
      recent_comments: recentComments.map((c) => ({
        id: c.id,
        nickname: c.nickname,
        content: String(c.content || '').slice(0, 80),
        status: c.status,
        created_at: c.created_at,
        article_title: c.article_title || '（文章已删除）',
      })),
      recent_messages: recentMessages.map((m) => ({
        id: m.id,
        nickname: m.nickname,
        content: String(m.content || '').slice(0, 80),
        status: m.status,
        created_at: m.created_at,
      })),
      recent_articles: recentArticles.map((a) => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        published_at: a.published_at,
      })),
    };
    writeDashboardCache(cacheKey, payload);
    return ok(res, payload);
  } catch (e) {
    return fail(res, '获取仪表盘数据失败', 500);
  }
});

/** 保存站点设置（后台） */
router.put('/settings', async (req, res) => {
  try {
    const { settings, rejected } = await saveSettings(req.body || {});
    // 静默丢弃必须让用户看见：saveSettings 的每个校验分支都是 `continue`，
    // 不提示的话用户会以为「已保存」而配置其实没变（然后去排查别的地方）。
    // 这里把被拒的字段名与原因一起回给前端，前端据此决定用 success 还是 warning。
    const msg = rejected.length
      ? `已保存，但以下 ${rejected.length} 个字段未通过校验、保持原值：${rejected.map((r) => `${r.key}（${r.reason}）`).join('；')}`
      : '设置已保存';
    if (rejected.length) {
      // 落到响应体里，前端不必解析中文文案就能判断
      return ok(res, { ...settings, rejected }, msg);
    }
    return ok(res, settings, msg);
  } catch (e) {
    return fail(res, '保存设置失败', 500);
  }
});

/** 设置导出（备份/迁移）：全量 JSON 下载
 *  剔除 ai_api_key / websearch_api_key：备份文件常被随手放进网盘/仓库，密钥不该跟着走 */
router.get('/settings/export', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const { ai_api_key: _k1, websearch_api_key: _k2, ai_system_prompt: _prompt, ...safe } = settings;
    res.set('Content-Disposition', 'attachment; filename="settings-backup.json"');
    return res.send(JSON.stringify(safe, null, 2));
  } catch (e) {
    return fail(res, '导出失败', 500);
  }
});

/** 设置导入（恢复备份）：白名单键 + 长度钳制，未知键/超长值静默忽略 */
router.post('/settings/import', async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, '备份数据格式不正确');
    const entries = {};
    for (const [k, v] of Object.entries(data)) {
      if (!ALLOWED_KEYS.has(k)) continue;
      const maxLen = k === 'about_content' ? 50000 : 5000;
      if (typeof v === 'string' && v.length > maxLen) continue;
      entries[k] = v;
    }
    if (!Object.keys(entries).length) return fail(res, '备份数据中没有可导入的字段', 400);
    await saveSettings(entries);
    return ok(res, null, `已导入 ${Object.keys(entries).length} 项设置`);
  } catch (e) {
    return fail(res, '导入失败', 500);
  }
});

// ============ 审计日志 ============

/** 管理员操作审计（谁 / 何时 / 做了什么），支持关键词与分页 */
router.get('/audit/logs', async (req, res) => {
  try {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const keyword = escapeLike(String(req.query.keyword || '').slice(0, 50));
    const base = db('audit_logs').modify((b) => {
      if (keyword) {
        b.where((q) =>
          q.where('username', 'like', `%${keyword}%`)
            .orWhere('action', 'like', `%${keyword}%`)
            .orWhere('detail', 'like', `%${keyword}%`)
            .orWhere('ip', 'like', `%${keyword}%`)
        );
      }
    });
    const [total, rows] = await Promise.all([
      base.clone().count('* as cnt').first(),
      base.clone().orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize),
    ]);
    return ok(res, { list: rows, pagination: { page, pageSize, total: Number(total.cnt || 0) } });
  } catch (e) {
    return fail(res, '获取审计日志失败', 500);
  }
});

/** 清空审计日志（危险操作，需二次确认由前端把关） */
router.delete('/audit/logs', async (req, res) => {
  try {
    if (req.body?.confirm !== true) return fail(res, '请确认后重试', 400);
    await db('audit_logs').del();
    // 写入清空自身的审计留痕，保证清空操作可追溯
    await db('audit_logs').insert({
      user_id: req.user?.sub || 0,
      username: req.user?.username || 'admin',
      action: 'AUDIT_CLEAR',
      detail: '清空历史审计日志',
      ip: req.ip || '',
      fp: String(req.headers['x-fp'] || '').slice(0, 128),
    });
    return ok(res, null, '审计日志已清空');
  } catch (e) {
    return fail(res, '清空失败', 500);
  }
});

/** 审计日志 CSV 导出（审核/合规留档；最近 1000 条，尊重关键词筛选；公式注入防护） */
router.get('/audit/export', async (req, res) => {
  try {
    const keyword = escapeLike(String(req.query.keyword || '').slice(0, 50));
    const base = db('audit_logs').modify((b) => {
      if (keyword) {
        b.where((q) =>
          q.where('username', 'like', `%${keyword}%`)
            .orWhere('action', 'like', `%${keyword}%`)
            .orWhere('detail', 'like', `%${keyword}%`)
            .orWhere('ip', 'like', `%${keyword}%`)
        );
      }
    });
    const rows = await base
      .orderBy('id', 'desc')
      .limit(1000)
      .select('id', 'username', 'action', 'detail', 'ip', 'created_at');
    const esc = (s) => {
      const str = String(s ?? '');
      const safe = /^[=+\-@\t\r]/.test(str.trimStart()) ? `'${str}` : str;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = ['ID', '操作者', '操作', '详情', 'IP', '时间'].map(esc).join(',');
    const lines = rows.map((r) =>
      [r.id, r.username, r.action, r.detail, r.ip, r.created_at].map(esc).join(',')
    );
    const csv = '\ufeff' + [header, ...lines].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (e) {
    return fail(res, '导出失败', 500);
  }
});

/** 测试邮件通知（管理员）：校验 SMTP 配置并发送测试信到站长邮箱 */
router.post('/settings/test-mail', async (req, res) => {
  try {
    const { smtpReady, enabled, send } = require('../utils/notifyMail');
    if (!smtpReady()) {
      return fail(res, '未配置 SMTP（SMTP_HOST / SMTP_USER / SMTP_PASS），请在环境变量中配置后重启');
    }
    const sent = await send(
      'Xalorblog 测试邮件',
      `这是一封测试邮件，收到即表示 SMTP 配置正常。\n发送时间：${new Date().toLocaleString('zh-CN')}`
    );
    if (!sent) {
      return fail(res, '发送失败：SMTP 连接或认证出错，请检查主机/端口/凭据');
    }
    return ok(res, { recipient: enabled() ? '已配置收件人' : 'SMTP 用户名邮箱' }, '测试邮件已发送，请查收');
  } catch (e) {
    return fail(res, '测试发送失败', 500);
  }
});

// ============ 上传 ============

/** 上传图片（封面/头像等）—— 认证已由本路由统一前置，未授权请求不会触达 multer */
router.post('/upload', (req, res, next) => {
  const multer = require('multer');
  const path = require('path');
  const fs = require('fs');
  const config = require('../config');

  if (!fs.existsSync(config.uploadDir)) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (req2, file, cb) => cb(null, config.uploadDir),
    filename: (req2, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      // 服务端强制重命名：加密随机文件名，杜绝路径穿越/重名覆盖/文件名可预测
      const name = `${Date.now()}-${require('crypto').randomBytes(6).toString('hex')}${ext}`;
      cb(null, name);
    },
  });

  /** 图片扩展名 → 期望的文件头（magic bytes） */
  const MAGIC = {
    '.jpg': (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8,
    '.jpeg': (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8,
    '.png': (b) => b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    '.gif': (b) => b.length > 5 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
    '.webp': (b) => b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
    '.svg': (b) => {
      // SVG 是文本文件：全文扫描（非仅文件头 512B——大注释填充可把 payload 推到检测窗口外）
      const text = b.toString('utf8').toLowerCase();
      if (!text.includes('<svg')) return false;
      // 拒绝危险内容：脚本/事件/外部引用/嵌入/XXE/HTML 双解析（polyglot）
      // 含 SMIL 变体：<set attributeName="onload" to="..."> 文本不含 onload= 与 javascript:，单独成类
      const danger = /<script|<iframe|<embed|<foreignobject|onload=|onerror=|onbegin=|onend=|onrepeat=|attributeName\s*=\s*["']on|javascript:|<!entity|<!doctype\s+html|href\s*=\s*["']\s*javascript/i;
      return !danger.test(text);
    },
  };

  const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 }, // 5MB，单文件
    fileFilter: (req2, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) cb(null, true);
      else cb(new Error('仅支持图片文件'));
    },
  });

  /**
   * 上传后二次校验：magic bytes 防伪造扩展名（SVG 是全文扫描）。
   *
   * 读完的字节挂在 `file.rawBytes` 上供后续复用：紧接着的 EXIF 剥离原本会
   * 再把同一个文件完整读一遍（上限 5MB × 2）。这里缓存一次即可 —— 注意**不可**
   * 复用 multer 的 `file.buffer` 字段名：diskStorage 下它不存在，但将来若改成
   * memoryStorage 就会被 multer 自己的语义覆盖，命名冲突会静默把校验绕过去。
   */
  function verifyMagic(req2, res2, next2) {
    if (!req2.file) return next2();
    const ext = path.extname(req2.file.filename).toLowerCase();
    const check = MAGIC[ext];
    const buffer = fs.readFileSync(req2.file.path);
    if (check && !check(buffer)) {
      fs.unlinkSync(req2.file.path);
      return fail(res2, '文件内容与扩展名不符，已拒绝');
    }
    req2.file.rawBytes = buffer;
    next2();
  }

  upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    verifyMagic(req, res, () => {
      if (!req.file) return fail(res, '请选择图片文件');
      // 隐私保护：JPEG 照片剥离 EXIF（GPS 坐标 / 设备型号 / 拍摄时间）。
      // 剥离失败保守保留原文件（不因元数据处理损坏用户上传）
      const upExt = path.extname(req.file.filename).toLowerCase();
      if (upExt === '.jpg' || upExt === '.jpeg') {
        try {
          const { stripExif } = require('../utils/stripExif');
          // 复用 verifyMagic 已读到的字节（同一文件不读第二遍）。
          // 回退分支保留：verifyMagic 在没有 file 时直接 next()，防御性兜底。
          const raw = req.file.rawBytes || fs.readFileSync(req.file.path);
          const stripped = stripExif(raw);
          // 没有可剥离的段时 stripExif 原样返回同一个 Buffer 引用：
          // 此时跳过写盘，省一次 5MB 写入（内容完全没变）。
          if (stripped !== raw) fs.writeFileSync(req.file.path, stripped);
        } catch (e) { /* 忽略：保留原文件 */ }
      }
      // 释放引用，避免 Buffer 跟着请求对象在后续中间件里多活一会儿
      req.file.rawBytes = null;

      // 总量配额：单文件 5MB 只管单次，管不住「一直传」—— 磁盘写满之后备份失败、
      // 数据库写不进去、整站 500，而报错现象会把人引向「凭据」这种错误方向。
      // 配额默认 1024MB，可用 UPLOAD_QUOTA_MB 调整；超限时**删掉刚写入的文件**再拒绝。
      try {
        const quotaBytes = Number(process.env.UPLOAD_QUOTA_MB || 1024) * 1024 * 1024;
        const { checkUploadQuota, dirSizeBytes } = require('../utils/uploads');
        const justWritten = fs.statSync(req.file.path).size;
        const usedBefore = Math.max(0, dirSizeBytes(config.uploadDir) - justWritten);
        const verdict = checkUploadQuota(usedBefore, quotaBytes, justWritten);
        if (!verdict.allowed) {
          fs.unlinkSync(req.file.path);
          return fail(res, `上传空间已满（已用 ${(verdict.used / 1048576).toFixed(0)}MB / 上限 ${(quotaBytes / 1048576).toFixed(0)}MB），请先清理图片`, 507);
        }
      } catch (e) {
        // 配额检查本身出错不阻断上传（宁可能写满，也不要把正常上传全拒掉）
        console.warn('[upload] 配额检查失败，已跳过：', e && e.message);
      }

      return ok(res, { url: `/uploads/${req.file.filename}`, filename: req.file.filename }, '上传成功');
    });
  });
});

// ============ 上传文件管理 ============

/**
 * 收集全站正在使用的上传文件集合（文章封面 / 正文 / 站点设置）
 * 供孤儿清理与删除保护共用：引用中的文件不允许被删/被清
 */
async function collectReferencedUploads() {
  const referenced = new Set();
  // 提取字符串中全部 /uploads/<rel> 引用（支持 cover URL、正文 Markdown、设置项值）
  //
  // ⚠ 必须认**一层子目录**：AI 写作助手转存的图在 `/uploads/ai/<name>`。
  // 旧正则 `([A-Za-z0-9._-]+)` 只捕获第一段，于是 ai/ 里的图永远被判定为「未引用」——
  // 图片管理页显示可删、孤儿清理会真的删掉仍在正文里使用的图（破图），
  // 而 /uploads/list 又只列顶层，这些文件对站长完全不可见。
  // 提取逻辑已抽到 utils/uploads（纯函数，可离线测）
  const extract = (s) => { extractUploadRefs(s, referenced); };
  // ⚠ 手记（notes）也必须算进来。
  // 原先只扫了 articles.cover / articles.content / settings.value / links.avatar，
  // **完全没查 notes** —— 于是手记正文里插入过的图片会被判定成孤儿：
  // 实测造一条正文引用 `/uploads/probe-note-img.png` 的手记，
  // 图片管理页把它当成「未引用」、删除按钮可点，点一下手记里就变破图。
  // notes 有两个可能带图的字段：content（Markdown 正文）与 images（图集 JSON）。
  //
  // 性能：正文列用 `LIKE '%/uploads/%'` 预过滤。
  // 任何能被 extractUploadRefs 提取出引用的文本，必然包含字面量 `/uploads/` ——
  // 所以这是个**必要条件**过滤，不会漏行，但把「读全部文章全文」降到「读有图文章的全文」。
  // 博客站里绝大多数文章不含图片，这个比例通常是一个数量级以上的差距。
  // （封面/头像/图片集本身很短，不值得预过滤；settings 表只有几十行。）
  const [covers, contents, settings, linkAvatars, noteContents, noteImages] = await Promise.all([
    db('articles').whereNotNull('cover').pluck('cover'),
    db('articles').where('content', 'like', UPLOAD_REF_SQL_LIKE).pluck('content'),
    db('settings').pluck('value'),
    db('links').whereNotNull('avatar').pluck('avatar'),
    db('notes').where('content', 'like', UPLOAD_REF_SQL_LIKE).pluck('content'),
    db('notes').whereNotNull('images').pluck('images'),
  ]);
  covers.forEach(extract);
  contents.forEach(extract);
  settings.forEach(extract);
  linkAvatars.forEach(extract);
  noteContents.forEach(extract);
  noteImages.forEach(extract);
  return referenced;
}

/** 上传文件列表（相对路径/大小/修改时间/是否被引用，倒序，上限 500）。
 *  用 utils/uploads 的递归（顶层 + 一层子目录）：ai/ 转存图必须可见，
 *  否则它们既删不掉、也看不出是否被引用。`name` 保持相对路径，与删除接口同一口径。 */
router.get('/uploads/list', async (req, res) => {
  try {
    const { listUploadFiles } = require('../utils/uploads');
    const referenced = await collectReferencedUploads();
    const files = listUploadFiles(config.uploadDir)
      .map((f) => {
        const slash = f.rel.indexOf('/');
        return {
          name: f.rel,
          path: f.rel,
          dir: slash === -1 ? '' : f.rel.slice(0, slash),
          size: f.size,
          mtime: f.mtime,
          used: referenced.has(f.rel),
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 500);
    return ok(res, files);
  } catch (e) {
    return fail(res, '读取失败', 500);
  }
});

/**
 * 删除单个上传文件（严格路径校验防穿越；被引用中的图片拒绝删除）。
 *
 * 两条路由共用同一处理：`DELETE /uploads/:filename`（顶层）与 `DELETE /uploads/*`（子目录）。
 * Express 的 `:filename` 不跨 `/`，而 ai/ 转存图的相对路径是 `ai/x.png` ——
 * 只留一条路由时它们永远删不掉（前端点了报"文件名不合法"）。
 * 校验统一交给 utils/uploads.resolveUploadPath：段白名单 + 解析后必须仍在根内。
 */
async function deleteUploadFile(req, res) {
  try {
    const fs = require('fs');
    const { resolveUploadPath } = require('../utils/uploads');
    const raw = String(req.params.filename || req.params[0] || '');
    const rel = raw.replace(/^\/+/, '');
    const full = resolveUploadPath(config.uploadDir, rel);
    if (!full) return fail(res, '文件名不合法');
    if (!fs.existsSync(full)) return fail(res, '文件不存在');

    // 引用保护：正在被文章/手记/设置使用的图片禁止删除（防文章图裂）
    const referenced = await collectReferencedUploads();
    if (referenced.has(rel)) {
      return fail(res, '该图片正被文章、手记或站点设置引用，不能直接删除', 400);
    }

    fs.unlinkSync(full);
    return ok(res, null, '已删除');
  } catch (e) {
    return fail(res, '删除失败', 500);
  }
}
router.delete('/uploads/:filename', deleteUploadFile);
router.delete('/uploads/*', deleteUploadFile);

/**
 * 扫描 uploads 目录，删除未被任何内容引用的孤儿文件
 * 引用来源：文章封面 / 文章正文 / 站点设置 / 友链头像 / 手记正文与图集
 * 安全窗口：24 小时内新上传的文件跳过（防止刚上传、引用尚未保存的竞态误删）
 * 覆盖范围：顶层 + 一层子目录（ai/），与列表/删除同一套 utils/uploads 规则。
 */
router.post('/uploads/cleanup-orphans', async (req, res) => {
  try {
    const fs = require('fs');
    const { listUploadFiles, resolveUploadPath } = require('../utils/uploads');
    const referenced = await collectReferencedUploads();
    const cutoff = Date.now() - 24 * 3600e3;
    const files = listUploadFiles(config.uploadDir);
    const deleted = [];
    for (const f of files) {
      if (f.mtime >= cutoff) continue;
      if (referenced.has(f.rel)) continue;
      const full = resolveUploadPath(config.uploadDir, f.rel);
      if (!full) continue;
      try {
        fs.unlinkSync(full);
        deleted.push(f.rel);
      } catch (e) { /* 占用/权限：跳过 */ }
    }
    return ok(res, { scanned: files.length, deleted }, deleted.length ? `已清理 ${deleted.length} 个孤儿文件` : '没有需要清理的孤儿文件');
  } catch (e) {
    return fail(res, '清理失败', 500);
  }
});

// ============ 安全中心 ============

/** 安全中心：封禁列表 + 攻击事件日志（实时内存 + 持久化历史） */
router.get('/security', async (req, res) => {
  try {
    const stats = await securityStats();
    return ok(res, {
      ...stats,
      pass_valid: verifyTicket(req).ok,
      server_time: Date.now(),
    });
  } catch (e) {
    return fail(res, '获取安全数据失败', 500);
  }
});

/** 手动解封 IP */
router.post('/security/unban', asyncGuard(async (req, res) => {
  const ip = cleanLine(req.body?.ip, 64);
  if (!ip || require('net').isIP(ip) === 0) return fail(res, 'IP 地址格式不正确');
  await unban(ip);
  return ok(res, null, '已解封');
}));

/** 手动封禁 IP（留言管理/安全中心联动）：默认 30 天，上限 1 年，审计中间件自动记录 */
router.post('/security/ban', asyncGuard(async (req, res) => {
  const ip = cleanLine(req.body?.ip, 64);
  const minutes = Math.min(Math.max(Number(req.body?.minutes) || 30 * 24 * 60, 5), 365 * 24 * 60);
  const reason = cleanLine(req.body?.reason, 120);
  if (!ip || require('net').isIP(ip) === 0) return fail(res, 'IP 地址格式不正确');
  const durText = minutes >= 1440
    ? `${Math.round((minutes / 1440) * 10) / 10} 天`
    : minutes >= 60
      ? `${Math.round((minutes / 60) * 10) / 10} 小时`
      : `${minutes} 分钟`;
  const okBan = ban(ip, minutes, reason || '管理员手动封禁');
  if (!okBan) return fail(res, '封禁失败：可信白名单或本机地址不可封禁');
  return ok(res, { ip, minutes }, `已封禁 ${ip}（${durText}）`);
}));

/** 管理员操作审计日志（近 100 条） */
router.get('/security/audit', async (req, res) => {
  try {
    const rows = await db('audit_logs')
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(100)
      .select('id', 'username', 'action', 'detail', 'ip', 'created_at');
    return ok(res, rows);
  } catch (e) {
    // DB 异常不能伪装成「没有日志」：原实现 catch 里 ok(res, []) 会让安全面板显示
    // 「无记录」，数据库掉线/表缺失被误读成「没人攻击过」—— 排查方向被彻底带偏。
    // 显式 503 + 明确文案，前端拦截器弹提示（code!==0），面板保留上一次数据。
    console.error('[security/audit] 查询审计日志失败:', e && e.message);
    return fail(res, '审计日志暂时不可用，请稍后重试', 503);
  }
});

/** 安全配置读取（当前生效值 + 规则索引，供安全中心渲染） */
router.get('/security/config', (req, res) => {
  return ok(res, {
    config: getConfig(),
    rules: Object.values(RULE_INDEX),
  });
});

/** 安全配置保存（强校验：规则 ID 白名单 / IP-CIDR 格式 / 数值区间在 securitySettings 内收敛） */
router.put('/security/config', asyncGuard(async (req, res) => {
  const patch = req.body || {};
  if (patch.disabledRules !== undefined) {
    if (!Array.isArray(patch.disabledRules)) return fail(res, '禁用规则必须为数组');
    // ⚠ 必须用 hasOwnProperty 而不是裸索引 —— 与 share-page 的 STATIC_PAGES 是同一个坑：
    // `RULE_INDEX['constructor']` / `['toString']` / `['__proto__']` 都返回 Object.prototype
    // 上的函数（**真值**），于是这些名字能通过「未知规则 ID」校验并被写进 disabledRules。
    // WAF 实际判断禁用用的是字符串 includes，所以规则不会被真禁用 —— 但配置里会留下垃圾条目，
    // 后台安全中心显示「已禁用规则：constructor」，而且 RULE_INDEX['constructor'].group 是 undefined。
    const bad = patch.disabledRules.filter((id) => !Object.prototype.hasOwnProperty.call(RULE_INDEX, String(id)));
    if (bad.length) return fail(res, `未知规则 ID：${bad.slice(0, 5).join('、')}`);
  }
  if (patch.trustedIps !== undefined) {
    if (!Array.isArray(patch.trustedIps)) return fail(res, '可信 IP 必须为数组');
    const bad = patch.trustedIps.filter((s) => !isValidIpOrCidr(String(s || '').trim()));
    if (bad.length) return fail(res, `IP/CIDR 格式不正确：${bad.slice(0, 5).join('、')}`);
  }
  for (const key of ['customSensitiveWords', 'allowWords']) {
    if (patch[key] !== undefined && !Array.isArray(patch[key])) {
      return fail(res, `${key === 'allowWords' ? '豁免词' : '自定义敏感词'}必须为数组`);
    }
  }
  try {
    const cfg = await saveConfig(patch);
    return ok(res, cfg, '安全配置已保存');
  } catch (e) {
    console.error('[admin] 保存安全配置失败:', e.message);
    return fail(res, '保存失败（配置表不可用，请先执行数据库迁移）', 500);
  }
}));

/** 规则测试器（dry-run）：粘贴文本返回命中的规则与异常分，不记分不拦截
 * 文本经 base64 传输 —— 测试器必须能接收攻击载荷本身，绕过全局 WAF 的 body 扫描 */
router.post('/security/test', (req, res) => {
  const raw = String(req.body?.text_b64 || '');
  if (!raw || raw.length > 6000 || !/^[A-Za-z0-9+/=]*$/.test(raw)) {
    return fail(res, '请通过 text_b64 传入待检测文本（base64）');
  }
  const text = Buffer.from(raw, 'base64').toString('utf8');
  if (!text.trim()) return fail(res, '请输入要检测的文本');
  if (text.length > 4000) return fail(res, '文本过长（最多 4000 字符）');
  const hits = [];
  const seen = new Set();
  let score = 0;
  for (const scope of ['query', 'body']) {
    const { hits: scopeHits, score: s } = scanAll(text, scope);
    score = Math.max(score, s);
    for (const h of scopeHits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      hits.push({ id: h.id, group: h.group, scope, note: h.note || RULE_INDEX[h.id]?.note || '', sev: h.sev, score: h.score });
    }
  }
  return ok(res, { hits, blocked: hits.length > 0, score, threshold: Number(getConfig().anomalyThreshold) || 5 });
});

/* ============================================================
   AI 写作助手 v2 —— 带工具循环的真 Agent
   —— SSE 流式 + function calling：AI 直接改写当前文章；
     客户端把工具执行结果回传（role:'tool'），模型能「看到」
     自己动作的结果并继续推理——搜图、读旧文都靠这个闭环。
      模型配置走「站点设置 → 内容审核 → AI 模型」，留空回落 .env。
      只提供「改内容」的工具，发布权永远在人手上（没有 publish）。
   ============================================================ */

/** 写作助手可调用的工具（写正文 ×6 + 元数据 ×4 + 检索 ×3，全部白名单化） */
const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_title',
      description: '设置文章标题',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: '新标题，40 字以内' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_content',
      description: '整体替换文章正文（Markdown）。只在用户明确要求重写/新写整篇时使用',
      parameters: {
        type: 'object',
        properties: { markdown: { type: 'string', description: '完整正文，Markdown 格式' } },
        required: ['markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_content',
      description: '在正文末尾追加内容（Markdown）。用于续写/补充',
      parameters: {
        type: 'object',
        properties: { markdown: { type: 'string', description: '要追加的 Markdown 片段' } },
        required: ['markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_selection',
      description: '替换用户当前在编辑器里选中的那段文本。用于润色/改写选中内容',
      parameters: {
        type: 'object',
        properties: { markdown: { type: 'string', description: '替换后的文本（Markdown）' } },
        required: ['markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_at_cursor',
      description: '在编辑器光标处插入内容（Markdown）。用于插入一段/一张图',
      parameters: {
        type: 'object',
        properties: { markdown: { type: 'string', description: '要插入的 Markdown 片段' } },
        required: ['markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_summary',
      description: '设置文章摘要',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '摘要，150 字以内' } },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_tags',
      description: '设置文章标签（整体替换）。优先从「已有标签」里选',
      parameters: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' }, description: '标签数组，2-5 个' } },
        required: ['tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_category',
      description: '设置文章分类。必须是「已有分类」之一（传分类名）',
      parameters: {
        type: 'object',
        properties: { category: { type: 'string', description: '分类名，必须已存在' } },
        required: ['category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_cover',
      description: '设置文章封面图（https 图片地址，通常是搜图结果里用户指定的那张）',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '图片的 https 地址' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_options',
      description: '设置文章选项：置顶/允许评论/允许复制/发布时间（只传要改的字段）',
      parameters: {
        type: 'object',
        properties: {
          is_top: { type: 'boolean', description: '置顶' },
          allow_comment: { type: 'boolean', description: '允许评论' },
          allow_copy: { type: 'boolean', description: '允许复制' },
          publish_time: { type: 'string', description: '发布时间，格式 YYYY-MM-DD HH:mm' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_images',
      description: '搜索可用作封面/插图的网络图片（Wikimedia Commons，CC 许可）。query 用英文，1-3 个词',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '英文搜索关键词，如 mountain sunrise' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '联网搜索公开网页（返回标题/链接/摘要）。写文章需要查证事实、找资料或了解较新的信息时用',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_articles',
      description: '检索站内文章（标题 + slug + 状态），匹配范围含标题/摘要/标签，用于找参考文章',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '关键词，留空列出最近的' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_article',
      description: '读取站内一篇文章的全文（Markdown），用于参考旧文写作',
      parameters: {
        type: 'object',
        properties: { slug: { type: 'string', description: '文章 slug（从 list_articles 拿）' } },
        required: ['slug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_comments',
      description: '查看最近评论（文章标题 + 读者昵称 + 内容 + 状态），用于了解读者在问什么',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_messages',
      description: '查看最近留言板留言（昵称 + 内容），用于了解读者反馈',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_article',
      description: '在光标处插入一篇站内文章的链接（Markdown）。用于正文里引用旧文',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: '被引用文章的 slug' },
          text: { type: 'string', description: '链接文字，留空用文章标题' },
        },
        required: ['slug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_draft',
      description: '把当前文章保存为草稿（不是发布）。写完/改完一段后用户说「存一下」时用',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'publish',
      description: '发布当前文章（立即对访客可见）。只在用户明确说「发布」时使用，绝不主动调用',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_slug',
      description: '设置文章的链接地址（slug）。建议用英文小写加连字符，如 my-first-post',
      parameters: {
        type: 'object',
        properties: { slug: { type: 'string', description: '新的 slug，建议 ASCII' } },
        required: ['slug'],
      },
    },
  },
];

/** 站点简报：已有分类/标签/最近文章 —— 服务端直接查库补进提示词，
 *  模型据此才能「优先复用已有标签」「分类必须已存在」「找到旧文 slug」 */
async function loadSiteBrief() {
  const [cats, tags, recent] = await Promise.all([
    db('categories').orderBy('id', 'asc').limit(30).select('name'),
    db('tags').orderBy('id', 'asc').limit(80).select('name'),
    db('articles').orderBy('updated_at', 'desc').limit(10).select('slug', 'title', 'status'),
  ]);
  return {
    categories: cats.map((c) => c.name),
    tags: tags.map((t) => t.name),
    recentArticles: recent.map((a) => `《${a.title}》 slug=${a.slug} [${a.status}]`),
  };
}

/** 写作助手的系统提示：文风要求写死，避免生成「AI 味」内容。
 *  systemPrompt 非空时用站长自定义的人设替换内置「角色与文风」层；
 *  工具说明与文章上下文始终保留（那是工具调用的功能底线，自定义不碰）。 */
function buildWriterSystemPrompt(context = {}, site = {}, systemPrompt = '', ctxChars = 6000) {
  const role = systemPrompt
    ? systemPrompt
    : [
        '你是「Xalor的小站」博客后台的 AI 写作助手，帮站长写文章、改稿、找配图。直接干活，不啰嗦。',
        '',
        '文风（很重要）：',
        '- 第一人称、口语、直接，像一个有主见的技术博主在讲话。',
        '- 禁止套话：「总而言之」「综上所述」「值得注意的是」「在这个快节奏的时代」「让我们一起」「希望对你有帮助」。',
        '- 有话则长，无话则短；不堆排比、不堆形容词。',
        '- 技术内容要具体：版本、命令、报错、坑点写清楚，不空泛。',
        '- 聊天回复保持短，力气花在文章里；改完只用一两句话说明改了什么。',
      ].join('\n');

  const parts = [
    role,
    '',
    '工具使用：',
    '- 改文章一律调工具写入，不要在聊天里贴大段正文让人复制。',
    '- 局部修改优先 replace_selection（上下文里有「用户选中的文本」时）或 append_content；set_content 是推倒重写，仅在明确要求重写时用。',
    '- 起标题：列出 3-5 个候选、各配一句理由，再调 set_title 应用你最推荐的。',
    '- 标签优先从「已有标签」里选，一篇 2-5 个；分类必须是「已有分类」之一。',
    '- 搜图：query 用英文（中文主题先翻译成 1-3 个英文词）。搜完让用户在卡片里挑一张，不要自作主张替用户 set_cover，除非用户明确让你选。',
    '- 要参考旧文：先 list_articles 找 slug，再 read_article 读全文；正文里引用旧文用 link_article 插入链接。',
    '- 想知道读者在关注什么：list_comments 看最近评论、list_messages 看最近留言。',
    '- 用户说「存一下/保存」时调 save_draft（这只是存草稿，不是发布）。',
    '- 用户明确说「发布」时才调 publish，绝不主动发布；发布前可以先 save_draft 兜底。',
    '- slug 建议英文小写连字符，中文 slug 对 SEO 和分享不友好。',
    '- 发布是高危操作：只有用户明确说「发布」时才调 publish，说「保存」一律 save_draft。',
  ];

  const siteLines = [];
  if (site.categories?.length) siteLines.push(`已有分类：${site.categories.join('、')}`);
  if (site.tags?.length) siteLines.push(`已有标签：${site.tags.join('、')}`);
  if (site.recentArticles?.length) siteLines.push(`最近文章：\n${site.recentArticles.map((s) => `- ${s}`).join('\n')}`);
  if (siteLines.length) parts.push('', '站点信息（标签/分类请对号入座）：', ...siteLines);

  const ctx = [];
  if (context.title) ctx.push(`标题：${String(context.title).slice(0, 200)}`);
  if (context.slug) ctx.push(`slug：${String(context.slug).slice(0, 200)}`);
  if (context.status) ctx.push(`状态：${context.status}`);
  if (context.category) ctx.push(`当前分类：${String(context.category).slice(0, 60)}`);
  if (context.summary) ctx.push(`摘要：${String(context.summary).slice(0, 500)}`);
  if (Array.isArray(context.tags) && context.tags.length) ctx.push(`标签：${context.tags.join('、')}`);
  if (context.selection) {
    ctx.push(`用户在编辑器里选中的文本（润色/改写针对它，用 replace_selection）：\n${String(context.selection).slice(0, 3000)}`);
  }
  if (context.content) {
    const raw = String(context.content);
    ctx.push(`当前正文${raw.length > ctxChars ? '（已截断）' : ''}：\n\n${raw.slice(0, ctxChars)}`);
  }
  if (ctx.length) parts.push('', '当前正在编辑的文章：', ...ctx);
  // 对话超长时，最早的部分已被压成纪要（见 compressHistory），挂在最后
  if (context._compression) {
    parts.push('', '此前对话纪要（更早的细节已省略）：', String(context._compression).slice(0, 800));
  }
  return parts.join('\n');
}

/** 对话压缩：历史超出保留条数时，把最早的部分让模型压成一段纪要，
 *  挂在 system prompt 里（不插进对话流，避免模型误把它当新指令） */
async function compressHistory(messages, keep, cfg) {
  const { chatOnce } = require('../utils/aiClient');
  // 取被截掉的旧段（同一份清洗规则，孤儿 tool 也会被清掉）
  const oldSeg = trimChatMessages(messages.slice(0, messages.length - keep), 999);
  const oldText = oldSeg
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
    .map((m) => `${m.role === 'user' ? '站长' : 'AI'}：${String(m.content).slice(0, 500)}`)
    .join('\n')
    .slice(0, 6000);
  if (!oldText) return '';
  const summary = await chatOnce({
    messages: [
      {
        role: 'system',
        content: '把站长与 AI 写作助手的对话压缩成 150 字以内的纪要：站长要什么、已完成了哪些修改、正在处理什么。只输出纪要本身，不要评价、不要复述原文。',
      },
      { role: 'user', content: oldText },
    ],
    maxTokens: 300,
  }).catch(() => '');
  return String(summary || '').trim();
}

/**
 * 对话消息清洗：支持三角色透传
 *  - user / assistant（纯文本）
 *  - assistant + tool_calls（工具调用记录，function.arguments 必须是 JSON 字符串）
 *  - tool（工具执行结果，tool_call_id 与上面配对）
 * 只保留最近 24 条；孤儿 tool 消息（配对的 assistant 被截掉）直接丢弃，
 * 否则上游会因 id 对不上而 400。
 */
function trimChatMessages(messages, turns = 24) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < turns; i--) {
    const m = list[i];
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      out.unshift({ role: 'user', content: m.content.slice(0, 4000) });
      continue;
    }

    if (m.role === 'assistant') {
      const content = typeof m.content === 'string' ? m.content.slice(0, 4000) : '';
      const calls = Array.isArray(m.tool_calls)
        ? m.tool_calls.slice(0, 8).map((tc) => ({
            id: String(tc?.id || '').slice(0, 80),
            type: 'function',
            function: {
              name: String(tc?.function?.name || '').slice(0, 48),
              arguments:
                typeof tc?.function?.arguments === 'string'
                  ? tc.function.arguments.slice(0, 24000)
                  : '{}',
            },
          }))
        : [];
      const named = calls.filter((c) => c.function.name && c.id);
      if (!content && !named.length) continue;
      out.unshift(named.length ? { role: 'assistant', content, tool_calls: named } : { role: 'assistant', content });
      continue;
    }

    if (m.role === 'tool') {
      const id = String(m.tool_call_id || '').slice(0, 80);
      if (!id) continue;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || {});
      out.unshift({ role: 'tool', tool_call_id: id, content: content.slice(0, 8000) });
    }
  }

  // 清孤儿：tool 消息的 id 必须出现在它前面的某条 assistant.tool_calls 里
  const callIds = new Set();
  for (const m of out) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) callIds.add(c.id);
    }
  }
  return out.filter((m) => m.role !== 'tool' || callIds.has(m.tool_call_id));
}

/* ---------------- 图片搜索（Wikimedia Commons） ----------------
   源的选择：Openverse 从香港服务器不可达（实测 8s 超时），
   Wikimedia Commons 0.6s 可达、免 key、CC 许可、允许外链。 */

const WM_UA = 'XalorBlog/1.0 (https://blog.xalor.cn; admin image-search)';

/** 搜 Wikimedia Commons：只留 https、位图、宽度 ≥600 的结果 */
async function searchWikimediaImages(query) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrnamespace: '6', // File 命名空间：只搜文件页
    gsrsearch: query,
    gsrlimit: '16',
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: '800', // 封面用 800px 缩略图足够（原图动辄 8-15MB，不适合转存）
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': WM_UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {});
    pages.sort((a, b) => (a.index || 0) - (b.index || 0));
    const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const imgs = [];
    for (const p of pages) {
      const info = Array.isArray(p.imageinfo) ? p.imageinfo[0] : null;
      if (!info || !/^https:\/\//i.test(String(info.url || ''))) continue;
      if (/\.(svg|tif|tiff|pdf|djvu)(\?|$)/i.test(info.url)) continue;
      if ((info.width || 0) < 600) continue;
      const meta = info.extmetadata || {};
      imgs.push({
        url: info.url,
        thumb: /^https:\/\//i.test(String(info.thumburl || '')) ? info.thumburl : info.url,
        title: stripTags(String(p.title || '').replace(/^File:/, '')).slice(0, 90) || '未命名',
        creator: stripTags(meta.Artist?.value).slice(0, 60) || '佚名',
        license: stripTags(meta.LicenseShortName?.value).slice(0, 40) || '见来源页',
        page: String(info.descriptionurl || '').slice(0, 300),
        width: info.width,
        height: info.height,
      });
      if (imgs.length >= 9) break;
    }
    return imgs;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

router.get('/ai/images', asyncGuard(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return fail(res, '缺少搜索词', 400);
  const images = await searchWikimediaImages(q);
  if (!images.length) return ok(res, { images: [], source: 'wikimedia' }, '没搜到合适的图，换个词试试');
  return ok(res, { images, source: 'wikimedia' });
}));

/* ---------------- 图片转存：外链图 → 本站 uploads ----------------
   封面直接外链会随源站失效，转存一份到 /uploads/ai/ 更稳。 */

const IMG_MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** 图片源安全校验：仅 https、拒绝 IP 字面量/内网域名/userinfo（SSRF 防护） */
function riskyImageSource(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return true;
  }
  if (u.protocol !== 'https:') return true;
  if (u.username || u.password) return true;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // IPv6 字面量，一刀切拒绝
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4 字面量（含全部内网段）
  return false;
}

router.post('/ai/save-image', async (req, res) => {
  const raw = String(req.body?.url || '').trim().slice(0, 500);
  if (!raw || riskyImageSource(raw)) return fail(res, '不支持的图片地址', 400);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    // ⚠ redirect 必须显式设为 'manual'。
    //
    // riskyImageSource() 只校验**第一跳**的 URL。fetch 的默认值是 'follow'，
    // 于是 `https://任意公网域名/redir` → 302 `Location: http://169.254.169.254/...`
    // 会让真正的请求打到内网地址上，而校验早已通过 —— 这是教科书式的 SSRF 重定向绕过。
    // （已实测：302 到 127.0.0.1 的内网路径时，fetch 直接返回了内网内容。）
    //
    // 这里业务上是「抓取一张远程图片」，正常图床不会对图片地址做跳转，
    // 因此直接拒绝跳转比逐跳校验更简单可靠。若将来确有需要，
    // 必须对每一跳的 Location 重新调用 riskyImageSource()，并限制跳转次数。
    const r = await fetch(raw, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': WM_UA } });
    if (r.status >= 300 && r.status < 400) return fail(res, '图片地址不允许跳转', 400);
    if (!r.ok) return fail(res, `图片源返回 ${r.status}`, 502);
    if (Number(r.headers.get('content-length') || 0) > 5 * 1024 * 1024) return fail(res, '图片超过 5MB', 413);
    const mime = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = IMG_MIME_EXT[mime];
    if (!ext) return fail(res, '仅支持 jpg / png / webp', 415);

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return fail(res, '图片超过 5MB', 413);

    const fs = require('fs');
    const path = require('path');
    const dir = path.join(config.uploadDir, 'ai');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${require('crypto').randomBytes(6).toString('hex')}.${ext}`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, buf);
    fs.chmodSync(file, 0o644); // 与 multer 上传保持一致，nginx 才读得到
    return ok(res, { path: `/uploads/ai/${name}` }, '已保存到本站');
  } catch (e) {
    return fail(res, '下载图片失败', 502);
  } finally {
    clearTimeout(timer);
  }
});

/* ---------------- 站内文章检索（供 read/list 工具） ---------------- */

router.get('/ai/articles', asyncGuard(async (req, res) => {
  const keyword = String(req.query.keyword || '').trim().slice(0, 60);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);
  const q = db('articles').orderBy('updated_at', 'desc').limit(limit)
    .select('id', 'slug', 'title', 'status', 'published_at');
  if (keyword) {
    // 检索范围：标题 + 摘要 + 标签（此前仅标题，AI 找参考文章经常扑空）
    const like = `%${escapeLike(keyword)}%`;
    q.andWhere((b) => {
      b.where('title', 'like', like)
        .orWhere('summary', 'like', like)
        .orWhereIn('id', db('articles as a2')
          .join('article_tags as at2', 'at2.article_id', 'a2.id')
          .join('tags as t2', 't2.id', 'at2.tag_id')
          .where('t2.name', 'like', like)
          .select('a2.id'));
    });
  }
  const rows = await q;
  return ok(res, { articles: rows });
}));

/** 网页搜索（供 search_web 工具，浏览器端执行）：后台开关 + Key 双重门控 */
router.get('/ai/web-search', asyncGuard(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 400);
  if (!query) return fail(res, '缺少搜索词', 400);
  const settings = await getAllSettings();
  if (settings.websearch_enabled !== true) return fail(res, '网页搜索未开启（站点设置）', 400);
  const { searchWeb } = require('../utils/webSearch');
  const r = await searchWeb(query, { apiKey: settings.websearch_api_key });
  if (!r.ok) return fail(res, r.error || '搜索失败', 502);
  return ok(res, { results: r.results, cached: !!r.cached });
}));

router.get('/ai/article', asyncGuard(async (req, res) => {
  const slug = String(req.query.slug || '').trim().slice(0, 220);
  if (!slug) return fail(res, '缺少 slug', 400);
  const row = await db('articles').where('slug', slug).first();
  if (!row) return notFound(res, '文章不存在');
  const tagRows = await db('article_tags as at')
    .join('tags as t', 'at.tag_id', 't.id')
    .where('at.article_id', row.id)
    .select('t.name');
  const cat = row.category_id ? await db('categories').where('id', row.category_id).first('name') : null;
  return ok(res, {
    slug: row.slug,
    title: row.title,
    status: row.status,
    category: cat?.name || '',
    tags: tagRows.map((t) => t.name),
    summary: String(row.summary || '').slice(0, 500),
    content: String(row.content || '').slice(0, 8000),
  });
}));

/** 最近评论（供 list_comments 工具）：了解读者在问什么 */
router.get('/ai/comments', asyncGuard(async (req, res) => {
  const rows = await db('comments as c')
    .join('articles as a', 'c.article_id', 'a.id')
    .orderBy('c.created_at', 'desc')
    .limit(8)
    .select('c.nickname', 'c.status', 'c.created_at', db.raw('a.title as article_title'), db.raw('c.content as content'));
  return ok(res, {
    comments: rows.map((r) => ({
      article: r.article_title,
      nickname: r.nickname,
      status: r.status,
      content: String(r.content || '').slice(0, 200),
    })),
  });
}));

/** 最近留言（供 list_messages 工具） */
router.get('/ai/messages', async (req, res) => {
  const rows = await db('messages').orderBy('created_at', 'desc').limit(8)
    .select('nickname', 'content', 'status', 'created_at');
  return ok(res, {
    messages: rows.map((r) => ({
      nickname: r.nickname,
      status: r.status,
      content: String(r.content || '').slice(0, 200),
    })),
  });
});

/** 模型可用性：前端据此决定是否显示 AI 入口，以及提示"还没配模型" */
router.get('/ai/status', async (req, res) => {
  try {
    const { getAiConfig } = require('../utils/aiClient');
    const ai = await getAiConfig();
    return ok(res, { ready: ai.ready, model: ai.ready ? ai.model : '' }, 'ok');
  } catch (e) {
    return ok(res, { ready: false, model: '' }, 'ok');
  }
});

/** AI 写作助手：SSE 流式对话（支持工具结果回传的多轮循环） */
router.post('/ai/chat', async (req, res) => {
  // SSE 头：no-transform + X-Accel-Buffering 关掉 nginx 缓冲，否则流式会被攒成一坨
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      /* 连接已断 */
    }
  };

  // 客户端断开 → 中止上游请求，避免悬挂连接白烧 token
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const { messages = [], context = {} } = req.body || {};
    const { streamChat, getAiConfig } = require('../utils/aiClient');
    const aiCfg = await getAiConfig();
    const keep = aiCfg.ctxTurns || 24;
    let chat = trimChatMessages(messages, keep);
    if (!chat.length) {
      send({ type: 'error', message: '没有收到对话内容' });
      return res.end();
    }

    // 上下文压缩：对话超过保留条数且压缩开着 → 把最早的对话压成纪要塞进 system prompt
    let ctx = context;
    if (aiCfg.ctxCompress !== false && Array.isArray(messages) && messages.length > keep) {
      const summary = await compressHistory(messages, keep, aiCfg);
      if (summary) ctx = { ...context, _compression: summary };
    }

    const site = await loadSiteBrief().catch(() => ({}));
    // maxTokens 不传：让后台配置的 ai_max_tokens 生效（默认 4096）
    const payload = [{ role: 'system', content: buildWriterSystemPrompt(ctx, site, aiCfg.systemPrompt, aiCfg.ctxChars) }, ...chat];

    for await (const ev of streamChat({
      messages: payload,
      tools: AI_TOOLS,
      signal: ac.signal,
    })) {
      if (ev.type === 'text') send({ type: 'text', text: ev.text });
      // raw = 原始参数 JSON 串：客户端要靠它重建 assistant.tool_calls 才能回传结果
      else if (ev.type === 'tool') send({ type: 'action', id: ev.id, name: ev.name, args: ev.args, raw: ev.raw });
      else if (ev.type === 'usage') send({ type: 'usage', usage: ev.usage });
    }
    send({ type: 'done' });
  } catch (e) {
    send({ type: 'error', message: e.message || '生成失败' });
  } finally {
    res.end();
  }
});

// 纯函数随 router 一起导出（挂在函数对象上），不改变 `module.exports === router` 这个
// 既有形态 —— app.js 是 `require('./routes/admin')` 后直接 app.use(...)，不受影响。
// 这样 test/articlePatchContract.test.js 可以真实调用它，而不必为「导出一个函数」
// 在本任务允许改动的文件之外新建模块。
module.exports = router;
module.exports.resolveArticlePatch = resolveArticlePatch;
module.exports.DASHBOARD_TTL = DASHBOARD_TTL;
module.exports.readDashboardCache = readDashboardCache;
module.exports.writeDashboardCache = writeDashboardCache;
module.exports.invalidateDashboardCache = invalidateDashboardCache;
