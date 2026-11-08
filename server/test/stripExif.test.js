/**
 * JPEG EXIF 剥离的离线测试。
 *
 * 这是**上传隐私保护**的一环：相机/手机照片携带 GPS 坐标、设备型号、拍摄时间，
 * 直接上传会泄露拍摄位置。所以它的正确性有两面：
 *   - **必须剥掉 APP1(FFE1)** —— 隐私承诺
 *   - **必须保留其余一切** —— 保留 APP2(FFE1 之外的段，含 ICC 色彩管理）与
 *     熵编码图像数据。剥过头 → 图片花掉/打不开；剥不足 → 位置泄露
 *
 * 之前只有 2 条断言（`sanitize.test.js`）：剥掉 APP1、保留 SOI。
 * 对一个**二进制解析器**来说，2 条断言几乎等于没测 ——
 * 段长算错一位、越界判断差一个字节、SOS 之后的拷贝边界错 1 字节，
 * 结果都可能是「图片打不开」或「EXIF 没剥干净」，而这两条断言都照样通过。
 *
 * 全部用**手工构造的 Buffer**（不依赖任何图片库或真实样本文件），
 * 夹具的段结构在注释里写明，便于核对。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { stripExif } = require('../src/utils/stripExif');

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

/* ---------- 构造 JPEG 段的辅助函数 ---------- */

/** 数据段：FFxx + 2 字节长度(含长度自身) + payload */
function segment(marker, payload) {
  const len = payload.length + 2;
  const head = Buffer.from([0xff, marker, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, payload]);
}

