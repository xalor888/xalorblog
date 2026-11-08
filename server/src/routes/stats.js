const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { localDateStr } = require('../utils/datetime');
const { plainText } = require('../utils/markdownText');

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

/* ============ 阅读统计（整站字数 / 阅读时长） ============ */

/**
 * 阅读速度：中文 350 字/分钟、英文 250 词/分钟。
 *
 * 为什么必须分开：中英文的信息密度与阅读速度不同，混用单一除数会让同一篇文章
 * 在「详情页的 N 分钟」与「全站累计阅读时长」报出两个不同数字 —— 700 词纯英文
 * 按 350 算得 2 分钟、按词速算得 3 分钟，读者会同时看到这两个数。
 * 前端 `utils/wordStats.js` 的 readingMinutes/aggregateReading 已按 cn/en 折算，
 * 服务端必须用同一套公式（`web/scripts/test-word-stats.mjs` 有跨仓一致性断言）。
 */
const CN_WPM = 350;
const EN_WPM = 250;
/** 兼容旧导出：中文阅读速度。不要再把它当「通用字数速度」用于英文文本。 */
const WORDS_PER_MINUTE = CN_WPM;

/**
 * 统计口径：CJK 逐字 + 拉丁/数字按词串。
 *
 * 为什么先过 plainText()：
 *   1. 复用既有工具（utils/markdownText.js，RSS/分享页摘要同源），不另造一套「Markdown 感知」逻辑；
 *   2. 天然剔掉 Markdown 语法噪音（`#`、`*`、`>`、链接目标、图片 URL），
 *      否则 `[文字](https://very.long.url/x?a=1&b=2)` 会把 URL 当成字算进来；
 *   3. 代码块被替换为空格 —— 有意为之：本站把「字数/阅读时长」定位为**散文阅读量**，
 *      代码块不计入（它们是查阅式的，不是顺序阅读的）。
 *
 * 为什么正则用 `[\u4e00-\u9fa5]`：与后台编辑器 ArticleEdit.vue 的实时 wordCount 同语义，
 * 两处报出的「字数」才可以互相印证；换成更宽的 Unicode 区间会让同一篇文章出现两个数字。
 *
 * @param {string} md Markdown 原文
 * @returns {number} 字数（非负整数）
 */
// CJK 区段：基本区 + 扩展 A + 兼容汉字。
// 只写 [\u4e00-\u9fa5] 会漏掉「㐀」这类扩展 A 字与「豈」这类兼容汉字，
// 它们在前端 utils/wordStats.js 里是计入的 —— 两边对同一篇文章报不同字数。
// 前后端必须用同一组区段，scripts/test-word-stats.mjs 有一致性断言锁住。
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/**
 * 逐字/逐词统计（CJK 逐字 + 拉丁/数字按词串）。
 * 返回细分是为了让阅读时长能按 cn/en 各自的语速折算 —— 只给总数就无法区分
 * 「350 个汉字」和「350 个英文单词」，而这两者的阅读时间差 40%。
 *
 * @param {string} md Markdown 原文
 * @returns {{cjk:number, latin:number, total:number}}
 */
function countWordsDetail(md) {
  const text = plainText(md);
  if (!text) return { cjk: 0, latin: 0, total: 0 };
  // 正则字面量带 /g：String.match / replace 都会忽略并重置 lastIndex，不存在跨调用污染
  const cjk = (text.match(CJK_PATTERN) || []).length;
  // 先把 CJK 抹成空格，避免 `Vue3使用` 被当成 2 个词（应为 Vue3 + 使 + 用 = 3）
  const latin = (text.replace(CJK_PATTERN, ' ').match(/[a-zA-Z0-9]+/g) || []).length;
  return { cjk, latin, total: cjk + latin };
}

/** 兼容旧调用：只要总字数 */
function countWords(md) {
  return countWordsDetail(md).total;
}

/**
 * 把文章行汇总成阅读统计（**纯函数**，不碰 DB —— 便于 test/readingStats.test.js 直接驱动）。
 *
 * 「只统计已发布」在两处各做一次，是有意的冗余：
 *   - SQL 侧 `where status='published'`：能用上索引、不把草稿正文（mediumtext）读进内存；
 *   - 这里再 filter 一次：让「只算已发布」这条契约可以**脱离数据库**被单测锁住。
 *
 * 严格判定 `status === 'published'`（不给缺字段的行开后门）：
 * 若宽松地「无 status 即视为已发布」，将来某个调用方只 select 了 title/content，
 * 草稿就会静默混进统计；严格判定则会让那种调用方直接得到 0 篇 —— 是响亮的错，不是安静的错。
 *
 * @param {Array<{title?:string, slug?:string, content?:string, status?:string}>} rows
 */
