/**
 * theme-init.js ↔ theme.js 的一致性（**执行**首屏脚本 + **执行** store 的颜色函数）
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
 * 真实发生过两次：
 *   1. theme-init 用 ×0.72 调暗，theme.js 用混白 28% 提亮（深色首帧 #a43f2c → 挂载后 #ec8673）。
 *   2. theme-init 根本不写 `--el-color-primary*`，浅色首帧的 EP 按钮/链接是默认蓝，
 *      挂载后才跳成主题色；而深色那条链在 theme.js 里还算出了 `rgb(NaN, NaN, NaN)`
 *      （mix() 的入参是它自己产出的 `rgb(...)` 字符串，旧 parseHex 只认 #rrggbb）。
 *
 * ⚠ 这个测试**不信任何一边的实现**：
 *   - theme-init.js 是整个文件丢进 `node:vm` 里**真跑**（打桩 localStorage/document），
 *     读它实际 setProperty 出来的字符串；
 *   - theme.js 侧同样不重写数学：从源码抽出 `apply()` 与 `parseColor/shade/mix` 的**函数体原文**
 *     直接求值（只补 isDark/accent/document 三个自由变量），跑的就是线上那份代码；
 *   - 另外把两边的系数逐条从各自源码里抽出来**配对**比较（RATIO 表里没有一个数是测试自带的），
 *     覆盖 `--accent*` 五变量与 `--el-color-primary*` 七个变量；
 *   - 末尾有「反恒真自检」：把 light-7 / accent-soft 的系数在内存里改动 0.01（init 与 store 各改一次），
 *     同一套流程必须判为不一致 —— 否则这段比对就是恒真的（这正是本次修掉的历史缺陷：
 *     旧版的「逐值相同」段把 init 侧系数写死成 0.28、期望值来自测试自己的 RATIO.accentDark=0.28）。
 *
 * 用法：node scripts/test-theme-init-parity.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

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

/* ============================================================
 * 一、两侧的「可执行真相」
 * ============================================================ */

/** theme-init.js：整个文件在沙箱里真跑一遍，返回它实际写出的内联变量 */
function runThemeInit(src, accentHex, dark) {
  const props = {};
  const saved = { xalor_theme: dark ? 'dark' : 'light', xalor_accent: accentHex };
  runInContext(
    src,
    createContext({
      localStorage: {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : null),
      },
      document: {
        documentElement: {
          dataset: {},
          style: {
            setProperty: (name, value) => {
              props[name] = value;
            },
          },
        },
      },
      window: { matchMedia: () => ({ matches: dark }) },
    })
  );
  return props;
}

/**
 * theme.js：把「色彩工具」那段的**源码原文**抽出来求值。
 * 不在这里重写 shade/mix —— 重写就等于自己和自己比（历史缺陷正是这么恒真的）。
 */
