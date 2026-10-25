/**
 * 文章收藏（本地书签，不依赖账号）
 * 存储结构：{ id, slug, title, summary, cover, category_name, category_color, tags, published_at, ts }
 */

const KEY = 'xalor_bookmarks';
const MAX = 100;

export function getBookmarks() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function save(list) {
  // 隐私模式/存储满时静默降级（收藏仅本次会话有效）
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) { /* 忽略 */ }
}

export function isBookmarked(id) {
  return getBookmarks().some((b) => b.id === id);
}

/** 收藏一篇文章（返回收藏后的列表） */
export function addBookmark(article) {
  const list = getBookmarks();
  if (!list.some((b) => b.id === article.id)) {
    list.unshift({
      id: article.id,
      slug: article.slug,
      title: article.title,
      summary: article.summary || '',
      cover: article.cover || '',
      category_name: article.category_name || '',
      category_color: article.category_color || '',
      tags: article.tags || [],
      published_at: article.published_at,
      ts: Date.now(),
    });
    save(list.slice(0, MAX));
  }
  return list;
}

/** 取消收藏（返回收藏后的列表） */
export function removeBookmark(id) {
  const list = getBookmarks().filter((b) => b.id !== id);
  save(list);
  return list;
}

export function clearBookmarks() {
  save([]);
}

/** localStorage 里存收藏的键（监听 storage 事件时要用同一个字符串） */
export const BOOKMARK_KEY = KEY;

/**
 * 跨标签页同步收藏变更。
 *
 * 为什么需要：收藏状态存在 localStorage，而 localStorage 的变更**只在其他标签页触发
 * `storage` 事件，当前页不会**。于是实测出现过这种情况 ——
 * 在收藏页清空全部之后，另一个标签页里那篇文章的按钮仍然写着「取消收藏」，
 * 再点一下等于又把它收回来，状态和存储直接错开。
 *
 * `storage` 事件只在**其他**标签页改动时触发，所以本页自己按的按钮不会重复回调。
 *
 * @param {(list: any[]) => void} handler 收到新列表
 * @returns {() => void} 取消监听的函数（组件卸载时调用）
 */
export function onBookmarksChange(handler) {
  const listener = (e) => {
    // key 为 null 表示 clear() 被调用，也算收藏变化
    if (e.key !== null && e.key !== BOOKMARK_KEY) return;
    handler(getBookmarks());
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
