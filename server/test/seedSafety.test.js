/**
 * `src/seed.js` 的安全性 —— 一个**部署时会跑、而且会写数据**的脚本，此前没有任何测试。
 *
 * 风险不在于「能不能播种」，而在于：
 *   1. **弱密码必须拒跑**（非 test 环境）：`admin123` 这种口令一旦被部署到公网就是后台被接管；
 *   2. **幂等**：每次部署都会跑一次，重复执行不能长出第二个 admin、不能重置已改过的设置；
 *   3. **不破坏既有内容**：播种只补缺，不删用户数据。
 *
 * 需要一个真实 MySQL（探针实例，用完即删）：
 *   npm run probe:mysql                        # 打印 socket
 *   WAF_PROBE_MYSQL_PORT=13399 node test/seedSafety.test.js
 * 没有探针时**显式跳过**并说明原因，不假装跑过。
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const skips = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const SERVER_DIR = path.join(__dirname, '..');
const SEED = path.join(SERVER_DIR, 'src', 'seed.js');
const DB_NAME = 'seed_probe';
const DB_USER = 'seedprobe';
const DB_PASS = 'probe-strong-password-9127';

/** 探针实例的连接方式；没有就跳过 */
function probeConn() {
  if (process.env.WAF_PROBE_MYSQL_PORT) return { port: Number(process.env.WAF_PROBE_MYSQL_PORT) };
  if (process.env.WAF_PROBE_MYSQL_SOCKET) return { socketPath: process.env.WAF_PROBE_MYSQL_SOCKET };
  return null;
}
const conn = probeConn();

if (!conn) {
  console.log('  ⚠ 未提供探针 MySQL（WAF_PROBE_MYSQL_PORT / SOCKET），本套件跳过。');
  console.log('     要实测：npm run probe:mysql 然后 WAF_PROBE_MYSQL_PORT=13399 node test/seedSafety.test.js');
  console.log('seedSafety 套件结果: 0 通过, 0 失败（跳过）');
  process.exit(0);
}

