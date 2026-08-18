/**
 * 管理后台 API 路由（全部挂载在秘钥路径 /api/<adminPath>/ 之下）
 * 所有写操作与管理列表接口都隐藏在由 JWT_SECRET 派生的秘钥路径内，
 * 公共前缀下探测不到任何后台接口 —— 与前台 404 同形，路由存在性不可枚举。
 * 所有路由统一要求 JWT + 指纹 + 服务端会话三重认证。
 */

const express = require('express');
const db = require('../db');
const config = require('../config');
const { ok, fail, notFound } = require('../utils/response');
const { slugify } = require('../utils/slugify');
const { authRequired } = require('../middleware/auth');
const { localDateTimeStr } = require('../utils/datetime');
const { cleanText, cleanLine, safeUrl, safeEmail, escapeLike } = require('../utils/sanitize');
const { securityStats, unban } = require('../middleware/ipGuard');
const { verifyTicket } = require('../middleware/gate');
const { saveSettings, getAllSettings, ALLOWED_KEYS } = require('../utils/settings');

const router = express.Router();

// 统一认证：本路由下的全部接口都要求已登录
router.use(authRequired);
// 角色纵深：仅管理员角色可访问后台（当前系统无其他角色，为未来扩展留闸）
router.use((req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ code: 1, message: '访问被拒绝' });
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
        if (category_id && category_id === '0') b.whereNull('a.category_id');
        else if (category_id && Number.isInteger(cid) && cid > 0) b.where('a.category_id', cid);
        if (keyword) {
          const kw = escapeLike(String(keyword).slice(0, 50));
          b.where((q) => q.where('a.title', 'like', `%${kw}%`).orWhere('a.content', 'like', `%${kw}%`));
        }
      });
    // 排序：latest 默认（创建）/ updated 最近更新 / views 浏览量
    const orderBy =
      sort === 'updated'
        ? [{ column: 'a.updated_at', order: 'desc' }]
        : sort === 'views'
          ? [{ column: 'a.views', order: 'desc' }]
          : [{ column: 'a.created_at', order: 'desc' }];

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
    const encrypted = pass ? encryptPayload(row.content, pass) : '';
    return ok(res, {
      ...row,
      content: encrypted,
      content_enc: !!encrypted,
      tags: tagRows.map((t) => t.name),
    });
  } catch (e) {
    return fail(res, '获取文章失败', 500);
  }
});

