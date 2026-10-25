/**
 * 设计 token 的对比度检查（WCAG AA）—— 离线、无需浏览器、可进构建门禁
 *
 * 为什么是「检查 token」而不是「检查页面」：
 * 页面级审计需要真实浏览器（computed style + 半透明层合成），只能手动跑。
 * 但本轮挖出的三处系统性偏差，根子都在 **token 层面**：
 *   1. 深色主题把主色 `shade()` 调暗 → 所有强调色文字 2.99:1
 *   2. `--accent-soft` 在深色下混白色 → 「亮字压亮底」1.33:1
 *   3. `--text-3` / `--accent`（作文字）/ 分类色恰好在 4.0–4.4 之间
 * 这些都能在这里用算术钉死：只要 token 值漂出 AA，构建就失败。
 * 页面级审计（scripts/a11y-check.mjs）作为手动补充，负责发现「没用 token 的散装颜色」。
 *
 * 用法：node scripts/test-contrast-tokens.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/styles/main.css'), 'utf8');

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

/* ---------- 对比度算术 ---------- */
const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const parseHex = (h) => {
  const s = String(h).trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
};
const lum = (hex) => {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const x = lum(a);
  const y = lum(b);
  return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
};

/** 从 css 里取一个 token 的字面值（只处理字面 hex，var() 引用不在此列） */
/**
 * 取 token 的字面 hex 值。
 * 注意：深色主题的取值都以 `-dark` 后缀定义在 :root 里（--bg-dark / --text-dark…），
 * 然后由 [data-theme='dark'] 映射过去。所以查深色时要直接查 `名字-dark`，
 * 而不是在 [data-theme='dark'] 块里找 `名字:`（那里是 var() 引用，没有字面值）。
 */
function token(name, scope = 'light') {
  const target = scope === 'dark' ? `${name}-dark` : name;
  const re = new RegExp(`${target}\\s*:\\s*(#[0-9a-fA-F]{3,8})`);
  const m = css.match(re);
  return m ? m[1] : null;
}

console.log('\n【浅色主题：正文与弱化文字】');
const bgLight = token('--bg');
const accentSoftLight = token('--accent-soft');
ok('取到 --bg', !!bgLight, bgLight || 'missing');
ok('取到 --accent-soft', !!accentSoftLight, accentSoftLight || 'missing');

{
  const text = token('--text');
  const text2 = token('--text-2');
  const text3 = token('--text-3');
  // 正文/次要文字要 4.5:1；弱化文字同样是小字（日期/字数/页脚），也是 4.5
  ok(`--text 对 --bg >= 7:1（当前 ${contrast(text, bgLight)}）`, contrast(text, bgLight) >= 7);
  ok(`--text-2 对 --bg >= 4.5:1（当前 ${contrast(text2, bgLight)}）`, contrast(text2, bgLight) >= 4.5);
  ok(`--text-3 对 --bg >= 4.5:1（当前 ${contrast(text3, bgLight)}）`, contrast(text3, bgLight) >= 4.5);
  // 玻璃卡片叠出来的底色比页底更灰，弱化文字在卡片里也要够
  ok(
    `--text-3 对玻璃卡片底 >= 4.5:1（当前 ${contrast(text3, '#ede9e0')}）`,
    contrast(text3, '#ede9e0') >= 4.5,
    '侧栏统计、字数这些恰好都在玻璃卡片里'
  );
}

