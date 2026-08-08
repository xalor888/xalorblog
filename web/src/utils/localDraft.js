/** 本地草稿工具（评论/留言共用）：防抖由调用方负责，本模块只管读写与过期 */

const TTL = 24 * 3600 * 1000; // 24 小时过期，避免恢复陈旧内容

/**
 * 保存草稿（内容为空时清除）
 * @param {string} key localStorage 键
 * @param {string} content 内容
 */
export function saveDraft(key, content) {
  try {
    if (String(content || '').trim()) {
      localStorage.setItem(key, JSON.stringify({ content: String(content), at: Date.now() }));
    } else {
      localStorage.removeItem(key);
    }
  } catch (e) { /* 隐私模式/配额满忽略 */ }
}

/**
 * 读取草稿：24 小时内且内容非空才返回，否则清理过期键
 * @param {string} key localStorage 键
 * @returns {string} 草稿内容（无/过期返回空串）
 */
export function loadDraft(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return '';
    const saved = JSON.parse(raw);
    const fresh = saved && saved.at && Date.now() - Number(saved.at) < TTL;
    if (fresh && typeof saved.content === 'string' && saved.content.trim()) {
      return saved.content;
    }
    localStorage.removeItem(key); // 过期/损坏草稿直接清理
    return '';
  } catch (e) {
    return '';
  }
}

/** 清除草稿 */
export function clearDraft(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) { /* 忽略 */ }
}
