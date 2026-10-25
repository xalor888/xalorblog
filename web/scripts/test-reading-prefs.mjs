/**
 * readingPrefs 的行为回归
 *
 * 重点不是「能存能取」，而是**坏输入不得污染样式**：
 * localStorage 里出现 ''、'abc'、'NaN'、越界值、旧版本写错的大小写时，
 * 必须安静地回落到默认值，而不是把 `font-size: NaNpx` 灌进 DOM。
 *
 * 用法：node scripts/test-reading-prefs.mjs
 */
import {
  FONT_SIZE,
  LINE_HEIGHT,
  READ_WIDTH,
  STORAGE_KEYS,
  loadFontSize,
  loadLineHeight,
  loadReadWidth,
  loadFontStyle,
  loadFocusMode,
  stepFontSize,
  stepLineHeight,
  stepReadWidth,
  saveFontSize,
  saveLineHeight,
  saveReadWidth,
  saveFontStyle,
  saveFocusMode,
  charsPerLine,
} from '../src/utils/readingPrefs.js';

let pass = 0;
let fail = 0;
/** 真值断言（用于「满足条件」而不是「等于某值」的场景） */
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, got, want) {
  if (Object.is(got, want)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} — 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }
}

/** 最小 localStorage 桩：可预置坏值、可断言写回了什么 */
function storageOf(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _dump: () => Object.fromEntries(map),
  };
}

console.log('\n【读取：坏值必须回落默认值】');
eq('空字符串 → 默认字号（Number("")===0 是个坑）', loadFontSize(storageOf({ [STORAGE_KEYS.fontSize]: '' })), FONT_SIZE.def);
eq('非数字 → 默认字号', loadFontSize(storageOf({ [STORAGE_KEYS.fontSize]: 'abc' })), FONT_SIZE.def);
eq('NaN 字面量 → 默认字号', loadFontSize(storageOf({ [STORAGE_KEYS.fontSize]: 'NaN' })), FONT_SIZE.def);
eq('Infinity → 默认字号', loadFontSize(storageOf({ [STORAGE_KEYS.fontSize]: 'Infinity' })), FONT_SIZE.def);
eq('越界偏大 → 夹到上界', loadFontSize(storageOf({ [STORAGE_KEYS.fontSize]: '999' })), FONT_SIZE.max);
eq('越界偏小 → 夹到下界', loadFontSize(storageOf({ [STORAGE_KEYS.fontSize]: '2' })), FONT_SIZE.min);
eq('合法值原样返回', loadFontSize(storageOf({ [STORAGE_KEYS.fontSize]: '18' })), 18);
eq('无记录 → 默认字号', loadFontSize(storageOf()), FONT_SIZE.def);

eq('行距坏值 → 默认', loadLineHeight(storageOf({ [STORAGE_KEYS.lineHeight]: 'wide' })), LINE_HEIGHT.def);
eq('行距越界 → 夹住', loadLineHeight(storageOf({ [STORAGE_KEYS.lineHeight]: '9' })), LINE_HEIGHT.max);
eq('行距浮点误差 → 2 位小数', loadLineHeight(storageOf({ [STORAGE_KEYS.lineHeight]: '1.9000000000000001' })), 1.9);

eq('版心坏值 → 默认', loadReadWidth(storageOf({ [STORAGE_KEYS.readWidth]: 'x' })), READ_WIDTH.def);
eq('版心越界 → 夹住', loadReadWidth(storageOf({ [STORAGE_KEYS.readWidth]: '3000' })), READ_WIDTH.max);

eq('字体风格大小写写错 → 回落 sans', loadFontStyle(storageOf({ [STORAGE_KEYS.fontStyle]: 'Serif' })), 'sans');
eq('字体风格 serif 生效', loadFontStyle(storageOf({ [STORAGE_KEYS.fontStyle]: 'serif' })), 'serif');

eq('沉浸模式只认 1', loadFocusMode(storageOf({ [STORAGE_KEYS.focusMode]: 'true' })), false);
eq('沉浸模式 1 生效', loadFocusMode(storageOf({ [STORAGE_KEYS.focusMode]: '1' })), true);

console.log('\n【storage 抛异常（隐私模式）不得炸】');
const throwing = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
};
eq('读取异常 → 默认字号', loadFontSize(throwing), FONT_SIZE.def);
eq('写入异常不抛（本次会话内仍生效）', (() => {
  try {
    saveFontSize(throwing, 18);
    return 'ok';
  } catch (e) {
    return 'threw';
  }
})(), 'ok');

