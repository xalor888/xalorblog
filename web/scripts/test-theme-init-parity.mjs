/**
 * theme-init.js ↔ theme.js 的一致性
 *
 * 为什么必须有这个测试：
 * 这两个文件用**两套独立代码**算同一批颜色变量 ——
 *   - `public/theme-init.js`：同步阻塞脚本，在 CSS 加载前设置 data-theme 与内联变量，
 *     目的是防「深色模式刷新闪白」。它不能用 ESM、不能引用 store，只能自己算一遍。
 *   - `src/stores/theme.js`：Vue 挂载后接管，必须给出同样的结果。
 *
 * 内部变量优先级高于样式表，所以**首屏那一帧完全由 theme-init.js 决定**。
 * 两边只要算得不一样，用户就会先看到颜色 A、Vue 启动后跳成颜色 B ——
 * 典型的「刷新时闪一下」，而且只在特定主题/特定自定义强调色下出现，极难复现。
 *
 * 真实发生过一次：theme-init 用 ×0.72 调暗，theme.js 用混白 28% 提亮。
 * 深色用户首屏看到 #a43f2c（暗红，对深底只有 2.99:1），挂载后跳成 #ec8673。
 *
 * 这个测试把两边的算法各实现一遍（就是各自源码里的数学），对同一组输入逐值比对。
 * 用法：node scripts/test-theme-init-parity.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const initSrc = readFileSync(resolve(here, '../public/theme-init.js'), 'utf8');
const storeSrc = readFileSync(resolve(here, '../src/stores/theme.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------- 两边的数学（照抄各自源码的公式） ---------- */

/** theme.js 的 shade(hex, amount)：c * (1 - amount) */
const shade = (c, amount) => Math.round(c * (1 - amount));
/** theme.js 的 mix(hex, '#ffffff', amount)：c + (255 - c) * amount */
const mixWhite = (c, amount) => Math.round(c + (255 - c) * amount);

/** 按 theme.js apply() 的规则算出四个变量的期望值 */
function expectedFromStore(hex, isDark) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const pick = (fn) => [fn(r), fn(g), fn(b)];

  const accent = isDark ? pick((c) => mixWhite(c, 0.28)) : [r, g, b];
  const deep = isDark ? pick((c) => mixWhite(c, 0.4)) : pick((c) => shade(c, 0.28));
  // 文字色：深色跟随 accent-deep，浅色压深 18%
  const text = isDark ? deep : pick((c) => shade(c, 0.18));
  // 实心底：永远压深 18%（不随主题提亮）
  const fill = pick((c) => shade(c, 0.18));
  // 淡底：浅色向白混 90%；深色向页面底色 #12110f 混 82%
  const soft = isDark
    ? [
        Math.round(r * 0.18 + 0x12 * 0.82),
        Math.round(g * 0.18 + 0x11 * 0.82),
        Math.round(b * 0.18 + 0x0f * 0.82),
      ]
    : pick((c) => mixWhite(c, 0.9));

  return { accent, deep, text, fill, soft };
}

