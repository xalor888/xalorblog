const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { getAllSettings } = require('../utils/settings');
const { plainText } = require('../utils/markdownText');

const router = express.Router();

/**
 * 条件发送：ETag + If-None-Match → 304（订阅器高频轮询时显著节省带宽）
 * 附带 30 秒公共缓存（与内部缓存 TTL 一致）
 */
function conditionalSend(req, res, content, type) {
  const etag = '"' + crypto.createHash('sha1').update(content).digest('hex').slice(0, 24) + '"';
  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=30');
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  res.set('Content-Type', type);
  return res.send(content);
}

// 短时缓存（RSS 订阅器会高频轮询，30 秒内直接返回缓存）
const cache = { rss: null, rssAt: 0, sitemap: null, sitemapAt: 0 };
const CACHE_TTL = 30 * 1000;

function cached(key, gen) {
  const now = Date.now();
  if (cache[key] && now - cache[key + 'At'] < CACHE_TTL) {
    return Promise.resolve(cache[key]);
  }
  return gen().then((value) => {
    cache[key] = value;
    cache[key + 'At'] = now;
    return value;
  });
}

/** XML 转义 */
function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 站点基础 URL：优先使用设置中的 site_url（防 Nginx 终止 TLS 时协议推导为 http） */
async function baseSiteUrl(req) {
  try {
    const settings = await getAllSettings();
    if (settings.site_url) return String(settings.site_url).replace(/\/+$/, '');
  } catch (e) { /* 忽略 */ }
  return req.protocol + '://' + req.get('host');
}

/** 本地时间字符串(YYYY-MM-DD HH:mm:ss) → UTC RFC 822（RSS 规范）
 * 注意：数据库存的是本地时间（+08:00），不能直接追加 Z 当 UTC 解析 */
function toRfc822(localStr) {
  const d = new Date(String(localStr || '').replace(' ', 'T'));
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

/** XML CDATA 安全包裹：内容中的 ]]> 必须拆分，否则会提前终止 CDATA 段 */
function cdata(s) {
  return String(s).replace(/\]\]>/g, ']]]]><![CDATA[>');
}

/**
 * 封面媒体标签（RSS 阅读器缩略图）：
 * - <enclosure>：RSS 2.0 标准附件（封面图）
 * - <media:thumbnail>：Media RSS 扩展（Feedly 等主流阅读器识别）
 * 无封面时返回空串，不产生空标签
 */
function enclosureFor(cover, siteUrl) {
  if (!cover) return '';
  const url = cover.startsWith('http') ? cover : siteUrl + cover;
  const ext = String(url.split('?')[0]).toLowerCase().match(/\.(jpe?g|png|gif|webp)$/)?.[1];
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext ? `image/${ext}` : 'image/jpeg';
  // length 无法对远程图片可靠获取，按规范填 0（多数阅读器仅依赖 url+type）
  return `      <enclosure url="${esc(url)}" type="${mime}" length="0"/>
      <media:thumbnail url="${esc(url)}"/>`;
}

/**
 * 频道站标（RSS 2.0 channel image：阅读器显示站点 logo，替代默认图标）
 * 使用站点设置的头像（默认 logo.png）；无头像时返回空串
 */
function channelImageFor(avatar, siteUrl, siteName) {
  if (!avatar) return '';
  const url = avatar.startsWith('http') ? avatar : siteUrl + avatar;
  return `    <image>
      <url>${esc(url)}</url>
      <title>${esc(siteName)}</title>
      <link>${esc(siteUrl)}/</link>
    </image>`;
}

/** 仅允许 http(s)/站内/相对 URL（RSS 输出中的 img/link 防 javascript:/data: 注入） */
function safeRssUrl(url) {
  const u = String(url || '').trim();
  return /^(https?:\/\/|\/|\.\/|\.\.\/)/i.test(u) ? u : '';
}

