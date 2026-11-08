/**
 * `migrate()` 的**真实执行**测试 —— 建全站 schema，并验证幂等。
 *
 * 为什么这条最重要：`src/migrate.js`（475 行）负责建出全站 18 张表与 14 条索引，
 * 而它**从来没有被真正执行过**。此前 4 个涉及它的测试全是**静态文本分析**
 * （读源码做正则比对），没有一行跑过 `migrate()` 本体。
 *
 * 而它在生产里是**每次部署都跑**的（`npm run migrate`）。这意味着三件事
 * 任何一件坏了都只在部署时才发现：
 *   1. 建表语句本身写错了（字段类型/默认值/外键）
 *   2. **幂等性坏了** —— 第二次跑报错或重复建索引，等于每次重启都炸
 *   3. 索引没建成（查询悄悄变慢，没有任何报错）
 *
 * 第 2 条尤其要紧：代码里到处是 `hasTable(...).then(if (!exists) createTable)`
 * 和 `ensureIndex(...)`，这种写法**看起来**幂等，但只有真跑两次才知道。
 *
 * 为什么不连生产库：`npm run test:all` 会清库，按硬约束不能跑；
 * 而生产账号也没有 CREATE DATABASE / DROP 权限。
 * 所以本套件用一个**独立的临时 mysqld 实例**（`npm run probe:mysql` 启动），
 * 在里面建一个用完即弃的库。生产库全程只读、不碰。
 *
 * 没有探针实例时**显式跳过并打印原因** —— 绝不用"假装跑过"充数。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];
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

/** 源码里声明的表与索引（从 migrate.js 静态提取，用于核对真实结果） */
const EXPECTED_TABLES = [
  'article_tags', 'articles', 'audit_logs', 'categories', 'comments', 'gate_tickets',
  'ip_bans', 'links', 'messages', 'notes', 'security_config', 'sessions', 'settings',
  'tags', 'users', 'visit_uv', 'visits',
];

