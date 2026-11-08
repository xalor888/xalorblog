const express = require('express');
const crypto = require('crypto');
const asyncGuard = require('../utils/asyncGuard');
const { etagMatches } = require('../utils/etag');
const db = require('../db');
const config = require('../config');
const { getAllSettings } = require('../utils/settings');
const { plainText } = require('../utils/markdownText');
const { isHomeHost, resolveBaseUrl } = require('../utils/siteHost');
const { noteSummary } = require('../utils/notes');
const sanitizeHtml = require('sanitize-html');

const router = express.Router();

// 对外 URL 统一走配置前缀（与 share.js 一致）：自定义 API_PREFIX 后
// RSS 链接/sitemap/robots 里的 /api 硬编码会全部指向死链
const apiPrefix = config.apiPrefix;

/**
 * 条件发送：ETag + If-None-Match → 304（订阅器高频轮询时显著节省带宽）
 * 附带 30 秒公共缓存（与内部缓存 TTL 一致）
 */
function conditionalSend(req, res, content, type) {
  const etag = '"' + crypto.createHash('sha1').update(content).digest('hex').slice(0, 24) + '"';
  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=30');
  // 同一个 URL（/sitemap.xml、/rss.xml）按 Host 返回主页版或博客版：
  // 必须声明 Vary: Host，否则共享缓存（CDN/中间代理）会按 URL 把其中一个域的
  // 版本喂给另一个域。用 append 而不是 set —— 全局 gzip 中间件已写入
  // Vary: Accept-Encoding，set 会把它覆盖掉。
  res.append('Vary', 'Host');
  // 弱比较 + 多值 + `*`：nginx/CDN 常把强 ETag 改写成 `W/"..."`，
  // 严格相等会让这些请求全部错过 304（订阅器每次轮询都白重建整页）。详见 utils/etag.js。
  if (etagMatches(req.headers['if-none-match'], etag)) {
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

/**
 * 规范化成 W3C Datetime 的日期部分（`YYYY-MM-DD`），**无法规范化时返回空串**。
 *
 * 为什么必须有这一步：`String(a.updated_at || a.published_at).slice(0, 10)` 在两个字段
 * 都是 NULL 时会得到字符串 `"null"`（String(null) 不是空串！），于是 sitemap 里出现
 * `<lastmod>null</lastmod>`；而 `String(c.updated_at || '')` 在 NULL 时得到 `""`，
 * 产出的是**空元素** `<lastmod></lastmod>`。
 * 两种都不是合法 W3C Datetime —— 搜索引擎要么忽略该字段，要么把整条 URL 判为格式错误。
 *
 * 数据库允许 published_at 为 NULL（后台「导入备份」路径会写入 null），所以这不是理论问题。
 *
 * @param {*} value 日期字符串 / Date / null
 * @returns {string} `YYYY-MM-DD` 或 `''`
 */
function w3cDate(value) {
  if (!value) return '';
  // Date 实例不能走 String() —— 那会得到 "Sun Mar 15 2026 ..."，截前 10 位是星期几
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    // 按**本地**时区格式化，与数据库里存的 localDateTimeStr 同一口径
    // （用 toISOString 会在 UTC+8 把「凌晨」的日期算成前一天）
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** XML 转义 */
function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 站点基础 URL：优先使用设置中的显式 URL（防 Nginx 终止 TLS 时协议推导为 http）。
 * 同一后端服务两个域名 —— 主页域（HOME_SITE_HOST）取 home_site_url，
 * 其余取博客的 site_url，保证各自的 RSS/Sitemap 里是本站链接。
 */
async function baseSiteUrl(req) {
  try {
    const settings = await getAllSettings();
    const configured = isHomeHost(req) ? settings.home_site_url : settings.site_url;
    if (configured) return resolveBaseUrl(req, configured);
  } catch (e) { /* 忽略 */ }
  return resolveBaseUrl(req, '');
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
function channelImageFor(avatar, siteUrl, siteName, preferImage) {
  // 优先用站点专门的分享图（`og_image`），其次头像。
  // 头像通常是正方形小图，而 RSS 阅读器的频道图按方图显示尚可，
  // 但两处用不同的图会让人以为是两个站 —— 与分享卡片保持同一口径。
  const pick = preferImage || avatar;
  if (!pick) return '';
  const url = pick.startsWith('http') ? pick : siteUrl + pick;
  return `    <image>
      <url>${esc(url)}</url>
      <title>${esc(siteName)}</title>
      <link>${esc(siteUrl)}/</link>
    </image>`;
}

/** 仅允许 http(s)/站内/相对 URL（RSS 输出中的 img/link 防 javascript:/data: 注入） */
function safeRssUrl(url) {
  const u = String(url || '').trim();
  if (u.startsWith('//')) return ''; // 拒绝协议相对外链
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
const RSS_HTML_OPTIONS = {
  allowedTags: ['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'em', 'a', 'img', 'br', 'hr', 'blockquote'],
  allowedAttributes: { a: ['href'], img: ['src', 'alt'] },
  allowedSchemes: ['http', 'https'],
};

/** 清洗 RSS 全文 HTML：剔除正文中残留的裸脚本与事件属性 */
function sanitizeRssHtml(html) {
  return sanitizeHtml(html, RSS_HTML_OPTIONS);
}

/**
 * 正文 h1 降级为 h2。
 *
 * 为什么：文章正文常以 `# 标题` 开头。网页端有 demoteH1 处理（每页只能有一个 h1，
 * 由页面模板自己提供），但 RSS 的 content:encoded 直接输出 markdown 转换结果 ——
 * 实测 6 条订阅内容**每条都含一个 `<h1>`**。阅读器本身会渲染条目标题，
 * 再叠一个正文 h1 就是两个主标题，且与网页端语义不一致。
 */
function demoteH1(html) {
  return String(html || '').replace(/<h1(\b[^>]*)>([\s\S]*?)<\/h1>/gi, '<h2$1>$2</h2>');
}

async function robotsTxt(req) {
  const siteUrl = await baseSiteUrl(req);
  // 个人主页域：hash 路由的 SPA，可收录的入口只有主页与手记时间线
  if (isHomeHost(req)) {
    return `# Xalor 的个人主页 robots.txt
User-agent: *
Disallow: ${apiPrefix}/
Disallow: /uploads/

# 放行：订阅源、站点地图与首屏摘要（真实内容，利于收录与社交预览）
Allow: ${apiPrefix}/rss.xml
Allow: ${apiPrefix}/sitemap.xml
Allow: ${apiPrefix}/share-page
Allow: ${apiPrefix}/home/summary

Sitemap: ${siteUrl}${apiPrefix}/sitemap.xml
`;
  }
  // 注：不要加 `Disallow: /#/`。那条规则写在这里**匹配不到任何真实请求** ——
  // 爬虫发请求时 fragment（`#` 之后）不会出现在请求行里，/#/articles 对它就是 `/`。
  // 曾经有过这一行，是无效规则；删掉是因为它让人误以为 hash 路由已被处理。
  return `# Xalor的小站 robots.txt
User-agent: *
Disallow: ${apiPrefix}/
Disallow: /uploads/

# 放行：RSS / Sitemap / 分享页（真实 HTML，利于收录与社交预览）
Allow: ${apiPrefix}/rss.xml
Allow: ${apiPrefix}/sitemap.xml
Allow: ${apiPrefix}/share/
Allow: ${apiPrefix}/share-page

Sitemap: ${siteUrl}${apiPrefix}/sitemap.xml
`;
}

/** robots.txt（/api 下也提供，根路径由 app.js 挂载） */
router.get('/robots.txt', asyncGuard(async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.append('Vary', 'Host'); // 同上：按 Host 分派主页版/博客版
  return res.send(await robotsTxt(req));
}));

/**
 * 个人主页版 RSS：只出「手记」摘要（正文仍受闸门 + AES-GCM 保护，不进订阅源）。
 * 与博客版共用 /rss.xml 路径，按请求 Host 分派，缓存键也必须分开。
 */
async function homeRssXml(req) {
  const settings = await getAllSettings();
  const siteUrl = await baseSiteUrl(req);
  const notes = await db('notes')
    .where('status', 'published')
    .orderBy([{ column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(20)
    .select('id', 'content', 'images', 'excerpt', 'published_at', 'created_at', 'mood', 'location', 'likes');

  const items = notes
    .map((n) => {
      const s = noteSummary(n);
      // 指向手记列表的分享页（真实路径）。
      // hash URL 在 RSS 里还能被点开，但搜索引擎收录时 # 之后会被丢弃，
      // 与新 sitemap 的口径保持一致更好排查。
      const link = `${esc(siteUrl)}${apiPrefix}/share-page/notes`;
      const date = String(s.published_at || s.created_at || '').slice(0, 10);
      return `    <item>
      <title>${esc(`手记 · ${date}`)}</title>
      <link>${link}</link>
      <guid isPermaLink="false">${link}</guid>
      <pubDate>${toRfc822(s.published_at || s.created_at)}</pubDate>
      <description>${esc(s.excerpt)}</description>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${esc(settings.site_name)} · 手记</title>
    <link>${esc(siteUrl)}/</link>
    <description>${esc(settings.site_desc)}</description>
    <language>zh-cn</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${channelImageFor(settings.avatar, siteUrl, settings.site_name, settings.og_image)}
${items}
  </channel>
</rss>`;
}

/** RSS 2.0 订阅源（按 Host 分派：主页域出手记，博客域出文章） */
router.get('/rss.xml', async (req, res) => {
  try {
    const home = isHomeHost(req);
    const xml = await cached(home ? 'rss:home' : 'rss', async () => {
      if (home) return homeRssXml(req);
      const settings = await getAllSettings();
      const siteUrl = await baseSiteUrl(req);
      const articles = await db('articles')
        .where('status', 'published')
        .orderBy('published_at', 'desc')
        .limit(20)
        // created_at 必须一起取：published_at 允许为 NULL（后台「导入备份」路径），
        // 而 RSS 的 pubDate 是必填元素 —— 没有兜底就只能用「当前时间」，
        // 结果是一条 2019 年的旧文每次被轮询都显示"刚刚发布"，订阅器会当成新文章推送。
        .select('id', 'title', 'slug', 'summary', 'content', 'cover', 'published_at', 'created_at');

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
          // 全文：mdToHtml 做 XML 转义 + URL 绝对化，sanitizeRssHtml 再做白名单清洗
          const full = demoteH1(sanitizeRssHtml(mdToHtml(a.content, siteUrl)));
          const link = `${esc(siteUrl)}${apiPrefix}/share/${a.slug}`;
          // 兜底到 created_at：与 sitemap 的 lastmod、list/archive 的排序时间轴口径一致
          //（三处都按 `published_at || created_at` 处理，否则同一篇文章在不同出口显示不同日期）
          const pubDate = toRfc822(a.published_at || a.created_at);
          const cats = (tagsByArticle[a.id] || [])
            .map((t) => `      <category>${esc(t)}</category>`)
            .join('\n');
          // 摘要模式：description 即摘要，content:encoded 与全文模式互斥输出
          const useFull = settings.rss_full_content === true;
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

      // channel/link 曾是 `${siteUrl}/api/share/` —— 空 slug 的分享路径，不是有效页面。
      // 频道链接应指向站点首页（RSS 里 channel/link 的语义就是「这个频道的网站」）。
      return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${esc(settings.site_name)}</title>
    <link>${esc(siteUrl)}/</link>
    <description>${esc(settings.site_desc)}</description>
    <language>zh-cn</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${channelImageFor(settings.avatar, siteUrl, settings.site_name, settings.og_image)}
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

/** 个人主页版 sitemap：主页 + 手记时间线 + 每条已发布手记详情 */
async function homeSitemapXml(req) {
  const siteUrl = await baseSiteUrl(req);
  const notes = await db('notes')
    .where('status', 'published')
    .orderBy([{ column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .select('id', 'published_at', 'updated_at');

  const staticPages = [
    { path: '', priority: '1.0' },
    { path: 'notes', priority: '0.8' },
  ]
    .map((p) => `  <url>
    <loc>${esc(siteUrl)}${apiPrefix}/share-page${p.path ? '/' + p.path : ''}</loc>
    <priority>${p.priority}</priority>
  </url>`)
    .join('\n');

  // 手记：暂无独立分享页，指向手记列表的分享页。
  // 用 hash URL 的话搜索引擎只会看到首页，等于没提交。
  // lastmod 只在有合法日期时输出：手记允许 published_at/updated_at 均为 NULL，
  // 原写法 `String(... || '').slice(0,10)` 会产出空元素 `<lastmod></lastmod>`，
  // 那不是合法 W3C Datetime（同 blog sitemap 里的 `"null"` 问题，见 w3cDate 注释）。
  const notesLm = notes.length ? w3cDate(notes[0].updated_at || notes[0].published_at) : '';
  const noteUrls = notes.length
    ? `  <url>
    <loc>${esc(siteUrl)}${apiPrefix}/share-page/notes</loc>${notesLm ? `\n    <lastmod>${notesLm}</lastmod>` : ''}
    <priority>0.6</priority>
  </url>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticPages}
${noteUrls}
</urlset>`;
}

/** sitemap.xml（按 Host 分派：主页域出手记，博客域出文章） */
router.get('/sitemap.xml', async (req, res) => {
  try {
    const home = isHomeHost(req);
    const xml = await cached(home ? 'sitemap:home' : 'sitemap', async () => {
      if (home) return homeSitemapXml(req);
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

      // 首页 + 归档/标签/关于/收藏等常驻页。
      // ⚠ 必须用 `/api/share-page/*` 这种**真实路径**，不能用 `/#/xxx`：
      // 搜索引擎会丢弃 `#` 之后的部分，hash URL 等于全部指向首页，
      // 整份 sitemap 形同虚设（实测 11 条记录全部无效）。
      // 从 share.js 的 STATIC_PAGES 派生，而不是再写一份硬编码 ——
      // 原来这里是 7 项，而 share.js 有 9 项：`articles` 页从来没进过 sitemap
      // （分类变体都列了，无分类的列表页反而没列，而它覆盖的文章最全）。
      // `notes` 排除：它有独立的 lastmod 逻辑，见下面的 noteUrls。
      const staticPageKeys = require('./share').STATIC_PAGE_KEYS.filter((k) => k !== 'notes');
      const staticPages = staticPageKeys
        .map((p) => `  <url>
    <loc>${esc(siteUrl)}${apiPrefix}/share-page${p ? '/' + p : ''}</loc>
    <priority>${p ? '0.4' : '1.0'}</priority>
  </url>`)
        .join('\n');

      const catUrls = categories
        .map((c) => {
          const lm = w3cDate(c.updated_at);
          // 无合法日期时整条省略 lastmod，而不是输出空元素
          return `  <url>
    <loc>${esc(siteUrl)}${apiPrefix}/share-page/articles?category=${encodeURIComponent(c.slug)}</loc>${lm ? `\n    <lastmod>${lm}</lastmod>` : ''}
    <priority>0.5</priority>
  </url>`;
        })
        .join('\n');

      const postUrls = articles
        .map((a) => {
          // lastmod 优先文章更新时间（内容修改后搜索引擎应重新抓取）。
          // 两者都为 NULL 时 w3cDate 返回空串 → 省略该元素（不能写字面量 "null"）。
          const lastmod = w3cDate(a.updated_at || a.published_at);
          return `  <url>
    <loc>${esc(siteUrl)}${apiPrefix}/share/${a.slug}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
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
module.exports.w3cDate = w3cDate;
module.exports.sanitizeRssHtml = sanitizeRssHtml;
module.exports.mdToHtml = mdToHtml;
