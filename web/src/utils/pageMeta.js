/**
 * 页面元信息（SEO / 社交分享）统一出口。
 *
 * 为什么要有：原来只有文章详情页自己维护 og:url / canonical，
 * 其余页面（列表、标签、关于、归档…）一个都没有；
 * 而 `og:image` 在 index.html / home.html 里是**硬编码的相对路径**
 * `/og-image.webp` —— 社交平台要求绝对 URL，相对路径会被直接忽略，
 * 分享卡片于是没有配图。实测四类页面的差异：
 *
 *   文章页   og:url ✓  canonical ✓  og:image 绝对 ✓
 *   列表页   og:url ✗  canonical ✗  og:image 相对 ✗
 *   标签页   og:url ✗  canonical ✗  og:image 相对 ✗
 *   关于页   og:url ✗  canonical ✗  og:image 相对 ✗
 *
 * 这里做成「一次设置整组」，避免每个页面各写一份、各漏几项。
 */

/**
 * 把 `site` 参数归一成 settings 对象。
 *
 * 为什么需要：这个函数有两种调用形态在同时使用 ——
 *   - `site`（Pinia store 实例，读 `.settings`）：Archive / Tags / About / Links /
 *     Bookmarks / History / ArticleList
 *   - `site.settings`（settings 本身）：首页 Home.vue、留言页 Messages.vue、
 *     以及主页三页传的 `{ settings: { site_name } }`
 * 旧实现只认第一种，于是上面那些页面拿到的 site_name / site_url / og_image
 * 全是 fallback 值：自定义站名的站点在首页分享出去仍是默认站名，
 * 后台配的 og_image 在首页也永远不生效。
 */
function resolveSettings(site) {
  if (!site || typeof site !== 'object') return {};
  // store 实例（含 .settings 对象）优先；否则当作 settings 本身
  if (site.settings && typeof site.settings === 'object') return site.settings;
  return site;
}

/**
 * 把「裸域名 / 带路径的站点地址 / 已带协议的 URL」统一成**带协议的 origin**。
 *
 * `xalor.cn` → `https://xalor.cn`。后台把 site_url 填成裸域名时，
 * 拼出来的 og:image / og:url / canonical 就没有协议头，
 * 社交平台会把 `xalor.cn/og-image.png` 当成相对路径**直接忽略** —— 卡片于是没图。
 */
function originFromRaw(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // 允许配置里带或不带协议
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withProto).origin;
  } catch (e) {
    return '';
  }
}

/** 站点的规范来源：优先用站点设置里的域名，退回当前 origin */
export function siteOrigin(site) {
  const settings = resolveSettings(site);
  const raw =
    settings.site_url ||
    settings.domain ||
    // absoluteUrl 的第二个参数有时直接就是域名串（不是 settings/store）
    (typeof site === 'string' ? site : '');
  return originFromRaw(raw) || location.origin;
}

/**
 * 把站内相对路径绝对化；已经是绝对 URL 的原样返回。
 *
 * 输出**一定带协议**：`og:image` / `twitter:image` / `og:url` / `canonical`
 * 给相对路径或裸域名，平台一律忽略。
 *
 * @param {string} url  站内路径（'/og-image.png'）、协议相对（'//cdn/a.png'）或绝对 URL
 * @param {object|string} [site] settings 对象 / store 实例，或直接一个域名串（'xalor.cn'）
 */
export function absoluteUrl(url, site) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  // 协议相对（//cdn.example.com/a.png）：补上 https 就是绝对地址
  if (s.startsWith('//')) return `https:${s}`;
  const origin = siteOrigin(site);
  return `${origin}${s.startsWith('/') ? '' : '/'}${s}`;
}

