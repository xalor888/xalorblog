const express = require('express');
const db = require('../db');
const config = require('../config');
const { getAllSettings } = require('../utils/settings');
const { plainText } = require('../utils/markdownText');

const router = express.Router();

/** HTML 转义 */
function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 文章分享页：返回带 OG/Twitter meta 的完整 HTML
 * 爬虫（微信/Twitter/QQ 等）抓取此 URL 可正确展示标题、摘要、封面预览
 * 访问路径: /api/share/:slug
 */
router.get('/share/:slug', async (req, res) => {
  try {
    const [article, settings] = await Promise.all([
      db('articles as a')
        .leftJoin('categories as c', 'a.category_id', 'c.id')
        .where('a.slug', req.params.slug)
        .where('a.status', 'published')
        .select('a.title', 'a.content', 'a.summary', 'a.cover', 'a.published_at', 'c.name as category_name')
        .first(),
      getAllSettings(),
    ]);

    if (!article) {
      // 软 404：noindex 防占位页被搜索引擎收录
      return res.status(404).send('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>文章不存在</title></head><body><h1>文章不存在</h1></body></html>');
    }

    const siteUrl = settings.site_url
      ? String(settings.site_url).replace(/\/+$/, '')
      : req.protocol + '://' + req.get('host');
    // 原始 URL（JSON-LD 结构化数据用，JSON.stringify 自行转义）
    const rawShareUrl = `${siteUrl}/#/article/${req.params.slug}`;
    const rawSelfUrl = `${siteUrl}${config.apiPrefix}/share/${req.params.slug}`;
    // HTML 属性中的 URL 全量转义（slug 虽由服务端生成，纵深防御防任何字符注入 meta）
    const shareUrl = esc(rawShareUrl);
    const selfUrl = esc(rawSelfUrl);
    const title = esc(article.title);
    const rawDesc = article.summary || plainText(article.content).slice(0, 200);
    const desc = esc(rawDesc);
    // 封面缺失时回退站点头像（保证社交平台有可抓取的 OG 图片）
    /**
     * 分享卡片配图，按优先级取：
     *   1. 文章封面；
     *   2. 站点专门的分享图 `og_image`（宽幅，适合卡片）；
     *   3. 站点头像；
     *   4. 内置 `/og-image.png`。
     *
     * 为什么要有第 2、4 级：原实现无封面时退回 `avatar`，而本站头像就是
     * `/logo.png`（正方形小图）—— 作为 1200×630 的分享大图会被裁得很糟。
     * 而 `web/public/og-image.png` 一直是存在的、专为此准备的，却从未被引用。
     *
     * 全部绝对化：社交平台不解析相对路径。
     */
    const toAbs = (p) => (!p ? '' : (String(p).startsWith('http') ? String(p) : siteUrl + String(p)));
    const cover = toAbs(article.cover)
      || toAbs(settings.og_image)
      || toAbs(settings.avatar)
      || siteUrl + '/og-image.png';
    const siteName = esc(settings.site_name || 'Xalor的小站');

    // 结构化数据（BlogPosting：富摘要/知识图谱收录；JSON.stringify 保证标题等特殊字符安全嵌入）
    const authorName = settings.author || settings.nickname || settings.site_name || 'Xalor的小站';
    // JSON.stringify 不转义 < —— 若字段值含 </script> 序列会提前终止 script 块
    // （设置项存储无标签清洗，如站点名）。替换 < 为 \u003c 是防 JSON-LD 注入的标准做法
    const ldJson = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: article.title,
      description: String(rawDesc || '').slice(0, 200),
      datePublished: article.published_at,
      mainEntityOfPage: { '@type': 'WebPage', '@id': rawSelfUrl },
      author: { '@type': 'Person', name: authorName },
      publisher: { '@type': 'Organization', name: settings.site_name || 'Xalor的小站' },
      image: [cover],
    }).replace(/</g, '\\u003c');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - ${siteName}</title>

<!-- 结构化数据 -->
<script type="application/ld+json">${ldJson}</script>

<!-- Open Graph -->
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:site_name" content="${siteName}">
<meta property="og:url" content="${shareUrl}">
<meta property="og:image" content="${esc(cover)}">
<meta property="og:locale" content="zh_CN">

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${esc(cover)}">

<!-- 跳转到 SPA（人类访问自动重定向） -->
<meta http-equiv="refresh" content="0;url=${shareUrl}">
<link rel="canonical" href="${selfUrl}">
</head>
<body>
<noscript>
<p>正在跳转…如未自动跳转，请<a href="${shareUrl}">点击这里</a>。</p>
</noscript>
</body>
</html>`;

    // 公开分享页：可缓存 5 分钟（OG 抓取器高频抓取减负；文章修改后最多 5 分钟生效）
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (e) {
    console.error('[share]', e.message);
    return res.status(500).send('生成分享页失败');
  }
});

/**
 * 静态页面分享页：/api/share-page/:page
 *
 * 为什么需要：sitemap 里原本给静态页（首页/归档/标签/关于…）写的是
 * `${siteUrl}/#/archive` 这类 **hash URL**。而搜索引擎**会丢弃 # 之后的部分** ——
 * 也就是说那 11 条 sitemap 记录实际全部指向同一个首页，等于没提交。
 * 文章有 `/api/share/:slug` 这种真实 URL 可用，静态页却一个都没有。
 *
 * 这里给静态页同样提供一个**服务端可渲染、有完整 meta 的真实地址**，
 * sitemap 改指向它，搜索引擎才拿得到不同内容。
 */
const STATIC_PAGES = {
  '': { title: '首页', desc: '记录技术、生活与思考的个人博客' },
  archive: { title: '归档', desc: '按时间浏览全部文章' },
  tags: { title: '标签云', desc: '全部标签，按文章数量排序' },
  about: { title: '关于', desc: '关于我，以及这个站点' },
  bookmarks: { title: '我的收藏', desc: '我在本站收藏的文章' },
  links: { title: '友情链接', desc: '友链与申请方式' },
  messages: { title: '留言板', desc: '欢迎在这里留言' },
  articles: { title: '全部文章', desc: '按分类、标签或关键词筛选的博客文章列表' },
  notes: { title: '手记', desc: '短一点的记录与想法' },
};

router.get('/share-page/:page?', async (req, res) => {
  try {
    const key = String(req.params.page || '').replace(/\/$/, '');
    const page = STATIC_PAGES[key];
    if (!page) return res.status(404).send('页面不存在');

    const settings = await getAllSettings();
    const siteUrl = settings.site_url
      ? String(settings.site_url).replace(/\/+$/, '')
      : `${req.protocol}://${req.get('host')}`;
    const siteName = esc(settings.site_name || 'Xalor的小站');
    const toAbs = (p) => (!p ? '' : (String(p).startsWith('http') ? String(p) : siteUrl + String(p)));
    // 与文章分享页同一条回退链，避免两处配图不一致
    const image = toAbs(settings.og_image) || toAbs(settings.avatar) || `${siteUrl}/og-image.png`;

    // 带 query 的规范地址：分类页各自是不同内容，不能全都指向同一个 URL
    //（否则 4 个分类在 sitemap 里是 1 条重复记录）
    const qs = req.query.category ? `?category=${encodeURIComponent(String(req.query.category))}` : '';
    const selfUrl = `${siteUrl}/api/share-page${key ? '/' + key : ''}${qs}`;
    const spaUrl = `${siteUrl}/#/${key}`;
    const catLabel = req.query.category ? ` · ${String(req.query.category)}` : '';
    const fullTitle = `${page.title}${catLabel} - ${siteName}`;

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${fullTitle}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${esc(page.desc)}">
<meta property="og:site_name" content="${siteName}">
<meta property="og:url" content="${selfUrl}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:locale" content="zh_CN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${esc(page.desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="description" content="${esc(page.desc)}">
<meta http-equiv="refresh" content="0;url=${spaUrl}">
<link rel="canonical" href="${selfUrl}">
</head>
<body>
<noscript>
<p>正在跳转…如未自动跳转，请<a href="${spaUrl}">点击这里</a>。</p>
</noscript>
</body>
</html>`;

    res.set('Cache-Control', 'public, max-age=300');
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (e) {
    console.error('[share-page]', e.message);
    return res.status(500).send('生成分享页失败');
  }
});

module.exports = router;