console.log('\n【步进：到边界停住，不回绕】');
eq('字号 +1', stepFontSize(16, 1), 17);
eq('字号到上界停住', stepFontSize(FONT_SIZE.max, 1), FONT_SIZE.max);
eq('字号到下界停住', stepFontSize(FONT_SIZE.min, -1), FONT_SIZE.min);
eq('步进时坏输入按默认值起算', stepFontSize('oops', 1), FONT_SIZE.def + 1);
eq('行距 +1 步', stepLineHeight(1.9, 1), 2.05);
eq('行距到上界停住', stepLineHeight(LINE_HEIGHT.max, 1), LINE_HEIGHT.max);
eq('行距到下界停住', stepLineHeight(LINE_HEIGHT.min, -1), LINE_HEIGHT.min);
eq('版心 -1 步', stepReadWidth(760, -1), 700);
eq('版心到下界停住', stepReadWidth(READ_WIDTH.min, -1), READ_WIDTH.min);

console.log('\n【写入：越界值先夹再存】');
{
  const s = storageOf();
  saveFontSize(s, 999);
  eq('存的字号被夹到上界', s._dump()[STORAGE_KEYS.fontSize], String(FONT_SIZE.max));
}
{
  const s = storageOf();
  saveFontStyle(s, 'SERIF');
  eq('存的字体风格被规范化', s._dump()[STORAGE_KEYS.fontStyle], 'sans');
}
{
  const s = storageOf();
  saveFocusMode(s, true);
  eq('存的沉浸模式是 1', s._dump()[STORAGE_KEYS.focusMode], '1');
}
{
  const s = storageOf();
  saveLineHeight(s, 2.4);
  eq('存的行距可读回', loadLineHeight(s), 2.4);
}

console.log('\n【每行字数反馈】');
eq('760/16 → 约 48 字', charsPerLine(760, 16), 48);
eq('980/20 → 49 字', charsPerLine(980, 20), 49);
eq('坏输入不返回 NaN', Number.isFinite(charsPerLine('x', 'y')), true);