function loadStoreColorFns() {
  const at = storeSrc.indexOf('// 色彩工具');
  if (at < 0) throw new Error('在 src/stores/theme.js 里找不到「// 色彩工具」段落，抽取失败');
  const tail = storeSrc.slice(at);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${tail}\n;return { parseColor, shade, mix };`);
  return factory();
}
const { shade, mix } = loadStoreColorFns();

/* ============================================================
 * 二、从两边源码里抽系数（不是测试自己写常量）
 * ============================================================ */
const num = (s) => (s === undefined || s === null ? null : Number(s));

/** theme-init.js 侧的系数：按 init 里的变量名 + 写法类型抽 */
function initCoef(varName, kind) {
  const patterns = {
    // var elPrimary = dark ? mixArr(baseRGB, WHITE, 0.1) : baseRGB;
    ident: new RegExp(`var ${varName} = dark \\? mixArr\\(baseRGB, WHITE, ([\\d.]+)\\) : baseRGB;`),
    // var elLight3 = dark ? mixArr(elPrimary, PAGE, 0.3) : mixArr(baseRGB, WHITE, 0.55);
    mixMix: new RegExp(
      `var ${varName} = dark \\? mixArr\\(elPrimary, PAGE, ([\\d.]+)\\) : mixArr\\(baseRGB, WHITE, ([\\d.]+)\\);`
    ),
    // var elDark2 = dark ? mixArr(baseRGB, WHITE, 0.12) : shadeArr(baseRGB, 0.25);
    // var elDark2 = dark ? mixArr(elPrimary, PAGE, 0.25) : shadeArr(baseRGB, 0.25);
    // （2026-11-08：深色 dark-2 从「向白混」改成「向页底压暗」—— 它本来该比 primary 更暗）
    mixShade: new RegExp(
      `var ${varName} = dark \\? mixArr\\(elPrimary, PAGE, ([\\d.]+)\\) : shadeArr\\(baseRGB, ([\\d.]+)\\);`
    ),
  };
  const m = initSrc.match(patterns[kind]);
  if (!m) return null;
  return { dark: num(m[1]), light: kind === 'ident' ? null : num(m[2]) };
}

/** theme.js 侧的系数：按 setProperty 的变量名定位那一段三目 */
function storeCoef(varName, kind) {
  const at = storeSrc.indexOf(`'${varName}'`);
  if (at < 0) return null;
  const seg = storeSrc.slice(at, at + 400);
  const pair = kind === 'ident'
    ? (seg.match(/^'--el-color-primary',\s*brightBase\s*\)/) ? { dark: storeBrightRatio(), light: null } : null)
    : kind === 'mixShade'
      ? (() => {
          const m = seg.match(/isDark\.value\s*\?\s*mix\(brightBase, '(#[0-9a-f]{6})', ([\d.]+)\)\s*:\s*shade\(accent\.value, ([\d.]+)\)/i);
          return m ? { dark: num(m[2]), light: num(m[3]), bg: m[1].toLowerCase() } : null;
        })()
      : (() => {
          const m = seg.match(/isDark\.value\s*\?\s*mix\(brightBase, '(#[0-9a-f]{6})', ([\d.]+)\)\s*:\s*mix\(accent\.value, '#ffffff', ([\d.]+)\)/i);
          return m ? { dark: num(m[2]), light: num(m[3]), bg: m[1].toLowerCase() } : null;
        })();
  if (pair && kind === 'ident') pair.bg = storeBgTarget();
  return pair;
}

function storeBrightRatio() {
  const m = storeSrc.match(/const brightBase = isDark\.value \? mix\(accent\.value, '#ffffff', ([\d.]+)\) : accent\.value/);
  return m ? num(m[1]) : null;
}
function storeBgTarget() {
  const at = storeSrc.indexOf("'--el-color-primary-light-3'");
  const seg = at < 0 ? '' : storeSrc.slice(at, at + 200);
  const m = seg.match(/mix\(brightBase, '(#[0-9a-f]{6})'/i);
  return m ? m[1].toLowerCase() : null;
}

/** 其余五个 accent 变量：仍是老写法（三目 + 逐通道数组），按变量名抽 */
function initAccentCoef(varDecl, until) {
  const re = new RegExp(`var\\s+${varDecl}\\s*=[\\s\\S]*?${until}`);
  const m = initSrc.match(re);
  if (!m) return null;
  const darkM = m[0].match(/mixWhite\(r,\s*([\d.]+)\)/);
  const lightM = m[0].match(/shade\(r,\s*([\d.]+)\)/);
  return {
    dark: darkM ? parseFloat(darkM[1]) : null,
    light: lightM ? parseFloat(lightM[1]) : null,
  };
}
function storeAccentCoef(varName) {
  const bare = String(varName).replace(/^--/, '');
  if (bare === 'accent') {
    const m = storeSrc.match(/const base = isDark\.value \? mix\(accent\.value, '#ffffff', ([\d.]+)\) : accent\.value/);
    return m ? { dark: num(m[1]), light: null } : null;
  }
  const at = storeSrc.indexOf(`'${varName}'`);
  if (at < 0) return null;
  const seg = storeSrc.slice(at, at + 300);
  const m = seg.match(/isDark\.value\s*\?\s*mix\(accent\.value, '(#[0-9a-f]{6})', ([\d.]+)\)\s*:\s*mix\(accent\.value, '#ffffff', ([\d.]+)\)/i)
    || seg.match(/isDark\.value\s*\?\s*mix\(accent\.value, '#ffffff', ([\d.]+)\)\s*:\s*shade\(accent\.value, ([\d.]+)\)/i);
  if (!m) return null;
  if (m.length === 4) return { dark: num(m[2]), light: num(m[3]), bg: m[1].toLowerCase() };
  return { dark: num(m[1]), light: num(m[2]) };
}

/* ---------- accent 五变量：两边系数配对 ---------- */

/**
 * --accent-soft 的深色分支在 theme-init.js 里是逐通道手写算式（历史写法）：
 *   var soft = dark ? [Math.round(r * 0.18 + 18 * 0.82), ...] : [mixWhite(r, 0.9), ...]
 * 这里把「保留系数 / 目标通道值 / 混合比例 / 浅色比例」逐个抽出来，
 * 而不是拿一个裸 /0.82/ 去全文件乱匹配 —— 那才是旧版「透明度和注释里出现 0.82 也算过」的漏洞。
 */
function extractSoftInit() {
  const m = initSrc.match(
    /var soft = dark\s*\n?\s*\?\s*\[Math\.round\(r \* ([\d.]+) \+ (\d+) \* ([\d.]+)\), Math\.round\(g \* ([\d.]+) \+ (\d+) \* ([\d.]+)\), Math\.round\(b \* ([\d.]+) \+ (\d+) \* ([\d.]+)\)\]\s*\n?\s*:\s*\[mixWhite\(r, ([\d.]+)\), mixWhite\(g, ([\d.]+)\), mixWhite\(b, ([\d.]+)\)\]/
  );
  if (!m) return null;
  const [cr, tr, ar, cg, tg, ag, cb, tb, ab, lr, lg, lb] = m.slice(1).map(Number);
  return {
    ratios: [ar, ag, ab],
    keep: [cr, cg, cb],
    targets: [tr, tg, tb],
    light: lr === lg && lg === lb ? lr : NaN,
  };
}
const softInit = extractSoftInit();
const softStore = storeAccentCoef('--accent-soft');

const ACCENT_VARS = [
  { css: '--accent', initVar: 'a', until: "setProperty\\('--accent'" },
  { css: '--accent-deep', initVar: 'd', until: "setProperty\\('--accent-deep'" },
  { css: '--accent-text', initVar: 't', until: "setProperty\\('--accent-text'" },
  { css: '--accent-soft', initVar: 'soft', until: '' },
];

console.log('\n【--accent 五变量：系数从两边源码各抽一份，再配对比较】');
const initAccent = {};
const storeAccentV = {};
for (const { css, initVar, until } of ACCENT_VARS) {
  initAccent[css] = initVar === 'soft'
    ? (softInit ? { dark: softInit.ratios[0], light: softInit.light } : null)
    : initAccentCoef(initVar, until);
  storeAccentV[css] = storeAccentCoef(css);
  const i = initAccent[css];
  const s = storeAccentV[css];
  ok(
    `${css} 两边系数一致（init dark ${i?.dark} / light ${i?.light}｜store dark ${s?.dark} / light ${s?.light}）`,
    !!i && !!s && i.dark === s.dark && (i.light ?? null) === (s.light ?? null),
    '任一边漂移都会在这里对上号'
  );
}

/* --accent-soft 的逐通道配方（旧版是裸 /0.82/，任何 0.82 都能满足） */
ok('抽到 --accent-soft 深色的逐通道配方（不是全文件裸匹配 0.82）', !!softInit, JSON.stringify(softInit));
ok(
  '--accent-soft 深色比例两边一致，且「保留系数 = 1 - 混合比例」',
  !!softInit
    && !!softStore
    && softInit.ratios.every((a, i) => a === softStore.dark && Math.abs(softInit.keep[i] - (1 - a)) < 1e-9),
  `init ${JSON.stringify(softInit && softInit.ratios)} / store ${softStore && softStore.dark}`
);
ok(
  '--accent-soft 深色的目标色就是页底 #12110f（两边同色）',
  !!softInit
    && !!softStore
    && `#${softInit.targets.map((c) => c.toString(16).padStart(2, '0')).join('')}` === softStore.bg,
  `init ${JSON.stringify(softInit && softInit.targets)} / store ${softStore && softStore.bg}`
);

