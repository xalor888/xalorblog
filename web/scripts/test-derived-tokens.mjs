/**
 * Element Plus 派生色阶（light-1..9 / dark-2）的可读性度量。
 *
 * 背景：`stores/theme.js` 按主题把强调色 `mix()` 到背景色/白色上，生成
 * `--el-color-primary-light-1..9` 与 `--el-color-primary-dark-2` 共 10 个变量。
 * Element Plus 自己拿它们当**状态填充色**用，例如：
 *   `.el-alert--primary { --el-alert-bg-color: var(--el-color-primary-light-9) }`
 *   表格 current-row / 下拉选中项 / 菜单 active / 按钮 hover 也都用 light-9 一档
 *
 * 所以 `light-9` 不是装饰，它承担「**这一行/这一项被选中了**」的信息。
 * 在深色主题下它被 mix 到 90% 的 `#12110f`，与页底几乎同色 ——
 * 用户看不出选中的是哪一项。这不是审美问题，是**状态不可感知**。
 *
 * 为什么这道门禁「钉现状」而不是「修」：修它要改 `theme.js` 的 0.9 系数，
 * 那是纯视觉决策（多亮算"恰好能看出又不刺眼"），属 `「颜色对比度待决策」项` 需人工决策项。
 * 本门禁的作用是：
 *   1. 把 10 个派生色的实际对比度**算出来并断言**（不是散文里的一个数字）
 *   2. 设绊线：谁改了系数，实测值会变，断言会红并说明该更新哪里
 *
 * 用法：node scripts/test-derived-tokens.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const THEME = resolve(here, '../src/stores/theme.js');
const MAIN_CSS = resolve(here, '../src/styles/main.css');

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

/* ---------- 从 theme.js 解析真实系数（不硬编，改了就跟上） ---------- */
const themeSrc = readFileSync(THEME, 'utf8');

/**
 * theme.js 实际只写 6 个派生变量（不是 9 档全写 —— light-1/2/4/6 用 EP 默认值）：
 *   dark-2、light-3、light-5、light-7、light-8、light-9
 * 且深色模式的基准不是 accent 本身，而是 **提亮 10% 的 brightBase**：
 *   brightBase = mix(accent, '#ffffff', 0.1)
 * 这一点很关键 —— 它也是 §6.4「dark-2 与 primary 几乎同色」的根源：
 *   primary(dark) = brightBase        = mix(accent, white, 0.10)
 *   dark-2(dark)  = mix(accent, white, 0.12)   ← 只差 2%
 */
const VARS = ['light-3', 'light-5', 'light-7', 'light-8', 'light-9', 'dark-2'];

/** 深色 brightBase 的提亮系数 */
const BRIGHTEN = (() => {
  const m = themeSrc.match(/brightBase\s*=\s*isDark\.value\s*\?\s*mix\(accent\.value,\s*'#ffffff',\s*([\d.]+)\)/);
  return m ? Number(m[1]) : null;
})();

