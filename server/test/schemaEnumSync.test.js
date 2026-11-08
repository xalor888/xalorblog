/**
 * 数据库 schema 的 enum 与运行时枚举常量必须一致。
 *
 * 背景：`utils/enums.js` 是枚举的**运行时**唯一来源（校验 + 展示），
 * 但 `migrate.js` 里 `t.enum('status', [...])` 是**数据库结构**，不能跟着常量自动变
 * —— 改它要跑迁移。两者一旦不一致：
 *   - schema 少了新值 → 写入直接报错（好发现）
 *   - schema 多了废弃值 → 能写进去但校验会拒（静默不一致，难发现）
 *   - **顺序不一致** → `ORDER BY status` 的排序语义变了，而没人会想到是这个原因
 *
 * `「schema enum 待决策」项` 记着「3 处 t.enum 仍是硬编码」。第 79 轮实测：**实际是 5 处**，
 * 且分属 2 个枚举（articles/notes 用 ARTICLE_STATUS；comments/links/messages 用 REVIEW_STATUS）。
 *
 * 本文件不改 schema（那要迁移，属需人工决策项），只做**静态一致性断言**：
 * 每一处 `t.enum('status', [...])` 的取值必须与对应常量逐项相同（含顺序）。
 * 这样谁改了常量忘了迁移、或改了迁移忘了常量，测试立刻红。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const { ARTICLE_STATUS, REVIEW_STATUS, isOneOf } = require('../src/utils/enums.js');

const MIGRATE = join(__dirname, '..', 'src', 'migrate.js');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const src = readFileSync(MIGRATE, 'utf8');
const lines = src.split('\n');

/**
 * 抽出所有 `t.enum('status', [...])`：所属表、取值、默认值、行号。
 * 表名靠向上找最近一个 `createTable('xxx'` —— 迁移文件是顺序书写的，
 * 每个 createTable 块内的 enum 都属于那张表。
 */
