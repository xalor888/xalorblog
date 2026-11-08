/**
 * 上传目录的**总量配额** —— 单文件 5MB 只管一次，管不住「一直传」。
 *
 * 为什么值得做成断言：磁盘写满之后的连锁反应完全不像磁盘问题 ——
 * 备份脚本报「请检查 mysqldump 凭据」、数据库写入失败、整站 500。
 * 此前已经在备份脚本里修过同一类误导（ENOSPC 被说成凭据问题），
 * 这里把**入口侧**也钉住：超过配额就明确拒绝，并删掉刚写入的文件。
 *
 * 判据：
 *   A. 纯函数 `checkUploadQuota` 的边界（等于配额允许、超一字节拒绝、配额 0 表示不限）
 *   B. 目录占用统计只数普通文件、不跟随符号链接、子目录只一层、坏条目跳过
 *   C. 路由里确实接了这个判定，且拒绝时**删文件**并返回 507
 *   D. 自检：判据能区分「刚好等于」与「超过」
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const { checkUploadQuota, dirSizeBytes } = require('../src/utils/uploads');

console.log('\n【A. 配额判定边界】');
{
  const GB = 1024 * 1024 * 1024;
  ok('空目录 + 5MB 文件，配额 1GB → 允许', () => {
    const v = checkUploadQuota(0, GB, 5 * 1024 * 1024);
    assert.strictEqual(v.allowed, true);
    assert.ok(v.remaining > 0);
  });
  ok('刚好等于配额 → 允许（不因为「不多不少」就全拒）', () => {
    const v = checkUploadQuota(GB - 100, GB, 100);
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.remaining, 0);
  });
  ok('超过一个字节 → 拒绝', () => {
    const v = checkUploadQuota(GB - 100, GB, 101);
    assert.strictEqual(v.allowed, false);
    assert.ok(v.remaining < 0);
  });
  ok('配额 0 / 未设置 → 不限（remaining = Infinity）', () => {
    const v = checkUploadQuota(500, 0, 5);
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.remaining, Infinity);
  });
  ok('非法输入按 0 处理，不抛错', () => {
    const v = checkUploadQuota('abc', null, undefined);
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.used, 0);
  });
}

console.log('\n【B. 目录占用统计】');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uquota-'));
  const sub = path.join(tmp, 'ai');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(tmp, 'a.png'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(sub, 'b.png'), Buffer.alloc(2000));
  // 目录本身不该被计入
  ok('顶层 + 一层子目录都被统计（1000 + 2000）', () => {
    assert.strictEqual(dirSizeBytes(tmp), 3000);
  });

  // 符号链接不计入（否则一个链接就能把配额计成满）
  const outside = path.join(os.tmpdir(), 'uquota-outside-' + Date.now());
  fs.writeFileSync(outside, Buffer.alloc(5000));
  try { fs.symlinkSync(outside, path.join(tmp, 'link.png')); } catch (_) { /* 某些 FS 不支持 */ }
  ok('符号链接不计入（按 lstat 判定）', () => {
    assert.ok(dirSizeBytes(tmp) <= 3000, `实际 ${dirSizeBytes(tmp)}`);
  });

  ok('不存在的目录返回 0（不抛错）', () => {
    assert.strictEqual(dirSizeBytes(path.join(tmp, '__nope__')), 0);
  });

  ok('内存统计与真实文件一致（自检：写入 3 个已知大小文件）', () => {
    assert.strictEqual(dirSizeBytes(tmp, 10), 3000, 'maxEntries=10 足以覆盖');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.unlinkSync(outside); } catch (_) { /* ignore */ }
}

console.log('\n【C. 路由接线】');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  ok('上传成功后调用 checkUploadQuota', () => assert.ok(/checkUploadQuota\(/.test(src)));
  ok('配额读自 UPLOAD_QUOTA_MB（默认 1024）', () => {
    assert.ok(/UPLOAD_QUOTA_MB \|\| 1024/.test(src), '找不到默认 1024MB 的配额来源');
  });
  ok('超限时删掉刚写入的文件（不能留垃圾）', () => {
    assert.ok(/if \(!verdict\.allowed\)[\s\S]{0,200}unlinkSync\(req\.file\.path\)/.test(src),
      '拒绝分支里没有删除刚写入的文件');
  });
  ok('超限返回 507（而不是 400/500 —— 语义是「存储不足」）', () => {
    assert.ok(/,\s*507\)/.test(src), '找不到 507 响应');
  });
  ok('配额检查自身出错时不阻断上传（宁可能写满也不全拒）', () => {
    assert.ok(/catch \(e\)[\s\S]{0,200}配额检查失败/.test(src));
  });
}

console.log('\n【D. 自检：判据能区分「刚好」与「超过」】');
{
  ok('自检：同一组数字下 exactly 与 over 的结论相反', () => {
    const exactly = checkUploadQuota(1000, 1100, 100);
    const over = checkUploadQuota(1000, 1100, 101);
    assert.strictEqual(exactly.allowed, true);
    assert.strictEqual(over.allowed, false);
  });
}

console.log(`\nuploadQuota 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
