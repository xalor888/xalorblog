/**
 * 双站互链基址
 *
 * 两个入口部署在不同域名（hash 路由）：
 *   - 博客：blog.xalor.cn（index.html 入口）
 *   - 个人主页：xalor.cn（home.html 入口）
 * 导航里的跨站项必须走这里，避免把域名散落在组件里（换域名只改 .env）。
 */
function trim(url) {
  return String(url || '').replace(/\/+$/, '');
}

export const BLOG_URL = trim(import.meta.env.VITE_BLOG_URL || 'https://blog.xalor.cn');
export const HOME_URL = trim(import.meta.env.VITE_HOME_URL || 'https://xalor.cn');

/** 拼博客站的 hash 路由地址：#/articles → https://blog.xalor.cn/#/articles */
export function blogUrl(hashPath = '') {
  const p = String(hashPath || '').replace(/^\/+/, '');
  return p ? `${BLOG_URL}/#/${p}` : `${BLOG_URL}/`;
}

/** 拼个人主页的 hash 路由地址 */
export function homeUrl(hashPath = '') {
  const p = String(hashPath || '').replace(/^\/+/, '');
  return p ? `${HOME_URL}/#/${p}` : `${HOME_URL}/`;
}