function collectEnums() {
  const out = [];
  let currentTable = null;
  lines.forEach((line, i) => {
    const tm = line.match(/createTable\(\s*'([a-z_]+)'/);
    if (tm) currentTable = tm[1];
    const em = line.match(/t\.enum\(\s*'status'\s*,\s*\[([^\]]+)\]\s*\)(?:\.defaultTo\(\s*'([^']+)'\s*\))?/);
    if (em) {
      const values = [...em[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      out.push({ table: currentTable, values, defaultTo: em[2] || null, line: i + 1 });
    }
  });
  return out;
}

const enums = collectEnums();

/** 哪张表用哪个常量（这张清单本身也要断言，防新增表漏归类） */
const TABLE_TO_ENUM = {
  articles: { name: 'ARTICLE_STATUS', values: ARTICLE_STATUS },
  notes: { name: 'ARTICLE_STATUS', values: ARTICLE_STATUS },
  comments: { name: 'REVIEW_STATUS', values: REVIEW_STATUS },
  links: { name: 'REVIEW_STATUS', values: REVIEW_STATUS },
  messages: { name: 'REVIEW_STATUS', values: REVIEW_STATUS },
};

console.log('\n【A. 枚举常量的定义】');
ok('ARTICLE_STATUS 是 [draft, published]', () => {
  assert.deepStrictEqual([...ARTICLE_STATUS], ['draft', 'published'], ARTICLE_STATUS.join(','));
});
ok('REVIEW_STATUS 是 [pending, approved, rejected]', () => {
  assert.deepStrictEqual([...REVIEW_STATUS], ['pending', 'approved', 'rejected'], REVIEW_STATUS.join(','));
});
ok('两个常量都冻结（防某处 push 污染全局）', () => {
  assert.ok(Object.isFrozen(ARTICLE_STATUS) && Object.isFrozen(REVIEW_STATUS));
});
ok('isOneOf 大小写敏感（这些值是数据库字面量）', () => {
  assert.ok(isOneOf(ARTICLE_STATUS, 'draft') && !isOneOf(ARTICLE_STATUS, 'Draft'));
  assert.ok(!isOneOf(ARTICLE_STATUS, 'constructor'), '原型链上的键不该命中');
});

console.log('\n【B. migrate.js 里每一处 t.enum 都与常量一致】');
ok(`找到 ${enums.length} 处 t.enum('status', ...)`, () => {
  // §6.7 记的是 3 处 —— 实测是 5 处。数量变化时提醒更新文档。
  assert.strictEqual(enums.length, 5,
    `实际 ${enums.length} 处。§6.7 记的是「3 处」，已过时；数量变了请同步更新文档`);
});

for (const e of enums) {
  const spec = TABLE_TO_ENUM[e.table];
  ok(`${e.table}.status（第 ${e.line} 行）与 ${spec ? spec.name : '?'} 逐项一致`, () => {
    assert.ok(spec, `表 ${e.table} 不在 TABLE_TO_ENUM 清单里 —— 新增表时请归类`);
    // 顺序也要一致：MySQL enum 的顺序影响 ORDER BY 语义
    assert.deepStrictEqual(e.values, [...spec.values],
      `schema 是 [${e.values.join(',')}]，常量是 [${[...spec.values].join(',')}]`);
  });
  ok(`${e.table}.status 的默认值在枚举内`, () => {
    if (!e.defaultTo) return;   // 没写 defaultTo 也算通过
    assert.ok(e.values.includes(e.defaultTo),
      `defaultTo('${e.defaultTo}') 不在 [${e.values.join(',')}] 里`);
  });
}

console.log('\n【C. 归类完整性（没有表被漏掉）】');
ok('每处 enum 的表都在 TABLE_TO_ENUM 里登记了', () => {
  const unknown = enums.filter((e) => !TABLE_TO_ENUM[e.table]).map((e) => e.table);
  assert.deepStrictEqual(unknown, [], `未归类：${unknown.join(', ')}`);
});
ok('TABLE_TO_ENUM 里登记的表在 migrate.js 里都真的有 status enum', () => {
  const found = new Set(enums.map((e) => e.table));
  const ghost = Object.keys(TABLE_TO_ENUM).filter((t) => !found.has(t));
  assert.deepStrictEqual(ghost, [], `登记了但没有 enum：${ghost.join(', ')}`);
});
ok('只有 2 个枚举值集被使用（没有第三种写法混进来）', () => {
  const sets = new Set(enums.map((e) => e.values.join(',')));
  assert.strictEqual(sets.size, 2, `出现了 ${sets.size} 种：${[...sets].join(' | ')}`);
});

console.log('\n【D. 自检：判据真的能区分】');
ok('自检：解析器能识别不同的取值列表', () => {
  const fake = "await db.schema.createTable('x', (t) => {\n  t.enum('status', ['a', 'b']).defaultTo('a');\n});";
  const saved = src;
  // 直接换源不现实，这里验证正则本身
  const m = fake.match(/t\.enum\(\s*'status'\s*,\s*\[([^\]]+)\]\s*\)(?:\.defaultTo\(\s*'([^']+)'\s*\))?/);
  assert.ok(m);
  assert.deepStrictEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), ['a', 'b']);
  assert.strictEqual(m[2], 'a');
  void saved;
});
ok('自检：顺序不同会被判为不一致', () => {
  const a = ['pending', 'approved', 'rejected'];
  const b = ['approved', 'pending', 'rejected'];
  assert.notDeepStrictEqual(a, b, '顺序不同的数组必须被判不同');
});
ok('自检：值相同但顺序相同才算一致', () => {
  assert.deepStrictEqual(['draft', 'published'], [...ARTICLE_STATUS]);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n⚠ 红了通常意味着「改了 utils/enums.js 但没跑迁移」或反之 ——');
  console.log('  改 schema 需要 ALTER TABLE（MySQL 8 会重建表），属需人工决策项。');
  process.exit(1);
}