/** Markdown 转简易 HTML（供 RSS 全文输出；URL 经 safeRssUrl 过滤） */
/**
 * Markdown 转简易 HTML（供 RSS 全文输出；URL 经 safeRssUrl 过滤 + XML 转义 + 绝对化）
 * 所有用户输入点（代码块/标题/列表/强调/链接文本）均做 XML 转义，
 * 防止正文中的 & < > 破坏 RSS 文档或注入 HTML。
 * @param {string} md 正文
 * @param {string} siteUrl 站点绝对 URL（相对路径图片/链接转绝对，阅读器跨域才能加载）
 */
function mdToHtml(md = '', siteUrl = '') {
  // 相对路径 → 绝对（仅 / 开头站内路径；外链与协议相对保持原样）
  const abs = (u) => (/^\//.test(u) ? siteUrl.replace(/\/+$/, '') + u : u);
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  return String(md)
    .replace(/```([\s\S]*?)```/g, (m, code) => `<pre><code>${esc(code)}</code></pre>`)
    .replace(/`([^`]*)`/g, (m, code) => `<code>${esc(code)}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (m, alt, url) => {
      const safe = safeRssUrl(url);
      return safe ? `<img src="${esc(abs(safe))}" alt="${esc(alt)}"/>` : '';
    })
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (m, text, url) => {
      const safe = safeRssUrl(url);
      return safe ? `<a href="${esc(abs(safe))}">${esc(text)}</a>` : esc(text);
    })
    .replace(/^###\s+(.*)$/gm, (m, t) => `<h3>${esc(t)}</h3>`)
    .replace(/^##\s+(.*)$/gm, (m, t) => `<h2>${esc(t)}</h2>`)
    .replace(/^#\s+(.*)$/gm, (m, t) => `<h1>${esc(t)}</h1>`)
    // 连续列表项（-/*/+ 开头）合并为一个 <ul>，避免每项单独包裹导致嵌套错乱
    .replace(/(?:^|\n)\s*[-*+]\s+[^\n]+(?:\n\s*[-*+]\s+[^\n]+)*/g, (m) => {
      const items = m
        .split('\n')
        .map((line) => line.replace(/^\s*[-*+]\s+/, '').trim())
        .map(esc)
        .join('</li><li>');
      return `<ul><li>${items}</li></ul>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, (m, t) => `<strong>${esc(t)}</strong>`)
    .replace(/\*([^*]+)\*/g, (m, t) => `<em>${esc(t)}</em>`)
    .replace(/\n\n+/g, '\n')
    .replace(/\n/g, '<br/>');
}

/** robots.txt 内容生成 */
async function robotsTxt(req) {
  const siteUrl = await baseSiteUrl(req);
  return `# Xalor的小站 robots.txt
User-agent: *
Disallow: /api/
Disallow: /uploads/
Disallow: /#/

# 放行：RSS / Sitemap / 分享页（真实 HTML，利于收录与社交预览）
Allow: /api/rss.xml
Allow: /api/sitemap.xml
Allow: /api/share/

Sitemap: ${siteUrl}/api/sitemap.xml
`;
}

/** robots.txt（/api 下也提供，根路径由 app.js 挂载） */
router.get('/robots.txt', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  return res.send(await robotsTxt(req));
});

/** RSS 2.0 订阅源 */
router.get('/rss.xml', async (req, res) => {
  try {
    const xml = await cached('rss', async () => {
      const settings = await getAllSettings();
      const siteUrl = await baseSiteUrl(req);
      const articles = await db('articles')
        .where('status', 'published')
        .orderBy('published_at', 'desc')
        .limit(20)
        .select('id', 'title', 'slug', 'summary', 'content', 'cover', 'published_at');

      // 标签聚合：文章 id → 标签名数组（RSS <category> 富化订阅端分类展示）
      const tagRows = await db('article_tags as at')
        .join('tags as t', 'at.tag_id', 't.id')
        .whereIn('at.article_id', articles.map((a) => a.id))
        .select('at.article_id', 't.name');
      const tagsByArticle = {};
      for (const r of tagRows) {
        (tagsByArticle[r.article_id] ||= []).push(r.name);
      }

      const items = articles
        .map((a) => {
          const desc = esc(a.summary || plainText(a.content).slice(0, 300));
          // 全文：mdToHtml 内部已做 XML 转义 + URL 绝对化，直接进 CDATA
          const full = mdToHtml(a.content, siteUrl);
          const link = `${esc(siteUrl)}/api/share/${a.slug}`;
          const pubDate = toRfc822(a.published_at);
          const cats = (tagsByArticle[a.id] || [])
            .map((t) => `      <category>${esc(t)}</category>`)
            .join('\n');
          // 摘要模式：description 即摘要，content:encoded 与全文模式互斥输出
          const useFull = settings.rss_full_content !== false;
          const contentPart = useFull
            ? `      <content:encoded><![CDATA[${cdata(full)}]]></content:encoded>`
            : '';
          return `    <item>
      <title>${esc(a.title)}</title>
      <link>${link}</link>
      <!-- guid 基于 slug（不随域名迁移变化），订阅器跨站点迁移不重复 -->
      <guid isPermaLink="false">xalor-blog:post:${a.slug}</guid>
${cats}
      <pubDate>${pubDate}</pubDate>
      <description>${useFull ? desc : `${desc}（摘要模式：仅显示前 300 字，阅读全文请访问站点）`}</description>
${enclosureFor(a.cover, siteUrl)}
${contentPart}
    </item>`;
        })
        .join('\n');

      return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${esc(settings.site_name)}</title>
    <link>${esc(siteUrl)}/api/share/</link>
    <description>${esc(settings.site_desc)}</description>
    <language>zh-cn</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${channelImageFor(settings.avatar, siteUrl, settings.site_name)}
${items}
  </channel>
</rss>`;
    });

    return conditionalSend(req, res, xml, 'application/rss+xml; charset=utf-8');
  } catch (e) {
    console.error('[rss]', e.message);
    return res.status(500).send('RSS 生成失败');
  }
});

