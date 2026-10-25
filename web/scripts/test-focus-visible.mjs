/**
 * 键盘焦点可见性
 *
 * 为什么需要这个测试：`:focus { outline: none }` 是「去掉浏览器默认粗黑框」的
 * 常见写法，但它同时把**唯一的焦点指示**也去掉了。WCAG 2.4.7 要求键盘焦点
 * 必须可见 —— 键盘用户 Tab 到输入框时，如果只有 border-color 变化，
 * 在小字号旁几乎看不出来，等于不知道自己在哪。
 *
 * 本轮实测（真实 Tab 走查 5 个页面）发现：
 *   - 列表页搜索框、留言页昵称、留言内容：完全没有可见焦点指示
 *   - 页面数选择器：只有边框变色
 *
 * 更麻烦的是**特指度**：main.css 的全局 `:focus-visible` 是 (0,1,0)，
 * 而组件的 `.form-input[data-v-x] { outline: none }` 是 (0,2,0) —— 全局打不过。
 * 所以修复必须落在组件里，这个测试也就必须同时检查「全局兜底」和「组件内覆盖」。
 *
 * 用法：node scripts/test-focus-visible.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

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

/**
 * 判断某个文件的样式里，是否存在「可聚焦控件被灭了 outline 却没有任何
 * :focus-visible 补偿」的情况。
 *
 * 检查方式：找出所有声明 `outline: none|0` 的规则块，取其选择器；
 * 然后要求同一文件里存在对应的 `:focus-visible` 规则，或该选择器的
 * 祖先容器有 `:focus-within` 的可见指示。
 */
function auditOutlineSuppression(src, fileLabel) {
  const problems = [];

  // 收集所有「选择器 → 声明块」对
  const rules = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(src))) {
    rules.push({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }

  const killsOutline = rules.filter((r) => /outline\s*:\s*(none|0)\s*;/.test(r.body));
  const hasFocusVisible = rules.some((r) => r.sel.includes(':focus-visible'));
  const hasFocusWithinRing = rules.some(
    (r) => r.sel.includes(':focus-within') && /outline\s*:\s*\d/.test(r.body)
  );

  for (const r of killsOutline) {
    // 明确写在 :focus-visible 里的 outline:none 是正当的（用于把环挪给父容器）
    if (r.sel.includes(':focus-visible')) continue;
    problems.push({ file: fileLabel, sel: r.sel, hasFocusVisible, hasFocusWithinRing });
  }
  return problems;
}

console.log('\n【全局兜底】');
{
  const css = read('../src/styles/main.css');
  ok(
    ':focus-visible 全局规则给出可见 outline',
    /:focus-visible\s*\{[\s\S]{0,200}?outline:\s*2px solid/.test(css)
  );
  ok(
    '全局规则给输入框类显式补环（不能只指望通用规则）',
    /input:focus-visible[\s\S]{0,200}?outline:\s*2px solid/.test(css),
    '组件里的 outline:none 会在特指度上压过通用 :focus-visible'
  );
  ok(
    '外层容器代画焦点环时，内层输入框保持 outline:none',
    /\.search-input:focus-visible\s*\{[\s\S]{0,80}?outline:\s*none/.test(css),
    '否则会出现「双层环」'
  );
  ok(
    '.search-box 用 :focus-within 显示环',
    /\.search-box:focus-within\s*\{[\s\S]{0,200}?outline:\s*2px solid/.test(css)
  );
}

console.log('\n【组件内：灭掉 outline 的地方必须有补偿】');
{
  const files = [
    ['../src/views/site/Messages.vue', '留言页'],
    ['../src/components/site/CommentSection.vue', '评论区'],
    ['../src/views/site/ArticleList.vue', '文章列表'],
  ];
  for (const [path, label] of files) {
    const src = read(path);
    const problems = auditOutlineSuppression(src, label);
    ok(
      `${label}：每个 outline:none 都有 :focus-visible 补偿`,
      problems.length === 0,
      problems.map((p) => p.sel).join(' / ') || undefined
    );
  }
}

console.log('\n【关键控件逐个点名】');
{
  const messages = read('../src/views/site/Messages.vue');
  const comment = read('../src/components/site/CommentSection.vue');
  const list = read('../src/views/site/ArticleList.vue');

  ok(
    '留言页 .form-input / .form-textarea 有 :focus-visible 环',
    /\.form-input:focus-visible,\s*\n\.form-textarea:focus-visible\s*\{[\s\S]{0,160}?outline:\s*2px solid/.test(messages)
  );
  ok(
    '评论区 .form-input / .form-textarea 有 :focus-visible 环',
    /\.form-input:focus-visible,\s*\n\.form-textarea:focus-visible\s*\{[\s\S]{0,160}?outline:\s*2px solid/.test(comment)
  );
  ok(
    '每页条数选择器有 :focus-visible 环',
    /\.page-size-select:focus-visible\s*\{[\s\S]{0,120}?outline:\s*2px solid/.test(list)
  );

  // 基础规则里不该再留着裸的 outline:none（那会让同特指度的补偿失效）
  ok(
    '留言页输入框基础规则不再裸写 outline:none',
    !/\.form-input\s*\{[^}]*outline:\s*none/.test(messages)
  );
  ok(
    '评论区输入框基础规则不再裸写 outline:none',
    !/\.form-input\s*\{[^}]*outline:\s*none/.test(comment)
  );
}

console.log('\n【鼠标点击不应被焦点环打扰】');
{
  const css = read('../src/styles/main.css');
  // 用 :focus-visible 而不是 :focus —— 鼠标点输入框本来就有光标，再加环太吵
  ok(
    '输入框的环用 :focus-visible（不是 :focus）',
    /input:focus-visible/.test(css) && !/^input:focus\s*\{/m.test(css)
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
