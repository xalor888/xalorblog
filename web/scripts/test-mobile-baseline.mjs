/**
 * 移动端基线守卫（无需浏览器、无需设备）
 *
 * 这些规则全都是「在桌面模拟器里看不出来、真机上必然出问题」的那一类，
 * 所以只能用静态断言把它们钉死，避免以后重构时被顺手删掉：
 *
 *  1. viewport 必须带 viewport-fit=cover —— 否则 env(safe-area-inset-*) 全是 0，
 *     刘海屏 / Home 指示条区域的内容永远避不开。
 *  2. 绝不能出现 user-scalable=no / maximum-scale=1 —— 那是拿禁缩放掩盖
 *     「输入框字号 < 16px 导致 iOS 自动放大」的真问题，属于无障碍缺陷。
 *  3. -webkit-tap-highlight-color: transparent —— 否则每次点击闪一层灰蓝方块，
 *     这是「网页感」最响的信号。
 *  4. touch-action: manipulation —— 消掉双击缩放等待带来的点击延迟。
 *  5. 触摸设备输入框字号 ≥ 16px —— iOS 焦点进入 <16px 输入框会强制缩放且不退焦还原。
 *  6. 首屏头图用 svh 而不是 vh —— 100vh 是「地址栏收起后」的高度，首屏底部会被顶出去。
 *  7. 右下角浮层栈避让 Home 指示条（env(safe-area-inset-bottom)）。
 *  8. 内层滚动容器 overscroll-behavior: contain —— 滚到底不再把整页一起拖走。
 *
 * 用法：node scripts/test-mobile-baseline.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const read = (p) => readFileSync(resolve(web, p), 'utf8');

let pass = 0;
let fail = 0;

function ok(name, condition, hint) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${hint ? ` — ${hint}` : ''}`);
  }
}

const indexHtml = read('index.html');
const homeHtml = read('home.html');
const mainCss = read('src/styles/main.css');
const siteHome = read('src/views/site/Home.vue');

/* ---------- 1. viewport ---------- */
for (const [name, html] of [
  ['index.html', indexHtml],
  ['home.html', homeHtml],
]) {
  const m = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/i);
  ok(`${name} 有 viewport meta`, !!m);
  if (!m) continue;
  const content = m[1];
  ok(
    `${name} viewport 带 viewport-fit=cover（否则 safe-area 全为 0）`,
    /viewport-fit\s*=\s*cover/i.test(content),
    `当前：${content}`
  );
  ok(
    `${name} viewport 用 interactive-widget=resizes-content（安卓软键盘压布局而非盖住）`,
    /interactive-widget\s*=\s*resizes-content/i.test(content),
    `当前：${content}`
  );
}

/* ---------- 2. 禁缩放检查（全仓） ---------- */
for (const [name, html] of [
  ['index.html', indexHtml],
  ['home.html', homeHtml],
]) {
  ok(
    `${name} 未禁用用户缩放（无 user-scalable=no / maximum-scale=1）`,
    !/user-scalable\s*=\s*no/i.test(html) && !/maximum-scale\s*=\s*1(\.0)?["\s,;]/i.test(html)
  );
}

/* ---------- 3~5 & 8. main.css 基线 ---------- */
ok(
  'main.css 关掉点击高亮（-webkit-tap-highlight-color: transparent）',
  /-webkit-tap-highlight-color:\s*transparent/i.test(mainCss)
);
ok(
  'main.css 给控件声明 touch-action: manipulation',
  /touch-action:\s*manipulation/i.test(mainCss)
);
ok(
  'main.css 在触摸设备上把输入框字号提到 ≥16px（iOS 不再强制放大）',
  /@media\s*\(pointer:\s*coarse\)[\s\S]{0,400}?font-size:\s*(16px|1rem|100%)/i.test(mainCss),
  '需要一段 @media (pointer: coarse) 覆盖 input/textarea/select'
);
ok(
  'main.css 定义 safe-area token（--sat/--sab）',
  /--sat:\s*env\(safe-area-inset-top/i.test(mainCss) && /--sab:\s*env\(safe-area-inset-bottom/i.test(mainCss)
);
ok(
  'main.css 给控件声明 user-select: none（长按不选中按钮文字）',
  /user-select:\s*none/i.test(mainCss)
);

/* ---------- 6. 首屏头图用 svh ---------- */
ok(
  '头图高度用 100svh（100vh 会把首屏底部顶出可视区）',
  /--hero-h:\s*100svh/i.test(siteHome),
  'views/site/Home.vue 的 --hero-h 应为 100svh（并保留 100vh 兜底）'
);
ok(
  '头图保留 100vh 兜底（老浏览器无 svh 单位）',
  /--hero-h:\s*100vh/.test(siteHome)
);

/* ---------- 7. 浮层栈避让 Home 指示条 ---------- */
ok(
  '浮层栈右下角避让安全区（--sab / safe-area-inset）',
  /\.float-dock\s*\{[\s\S]{0,700}?(var\(--sab\)|safe-area-inset)/i.test(mainCss),
  '.float-dock 的 right/bottom 需要 calc(... + var(--sab))'
);

/* ---------- 8. 内层滚动容器 ---------- */
const scrollContainers = ['src/views/site/Layout.vue', 'src/views/site/ArticleDetail.vue'];
for (const f of scrollContainers) {
  if (!existsSync(resolve(web, f))) continue;
  const src = read(f);
  ok(
    `${f} 的内层滚动容器用 overscroll-behavior: contain`,
    /overscroll-behavior:\s*contain/i.test(src),
    '滚到底时不该把整页一起拖走'
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