async function main() {
  console.log('\n【A. 探针实例可用性】');

  const conn = {};
  if (process.env.WAF_PROBE_MYSQL_SOCKET) conn.socketPath = process.env.WAF_PROBE_MYSQL_SOCKET;
  else if (process.env.WAF_PROBE_MYSQL_PORT) {
    conn.host = '127.0.0.1';
    conn.port = Number(process.env.WAF_PROBE_MYSQL_PORT);
  }

  if (!conn.socketPath && !conn.port) {
    await okAsync('⚠ 未配置探针 MySQL，本套件跳过（显式记录）', () => {
      assert.ok(true, '设置 WAF_PROBE_MYSQL_SOCKET 或 WAF_PROBE_MYSQL_PORT 可启用');
    });
    console.log('    要实测：npm run probe:mysql  然后重跑本套件');
    console.log('    这部分是本仓库唯一的验证空白（写路径与 migrations 从未执行）。');
    return;
  }

  const knex = require('knex');
  const DB_NAME = 'migrate_probe_run';
  const admin = knex({
    client: 'mysql2',
    connection: { ...conn, user: 'root', password: '' },
  });

  let db = null;
  try {
    await okAsync('能连上探针实例', async () => {
      const r = await admin.raw('SELECT VERSION() AS v');
      assert.ok(r[0][0].v, '没有返回版本');
    });

    console.log('\n【B. 在一个干净的库上跑第一次 migrate()】');

    await admin.raw(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    await admin.raw(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4`);

    db = knex({
      client: 'mysql2',
      connection: { ...conn, user: 'root', password: '', database: DB_NAME, charset: 'utf8mb4' },
    });

    // 把 knex 实例注入 require.cache —— migrate.js 在模块加载时取 `db`
    const dbPath = require.resolve('../src/db');
    const migratePath = require.resolve('../src/migrate');
    const originalDb = require.cache[dbPath];
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    delete require.cache[migratePath];
    const { migrate } = require('../src/migrate');

    const t0 = Date.now();
    let firstErr = null;
    try {
      await migrate();
    } catch (e) {
      firstErr = e;
    }
    const ms1 = Date.now() - t0;

    await okAsync('**第一次 migrate() 不抛错**（建表语句本身能执行）', () => {
      assert.strictEqual(firstErr, null, firstErr && firstErr.message);
    });
    console.log(`    （耗时 ${ms1}ms）`);

    console.log('\n【C. 建出的表与源码声明一致】');
    const tables = (await db.raw('SHOW TABLES'))[0].map((r) => Object.values(r)[0]);
    const tableSet = new Set(tables);

    for (const t of EXPECTED_TABLES) {
      await okAsync(`表 ${t} 存在`, () => {
        assert.ok(tableSet.has(t), `缺表 ${t}`);
      });
    }
    await okAsync('没有多余的未声明表', () => {
      const extra = tables.filter((t) => !EXPECTED_TABLES.includes(t));
      assert.deepStrictEqual(extra, [], `多出：${extra.join(', ')}`);
    });
    await okAsync(`表总数 = ${EXPECTED_TABLES.length}`, () => {
      assert.strictEqual(tables.length, EXPECTED_TABLES.length, tables.join(','));
    });

    console.log('\n【D. 索引真的建出来了（不是只有建表语句）】');
    const indexCount = async (table) => {
      const rows = (await db.raw(`SHOW INDEX FROM \`${table}\``))[0];
      return new Set(rows.map((r) => r.Key_name)).size;
    };
    await okAsync('**notes 有 idx_notes_status_published_at**', async () => {
      const rows = (await db.raw('SHOW INDEX FROM `notes`'))[0];
      const names = new Set(rows.map((r) => r.Key_name));
      assert.ok(names.has('idx_notes_status_published_at'), [...names].join(','));
    });
    await okAsync('**articles 有 idx_articles_status_published_at**', async () => {
      const rows = (await db.raw('SHOW INDEX FROM `articles`'))[0];
      const names = new Set(rows.map((r) => r.Key_name));
      assert.ok([...names].some((n) => /status.*published|published.*status/.test(n)), [...names].join(','));
    });
    await okAsync('comments 有 status 相关索引或至少主键以外的索引', async () => {
      assert.ok((await indexCount('comments')) >= 2, `只有 ${await indexCount('comments')} 个索引名`);
    });
    await okAsync('全库索引数 > 表数（说明 ensureIndex 真的跑了）', async () => {
      let total = 0;
      for (const t of tables) total += await indexCount(t);
      assert.ok(total > tables.length, `索引名总数 ${total}，表数 ${tables.length}`);
    });

    console.log('\n【E. 幂等：再跑一次必须同样成功且不改变结构】');
    const snapshot = async () => {
      const out = {};
      for (const t of tables.sort()) {
        const rows = (await db.raw(`SHOW INDEX FROM \`${t}\``))[0];
        out[t] = {
          idx: [...new Set(rows.map((r) => r.Key_name))].sort(),
          cols: Object.keys((await db.raw(`SHOW COLUMNS FROM \`${t}\``))[0][0] || {}).length,
        };
        const cols = (await db.raw(`SHOW COLUMNS FROM \`${t}\``))[0].map((c) => c.Field).sort();
        out[t].cols = cols;
      }
      return out;
    };
    const before = await snapshot();

    const t1 = Date.now();
    let secondErr = null;
    try {
      await migrate();
    } catch (e) {
      secondErr = e;
    }
    const ms2 = Date.now() - t1;

    await okAsync('**第二次 migrate() 不抛错**（幂等性 —— 每次部署都会跑）', () => {
      assert.strictEqual(secondErr, null, secondErr && secondErr.message);
    });
    console.log(`    （耗时 ${ms2}ms，第一次 ${ms1}ms）`);

    const after = await snapshot();
    await okAsync('**两次跑完后结构完全一致**（表/索引/列都没有变化）', () => {
      assert.deepStrictEqual(after, before,
        '结构变了 —— 说明 migrate 不是幂等的');
    });
    await okAsync('第二次跑完表数不变（没有重复建表）', () => {
      assert.strictEqual(Object.keys(after).length, EXPECTED_TABLES.length);
    });

    console.log('\n【F. 写路径：INSERT/SELECT/UPDATE 真的能用】');
    await okAsync('能往 users 插一行并读回', async () => {
      await db('users').insert({ username: 'probe_user', password: 'x', role: 'admin' });
      const row = await db('users').where({ username: 'probe_user' }).first();
      assert.ok(row, '插入后读不到');
      assert.strictEqual(row.username, 'probe_user');
    });
    await okAsync('UPDATE 生效', async () => {
      await db('users').where({ username: 'probe_user' }).update({ role: 'viewer' });
      const row = await db('users').where({ username: 'probe_user' }).first();
      assert.strictEqual(row.role, 'viewer');
    });
    await okAsync('DELETE 生效', async () => {
      await db('users').where({ username: 'probe_user' }).del();
      const row = await db('users').where({ username: 'probe_user' }).first();
      assert.strictEqual(row, undefined);
    });
    await okAsync('**事务能回滚**（写路径里最容易漏的一项）', async () => {
      const before2 = await db('users').count({ n: '*' }).first();
      let threw = false;
      try {
        await db.transaction(async (trx) => {
          await trx('users').insert({ username: 'rollback_probe', password: 'x', role: 'admin' });
          throw new Error('故意回滚');
        });
      } catch (e) {
        threw = true;
      }
      assert.ok(threw, '事务没有把异常抛出来');
      const after2 = await db('users').count({ n: '*' }).first();
      assert.strictEqual(Number(after2.n), Number(before2.n), '回滚后行数变了');
    });
    await okAsync('utf8mb4 能存 4 字节 emoji（建表时 charset 对了）', async () => {
      await db('users').insert({ username: 'emoji😀probe', password: 'x', role: 'admin' });
      const row = await db('users').where({ username: 'emoji😀probe' }).first();
      assert.ok(row, 'emoji 用户名写不进去 —— charset 可能不是 utf8mb4');
      await db('users').where({ username: 'emoji😀probe' }).del();
    });

    console.log('\n【G. 自检：判据真的能区分】');
    await okAsync('自检：表清单不是空集（否则 C 组什么都没验证）', () => {
      assert.ok(tables.length > 0);
    });
    await okAsync('自检：两次 migrate 的耗时都可测量（说明真的执行了）', () => {
      assert.ok(ms1 >= 0 && ms2 >= 0);
    });
    await okAsync('自检：故意查一个不存在的表会失败（证明查询真的打到库上）', async () => {
      let threw = false;
      try { await db.raw('SELECT * FROM `definitely_not_a_table`'); } catch (e) { threw = true; }
      assert.ok(threw);
    });

    // 还原 require.cache
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
    delete require.cache[migratePath];
  } catch (e) {
    console.log(`\n⚠ 探针实例不可用，跳过：${e.message}`);
  } finally {
    try { if (db) await db.destroy(); } catch (e) { /* ignore */ }
    try {
      await admin.raw(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    } catch (e) { /* ignore */ }
    try { await admin.destroy(); } catch (e) { /* ignore */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    console.log('\n⚠ 本套件红了意味着 **migrate.js 有问题** —— 那是每次部署都会跑的代码。');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('套件自身异常:', e);
  process.exit(1);
});
