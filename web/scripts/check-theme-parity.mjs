/**
 * 首帧主题与运行时主题的一致性（**行为验证**，不是源码比对）。
 *
 * 背景：`public/theme-init.js` 在 CSS 加载前执行，决定**首帧**颜色；
 * `src/stores/theme.js` 在 Vue 挂载后执行，决定**之后**的颜色。
 * 两边算得不一样就是「刷新闪一下」——这个项目历史上真实踩过三次：
 *
 *   1. 深色下 theme-init 用 ×0.72 调暗、theme.js 混白提亮 → 首帧 #a43f2c、挂载后 #ec8673
 *   2. theme-init 只在「用户存过合法 accent」时才写变量 → 首访者首帧吃 main.css 字面量，
 *      而字面量的系数与 theme.js 不是一套
 *   3. Element Plus 七个主色变量同样只在 hasAccent 时写
 *
 * 前两次都是源码级修复。这道门禁做的是**把它们钉住**：真的跑一遍 theme-init.js
 * （vm 沙箱 + 假 DOM），收集它写入的 12 个 CSS 变量，再用 theme.js 的公式复算一遍，
 * 逐个变量比对字符串。
 *
 * 为什么用 vm 而不是正则读源码：源码比对只能证明"两处写了同一个字面量"，
 * 证明不了"它们算出同一个值"。而这里真正重要的是后者 ——
 * 系数相同但混合方向写反（0.28 的 mix vs shade）照样字面量一致、结果相反。
 *
 * 用法：node scripts/check-theme-parity.mjs   （无参数）
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/* ---------- theme.js 的公式（ES5 复刻，与 src/stores/theme.js 逐字对应） ---------- */
const WHITE = [255, 255, 255];
const PAGE = [18, 17, 15];   // #12110f，深色 --bg-dark
const mixWhite = (c, a) => Math.round(c + (255 - c) * a);
const shade = (c, a) => Math.round(c * (1 - a));
const mixTo = (c, t, a) => Math.round(c + (t - c) * a);
const mixArr = (p, q, a) => [mixTo(p[0], q[0], a), mixTo(p[1], q[1], a), mixTo(p[2], q[2], a)];
const shadeArr = (p, a) => [shade(p[0], a), shade(p[1], a), shade(p[2], a)];
const rgbStr = (p) => `rgb(${p[0]}, ${p[1]}, ${p[2]})`;

/** 按 theme.js 的逻辑算出期望的 12 个变量 */
function expectVars(accentHex, dark) {
  const r = parseInt(accentHex.slice(1, 3), 16);
  const g = parseInt(accentHex.slice(3, 5), 16);
  const b = parseInt(accentHex.slice(5, 7), 16);
  const out = {};
  // theme.js 浅色下 `--accent` 直接赋 accent.value（**hex 字符串**），
  // 而 theme-init.js 一律写 rgb(...)。CSS 引擎解析两者等价，但字符串不等 ——
  // 所以这里统一归一化成 rgb() 再比。（第一版没归一化，两个浅色场景假红。）
  out['--accent'] = dark ? rgbStr([mixWhite(r, 0.28), mixWhite(g, 0.28), mixWhite(b, 0.28)]) : rgbStr([r, g, b]);
  const deep = dark
    ? [mixWhite(r, 0.4), mixWhite(g, 0.4), mixWhite(b, 0.4)]
    : [shade(r, 0.28), shade(g, 0.28), shade(b, 0.28)];
  out['--accent-deep'] = rgbStr(deep);
  out['--accent-text'] = rgbStr(deep);   // 深色跟随 accent-deep，浅色与它同值
  out['--accent-fill'] = rgbStr([shade(r, 0.24), shade(g, 0.24), shade(b, 0.24)]);
  out['--accent-soft'] = dark
    ? rgbStr([Math.round(r * 0.18 + 18 * 0.82), Math.round(g * 0.18 + 17 * 0.82), Math.round(b * 0.18 + 15 * 0.82)])
    : rgbStr([mixWhite(r, 0.9), mixWhite(g, 0.9), mixWhite(b, 0.9)]);

  const base = [r, g, b];
  const elPrimary = dark ? mixArr(base, WHITE, 0.1) : base;
  out['--el-color-primary'] = rgbStr(elPrimary);
  out['--el-color-primary-dark-2'] = dark ? rgbStr(mixArr(base, WHITE, 0.12)) : rgbStr(shadeArr(base, 0.25));
  // 深色下 light-N 是「拿提亮后的 primary 朝深底压暗」，浅色是「朝白混」
  const lightMix = dark
    ? [[0.3], [0.55], [0.8], [0.88], [0.9]]
    : [[0.55], [0.7], [0.85], [0.9], [0.95]];
  const target = dark ? PAGE : WHITE;
  const from = dark ? elPrimary : base;
  [3, 5, 7, 8, 9].forEach((n, i) => {
    out[`--el-color-primary-light-${n}`] = rgbStr(mixArr(from, target, lightMix[i][0]));
  });
  return out;
}

