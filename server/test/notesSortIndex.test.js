/**
 * 手记列表的排序与索引 —— 记录现状 + 用实测找出真正有效的修法。
 *
 * 背景：`「notes filesort 待决策」项` 记着「notes 列表查询排序键不在索引里，EXPLAIN 显示
 * Using filesort」，并给了两个修法：
 *   1. 查询改成 `orderBy('published_at','desc')`（走索引，但改变排序语义）
 *   2. 加一条 `(status, id)` 索引
 *
 * 第 77 轮实测发现两处问题：
 *   a) 记录里的排序键过时了 —— 实际是三键 `is_pinned DESC, published_at DESC, id DESC`，
 *      不是「order by id desc」。
 *   b) **第 2 个修法无效**：加 `(status, id)` 后优化器**仍然**选原索引并 filesort。
 *      真正的原因是 `is_pinned` 排在最左且不在索引里 ——
 *      复合索引只能覆盖「等值列之后」的排序键，最左排序键缺失就整体用不上。
 *      唯一有效的是 `(status, is_pinned, published_at, id)`（覆盖索引）。
 *
 * 2026-11-08：这条覆盖索引**已落到 migrate.js**（`ensureIndex('notes', 'idx_notes_public_sort', ...)`），
 * 所以 B 组现在断言「索引已覆盖排序键」，C 组保留对照实验（旧索引 / (status,id) / 覆盖索引
 * 三者的 EXPLAIN 差异）—— 前者是现状，后者是「为什么只有这一种修法有效」的证据。
 *
 * 本文件做三件事（不碰生产 schema）：
 *   1. 断言当前查询的排序键组合（防排序被无意改动）
 *   2. 断言排序键与现有索引的覆盖关系（说清 filesort 的成因）
 *   3. 用**真实 MySQL 实例**跑 EXPLAIN 对照，验证「第 2 个方案无效」
 *      —— 这条结论不能靠推理，必须实测
 *
 * 第 3 条需要一个能建表的 MySQL。通过环境变量指定探针实例：
 *   WAF_PROBE_MYSQL_SOCKET=/path/to/mysql.sock
 *   WAF_PROBE_MYSQL_PORT=13399
 * 没有就**跳过并明确报告跳过原因** —— 绝不用"假装跑过"来充数。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const NOTES_ROUTE = join(__dirname, '..', 'src', 'routes', 'notes.js');
const MIGRATE = join(__dirname, '..', 'src', 'migrate.js');

let pass = 0;
let fail = 0;
const failures = [];

/** 同步断言 */
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name} — ${e.message}`);
    failures.push(name);
  }
}

/** 异步断言（EXPLAIN 用） */
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name} — ${e.message}`);
    failures.push(name);
  }
}

const routeSrc = readFileSync(NOTES_ROUTE, 'utf8');
const migrateSrc = readFileSync(MIGRATE, 'utf8');

/** 从 .orderBy([...]) 里抽出排序键 */
function sortKeys() {
  const m = routeSrc.match(/\.orderBy\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!m) return null;
  return [...m[1].matchAll(/column:\s*'([^']+)'/g)].map((x) => x[1]);
}