console.log('\n【浅色主题：主色作文字 / 作底色 是两个不同要求】');
{
  const accent = token('--accent');
  const accentText = token('--accent-text');
  const accentFill = token('--accent-fill');
  const accentContrast = token('--accent-contrast');

  ok('--accent-text 存在（文字专用色）', !!accentText, '缺失会导致 114 处 color 退回 --accent');
  ok(
    `--accent-text 对 --bg >= 4.5:1（当前 ${contrast(accentText, bgLight)}）`,
    contrast(accentText, bgLight) >= 4.5
  );
  ok(
    `--accent-text 对 --accent-soft 淡底 >= 4.5:1（当前 ${contrast(accentText, accentSoftLight)}）`,
    contrast(accentText, accentSoftLight) >= 4.5,
    '公告标签正是压在 accent-soft 上'
  );
  ok('--accent-fill 存在（实心底专用色）', !!accentFill);
  ok(
    `--accent-contrast 对 --accent-fill >= 4.5:1（当前 ${contrast(accentContrast, accentFill)}）`,
    contrast(accentContrast, accentFill) >= 4.5,
    '按钮白字压在实心底上'
  );
  // 明确记录「原色不能直接当文字」这件事，避免以后有人把 --accent-text 删掉合并回去
  ok(
    `--accent 原色对页底确实不足 4.5（当前 ${contrast(accent, bgLight)}）—— 所以需要 --accent-text`,
    contrast(accent, bgLight) < 4.5
  );
}

console.log('\n【深色主题：方向必须相反】');
{
  const bgDark = token('--bg', 'dark');
  const textDark = token('--text', 'dark');
  const text2Dark = token('--text-2', 'dark');
  const text3Dark = token('--text-3', 'dark');
  const accentDeepDark = token('--accent-deep', 'dark');
  const accentSoftDark = token('--accent-soft', 'dark');

  ok('取到 --bg（深色）', !!bgDark, bgDark || 'missing');
  ok(`--text-dark 对深底 >= 7:1（当前 ${contrast(textDark, bgDark)}）`, contrast(textDark, bgDark) >= 7);
  ok(`--text-2-dark 对深底 >= 4.5:1（当前 ${contrast(text2Dark, bgDark)}）`, contrast(text2Dark, bgDark) >= 4.5);
  ok(`--text-3-dark 对深底 >= 4.5:1（当前 ${contrast(text3Dark, bgDark)}）`, contrast(text3Dark, bgDark) >= 4.5);
  ok(
    `--accent-deep-dark 对深底 >= 4.5:1（当前 ${contrast(accentDeepDark, bgDark)}）`,
    contrast(accentDeepDark, bgDark) >= 4.5,
    '深色主题的 --accent 指向它，等于所有强调色文字'
  );
  ok(
    `--accent-deep-dark 比浅色 --accent 更亮（深色要提亮，不是调暗）`,
    lum(accentDeepDark) > lum(token('--accent')),
    '本轮的真实 bug：JS 用 shade() 把它调暗了 28%'
  );
  ok(
    `--accent-soft-dark 对深底只略亮（不是混白出来的近原色，当前 ${contrast(accentSoftDark, bgDark)}）`,
    contrast(accentSoftDark, bgDark) < 3,
    '混白会让「亮字压亮底」，实测 1.33:1'
  );
}

