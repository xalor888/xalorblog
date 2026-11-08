/**
 * 探测式唯一 slug（零 DB、零服务）。
 *
 * 背景：每个「生成 slug」的调用点都是 `slugify(x, await db('tags').pluck('slug'))` ——
 * 把整张表的 slug 拉成数组，只为判断一个候选有没有被占用。改成探测式后：
 *   - 走唯一索引，通常 1 次查询；
 *   - 唯一性由数据库回答，没有缓存一致性问题；
 *   - 在事务里传 `conn: trx` 能看到同事务未提交的插入（批量建标签时必须）。
 *
 * 用假 conn 驱动：它记录每次查询，并能对 `pluck()` 直接抛错 —— 如果将来有人改回
 * 全表读，测试会以「不应该做 pluck」失败，而不是悄悄变慢。
 *
 * 这类基础设施的 bug 不会报错，只会让 slug 撞车（数据库 unique 约束把它变成 500），
 * 或者在事务里看不到兄弟插入（批量导入时后半段全部重复）。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { uniqueSlug, normalizeSlug, slugify, SLUG_TABLES } = require('../src/utils/slugify');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * 假 knex：taken = { table: [{id, slug}] }；log 记录每次 first() 的探测。
 */
function makeConn(taken, log = []) {
  return (table) => {
    const state = { slug: null, excludeId: null };
    const q = {
      where(col, val) { if (col === 'slug') state.slug = val; return q; },
      whereNot(col, val) { if (col === 'id') state.excludeId = val; return q; },
      first() {
        log.push({ table, slug: state.slug, excludeId: state.excludeId });
        const hit = (taken[table] || []).find(
          (r) => r.slug === state.slug && r.id !== state.excludeId
        );
        return Promise.resolve(hit ? { id: hit.id } : undefined);
      },
      pluck() { throw new Error(`不应该对 ${table} 做 pluck（全表读）`); },
    };
    return q;
  };
}

async function suite() {
  console.log('=== A. 无冲突：只查一次 ===');
  {
    const log = [];
    const slug = await uniqueSlug('tags', 'Vue', { conn: makeConn({ tags: [] }, log) });
    ok('返回规范化 slug', slug === 'vue', slug);
    ok('只发起 1 次查询（走唯一索引）', log.length === 1, `实际 ${log.length} 次`);
    ok('探测条件是 where(slug, 候选)', log[0].slug === 'vue');
  }

  console.log('\n=== B. 有冲突：依次试 -1 / -2 / -3 ===');
  {
    const log = [];
    const conn = makeConn({ tags: [{ id: 1, slug: 'vue' }, { id: 2, slug: 'vue-1' }, { id: 3, slug: 'vue-2' }] }, log);
    const slug = await uniqueSlug('tags', 'Vue', { conn });
    ok('跳过三个已占用的候选', slug === 'vue-3', slug);
    ok('查询次数 = 冲突数 + 1', log.length === 4, `实际 ${log.length} 次`);
    ok('每次探测都是 where(slug, ...)（没有一次全表读）', log.every((r) => typeof r.slug === 'string'));
  }

  console.log('\n=== C. excludeId：编辑自己时不该与自己冲突 ===');
  {
    const log = [];
    const conn = makeConn({ categories: [{ id: 7, slug: 'tech' }] }, log);
    const same = await uniqueSlug('categories', 'Tech', { conn, excludeId: 7 });
    ok('保留自己的 slug（不再加 -1）', same === 'tech', same);
    ok('探测时带上了 whereNot(id, 7)', log[0].excludeId === 7, JSON.stringify(log[0]));
  }
  {
    // 别人的 slug 仍然要避开：自己叫 tech、别人也叫 tech（历史数据/并发写入）
    // → 排除自己后仍有 id=8 占着 tech，必须退到 tech-1
    const conn = makeConn({ categories: [{ id: 7, slug: 'tech' }, { id: 8, slug: 'tech' }] });
    const slug = await uniqueSlug('categories', 'Tech', { conn, excludeId: 7 });
    ok('排除自己后仍避开他人占用的同名 slug', slug === 'tech-1', slug);
  }
  {
    // 反向对照：别人占的是 tech-1 而不是 tech，自己就该保住 tech（不该无谓加后缀）
    const conn = makeConn({ categories: [{ id: 7, slug: 'tech' }, { id: 8, slug: 'tech-1' }] });
    const slug = await uniqueSlug('categories', 'Tech', { conn, excludeId: 7 });
    ok('别人占的是 tech-1 时不误伤自己的 tech（不加无谓后缀）', slug === 'tech', slug);
  }

  console.log('\n=== D. 事务内可见性（conn: trx 就不该换成全局 db） ===');
  {
    const log = [];
    // 模拟：同一事务里先建了 tag "rust"，再建同名 tag 时应看到它
    const trxTaken = { tags: [{ id: 11, slug: 'rust' }] };
    const trxConn = makeConn(trxTaken, log);
    const slug = await uniqueSlug('tags', 'Rust', { conn: trxConn });
    ok('事务内能看到未提交的兄弟插入（不会被判成 rust 而重复）', slug === 'rust-1', slug);
    ok('用的是传入的 conn，不是全局 db', log.length >= 1);
  }

  console.log('\n=== E. 防御性 ===');
  {
    let threw = false;
    try { await uniqueSlug('users', 'x', { conn: makeConn({}) }); } catch (e) { threw = true; }
    ok('非法表名抛错（防将来把用户输入拼进表名）', threw);
    ok('白名单只含三张有 slug 的表',
      SLUG_TABLES.has('articles') && SLUG_TABLES.has('tags') && SLUG_TABLES.has('categories')
      && SLUG_TABLES.size === 3);
  }
  {
    // 同一基串被占满 maxTries 个时，退化为时间戳后缀，保证能落库
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, slug: i === 0 ? 'x' : `x-${i}` }));
    const slug = await uniqueSlug('tags', 'x', { conn: makeConn({ tags: many }), maxTries: 5 });
    ok('超过重试上限时退化为带时间戳的后缀（不返回已占用值）',
      slug !== 'x' && !many.some((r) => r.slug === slug), slug);
  }

  console.log('\n=== F. 规范化不变（与旧 slugify 的字符串处理一致） ===');
  {
    const cases = ['Hello World', '中文 标题', '  Vue3 使用  ', 'a--b', '---', 'A/B', 'x'.repeat(200)];
    const same = cases.every((c) => normalizeSlug(c) === slugify(c, []));
    ok('normalizeSlug 与 slugify(x, []) 结果完全一致（抽函数没改语义）', same);
    ok('超长截断到 80', normalizeSlug('x'.repeat(200)).length === 80, String(normalizeSlug('x'.repeat(200)).length));
    ok('纯标点输入有兜底前缀', /^post-\d+$/.test(normalizeSlug('???')), normalizeSlug('???'));
    ok('旧接口仍支持 Set 入参', slugify('a', new Set(['a'])) === 'a-1');
  }

  console.log(`\nslugUnique 套件结果: ${pass} 通过, ${fail} 失败`);
  if (fail) process.exit(1);
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