console.log('\n【接线：文章页真的用上了这些偏好】');
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const detail = readFileSync(resolve(here, '../src/views/site/ArticleDetail.vue'), 'utf8');
  const mainCss = readFileSync(resolve(here, '../src/styles/main.css'), 'utf8');

  eq('文章页从 readingPrefs 读字号（不再自己 Number(localStorage)）',
    /loadFontSize\(localStorage\)/.test(detail), true);
  eq('文章页不再有裸 Number(localStorage.getItem(...)) 的字号读取',
    /Number\(localStorage\.getItem\('xalor_font_size'\)\)/.test(detail), false);
  eq('行距接进正文行内样式', /lineHeight: String\(lineHeight\)/.test(detail), true);
  eq('版心接进正文行内样式', /maxWidth: readWidth \+ 'px'/.test(detail), true);
  eq('沉浸开关写回 storage', /saveFocusMode\(localStorage/.test(detail), true);
  eq('沉浸状态挂在 <html> 上', /documentElement\.dataset\.focus/.test(detail), true);
  eq('离开文章页会清掉沉浸状态（不带到首页）',
    /dataset\.focus = ''/.test(detail), true);

  eq('全局样式里隐藏导航/页脚/浮层栈/粒子层',
    /html\[data-focus='on'\] \.site-nav[\s\S]{0,300}html\[data-focus='on'\] \.ambient/.test(mainCss), true);
  eq('沉浸时正文卡片去掉玻璃材质', /html\[data-focus='on'\] \.detail-main/.test(mainCss), true);
  eq('减弱动画时沉浸切换不过渡',
    /prefers-reduced-motion[\s\S]{0,400}data-focus/.test(mainCss), true);

  eq('工具栏暴露行距控件', /changeLineHeight/.test(detail), true);
  eq('工具栏暴露版心控件', /changeReadWidth/.test(detail), true);
  eq('版心给出每行字数反馈', /charsPerLineValue/.test(detail), true);

  // 手机上 11 个控件需要 463px、可用只有 324px → 必须折叠成「沉浸 + Aa」两个按钮
  eq('窄屏把阅读设置收进 Aa 折叠按钮',
    /class="rt-btn rt-wide rt-toggle"/.test(detail), true);
  eq('Aa 按钮默认收起',
    /const toolbarExpanded = ref\(false\)/.test(detail), true);
  eq('收起态不渲染设置组（display:none 不占位也不可聚焦）',
    /\.reading-toolbar:not\(\.expanded\) \.rt-group[\s\S]{0,80}display:\s*none/.test(detail), true);
  // 选择器特指度坑：单写 .rt-toggle 会被后面的 .rt-btn{display:flex} 覆盖
  eq('桌面端隐藏 Aa 用 .rt-btn.rt-toggle（同级选择器会被覆盖）',
    /\.rt-btn\.rt-toggle\s*\{\s*display:\s*none/.test(detail), true);
  eq('正文版心不再做 max-width 过渡（每帧重排上万字）',
    /transition:\s*max-width/.test(detail), false);
}

console.log('\n【代码块复制 / 图片属性 / 目录滚动】');
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const md = readFileSync(resolve(here, '../src/utils/markdown.js'), 'utf8');
  const detail = readFileSync(resolve(here, '../src/views/site/ArticleDetail.vue'), 'utf8');
  const mdCss = readFileSync(resolve(here, '../src/styles/markdown.css'), 'utf8');

  // --- 代码块复制 ---
  // 旧实现丢弃了 execCommand 的返回值，并在 catch 里静默 → 非安全上下文点了没反应。
  eq('复制走 execCommand 时读取真实返回值（不能只看有没有抛异常）',
    /execCommand\(['"]copy['"]\)/.test(md) && /return\s+\w*(ok|success|result)/i.test(md), true);
  eq('复制成功与失败都有反馈（不是静默）',
    /已复制/.test(md) && /复制失败/.test(md), true);
  eq('复制反馈 1.6s 后复位',
    /COPY_FEEDBACK_MS\s*=\s*1600/.test(md), true);
  // innerText 会把缩进塌成单空格，代码块复制最要紧的正是缩进
  eq('读代码用 textContent 而不是 innerText（保缩进）',
    /textContent/.test(md) && !/code\.innerText/.test(md), true);
  eq('连点不会叠定时器（用 WeakMap 按按钮存）',
    /copyTimers\s*=\s*new WeakMap/.test(md), true);

  // --- 图片属性 ---
  eq('loading 与 decoding 独立补齐（eager 的图也要有 decoding）',
    /attrs\.loading === undefined/.test(md) && /attrs\.decoding === undefined/.test(md), true);
  // 语义修正：alt="" 是作者声明的装饰图，不该被 aria-label 覆盖
  eq('只给「连 alt 属性都没有」的图补 aria-label（alt="" 是装饰图）',
    /attrs\.alt === undefined/.test(md), true);
  eq('手写 aria-label / aria-hidden 不被覆盖',
    /attrs\['aria-label'\] === undefined/.test(md) && /attrs\['aria-hidden'\] === undefined/.test(md), true);
  eq('灯箱 caption 有 alt 缺失兜底', /aria-label/.test(detail), true);

  // --- 目录 ---
  // 真实缺陷：.toc-item 的 overflow:hidden 让 flex 子项的 min-height:auto 归零，
  // 27 项被压成 13.6px，总高恰好等于容器高 → scrollHeight===clientHeight → 永远滚不动
  eq('目录项不被 flex 压扁（flex-shrink: 0）',
    /\.toc-item[\s\S]{0,400}?flex-shrink:\s*0/.test(detail), true);
  eq('手机抽屉目录项同样锁死',
    /\.td-item[\s\S]{0,400}?flex-shrink:\s*0/.test(detail), true);
  eq('高亮项会滚入目录视口（block: nearest，不叠动画）',
    /scrollIntoView\(\{[^}]*block:\s*['"]nearest['"]/.test(detail), true);
  eq('目录跟随用 rAF 合并同帧多次高亮变化',
    /requestAnimationFrame/.test(detail), true);

  // --- 样式 ---
  eq('复制失败态有独立配色（不能长得像成功）',
    /\.code-copy\.copy-failed/.test(mdCss), true);
  // 实测：三个状态的文字宽度是 62 / 72 / 69px，5.2em 不够，必须 >=6em，
  // 且文件里不能有更窄的重复声明把它的效果覆盖掉（dist 里后写的赢）。
  eq('复制按钮锁宽 >=6em（实测「已复制 ✓」需 6.06em）',
    /\.code-copy[\s\S]{0,600}?min-width:\s*([6-9]|[1-9]\d)(\.\d+)?em/.test(mdCss), true);
  {
    const all = [...mdCss.matchAll(/min-width:\s*([\d.]+)em/g)].map((m) => Number(m[1]));
    const minEm = all.length ? Math.min(...all) : Infinity;
    ok('没有更窄的重复 min-width 覆盖它', minEm >= 6, all.length ? `最小 ${minEm}em` : '未声明');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
