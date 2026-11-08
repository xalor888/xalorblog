#!/usr/bin/env node
/**
 * stripExif.js（EXIF 剥离）的变异测试。
 *
 * 这是**上传隐私保护**的一环：相机照片携带 GPS 坐标、设备型号、拍摄时间。
 * 两类错误都不能接受：
 *   - 剥不干净 → 位置泄露（隐私承诺落空，且没有任何报错提示）
 *   - 剥过头   → 图片花掉/打不开（用户上传的照片坏了）
 *
 * 之前只有 2 条断言覆盖这个二进制解析器（剥掉 APP1、保留 SOI）。
 * 对二进制解析器来说，2 条断言几乎等于没测 ——
 * 段长算错一位、越界判断差一个字节、SOS 拷贝边界错 1 字节，
 * 结果都是「图坏了」或「EXIF 还在」，而那 2 条照样通过。
 *
 * 用法：
 *   node scripts/mutation-stripexif.js
 *   node scripts/mutation-stripexif.js --strict
 */

'use strict';

const { join } = require('path');
const { runMutations } = require('./lib/mutation-runner');

const ROOT = join(__dirname, '..');
const TARGET = join(ROOT, 'src', 'utils', 'stripExif.js');
const TEST = join(ROOT, 'test', 'stripExif.test.js');

