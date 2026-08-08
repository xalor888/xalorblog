/**
 * Markdown 纯文本提取（RSS 摘要 / 分享页 OG 描述共用）
 * 消除 feed.js 与 share.js 的重复实现，避免行为漂移
 */

/** 去掉 Markdown 标记，生成纯文本摘要 */
function plainText(md = '') {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')   // 代码块
    .replace(/`([^`]*)`/g, '$1')        // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
    .replace(/[#>*_~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { plainText };
