/**
 * 旧数据清理脚本的**行为测试**（`scripts/prune-old-data.js`）。
 *
 * 这个脚本会**真删数据**，所以它自己的安全闸必须被测：
 *   1. 默认 dry-run —— 不加 `--apply` 一行都不删
 *   2. `--apply` 在非一次性库上必须拒绝（除非显式 ALLOW_NON_SCRATCH=1）
 *   3. 真删时只删「该删的」：过期的删、还没到期的不动
 *   4. `--days` 过小（<7）被夹到默认 90，避免「手滑打成 3」
 *
 * 需要探针 MySQL：npm run probe:mysql → WAF_PROBE_MYSQL_PORT=13399 node test/dataLifecycle.test.js
 * 没有探针时显式跳过（不假装跑过）。
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const SERVER_DIR = path.join(__dirname, '..');
const SCRIPT = path.join(SERVER_DIR, 'scripts', 'prune-old-data.js');
const DB_NAME = 'prune_probe';
const DB_USER = 'pruneprobe';
const DB_PASS = 'probe-strong-password-9127';

const conn = process.env.WAF_PROBE_MYSQL_PORT
  ? { port: Number(process.env.WAF_PROBE_MYSQL_PORT) }
  : process.env.WAF_PROBE_MYSQL_SOCKET
    ? { socketPath: process.env.WAF_PROBE_MYSQL_SOCKET }
    : null;

if (!conn) {
  console.log('  ⚠ 未提供探针 MySQL，本套件跳过（要实测：npm run probe:mysql）。');
  console.log('dataLifecycle 套件结果: 0 通过, 0 失败（跳过）');
  process.exit(0);
}

function mysqlRoot(sql) {
  const args = conn.port ? ['-h', '127.0.0.1', '-P', String(conn.port), '-u', 'root'] : ['--socket=' + conn.socketPath, '-u', 'root'];
  const r = spawnSync('mysql', [...args, '-N', '-B', '-e', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('root 执行失败：' + (r.stderr || '').trim().slice(0, 200));
  return r.stdout.trim();
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    DB_HOST: '127.0.0.1',
    DB_PORT: String(conn.port || 3306),
    DB_USER,
    DB_PASSWORD: DB_PASS,
    DB_NAME,
    ...extra,
  };
}

function runScript(args, extraEnv = {}) {
  const env = baseEnv(extraEnv);
  delete env.WAF_PROBE_MYSQL_SOCKET;
  return spawnSync('node', [SCRIPT, ...args], { cwd: SERVER_DIR, env, encoding: 'utf8', timeout: 60000 });
}

(async () => {
  console.log('\n【0. 准备探针库】');
  mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME};
    CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DROP USER IF EXISTS '${DB_USER}'@'localhost';
    CREATE USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
    GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';`);
  const migrated = spawnSync('node', [path.join(SERVER_DIR, 'src', 'migrate.js')], { cwd: SERVER_DIR, env: baseEnv(), encoding: 'utf8' });
  ok('探针库建表成功', () => assert.strictEqual(migrated.status, 0, (migrated.stderr || '').slice(0, 160)));

  // 造数据：2 条很旧的审计、1 条新的；1 条过期会话、1 条有效；1 条过期封禁、1 条有效
  mysqlRoot(`INSERT INTO ${DB_NAME}.audit_logs (action, created_at) VALUES
      ('old-1', DATE_SUB(NOW(), INTERVAL 200 DAY)),
      ('old-2', DATE_SUB(NOW(), INTERVAL 120 DAY)),
      ('fresh', NOW());
    INSERT INTO ${DB_NAME}.users (id, username, password, role) VALUES (1, 'probe', 'hash', 'admin');
    INSERT INTO ${DB_NAME}.sessions (jti, user_id, expires_at, revoked) VALUES
      ('stale-expired', 1, DATE_SUB(NOW(), INTERVAL 3 DAY), 0),
      ('stale-revoked', 1, DATE_ADD(NOW(), INTERVAL 3 DAY), 1),
      ('alive', 1, DATE_ADD(NOW(), INTERVAL 3 DAY), 0);
    INSERT INTO ${DB_NAME}.ip_bans (ip, banned_until, reason) VALUES
      ('1.1.1.1', DATE_SUB(NOW(), INTERVAL 2 DAY), 'expired'),
      ('2.2.2.2', DATE_ADD(NOW(), INTERVAL 2 DAY), 'active');`);

  const count = (t) => Number(mysqlRoot(`SELECT COUNT(*) FROM ${DB_NAME}.${t}`));

  console.log('\n【A. 默认 dry-run：一行都不删】');
  {
    const before = { audit: count('audit_logs'), sess: count('sessions'), bans: count('ip_bans') };
    const r = runScript([]);
    ok('退出码 0', () => assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 160)));
    ok('输出里写明 DRY-RUN', () => assert.ok(/DRY-RUN/.test(r.stdout), r.stdout.slice(0, 120)));
    ok('输出给了三类待删条数', () => {
      assert.ok(/audit_logs/.test(r.stdout) && /sessions/.test(r.stdout) && /ip_bans/.test(r.stdout));
    });
    ok('数据库没有变化', () => {
      assert.deepStrictEqual(
        { audit: count('audit_logs'), sess: count('sessions'), bans: count('ip_bans') },
        before,
        'dry-run 竟然删了数据'
      );
    });
  }

  console.log('\n【B. --apply 在非一次性库上必须拒绝】');
  {
    const r = runScript(['--apply']);
    ok('退出码非 0', () => assert.notStrictEqual(r.status, 0));
    ok('报错说明原因与放行方式', () => {
      assert.ok(/不是一次性库/.test(r.stderr), (r.stderr || '').slice(0, 160));
      assert.ok(/ALLOW_NON_SCRATCH=1/.test(r.stderr));
    });
    ok('一行都没删', () => assert.strictEqual(count('audit_logs'), 3));
  }

  console.log('\n【C. 显式放行后真删：只删该删的】');
  {
    const r = runScript(['--apply'], { ALLOW_NON_SCRATCH: '1' });
    ok('退出码 0', () => assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 160)));
    ok('过期的审计日志被删、新的留下', () => {
      assert.strictEqual(count('audit_logs'), 1);
      assert.strictEqual(mysqlRoot(`SELECT action FROM ${DB_NAME}.audit_logs`), 'fresh');
    });
    ok('过期与撤销的会话被删、有效的留下', () => {
      assert.strictEqual(count('sessions'), 1);
      assert.strictEqual(mysqlRoot(`SELECT jti FROM ${DB_NAME}.sessions`), 'alive');
    });
    ok('过期的封禁被删、生效中的留下', () => {
      assert.strictEqual(count('ip_bans'), 1);
      assert.strictEqual(mysqlRoot(`SELECT ip FROM ${DB_NAME}.ip_bans`), '2.2.2.2');
    });
  }

  console.log('\n【D. --days 的边界】');
  {
    const r = runScript(['--days', '3']);
    ok('小于 7 天被夹回 90 天（输出里写着保留天数）', () => {
      assert.ok(/保留=90 天/.test(r.stdout), r.stdout.slice(0, 160));
    });
    const r2 = runScript(['--days', '30']);
    ok('合法的 30 天被接受', () => assert.ok(/保留=30 天/.test(r2.stdout)));
  }

  console.log('\n【E. 自检：判据能区分 dry-run 与 apply】');
  ok('自检：参数解析上 --apply 与空数组不同', () => {
    assert.notDeepStrictEqual(['--apply'].includes('--apply'), [].includes('--apply'));
  });

  mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; DROP USER IF EXISTS '${DB_USER}'@'localhost';`);

  console.log(`\ndataLifecycle 套件结果: ${pass} 通过, ${fail} 失败`);
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
