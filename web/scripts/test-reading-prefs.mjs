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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
