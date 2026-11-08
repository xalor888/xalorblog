const express = require('express');
const crypto = require('crypto');
const { etagMatches } = require('../utils/etag');
const db = require('../db');
const config = require('../config');
const { getAllSettings } = require('../utils/settings');
const { plainText } = require('../utils/markdownText');

const router = express.Router();

/**
 * 条件发送：手算 ETag + If-None-Match → 304。
 *
 * 为什么要手算：`app.disable('etag')` 全局关了 Express 的自动 ETag
 * （注释写的是避免响应体大小指纹泄露），所以 feed.js 里 sitemap/RSS 都是手动算的。
 * 分享页之前漏了这一步 —— 实测只有 `Cache-Control: public, max-age=300`，
 * 没有 ETag，于是抓取器 5 分钟后回来**只能重新生成整页**：
 * 每次都要查库（文章 + 分类 + 标签 + 设置）并重新拼 HTML。
 * og 抓取器对同一 URL 会反复抓，这部分开销是白付的。
 *
 * 安全上与全局关闭 ETag 的初衷不冲突：这里哈希的是**响应体内容**
 * （sha1 取前 24 位），不是 Express 默认那种带长度信息的弱指纹，
 * 与 feed.js 的做法保持一致。
 */
function conditionalSendHtml(req, res, html) {
  const etag = '"' + crypto.createHash('sha1').update(html).digest('hex').slice(0, 24) + '"';
  res.set('ETag', etag);
  // 文章修改后最多 5 分钟生效
  res.set('Cache-Control', 'public, max-age=300');
  /**
   * 必须声明 Vary: Host。
   *
   * siteUrl 的取值是 `settings.site_url || req.protocol + '://' + req.get('host')` ——
   * 站点没配 site_url 时，**整页的 og:url / canonical / og:image 都跟着 Host 变**。
   * 而响应是 `public` 可缓存 5 分钟的：共享缓存（CDN / 中间代理）只按 URL 归档，
   * 会把 A 域渲染的版本喂给 B 域，B 域的分享卡片于是指向 A 域。
   * 这与 feed.js 里 sitemap/RSS 的处理是同一类问题、同一种解法。
   *
   * 用 append 而不是 set —— 全局 gzip / CORS 中间件已写入 Vary，
   * set 会把它覆盖掉（feed.js 的注释里也记过这一条）。
   */
  res.append('Vary', 'Host');
  // 弱比较 + 多值 + `*`：nginx/CDN 常把强 ETag 改写成 `W/"..."`，
  // 严格相等会让这些请求全部错过 304（订阅器每次轮询都白重建整页）。详见 utils/etag.js。
  if (etagMatches(req.headers['if-none-match'], etag)) {
    return res.status(304).end();
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
}

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
    /**
     * 两个 URL，用途必须分清 —— 混用过一次：
     *
     * rawShareUrl  → `/#/article/<slug>`，**人类**的落点：
     *                用于 <meta http-equiv="refresh"> 与 noscript 里的「点击这里」。
     *                SPA 靠 hash 路由渲染文章。
     * rawSelfUrl   → `/api/share/<slug>`，**机器**的落点：
     *                爬虫抓的就是它，所以 og:url 与 canonical 必须都指向它。
     *
     * 原来 og:url 写的是 rawShareUrl，于是 Open Graph 声称规范地址是那个 hash URL，
     * 与 canonical 自相矛盾 —— 平台可能因此认为抓到的是另一个页面。
     * hash 后面的部分对爬虫而言本来就不会被请求，指向它毫无意义。
     */
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
    // ⚠ 两份站点名必须分开：siteName 已转义，只能**直接插进 HTML**；
    // 任何需要再拼接后再 esc 的地方必须用 rawSiteName，否则 & 会变成 &amp;amp;
    // （转义两次的经典症状：页面显示 "A &amp; B" 而不是 "A & B"）。
    const rawSiteName = settings.site_name || 'Xalor的小站';
    const siteName = esc(rawSiteName);

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
<meta property="og:url" content="${selfUrl}">
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
<!--
  这个页面是给爬虫看的，人到了这里靠上面的 meta refresh 立刻被送进 SPA。
  但原来 body 是**空的**（只有 noscript 里一句话），于是：
    · 禁用 JavaScript 的浏览器 / 装了拦截 refresh 的扩展 → 一片白屏，没有任何出路；
    · 慢网络下 refresh 生效前那一瞬也是空白。
  下面这段是给「跳转没发生」的人看的兜底：说清这是什么、标题是什么、往哪走。
  对爬虫无害（正文本来就靠 JSON-LD 与 og:* 描述），对人是一根救命绳。
-->
<main style="max-width:40rem;margin:12vh auto;padding:0 1.25rem;font:16px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#1a1814;background:#fff">
  <p style="font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:#6b6456;margin:0 0 .5rem">${siteName}</p>
  <h1 style="font-size:1.6rem;line-height:1.3;margin:0 0 .75rem">${title}</h1>
  <p style="color:#4a463f;margin:0 0 1.5rem">${desc}</p>
  <p style="margin:0">
    <a href="${shareUrl}" style="display:inline-block;padding:.6rem 1.1rem;border-radius:8px;background:#bb4732;color:#fff;text-decoration:none;font-weight:600">继续阅读</a>
  </p>
  <noscript>
    <p style="margin:1.5rem 0 0;color:#6b6456;font-size:.9rem">你的浏览器没有自动跳转过去，请点上面的按钮。</p>
  </noscript>
</main>
</body>
</html>`;

    // 公开分享页：可缓存 5 分钟 + ETag 条件请求（详见 conditionalSendHtml 注释）
    return conditionalSendHtml(req, res, html);
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
// `list` 表示这一页应该在正文里列出真实条目。
//
// 为什么需要：这个分享页原本 body 里只有一句描述 —— 对搜索引擎来说是**薄内容 + 0 秒跳转**，
// 通常被当成 doorway page 不给排名。而 sitemap 里 11 条静态页全指着它，
// 等于 sitemap 交了但一条都收不进去。
// 现在 articles / archive 两页会列出最近 30 篇文章的**标题 + 真实 URL**（`/api/share/:slug`），
// 搜索抓取器至少能读到实际内容。
//
// notes / tags 两页**故意不列**：手记没有 `/share/:slug` 这类可抓取的真实地址，
// 给 hash URL 等于把「丢 # 之后」的老问题换个地方重演。这两页继续只靠 meta。
const STATIC_PAGES = {
  '': { title: '首页', desc: '记录技术、生活与思考的个人博客', list: 'articles' },
  archive: { title: '归档', desc: '按时间浏览全部文章', list: 'archive' },
  tags: { title: '标签云', desc: '全部标签，按文章数量排序' },
  about: { title: '关于', desc: '关于我，以及这个站点' },
  bookmarks: { title: '我的收藏', desc: '我在本站收藏的文章' },
  links: { title: '友情链接', desc: '友链与申请方式' },
  messages: { title: '留言板', desc: '欢迎在这里留言' },
  articles: { title: '全部文章', desc: '按分类、标签或关键词筛选的博客文章列表', list: 'articles' },
  notes: { title: '手记', desc: '短一点的记录与想法' },
};

/**
 * 分享页要列的条目（只服务抓取器，所以字段极少：标题 + 相对路径）。
 * 60 秒模块级缓存：og 抓取器会对同一 URL 反复抓，没必要每次都查库。
 */
const LIST_TTL = 60 * 1000;
const listCache = new Map(); // kind -> { at, items }

async function fetchList(kind) {
  const hit = listCache.get(kind);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.items;
  let items = [];
  if (kind === 'articles' || kind === 'archive') {
    const rows = await db('articles')
      .where('status', 'published')
      .orderBy([{ column: 'published_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(30)
      .select('title', 'slug');
    items = rows.map((r) => ({ title: String(r.title || ''), path: `/share/${encodeURIComponent(r.slug)}` }));
  }
  listCache.set(kind, { at: Date.now(), items });
  return items;
}

router.get('/share-page/:page?', async (req, res) => {
  try {
    const key = String(req.params.page || '').replace(/\/$/, '');
    // ⚠ 必须用 hasOwnProperty 而不是直接索引。
    //
    // `STATIC_PAGES` 是对象字面量，它继承 Object.prototype —— 于是
    // `STATIC_PAGES['constructor']`、`['toString']`、`['__proto__']`、`['valueOf']`
    // 全都返回**真值**（原型链上的函数），`if (!page)` 不会触发 404。
    // 实测 `/api/share-page/constructor` 返回 200，页面标题渲染成 "undefined - 站点名"，
    // 描述也是 undefined，还带着指向自己的 canonical —— 搜索引擎完全可能把这个垃圾页收进索引。
    //
    // 这类页面数量有限但可枚举（原型链上所有非空属性名），而且每个都是一条低质收录页。
    const page = Object.prototype.hasOwnProperty.call(STATIC_PAGES, key) ? STATIC_PAGES[key] : null;
    if (!page) {
      // 与文章分享页的 404 保持一致：完整 HTML + noindex + h1。
      // 原来这里只 send('页面不存在') —— 裸文本，
      // 却带着 Content-Type: text/html，且**没有 noindex**，
      // 搜索引擎完全可能把这个 404 收进索引，抓取器也拿不到任何结构。
      return res.status(404).send(
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + '<meta name="robots" content="noindex,nofollow">'
        + '<title>页面不存在</title></head><body><h1>页面不存在</h1></body></html>'
      );
    }

    const settings = await getAllSettings();
    const siteUrl = settings.site_url
      ? String(settings.site_url).replace(/\/+$/, '')
      : `${req.protocol}://${req.get('host')}`;
    // 与文章分享页同一约定：rawSiteName 给「还要再 esc 一次」的拼接用
    const rawSiteName = settings.site_name || 'Xalor的小站';
    const siteName = esc(rawSiteName);
    const toAbs = (p) => (!p ? '' : (String(p).startsWith('http') ? String(p) : siteUrl + String(p)));
    // 与文章分享页同一条回退链，避免两处配图不一致
    const image = toAbs(settings.og_image) || toAbs(settings.avatar) || `${siteUrl}/og-image.png`;

    // 带 query 的规范地址：分类页各自是不同内容，不能全都指向同一个 URL
    //（否则 4 个分类在 sitemap 里是 1 条重复记录）
    //
    // 前缀必须走 config.apiPrefix 而不是写死 `/api`：API_PREFIX 是部署项，
    // 一改成随机串（config.js 注释里就建议生产改成随机值），写死的 `/api`
    // 会让 canonical / og:url 全部指向 404 —— 搜索引擎会把整份 sitemap 判为死链。
    // feed.js 里所有对外 URL 早已用 apiPrefix，这里是漏网的一处。
    const qs = req.query.category ? `?category=${encodeURIComponent(String(req.query.category))}` : '';
    const selfUrl = `${siteUrl}${config.apiPrefix}/share-page${key ? '/' + key : ''}${qs}`;
    const spaUrl = `${siteUrl}/#/${key}`;
    // ⚠ category 来自 query 串，是**读者可控**的。它曾经未经 esc() 直接拼进
    // `<title>` / og:title / `<h1>` —— 实测 `?category=%22` 会原样产出
    // `content="全部文章 · " - 小站"`，一个双引号就能闭合属性。
    // WAF 目前会拦 `<script`，但那是**第二道**防线，不能当转义用：
    // 换一种不含正则特征的载荷（或调高了 WAF 阈值）就直接穿透。
    // 这里同时保留一份已转义的值用于任何输出位置。
    const rawCatLabel = req.query.category ? ` · ${String(req.query.category)}` : '';
    const catLabel = esc(rawCatLabel);
    // 这里必须用 rawSiteName：siteName 已经 esc 过，再 esc 一次会让 `&` → `&amp;amp;`
    // （实测站点名写成「A & B」时，无分类的分享页标题会显示成 "A &amp; B - A & B 的小站"）。
    const fullTitle = esc(`${page.title}${rawCatLabel} - ${rawSiteName}`);

    // 正文列表：给抓取器的真实内容。空列表时不留空 <ul>。
    const listItems = page.list ? await fetchList(page.list) : [];
    const listHtml = listItems.length
      ? '<ul style="margin:0 0 1.5rem;padding-left:1.1rem;color:#4a463f">\n'
        + listItems.map((it) => `    <li><a href="${esc(siteUrl + config.apiPrefix + it.path)}" style="color:#8a3b28">${esc(it.title)}</a></li>`).join('\n')
        + '\n  </ul>'
      : '';

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
<!-- 与文章分享页同理：body 不能是空的。
     禁 JS / 拦 refresh / 慢网络时，这里就是用户唯一能看到的东西。 -->
<main style="max-width:40rem;margin:12vh auto;padding:0 1.25rem;font:16px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#1a1814;background:#fff">
  <p style="font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:#6b6456;margin:0 0 .5rem">${siteName}</p>
  <h1 style="font-size:1.6rem;line-height:1.3;margin:0 0 .75rem">${esc(page.title)}${catLabel}</h1>
  <p style="color:#4a463f;margin:0 0 1.5rem">${esc(page.desc)}</p>
${listHtml}
  <p style="margin:0">
    <a href="${spaUrl}" style="display:inline-block;padding:.6rem 1.1rem;border-radius:8px;background:#bb4732;color:#fff;text-decoration:none;font-weight:600">进入站点</a>
  </p>
  <noscript>
    <p style="margin:1.5rem 0 0;color:#6b6456;font-size:.9rem">你的浏览器没有自动跳转过去，请点上面的按钮。</p>
  </noscript>
</main>
</body>
</html>`;

    return conditionalSendHtml(req, res, html);
  } catch (e) {
    console.error('[share-page]', e.message);
    return res.status(500).send('生成分享页失败');
  }
});

// 供基准脚本在每轮测量前清掉列表缓存（否则「冷路径」测到的是缓存命中）
router.clearShareListCache = () => listCache.clear();

/**
 * 静态页的 key 清单（给 sitemap 用）。
 *
 * 为什么导出而不是让 feed.js 再写一遍：那两个地方原本各有一份硬编码列表，
 * 而 share.js 有 9 项、feed.js 只有 7 项 —— **`articles` 从来没进过 sitemap**。
 * 分类变体 `?category=xxx` 都列了，偏偏无分类的列表页没列，而它覆盖的文章最全。
 * 导出后两边不可能再漂移（有断言钉着）。
 *
 * `notes` 也在这里，但 feed.js 需要特殊处理它（有独立的 lastmod 逻辑且只在
 * 有已发布手记时才输出），所以调用方要显式排除。
 */
router.STATIC_PAGE_KEYS = Object.freeze(Object.keys(STATIC_PAGES));

module.exports = router;
