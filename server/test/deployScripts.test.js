/**
 * 部署脚本的静态检查（零依赖，不执行任何脚本）。
 *
 * 为什么检查这个：`deploy/` 是此前**唯一没覆盖过的目录**，
  *而部署脚本出错的代价最大* —— 备份失败可能几个月都没人发现
  *（唯一的证据是 `backups/` 里少了几份文件，而没人天天去看）。
 *
 * 这里只做**静态**检查：语法、必需的防护、危险的写法。
  *不执行脚本（执行 backup.sh 会真的连数据库）。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { stripCommentLines } = require('./helpers/sourceText');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

const DEPLOY = path.join(__dirname, '..', '..', 'deploy');
const backup = fs.readFileSync(path.join(DEPLOY, 'backup.sh'), 'utf8');
const unit = fs.readFileSync(path.join(DEPLOY, 'xalor-blog.service'), 'utf8');

console.log('=== A. backup.sh 的防护 ===');
ok('有 set -euo pipefail（任一命令失败就停）', /set -euo pipefail/.test(backup));
ok('设了 umask 077（备份文件默认仅属主可读）', /umask 077/.test(backup));
ok('密码走 MYSQL_PWD 而不是命令行参数',
  /export MYSQL_PWD=/.test(backup) && !/-p"?\$DB_PASS/.test(backup),
  '命令行传密码会出现在 ps 与 shell history 里');
ok('备份失败时会删掉半截文件', /rm -f "\$DB_BACKUP"/.test(backup));
ok('没用 source 读 .env（会执行文件里的任意 shell 代码）',
  !/^\s*source\s/.test(backup) && !/^\s*\.\s+\S*\.env/.test(backup));

console.log('\n=== B. backup.sh 能读 server/.env ===');
{
  ok('定义了 read_env_key', /read_env_key\(\)/.test(backup));
  ok('DB_USER 会从 .env 回退读取',
    /DB_USER="\$\{DB_USER:-\$\(read_env_key DB_USER/.test(backup));
  ok('DB_PASS 从 DB_PASSWORD 读（.env 叫 DB_PASSWORD，脚本叫 DB_PASS —— 别搞混）',
    /DB_PASS="\$\{DB_PASS:-\$\(read_env_key DB_PASSWORD/.test(backup));
  ok('read_env_key 会剥成对引号', /sed 's\/\^\["'"'"'\]\/\//.test(backup) || /s\/\["'"'"'\]\$\/\//.test(backup));
  ok('非 localhost 的 DB_HOST 会传 -h（否则 mysqldump 连本地 socket）',
    /DB_HOST_ARG=\(-h/.test(backup) && /"\$\{DB_HOST_ARG\[@\]\}"/.test(backup));
}

console.log('\n=== C. systemd unit 的加固项 ===');
{
  const must = [
    ['NODE_ENV=production', /NODE_ENV=production/],
    ['LISTEN_HOST=127.0.0.1（只监听本机）', /LISTEN_HOST=127\.0\.0\.1/],
    ['TRUST_PROXY=loopback（只信同机 nginx）', /TRUST_PROXY=loopback/],
    ['Non-root 用户', /^User=www-data$/m],
    ['ProtectSystem=strict', /^ProtectSystem=strict$/m],
    ['空 CapabilityBoundingSet', /^CapabilityBoundingSet=$/m],
    ['NoNewPrivileges', /^NoNewPrivileges=true$/m],
    ['RestrictAddressFamilies', /RestrictAddressFamilies=/],
    ['Restart=always', /^Restart=always$/m],
  ];
  for (const [name, re] of must) ok(name, re.test(unit));
  ok('禁止 TRUST_PROXY=1/true 写在注释里（避免有人图省事改掉）',
    /禁止 TRUST_PROXY=1\/true/.test(unit));
  // ReadWritePaths 必须存在且只覆盖 uploads —— ProtectSystem=strict 下其余全只读
  const rw = (unit.match(/^ReadWritePaths=(.+)$/m) || [])[1] || '';
  ok('ReadWritePaths 存在', rw.length > 0);
  ok('ReadWritePaths 只授权 uploads（多授权会削弱 ProtectSystem=strict）',
    rw.trim().endsWith('/uploads') && rw.split(':').length === 1, rw);
}

console.log('\n=== D. bash 语法真的能过 ===');
{
  let syntaxOk = true, msg = '';
  try {
    execFileSync('bash', ['-n', path.join(DEPLOY, 'backup.sh')], { stdio: 'pipe' });
  } catch (e) {
    syntaxOk = false;
    msg = String(e.stderr || e.message).slice(0, 120);
  }
  ok('backup.sh 通过 bash -n', syntaxOk, msg);
}

console.log('\n=== E. 自检：判据能区分好坏写法 ===');
{
  const bad = 'set -e\nmysqldump -u root -pPa55w0rd db > out.sql\nsource .env\n';
  ok('自检：命令行传密码会被判为危险', /-p"?\$DB_PASS/.test(bad) === false && /-p[A-Za-z0-9]/.test(bad));
  ok('自检：缺 pipefail 能被识别', !/set -euo pipefail/.test(bad));
  ok('自检：source .env 能被识别', /^\s*source\s/m.test(bad));
  ok('自检：正规写法不会被误判为 source',
    !/^\s*source\s/m.test(stripCommentLines(backup)));
}

console.log(`\ndeployScripts 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