/* ---------- Element Plus 色阶：8 个变量，两边系数配对 ---------- */
const EP_VARS = [
  { css: '--el-color-primary', initVar: 'elPrimary', kind: 'ident' },
  { css: '--el-color-primary-dark-2', initVar: 'elDark2', kind: 'mixShade' },
  { css: '--el-color-primary-light-3', initVar: 'elLight3', kind: 'mixMix' },
  { css: '--el-color-primary-light-5', initVar: 'elLight5', kind: 'mixMix' },
  { css: '--el-color-primary-light-7', initVar: 'elLight7', kind: 'mixMix' },
  { css: '--el-color-primary-light-8', initVar: 'elLight8', kind: 'mixMix' },
  { css: '--el-color-primary-light-9', initVar: 'elLight9', kind: 'mixMix' },
];

console.log('\n【--el-color-primary* 七变量：theme-init 必须与 theme.js 同公式（缺陷 2）】');
const epInit = {};
const epStore = {};
for (const { css, initVar, kind } of EP_VARS) {
  epInit[css] = initCoef(initVar, kind);
  epStore[css] = storeCoef(css, kind);
  const i = epInit[css];
  const s = epStore[css];
  ok(
    `${css} 两边系数一致（dark ${i?.dark} / light ${i?.light === null ? '恒等' : i?.light}）`,
    !!i && !!s && i.dark === s.dark && (i.light ?? null) === (s.light ?? null),
    `init ${JSON.stringify(i)}｜store ${JSON.stringify(s)}`
  );
}
ok(
  '深色色阶链的深底目标色两边同为 #12110f',
  epStore['--el-color-primary-light-3']?.bg === epStore['--el-color-primary-light-7']?.bg
    && epStore['--el-color-primary-light-3']?.bg === '#12110f'
    && /var PAGE = \[18, 17, 15\];/.test(initSrc),
  `store ${epStore['--el-color-primary-light-3']?.bg}`
);

/* ---------- 结构性约束：色阶必须是单调递减的「变暗阶梯」 ---------- */
{
  const darkLadder = ['light-3', 'light-5', 'light-7', 'light-8', 'light-9'].map(
    (n) => epStore[`--el-color-primary-${n}`]?.dark
  );
  const lightLadder = ['light-3', 'light-5', 'light-7', 'light-8', 'light-9'].map(
    (n) => epStore[`--el-color-primary-${n}`]?.light
  );
  const monotone = (arr) => arr.every((v, i) => i === 0 || (typeof v === 'number' && v > arr[i - 1]));
  ok(`深色 light-3→9 的压暗比例单调递增（${darkLadder.join(' < ')}）`, monotone(darkLadder));
  ok(`浅色 light-3→9 的混白比例单调递增（${lightLadder.join(' < ')}）`, monotone(lightLadder));
  ok(
    '深色主色先提亮再加色阶（brightBase 比例 > 0）',
    typeof epStore['--el-color-primary']?.dark === 'number' && epStore['--el-color-primary'].dark > 0,
    String(epStore['--el-color-primary']?.dark)
  );
}

