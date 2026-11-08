/**
 * 枚举清单的单点性（零依赖）。
 *
 * 背景：审核状态 `['pending','approved','rejected']` 原本分散在 **8 处**：
 *   - `migrate.js` 里 3 张表各自的 `t.enum('status', [...])`
 *   - `admin.js` 里 5 处接口校验（评论/友链/留言的单条与批量）
 *   - `admin.js` 里 2 处中文映射（评论导出 / 友链导出）
 *
 * 分头写的后果：
 *   - 漏了接口校验 → 新状态永远提交不进去（好发现：一测就 400）
 *   - 漏了中文映射 → 界面上显示原始英文（不好发现：只有那个状态才看得出）
 *   - 漏了 schema enum → 写入直接报错（好发现，但那是在生产上）
 *
 * 这里钉住「运行时那份只有一处定义」，并检查它与 schema 一致。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { REVIEW_STATUS, REVIEW_STATUS_ZH, ARTICLE_STATUS, isOneOf } = require('../src/utils/enums');
const { stripCommentLines } = require('./helpers/sourceText');

let passCount = 0, failCount = 0;
function check(name, fn) {
  try { fn(); passCount++; console.log(`  ✓ ${name}`); }
  catch (e) { failCount++; console.log(`  ✗ ${name} — ${e.message}`); }
}

const read = (p) => stripCommentLines(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));

console.log('=== A. 常量本身 ===');
check('REVIEW_STATUS 是三个值的冻结数组', () => {
  assert.deepStrictEqual([...REVIEW_STATUS], ['pending', 'approved', 'rejected']);
  assert.ok(Object.isFrozen(REVIEW_STATUS));
});
check('中文映射覆盖每个状态', () => {
  for (const v of REVIEW_STATUS) {
    assert.strictEqual(typeof REVIEW_STATUS_ZH[v], 'string', `缺 ${v} 的中文`);
  }
});
check('中文映射没有多余键（枚举删值时要一起删）', () => {
  assert.deepStrictEqual(Object.keys(REVIEW_STATUS_ZH).sort(), [...REVIEW_STATUS].sort());
});
check('ARTICLE_STATUS 是 draft/published', () => {
  assert.deepStrictEqual([...ARTICLE_STATUS], ['draft', 'published']);
});

console.log('\n=== B. isOneOf 的边界 ===');
check('合法值返回 true', () => REVIEW_STATUS.every((v) => isOneOf(REVIEW_STATUS, v) === true));
check('非法值返回 false', () => {
  assert.strictEqual(isOneOf(REVIEW_STATUS, 'spam'), false);
  assert.strictEqual(isOneOf(REVIEW_STATUS, ''), false);
  assert.strictEqual(isOneOf(REVIEW_STATUS, 'PENDING'), false);
});
check('原型链键不被当成合法值（Array.includes 不会走原型链）', () => {
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(isOneOf(REVIEW_STATUS, k), false, `${k} 不该通过`);
  }
});
check('非数组 / null 不抛', () => {
  assert.strictEqual(isOneOf(null, 'pending'), false);
  assert.strictEqual(isOneOf(undefined, 'pending'), false);
  assert.strictEqual(isOneOf('pending', 'pending'), false);
});

console.log('\n=== C. admin.js 里不许再有硬编码 ===');
{
  const src = read('src/routes/admin.js');
  check('没有硬编码状态校验数组', () => {
    assert.ok(!/\['pending',\s*'approved',\s*'rejected'\]/.test(src));
    assert.ok(!/\['approved',\s*'rejected',\s*'pending'\]/.test(src));
  });
  check('没有硬编码中文映射', () => {
    assert.ok(!/pending:\s*'待审核'/.test(src));
  });
  check('从 utils/enums 引入', () => {
    assert.ok(/require\('\.\.\/utils\/enums'\)/.test(src));
  });
  check('校验统一走 isOneOf', () => {
    assert.ok((src.match(/isOneOf\(REVIEW_STATUS, status\)/g) || []).length >= 4,
      '至少 4 处接口校验应该用它');
  });
}

console.log('\n=== D. 与数据库 schema 一致 ===');
{
  const mig = read('src/migrate.js');
  // 只取「审核状态」那三张表 —— articles.status 是 ARTICLE_STATUS（draft/published），
  // 它也叫 status，但不能拿同一份判据去比（第一次写时就是这么误报的）。
  const reviewTables = ['comments', 'links', 'messages'];
  // 两种写法：字面量（旧）与 [...常量]（2026-11-08 起的唯一写法）。派生式要把常量展开再比。
  const CONST_MAP = { ARTICLE_STATUS, REVIEW_STATUS };
  const allEnums = [...mig.matchAll(/t\.enum\('status',\s*\[([^\]]+)\]\)/g)]
    .map((m) => {
      const body = m[1].trim();
      const spread = body.match(/^\.\.\.([A-Za-z_][A-Za-z0-9_]*)$/);
      if (spread) return [...(CONST_MAP[spread[1]] || [])].sort();
      return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    });
  const reviewEnums = allEnums.filter((e) => JSON.stringify(e) === JSON.stringify([...REVIEW_STATUS].sort()));

  check(`migrate.js 里至少 2 张表用审核状态`, () => {
    assert.ok(reviewEnums.length >= 2, `只找到 ${reviewEnums.length} 处，应至少 comments 与 messages`);
  });
  check('没有「是 status enum 但不属于审核状态也不属于文章状态」的第三类',
    () => {
      const known = [...REVIEW_STATUS].sort().join(','), art = [...ARTICLE_STATUS].sort().join(',');
      const unknown = allEnums.filter((e) => {
        const k = e.join(',');
        return k !== known && k !== art;
      });
      assert.deepStrictEqual(unknown, [],
        `出现了新的 status 枚举：${JSON.stringify(unknown)} —— 要么加进 enums.js，要么说明它是第三种语义`);
    });
  check(`审核状态覆盖 ${reviewTables.length} 个实体（comments/links/messages 共用一套）`, () => {
    // 从 admin.js 的路由里确认三个实体都在用
    const adm = read('src/routes/admin.js');
    const missing = reviewTables.filter((t) => !new RegExp(`/${t}/`).test(adm));
    assert.deepStrictEqual(missing, [], `这些实体的状态接口不见了：${missing.join(', ')}`);
  });
}

console.log('\n=== E. 自检：判据真的能区分 ===');
check('自检：少一个值的数组会判定不一致', () => {
  const wrong = ['approved', 'rejected'];
  assert.notDeepStrictEqual([...wrong].sort(), [...REVIEW_STATUS].sort());
});
check('自检：顺序不同但集合相同 → 排序后相等（不该误报）', () => {
  assert.deepStrictEqual([...REVIEW_STATUS].reverse().sort(), [...REVIEW_STATUS].sort());
});
check('自检：includes 对未列出的值返回 false（不是 undefined）', () => {
  assert.strictEqual(REVIEW_STATUS.includes('spam'), false);
});

console.log(`\nenums 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
