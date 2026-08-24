const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { localDateStr } = require('../utils/datetime');

const router = express.Router();

// UV 去重快路径：内存记录「日期:IP:FP」已计过（命中直接跳过 DB 查询）
// 权威去重在 visit_uv 表（持久化，服务重启不虚高）
const uvSeen = new Set();
const UV_CLEAN_INTERVAL = 6 * 3600 * 1000;
let lastClean = Date.now();

// PV 防刷：同一 IP 每 10 秒最多计 1 次 PV（持有票据即可调用 record 接口，
// 无此限制会被脚本周期性刷新刷爆浏览量统计）
const pvGuard = new Map(); // ip -> 下次允许时间戳
const PV_INTERVAL = 10 * 1000;

function canCountPv(ip) {
  const now = Date.now();
  const next = pvGuard.get(ip) || 0;
  if (now < next) return false;
  pvGuard.set(ip, now + PV_INTERVAL);
  if (pvGuard.size > 10000) {
    for (const [k, t] of pvGuard) {
      if (t < now) pvGuard.delete(k);
    }
    while (pvGuard.size > 8000) {
      const oldest = pvGuard.keys().next().value;
      if (oldest === undefined) break;
      pvGuard.delete(oldest);
    }
  }
  return true;
}

function cleanUvSeen() {
  if (Date.now() - lastClean < UV_CLEAN_INTERVAL) return;
  const today = localDateStr();
  for (const key of uvSeen) {
    if (!key.startsWith(today)) uvSeen.delete(key);
  }
  lastClean = Date.now();
}

/** 站点访问统计：PV 每次 +1（IP 防刷窗口），UV 按 IP+设备指纹每日去重（持久化到 visit_uv 表） */
router.post('/record', async (req, res) => {
  try {
    const today = localDateStr();
    const ip = req.ip || 'unknown';
    const fp = String(req.headers['x-fp'] || '').slice(0, 64) || ip;
    const uvKey = `${today}:${ip}:${fp}`;
    // 隐私友好：仅存哈希，不留明文 IP
    const h = crypto.createHash('sha256').update(uvKey).digest('hex').slice(0, 32);

    cleanUvSeen();
    let isNewUv = false;
    if (!uvSeen.has(uvKey)) {
      // 持久化去重：INSERT ... ON CONFLICT DO NOTHING，插入成功才算新 UV。
      // 注意：mysql2 的 INSERT IGNORE 被忽略时返回 [0]（insertId=0）而非空数组，
      // 用 length 判断会把被忽略的插入也误判为新 UV（并发下 UV 虚增）；
      // 必须以 insertId 非零为准
      const inserted = await db('visit_uv')
        .insert({ day: today, h })
        .onConflict(['day', 'h'])
        .ignore();
      isNewUv = Array.isArray(inserted) && Number(inserted[0]) > 0;
      if (isNewUv) uvSeen.add(uvKey);
    }
    // UV 内存集合硬上限：超限时先清历史日期，再按最旧丢弃今天的键
    if (uvSeen.size > 200000) {
      for (const key of uvSeen) {
        if (!key.startsWith(today)) uvSeen.delete(key);
      }
      let excess = uvSeen.size - 150000;
      for (const key of uvSeen) {
        if (excess <= 0) break;
        uvSeen.delete(key);
        excess -= 1;
      }
    }

    // PV 防刷窗口内：仅 UV 计一次（避免完全静默，且 UV 本身有日级去重不受影响）
    const pv = canCountPv(ip) ? 1 : 0;
    await db('visits')
      .insert({ day: today, pv, uv: isNewUv ? 1 : 0 })
      .onConflict('day')
      .merge({
        pv: db.raw('visits.pv + ?', [pv]),
        uv: isNewUv ? db.raw('visits.uv + 1') : db.raw('visits.uv'),
      });
    // 写入后立刻作废摘要缓存，否则前台刷新仍显示 60 秒前的 0
    summaryCache = null;
    summaryCacheAt = 0;
    return ok(res, { uv_counted: isNewUv, pv_counted: pv === 1 });
  } catch (e) {
    return fail(res, '统计失败', 500);
  }
});

// summary 短时缓存（前台页脚每次加载都会调用；60s 内直接返回缓存）
let summaryCache = null;
let summaryCacheAt = 0;
const SUMMARY_TTL = 60 * 1000;

/** 前台展示：总 PV/UV、今日、文章数、评论数 */
router.get('/summary', async (req, res) => {
  try {
    const now = Date.now();
    if (summaryCache && now - summaryCacheAt < SUMMARY_TTL) {
      return ok(res, summaryCache);
    }
    const today = localDateStr();
    const [total, todayRow, articles, comments] = await Promise.all([
      db('visits').select(db.raw('COALESCE(SUM(pv),0) as pv'), db.raw('COALESCE(SUM(uv),0) as uv')).first(),
      db('visits').where('day', today).first(),
      db('articles').where('status', 'published').count('* as cnt').first(),
      db('comments').where('status', 'approved').count('* as cnt').first(),
    ]);
    summaryCache = {
      total_pv: Number(total.pv) || 0,
      total_uv: Number(total.uv) || 0,
      today_pv: Number(todayRow && todayRow.pv) || 0,
      today_uv: Number(todayRow && todayRow.uv) || 0,
      article_count: Number(articles.cnt) || 0,
      comment_count: Number(comments.cnt) || 0,
    };
    summaryCacheAt = now;
    return ok(res, summaryCache);
  } catch (e) {
    return fail(res, '获取统计失败', 500);
  }
});

module.exports = router;
