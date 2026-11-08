/**
 * 上传路径白名单与目录枚举的单元测试（零 DB、零网络、零服务）。
 *
 * 这组断言锁的是三条互相咬合的契约：
 *   1. `safeUploadRel`（sanitize.js）—— 什么算合法的上传相对路径；
 *   2. `resolveUploadPath` / `listUploadFiles`（utils/uploads.js）—— 同一套规则在
 *      文件系统层必须一致，否则会出现「能设成封面但列表里看不到」「清理扫不到」；
 *   3. `safeCover` —— 封面字段接受 `/uploads/<rel>`，且**不接受** `..` 与三层以上。
 *
 * 背景缺陷：白名单曾只认单段（`^/uploads/[A-Za-z0-9._-]+$`），而 AI 转存图落在
 * `/uploads/ai/<name>` —— 这类图当封面会被静默置空，孤儿清理与列表又都只扫顶层。
 * 同时旧正则能匹配 `/uploads/..`（`[A-Za-z0-9._-]+` 包含点），一旦被删除接口复用
 * 就是路径穿越。下面的用例把这两件事一起钉住。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { safeUploadRel, safeCover } = require('../src/utils/sanitize');
const { resolveUploadPath, listUploadFiles } = require('../src/utils/uploads');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('=== A. safeUploadRel：合法形态 ===');
ok('单段文件名', safeUploadRel('a1b2c3.png') === 'a1b2c3.png');
ok('一层子目录（AI 转存图）', safeUploadRel('ai/x.png') === 'ai/x.png');
ok('剥离前导斜杠', safeUploadRel('/ai/x.png') === 'ai/x.png');
ok('带多点扩展名', safeUploadRel('ai/x.min.webp') === 'ai/x.min.webp');
ok('下划线/连字符开头', safeUploadRel('_tmp/a-b.jpg') === '_tmp/a-b.jpg');

console.log('\n=== B. safeUploadRel：拒绝形态 ===');
ok('空串', safeUploadRel('') === '');
ok('非字符串', safeUploadRel(null) === '' && safeUploadRel(42) === '');
ok('单点段', safeUploadRel('.') === '', safeUploadRel('.'));
ok('双点段（旧正则能通过）', safeUploadRel('..') === '', safeUploadRel('..'));
ok('中间穿越', safeUploadRel('a/../b') === '', safeUploadRel('a/../b'));
ok('三层（当前没有生产者）', safeUploadRel('a/b/c.png') === '');
ok('隐藏文件（以点开头）', safeUploadRel('.env') === '');
ok('反斜杠（Windows 分隔符）', safeUploadRel('ai\\x.png') === '');
ok('空格与百分号', safeUploadRel('a b.png') === '' && safeUploadRel('a%2fb.png') === '');
ok('查询串被拒（含 ?）', safeUploadRel('x.png?v=1') === '');

console.log('\n=== C. safeCover：封面字段的上传白名单 ===');
ok('/logo.png 仍然放行', safeCover('/logo.png') === '/logo.png');
ok('单段上传路径放行', safeCover('/uploads/a.png') === '/uploads/a.png');
ok('ai/ 子目录放行（缺陷修复点）', safeCover('/uploads/ai/a.png') === '/uploads/ai/a.png');
ok('/uploads/.. 被拒（路径穿越）', safeCover('/uploads/..') === '', safeCover('/uploads/..'));
ok('/uploads/a/../b 被拒', safeCover('/uploads/a/../b') === '');
ok('三层被拒', safeCover('/uploads/a/b/c.png') === '');
ok('外链仍走 safeUrl', safeCover('https://example.com/a.png') === 'https://example.com/a.png');

console.log('\n=== D. resolveUploadPath：解析后必须仍在根内 ===');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xalor-uploads-'));
ok('合法相对路径解析成功', resolveUploadPath(root, 'ai/x.png') === path.join(root, 'ai', 'x.png'));
ok('穿越被拒', resolveUploadPath(root, '../etc/passwd') === '');
ok('双点段被拒', resolveUploadPath(root, '..') === '');
ok('空串被拒', resolveUploadPath(root, '') === '');
ok('三层被拒', resolveUploadPath(root, 'a/b/c') === '');

console.log('\n=== E. listUploadFiles：顶层 + 一层子目录 ===');
fs.mkdirSync(path.join(root, 'ai'));
fs.writeFileSync(path.join(root, 'top.png'), 'x');
fs.writeFileSync(path.join(root, 'ai', 'deep.png'), 'y');
fs.mkdirSync(path.join(root, '.git'));
fs.writeFileSync(path.join(root, '.git', 'config'), 'z');
fs.mkdirSync(path.join(root, 'ai', 'nested'));
fs.writeFileSync(path.join(root, 'ai', 'nested', 'too-deep.png'), 'w');

// 顶层也放两个「不合规但真实存在」的文件：点开头 与 含空格
// —— 它们必须与子目录/子文件适用同一套规则（不出现在列表里）
fs.writeFileSync(path.join(root, '.hidden.png'), 'h');
fs.writeFileSync(path.join(root, 'has space.png'), 's');

const listed = listUploadFiles(root).map((f) => f.rel).sort();
ok('列出顶层文件', listed.includes('top.png'));
ok('列出 ai/ 子目录文件', listed.includes('ai/deep.png'));
ok('不列隐藏目录内容', !listed.some((r) => r.startsWith('.git')));
ok('**顶层点开头的文件也不列**（与子目录同一套规则）', !listed.includes('.hidden.png'));
ok('**顶层含空格的文件也不列**', !listed.includes('has space.png'));
ok('合规顶层文件仍然列出（不是把顶层全关掉）', listed.includes('top.png'));
ok('不列三层文件', !listed.some((r) => r.includes('nested')));
ok('每项带 size/mtime', listUploadFiles(root).every((f) => Number.isFinite(f.size) && Number.isFinite(f.mtime)));
ok('目录不存在时返回空数组', listUploadFiles(path.join(root, 'nope')).length === 0);

// 清理临时目录（失败不影响断言结果）
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch (e) { /* 忽略 */ }

console.log(`\nuploads 套件结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
