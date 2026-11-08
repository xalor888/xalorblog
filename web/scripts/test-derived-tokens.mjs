/**
 * Element Plus 派生色阶（light-1..9 / dark-2）的可读性门禁。
 *
 * 为什么值得测：`--el-color-primary-light-9` 不是装饰色。Element Plus 用它做
 *   `.el-alert--primary { --el-alert-bg-color: var(--el-color-primary-light-9) }`
 *   表格 current-row / 下拉选中项 / 菜单 active / 按钮 hover 也都用 light-9 这一档。
 * 所以它承担「**这一行/这一项被选中了**」的信息 —— 与页底同色等于这条信息不存在。
 *
 * 历史（2026-11-08 修复）：旧阶梯浅色 light-9 = `#fef7f5`，与页底**逐字节相同**（1.00:1）；
 * 深色 light-9 1.12:1。两条都属「几乎同色」一档。深色 dark-2 与 primary 只差 2%（1.02:1），
 * hover 加深态也看不出来。现在整套系数重调（theme.js / theme-init.js / main.css 三处同步），
 * 本文件把**修复后**的实测值钉住：
 *   - 浅色 light-9 ≥ 1.2:1、深色 light-9 ≥ 1.2:1
 *   - dark-2 比 primary 至少暗 1.3:1
 *   - main.css 的静态兜底值与 theme.js 公式**算出来的值逐字节相同**（不能靠眼算）
 *
 * 三道实现（theme.js 运行时 / theme-init.js 首帧 / main.css 兜底）系数必须同源，
 * `test-theme-init-parity.mjs` 负责三者一致，本文件负责「这一套值到底看不看得见」。
 *
 * 用法：node scripts/test-derived-tokens.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const THEME = resolve(here, '../src/stores/theme.js');
const MAIN_CSS = resolve(here, '../src/styles/main.css');
const themeSrc = readFileSync(THEME, 'utf8');
const cssSrc = readFileSync(MAIN_CSS, 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/* ---------- WCAG 相对亮度与对比度（本地计算，不联网） ---------- */
function parseColor(c) {
  const s = String(c).trim();
  let m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const h = m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  m = s.match(/^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  throw new Error(`无法解析颜色: ${s}`);
}
const chan = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c) => { const { r, g, b } = parseColor(c); return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b); };
function ratio(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** 与 theme.js 的 mix() 完全一致的实现（Math.round，输出 rgb() 串） */
function mix(color, target, amount) {
  const c = parseColor(color), t = parseColor(target);
  const m = (x, y) => Math.round(x + (y - x) * amount);
  return `rgb(${m(c.r, t.r)}, ${m(c.g, t.g)}, ${m(c.b, t.b)})`;
}
const hexToRgbStr = (hex) => {
  const { r, g, b } = parseColor(hex);
  return `rgb(${r}, ${g}, ${b})`;
};

/* ---------- 从源码解析真实系数（不硬编，改了就跟上） ---------- */
const DARK_BG = '#12110f';
const LIGHT_BG = '#fef7f5';
const ADJ = ['light-3', 'light-5', 'light-7', 'light-8', 'light-9'];

function parseAdj(name) {
  const line = themeSrc.split('\n').find((l) => l.includes(`--el-color-primary-${name}'`));
  if (!line) return null;
  const joined = themeSrc.split('\n').slice(themeSrc.split('\n').indexOf(line), themeSrc.split('\n').indexOf(line) + 3).join(' ');
  const mixes = [...joined.matchAll(/mix\(\s*(?:accent\.value|brightBase)\s*,\s*'([^']+)'\s*,\s*([\d.]+)\s*\)/g)]
    .map((m) => ({ target: m[1].toLowerCase(), amount: Number(m[2]) }));
  const shades = [...joined.matchAll(/shade\(\s*accent\.value\s*,\s*([\d.]+)\s*\)/g)]
    .map((m) => ({ shade: Number(m[1]) }));
  return { mixes, shades };
}

const BRIGHTEN = (() => {
  const m = themeSrc.match(/brightBase\s*=\s*isDark\.value\s*\?\s*mix\(accent\.value,\s*'#ffffff',\s*([\d.]+)\)/);
  return m ? Number(m[1]) : null;
})();

const spec = {};
for (const v of ADJ) spec[v] = parseAdj(v);
spec['dark-2'] = parseAdj('dark-2');

/** main.css 的两段声明（浅色 :root / 深色块），各取七个变量 */
function cssBlock(fromLine) {
  const lines = cssSrc.split('\n');
  const out = {};
  for (const m of lines.slice(fromLine, fromLine + 14).join('\n').matchAll(/--el-color-primary-(light-\d|dark-2):\s*(#[0-9a-f]{6})/gi)) {
    out[m[1]] = m[2];
  }
  return out;
}
const cssLight9Line = cssSrc.split('\n').findIndex((l) => /--el-color-primary-light-9:/.test(l));
const cssDark9Line = cssSrc.split('\n').findIndex((l, i) => i > cssLight9Line && /--el-color-primary-light-9:/.test(l));
// 两段声明按出现顺序取：第一处是浅色 :root，第二处是深色块。
// （不要按 "[data-theme='dark']" 切串 —— 注释里也会出现这个词，会切错位置。）
const primaryDecls = [...cssSrc.matchAll(/--el-color-primary:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
const cssLightAccent = primaryDecls[0];
const cssDarkAccent = primaryDecls[1];

const LIGHT_ACCENT = cssLightAccent || '#e4573d';
const DARK_PRIMARY = cssDarkAccent || mix(LIGHT_ACCENT, '#ffffff', 0.1);

console.log('\n【A. 三处系数都从源码解析到了】');
{
  const missing = [...ADJ, 'dark-2'].filter((v) => !spec[v] || (!spec[v].mixes.length && !spec[v].shades.length));
  ok('6 个派生变量都能解析', missing.length === 0, missing.join(', '));
  ok('深色基准是提亮 10% 的 brightBase', BRIGHTEN === 0.1, String(BRIGHTEN));
  ok('light-3/5/7/8/9 的深色支都 mix 到 #12110f',
    ADJ.every((v) => spec[v].mixes.some((m) => m.target === DARK_BG)),
    ADJ.filter((v) => !spec[v].mixes.some((m) => m.target === DARK_BG)).join(', '));
  ok('light-3/5/7/8/9 的浅色支都 mix 到 #ffffff',
    ADJ.every((v) => spec[v].mixes.some((m) => m.target === '#ffffff')),
    ADJ.filter((v) => !spec[v].mixes.some((m) => m.target === '#ffffff')).join(', '));
}

console.log('\n【B. 系数结构（修复后的阶梯）】');
{
  const darkLadder = ADJ.map((v) => spec[v].mixes.find((m) => m.target === DARK_BG).amount);
  const lightLadder = ADJ.map((v) => spec[v].mixes.find((m) => m.target === '#ffffff').amount);

  ok(`深色阶梯 .30/.50/.66/.72/.78 单调递增（${darkLadder.join(' → ')}）`,
    darkLadder.join(',') === '0.3,0.5,0.66,0.72,0.78', darkLadder.join(','));
  ok(`浅色阶梯 .40/.55/.66/.72/.78 单调递增（${lightLadder.join(' → ')}）`,
    lightLadder.join(',') === '0.4,0.55,0.66,0.72,0.78', lightLadder.join(','));
  ok('所有系数都在 (0, 1) 内（零系数=同色，1=完全底色）',
    [...darkLadder, ...lightLadder].every((a) => a > 0 && a < 1));

  const d2dark = spec['dark-2'].mixes.find((m) => m.target === DARK_BG);
  ok('深色 dark-2 = mix(brightBase, #12110f, 0.25)（向页底压暗，不是向白提亮）',
    d2dark && d2dark.amount === 0.25, d2dark ? String(d2dark.amount) : '未解析到');
  ok('浅色 dark-2 用 shade(accent, 0.25)',
    spec['dark-2'].shades.some((x) => x.shade === 0.25), JSON.stringify(spec['dark-2'].shades));
}

console.log('\n【C. 派生色与底色的对比度（实测）】');
{
  const brightBase = mix(LIGHT_ACCENT, '#ffffff', BRIGHTEN);
  const rows = ADJ.map((v) => {
    const d = spec[v].mixes.find((m) => m.target === DARK_BG);
    const l = spec[v].mixes.find((m) => m.target === '#ffffff');
    const darkColor = mix(brightBase, DARK_BG, d.amount);
    const lightColor = mix(LIGHT_ACCENT, '#ffffff', l.amount);
    return { v, darkColor, darkRatio: ratio(darkColor, DARK_BG), lightColor, lightRatio: ratio(lightColor, LIGHT_BG) };
  });
  for (const r of rows) {
    console.log('    ' + r.v.padEnd(8) + ' dark ' + r.darkColor.padEnd(18) + r.darkRatio.toFixed(2) + ':1'
      + '   light ' + r.lightColor.padEnd(18) + r.lightRatio.toFixed(2) + ':1');
  }

  const r9 = rows.find((r) => r.v === 'light-9');
  const r8 = rows.find((r) => r.v === 'light-8');

  ok('浅色 light-9 与页底 ≥ 1.2:1（选中行可辨）', r9.lightRatio >= 1.2, r9.lightRatio.toFixed(2) + ':1');
  ok('深色 light-9 与页底 ≥ 1.2:1', r9.darkRatio >= 1.2, r9.darkRatio.toFixed(2) + ':1');
  ok('浅色 light-8 ≥ 1.2:1', r8.lightRatio >= 1.2, r8.lightRatio.toFixed(2) + ':1');
  ok('深色 light-8 ≥ 1.2:1', r8.darkRatio >= 1.2, r8.darkRatio.toFixed(2) + ':1');
  ok('light-9 是整条阶梯里最淡的一档（不能反过来比 light-8 更浓）',
    r9.lightRatio <= r8.lightRatio && r9.darkRatio <= r8.darkRatio,
    `light-9 ${r9.lightRatio.toFixed(2)} / light-8 ${r8.lightRatio.toFixed(2)}`);

  const d2 = mix(brightBase, DARK_BG, 0.25);
  ok('深色 dark-2 比 primary 暗 ≥ 1.3:1（hover 加深态看得出来）',
    ratio(d2, brightBase) >= 1.3, ratio(d2, brightBase).toFixed(2) + ':1');
}

console.log('\n【D. main.css 静态兜底值 = theme.js 公式算出的值（逐字节）】');
{
  ok('main.css 里 light-9 声明了两次（浅色 + 深色）', cssLight9Line !== -1 && cssDark9Line !== -1,
    `浅色行 ${cssLight9Line + 1} / 深色行 ${cssDark9Line + 1}`);

  const lightVars = cssBlock(cssLight9Line - 12);
  const darkVars = cssBlock(cssDark9Line - 12);
  const brightBase = mix(LIGHT_ACCENT, '#ffffff', BRIGHTEN);

  ok('浅色 accent 解析到 #e4573d', LIGHT_ACCENT === '#e4573d', String(LIGHT_ACCENT));
  ok('深色 primary 解析到 brightBase 算出的值', hexToRgbStr(DARK_PRIMARY) === brightBase,
    `css ${DARK_PRIMARY} / 公式 ${brightBase}`);

  for (const v of ADJ) {
    const dAmt = spec[v].mixes.find((m) => m.target === DARK_BG).amount;
    const lAmt = spec[v].mixes.find((m) => m.target === '#ffffff').amount;
    const wantDark = Hex(mix(brightBase, DARK_BG, dAmt));
    const wantLight = Hex(mix(LIGHT_ACCENT, '#ffffff', lAmt));
    ok(`浅色 ${v} 兜底值零漂移（${wantLight}）`, lightVars[v] === wantLight, `css ${lightVars[v]}`);
    ok(`深色 ${v} 兜底值零漂移（${wantDark}）`, darkVars[v] === wantDark, `css ${darkVars[v]}`);
  }
  ok('浅色 dark-2 兜底值零漂移（#ab412e）', lightVars['dark-2'] === '#ab412e', String(lightVars['dark-2']));
  ok('深色 dark-2 兜底值零漂移', darkVars['dark-2'] === Hex(mix(brightBase, DARK_BG, 0.25)), `css ${darkVars['dark-2']}`);
}

function Hex(rgbStr) {
  const { r, g, b } = parseColor(rgbStr);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

console.log('\n【E. 决策参考：系数扫描（说明为什么选 0.78）】');
{
  const brightBase = mix(LIGHT_ACCENT, '#ffffff', BRIGHTEN);
  const sweep = [0.95, 0.9, 0.85, 0.82, 0.78, 0.75];
  for (const amt of sweep) {
    const dark = mix(brightBase, DARK_BG, amt);
    const light = mix(LIGHT_ACCENT, '#ffffff', amt);
    console.log(`    系数 ${amt.toFixed(2)}  dark ${ratio(dark, DARK_BG).toFixed(2)}:1   light ${ratio(light, LIGHT_BG).toFixed(2)}:1`
      + (Math.abs(amt - 0.78) < 1e-9 ? '  ← 当前' : ''));
  }
  const chosen = sweep.find((a) => Math.abs(a - 0.78) < 1e-9);
  ok('选定的 0.78 两个主题都 ≥ 1.2:1', ratio(mix(brightBase, DARK_BG, chosen), DARK_BG) >= 1.2
    && ratio(mix(LIGHT_ACCENT, '#ffffff', chosen), LIGHT_BG) >= 1.2);
  ok('旧的 0.95 仍然是 1.00:1（说明修复确实来自系数，不是巧合）',
    ratio(mix(LIGHT_ACCENT, '#ffffff', 0.95), LIGHT_BG) < 1.01);
}

console.log('\n【F. 自检：判据真的能区分】');
{
  ok('自检：对比度计算器可信（纯黑对纯白 = 21:1）',
    Math.abs(ratio('#000000', '#ffffff') - 21) < 0.01, ratio('#000000', '#ffffff').toFixed(2));
  ok('自检：同色对比度 = 1:1', Math.abs(ratio('#123456', '#123456') - 1) < 1e-9);
  ok('自检：parseColor 能吃 hex 与 rgb() 两种格式',
    parseColor('#0f8f5f').g === 143 && parseColor('rgb(15, 143, 95)').g === 143);
  ok('自检：投影函数能把「旧系数」算成不可辨（否则本文件拦不住回退）',
    ratio(mix(LIGHT_ACCENT, '#ffffff', 0.95), LIGHT_BG) < 1.2);
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n⚠ C/D 组红了通常意味着「theme.js 或 main.css 的系数被改过」——' +
    '三处（theme.js / theme-init.js / main.css）必须同源，改完请重跑本文件与 test-theme-init-parity.mjs');
  process.exit(1);
}