/** 独立标记：只有 FFxx 两字节，无长度字段 */
function standalone(marker) {
  return Buffer.from([0xff, marker]);
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const APP1 = (payload) => segment(0xe1, payload);
const APP2 = (payload) => segment(0xe2, payload);
const APP0 = (payload) => segment(0xe0, payload);
const COM = (payload) => segment(0xfe, payload);
const SOS = (payload) => segment(0xda, payload);

/** 标准头 + APP1(EXIF) + APP2(ICC) + SOS + 图像数据 + EOI */
function buildJpeg({ exif = 'Exif', icc = 'ICC', sos = 'SOS', image = 'IMGDATA', eoi = true } = {}) {
  // 顺序符合真实 JPEG：SOI → APP0(JFIF) → APP1(EXIF) → APP2(ICC) → SOS → 数据 → EOI
  //
  // ⚠ 第一版的夹具**漏了 APP0 和 COM**，但断言却要求它们被保留 ——
  // 那是夹具错，不是实现错（实现当然保留不了不存在的东西）。
  const parts = [
    SOI,
    APP0(Buffer.from('JFIF', 'ascii')),
    APP1(Buffer.from(exif, 'ascii')),
    APP2(Buffer.from(icc, 'ascii')),
    COM(Buffer.from('note', 'ascii')),
  ];
  if (sos !== null) parts.push(SOS(Buffer.from(sos, 'ascii')));
  if (image !== null) parts.push(Buffer.from(image, 'ascii'));
  if (eoi) parts.push(EOI);
  return Buffer.concat(parts);
}

console.log('\n【A. 基本剥离行为】');
{
  ok('APP1 被剥掉', () => {
    const src = buildJpeg();
    const out = stripExif(src);
    assert.ok(!out.includes(Buffer.from([0xff, 0xe1])), '仍含 APP1 标记');
  });
  ok('APP2(ICC) 被保留', () => {
    const out = stripExif(buildJpeg());
    assert.ok(out.includes(Buffer.from([0xff, 0xe2])), 'ICC 段被误删');
    assert.ok(out.includes(Buffer.from('ICC', 'ascii')), 'ICC 内容丢失');
  });
  ok('APP0(JFIF) 被保留', () => {
    const out = stripExif(buildJpeg());
    assert.ok(out.includes(Buffer.from([0xff, 0xe0])));
  });
  ok('COM 注释段被保留', () => {
    const out = stripExif(buildJpeg());
    assert.ok(out.includes(Buffer.from([0xff, 0xfe])));
  });
  ok('SOI 保留在开头', () => {
    const out = stripExif(buildJpeg());
    assert.strictEqual(out[0], 0xff);
    assert.strictEqual(out[1], 0xd8);
  });
  ok('EOI 保留在结尾', () => {
    const out = stripExif(buildJpeg());
    assert.strictEqual(out[out.length - 2], 0xff);
    assert.strictEqual(out[out.length - 1], 0xd9);
  });
  ok('熵编码图像数据逐字节保留', () => {
    const out = stripExif(buildJpeg({ image: 'ABCDEFGH' }));
    assert.ok(out.includes(Buffer.from('ABCDEFGH', 'ascii')), '图像数据不完整');
  });
  ok('剥离后长度恰好减少 APP1 段的长度', () => {
    const src = buildJpeg();
    const out = stripExif(src);
    // APP1 = FF E1 + 2 字节长度 + 4 字节 "Exif" = 8 字节
    //
    // ⚠ 第一版这里断言少 8 字节却拿到 7 —— 是我**算错了 APP2 的长度**：
    // ICC 是 3 个字母不是 4，APP2 段 = 2+2+3 = 7 字节。
    // 而 APP1 = 2+2+4 = 8 字节是对的，所以「少 8」本该成立；
    // 实际少 7 说明夹具里的 exif payload 不是 4 字节 —— 那时 buildJpeg
    // 用的是 `Buffer.from(exif,'ascii')` 而 exif 默认 'Exif' 正是 4 字节……
    // 真正的差别在于：第一版夹具**没有 APP0/COM**，长度基线算错了。
    // 现在按「输出与输入差恰好一个 APP1 段」来断言，与夹具内容解耦。
    const app1Len = APP1(Buffer.from('Exif', 'ascii')).length;
    assert.strictEqual(app1Len, 8, 'APP1 段长度应为 8');
    assert.strictEqual(src.length - out.length, app1Len,
      `实际少了 ${src.length - out.length} 字节，应为 ${app1Len}`);
  });
  ok('多次调用结果幂等（已剥离的文件再剥一次不变）', () => {
    const once = stripExif(buildJpeg());
    const twice = stripExif(once);
    assert.ok(once.equals(twice), '二次剥离改变了内容');
  });
}

console.log('\n【B. 保留的段一个都不能少】');
{
  ok('APP0 + APP1 + APP2 + COM 同时存在时，只删 APP1', () => {
    const src = Buffer.concat([
      SOI,
      APP0(Buffer.from('JFIF', 'ascii')),
      APP1(Buffer.from('Exif', 'ascii')),
      APP2(Buffer.from('ICC', 'ascii')),
      COM(Buffer.from('note', 'ascii')),
      SOS(Buffer.from('S', 'ascii')),
      Buffer.from('PIXELS', 'ascii'),
      EOI,
    ]);
    const out = stripExif(src);
    assert.ok(!out.includes(Buffer.from([0xff, 0xe1])), 'APP1 未剥');
    for (const [m, name] of [[0xe0, 'APP0'], [0xe2, 'APP2'], [0xfe, 'COM']]) {
      assert.ok(out.includes(Buffer.from([0xff, m])), `${name} 被误删`);
    }
    assert.ok(out.includes(Buffer.from('JFIF', 'ascii')));
    assert.ok(out.includes(Buffer.from('ICC', 'ascii')));
    assert.ok(out.includes(Buffer.from('note', 'ascii')));
    assert.ok(out.includes(Buffer.from('PIXELS', 'ascii')));
  });
  ok('多个 APP1 全部被剥掉', () => {
    const src = Buffer.concat([
      SOI,
      APP1(Buffer.from('EXIF1', 'ascii')),
      APP1(Buffer.from('EXIF2', 'ascii')),
      SOS(Buffer.from('S', 'ascii')),
      Buffer.from('P', 'ascii'),
      EOI,
    ]);
    const out = stripExif(src);
    assert.ok(!out.includes(Buffer.from('EXIF1', 'ascii')));
    assert.ok(!out.includes(Buffer.from('EXIF2', 'ascii')));
  });
}

console.log('\n【C. 非 JPEG / 非法输入 → 保守回退原文件】');
{
  const cases = [
    ['空 Buffer', Buffer.alloc(0)],
    ['null', null],
    ['undefined', undefined],
    ['单字节', Buffer.from([0xff])],
    ['非 SOI 开头（PNG 头）', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['GIF 头', Buffer.from('GIF89a', 'ascii')],
    ['长度为 4 但不是 SOI', Buffer.from([0xff, 0x00, 0x00, 0x00])],
  ];
  for (const [name, buf] of cases) {
    ok(`${name} → 原样返回（不抛）`, () => {
      let out;
      assert.doesNotThrow(() => { out = stripExif(buf); }, `${name} 抛了`);
      if (buf && buf.length) {
        assert.ok(out.equals(buf), `${name} 未原样返回`);
      }
    });
  }
  ok('非字符串/非 Buffer 输入不抛', () => {
    assert.doesNotThrow(() => stripExif('not a buffer'));
    assert.doesNotThrow(() => stripExif(12345));
    assert.doesNotThrow(() => stripExif([]));
  });
}

console.log('\n【D. 结构异常 → 保守回退（不得静默产出损坏文件）】');
{
  ok('段长度越界（声明 100 但文件不够）→ 原样返回', () => {
    const bad = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x64]), Buffer.from('short')]);
    const out = stripExif(bad);
    assert.ok(out.equals(bad), '未原样返回');
  });
  ok('段长度 < 2（非法）→ 原样返回', () => {
    const bad = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x00]), EOI]);
    const out = stripExif(bad);
    assert.ok(out.equals(bad), '未原样返回');
  });
  ok('段结构非法（FF 后面不是标记）→ 原样返回', () => {
    const bad = Buffer.concat([SOI, Buffer.from([0x12, 0x34]), EOI]);
    const out = stripExif(bad);
    assert.ok(out.equals(bad), '未原样返回');
  });
  ok('文件被截断（尾部无 EOI/SOS）→ 原样返回', () => {
    const bad = Buffer.concat([SOI, APP1(Buffer.from('Exif', 'ascii'))]);
    const out = stripExif(bad);
    assert.ok(out.equals(bad), '截断文件未原样返回');
  });
  ok('截断时**不剥离**（保守：宁可留 EXIF 也不给损坏文件）', () => {
    const bad = Buffer.concat([SOI, APP1(Buffer.from('Exif', 'ascii'))]);
    const out = stripExif(bad);
    assert.ok(out.includes(Buffer.from('Exif', 'ascii')), '截断文件被部分剥离了');
  });
}