/** sitemap.xml */
router.get('/sitemap.xml', async (req, res) => {
  try {
    const xml = await cached('sitemap', async () => {
      const siteUrl = await baseSiteUrl(req);
      const [articles, categories] = await Promise.all([
        db('articles')
          .where('status', 'published')
          .orderBy('published_at', 'desc')
          .select('slug', 'published_at', 'updated_at'),
        db('categories')
          .whereExists(function () {
            this.select('*').from('articles as a')
              .whereRaw('a.category_id = categories.id')
              .where('a.status', 'published');
          })
          .select('slug', 'updated_at'),
      ]);

      // 首页 + 归档/标签/关于/收藏等常驻页（hash 路由，分享页为真实 HTML 供抓取）
      const staticPages = ['', 'archive', 'tags', 'about', 'bookmarks', 'links', 'messages']
        .map((p) => `  <url>
    <loc>${esc(siteUrl)}/#/${p}</loc>
    <priority>${p ? '0.4' : '1.0'}</priority>
  </url>`)
        .join('\n');

      const catUrls = categories
        .map((c) => `  <url>
    <loc>${esc(siteUrl)}/#/articles?category=${encodeURIComponent(c.slug)}</loc>
    <lastmod>${String(c.updated_at || '').slice(0, 10)}</lastmod>
    <priority>0.5</priority>
  </url>`)
        .join('\n');

      const postUrls = articles
        .map((a) => {
          // lastmod 优先文章更新时间（内容修改后搜索引擎应重新抓取）
          const lastmod = String(a.updated_at || a.published_at).slice(0, 10);
          return `  <url>
    <loc>${esc(siteUrl)}/api/share/${a.slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>0.6</priority>
  </url>`;
        })
        .join('\n');

      return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticPages}
${catUrls}
${postUrls}
</urlset>`;
    });

    return conditionalSend(req, res, xml, 'application/xml; charset=utf-8');
  } catch (e) {
    console.error('[sitemap]', e.message);
    return res.status(500).send('Sitemap 生成失败');
  }
});

module.exports = router;
module.exports.robotsTxt = robotsTxt;
