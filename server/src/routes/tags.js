const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/response');

const router = express.Router();

/** 标签列表（公开，带文章数） */
router.get('/', async (req, res) => {
  try {
    const rows = await db('tags as t')
      .leftJoin('article_tags as at', 'at.tag_id', 't.id')
      .leftJoin('articles as a', function () {
        this.on('a.id', 'at.article_id').andOn('a.status', '=', db.raw('?', ['published']));
      })
      .groupBy('t.id')
      .select('t.id', 't.name', 't.slug')
      .count('a.id as article_count')
      .orderBy('article_count', 'desc');
    return ok(res, rows.map((r) => ({ ...r, article_count: Number(r.article_count) })));
  } catch (e) {
    return fail(res, '获取标签失败', 500);
  }
});

module.exports = router;
