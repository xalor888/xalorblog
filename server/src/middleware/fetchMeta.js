/**
 * Fetch Metadata 校验（现代浏览器自动发送 Sec-Fetch-* 头，脚本/curl 不会发送）
 * - 写请求：若浏览器发送了 Sec-Fetch-Site，必须为 same-origin/same-site，
 *   cross-site 提交一律拒绝（防跨站表单伪造）
 * - 未发送（旧浏览器）放行，由签名/令牌兜底
 */

function fetchMetaGuard(req, res, next) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (!site) return next(); // 旧浏览器/脚本，签名兜底
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return next();
  return res.status(403).json({ code: 1, message: '请求被拒绝' });
}

module.exports = { fetchMetaGuard };