console.log('\n【D2. 五条被变异测试暴露、但当时没有断言钉住的不变量】');
{
  // 这五条当前行为都是对的，但**没有任何断言固定住它们** ——
  // 改坏了也不会红。逐条钉死。
  ok('段长度 = 1（非法，小于 2）→ 原样返回', () => {
    const bad = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x01]), Buffer.from('XY'), EOI]);
    assert.ok(stripExif(bad).equals(bad), '未原样返回');
  });
  ok('段长度 = 0（非法）→ 原样返回', () => {
    const bad = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x00]), EOI]);
    assert.ok(stripExif(bad).equals(bad), '未原样返回');
  });
  ok('段声明长度超出文件末尾（越界）→ 原样返回', () => {
    const bad = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x64]), Buffer.from('short'), EOI]);
    assert.ok(stripExif(bad).equals(bad), '未原样返回');
  });
  ok('段头只有 3 字节（长度字段不完整）→ 原样返回', () => {
    const bad = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00])]);
    assert.ok(stripExif(bad).equals(bad), '未原样返回');
  });
  ok('**长度恰好为 2 的 SOI（2 字节）→ 原样返回**', () => {
    // 输入下限是 4 字节。放宽到 2 会让 2 字节的 FF D8 进入解析循环 ——
    // 循环条件 i + 1 < buf.length 不成立 → 落到末尾的「未正常走到 EOI/SOS → 保守回退」，
    // 结果**恰好也相同**。但这是巧合：放宽下限后走的是完全不同的代码路径。
    const bad = Buffer.from([0xff, 0xd8]);
    assert.ok(stripExif(bad).equals(bad), '未原样返回');
  });
  ok('**非法段结构（FF 后面不是标记）→ 原样返回**', () => {
    // 这条最关键：不检查的话，后续字节会被当成段头解析，
    // 可能产出「结构错乱但能打开」的 JPEG —— 用户看不出问题，但文件已损坏。
    const bad = Buffer.concat([SOI, Buffer.from([0x12, 0x34]), EOI]);
    assert.ok(stripExif(bad).equals(bad), '未原样返回');
  });
  ok('非法段结构在**中间**出现也是原样返回（不是只剥前面的）', () => {
    const bad = Buffer.concat([
      SOI, APP1(Buffer.from('Exif', 'ascii')),
      Buffer.from([0x12, 0x34]),   // 非法
      SOS(Buffer.from('S', 'ascii')), Buffer.from('P', 'ascii'), EOI,
    ]);
    assert.ok(stripExif(bad).equals(bad), '未原样返回（说明被部分剥离了）');
    assert.ok(stripExif(bad).includes(Buffer.from('Exif', 'ascii')), 'EXIF 不该被剥掉');
  });
}

