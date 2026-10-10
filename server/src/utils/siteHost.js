/**
 * 站点域名识别
 * 同一个后端进程同时服务博客域（blog.xalor.cn）与个人主页域（xalor.cn）：
 * - SEO 路由（robots.txt / sitemap.xml / rss.xml）按请求 Host 派发不同版本
 * - 主页链接与 sitemap 的 <loc> 需要各自域名的基数
 * 与 app.js 的 Host 校验共用同一套 hostname 归一化规则（去端口、去 IPv6 方括号）。
 */

const config = require('../config');

/** 归一化请求 Host：小写、去端口、去 IPv6 方括号与末尾点 */
function requestHost(req) {
  const raw = String((req && req.headers && req.headers.host) || '').toLowerCase();
  let h = raw;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end > 0 ? h.slice(1, end) : h;
  } else {
    h = h.split(':')[0];
  }
  return h.replace(/\.+$/, '');
}

/** 是否来自个人主页域。未配置 HOME_SITE_HOST 时恒为 false（一律按博客版返回）。 */
function isHomeHost(req) {
  if (!config.homeSiteHost) return false;
  return requestHost(req) === config.homeSiteHost;
}

/** 站点基址：优先显式配置，回落到「请求协议 + Host」（Nginx 终止 TLS 时的兜底） */
function resolveBaseUrl(req, configured) {
  const c = String(configured || '').trim();
  if (c) return c.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = { requestHost, isHomeHost, resolveBaseUrl };
