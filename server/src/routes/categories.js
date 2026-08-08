const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/response');

const router = express.Router();

/** 分类列表（公开，带文章数；sort 升序 + id 稳定排序） */
router.get('/', async (req, res) => {
  try {
    const rows = await db('categories as c')
      .leftJoin('articles as a', function () {
        this.on('a.category_id', 'c.id').andOn('a.status', '=', db.raw('?', ['published']));
      })
      .groupBy('c.id')
      .select('c.id', 'c.name', 'c.slug', 'c.description', 'c.color', 'c.sort')
      .count('a.id as article_count')
      .orderBy([{ column: 'c.sort', order: 'asc' }, { column: 'c.id', order: 'asc' }]);
    return ok(res, rows.map((r) => ({ ...r, article_count: Number(r.article_count) })));
  } catch (e) {
    return fail(res, '获取分类失败', 500);
  }
});

module.exports = router;