/** 在 vm 里跑 theme-init.js，收集它写入的变量 */
function runThemeInit({ dark, accent = null }) {
  const written = {};
  const dataset = {};
  const storage = accent === null ? {} : { xalor_accent: accent };
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = v; },
    },
    window: { matchMedia: () => ({ matches: dark }) },
    document: {
      documentElement: { dataset, style: { setProperty: (k, v) => { written[k] = v; } } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(WEB, 'public', 'theme-init.js'), 'utf8'), sandbox);
  return { written, dataset };
}

/* ---------- 逐个场景比对 ---------- */
const CASES = [
  ['浅色 + 默认强调色', { dark: false, accent: null }, '#e4573d'],
  ['深色 + 默认强调色', { dark: true, accent: null }, '#e4573d'],
  ['浅色 + 自定义强调色', { dark: false, accent: '#1a7f5a' }, '#1a7f5a'],
  ['深色 + 自定义强调色', { dark: true, accent: '#1a7f5a' }, '#1a7f5a'],
];

console.log('\n【theme-init.js 与 theme.js 公式逐值一致】');
for (const [name, opts, accentHex] of CASES) {
  const { written, dataset } = runThemeInit(opts);
  const expected = expectVars(accentHex, opts.dark);

  const missing = Object.keys(expected).filter((k) => !(k in written));
  ok(`${name}：写了全部 ${Object.keys(expected).length} 个变量`, missing.length === 0,
    missing.length ? `缺 ${missing.join(', ')}` : '');

  const diff = Object.entries(expected).filter(([k, v]) => written[k] !== v);
  ok(`${name}：每个变量都与 theme.js 同值`, diff.length === 0,
    diff.slice(0, 3).map(([k, v]) => `${k} 实际 ${written[k]} ≠ 期望 ${v}`).join(' | '));

  // data-theme 也必须跟着设（否则 CSS 的 [data-theme='dark'] 分支不生效）
  const wantTheme = opts.dark ? 'dark' : undefined;
  ok(`${name}：data-theme 正确`, dataset.theme === wantTheme,
    `实际 ${dataset.theme} / 期望 ${wantTheme}`);
}

console.log('\n【自检：判据真的能抓到系数漂移】');
{
  // 复刻一遍但把深色 accent-deep 的 0.4 改成 0.42，应当产生差异
  const accentHex = '#e4573d';
  const r = parseInt(accentHex.slice(1, 3), 16), g = parseInt(accentHex.slice(3, 5), 16), b = parseInt(accentHex.slice(5, 7), 16);
  const drifted = rgbStr([mixWhite(r, 0.42), mixWhite(g, 0.42), mixWhite(b, 0.42)]);
  const correct = rgbStr([mixWhite(r, 0.4), mixWhite(g, 0.4), mixWhite(b, 0.4)]);
  ok('自检：0.42 ≠ 0.4 能算出差值', drifted !== correct, `${drifted} vs ${correct}`);
  ok('自检：真实文件当前不是那个漂移值',
    runThemeInit({ dark: true }).written['--accent-deep'] === correct);
}

console.log('\n【防闪的三条结构性保证】');
{
  const src = readFileSync(join(WEB, 'public', 'theme-init.js'), 'utf8');
  ok('是外部文件而不是内联（CSP 才能收紧为 script-src \'self\'）',
    /^\(function \(\)/.test(src.trim()) || src.trim().startsWith('//'));
  ok('默认强调色与 theme.js 相同（#e4573d）',
    src.includes("DEFAULT_ACCENT = '#e4573d'"));
  ok('写变量的段落不被「用户是否自定义过」这个条件包住',
    !/if\s*\(\s*hasAccent\s*\)\s*\{[\s\S]{0,200}setProperty/.test(src),
    '首访者占多数，他们的首帧必须也走这套公式');
  const sha = createHash('sha256').update(src).digest('hex').slice(0, 8);
  ok(`内容 hash 记录：${sha}`, true);
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
