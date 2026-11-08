/**
 * 冗余索引判定（零 DB、零服务）。
 *
 * 背景：`articles.slug` 在建表时是 `.unique()`（自动产出 `articles_slug_unique`），
 * 而 `migrate.js` 后面又 `ensureIndex('articles','idx_articles_slug',['slug'])` 建了
 * 一条**同列普通索引**。两条索引 = 每次写入维护两棵 B+ 树，读路径却只用一条。
 *
 * 判定必须保守：只有「列完全相同 + 覆盖者确实是 UNIQUE」才允许删。
 * 这里逐条锁住五种「不该删」的情形 —— 删错索引是不可逆的（要重建），
 * 而删对了只是省一点写放大，所以错一侧必须偏向「不删」。
 */

// 直接 require 纯函数模块：不再经过 migrate.js，因此不需要 DB_PASSWORD 占位符
const { classifyRedundantIndex } = require('../src/utils/indexAnalysis');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 构造 SHOW INDEX 行 */
const row = (key, col, seq, unique) => ({
  Key_name: key, Column_name: col, Seq_in_index: seq, Non_unique: unique ? 0 : 1,
});

console.log('=== A. 应当删除：同列 + 覆盖者 UNIQUE ===');
{
  const rows = [
    row('PRIMARY', 'id', 1, true),
    row('articles_slug_unique', 'slug', 1, true),
    row('idx_articles_slug', 'slug', 1, false),
  ];
  const v = classifyRedundantIndex(rows, 'idx_articles_slug', 'articles_slug_unique');
  ok('判定为可删', v.drop === true, JSON.stringify(v));
  ok('理由里点名覆盖索引', /articles_slug_unique/.test(v.reason), v.reason);
}

console.log('\n=== B. 不该删的四种情形 ===');
{
  const onlyTarget = [row('idx_articles_slug', 'slug', 1, false)];
  ok('覆盖索引不存在 → 不删',
    classifyRedundantIndex(onlyTarget, 'idx_articles_slug', 'articles_slug_unique').drop === false);

  const onlyKeeper = [row('articles_slug_unique', 'slug', 1, true)];
  ok('目标索引不存在 → 不删（且理由说明是"无需处理"）',
    classifyRedundantIndex(onlyKeeper, 'idx_articles_slug', 'articles_slug_unique').drop === false
    && /无需处理/.test(classifyRedundantIndex(onlyKeeper, 'idx_articles_slug', 'articles_slug_unique').reason));

  const diffCols = [
    row('articles_slug_unique', 'slug', 1, true),
    row('idx_articles_slug', 'title', 1, false),
  ];
  ok('列不同 → 不删',
    classifyRedundantIndex(diffCols, 'idx_articles_slug', 'articles_slug_unique').drop === false);

  const notUnique = [
    row('idx_a', 'slug', 1, false),
    row('idx_b', 'slug', 1, false),
  ];
  ok('覆盖者不是 UNIQUE → 不删（删了会丢唯一约束）',
    classifyRedundantIndex(notUnique, 'idx_a', 'idx_b').drop === false);

  const multiDiff = [
    row('idx_ab', 'a', 1, true), row('idx_ab', 'b', 2, true),
    row('idx_ab2', 'b', 1, false), row('idx_ab2', 'a', 2, false),
  ];
  ok('多列顺序不同 → 不删（(a,b) 与 (b,a) 覆盖关系不同）',
    classifyRedundantIndex(multiDiff, 'idx_ab2', 'idx_ab').drop === false);
}

console.log('\n=== C. 多列同序时应当删除 ===');
{
  const rows = [
    row('uniq_ab', 'a', 1, true), row('uniq_ab', 'b', 2, true),
    row('dup_ab', 'a', 1, false), row('dup_ab', 'b', 2, false),
  ];
  ok('列与顺序完全一致且覆盖者 UNIQUE → 可删',
    classifyRedundantIndex(rows, 'dup_ab', 'uniq_ab').drop === true);
}

console.log('\n=== D. 脏输入不炸 ===');
ok('空数组 → 不删', classifyRedundantIndex([], 'a', 'b').drop === false);
ok('null → 不删', classifyRedundantIndex(null, 'a', 'b').drop === false);
ok('行里有 null 项被跳过',
  classifyRedundantIndex([null, row('uniq', 's', 1, true), row('dup', 's', 1, false)], 'dup', 'uniq').drop === true);

console.log('\n=== E. 源码契约：migrate 不再建重复索引 ===');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrate.js'), 'utf8');
  // 只看代码行：注释里会引用旧写法作说明，不能用全文正则。
  // 原来这里是手写的 `!/^\s*(\*|\/\//.test(line)` —— 与 utils/sourceText 里修过的
  // 「`* {` 被当成块注释删掉」是同一个 bug 面。统一走工具（它有 inBlock 上下文判断）。
  const { stripCommentLines } = require('./helpers/sourceText');
  const code = stripCommentLines(src);
  ok('代码里不再对 articles.slug 调用 ensureIndex（那会建出第二条同列索引）',
    !/ensureIndex\('articles',\s*'idx_articles_slug'/.test(code));
  ok('改为 dropRedundantIndex(articles, idx_articles_slug, articles_slug_unique)',
    /dropRedundantIndex\('articles',\s*'idx_articles_slug',\s*'articles_slug_unique'\)/.test(code));
  ok('删索引前先查 SHOW INDEX（不能盲删）',
    /SHOW INDEX FROM/.test(code) && /classifyRedundantIndex\(rows, indexName, keeperName\)/.test(code));
}

console.log(`\nredundantIndex 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
