/**
 * 失效条目校验的**共享缓存**：收藏页与阅读足迹页都用它。
 *
 * 为什么需要缓存：
 *   两个页面都在挂载时逐条请求 `articleApi.detail(slug)` 来判断文章是否还存在。
 *   足迹上限 20 条、收藏也有上限，于是**每进一次页面就是二十来个请求** ——
 *   同一个 slug 在一天里被反复问过很多遍，而文章是否被删除是件变化很慢的事。
 *   本站 `/api` 限速是每分钟 120 次，两个页面来回切几下就吃掉可观额度，
 *   更糟的是这些请求在语义上全是重复的。
 *
 * 策略：
 *   - 只缓存**成功**（224/200）与**明确 404** 两种结论，分别记 `ok` / `gone`；
 *   - 网络错误、超时、5xx 一律**不缓存** —— 那是暂时状态，缓存下来会让一次抖动
 *     把收藏错误地标成失效（我们只在 404 时删除，但「不缓存」保证了下次还会再问）；
 *   - TTL 24 小时：文章被删除后最多一天内被发现，换来的是页面打开时的零重复请求。
 */

const KEY = 'xalor_slug_check';
const TTL = 24 * 3600 * 1000;

function readMap() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeMap(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch (e) {
    /* 隐私模式/配额满忽略 */
  }
}

/** 取缓存的结论：'ok' | 'gone' | null（未知或已过期） */
export function getCachedStatus(slug) {
  if (!slug) return null;
  const entry = readMap()[slug];
  if (!entry || typeof entry.ts !== 'number') return null;
  if (Date.now() - entry.ts > TTL) return null;
  return entry.status === 'gone' ? 'gone' : entry.status === 'ok' ? 'ok' : null;
}

/** 记录结论。只接受 'ok' / 'gone' —— 调用方不该把网络错误缓存进来。 */
export function setCachedStatus(slug, status) {
  if (!slug || (status !== 'ok' && status !== 'gone')) return;
  const map = readMap();
  map[slug] = { status, ts: Date.now() };
  // 顺手清理过期项与明显超量的旧记录，避免这个键无限长
  const now = Date.now();
  const entries = Object.entries(map).filter(([, v]) => v && now - v.ts <= TTL);
  writeMap(Object.fromEntries(entries.slice(-200)));
}

/** 清掉缓存（调试或用户主动刷新时可用） */
export function clearStatusCache() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    /* 忽略 */
  }
}
