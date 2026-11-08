/**
 * `deploy/backup.sh` 的失败路径 —— **行为测试，不是代码审查**。
 *
 * 为什么要测这个：备份脚本最危险的时刻不是「跑成功」，而是「跑失败」。
 * 上一版遇到底层报错只打印「请检查 mysqldump 凭据」并 `rm` 掉半截文件 ——
 * 消息把**磁盘满**（ENOSPC）说成了凭据问题，运维会去翻 .env，而真正该做的是清盘。
 *
 * 本文件用假 mysqldump 复现三种失败，逐条断言：
 *   A. ENOSPC → 明确说是磁盘空间不足，且**不留半截文件**
 *   B. 凭据错误 → 说出凭据，并把 mysqldump 的原始 stderr 附上
 *   C. 成功 → 生成 .sql 与 env 备份，退出码 0
 *   D. 静态：写盘之前的空间预检存在（100MB 下限）
 *
 * 全部在临时目录里跑，不碰真实备份目录、不打包真实 uploads（SKIP_UPLOADS=1）。
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'deploy', 'backup.sh');

/** 造一个假 mysqldump：按 mode 决定成功/失败与 stderr 内容 */
function makeFakeDump(dir, mode) {
  const file = path.join(dir, 'mysqldump');
  const body = mode === 'ok'
    ? '#!/usr/bin/env bash\nprintf -- "-- fake dump\\n"\nexit 0\n'
    : mode === 'enospc'
      ? '#!/usr/bin/env bash\nprintf -- "-- partial\\n"\necho "mysqldump: Got error: 3: No space left on device" >&2\nexit 2\n'
      : '#!/usr/bin/env bash\nprintf -- "-- partial\\n"\necho "mysqldump: Got error: 1045: Access denied for user" >&2\nexit 2\n';
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function runBackup(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-' + mode + '-'));
  const dump = makeFakeDump(tmp, mode);
  const backups = path.join(tmp, 'backups');
  const r = spawnSync('bash', [SCRIPT, backups], {
    env: {
      ...process.env,
      MYSQLDUMP: dump,
      DB_USER: 'testuser',
      DB_NAME: 'testdb',
      DB_PASS: '',
      SKIP_UPLOADS: '1',
    },
    encoding: 'utf8',
  });
  const files = fs.existsSync(backups) ? fs.readdirSync(backups) : [];
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '', files, dir: tmp };
}

const enospc = runBackup('enospc');
const denied = runBackup('denied');
const good = runBackup('ok');

console.log('\n【A. 磁盘满（ENOSPC）】');
ok('退出码非 0', () => assert.notStrictEqual(enospc.status, 0, `status=${enospc.status}`));
ok('报错明确指向磁盘空间（不是凭据）', () => {
  assert.ok(/磁盘空间不足|ENOSPC/.test(enospc.stderr), `stderr=${enospc.stderr.trim().slice(0, 200)}`);
  assert.ok(!/凭据/.test(enospc.stderr), '仍在说凭据 —— 会把运维引向错误方向');
});
ok('不留半截 .sql 文件（那会被误当成可用备份）', () => {
  const sql = enospc.files.filter((f) => f.endsWith('.sql'));
  assert.deepStrictEqual(sql, [], `残留：${sql.join(', ')}`);
});

console.log('\n【B. 凭据错误】');
ok('退出码非 0', () => assert.notStrictEqual(denied.status, 0));
ok('报错指向凭据，并附带 mysqldump 原始输出', () => {
  assert.ok(/凭据/.test(denied.stderr), `stderr=${denied.stderr.trim().slice(0, 200)}`);
  assert.ok(/Access denied/.test(denied.stderr), '原始 stderr 没有被附上 —— 排障时看不到真正原因');
});
ok('同样不留半截 .sql', () => {
  assert.deepStrictEqual(denied.files.filter((f) => f.endsWith('.sql')), []);
});

console.log('\n【C. 成功路径】');
ok('退出码 0', () => assert.strictEqual(good.status, 0, `status=${good.status} stderr=${good.stderr.trim().slice(0, 120)}`));
ok('生成了 .sql 备份', () => {
  const sql = good.files.filter((f) => f.endsWith('.sql'));
  assert.ok(sql.length >= 1, `备份目录里没有 .sql：${good.files.join(', ')}`);
});
ok('生成了 env 备份（.env.example 的副本）', () => {
  assert.ok(good.files.some((f) => f.startsWith('env_example_')), good.files.join(', '));
});
ok('SKIP_UPLOADS=1 时跳过 uploads 打包', () => {
  assert.ok(!good.files.some((f) => f.includes('uploads')), `不该有 uploads：${good.files.join(', ')}`);
});

console.log('\n【D. 写盘之前的空间预检】');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok('存在剩余空间下限（100MB）', () => {
    assert.ok(/FREE_KB/.test(src) && /102400/.test(src),
      '找不到 100MB 预检 —— 磁盘快满时会先写出一堆半截文件再失败');
  });
  ok('预检发生在 mysqldump 之前', () => {
    const pre = src.indexOf('FREE_KB=');
    const dump = src.indexOf('"$MYSQLDUMP" -u');
    assert.ok(pre > 0 && dump > pre, '顺序不对：预检应在备份命令之前');
  });
  ok('**带 --skip-lock-tables**（生产账号没有 FLUSH_TABLES，缺它备份 100% 失败）', () => {
    assert.ok(/--skip-lock-tables/.test(src),
      '缺少 --skip-lock-tables：mysqldump 默认要 FLUSH TABLES，最小权限账号会 Access denied');
  });
  ok('带 --set-gtid-purged=OFF（避免需要 SUPER/GTID 权限）', () => {
    assert.ok(/--set-gtid-purged=OFF/.test(src));
  });
  ok('空数组展开用可移植写法（`set -u` + bash 3.2 会因空数组报 unbound）', () => {
    assert.ok(/\$\{DB_HOST_ARG\[@\]\+/.test(src),
      '仍是裸的 "${DB_HOST_ARG[@]}" —— 在 macOS 自带 bash 3.2 上会直接报 unbound variable');
  });
}

console.log('\n【E. 自检：判据能区分两种失败】');
ok('自检：ENOSPC 文本能被识别', () => {
  const text = 'mysqldump: Got error: 3: No space left on device';
  assert.ok(/no space left on device|ENOSPC/i.test(text));
});
ok('自检：凭据错误不会被误判成 ENOSPC', () => {
  const text = 'mysqldump: Got error: 1045: Access denied for user';
  assert.ok(!/no space left on device|ENOSPC/i.test(text));
});

// 清理临时目录
for (const r of [enospc, denied, good]) {
  try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

console.log(`\nbackupFailure 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