function buildReadingStats(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && typeof row === 'object' && row.status === 'published'
  );

  let totalWords = 0;
  let totalCjk = 0;
  let totalLatin = 0;
  let longest = null;
  for (const row of list) {
    const d = countWordsDetail(row.content);
    totalWords += d.total;
    totalCjk += d.cjk;
    totalLatin += d.latin;
    // 严格大于：并列时保留先出现的那篇（SQL 按 published_at desc 排序 → 并列取较新的一篇）
    if (!longest || d.total > longest.words) {
      longest = { title: row.title, slug: row.slug, words: d.total };
    }
  }

  const totalArticles = list.length;
  return {
    total_words: totalWords,
    total_articles: totalArticles,
    // 空库必须给 0 而不是 NaN（0/0）：前端要拿它直接插值渲染
    avg_words: totalArticles ? Math.round(totalWords / totalArticles) : 0,
    longest,
    // 对「总量」一次性向上取整，而不是逐篇 ceil 后相加：
    // 逐篇取整在短文章多的库里会系统性高估（100 篇各 10 字 → 报 100 分钟，实际 3 分钟）。
    // 中文与英文分别按各自语速折算后再相加 —— 与前端 aggregateReading 同一公式，
    // 否则同一份数据会在「详情页」与「全站统计」给出两个分钟数。
    total_reading_minutes: totalWords === 0
      ? 0
      : Math.ceil(totalCjk / CN_WPM + totalLatin / EN_WPM),
  };
}

// 阅读统计缓存：本端点要读**全部已发布文章的正文**（mediumtext），
// 而个人主页与博客侧栏很可能在同一次页面加载里各调一次 → 不缓存就是每次两个全表扫。
// TTL 取 60 秒，与本文件既有的 summary 缓存同一量级（同一种「前台高频、结果不敏感」的接口沿用同一套惯例）。
//
// 缓存失效已接入 admin 的文章写入路径（创建 / 更新 / 复制 / 删除 / 批量删除 / 批量更新，
// 共 8 处调用），所以发布新文章后本端点会立刻反映，不必等 TTL 到期。
//
// 这里原有一段写着「已知缺口：invalidateReadingCache() 没有接入 admin 的写入路径，
// 新文章最多 60 秒后才计入」——那段注释在接入完成之后**就过期了**，却一直留着。
// 过期的注释比没有注释更坏：后来的读者会照它去「修」一个已经不存在的缺陷，
// 或者据此判断某个行为不可信。（我这次就是先读到它、差点直接去补代码的。）
const READING_TTL = 60 * 1000;
let readingCache = null;
let readingCacheAt = 0;

/**
 * 本端点要读的文章列。抽成常量而不是散在查询里，是因为 `status` 是**功能性**的：
 * buildReadingStats 严格判定 `status === 'published'`，投影里一旦漏掉它，
 * 端点会安静地返回「0 篇 0 字」而不是报错。常量让测试能直接对着同一份定义断言（见 test/readingStats.test.js）。
 */
const READING_FIELDS = ['title', 'slug', 'content', 'status'];

function invalidateReadingCache() {
  readingCache = null;
  readingCacheAt = 0;
}

/** 整站阅读统计：总字数、篇数、篇均字数、最长一篇、累计阅读时长 */
router.get('/reading', async (req, res) => {
  try {
    const now = Date.now();
    if (readingCache && now - readingCacheAt < READING_TTL) {
      return ok(res, readingCache);
    }
    // 排序只为让「并列最长」有确定结果，不参与其它计算
    const rows = await db('articles')
      .where('status', 'published')
      .orderBy([{ column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .select(...READING_FIELDS);
    readingCache = buildReadingStats(rows);
    readingCacheAt = now;
    return ok(res, readingCache);
  } catch (e) {
    return fail(res, '获取阅读统计失败', 500);
  }
});

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
// 供 test/readingStats.test.js 直接驱动（纯函数，无 DB / 无服务）
module.exports.buildReadingStats = buildReadingStats;
module.exports.countWords = countWords;
module.exports.countWordsDetail = countWordsDetail;
module.exports.invalidateReadingCache = invalidateReadingCache;
module.exports.WORDS_PER_MINUTE = WORDS_PER_MINUTE;
module.exports.CN_WPM = CN_WPM;
module.exports.EN_WPM = EN_WPM;
module.exports.READING_TTL = READING_TTL;
module.exports.READING_FIELDS = READING_FIELDS;