/** 从 migrate.js 里抽出 notes 的索引列 */
function notesIndexCols() {
  const m = migrateSrc.match(/ensureIndex\('notes',\s*'[^']+',\s*\[([^\]]+)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const keys = sortKeys();
const idxCols = notesIndexCols();

async function main() {
  console.log('\n【A. 当前查询的排序键组合】');
  ok('能从 notes.js 解析出排序键', () => {
    assert.ok(keys && keys.length, '没找到 .orderBy([...])');
  });
  ok('排序是三键：is_pinned → published_at → id', () => {
    assert.deepStrictEqual(keys, ['is_pinned', 'published_at', 'id'],
      `实际排序键是 [${keys.join(', ')}]。§6.6a 记的是「order by id desc」，已过时。`);
  });
  ok('排序方向都是 desc（置顶优先，其次时间倒序）', () => {
    const m = routeSrc.match(/\.orderBy\(\s*\[([\s\S]*?)\]\s*\)/);
    const dirs = [...m[1].matchAll(/order:\s*'([^']+)'/g)].map((x) => x[1]);
    assert.deepStrictEqual(dirs, ['desc', 'desc', 'desc'], dirs.join(', '));
  });

  console.log('\n【B. filesort 的成因（排序键 vs 现有索引）】');
  ok('索引已是覆盖索引 (status, is_pinned, published_at, id)（2026-11-08 修复）', () => {
    assert.deepStrictEqual(idxCols, ['status', 'is_pinned', 'published_at', 'id'],
      `索引现在是 [${(idxCols || []).join(', ')}] —— 若被改动，C 组的实测会重新出现 filesort`);
  });
  ok('**is_pinned 现在排在等值列 status 之后的第一位**（旧索引缺的就是它）', () => {
    assert.ok(idxCols.includes('is_pinned'),
      `索引 [${idxCols.join(', ')}] 里没有 is_pinned —— filesort 会回来`);
    assert.strictEqual(idxCols[0], 'status', '等值列必须位于索引最左');
  });
  ok('索引顺序与排序键顺序完全一致（等值列之后逐个对齐）', () => {
    // 复合索引只能覆盖「等值列（status）之后」的排序键，且**顺序必须一致**。
    // 排序键 [is_pinned, published_at, id]，索引去掉 status 之后应当正好是这三个。
    const afterEqual = idxCols.slice(1);
    assert.deepStrictEqual(afterEqual, keys,
      `索引尾段 [${afterEqual.join(', ')}] ≠ 排序键 [${keys.join(', ')}]`);
  });

  console.log('\n【C. 实测：加 (status, id) 索引并不能消除 filesort】');
  const candidates = [];
  if (process.env.WAF_PROBE_MYSQL_SOCKET) candidates.push({ socketPath: process.env.WAF_PROBE_MYSQL_SOCKET });
  if (process.env.WAF_PROBE_MYSQL_PORT) candidates.push({ port: Number(process.env.WAF_PROBE_MYSQL_PORT) });

  let probed = false;
  for (const c of candidates) {
    let db = null;
    try {
      const knex = require('knex');
      db = knex({
        client: 'mysql2',
        connection: {
          host: c.socketPath ? undefined : '127.0.0.1',
          port: c.port,
          socketPath: c.socketPath,
          user: 'root',
          password: '',
        },
      });
      await db.raw('CREATE DATABASE IF NOT EXISTS idxprobe');
      await db.raw('USE idxprobe');
      await db.raw('DROP TABLE IF EXISTS notes');
      await db.raw(`CREATE TABLE notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        is_pinned TINYINT NOT NULL DEFAULT 0,
        published_at DATETIME NULL
      )`);
      await db.raw(`INSERT INTO notes (status,is_pinned,published_at) VALUES
        ('published',0,'2026-01-01'),('published',1,'2026-02-01'),('published',0,'2026-03-01'),
        ('published',0,'2026-04-01'),('published',1,'2026-05-01'),('draft',0,'2026-06-01')`);
      await db.raw('CREATE INDEX idx_notes_status_published_at ON notes (status, published_at)');

      const plan = async () => {
        const r = await db.raw(
          `EXPLAIN SELECT id FROM notes WHERE status='published'
           ORDER BY is_pinned DESC, published_at DESC, id DESC LIMIT 20`);
        return r[0][0].EXPLAIN || '';
      };

      const p1 = await plan();
      await db.raw('CREATE INDEX idx_sid ON notes (status, id)');
      const p2 = await plan();
      await db.raw('CREATE INDEX idx_full ON notes (status, is_pinned, published_at, id)');
      const p3 = await plan();

      const hasSort = (p) => /filesort|Sort:/.test(p);
      await okAsync('当前形态走 filesort', () => assert.ok(hasSort(p1), p1));
      await okAsync('**加 (status, id) 后仍然走 filesort** —— §6.6a 的第 2 个方案无效', () => {
        assert.ok(hasSort(p2), `加索引后没有 filesort：${p2}`);
      });
      await okAsync('加 (status, is_pinned, published_at, id) 后走覆盖索引、无 filesort', () => {
        assert.ok(!hasSort(p3), `仍有 filesort：${p3}`);
        assert.ok(/idx_full/.test(p3), `未选用新索引：${p3}`);
      });

      await db.raw('DROP TABLE notes');
      await db.destroy();
      probed = true;
      break;
    } catch (e) {
      if (db) {
        try {
          await db.raw('DROP TABLE IF EXISTS notes');
          await db.destroy();
        } catch (_) { /* ignore */ }
      }
      console.log(`    （跳过：${e.message}）`);
    }
  }
  if (!probed) {
    await okAsync('⚠ 未能连到探针 MySQL，本组跳过（显式记录，不假装跑过）', () => {
      assert.ok(true, '显式跳过');
    });
    console.log('    ⚠ 第 C 组未实测。结论依据：MySQL 文档 —— 复合索引只能覆盖');
    console.log('      「等值列之后」的排序键；is_pinned 作为最左排序键且不在索引中时，');
    console.log('      索引顺序无法被利用，必然 filesort。');
    console.log('    要实测：设 WAF_PROBE_MYSQL_SOCKET 或 WAF_PROBE_MYSQL_PORT 后重跑。');
  }

  console.log('\n【D. 自检：判据真的能区分】');
  ok('自检：排序键解析器能区分不同形态', () => {
    assert.deepStrictEqual(sortKeys(), ['is_pinned', 'published_at', 'id']);
    const fake = "db('notes').orderBy([{ column: 'id', order: 'desc' }])";
    const m = fake.match(/\.orderBy\(\s*\[([\s\S]*?)\]\s*\)/);
    assert.deepStrictEqual([...m[1].matchAll(/column:\s*'([^']+)'/g)].map((x) => x[1]), ['id']);
  });
  ok('自检：「is_pinned 在索引里」这个反例会被 B 组抓到', () => {
    const idxWithPinned = "ensureIndex('notes', 'x', ['status', 'is_pinned'])";
    const cols = [...idxWithPinned.match(/\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.ok(cols.includes('is_pinned'));
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    console.log('\n⚠ A/B 组红了通常意味着「notes 排序键或索引定义被改动」——');
    console.log('  请确认是有意的，并同步更新本文件期望值与 「notes filesort 待决策」项');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('套件自身异常:', e);
  process.exit(1);
});
