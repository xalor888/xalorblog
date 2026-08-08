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
