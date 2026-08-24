/**
 * 正文刮取检测：单会话短时读太多不同文章时拒绝并计信誉。
 * 人点开几篇没问题；无头循环拖详情会撞窗。
 * 状态在内存，重启清零——挡的是进行中的采集，不是跨进程账本。
 */

const WINDOW_MS = 45 * 1000;
const MAX_UNIQUE = 12;
const MAX_HITS = 24;
const MAX_KEYS = 8000;

const buckets = new Map(); // key -> { hits, slugs: Map(slug -> ts), start }

function readerKey(ip, fp) {
  return `${ip || 'unknown'}:${String(fp || '').slice(0, 128)}`;
}

function prune(now) {
  if (buckets.size <= MAX_KEYS) return;
  for (const [k, rec] of buckets) {
    if (now - rec.start > WINDOW_MS * 2) buckets.delete(k);
  }
  while (buckets.size > MAX_KEYS * 0.75) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function noteArticleRead(ip, fp, slug) {
  const key = readerKey(ip, fp);
  const now = Date.now();
  let rec = buckets.get(key);
  if (!rec || now - rec.start > WINDOW_MS) {
    rec = { hits: 0, slugs: new Map(), start: now };
    buckets.set(key, rec);
    prune(now);
  }
  rec.hits += 1;
  rec.slugs.set(String(slug || ''), now);
  if (rec.slugs.size > MAX_UNIQUE || rec.hits > MAX_HITS) {
    return { ok: false, reason: 'scrape' };
  }
  return { ok: true };
}

function resetScrapeGuard() {
  buckets.clear();
}

module.exports = {
  noteArticleRead,
  resetScrapeGuard,
  WINDOW_MS,
  MAX_UNIQUE,
  MAX_HITS,
};
