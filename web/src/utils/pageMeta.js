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

/** 站点的规范来源：优先用站点设置里的域名，退回当前 origin */
export function siteOrigin(site) {
  const raw = String(site?.settings?.site_url || site?.settings?.domain || '').trim();
  if (!raw) return location.origin;
  // 允许配置里带或不带协议
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProto).origin;
  } catch (e) {
    return location.origin;
  }
}

/** 把站内相对路径绝对化；已经是绝对 URL 的原样返回 */
export function absoluteUrl(url, site) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
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
 * 设置整页元信息。
 * @param {object} opts
 * @param {string} opts.title        og:title / twitter:title（不含站名后缀）
 * @param {string} opts.description  描述
 * @param {string} [opts.path]       站内路径（如 '/articles'），用于 og:url 与 canonical
 * @param {string} [opts.canonical]  直接指定 canonical（分享页等场景）
 * @param {string} [opts.image]      配图，站内相对路径会自动绝对化
 * @param {object} opts.site         站点 store（取域名与默认配图）
 * @param {string} [opts.type]       og:type，默认 website
 */
export function applyPageMeta({ title, description, path, canonical, image, site, type = 'website' }) {
  const siteName = site?.settings?.site_name || 'Xalor的小站';
  const origin = siteOrigin(site);

  upsertMeta('description', description);
  upsertMeta('og:type', type);
  upsertMeta('og:site_name', siteName);

  // 标题：页面标题 + 站名，与 document.title 保持同源
  if (title) {
    upsertMeta('og:title', `${title} · ${siteName}`);
    upsertMeta('twitter:title', `${title} · ${siteName}`);
  }
  upsertMeta('og:description', description);
  upsertMeta('twitter:description', description);

  // og:image / twitter:image 必须是**绝对 URL**，相对路径会被平台忽略
  // 默认值与 server/src/routes/share.js 保持一致，都用 /og-image.png ——
  // 两处各写一个默认值，迟早有一边改另一边忘（本项目已因此踩过一次）。
  const img = absoluteUrl(image || site?.settings?.og_image || '/og-image.png', site);
  if (img) {
    upsertMeta('og:image', img);
    upsertMeta('twitter:image', img);
  }
  // twitter:* 实际用的是 name 属性，但 upsertMeta 按 ':' 判断会当成 property。
  // 显式按 name 写入，否则会被写成 property="twitter:card"，Twitter 读不到。
  setMetaByName('twitter:card', 'summary_large_image');

  // og:url 与 canonical：每页都应有，指向自己的规范地址
  const pagePath = path || (location.hash ? location.hash.slice(1) : '/');
  const url = canonical || `${origin}${pagePath.startsWith('/') ? '' : '/'}${pagePath}`;
  upsertMeta('og:url', url);
  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', url);
}