/* ---------- 汇总表：RATIO 里没有一个数是测试自己写的，全部来自两份源码 ---------- */
/**
 * 旧版的 RATIO 常量表是「测试自己写死一份、再拿它去比测试自己算的值」，
 * 于是「深色 0.28 == 深色 0.28」恒真。现在这张表是**抽取结果的汇总视图**：
 * 每一项都同时带 init / store 两条来源，两边不一致上面的断言已经报过。
 * 覆盖 --accent* 五变量 + --el-color-primary* 七变量（含 brightBase 的 0.1 与 dark-2）。
 */
const RATIO_TABLE = {
  ...Object.fromEntries(ACCENT_VARS.map(({ css }) => [css, { init: initAccent[css], store: storeAccentV[css] }])),
  ...Object.fromEntries(EP_VARS.map(({ css }) => [css, { init: epInit[css], store: epStore[css] }])),
};
{
  console.log('  抽取到的系数表（init｜store）：');
  for (const [k, v] of Object.entries(RATIO_TABLE)) {
    const show = (c) => (c ? `dark ${c.dark} / light ${c.light === null ? '恒等' : c.light}` : '抽取失败');
    console.log(`    ${k.padEnd(30)} init ${show(v.init)} ｜ store ${show(v.store)}`);
  }
  ok(
    '每一条系数都同时来自两边源码（12 个变量，无一条为空）',
    Object.keys(RATIO_TABLE).length === ACCENT_VARS.length + EP_VARS.length
      && Object.values(RATIO_TABLE).every((v) => !!v.init && !!v.store),
    Object.entries(RATIO_TABLE).filter(([, v]) => !v.init || !v.store).map(([k]) => k).join(', ')
  );
}

/* ---------- 三通道必须同系数（旧断言只看 r 通道） ---------- */
{
  const groups = [];
  const mixRe = /\[mixWhite\(r, ([\d.]+)\), mixWhite\(g, ([\d.]+)\), mixWhite\(b, ([\d.]+)\)\]/g;
  let mm;
  while ((mm = mixRe.exec(initSrc))) groups.push({ label: 'mixWhite 三通道组', m: mm });
  const shadeRe = /\[shade\(r, ([\d.]+)\), shade\(g, ([\d.]+)\), shade\(b, ([\d.]+)\)\]/g;
  while ((mm = shadeRe.exec(initSrc))) groups.push({ label: 'shade 三通道组', m: mm });
  const fillRe = /shade\(r, ([\d.]+)\) \+ ',\s*' \+ shade\(g, ([\d.]+)\) \+ ',\s*' \+ shade\(b, ([\d.]+)\)/g;
  while ((mm = fillRe.exec(initSrc))) groups.push({ label: '--accent-fill 拼接组', m: mm });

  ok('抽到全部三通道组（至少 5 组：accent/deep/text × 明暗 + fill）', groups.length >= 5, `实际 ${groups.length} 组`);
  const bad = [];
  groups.forEach(({ label, m }, i) => {
    if (!(m[1] === m[2] && m[2] === m[3])) bad.push(`${label}#${i} r=${m[1]} g=${m[2]} b=${m[3]}`);
  });
  ok('每一组三通道都用同一个系数（改单个通道会被抓到）', bad.length === 0, bad.join(' / ') || undefined);
}