console.log('\n【E. FF00 填充字节：跳过而不是整份回退】');
{
  // 源码注释记着这个坑：只 i += 1 的话下一轮落在 0x00 上，
  // 命中「buf[i] !== 0xff → 保守回退」，整份文件原样返回 ——
  // **EXIF 原样保留，而调用方拿到的仍是「已剥离」的成功结果，剥离功能静默失效。**
  ok('段间 FF00 被跳过，剥离仍然生效', () => {
    const src = Buffer.concat([
      SOI,
      Buffer.from([0xff, 0x00]),        // 填充
      APP1(Buffer.from('Exif', 'ascii')),
      APP2(Buffer.from('ICC', 'ascii')),
      SOS(Buffer.from('S', 'ascii')),
      Buffer.from('P', 'ascii'),
      EOI,
    ]);
    const out = stripExif(src);
    assert.ok(!out.includes(Buffer.from('Exif', 'ascii')), 'FF00 导致整份回退，EXIF 未剥离');
    assert.ok(out.includes(Buffer.from('ICC', 'ascii')), 'ICC 丢失');
  });
  ok('多个 FF00 填充都跳过', () => {
    const src = Buffer.concat([
      SOI,
      Buffer.from([0xff, 0x00, 0xff, 0x00]),
      APP1(Buffer.from('Exif', 'ascii')),
      SOS(Buffer.from('S', 'ascii')),
      Buffer.from('P', 'ascii'),
      EOI,
    ]);
    const out = stripExif(src);
    assert.ok(!out.includes(Buffer.from('Exif', 'ascii')), 'EXIF 未剥离');
  });
}