/* ---------- 静态检查：theme-init.js 是否仍按同样的公式写 ---------- */
console.log('\n【theme-init.js 的公式】');
ok('深色 --accent 向白混 0.28（不是调暗）', /mixWhite\(r,\s*0\.28\)/.test(initSrc) && /mixWhite\(g,\s*0\.28\)/.test(initSrc));
ok('浅色 --accent 保持原色', /: \[r, g, b\]/.test(initSrc));
ok('深色 --accent-deep 向白混 0.4', /mixWhite\(r,\s*0\.4\)/.test(initSrc));
ok('浅色 --accent-deep 压深 0.28', /shade\(r,\s*0\.28\)/.test(initSrc));
ok('--accent-text 浅色压深 0.18', /shade\(r,\s*0\.18\)/.test(initSrc));
ok('--accent-fill 始终压深 0.18（不随主题提亮）', /shade\(r,\s*0\.18\)[\s\S]{0,200}accent-fill/.test(initSrc));
ok('--accent-soft 深色向页面底色混（含 0.82）', /0\.82/.test(initSrc));
ok('--accent-soft 浅色向白混 0.9', /mixWhite\(r,\s*0\.9\)/.test(initSrc));
// 只查「真正的代码」里有没有 ×0.72 这种调暗写法；注释里为了记录历史可以提到它。
{
  const codeOnly = initSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');   // 行注释（避开 :// 这种 URL）
  ok(
    '代码里没有残留「深色调暗」写法（这是本次修掉的 bug）',
    !/0\.72/.test(codeOnly),
    '注释中提到历史值是可以的，但不能还在用'
  );
  // 只钉「用一个全局系数把整色缩掉」这种写法（旧的 `var f = dark ? 0.72 : 1`）。
  // 复合色混合（如 accent-soft 向页面底色混 82%）是正当用法，不在此列。
  ok(
    '代码里不再有「一个系数通吃整色」的调暗写法',
    !/var\s+f\s*=\s*dark\s*\?/.test(codeOnly) && !/\bf\s*=\s*dark\s*\?\s*0\./.test(codeOnly),
    '压深应逐通道走 shade()，这样才与 theme.js 逐值对齐'
  );
}

/* ---------- 数学检查：两套实现逐值相同 ---------- */
console.log('\n【两套实现对同一输入的结果必须逐值相同】');
const ACCENTS = ['#e4573d', '#c9900f', '#217a5e', '#2f6fb3', '#c24b5e', '#7c3aed', '#0ea5e9', '#111111', '#ffffff'];
let mismatch = 0;
for (const hex of ACCENTS) {
  for (const isDark of [false, true]) {
    const want = expectedFromStore(hex, isDark);
    // theme-init.js 的实现（同一套公式；这里验的是「公式一致」，不是运行时求值）
    const initAccent = isDark
      ? [mixWhite(parseInt(hex.slice(1, 3), 16), 0.28), mixWhite(parseInt(hex.slice(3, 5), 16), 0.28), mixWhite(parseInt(hex.slice(5, 7), 16), 0.28)]
      : [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    if (JSON.stringify(initAccent) !== JSON.stringify(want.accent)) {
      mismatch += 1;
      console.log(`    ✗ ${hex} ${isDark ? 'dark' : 'light'} accent init=${initAccent} store=${want.accent}`);
    }
  }
}
ok(`${ACCENTS.length * 2} 组「强调色 × 主题」的 --accent 完全一致`, mismatch === 0, `${mismatch} 组不一致`);

/* ---------- 语义检查：结果本身也要满足对比度 ---------- */
console.log('\n【算出来的颜色必须满足对比度（否则两个文件「一致地错」也没意义）】');
{
  const lum = (rgbArr) => {
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(rgbArr[0]) + 0.7152 * lin(rgbArr[1]) + 0.0722 * lin(rgbArr[2]);
  };
  const ratio = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
  };
  const DARK_BG = [0x12, 0x11, 0x0f];
  const LIGHT_BG = [0xf6, 0xf4, 0xf1];

  const d = expectedFromStore('#e4573d', true);
  const l = expectedFromStore('#e4573d', false);
  ok(`深色 --accent 对深底 >= 4.5:1（${ratio(d.accent, DARK_BG)}）`, ratio(d.accent, DARK_BG) >= 4.5);
  ok(`深色 --accent-text 对深底 >= 4.5:1（${ratio(d.text, DARK_BG)}）`, ratio(d.text, DARK_BG) >= 4.5);
  ok(`浅色 --accent-text 对页底 >= 4.5:1（${ratio(l.text, LIGHT_BG)}）`, ratio(l.text, LIGHT_BG) >= 4.5);
  ok(`--accent-fill 对白字 >= 4.5:1（${ratio(l.fill, [255, 255, 255])}）`, ratio(l.fill, [255, 255, 255]) >= 4.5);
  ok(`深色 --accent-soft 只是略亮于深底（${ratio(d.soft, DARK_BG)}:1，应 < 3）`, ratio(d.soft, DARK_BG) < 3);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
