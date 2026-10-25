/**
 * 阅读足迹：本机记录「最近读过哪些文章」。
 *
 * 为什么不做成后台服务：足迹是**阅读者自己的**，不是站长的数据。
 * 存本地既不需要登录、也不用担心隐私 —— 和收藏（utils/bookmark.js）是一套心智模型，
 * 读者在页脚已经熟悉「我的收藏」，这里就放在它旁边。
 *
 * 与收藏的区别：
 *   - 收藏是**主动**的、长期保留；足迹是**被动**的、滚动淘汰。
 *   - 足迹同一篇只留一条（重复打开把时间刷新、并把旧条移到最前），
 *     否则反复回看同一篇会把列表占满。
 */

const KEY = 'xalor_read_history';
/** 上限：超过就丢掉最旧的。20 条够看出「最近在读什么」，又不至于把页脚撑爆。 */
const MAX = 20;

function readList() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((x) => x && x.slug) : [];
  } catch (e) {
    // 隐私模式 / 数据损坏：当成没有足迹，不能让页脚因此崩掉
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch (e) {
    /* 配额满/隐私模式忽略 */
  }
}

/** 取足迹（新的在前） */
export function getHistory() {
  return readList();
}

/**
 * 记一条足迹。
 *
 * 只存渲染卡片必需的字段 —— 和收藏一样是快照，所以**不能指望它永远有效**；
 * 页面展示前要按 slug 校验（见 History.vue 的清理逻辑）。
 *
 * @param {{id:number, slug:string, title:string, summary?:string, cover?:string,
 *          category_name?:string, category_color?:string, published_at?:string}} article
 */
export function addHistory(article) {
  if (!article || !article.slug) return;
  const entry = {
    id: article.id,
    slug: article.slug,
    title: article.title || '',
    summary: article.summary || '',
    cover: article.cover || '',
    category_name: article.category_name || '',
    category_color: article.category_color || '',
    published_at: article.published_at || '',
    ts: Date.now(),
  };
  // 去重：同一篇只留最新的一条
  const list = readList().filter((b) => b.slug !== entry.slug);
  save([entry, ...list]);
}

export function removeHistory(slug) {
  const list = readList().filter((b) => b.slug !== slug);
  save(list);
  return list;
}

export function clearHistory() {
  save([]);
}

export const HISTORY_KEY = KEY;

/** 跨标签页同步足迹变更（与收藏同一套做法：storage 事件不会在当前页触发） */
export function onHistoryChange(handler) {
  const listener = (e) => {
    if (e.key !== null && e.key !== HISTORY_KEY) return;
    handler(getHistory());
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