console.log('\n【分类色：作文字时要有更深的一档】');
{
  const amberText = css.match(/--amber-text:\s*(#[0-9a-fA-F]{3,8})/);
  ok('--amber-text 存在', !!amberText);
  if (amberText) {
    ok(
      `--amber-text 对页底 >= 4.5:1（当前 ${contrast(amberText[1], bgLight)}）`,
      contrast(amberText[1], bgLight) >= 4.5,
      '琥珀原色只有 2.65:1，是四色里唯一严重不足的'
    );
  }
  // 浅色主题下按色值点名替换的四条规则都要在
  for (const [hex, label] of [
    ['c9900f', '琥珀'],
    ['c24b5e', '绛红'],
    ['217a5e', '黛绿'],
    ['2f6fb3', '黛蓝'],
  ]) {
    ok(
      `浅色主题有 [style*='${hex}']（${label}）的文字色覆盖`,
      css.includes(`[style*='${hex}']`),
      '分类色来自后端数据，只能按值匹配'
    );
  }
  ok(
    '深色主题有统一提亮分类色的规则',
    /\[data-theme='dark'\]\[data-theme\] \.grid-cat/.test(css),
    '且必须用双 [data-theme] 提特指度，否则打不过 scoped 的 .grid-cat[data-v-*]'
  );
}

console.log('\n【代码高亮：深色代码底上的可读性】');
{
  const mdCss = readFileSync(resolve(here, '../src/styles/markdown.css'), 'utf8');
  const comment = (mdCss.match(/\.hljs-comment,\s*\n\.hljs-quote\s*\{[\s\S]{0,400}?color:\s*(#[0-9a-fA-F]{3,8})/) || [])[1];
  ok('取到 .hljs-comment 颜色', !!comment);
  if (comment) {
    ok(
      `注释对代码底 (#1b1a17) >= 4.5:1（当前 ${contrast(comment, '#1b1a17')}）`,
      contrast(comment, '#1b1a17') >= 4.5,
      '注释是代码块里读得最多的部分之一'
    );
  }
  const lang = (mdCss.match(/\.code-lang\s*\{[\s\S]{0,240}?color:\s*(#[0-9a-fA-F]{3,8})/) || [])[1];
  ok('取到 .code-lang 颜色', !!lang);
  if (lang) {
    ok(
      `.code-lang 对块头底 (#252421) >= 4.5:1（当前 ${contrast(lang, '#252421')}）`,
      contrast(lang, '#252421') >= 4.5
    );
  }
}

console.log('\n【后台：Element Plus 默认灰与语义色的对比度】');
{
  // 后台是**信息密度高**的界面：表格、日志、表单全在密集阅读。
  // 审计五个页面时发现 18 项不达标，共同点是都用了 EP 的浅色档。
  ok(
    'EP 的 placeholder / secondary 变量被覆盖（变量级最可靠）',
    /--el-text-color-placeholder:\s*var\(--text-3\)/.test(css)
    && /--el-text-color-secondary:\s*var\(--text-2\)/.test(css)
  );
  ok(
    '这些变量覆盖作用在 .el-input/.el-select/.el-table 等容器上',
    /\.el-input,[\s\S]{0,200}?--el-text-color-placeholder/.test(css)
  );
  // 特指度：EP 自己用 `.el-textarea .el-input__count`（0,2,0），裸类名打不过
  ok(
    'input 字数统计用加一层祖先的选择器（否则被 EP 的 0,2,0 压过）',
    /\.el-input \.el-input__count,[\s\S]{0,120}?\.el-textarea \.el-input__count/.test(css)
  );
  ok(
    'warning 按钮底色压深（EP 原色 #e6a23c 配白字仅 2.19:1）',
    /--el-button-bg-color:\s*#a06614/.test(css)
  );
  ok(
    'success 按钮的描边/文字态用深绿（原 #67c23a 压浅绿底 2.08:1）',
    /\.el-button--success\.is-plain,[\s\S]{0,200}?color:\s*#2f7a37/.test(css)
  );
  ok(
    'danger 文字链接态用深红（原 #f56c6c 对白底 2.9:1）',
    /\.el-button\.is-link\.el-button--danger,[\s\S]{0,160}?color:\s*#a8323a/.test(css)
  );

  // 自定义徽标（安全日志的事件类型）
  const sec = readFileSync(resolve(here, '../src/views/admin/SecurityManage.vue'), 'utf8');
  ok('安全日志事件徽标文字已压深', /\.t-waf \{[^}]*color: #9e3548/.test(sec));
  ok('认证失败徽标（原 #c9900f 仅 2.46:1）已压深', /\.t-auth \{[^}]*color: #8a5a00/.test(sec));
}

console.log('\n【反向保护：这些地方必须继续用原色，不能也被换掉】');
{
  // 装饰用途（圆点/下划线/进度条/边框）应保持鲜艳的主色
  ok(
    '::selection 用 --accent-fill（选区是实心底 + 白字）',
    /::selection\s*\{[\s\S]{0,80}?background:\s*var\(--accent-fill\)/.test(css)
  );
  ok(
    '.btn-primary 用 --accent-fill',
    /\.btn-primary\s*\{[\s\S]{0,160}?background:\s*var\(--accent-fill\)/.test(css)
  );
  // 深浅主题各有一处 --accent-text 定义
  const count = (css.match(/--accent-text:/g) || []).length;
  ok('--accent-text 在浅色与深色各定义一次', count === 2, `实际 ${count} 处`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
