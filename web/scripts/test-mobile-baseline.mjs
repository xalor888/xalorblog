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
  /@media\s*\(pointer:\s*coarse\)[\s\S]{0,900}?font-size:\s*16px/i.test(mainCss),
  '需要一段 @media (pointer: coarse) 覆盖 input/textarea/select'
);
// 组件的 scoped 选择器形如 .form-input[data-v-xxxx]，特指度高于全局 .form-input，
// 不加 !important 这条兜底实测不生效（表单仍是 14.4px），iOS 照旧放大。
// 断言钉住它，避免以后有人「清理 !important」时把这条静默删掉。
ok(
  '触摸设备输入框字号用 !important 压过 scoped 样式（否则实测不生效）',
  /@media\s*\(pointer:\s*coarse\)[\s\S]{0,1200}?font-size:\s*16px\s*!important/i.test(mainCss),
  'scoped .form-input[data-v-*] 特指度 (0,2,0) 会赢过全局 .form-input (0,1,0)'
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

// ---------- 9. 首屏视差：必须按帧收敛，且尊重 reduced-motion ----------
// 实测（浏览器）：未节流时 30 个 scroll 事件触发 33 次 transform 写入；
// 高刷屏上 scroll 派发比渲染帧还密，等于每次滚动都在重算样式。
{
  const js = siteHome.slice(siteHome.indexOf('<script setup>'), siteHome.indexOf('</script>'));
  ok(
    '头图视差用 requestAnimationFrame 收敛（每帧最多一次）',
    /requestAnimationFrame\(applyHeroParallax\)/.test(js),
    '原来每个 scroll 事件都直接写 style.transform'
  );
  ok(
    '视差有节流闸（连续 scroll 只排一次 rAF）',
    /if\s*\(heroTicking\)\s*return/.test(js)
  );
  ok(
    '节流位在函数入口复位（任何 return 路径都不会把它卡死）',
    /function applyHeroParallax\(\)\s*\{[\s\S]{0,300}?heroTicking\s*=\s*false/ .test(js),
    '漏掉复位会让视差滚过一屏后永久冻住'
  );
  ok(
    'reduced-motion 下关掉视差',
    /prefers-reduced-motion: reduce[\s\S]{0,200}?matches/.test(js) && /heroMotionAllowed/.test(js)
  );
  ok(
    '卸载时取消挂起的 rAF（防卸载后仍写 DOM）',
    /cancelAnimationFrame\(heroRafId\)/.test(js)
  );
  ok(
    '视差用 translate3d 走合成层（不是改 top/left 触发重排）',
    /translate3d\(0,/.test(js)
  );
}

// ---------- 10. 触摸目标：44×44 是下限，且热区不能被祖先裁掉 ----------
// 实测（390×844 视口逐页扫描）：公告关闭按钮只有 22×22，热榜切换 28×20，
// 表情按钮 30×30 —— 真机上几乎点不中。
{
  const layout = read('src/views/site/Layout.vue');
  const siteHomeCss = siteHome;
  const commentSection = read('src/components/site/CommentSection.vue');
  const messages = read('src/views/site/Messages.vue');

  ok(
    '公告关闭按钮的可点盒子是 44×44（视觉圆点仍 22px）',
    /\.ticker-close \{[\s\S]{0,1200}?width:\s*44px[\s\S]{0,200}?height:\s*44px/.test(layout),
    '原来 22×22，低于 iOS HIG / WCAG 2.5.5 的下限'
  );
  ok(
    '公告关闭按钮的视觉圆点用伪元素单独画（不把 44px 的空盒子画成实心）',
    /\.ticker-close::before\s*\{[\s\S]{0,300}?width:\s*22px/.test(layout)
  );
  // 这条是本次的真实事故：ticker 的 overflow:hidden 把 44px 热区上下各裁 4px，
  // 且 22px 的间距让热区上沿钻进导航条（z 更高）下面，上半部分永远点不到。
  ok(
    '公告条不裁剪子元素（否则热区被 overflow:hidden 切掉）',
    /\.ticker \{[\s\S]{0,1200}?overflow:\s*visible/.test(layout),
    'overflow:hidden 会把关闭按钮的 44px 热区裁掉'
  );
  ok(
    '公告条与导航之间留出热区越界的余量（33px，不是 22px）',
    /top:\s*calc\(var\(--nav-h\)\s*\+\s*33px/.test(layout),
    '22px 会让 44px 热区的上沿钻进导航条下方'
  );
  ok(
    '容器不再裁剪后，公告文字自己负责省略号',
    /\.ticker-text \{[\s\S]{0,400}?text-overflow:\s*ellipsis/.test(layout)
  );
  ok(
    '热榜切换按钮加高到可点（vertical padding 8px）',
    /\.hot-tabs button \{[\s\S]{0,300}?padding:\s*8px/.test(siteHomeCss)
  );
  ok(
    '标签云链接有最小高度 32px',
    /\.tag-cloud a \{[\s\S]{0,400}?min-height:\s*32px/.test(siteHomeCss)
  );
  ok(
    '评论表情按钮 ≥36px',
    /\.emoji-toggle \{[\s\S]{0,300}?width:\s*36px/.test(commentSection)
  );
  ok(
    '留言页表情按钮 ≥36px',
    /\.emoji-toggle \{[\s\S]{0,300}?width:\s*36px/.test(messages)
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
