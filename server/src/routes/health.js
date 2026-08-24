const express = require('express');
const { ok, fail } = require('../utils/response');

const router = express.Router();

async function dbStatus() {
  const dbConn = require('../db');
  await dbConn.raw('SELECT 1');
}

/** 存活探针：不查库，供进程是否在听端口 */
router.get('/live', (req, res) => ok(res, { status: 'ok' }, 'ok'));

/** 就绪探针：数据库不可用时 503 */
router.get('/ready', async (req, res) => {
  try {
    await dbStatus();
    return ok(res, { status: 'ok', db: 'up' }, 'ok');
  } catch (e) {
    return fail(res, '数据库不可用', 503);
  }
});

/** 兼容旧探活路径（含 DB 状态）。新部署请用 /live 与 /ready */
router.get('/', async (req, res) => {
  let db = 'down';
  try {
    await dbStatus();
    db = 'up';
  } catch (e) { /* DB 不可用 */ }
  return ok(res, { status: 'ok', db, time: new Date().toISOString() }, 'Xalor的小站 API 运行中');
});

module.exports = router;
