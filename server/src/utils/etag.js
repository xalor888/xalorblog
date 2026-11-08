/**
 * ETag 比较工具。
 *
 * 为什么需要一个工具而不是 `if (req.headers['if-none-match'] === etag)`：
 *
 * 1. **弱比较（weak comparison）**。RFC 9110 §13.1.2 规定 If-None-Match 用弱比较：
 *    `W/"abc"` 与 `"abc"` 视为匹配。中间代理（nginx、CDN）经常把强 ETag 改写成弱形式
 *    （`W/` 前缀），因为它们不保证字节级一致。严格相等会让这些请求全部拿不到 304 ——
 *    订阅器每次轮询都重新生成整页，白白付查库 + 拼 HTML 的成本。
 *
 * 2. **多值列表**。客户端缓存了同一资源的多个表示时会发
 *    `If-None-Match: "a", "b"`；`*` 表示"任何当前表示都算命中"。
 *    严格相等对这两种形态一律不命中。
 *
 * 3. **空白**。`"a" , "b"` 结尾/中间的空白不改变语义。
 *
 * 注意不能图省事用 `includes()`：`"abc"` 会被 `"abcdef"` 命中。必须先按逗号切分再逐项比较。
 */

/**
 * 弱比较两个实体标签，忽略 `W/` 前缀与首尾空白。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function weakCompare(a, b) {
  const norm = (t) => String(t || '').trim().replace(/^W\//i, '');
  const na = norm(a);
  return na !== '' && na === norm(b);
}

/**
 * `If-None-Match` 是否命中当前 ETag。
 * @param {string|undefined} ifNoneMatch 请求头原文
 * @param {string} etag 服务端即将发出的 ETag（带引号）
 * @returns {boolean}
 */
function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const header = String(ifNoneMatch).trim();
  if (!header) return false;
  if (header === '*') return true;
  // 按逗号切分后逐项弱比较；不能用 includes，否则 "abc" 会被 "abcdef" 命中
  return header.split(',').some((part) => weakCompare(part, etag));
}

module.exports = { etagMatches, weakCompare };