/** root 连探针，建库建号 */
function mysqlRoot(sql) {
  const args = conn.port
    ? ['-h', '127.0.0.1', '-P', String(conn.port), '-u', 'root']
    : ['--socket=' + conn.socketPath, '-u', 'root'];
  // -N -B：只要值，不要表头/对齐 —— 否则 `SELECT COUNT(*)` 会返回 "COUNT(*)\n0"
  const r = spawnSync('mysql', [...args, '-N', '-B', '-e', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`root 执行失败：${(r.stderr || '').trim().slice(0, 200)}`);
  return r.stdout;
}

/** 以播种用的账号跑 seed.js，返回 {status, stdout, stderr} */
function runSeed(extraEnv = {}) {
  const env = {
    ...process.env,
    DB_HOST: '127.0.0.1',
    DB_PORT: String(conn.port || 3306),
    DB_USER,
    DB_PASSWORD: DB_PASS,
    DB_NAME,
    ...extraEnv,
  };
  delete env.WAF_PROBE_MYSQL_SOCKET;
  return spawnSync('node', [SEED], { cwd: SERVER_DIR, env, encoding: 'utf8', timeout: 120000 });
}

(async () => {
  console.log('\n【0. 准备探针库】');
  mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME};
    CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DROP USER IF EXISTS '${DB_USER}'@'localhost';
    CREATE USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
    GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';`);
  // 先建表（seed 不会自己建表，它假定 migrate 已跑过）
  const migrated = spawnSync('node', [path.join(SERVER_DIR, 'src', 'migrate.js')], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DB_HOST: '127.0.0.1',
      DB_PORT: String(conn.port || 3306),
      DB_USER,
      DB_PASSWORD: DB_PASS,
      DB_NAME,
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  ok('探针库建表成功（migrate 跑过）', () => assert.strictEqual(migrated.status, 0, (migrated.stderr || '').slice(0, 200)));

  console.log('\n【A. 弱密码必须拒跑（test 以外的环境都算）】');
  {
    const r = runSeed({ NODE_ENV: 'development', SEED_ADMIN_PASSWORD: 'admin123' });
    ok('退出码非 0', () => assert.notStrictEqual(r.status, 0, `status=${r.status}`));
    ok('报错点名「强 SEED_ADMIN_PASSWORD」', () => assert.ok(/SEED_ADMIN_PASSWORD/.test(r.stderr), (r.stderr || '').slice(0, 160)));
    const admins = mysqlRoot(`SELECT COUNT(*) FROM ${DB_NAME}.users WHERE username='admin'`).trim();
    ok('没有创建 admin 账号', () => assert.strictEqual(Number(admins), 0, `users 里有 ${admins} 个 admin`));
  }

  console.log('\n【B. 强密码可以播种，且口令是哈希】');
  {
    const r = runSeed({ NODE_ENV: 'development', SEED_ADMIN_PASSWORD: 'a-very-long-Seed-Pass-2026' });
    ok('退出码 0', () => assert.strictEqual(r.status, 0, `stderr=${(r.stderr || '').slice(0, 200)}`));
    const hash = mysqlRoot(`SELECT password FROM ${DB_NAME}.users WHERE username='admin'`).trim();
    ok('admin 已创建', () => assert.ok(hash.length > 0));
    ok('存的是哈希而不是明文', () => {
      assert.ok(hash !== 'a-very-long-Seed-Pass-2026', '密码被明文落库');
      assert.ok(hash.length >= 50, `哈希长度 ${hash.length}，看起来不像 bcrypt/scrypt 产物`);
    });
    ok('日志里不回显明文口令', () => {
      const out = (r.stdout || '') + (r.stderr || '');
      assert.ok(!out.includes('a-very-long-Seed-Pass-2026'), '日志泄漏了管理员口令');
    });
  }

  console.log('\n【C. 幂等：再跑一次不长出第二个 admin、不重置改过的设置】');
  {
    // 改一条设置（模拟站长在后台改过），再跑一次 seed
    mysqlRoot(`UPDATE ${DB_NAME}.settings SET value='"我改过的站名"' WHERE \`key\`='site_name' LIMIT 1`);
    const before = mysqlRoot(`SELECT value FROM ${DB_NAME}.settings WHERE \`key\`='site_name' LIMIT 1`).trim();
    const r = runSeed({ NODE_ENV: 'development', SEED_ADMIN_PASSWORD: 'a-very-long-Seed-Pass-2026' });
    ok('第二次退出码 0', () => assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 160)));
    const admins = mysqlRoot(`SELECT COUNT(*) FROM ${DB_NAME}.users WHERE username='admin'`).trim();
    ok('admin 仍然只有 1 个', () => assert.strictEqual(Number(admins), 1, `实际 ${admins}`));
    const after = mysqlRoot(`SELECT value FROM ${DB_NAME}.settings WHERE \`key\`='site_name' LIMIT 1`).trim();
    ok(`已改过的设置不被覆盖（${before}）`, () => assert.strictEqual(after, before, `变成了 ${after}`));
  }

  console.log('\n【D. 不破坏既有内容】');
  {
    mysqlRoot(`INSERT INTO ${DB_NAME}.articles (title, content, status, slug) VALUES ('站长手写', '正文', 'published', 'kept-by-seed-probe')`);
    const before = mysqlRoot(`SELECT COUNT(*) FROM ${DB_NAME}.articles`).trim();
    const r = runSeed({ NODE_ENV: 'development', SEED_ADMIN_PASSWORD: 'a-very-long-Seed-Pass-2026' });
    ok('第三次退出码 0', () => assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 160)));
    const after = mysqlRoot(`SELECT COUNT(*) FROM ${DB_NAME}.articles`).trim();
    ok('文章总数没有减少', () => assert.ok(Number(after) >= Number(before), `before=${before} after=${after}`));
    ok('手写的那篇还在', () => {
      const kept = mysqlRoot(`SELECT COUNT(*) FROM ${DB_NAME}.articles WHERE slug='kept-by-seed-probe'`).trim();
      assert.strictEqual(Number(kept), 1);
    });
  }

  console.log('\n【E. NODE_ENV=test 允许测试口令（这是本地与 CI 的路径）】');
  {
    mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    const m = spawnSync('node', [path.join(SERVER_DIR, 'src', 'migrate.js')], {
      cwd: SERVER_DIR,
      env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(conn.port || 3306), DB_USER, DB_PASSWORD: DB_PASS, DB_NAME },
      encoding: 'utf8', timeout: 120000,
    });
    ok('重建空库并建表', () => assert.strictEqual(m.status, 0));
    const r = runSeed({ NODE_ENV: 'test', SEED_ADMIN_PASSWORD: '' });
    ok('test 环境下无需强口令也能播种', () => assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 200)));
    const admins = mysqlRoot(`SELECT COUNT(*) FROM ${DB_NAME}.users WHERE username='admin'`).trim();
    ok('admin 已创建', () => assert.strictEqual(Number(admins), 1));
  }

  console.log('\n【F. 自检：判据能区分两种口令策略】');
  ok('自检：admin123 属于拒绝集、长口令不属于', () => {
    const weak = /^(?:admin123|12345678|password|password1|passw0rd)$/i;
    assert.ok(weak.test('admin123'));
    assert.ok(!weak.test('a-very-long-Seed-Pass-2026'));
  });

  // 清理：删库删号
  mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; DROP USER IF EXISTS '${DB_USER}'@'localhost';`);

  console.log(`\nseedSafety 套件结果: ${pass} 通过, ${fail} 失败`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常:', e && e.stack || e);
  try { mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; DROP USER IF EXISTS '${DB_USER}'@'localhost';`); } catch (_) { /* ignore */ }
  process.exit(1);
});