/** 解析一行里三元的深/浅两支 */
function parseLine(varName) {
  const line = themeSrc.split('\n').find((l) => l.includes(`--el-color-primary-${varName}'`));
  if (!line) return null;
  // 有些变量声明跨行（dark-2），把后续两行接上再找
  const idx = themeSrc.split('\n').indexOf(line);
  const joined = themeSrc.split('\n').slice(idx, idx + 3).join(' ');
  const mixes = [...joined.matchAll(/mix\(\s*(?:accent\.value|brightBase)\s*,\s*'([^']+)'\s*,\s*([\d.]+)\s*\)/g)]
    .map((m) => ({ target: m[1], amount: Number(m[2]) }));
  const shades = [...joined.matchAll(/shade\(\s*accent\.value\s*,\s*([\d.]+)\s*\)/g)]
    .map((m) => ({ shade: Number(m[1]) }));
  return { mixes, shades };
}

const DARK_BG = '#12110f';    // 与 main.css 的 --bg-dark 一致
const LIGHT_BG = '#fef7f5';  // 与 main.css 的 --bg 一致

const spec = {};
for (const v of VARS) spec[v] = parseLine(v);

console.log('\n【A. 6 个派生变量都从 theme.js 解析出来了】');
{
  const missing = VARS.filter((v) => !spec[v] || (!spec[v].mixes.length && !spec[v].shades.length));
  ok(`6 个派生变量都能解析（缺 ${missing.length} 个）`, missing.length === 0, missing.join(', '));
  ok('深色基准是提亮 10% 的 brightBase（不是 accent 本身）', BRIGHTEN === 0.1, String(BRIGHTEN));
  ok('light-3/5/7/8/9 的深色支都 mix 到 #12110f',
    ['light-3', 'light-5', 'light-7', 'light-8', 'light-9']
      .every((v) => spec[v].mixes.some((m) => m.target === '#12110f')),
    '有变量 mix 到了别的底色');
  ok('浅色支都 mix 到 #ffffff',
    VARS.every((v) => !spec[v].mixes.length || spec[v].mixes.some((m) => m.target === '#ffffff')));
}

console.log('\n【B. 系数结构】');
{
  const darks = ['light-3', 'light-5', 'light-7', 'light-8', 'light-9']
    .map((v) => spec[v].mixes.find((m) => m.target === '#12110f').amount);
  ok('深色 light-3..9 的系数单调不减', darks.every((a, i) => i === 0 || a >= darks[i - 1]), darks.join(' → '));
  ok('深色系数都在 (0,1) 内', darks.every((a) => a > 0 && a < 1), darks.join(', '));
  ok('深色 light-9 的系数是 0.9', darks[4] === 0.9, String(darks[4]));

  const d2dark = spec['dark-2'].mixes.find((m) => m.target === '#ffffff');
  ok('深色 dark-2 = mix(accent, white, 0.12)', d2dark && d2dark.amount === 0.12,
    d2dark ? String(d2dark.amount) : '未解析到');
  ok('浅色 dark-2 用 shade(accent, 0.25)', spec['dark-2'].shades.some((x) => x.shade === 0.25),
    JSON.stringify(spec['dark-2'].shades));
  ok('**深色 dark-2(0.12) 与 primary 的 brightBase(0.10) 只差 0.02** —— §6.4 的根源',
    Math.abs(d2dark.amount - BRIGHTEN - 0.02) < 1e-9,
    `dark-2=${d2dark.amount} brightBase=${BRIGHTEN}`);
}

console.log('\n【C. 派生色与底色的对比度（实测，逐档列出）】');
{
  const ACCENT = '#e4573d';   // 默认强调色（main.css 的 --accent）
  const brightBase = mix(ACCENT, '#ffffff', BRIGHTEN);

  const rows = VARS.map((v) => {
    const d = spec[v].mixes.find((m) => m.target === '#12110f');
    const l = spec[v].mixes.find((m) => m.target === '#ffffff');
    const darkColor = d ? mix(brightBase, '#12110f', d.amount) : mix(ACCENT, '#ffffff', 0.12);
    const lightColor = l ? mix(ACCENT, '#ffffff', l.amount) : null;
    return {
      v, darkColor, darkRatio: ratio(darkColor, DARK_BG),
      lightColor, lightRatio: lightColor ? ratio(lightColor, LIGHT_BG) : null,
    };
  });
  for (const r of rows) {
    console.log('    ' + r.v.padEnd(8) + ' dark ' + r.darkColor.padEnd(18) + ' ' + r.darkRatio.toFixed(2) + ':1' +
      (r.lightColor ? '   light ' + r.lightColor.padEnd(18) + ' ' + r.lightRatio.toFixed(2) + ':1' : ''));
  }

  const r9 = rows.find((r) => r.v === 'light-9');
  const r8 = rows.find((r) => r.v === 'light-8');
  const r3 = rows.find((r) => r.v === 'light-3');

  ok('**深色 light-9 与页底 < 1.2:1（已知缺陷，等 §6.3 决策）**', r9.darkRatio < 1.2,
    '实测 ' + r9.darkRatio.toFixed(2) + ':1 —— light-9 是 EP 的选中/悬停填充色，几乎同色等于看不出选中');
  ok('深色 light-8 也 < 1.2:1（同属「几乎同色」一档）', r8.darkRatio < 1.2, r8.darkRatio.toFixed(2) + ':1');
  ok('深色 light-3 与页底 > 1.5:1（较浓的一档是可见的，证明公式本身没问题）',
    r3.darkRatio > 1.5, r3.darkRatio.toFixed(2) + ':1');
  // ⚠ 实测推翻原记录：§6.3 只提了深色，但**浅色 light-9 = #fef7f5 = 页底本色**，
  //   对比度 **1.00:1** —— 原件与页底逐字节相同，选中态完全不可见。
  ok('**浅色 light-9 与页底 = 1.00:1（同样不可见，原记录漏了）**',
    r9.lightRatio < 1.01, '实测 ' + r9.lightRatio.toFixed(3) + ':1');

  const dk2 = mix(ACCENT, '#ffffff', 0.12);
  ok('**深色 dark-2 与 primary 的差异 < 1.03:1（已知缺陷，等 §6.4 决策）**',
    ratio(dk2, brightBase) < 1.03,
    '实测 ' + ratio(dk2, brightBase).toFixed(3) + ':1 —— hover 加深态看不出来');
}

console.log('\n【D. main.css 的静态回退值与 theme.js 的问题一致】');
{
  const css = readFileSync(MAIN_CSS, 'utf8');
  const pick = (block) => {
    const out = {};
    for (const m of block.matchAll(/--el-color-primary-(light-\d|dark-2):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2];
    return out;
  };
  // 两段声明：:root（浅色，第 1081 行附近）与深色块（第 1111 行附近）。
  // 用行号定位比找 '.dark' 子串稳 —— 后者会命中注释或选择器片段。
  const lines = css.split('\n');
  const lightLine = lines.findIndex((l) => /--el-color-primary-light-9:/.test(l));
  const darkLine = lines.findIndex((l, i) => i > lightLine && /--el-color-primary-light-9:/.test(l));
  ok('main.css 里 light-9 声明了两次（浅色 + 深色）', lightLine !== -1 && darkLine !== -1,
    `浅色行 ${lightLine + 1} / 深色行 ${darkLine + 1}`);

  const lightVars = pick(lines.slice(Math.max(0, lightLine - 12), lightLine + 12).join('\n'));
  const darkVars = pick(lines.slice(Math.max(0, darkLine - 12), darkLine + 12).join('\n'));
  ok('浅色回退值是 #fef7f5', lightVars['light-9'] === '#fef7f5', String(lightVars['light-9']));
  ok('深色回退值是 #271a16', darkVars['light-9'] === '#271a16', String(darkVars['light-9']));

  // 关键：静态回退值与页底的关系，和 theme.js 算出来的一致
  ok('**浅色回退值与页底 #fef7f5 完全相同（1.00:1）**',
    ratio(lightVars['light-9'] || LIGHT_BG, LIGHT_BG) < 1.01,
    ratio(lightVars['light-9'] || LIGHT_BG, LIGHT_BG).toFixed(3) + ':1');
  ok('深色回退值与页底 #12110f 也接近（同样的问题复制了一份）',
    ratio(darkVars['light-9'] || DARK_BG, DARK_BG) < 1.2,
    ratio(darkVars['light-9'] || DARK_BG, DARK_BG).toFixed(2) + ':1 —— 修 theme.js 时这两行也要一起改');
}

console.log('\n【E. 决策参考：不同系数对应的对比度（不改代码，只算）】');
{
  // §6.3 需要人决定「多淡算够淡、又多浓才看得出选中」。
  // 这组数字让决策有依据，不用自己算 WCAG。
  const ACCENT = '#e4573d';
  const brightBase = mix(ACCENT, '#ffffff', BRIGHTEN);
  const rows = [0.9, 0.88, 0.86, 0.85, 0.83, 0.8, 0.75].map((amt) => {
    const c = mix(brightBase, DARK_BG, amt);
    return { amt, c, r: ratio(c, DARK_BG) };
  });
  for (const x of rows) {
    const mark = x.amt === 0.9 ? ' ← 当前' : (x.r >= 1.2 ? '  ≥1.2 可见' : '');
    console.log(`    深色系数 ${x.amt.toFixed(2)} → ${x.c.padEnd(18)} ${x.r.toFixed(2)}:1${mark}`);
  }
  ok('当前 0.9 是这组里对比度最低的（越靠近底色越不可见）',
    rows[0].r === Math.min(...rows.map((x) => x.r)));
  ok('把系数降到 0.85 可达 1.20:1（一个可选的修复点）',
    Math.abs(rows.find((x) => x.amt === 0.85).r - 1.2) < 0.02,
    rows.find((x) => x.amt === 0.85).r.toFixed(2) + ':1');

  // 浅色侧：light-9 的目标是白色，系数 0.95 意味着只剩 5% 强调色
  const lightRows = [0.95, 0.93, 0.9, 0.88, 0.85].map((amt) => {
    const c = mix(ACCENT, '#ffffff', amt);
    return { amt, c, r: ratio(c, LIGHT_BG) };
  });
  for (const x of lightRows) {
    const mark = x.amt === 0.95 ? ' ← 当前（1.00:1，与页底同色）' : (x.r >= 1.05 ? '  可辨' : '');
    console.log(`    浅色系数 ${x.amt.toFixed(2)} → ${x.c.padEnd(18)} ${x.r.toFixed(2)}:1${mark}`);
  }
  ok('浅色系数降到 0.88 以下才与页底产生可见差异',
    lightRows.find((x) => x.amt === 0.88).r >= 1.03,
    lightRows.find((x) => x.amt === 0.88).r.toFixed(2) + ':1');
}

console.log('\n【F. 自检：判据真的能区分】');
{
  ok('自检：把系数从 0.9 改成 0.85 会让对比度上升（绊线会红）', (() => {
    const before = ratio(mix('#e4573d', DARK_BG, 0.9), DARK_BG);
    const after = ratio(mix('#e4573d', DARK_BG, 0.85), DARK_BG);
    return after > before;
  })());
  ok('自检：对比度计算器本身可信（纯黑对纯白 = 21:1）',
    Math.abs(ratio('#000000', '#ffffff') - 21) < 0.01, String(ratio('#000000', '#ffffff')));
  ok('自检：同色对比度 = 1:1', Math.abs(ratio('#123456', '#123456') - 1) < 1e-9);
  ok('自检：parseColor 能吃 hex 与 rgb() 两种格式',
    parseColor('#0f8f5f').g === 143 && parseColor('rgb(15, 143, 95)').g === 143);
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n⚠ C 组的「已知缺陷」断言红了通常意味着「theme.js 的系数被改过」——' +
    '请更新本文件实测值与 「颜色对比度待决策」项');
  process.exit(1);
}
