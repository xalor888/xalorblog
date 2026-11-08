/**
 * 上传路径「同一文件只读一次」契约（零 DB、零服务）。
 *
 * 背景：`POST /uploads` 的处理链是 verifyMagic（读全文做 magic bytes / SVG 全文扫描）
 * → stripExif（再读一次同文件）。上限 5MB，等于每次上传最多读 10MB、写 5MB。
 * 而 stripExif 在没有可剥离段时是**原样返回同一个 Buffer 引用**，那次写入也纯属浪费。
 *
 * 三条断言：
 *   A. verifyMagic 把读到的字节挂到 file.rawBytes（供下游复用）；
 *   B. EXIF 剥离优先用 rawBytes，只在缺失时回退读盘（防御分支不能删）；
 *   C. 引用了同一 Buffer 时跳过写盘（stripExif 的契约是「无需改动则返回入参」）。
 *
 * C 依赖 stripExif 的真实行为，所以顺带把它锁在测试里 —— 将来如果有人把 stripExif
 * 改成「总是返回新 Buffer」，这条会红，提醒复核「跳过写盘」的优化是否还成立。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const fs = require('fs');
const path = require('path');
const { stripExif } = require('../src/utils/stripExif');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
const verifyWin = (src.match(/function verifyMagic\(req2, res2, next2\) \{[\s\S]{0,900}?\n  \}/) || [''])[0];
const exifWin = (src.match(/const upExt = path\.extname\(req\.file\.filename\)[\s\S]{0,1100}/) || [''])[0];

console.log('=== A. verifyMagic 缓存已读字节 ===');
ok('找到 verifyMagic 实现', verifyWin.length > 0);
ok('校验后把 buffer 挂到 file.rawBytes', /req2\.file\.rawBytes = buffer;/.test(verifyWin));
ok('没有复用 multer 的 file.buffer（diskStorage 下语义不同，改名会静默绕过校验）',
  !/req2\.file\.buffer =/.test(verifyWin));

console.log('\n=== B. EXIF 剥离复用缓存，保留回退 ===');
ok('找到 EXIF 剥离块', exifWin.length > 0);
ok('优先用 rawBytes', /req\.file\.rawBytes \|\| fs\.readFileSync\(req\.file\.path\)/.test(exifWin));
ok('回退分支仍在（verifyMagic 无 file 时直接 next，需要兜底）',
  /fs\.readFileSync\(req\.file\.path\)/.test(exifWin));

console.log('\n=== C. 内容未变时跳过写盘（依赖 stripExif 的引用语义） ===');
{
  // 真实驱动：非 JPEG → 原样返回同一引用
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  ok('非 JPEG 输入原样返回同一 Buffer 引用（引用相等）', stripExif(png) === png);

  // 最小 JPEG：SOI + APP1(EXIF) + SOS + EOI —— 有可剥离段，必须返回新引用
  const seg = (marker, payload) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
  };
  const withExif = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.from('Exif\0\0GPS', 'binary')),
    seg(0xda, Buffer.from([1, 2, 3])),
    Buffer.from([0xff, 0xd9]),
  ]);
  const stripped = stripExif(withExif);
  ok('含 EXIF 的 JPEG 返回新 Buffer（不是同一引用）', stripped !== withExif);
  ok('剥离后确实变短（APP1 段被丢弃）', stripped.length < withExif.length);
  ok('剥离后仍以 SOI 开头、EOI 结尾',
    stripped[0] === 0xff && stripped[1] === 0xd8
    && stripped[stripped.length - 2] === 0xff && stripped[stripped.length - 1] === 0xd9);

  // 跳过写盘的判据必须与上面两条引用语义一致
  ok('源码用引用比较决定是否写盘（stripped !== raw）',
    /if \(stripped !== raw\) fs\.writeFileSync/.test(exifWin));
}

console.log('\n=== D. 读盘次数：上传区间内至多 2 次（主读 + 回退） ===');
{
  const uploadWin = (src.match(/function verifyMagic[\s\S]{0,2200}/) || [''])[0];
  const reads = (uploadWin.match(/fs\.readFileSync\(/g) || []).length;
  ok(`verifyMagic→EXIF 区间内 readFileSync 出现 ${reads} 次（上限 2：主读 + 回退兜底）`, reads <= 2);
  ok('写入前有 rawBytes 释放（避免 Buffer 跟随请求多活）', /req\.file\.rawBytes = null;/.test(exifWin));
}

console.log(`\nuploadSingleRead 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
