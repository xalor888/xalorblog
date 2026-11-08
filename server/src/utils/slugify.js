/**
 * URL slug 工具。
 *
 * 两层 API：
 *   1. `normalizeSlug(text)` —— 纯字符串处理（小写、去特殊字符、合并连字符、截断 80）
 *   2. `slugify(text, existing)` —— **旧接口**，传入「已占用集合」去重。
 *      保留它是因为 `articlePatchContract` 等测试直接驱动它，且它是纯函数、无副作用。
 *
 *   3. `uniqueSlug(table, text, dbOrTrx)` —— **生产路径用它**，见下方说明。
 *
 * 为什么生产路径不再用「先 pluck 全表再 slugify」：
 *   每个调用点都 `await db('tags').pluck('slug')` 把整张表的 slug 拉成数组，只为判断
 *   「生成的 slug 有没有被占用」。标签几百个、分类几十个时看不出问题，但它随数据量
 *   线性增长，而**唯一性本来就有数据库唯一索引兜底** —— 完全可以让数据库做这件事。
 *
 *   探测式写法（`where('slug', 候选).first()`）走唯一索引，通常一次查询就命中或落空；
 *   有冲突时依次试 `-1`、`-2`。代价是 N 次索引查询（N=冲突数，正常为 1），
 *   收益是**不再把整列读进内存**，也没有任何缓存一致性问题。
 *
 *   在事务里传入 `trx` 即可看到同事务未提交的插入 —— 批量建标签时前一个刚入库的
 *   slug 能被后一个看见，与原来「每次重新 pluck」的可见性一致。
 */

/** 文本 → slug 基串（不含去重后缀） */
function normalizeSlug(text) {
  let base = String(text || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // 全被过滤光（比如纯 emoji / 纯标点）时给一个稳定前缀 + 时间戳，避免空 slug
  if (!base) base = `post-${Date.now()}`;
  // 超长标题截断（80 字符内），防超长 slug 拖长 URL；截断后再去一次尾部连字符
  if (base.length > 80) base = base.slice(0, 80).replace(/-+$/, '');
  return base;
}

/**
 * 旧接口：传入已占用集合去重。纯函数，无 DB 依赖。
 * @param {string} text
 * @param {Iterable<string>} existing 已占用的 slug 集合/数组
 */
function slugify(text, existing = []) {
  const base = normalizeSlug(text);
  let slug = base;
  let i = 1;
  const set = existing instanceof Set ? existing : new Set(existing);
  while (set.has(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

/** 允许被探测的表名白名单（防将来有人把用户输入拼进表名） */
const SLUG_TABLES = new Set(['articles', 'tags', 'categories']);

/**
 * 探测式唯一 slug：不读全表，让数据库的唯一索引回答「有没有被占用」。
 *
 * @param {string} table   articles / tags / categories
 * @param {string} text    原始文本（标题 / 标签名 / 分类名）
 * @param {object} [opts]
 * @param {Function} [opts.conn] knex 实例或事务对象，默认取全局 db
 * @param {number}   [opts.excludeId] 排除的自身 id（编辑场景：自己的 slug 不该与自己冲突）
 * @param {number}   [opts.maxTries=50] 冲突重试上限，防止异常数据导致长循环
 * @returns {Promise<string>}
 */
async function uniqueSlug(table, text, opts = {}) {
  if (!SLUG_TABLES.has(table)) {
    throw new Error(`uniqueSlug: 不支持的表名 ${table}`);
  }
  const conn = opts.conn || require('../db');
  const excludeId = opts.excludeId;
  const maxTries = Number.isFinite(opts.maxTries) ? opts.maxTries : 50;
  const base = normalizeSlug(text);

  /** 探测某个候选是否已被别人占用 */
  const taken = async (candidate) => {
    const q = conn(table).where('slug', candidate);
    if (excludeId !== undefined && excludeId !== null) q.whereNot('id', excludeId);
    const hit = await q.first('id');
    return !!hit;
  };

  let candidate = base;
  for (let i = 1; i <= maxTries; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await taken(candidate))) return candidate;
    candidate = `${base}-${i}`;
  }
  // 极端情况（同一基串已被占满 maxTries 个）：退化为带时间戳后缀，保证能落库
  return `${base}-${Date.now()}`;
}

module.exports = { slugify, normalizeSlug, uniqueSlug, SLUG_TABLES };
