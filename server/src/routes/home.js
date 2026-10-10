/**
 * 个人主页首屏摘要接口（GET /api/home/summary）
 *
 * 这是整个站点**唯一一处有意放宽的免票读接口**（见 app.js 的 GATE_SKIP）：
 * 目的只是让主页壳（名片 / 关于 / 友链预览 / 最近文章标题）无需等待 PoW 即可渲染，
 * 改善首访体验与 SEO 首屏。因此这里的返回**必须是固定白名单**：
 *
 *   - 不含任何密钥（ai_api_key / websearch_api_key 等一律不出现）
 *   - 不含手记正文（手记仍走闸门 + AES-GCM，见 routes/notes.js）
 *   - 友链/关于/文章标题本就通过 sitemap.xml、rss.xml、/links、/about 公开
 *
 * 仍受 WAF、IP 信誉闸门、antiBot（UA 特征）与独立限流保护。
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { getAllSettings } = require('../utils/settings');
const { plainText } = require('../utils/markdownText');
const { antiBot } = require('../middleware/antiBot');
const { report } = require('../middleware/ipGuard');

const router = express.Router();

// 独立限流：免票接口必须自带节流，否则会变成最廉价的采集入口
const summaryLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    report(req.ip, 'rate', 'HOME-SUMMARY 高频读取');
    res.status(429).json({ code: 1, message: '读取过于频繁，请稍后再试' });
  },
});

const LINKS_PREVIEW = 6;
const POSTS_PREVIEW = 5;
const ABOUT_EXCERPT_LEN = 200;

/** 运行天数：起始日期来自设置，非法/留空回落到 2024-01-01 */
function runningDays(sinceDate) {
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(String(sinceDate || '').trim())
    ? String(sinceDate).trim()
    : '2024-01-01';
  const start = new Date(`${raw}T00:00:00`).getTime();
  if (!Number.isFinite(start)) return 1;
  const diff = Math.floor((Date.now() - start) / 86400000);
  return diff > 0 ? diff : 1;
}

/** 额外社交链接（JSON 字符串）→ 数组；脏值降级为空数组 */
function parseSocialExtra(raw) {
  try {
    const list = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(list)) return [];
    return list
      // 协议再校验一次：这些 URL 会直接进客户端的 <a href>，
      // 不能只依赖「保存时被 saveSettings 清洗过」（设置表可能被直接改写）
      .filter((it) => it && typeof it === 'object' && it.label && /^https?:\/\//i.test(String(it.url || '')))
      .slice(0, 8)
      .map((it) => ({ label: String(it.label).slice(0, 30), url: String(it.url).slice(0, 300) }));
  } catch (e) {
    return [];
  }
}

/**
 * 首屏摘要的**唯一**组装点：固定白名单，逐字段显式挑选。
 * 抽出成纯函数有两个目的：
 *   1. 免票接口的暴露面可以脱离 DB 做单测（见 test/homeSummary.test.js）
 *   2. 任何新增字段都必须显式写进这里，杜绝「spread settings 顺手带出密钥」
 */
function buildSummary({ settings, links, articleCount, noteCount, posts }) {
  const aboutExcerpt = String(settings.home_about_excerpt || '').trim()
    || plainText(settings.about_content).slice(0, ABOUT_EXCERPT_LEN);

  return {
    site_name: settings.site_name,
    site_desc: settings.site_desc,
    avatar: settings.avatar,
    announcement: settings.announcement,
    icp: settings.icp,
    home_site_url: settings.home_site_url,
    hero: {
      greeting: settings.home_hero_greeting,
      role: settings.home_hero_role,
      quote: settings.home_hero_quote,
      status: settings.home_status,
    },
    since_date: settings.home_since_date || '2024-01-01',
    running_days: runningDays(settings.home_since_date),
    about_excerpt: aboutExcerpt,
    social: {
      github: settings.social_github,
      weibo: settings.social_weibo,
      email: settings.social_email,
      extra: parseSocialExtra(settings.home_social_extra),
    },
    links: (links || []).map((l) => ({
      id: l.id,
      name: l.name,
      url: l.url,
      avatar: l.avatar,
      description: l.description,
    })),
    stats: {
      article_count: Number(articleCount || 0),
      note_count: Number(noteCount || 0),
    },
    // 文章标题/摘要本就在 rss.xml 与 sitemap.xml 中公开，此处不算新增暴露
    recent_posts: (posts || []).map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      summary: p.summary,
      cover: p.cover,
      published_at: p.published_at,
    })),
  };
}

router.get('/summary', summaryLimiter, antiBot, async (req, res) => {
  try {
    const settings = await getAllSettings();

    const [linkRows, articleCount, noteCount, posts] = await Promise.all([
      db('links')
        .where('status', 'approved')
        .orderBy([{ column: 'sort', order: 'desc' }, { column: 'id', order: 'asc' }])
        .limit(LINKS_PREVIEW)
        .select('id', 'name', 'url', 'avatar', 'description'),
      db('articles').where('status', 'published').count('* as cnt').first(),
      db('notes').where('status', 'published').count('* as cnt').first(),
      db('articles')
        .where('status', 'published')
        .orderBy('published_at', 'desc')
        .limit(POSTS_PREVIEW)
        .select('id', 'title', 'slug', 'summary', 'cover', 'published_at'),
    ]);

    return ok(res, buildSummary({
      settings,
      links: linkRows,
      articleCount: articleCount?.cnt,
      noteCount: noteCount?.cnt,
      posts,
    }));
  } catch (e) {
    return fail(res, '获取主页信息失败', 500);
  }
});

module.exports = router;
module.exports.buildSummary = buildSummary;
module.exports.parseSocialExtra = parseSocialExtra;
module.exports.runningDays = runningDays;
module.exports.SUMMARY_FIELDS = [
  'site_name', 'site_desc', 'avatar', 'announcement', 'icp', 'home_site_url',
  'hero', 'since_date', 'running_days', 'about_excerpt', 'social', 'links',
  'stats', 'recent_posts',
];