console.log('\n【F. 独立标记（无长度字段）】');
{
  ok('FFD0-DFF7（RSTn）被原样保留', () => {
    const src = Buffer.concat([
      SOI, APP1(Buffer.from('Exif', 'ascii')),
      standalone(0xd0), standalone(0xd1),
      SOS(Buffer.from('S', 'ascii')), Buffer.from('P', 'ascii'), EOI,
    ]);
    const out = stripExif(src);
    assert.ok(out.includes(Buffer.from([0xff, 0xd0])));
    assert.ok(out.includes(Buffer.from([0xff, 0xd1])));
  });
  ok('FF01（TEM 标记）被原样保留', () => {
    const src = Buffer.concat([
      SOI, APP1(Buffer.from('Exif', 'ascii')),
      standalone(0x01),
      SOS(Buffer.from('S', 'ascii')), Buffer.from('P', 'ascii'), EOI,
    ]);
    const out = stripExif(src);
    assert.ok(out.includes(Buffer.from([0xff, 0x01])));
  });
  ok('独立标记没有长度字段（后面紧跟下一段仍能正确解析）', () => {
    const src = Buffer.concat([
      SOI, standalone(0x01),
      APP1(Buffer.from('Exif', 'ascii')),
      SOS(Buffer.from('S', 'ascii')), Buffer.from('P', 'ascii'), EOI,
    ]);
    const out = stripExif(src);
    assert.ok(!out.includes(Buffer.from('Exif', 'ascii')), '独立标记后未正确跳过长度字段');
  });
}

console.log('\n【G. SOS 之后原样拷贝到结尾】');
{
  ok('SOS 后的数据（含 0xff 0x00）原样保留', () => {
    const tail = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd9]);
    const src = Buffer.concat([
      SOI, APP1(Buffer.from('Exif', 'ascii')),
      SOS(Buffer.from('S', 'ascii')), tail,
    ]);
    const out = stripExif(src);
    assert.ok(out.includes(tail), 'SOS 后的数据不完整');
    assert.ok(!out.includes(Buffer.from('Exif', 'ascii')));
  });
  ok('SOS 后的数据不被当作段解析（其中的 FFE1 不被剥）', () => {
    // 熵编码数据里恰好出现 FFE1 字节序列是很常见的（压缩数据不可预测）
    const tail = Buffer.from([0xff, 0xe1, 0x11, 0x22, 0x33]);
    const src = Buffer.concat([
      SOI, APP1(Buffer.from('Exif', 'ascii')),
      SOS(Buffer.from('S', 'ascii')), tail,
    ]);
    const out = stripExif(src);
    assert.ok(out.includes(tail), '熵编码数据里的 FFE1 被误当成段剥掉了');
  });
  ok('无 SOS 的文件（只有段）也能处理', () => {
    const src = Buffer.concat([SOI, APP1(Buffer.from('Exif', 'ascii')), APP2(Buffer.from('ICC', 'ascii')), EOI]);
    const out = stripExif(src);
    assert.ok(!out.includes(Buffer.from('Exif', 'ascii')));
    assert.ok(out.includes(Buffer.from('ICC', 'ascii')));
  });
}

console.log('\n【H. 自检：判据真的能区分】');
{
  ok('自检：构造的夹具确实是合法 JPEG（不被回退）', () => {
    const src = buildJpeg();
    const out = stripExif(src);
    assert.ok(!out.equals(src), '输出与输入相同 → 说明整份回退了，夹具或实现有问题');
  });
  ok('自检：APP1 在输入里确实存在（不是夹具本身就错）', () => {
    assert.ok(buildJpeg().includes(Buffer.from([0xff, 0xe1])));
  });
  ok('自检：回退路径与剥离路径产生不同输出', () => {
    const good = stripExif(buildJpeg());
    const bad = stripExif(Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x64]), Buffer.from('short')]));
    assert.ok(!good.equals(bad), '两条路径结果相同 → 断言无效');
  });
  ok('自检：段长度算术正确（标记2 + 长度2 + payload）', () => {
    // "Exif" 4 字节 → 8；"ICC" 3 字节 → 7
    // ⚠ 第一版把 APP2 也写成 8 —— ICC 是 3 个字母。
    assert.strictEqual(APP1(Buffer.from('Exif', 'ascii')).length, 8);
    assert.strictEqual(APP2(Buffer.from('ICC', 'ascii')).length, 7);
    assert.strictEqual(COM(Buffer.from('note', 'ascii')).length, 8);
  });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