/** 创建文章 */
router.post('/articles', async (req, res) => {
  try {
    const { title, content, summary, cover, category_id, tags = [], status = 'draft', is_top = false, allow_comment = true } = req.body;
    const cleanTitle = cleanLine(title, 200);
    const cleanContent = cleanText(content, 100000);
    if (!cleanTitle) return fail(res, '标题不能为空');
    if (!cleanContent) return fail(res, '正文不能为空');
    const cleanStatus = status === 'published' ? 'published' : 'draft';
    const cleanIsTop = toBool(is_top, false);
    const cleanAllowComment = toBool(allow_comment, true);

    // 边界场景：引用的分类已被删除（如另一管理员同时操作）→ 明确拒绝而非写入孤儿 ID
    if (category_id) {
      const cat = await db('categories').where('id', Number(category_id)).first('id');
      if (!cat) return fail(res, '所选分类不存在，请刷新页面后重试');
    }

    const slug = slugify(req.body.slug || cleanTitle, await db('articles').pluck('slug'));
    const published_at = cleanStatus === 'published' ? localDateTimeStr() : null;

    // 事务：文章正文与标签关联原子落库（标签中途失败整体回滚，杜绝半成品文章）
    const trx = await db.transaction();
    let id;
    try {
      [id] = await trx('articles').insert({
        title: cleanTitle, slug, content: cleanContent,
        summary: cleanText(summary || cleanContent.replace(/[#>*_`~\-\[\]()!]/g, '').slice(0, 150), 500),
        cover: safeCover(cover), category_id: category_id || null,
        status: cleanStatus, is_top: cleanIsTop, allow_comment: cleanAllowComment,
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
          [tagId] = await trx('tags').insert({ name: t, slug: slugify(t, await db('tags').pluck('slug')) });
        }
        await trx('article_tags').insert({ article_id: id, tag_id: tagId });
      }
      await trx.commit();
    } catch (e) {
      await trx.rollback();
      throw e;
    }
    return ok(res, { id }, '文章创建成功');
  } catch (e) {
    // 并发创建同标题/同 slug 时的唯一约束冲突：给出明确提示而非笼统 500
    if (e.code === 'ER_DUP_ENTRY') {
      return fail(res, '链接地址已存在，请更换标题后重试');
    }
    return fail(res, '创建文章失败', 500);
  }
});

/** 更新文章 */
router.put('/articles/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, '参数不合法');
    const row = await db('articles').where('id', id).first();
    if (!row) return notFound(res, '文章不存在');

    const { title, content, summary, cover, category_id, tags, status, is_top, allow_comment, slug, published_at } = req.body;
    const patch = { updated_at: db.fn.now() };
    if (title !== undefined) patch.title = cleanLine(title, 200);
    if (content !== undefined) patch.content = cleanText(content, 100000);
    if (summary !== undefined) patch.summary = cleanText(summary, 500);
    if (cover !== undefined) patch.cover = safeCover(cover);
    if (category_id !== undefined) {
      // 边界场景：引用的分类已被删除 → 明确拒绝而非写入孤儿 ID
      if (category_id) {
        const cat = await db('categories').where('id', Number(category_id)).first('id');
        if (!cat) return fail(res, '所选分类不存在，请刷新页面后重试');
      }
      patch.category_id = category_id || null;
    }
    if (is_top !== undefined) patch.is_top = toBool(is_top, row.is_top);
    if (allow_comment !== undefined) patch.allow_comment = toBool(allow_comment, row.allow_comment);
    if (slug) {
      patch.slug = slugify(slug, (await db('articles').whereNot('id', id).pluck('slug')));
    }
    if (status !== undefined) {
      if (!['draft', 'published'].includes(status)) return fail(res, '非法状态', 400);
      if (status !== row.status) {
        patch.status = status;
        if (status === 'published' && !row.published_at) {
          patch.published_at = localDateTimeStr();
        }
      }
    }
    // 手动调整发布时间（补发旧文/时间线归档）：严格格式校验
    if (published_at !== undefined && typeof published_at === 'string' && published_at) {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(published_at)) {
        return fail(res, '发布时间格式不正确', 400);
      }
      patch.published_at = published_at;
    }
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
            [tagId] = await trx('tags').insert({ name: t, slug: slugify(t, await db('tags').pluck('slug')) });
          }
          await trx('article_tags').insert({ article_id: id, tag_id: tagId });
        }
      }
      await trx.commit();
    } catch (e) {
      await trx.rollback();
      throw e;
    }
    return ok(res, null, '文章更新成功');
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
      // 标题去重：已有同名副本时追加序号（如「副本 (2)」）
      let title = `${cleanLine(row.title, 190)}（副本）`;
      const dupCount = await trx('articles').where('title', 'like', `${title.replace(/[%_\\]/g, '\\$&')}%`).count('* as cnt').first();
      if (Number(dupCount.cnt || 0) > 0) title = `${cleanLine(row.title, 186)}（副本 ${Number(dupCount.cnt) + 1}）`;
      const [aid] = await trx('articles').insert({
        title,
        slug: slugify(title, await trx('articles').pluck('slug')),
        summary: row.summary || '',
        content: row.content || '',
        cover: row.cover || '',
        category_id: row.category_id,
        status: 'draft',
        is_top: false,
        allow_comment: row.allow_comment,
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
      const needDate = await db('articles')
        .whereIn('id', safeIds)
        .whereNull('published_at')
        .pluck('id');
      if (needDate.length) {
        await db('articles').whereIn('id', needDate).update({ published_at: localDateTimeStr() });
      }
      patch.status = 'published';
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
        [tagId] = await db('tags').insert({ name: tagName, slug: slugify(tagName, await db('tags').pluck('slug')) });
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
        const title = cleanLine(it.title, 200);
        if (!title) { skipped += 1; continue; }
        const content = String(it.content || '');
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
          let cat = await trx('categories').where('name', cname).first('id');
          if (!cat) {
            const [cid] = await trx('categories').insert({
              name: cname,
              slug: slugify(cname, await trx('categories').pluck('slug')),
            });
            cat = { id: cid };
          }
          category_id = cat.id;
        }
        const tsRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        const now = db.fn.now();
        const [aid] = await trx('articles').insert({
          title,
          slug: slug || slugify(title, await trx('articles').pluck('slug')),
          summary: cleanLine(it.summary, 300),
          content,
          // 封面：允许站内相对路径（/uploads/xxx.png，本站导出格式），
          // 其余必须通过 safeUrl（http/https + 非内网 + 无危险协议）
          cover: (() => {
            const c = String(it.cover || '').slice(0, 500);
            if (!c) return '';
            if (c.startsWith('/')) return c;
            return safeUrl(c);
          })(),
          status: it.status === 'published' ? 'published' : 'draft',
          is_top: !!it.is_top,
          views: Math.max(0, Math.min(9999999, Number(it.views) || 0)),
          likes: Math.max(0, Math.min(9999999, Number(it.likes) || 0)),
          category_id,
          published_at: tsRe.test(String(it.published_at || '')) ? it.published_at : null,
          created_at: tsRe.test(String(it.created_at || '')) ? it.created_at : now,
          updated_at: now,
        });
        // 标签：按名称查找或创建
        const tagNames = Array.isArray(it.tags)
          ? [...new Set(it.tags.map((t) => cleanLine(String((t && t.name) || t), 50)).filter(Boolean))]
          : [];
        const tagIds = [];
        for (const tn of tagNames) {
          let tag = await trx('tags').where('name', tn).first('id');
          if (!tag) {
            const [tid] = await trx('tags').insert({ name: tn, slug: slugify(tn, await trx('tags').pluck('slug')) });
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
    return ok(res, { imported, skipped }, `导入完成：新增 ${imported} 篇，跳过 ${skipped} 篇`);
  } catch (e) {
    return fail(res, '导入失败', 500);
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

/** 封面只允许 http(s) 外链或站内绝对路径，拒绝协议相对/路径穿越 */
function safeCover(input) {
  if (typeof input !== 'string') return '';
  const v = input.trim().replace(/[\r\n]+/g, '').slice(0, 500);
  if (!v) return '';
  if (v.startsWith('/') && !v.startsWith('//') && !v.includes('..')) return v;
  return safeUrl(v, 500);
}

/** 创建分类 */
router.post('/categories', async (req, res) => {
  try {
    const { name, description = '', color = '#e4573d', slug } = req.body;
    const cleanName = cleanLine(name, 50);
    if (!cleanName) return fail(res, '分类名称不能为空');
    await db('categories').insert({
      name: cleanName,
      slug: slugify(slug || cleanName, await db('categories').pluck('slug')),
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
    if (name !== undefined) patch.name = cleanLine(name, 50);
    if (description !== undefined) patch.description = cleanLine(description, 255);
    if (color !== undefined) patch.color = validHexColor(color);
    if (slug) patch.slug = slugify(slug, (await db('categories').whereNot('id', id).pluck('slug')));
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
    await db('tags').insert({ name, slug: slugify(name, await db('tags').pluck('slug')) });
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
      if (articleIds.length) {
        await trx('article_tags')
          .insert(articleIds.map((aid) => ({ article_id: aid, tag_id: toId })))
          .onConflict(['article_id', 'tag_id'])
          .ignore();
      }
      await trx('article_tags').where('tag_id', fromId).del();
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
        .orderBy('c.created_at', 'desc')
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
      .orderBy('c.created_at', 'desc')
      .limit(1000)
      .select('c.id', 'c.nickname', 'c.email', 'c.content', 'c.status', 'c.ai_reason', 'c.created_at', 'a.title as article_title');
    const esc = (s) => {
      const str = String(s ?? '');
      const safe = /^[=+\-@\t\r]/.test(str.trimStart()) ? `'${str}` : str;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    // 状态中文化（导出可读性）
    const statusZh = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };
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
    if (!['pending', 'approved', 'rejected'].includes(status)) return fail(res, '非法状态');
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

/** 批量删除评论（显式清理子回复） */
router.post('/comments/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, '请选择要删除的评论');
    if (ids.length > 500) return fail(res, '单次最多操作 500 条');
    const safeIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!safeIds.length) return fail(res, '参数不合法');
    await db('comments').whereIn('parent_id', safeIds).del();
    await db('comments').whereIn('id', safeIds).del();
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
    if (!['approved', 'rejected', 'pending'].includes(status)) return fail(res, '非法状态');
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
    const affected = await db('comments')
      .where('status', 'pending')
      .limit(1000)
      .update({ status: 'approved' });
    return ok(res, { affected }, `已通过 ${affected} 条待审评论`);
  } catch (e) {
    return fail(res, '操作失败', 500);
  }
});

// ============ 友链 ============

/** 后台友链列表 */
router.get('/links/admin/list', async (req, res) => {
  try {
    const { status } = req.query;
    const base = db('links').modify((b) => {
      if (status && status !== 'all') b.where('status', status);
    });
    const rows = await base.orderBy('created_at', 'desc').select('*');
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
    if (!['pending', 'approved', 'rejected'].includes(status)) return fail(res, '非法状态');
    const patch = { status };
    // 排序值钳制（0-100，防恶意写入超范围值破坏排序稳定性）
    if (sort !== undefined) {
      const n = Number(sort);
      if (!Number.isFinite(n)) return fail(res, '排序值不合法');
      patch.sort = Math.min(100, Math.max(0, Math.round(n)));
    }
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
    const affected = await db('links')
      .where('status', 'pending')
      .limit(1000)
      .update({ status: 'approved' });
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
    const { status, ai_only } = req.query;
    const base = db('messages')
      .modify((b) => {
        if (status && status !== 'all') b.where('status', status);
        // 仅看 AI 标记（复核/批量处理入口）
        if (ai_only === '1') {
          b.whereNotNull('ai_reason').where('ai_reason', '!=', '');
        }
      });
    const [total, rows] = await Promise.all([
      base.clone().count('id as cnt').first(),
      base.clone()
        .orderBy('created_at', 'desc')
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
    const { status, ai_only } = req.query;
    const base = db('messages').modify((b) => {
      if (status && status !== 'all') b.where('status', status);
      if (ai_only === '1') {
        b.whereNotNull('ai_reason').where('ai_reason', '!=', '');
      }
    });
    const rows = await base
      .orderBy('created_at', 'desc')
      .limit(1000)
      .select('id', 'nickname', 'email', 'content', 'status', 'ai_reason', 'created_at');
    const esc = (s) => {
      const str = String(s ?? '');
      const safe = /^[=+\-@\t\r]/.test(str.trimStart()) ? `'${str}` : str;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    // 状态中文化（导出可读性）
    const statusZh = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };
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
    if (!['pending', 'approved', 'rejected'].includes(status)) return fail(res, '非法状态');
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

/** 全部通过（留言审核提速）：当前待审留言一键通过（上限 1000） */
router.post('/messages/approve-all', async (req, res) => {
  try {
    const affected = await db('messages')
      .where('status', 'pending')
      .limit(1000)
      .update({ status: 'approved' });
    return ok(res, { affected }, `已通过 ${affected} 条待审留言`);
  } catch (e) {
    return fail(res, '操作失败', 500);
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

// ============ 统计 / 设置 ============

/** 后台仪表盘数据 */
router.get('/stats/dashboard', async (req, res) => {
  try {
    const { localDateStr, localDateTimeStr } = require('../utils/datetime');
    const today = localDateStr();
    // 时间范围可配置（7-90 天，默认 14）
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const since = localDateStr(new Date(Date.now() - (days - 1) * 24 * 3600 * 1000));

    const [trend, byCategory, pendingComments, pendingLinks, pendingMessages, total, topArticles, recentComments, recentMessages, recentArticles, commentTrend, messageTrend, draftCount, totalViews, totalComments, totalMessages, todayVisits, uncategorized] = await Promise.all([
      db('visits')
        .whereBetween('day', [since, today])
        .orderBy('day', 'asc')
        .select('day', 'pv', 'uv'),
      db('categories as c')
        .leftJoin('articles as a', function () {
          this.on('a.category_id', 'c.id').andOn('a.status', '=', db.raw('?', ['published']));
        })
        .groupBy('c.id')
        .select('c.name')
        .count('a.id as cnt'),
      db('comments').where('status', 'pending').count('* as cnt').first(),
      db('links').where('status', 'pending').count('* as cnt').first(),
      db('messages').where('status', 'pending').count('* as cnt').first(),
      db('articles').count('* as cnt').first(),
      // 热门文章 TOP 5（按浏览量）
      db('articles')
        .where('status', 'published')
        .orderBy('views', 'desc')
        .limit(5)
        .select('id', 'title', 'slug', 'views', 'likes', 'published_at'),
      // 最新动态：最近 5 条评论（含所属文章标题）
      db('comments as cm')
        .leftJoin('articles as a', 'cm.article_id', 'a.id')
        .orderBy('cm.created_at', 'desc')
        .limit(5)
        .select('cm.id', 'cm.nickname', 'cm.content', 'cm.status', 'cm.created_at', 'a.title as article_title'),
      // 最新动态：最近 5 条留言
      db('messages').orderBy('created_at', 'desc').limit(5).select('id', 'nickname', 'content', 'status', 'created_at'),
      // 最新动态：最近 5 篇文章
      db('articles').where('status', 'published').orderBy('published_at', 'desc').limit(5).select('id', 'title', 'slug', 'published_at'),
      // 互动趋势：近 14 天评论/留言数（按天聚合，图表展示）
      db('comments')
        .where('created_at', '>=', localDateTimeStr(new Date(Date.now() - 13 * 24 * 3600 * 1000)))
        .groupBy(db.raw('DATE(created_at)'))
        .select(db.raw('DATE(created_at) as day'))
        .count('* as cnt'),
      db('messages')
        .where('created_at', '>=', localDateTimeStr(new Date(Date.now() - 13 * 24 * 3600 * 1000)))
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
    for (const r of trend) trendMap[r.day] = { day: r.day, pv: r.pv, uv: r.uv };
    const fullTrend = [];
    for (let i = 0; i < days; i++) {
      const d = localDateStr(new Date(Date.now() - (days - 1 - i) * 24 * 3600 * 1000));
      fullTrend.push(trendMap[d] || { day: d, pv: 0, uv: 0 });
    }

    return ok(res, {
      trend: fullTrend,
      // 分类分布（含未分类条目，便于发现未归类文章）
      by_category: (() => {
        const list = byCategory.map((r) => ({ name: r.name, count: Number(r.cnt) }));
        const uncat = Number(uncategorized.cnt || 0);
        if (uncat > 0) list.push({ name: '未分类', count: uncat });
        return list;
      })(),
      // 互动趋势：14 天补零对齐
      interact_trend: (() => {
        const cMap = {}; const mMap = {};
        for (const r of commentTrend) cMap[r.day] = Number(r.cnt);
        for (const r of messageTrend) mMap[r.day] = Number(r.cnt);
        const out = [];
        for (let i = 0; i < 14; i++) {
          const d = localDateStr(new Date(Date.now() - (13 - i) * 24 * 3600 * 1000));
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
    });
  } catch (e) {
    return fail(res, '获取仪表盘数据失败', 500);
  }
});

/** 保存站点设置（后台） */
router.put('/settings', async (req, res) => {
  try {
    const settings = await saveSettings(req.body || {});
    return ok(res, settings, '设置已保存');
  } catch (e) {
    return fail(res, '保存设置失败', 500);
  }
});

/** 设置导出（备份/迁移）：全量 JSON 下载 */router.get('/settings/export', async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.set('Content-Disposition', 'attachment; filename="settings-backup.json"');
    return res.send(JSON.stringify(settings, null, 2));
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
      if (typeof v === 'string' && v.length > 5000) continue;
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
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req2, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) cb(null, true);
      else cb(new Error('仅支持图片文件'));
    },
  });

  /** 上传后二次校验：magic bytes 防伪造扩展名 */
  function verifyMagic(req2, res2, next2) {
    if (!req2.file) return next2();
    const ext = path.extname(req2.file.filename).toLowerCase();
    const check = MAGIC[ext];
    const buffer = fs.readFileSync(req2.file.path);
    if (check && !check(buffer)) {
      fs.unlinkSync(req2.file.path);
      return fail(res2, '文件内容与扩展名不符，已拒绝');
    }
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
          const stripped = stripExif(fs.readFileSync(req.file.path));
          fs.writeFileSync(req.file.path, stripped);
        } catch (e) { /* 忽略：保留原文件 */ }
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
  // 提取字符串中全部 /uploads/<file> 引用（支持 cover URL、正文 Markdown、设置项值）
  const extract = (s) => {
    if (typeof s !== 'string') return;
    for (const m of s.matchAll(/\/uploads\/([A-Za-z0-9._-]+)/g)) referenced.add(m[1]);
  };
  const [covers, contents, settings] = await Promise.all([
    db('articles').whereNotNull('cover').pluck('cover'),
    db('articles').pluck('content'),
    db('settings').pluck('value'),
  ]);
  covers.forEach(extract);
  contents.forEach(extract);
  settings.forEach(extract);
  return referenced;
}

/** 上传文件列表（名称/大小/修改时间/是否被引用，倒序，上限 500） */
router.get('/uploads/list', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(config.uploadDir)) return ok(res, []);
    const referenced = await collectReferencedUploads();
    const files = fs.readdirSync(config.uploadDir)
      .filter((f) => {
        try { return fs.statSync(path.join(config.uploadDir, f)).isFile(); } catch (e) { return false; }
      })
      .map((f) => {
        const st = fs.statSync(path.join(config.uploadDir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs, used: referenced.has(f) };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 500);
    return ok(res, files);
  } catch (e) {
    return fail(res, '读取失败', 500);
  }
});

/** 删除单个上传文件（严格文件名校验防路径穿越；被引用中的图片拒绝删除） */
router.delete('/uploads/:filename', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const name = String(req.params.filename || '');
    // 仅允许服务端生成的随机文件名格式（杜绝 ../ 穿越与扩展名伪装）
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name)) return fail(res, '文件名不合法');
    const uploadRoot = path.resolve(config.uploadDir);
    const full = path.resolve(uploadRoot, name);
    if (full !== path.join(uploadRoot, name) || !full.startsWith(uploadRoot + path.sep)) {
      return fail(res, '文件名不合法');
    }
    if (!fs.existsSync(full)) return fail(res, '文件不存在');

    // 引用保护：正在被文章/设置使用的图片禁止删除（防文章图裂）
    const referenced = await collectReferencedUploads();
    if (referenced.has(name)) {
      return fail(res, '该图片正被文章或站点设置引用，不能直接删除', 400);
    }

    fs.unlinkSync(full);
    return ok(res, null, '已删除');
  } catch (e) {
    return fail(res, '删除失败', 500);
  }
});

/**
 * 扫描 uploads 目录，删除未被任何内容引用的孤儿文件
 * 引用来源：文章封面 / 文章正文 / 站点设置中的图片路径
 * 安全窗口：24 小时内新上传的文件跳过（防止刚上传、引用尚未保存的竞态误删）
 */
router.post('/uploads/cleanup-orphans', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const referenced = await collectReferencedUploads();

    if (!fs.existsSync(config.uploadDir)) return ok(res, { scanned: 0, deleted: [] });
    const cutoff = Date.now() - 24 * 3600e3;
    const files = fs.readdirSync(config.uploadDir);
    const deleted = [];
    for (const f of files) {
      const full = path.join(config.uploadDir, f);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      if (!referenced.has(f)) {
        try { fs.unlinkSync(full); deleted.push(f); } catch (e) { /* 占用/权限：跳过 */ }
      }
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
router.post('/security/unban', (req, res) => {
  const ip = cleanLine(req.body?.ip, 64);
  if (!ip || require('net').isIP(ip) === 0) return fail(res, 'IP 地址格式不正确');
  unban(ip);
  return ok(res, null, '已解封');
});

/** 管理员操作审计日志（近 100 条） */
router.get('/security/audit', async (req, res) => {
  try {
    const rows = await db('audit_logs')
      .orderBy('created_at', 'desc')
      .limit(100)
      .select('id', 'username', 'action', 'detail', 'ip', 'created_at');
    return ok(res, rows);
  } catch (e) {
    return ok(res, []);
  }
});

module.exports = router;
