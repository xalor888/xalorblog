/**
 * 搜索关键词高亮的唯一实现（列表页与搜索弹层共用）。
 *
 * ⚠ 为什么单独抽出来：这段逻辑原来在两个文件里各写了一份，**两份逐字相同、
 * 也都带着同一个缺陷** —— 只修一处会让另一处继续错，而且以后很容易再次分叉。
 *
 * ⚠ 顺序很重要：**先在原文上匹配，再逐段转义**。
 * 原先的写法是「整串先转义、然后拿关键词去匹配转义后的串」，
 * 于是标题里的 `&` 已经变成 `&amp;`，关键词 `A & B` 里的 `&` 就匹配不上了：
 * 实测搜 `A & B` 能搜到文章（服务端正常），但**一处高亮都没有**。
 *
 * 反过来「先匹配、再整串转义」也不行 —— 那样 `<mark>` 自己会被转义成文本。
 * 所以是「先匹配 → 逐段转义 → 命中段包 mark → 拼接」。
 */

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 转义 HTML 特殊字符（五个都要，少一个就可能突破属性或标签边界） */
export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
}

/**
 * 高亮关键词，返回可直接给 v-html 的安全 HTML。
 * @param {string} text 原文（纯文本）
 * @param {string} keyword 关键词；空则只转义不高亮
 * @returns {string}
 */
export function highlightKeyword(text, keyword) {
  const raw = String(text ?? '');
  const k = String(keyword ?? '').trim();
  if (!k) return escHtml(raw);
  // 关键词里的正则元字符必须转义，否则 `(` 会让 RegExp 抛异常、`*` 会贪婪匹配
  const pattern = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${pattern})`, 'gi');
  // split 带捕获组时，奇数位正是命中的片段
  return raw
    .split(re)
    .map((part, i) => (i % 2 === 1 ? `<mark>${escHtml(part)}</mark>` : escHtml(part)))
    .join('');
}
