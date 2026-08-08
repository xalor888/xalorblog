const express = require('express');
const { ok } = require('../utils/response');

const router = express.Router();

/** 健康检查（含 DB 状态，供监控/负载均衡探活） */
router.get('/', async (req, res) => {
  let db = 'down';
  try {
    const dbConn = require('../db');
    await dbConn.raw('SELECT 1');
    db = 'up';
  } catch (e) { /* DB 不可用 */ }
  return ok(res, { status: 'ok', db, time: new Date().toISOString() }, 'Xalor的小站 API 运行中');
});

module.exports = router;