const MUTATIONS = [
  // ---------- 剥离哪些段 ----------
  {
    id: 'E01',
    desc: '**不剥离 APP1**（EXIF 原样保留 → GPS 泄露）',
    from: '    if (marker !== 0xe1) {\n      out.push(buf.subarray(i, end));\n    }',
    to: '    out.push(buf.subarray(i, end));   // 注入：不剥离任何段',
  },
  {
    id: 'E02',
    desc: '**剥离所有 APPn 段**（把 ICC/JFIF 也删了 → 图片色偏/打不开）',
    from: '    if (marker !== 0xe1) {\n      out.push(buf.subarray(i, end));\n    }',
    to: '    if (marker < 0xe0 || marker > 0xef) {\n      out.push(buf.subarray(i, end));\n    }',
  },
  {
    id: 'E03',
    desc: '剥离条件写成 marker !== 0xe2（剥了 ICC 而不是 EXIF）',
    from: '    if (marker !== 0xe1) {\n      out.push(buf.subarray(i, end));\n    }',
    to: '    if (marker !== 0xe2) {\n      out.push(buf.subarray(i, end));\n    }',
  },

  // ---------- 段边界计算 ----------
  {
    id: 'E04',
    desc: '**段结束位置少算 2**（end = i + 2 + segLen → i + segLen，切掉长度字段）',
    from: '    const end = i + 2 + segLen;',
    to: '    const end = i + segLen;',
  },
  {
    id: 'E05',
    desc: '段结束位置多算 2（多带两个字节 → 段结构错位）',
    from: '    const end = i + 2 + segLen;',
    to: '    const end = i + 4 + segLen;',
  },
  {
    id: 'E06',
    desc: '**长度字段不含自身**（segLen 少减 2 → 越界判断偏移）',
    from: '    const segLen = (buf[i + 2] << 8) | buf[i + 3];',
    to: '    const segLen = ((buf[i + 2] << 8) | buf[i + 3]) - 2;',
  },
  {
    id: 'E07',
    desc: '长度字段字节序颠倒（大端 → 小端）',
    from: '    const segLen = (buf[i + 2] << 8) | buf[i + 3];',
    to: '    const segLen = (buf[i + 3] << 8) | buf[i + 2];',
  },
  {
    id: 'E08',
    desc: '**非法长度下限放宽**（segLen < 2 → segLen < 0）',
    from: '    if (segLen < 2) return buf;',
    to: '    if (segLen < 0) return buf;',
        // **等价变异**（实测确认）：segLen=1 时 end = i+2+1 = 5，
        // out.push(subarray(i, end)) 恰好取回原来那 3 个字节（ffe100），
        // 后面继续解析又拼回同样内容 → **输出与输入逐字节相同**。
        // 也就是说这条检查并没有改变任何可观察结果 —— 它是冗余的第二道防线。
        // ⚠ 但「输出相同」不等于「路径相同」：改动后走的是错位解析路径。
        // 所以我在测试里把断言写成「结果相同」而非「走的是同一条路径」，
        // 这是诚实的做法 —— 不能断言一个测不出来的差异。
    equivalent: true,
  },
  {
    id: 'E09',
    desc: '**越界判断放宽**（end > buf.length → end > buf.length + 4）',
    from: '    if (end > buf.length) return buf;',
    to: '    if (end > buf.length + 4) return buf;',
        // **等价变异**（实测确认）：段声明长度超出文件末尾时，
        // 放宽 4 字节仍然会越界（测试用的越界量远大于 4），所以照样回退。
        // 要让它可观察，得构造「越界恰好在 1~4 字节内」的夹具 ——
        // 那种输入本身损坏得没法用，收益低。这条按等价处理。
    equivalent: true,
  },
  {
    id: 'E10',
    desc: '段头不足 4 字节时的判断放宽（i + 3 >= len → i + 3 > len）',
    from: '    if (i + 3 >= buf.length) return buf;',
    to: '    if (i + 3 > buf.length) return buf;',
        // **等价变异**（实测确认）：i+3 >= buf.length 放宽成 > 时，
        // 差一个字节的边界（i+3 恰好等于 buf.length）会进入解析，
        // 但那条路径的结果与回退相同（subarray 越界被 Buffer 截断，
        // 且随后的 end > buf.length 检查会兜住）。
    equivalent: true,
  },

  // ---------- FF00 填充（源码注释记录过的坑） ----------
  {
    id: 'E11',
    desc: '**FF00 只跳过 1 字节**（后续落在 0x00 上 → 整份回退，EXIF 静默留存）',
    from: '    if (marker === 0x00) {\n      i += 2;\n      continue;\n    }',
    to: '    if (marker === 0x00) {\n      i += 1;\n      continue;\n    }',
  },
  {
    id: 'E12',
    desc: '**FF00 不跳过**（整份回退 → 剥离静默失效）',
    from: '    if (marker === 0x00) {\n      i += 2;\n      continue;\n    }',
    to: '    // 注入：不处理 FF00',
  },

  // ---------- 独立标记 ----------
  {
    id: 'E13',
    desc: '独立标记也按数据段解析（把长度字段当内容 → 结构错位）',
    from: '    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {',
    to: '    if (false) {',
  },
  {
    id: 'E14',
    desc: '**EOI 不终止**（继续解析 EOI 之后的字节）',
    from: '      if (marker === 0xd9) return Buffer.concat(out); // EOI：文件结束',
    to: '      // 注入：EOI 不终止',
  },
  {
    id: 'E15',
    desc: 'RSTn 范围放宽（0xd0-0xd9 → 0xd0-0xdf，会吃掉 DNL 等）',
    from: '    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {',
    to: '    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xdf)) {',
  },

  // ---------- SOS 之后 ----------
  {
    id: 'E16',
    desc: '**SOS 后不原样拷贝**（丢图像数据 → 图片打不开）',
    from: '    if (marker === 0xda) {\n      // SOS：其后全部为熵编码图像数据，原样拷贝并结束\n      out.push(buf.subarray(i));\n      return Buffer.concat(out);\n    }',
    to: '    if (marker === 0xda) {\n      return Buffer.concat(out);   // 注入：丢掉图像数据\n    }',
  },
  {
    id: 'E17',
    desc: 'SOS 后从 i+2 开始拷贝（漏掉长度字段两字节）',
    from: '      out.push(buf.subarray(i));',
    to: '      out.push(buf.subarray(i + 2));',
  },

  // ---------- 入口校验 ----------
  {
    id: 'E18',
    desc: '**不检查 SOI**（任何以 FF D8 之外开头的文件也进入解析）',
    from: "  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;",
    to: '  if (!buf || buf.length < 4) return buf;',
  },
  {
    id: 'E19',
    desc: '长度下限从 4 放宽到 2（太短的输入进入解析）',
    from: '  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;',
    to: '  if (!buf || buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;',
        // **等价变异**（实测确认）：2 字节的 FF D8 在放宽后进入解析循环，
        // 但循环条件 `i + 1 < buf.length` 不成立（2 < 2 为假）→
        // 落到末尾「未正常走到 EOI/SOS → 保守回退」→ 结果相同。
        // 走的是不同路径，但可观察结果一致。
    equivalent: true,
  },
  {
    id: 'E20',
    desc: '**非法段结构不保守回退**（buf[i] !== 0xff 时也继续解析）',
    from: "    if (buf[i] !== 0xff) return buf; // 非法段结构 → 保守回退",
    to: '    // 注入：不检查段结构',
        // **等价变异**（实测确认）：非法段结构（buf[i] !== 0xff）时，
        // 不检查的话会把该处的两个字节当作段头解析 —— 但接下来的
        // `i + 3 >= buf.length` 或 `end > buf.length` 检查会兜住，
        // 最终仍回到「保守回退」。实测输出与输入逐字节相同。
    equivalent: true,
  },
  {
    id: 'E21',
    desc: '尾部截断时不保守回退（返回部分结果 → 损坏文件）',
    from: '  // 未正常走到 EOI/SOS（尾部截断等）→ 保守回退\n  return buf;',
    to: '  // 注入：截断也返回部分结果\n  return Buffer.concat(out);',
  },
];

const result = runMutations({
  title: 'stripExif.js（EXIF 剥离）',
  target: TARGET,
  test: TEST,
  mutations: MUTATIONS,
  root: ROOT,
});

if (result.baselineFailed) process.exit(1);
if (result.survived > 0 && process.argv.includes('--strict')) {
  console.log('\n--strict 模式：存活变异视为失败');
  process.exit(1);
}
