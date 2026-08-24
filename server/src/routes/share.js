const express = require('express');
const db = require('../db');
const config = require('../config');
const { getAllSettings } = require('../utils/settings');

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
        .select('a.title', 'a.summary', 'a.cover', 'a.published_at', 'c.name as category_name')
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
    const desc = esc(article.summary || '');
    // 封面缺失时回退站点头像（保证社交平台有可抓取的 OG 图片）
    const cover = article.cover
      ? (article.cover.startsWith('http') ? article.cover : siteUrl + article.cover)
      : (settings.avatar
          ? (settings.avatar.startsWith('http') ? settings.avatar : siteUrl + settings.avatar)
          : '');
    const siteName = esc(settings.site_name || 'Xalor的小站');

    // 结构化数据（BlogPosting：富摘要/知识图谱收录；JSON.stringify 保证标题等特殊字符安全嵌入）
    const authorName = settings.author || settings.nickname || settings.site_name || 'Xalor的小站';
    // JSON.stringify 不转义 < —— 若字段值含 </script> 序列会提前终止 script 块
    // （设置项存储无标签清洗，如站点名）。替换 < 为 \u003c 是防 JSON-LD 注入的标准做法
    const ldJson = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: article.title,
      description: String(article.summary || '').slice(0, 200),
      datePublished: article.published_at,
      mainEntityOfPage: { '@type': 'WebPage', '@id': rawSelfUrl },
      author: { '@type': 'Person', name: authorName },
      publisher: { '@type': 'Organization', name: settings.site_name || 'Xalor的小站' },
      ...(cover ? { image: [cover] } : {}),
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
${cover ? `<meta property="og:image" content="${esc(cover)}">` : ''}
<meta property="og:locale" content="zh_CN">

<!-- Twitter Card -->
<meta name="twitter:card" content="${cover ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
${cover ? `<meta name="twitter:image" content="${esc(cover)}">` : ''}

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

module.exports = router;