function upsertMeta(key, content) {
  if (content === undefined || content === null || content === '') return;
  const isProp = key.includes(':');
  let el = document.querySelector(`meta[${isProp ? 'property' : 'name'}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(isProp ? 'property' : 'name', key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', String(content).slice(0, 300));
}

/** 按 name 属性写 meta（twitter:* 这类用的是 name） */
function setMetaByName(name, content) {
  if (content === undefined || content === null || content === '') return;
  let el = document.querySelector(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('name', name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', String(content).slice(0, 300));
}

/**
 * 页面级结构化数据（JSON-LD）的 <script> 固定用这个 id。
 *
 * 为什么要有：文章详情页原先自己写了一份 setJsonLd / applyJsonLd，
 * 与上面这一组 meta 是同一件事的两套实现。现在统一由这里负责 ——
 * 固定 id 复用同一个节点，**替换而不是追加**（每次导航 append 一个，
 * 来回点几篇文章 head 里就会堆一串 BlogPosting，互相矛盾）。
 */
const JSONLD_ID = 'page-meta-jsonld';

function $jsonLd() {
  return document.getElementById(JSONLD_ID);
}

/**
 * 写入 / 清空页面级 JSON-LD。
 *
 * ⚠ 必须把 `<` 转义成 `\u003c`：标题、摘要里出现 `</script>` 时，
 * 浏览器会就地闭合这个 <script>，后面的 JSON 变成页面正文（乱码），
 * 结构化数据整段失效 —— 而且这是**内容可控**的一条路径（后台能改标题）。
 *
 * @param {object|null|undefined} jsonLd 传对象=写入；传空=清掉（离开文章页等场景）
 */
function upsertJsonLd(jsonLd) {
  const exist = $jsonLd();
  if (!jsonLd) {
    // 不传就清掉上一个页面留下的：否则从文章页回到列表页，
    // BlogPosting 还挂在那儿，向搜索引擎声称「这页是一篇文章」。
    exist?.remove();
    return;
  }
  let el = exist;
  if (!el) {
    el = document.createElement('script');
    el.setAttribute('type', 'application/ld+json');
    el.setAttribute('id', JSONLD_ID);
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
}

/** 显式清掉页面级 JSON-LD（组件卸载时用，避免结构化数据跟着离开的页面漂移） */
export function clearPageJsonLd() {
  $jsonLd()?.remove();
}

/**
 * 设置整页元信息。
 * @param {object} opts
 * @param {string} [opts.title]     og:title / twitter:title（不含站名后缀）。
 *        **省略时写成站名本身**：这个函数是「设置整组」，而 SPA 的 <head> 只有一份。
 *        若省略就跳过，从文章页返回首页后 og:title 会**留着上一篇的标题**
 *        （首页刻意不传 title，正文注释说「避免出现 Xalor的小站 · Xalor的小站」，
 *        但省略 == 不更新，不是「用站名」）。
 * @param {string} opts.description  描述
 * @param {string} [opts.path]       站内路径（如 '/articles'），用于 og:url
 * @param {string} [opts.canonical]  显式指定 canonical（收录目标，与 og:url **互不影响**）。
 *        文章页传服务端分享页 /api/share/:slug —— hash 地址爬虫不收录；
 *        而 og:url 仍是 SPA 文章页（人类分享落点）。两者本来就该不同。
 * @param {string} [opts.image]      配图，站内相对路径会自动绝对化
 * @param {object} opts.site         站点数据。两种形态都接受：
 *        store 实例（`{ settings }`）或 settings 本身 —— 调用点历史上两种都传过。
 * @param {string} [opts.type]       og:type，默认 website
 * @param {object} [opts.jsonLd]     页面级结构化数据（如 BlogPosting）。传对象=写入/替换
 *        `<script type="application/ld+json">`（`<` 已转义）；不传=清掉上一页留下的。
 */
export function applyPageMeta({ title, description, path, canonical, image, site, type = 'website', jsonLd } = {}) {
  const settings = resolveSettings(site);
  const siteName = settings.site_name || 'Xalor的小站';

  upsertMeta('description', description);
  upsertMeta('og:type', type);
  upsertMeta('og:site_name', siteName);

  // 标题：页面标题 + 站名，与 document.title 保持同源。
  // 没有页面标题时用站名本身 —— 关键是**必须写**，否则会残留上一次路由的值。
  const pageLabel = title ? `${title} · ${siteName}` : siteName;
  upsertMeta('og:title', pageLabel);
  // twitter:* 一律走 setMetaByName —— Twitter 读的是 name 属性，
  // 写成 property 等于这一项不存在（下面 twitter:card 处有更详细的说明）。
  setMetaByName('twitter:title', pageLabel);
  upsertMeta('og:description', description);
  setMetaByName('twitter:description', description);

  // og:image / twitter:image 必须是**绝对 URL**，相对路径会被平台忽略
  // 默认值与 server/src/routes/share.js 保持一致，都用 /og-image.png ——
  // 两处各写一个默认值，迟早有一边改另一边忘（本项目已因此踩过一次）。
  const img = absoluteUrl(image || settings.og_image || '/og-image.png', settings);
  if (img) {
    upsertMeta('og:image', img);
    setMetaByName('twitter:image', img);
  }
  // twitter:* **全部**都用 name 属性，而 upsertMeta 历史实现按「含 ':'」判断成
  // property —— 于是 twitter:title / description / image 全被写成 property，
  // 对 Twitter 而言等于不存在（实测三者都出现在 meta[property=...] 里，
  // meta[name^="twitter"] 只剩 card 一项）。
  // 所以这里四项一律走 setMetaByName，别再图省事用 upsertMeta。
  setMetaByName('twitter:card', 'summary_large_image');

  // og:url 与 canonical 分开算（两者都必须是带协议的绝对 URL）：
  //   og:url    = 本页自身地址，由 path 派生
  //   canonical = 收录目标，可用 canonical 显式指定
  // 原先两处写的是同一个变量，于是任何一页都没法同时表达「分享落点」与「收录目标」。
  const pagePath = path || (location.hash ? location.hash.slice(1) : '/');
  upsertMeta('og:url', absoluteUrl(pagePath, settings));
  const canonicalHref = absoluteUrl(canonical || pagePath, settings);
  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', canonicalHref);

  // 结构化数据放在最后：整组 meta 写完再写它，失败也不影响上面那些
  upsertJsonLd(jsonLd);
}