/* ---------- 其余静态护栏 ---------- */
{
  const codeOnly = initSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ok('theme-init.js 里没有残留「深色调暗」写法（×0.72 那次缺陷）', !/\*\s*0\.72/.test(codeOnly));
  ok(
    'theme-init.js 里没有「一个系数通吃整色」的调暗写法',
    !/var\s+f\s*=\s*dark\s*\?/.test(codeOnly)
  );
  // 纯 ES5：该文件不进打包、没有 polyfill，出现箭头函数/const/let 就是运行时不兼容
  ok(
    'theme-init.js 仍是纯 ES5（无箭头函数 / const / let / 模板串）',
    !/=>/.test(codeOnly) && !/\b(?:const|let)\s+[A-Za-z_$]/.test(codeOnly) && !/`/.test(codeOnly)
  );
  ok(
    'theme.js 的 apply() 里写了 --accent-text（否则切主题后内联值残留）',
    /setProperty\(\s*'--accent-text'/.test(storeSrc)
  );
  // 关键回归锁：mix() 必须吃得下自己产出的 rgb() 字符串，否则深色色阶又是 NaN
  ok(
    'theme.js 的 mix() 接受 rgb() 输入（缺陷 1 的第一现场）',
    (() => {
      const v = mix('rgb(231, 104, 80)', '#12110f', 0.3);
      return v === 'rgb(167, 78, 61)' && !/NaN/.test(v);
    })(),
    mix('rgb(231, 104, 80)', '#12110f', 0.3)
  );
}

/* ============================================================
 * 三、逐字符比对：真的跑 theme-init，和 store 的公式对齐
 * ============================================================ */

/**
 * theme.js 侧：把 apply() 的**函数体原文**抽出来直接执行 —— 不在这里重写它的公式。
 *
 * 只补它需要的四个自由变量：isDark / accent（Pinia 的 ref，这里给 { value }）、
 * document（打桩 setProperty），以及从同一份源码抽出的 mix / shade。
 * 于是 store 侧跑的是**线上那份代码本身**，任何一处系数、目标色、链式顺序的改动
 * 都会直接反映到输出里。
 */
function runStoreApply(src, hex, isDark) {
  const applySrc = (src.match(/function apply\(\) \{[\s\S]*?\n  \}\n/) || [''])[0];
  if (!applySrc) throw new Error('在 src/stores/theme.js 里抽不到 apply() 的函数体');
  const props = {};
  const doc = {
    documentElement: {
      dataset: {},
      style: {
        setProperty: (name, value) => {
          props[name] = value;
        },
      },
    },
    querySelector: () => null, // meta[theme-color]，与色值无关
  };
  // eslint-disable-next-line no-new-func
  const make = new Function(
    'isDark',
    'accent',
    'document',
    'mix',
    'shade',
    `${applySrc}\n;return apply;`
  );
  make({ value: isDark }, { value: hex }, doc, mix, shade)();
  return props;
}

/** 线上 store 在给定强调色/主题下会写的全部变量 */
const storeValues = (hex, isDark) => runStoreApply(storeSrc, hex, isDark);

/** 色板直接从 store 的 THEME_COLORS 里取，不另抄一份（两份硬编码色板是历史问题） */
const paletteBlock = (storeSrc.match(/THEME_COLORS = \[[\s\S]*?\n\];/) || [''])[0];
const PALETTE = paletteBlock.match(/#[0-9a-f]{6}/gi) || [];
const INPUTS = [...PALETTE, '#111111', '#ffffff'].map((h) => h.toLowerCase());
const KEYS = [
  '--accent',
  '--accent-deep',
  '--accent-text',
  '--accent-fill',
  '--accent-soft',
  ...EP_VARS.map((e) => e.css),
];

console.log('\n【执行 theme-init.js（node:vm）vs 执行 theme.js 的颜色函数：逐字符比对】');
ok(`从 theme.js 的 THEME_COLORS 取到 8 个主题色`, PALETTE.length === 8, `${PALETTE.length} 个`);
ok(`首屏脚本被真的执行（每个输入写出 ${KEYS.length} 个变量）`, (() => {
  const r = runThemeInit(initSrc, '#e4573d', true);
  return KEYS.every((k) => typeof r[k] === 'string');
})(), JSON.stringify(runThemeInit(initSrc, '#e4573d', true)));

/**
 * 归一成 'rgb(r, g, b)' 再逐字符比：
 * 浅色主题的 `--accent` / `--el-color-primary` 在 store 侧**就是原样 hex**
 * （apply() 写 `base = accent.value`），而 theme-init 侧统一写成 rgb(...) ——
 * 两者对 CSS 完全等价，所以比较的是「数值」这一层的字符串相等。
 * 无法识别的值返回 null，会被当成不一致（并且不会掩盖 NaN）。
 */
function canon(value) {
  const s = String(value).trim();
  let m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) return `rgb(${m.slice(1).map((h) => parseInt(h, 16)).join(', ')})`;
  m = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (m) return `rgb(${m.slice(1).map(Number).join(', ')})`;
  return null;
}

/** 比对一组输入，返回不一致明细（也被末尾的反恒真自检复用） */
function compareAll(src, srcStore = storeSrc) {
  const bad = [];
  for (const hex of INPUTS) {
    for (const isDark of [false, true]) {
      const tag = `${hex} ${isDark ? 'dark' : 'light'}`;
      const got = runThemeInit(src, hex, isDark);
      const want = runStoreApply(srcStore, hex, isDark);
      for (const k of KEYS) {
        if (canon(got[k]) === null || /NaN|undefined|null/.test(String(got[k]))) {
          bad.push(`${tag} ${k}: 非法值 ${got[k]}`);
        } else if (canon(got[k]) !== canon(want[k])) {
          bad.push(`${tag} ${k}: init=${got[k]} store=${want[k]}`);
        }
      }
    }
  }
  return bad;
}
{
  const bad = compareAll(initSrc);
  ok(
    `${INPUTS.length * 2} 组「主题色 × 明暗」× ${KEYS.length} 个变量逐字符相同（含 --el-color-primary*）`,
    bad.length === 0,
    bad.slice(0, 8).join(' | ')
  );
}

/* ---------- 反恒真自检：改动 0.01 必须被抓到 ---------- */
console.log('\n【反恒真自检：故意改系数 0.01，同一套比对必须失败】');
{
  const bump = (n) => Number((n + 0.01).toFixed(2));
  // 1) 深色分支：light-7 的压暗比例
  const d7 = epInit['--el-color-primary-light-7']?.dark;
  const m1 = initSrc.replace(
    `var elLight7 = dark ? mixArr(elPrimary, PAGE, ${d7})`,
    `var elLight7 = dark ? mixArr(elPrimary, PAGE, ${bump(d7)})`
  );
  ok(
    `把 light-7 深色系数 ${d7} 改成 ${bump(d7)} 后必须判为不一致`,
    m1 !== initSrc && compareAll(m1).some((s) => /dark --el-color-primary-light-7/.test(s)),
    m1 === initSrc ? '替换没生效（抽取与源码写法已脱节）' : compareAll(m1).slice(0, 2).join(' | ')
  );
  // 2) 浅色分支：light-7 的混白比例
  const l7 = epInit['--el-color-primary-light-7']?.light;
  const m2 = initSrc.replace(
    `mixArr(baseRGB, WHITE, ${l7});`,
    `mixArr(baseRGB, WHITE, ${bump(l7)});`
  );
  ok(
    `把 light-7 浅色系数 ${l7} 改成 ${bump(l7)} 后必须判为不一致`,
    m2 !== initSrc && compareAll(m2).some((s) => /light --el-color-primary-light-7/.test(s)),
    m2 === initSrc ? '替换没生效' : compareAll(m2).slice(0, 2).join(' | ')
  );
  // 3) --accent-soft 的深色比例（旧版是裸 /0.82/，改 0.01 也照样通过）
  const as9 = softStore.dark;
  const m3 = initSrc.replace(`+ 18 * ${as9}`, `+ 18 * ${(as9 + 0.01).toFixed(2)}`);
  ok(
    `把 --accent-soft 深色比例 ${as9} 改成 ${(as9 + 0.01).toFixed(2)} 后必须判为不一致`,
    m3 !== initSrc && compareAll(m3).some((s) => /--accent-soft/.test(s)),
    m3 === initSrc ? '替换没生效' : compareAll(m3).slice(0, 2).join(' | ')
  );
  // 4) 反向：改 **store** 一侧的系数（证明被执行的 store 不是死的）。
  //    这里与 init 的当前取值无关地比较「改前 vs 改后」的 store 输出，
  //    这样无论 init 是否已经漂移，这条自检都只回答一个问题：store 侧确实在真跑。
  const s7 = epStore['--el-color-primary-light-7'] || {};
  const storeLine = `mix(brightBase, '#12110f', ${s7.dark}) : mix(accent.value, '#ffffff', ${s7.light})`;
  const m4 = storeSrc.replace(
    storeLine,
    `mix(brightBase, '#12110f', ${bump(s7.dark)}) : mix(accent.value, '#ffffff', ${s7.light})`
  );
  const before7 = runStoreApply(storeSrc, '#e4573d', true)['--el-color-primary-light-7'];
  const after7 = m4 === storeSrc ? before7 : runStoreApply(m4, '#e4573d', true)['--el-color-primary-light-7'];
  ok(
    `把 theme.js 的 light-7 深色系数 ${s7.dark} 改成 ${bump(s7.dark)} 后输出必须变化（${before7} → ${after7}）`,
    m4 !== storeSrc && before7 !== after7,
    m4 === storeSrc ? '替换没生效（store 侧的 apply() 抽取与源码写法已脱节）' : 'store 侧的执行是死的'
  );
}

/* ============================================================
 * 四、main.css 的字面量兜底值（与运行时的默认强调色对齐）
 * ============================================================ */
console.log('\n【main.css 的字面量兜底值】');
{
  const css = readFileSync(resolve(here, '../src/styles/main.css'), 'utf8');
  const cssToken = (name) => {
    const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    return m ? m[1] : null;
  };
  const rgbToHex = (rgbStr) => {
    const [r, g, b] = rgbStr.match(/\d+/g).map(Number);
    return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
  };
  const coral = '#e4573d';
  const wantFill = rgbToHex(storeValues(coral, false)['--accent-fill']);
  const wantText = rgbToHex(storeValues(coral, false)['--accent-text']);
  const wantDeep = rgbToHex(storeValues(coral, false)['--accent-deep']);

  ok(`main.css --accent-fill = shade(珊瑚) = ${wantFill}`, cssToken('accent-fill') === wantFill, `实际 ${cssToken('accent-fill')}`);
  ok(`main.css --accent-text = shade(珊瑚) = ${wantText}`, cssToken('accent-text') === wantText, `实际 ${cssToken('accent-text')}`);
  ok(`main.css --accent-deep = shade(珊瑚) = ${wantDeep}`, cssToken('accent-deep') === wantDeep, `实际 ${cssToken('accent-deep')}`);

  const darkFill = css.match(/\[data-theme='dark'\][\s\S]*?--accent-fill:\s*([^;]+);/);
  ok(
    '深色 --accent-fill 是字面量而不是 var(--accent-dark)',
    !!darkFill && !/-dark\)/.test(darkFill[1]),
    darkFill ? `实际 ${darkFill[1].trim()}` : '未找到'
  );
}

/* ============================================================
 * 四之二、main.css 的 --el-color-primary* 字面量 ↔ theme.js 公式（默认强调色）
 * ------------------------------------------------------------
 * 为什么需要这一段（这是「首帧跳色」的第三块拼图）：
 *   运行时唯一权威是 theme.js 的公式 —— theme-init.js 首帧写它、apply() 挂载后写它。
 *   但 main.css 里还有一份 `--el-color-primary*` 字面量，用于「JS 完全没执行」的兜底。
 *   旧文件里那份字面量是**第三套系数**（≈0.21/0.4/0.6/0.7/0.88，深色 primary 与
 *   light-9 又各自手调过），于是没设置过强调色的用户（绝大多数首访者）首帧看到
 *   一套颜色、Vue 一挂载就被覆盖成另一套。
 *
 * 这里做的事：把 main.css 的浅色块（:root）与深色块（[data-theme='dark']）里的
 * 七个 `--el-color-primary*` 抽出来，和「默认强调色 #e4573d 按 theme.js 公式算出的值」
 * **逐值比对，容差 0**（hex / rgb() 先归一）。CSS 一旦再漂移，这里就红。
 * 期望值不是测试自带的常量：它来自 runStoreApply() 真跑的那份 apply()。
 */
console.log('\n【CSS 一致性：main.css 的 --el-color-primary* 必须等于默认色按 theme.js 公式算出的值】');
{
  const css = readFileSync(resolve(here, '../src/styles/main.css'), 'utf8');
  const DEFAULT_ACCENT = '#e4573d';

  /**
   * 抽出「某选择器的样式块原文」。用「块内必须含有 --el-color-primary:」来定位，
   * 而不是「文件里第一个 :root / 第一个 [data-theme='dark']」——
   * 文件里别处也可能有同名块，靠顺序定位会抽错块、让断言恒真。
   * 取值型声明块没有嵌套花括号，所以 `[^}]*` 是安全的。
   */
  const cssBlock = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gi');
    let m;
    while ((m = re.exec(css))) {
      // 只认「块里真的定义了 --el-color-primary:」的那一块（同名选择器可能有多块）
      if (/(?:^|[\s;{])--el-color-primary\s*:/.test(m[1])) return m[1];
    }
    return null;
  };
  /** 在块里取某个变量的原始字面量（只认 hex / rgb()，别的一律 null → 判不一致） */
  const cssValueIn = (block, name) => {
    if (!block) return null;
    const m = block.match(new RegExp(`--${name}\\s*:\\s*([^;}]+)\\s*;`));
    return m ? m[1].trim() : null;
  };

  const blocks = [
    { label: ":root（浅色）", selector: ':root', isDark: false },
    { label: "[data-theme='dark']（深色）", selector: "[data-theme='dark']", isDark: true },
  ];

  for (const { label, selector, isDark } of blocks) {
    const block = cssBlock(selector);
    ok(`能在 main.css 里定位到含 --el-color-primary 的 ${label} 块`, !!block, block ? '' : '抽不到块，后面的逐值比对无从谈起');

    // 期望值：默认强调色跑一遍线上那份 apply()
    const want = storeValues(DEFAULT_ACCENT, isDark);
    const themeName = isDark ? 'deep' : 'light';
    const bad = [];
    for (const { css: name } of EP_VARS) {
      const got = cssValueIn(block, name.replace(/^--/, ''));
      const gotCanon = canon(got);
      const wantCanon = canon(want[name]);
      const same = gotCanon !== null && gotCanon === wantCanon;
      if (!same) bad.push(`${name}: css=${got ?? '缺失'} want=${want[name]}`);
      ok(
        `main.css ${label} ${name} = 默认色在${themeName === 'deep' ? '深' : '浅'}色下按 theme.js 公式算出的值（${want[name]}）`,
        same,
        `实际 css=${got ?? '缺失'} → 归一 ${gotCanon}；期望 ${wantCanon}`
      );
    }
    ok(
      `main.css ${label} 的七个 --el-color-primary* 与 theme.js 公式零漂移（容差 0）`,
      bad.length === 0,
      bad.join(' | ')
    );
  }

  // hex 输出约定：main.css 用 hex（与既有字面量风格一致），JS 用 rgb(r, g, b)
  const rawLight = cssValueIn(cssBlock(':root'), 'el-color-primary-light-7');
  ok(
    'main.css 的 EP 色阶仍是 hex 字面量（不是 rgb()/var()）',
    /^#[0-9a-f]{6}$/i.test(rawLight || ''),
    `实际 ${rawLight}`
  );

  // ---- theme-init 现在**无条件**写这七个变量：没有 localStorage 强调色也照写 ----
  // 旧实现把整段写变量关在「存过合法 accent」的 if 里，于是默认用户首帧没有内联值。
  const noAccent = runThemeInit(initSrc, null, false);
  ok(
    'theme-init 在 localStorage 没有强调色时也写全七个 --el-color-primary*',
    EP_VARS.every((e) => typeof noAccent[e.css] === 'string' && noAccent[e.css] !== ''),
    EP_VARS.filter((e) => typeof noAccent[e.css] !== 'string').map((e) => e.css).join(', ') || '全部缺失'
  );
  const noAccentDark = runThemeInit(initSrc, null, true);
  ok(
    '无强调色时的首帧 EP 色阶 == 默认色 #e4573d 的公式值（明暗两套都同源）',
    [false, true].every((isDark) => {
      const props = isDark ? noAccentDark : noAccent;
      const want = storeValues(DEFAULT_ACCENT, isDark);
      return EP_VARS.every((e) => canon(props[e.css]) === canon(want[e.css]));
    }),
    [false, true]
      .flatMap((isDark) => {
        const props = isDark ? noAccentDark : noAccent;
        const want = storeValues(DEFAULT_ACCENT, isDark);
        return EP_VARS.filter((e) => canon(props[e.css]) !== canon(want[e.css]))
          .map((e) => `${isDark ? 'dark' : 'light'} ${e.css}: init=${props[e.css]} want=${want[e.css]}`);
      })
      .slice(0, 6)
      .join(' | ')
  );
  // 无强调色时**也必须**写 --accent*：首帧与挂载后要同值。
  //
  // 曾经这里断言的是「无强调色时不写」（理由：五个变量交样式表管）。但样式表与
  // apply() 在深色下并不一致——main.css 是 `--accent: var(--accent-deep)`（混白 40%），
  // apply() 写混白 28%。没自定义过颜色的深色用户于是首帧 40%、挂载后 28%，
  // 与 EP 色阶是同一类残余跳变。现在两边无条件写，这条断言改为正向校验：
  // 五个变量都必须存在，且每个都与 store 对默认色的计算结果逐值相同。
  ok(
    '无强调色时 theme-init 也写全五个 --accent* 且与 store 默认色同值',
    [false, true].every((isDark) => {
      const props = isDark ? noAccentDark : noAccent;
      const want = storeValues(DEFAULT_ACCENT, isDark);
      return ACCENT_VARS.every((e) => typeof props[e.css] === 'string' && canon(props[e.css]) === canon(want[e.css]));
    }),
    Object.keys(noAccent).join(', ')
  );
}

/* ============================================================
 * 五、语义：算出来的颜色本身也要站得住（一致地错同样没意义）
 * ============================================================ */
console.log('\n【算出来的颜色必须满足对比度 / 亮度阶梯】');
{
  // 严格解析：既认 #rrggbb 也认 rgb(r, g, b)（store 浅色侧会写 hex）
  const toRgb = (s) => {
    const c = canon(s);
    return c ? c.match(/\d+/g).map(Number) : [NaN, NaN, NaN];
  };
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = (arr) => 0.2126 * lin(arr[0]) + 0.7152 * lin(arr[1]) + 0.0722 * lin(arr[2]);
  const ratio = (a, b) => {
    const x = lum(toRgb(a));
    const y = lum(toRgb(b));
    return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
  };
  const DARK_BG = '#12110f';
  const LIGHT_BG = '#f6f4f1';
  const d = storeValues('#e4573d', true);
  const l = storeValues('#e4573d', false);

  ok(`深色 --accent 对深底 >= 4.5:1（${ratio(d['--accent'], DARK_BG)}）`, ratio(d['--accent'], DARK_BG) >= 4.5);
  ok(`深色 --accent-text 对深底 >= 4.5:1（${ratio(d['--accent-text'], DARK_BG)}）`, ratio(d['--accent-text'], DARK_BG) >= 4.5);
  ok(`浅色 --accent-text 对页底 >= 4.5:1（${ratio(l['--accent-text'], LIGHT_BG)}）`, ratio(l['--accent-text'], LIGHT_BG) >= 4.5);
  ok(`--accent-fill 对白字 >= 4.5:1（${ratio(l['--accent-fill'], '#ffffff')}）`, ratio(l['--accent-fill'], '#ffffff') >= 4.5);
  ok(`深色 --accent-soft 只是略亮于深底（${ratio(d['--accent-soft'], DARK_BG)}:1，应 < 3）`, ratio(d['--accent-soft'], DARK_BG) < 3);

  // 缺陷 1 的验收：深色 light-9 必须是合法 rgb，且夹在「页底」与「主色」之间
  const l9 = d['--el-color-primary-light-9'];
  const prim = d['--el-color-primary'];
  const l9Lum = lum(toRgb(l9));
  const bgLum = lum(toRgb(DARK_BG));
  const primLum = lum(toRgb(prim));
  console.log(`    实测：--bg-dark ${DARK_BG} → --el-color-primary-light-9 ${l9} → --el-color-primary ${prim}`);
  ok(`深色 light-9 是合法 rgb(...) 且不含 NaN（${l9}）`, /^rgb\(\d+, \d+, \d+\)$/.test(l9));
  ok(`深色 light-9 比页底亮（${l9Lum.toFixed(5)} > ${bgLum.toFixed(5)}）`, l9Lum > bgLum);
  ok(`深色 light-9 明显暗于主色（${l9Lum.toFixed(5)} < ${primLum.toFixed(5)}）`, l9Lum < primLum);
  ok(`深色 主色 / light-9 的亮度差 >= 3:1（${ratio(prim, l9)}）`, ratio(prim, l9) >= 3);
  // 每个 light-N 的亮度必须随 N 递减（深色下是「越来越接近页底」）
  const ladder = ['--el-color-primary', '--el-color-primary-light-3', '--el-color-primary-light-5', '--el-color-primary-light-7', '--el-color-primary-light-8', '--el-color-primary-light-9'];
  ok(
    '深色色阶亮度逐级递减（主色 > light-3 > 5 > 7 > 8 > 9）',
    ladder.every((k, i) => i === 0 || lum(toRgb(d[k])) < lum(toRgb(d[ladder[i - 1]]))),
    ladder.map((k) => `${k.replace('--el-color-primary', 'primary')}=${lum(toRgb(d[k])).toFixed(4)}`).join(' ')
  );
  // light-9 与页底不能是同一个颜色（否则 EP 的 plain 按钮/表头与背景糊在一起）
  ok(`深色 light-9 与页底不是同色（${ratio(l9, DARK_BG)}:1 > 1）`, ratio(l9, DARK_BG) > 1);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
