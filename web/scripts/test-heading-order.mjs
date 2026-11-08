/**
 * 标题层级门禁：**不许跳级，且每页只有一个 h1**。
 *
 * 为什么这件事值得一道门禁：标题层级是读屏用户的主要导航方式 ——
 * 他们按 `H` 键在标题间跳转，靠层级判断「这部分内容在主标题之下」。从 h1 直接跳到 h3，
 * 读屏用户会以为中间漏了一级；而**视觉上完全看不出区别**（h3 的字号是 CSS 决定的，
 * 我们本来就会把卡片标题样式化得像小标题）。
 *
 * 实测发现的真实案例：`views/site/Home.vue` 的 hero 是 h1，六个侧栏卡片标题全是 h3 ——
 * 中间没有 h2。已改成 h2，CSS 选择器同步改为 `.side-card h2`。
 *
 * 检查范围只含**模板里静态写出的** h1–h6。`v-html` 渲染的 markdown（文章正文）不算：
 * 那部分层级由 markdown 作者控制，属于内容问题而不是模板问题，
 * 而且正文里的 h1 会让「每页一个 h1」的规则大面积误报。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SRC = join(ROOT, 'src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

/** 取 <template> 段并剥掉 HTML 注释与 v-html 容器内部 */
function templateOf(src) {
  const m = src.match(/<template>([\s\S]*)<\/template>/);
  if (!m) return '';
  let t = m[1];
  // 剥 HTML 注释：否则「注释里提到 <h3>」会被当成真实标题
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  // 剥掉 v-html 的元素（markdown 正文，层级由内容决定）
  t = t.replace(/<([a-zA-Z0-9-]+)\b[^>]*\bv-html\b[^>]*>[\s\S]*?<\/\1>/g, '');
  return t;
}

/** 按出现顺序抽出 h1..h6 */
function headingsOf(tpl) {
  return [...tpl.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
}

const files = walk(SRC);

console.log('\n【每个视图最多一个 h1】');
{
  const bad = [];
  for (const f of files) {
    const hs = headingsOf(templateOf(readFileSync(f, 'utf8')));
    const h1Count = hs.filter((n) => n === 1).length;
    if (h1Count > 1) bad.push(`${relative(SRC, f)}: ${h1Count} 个 h1`);
  }
  ok('没有「一页多个 h1」的视图', bad.length === 0, bad.join(' | '));
}

console.log('\n【标题不许跳级（上一级不能比下一级小 2 以上）】');
{
  const bad = [];
  for (const f of files) {
    const hs = headingsOf(templateOf(readFileSync(f, 'utf8')));
    for (let i = 1; i < hs.length; i++) {
      if (hs[i] - hs[i - 1] >= 2) {
        bad.push(`${relative(SRC, f)}: h${hs[i - 1]} → h${hs[i]}`);
        break;
      }
    }
  }
  ok('没有跳级的视图', bad.length === 0, bad.join(' | '));
}

console.log('\n【回归：site/Home.vue 的侧栏卡片标题已改为 h2】');
{
  const home = readFileSync(join(SRC, 'views', 'site', 'Home.vue'), 'utf8');
  const tpl = templateOf(home);
  const hs = headingsOf(tpl);
  ok('模板里有 h1', hs.includes(1));
  ok('不再出现 h3（它已改成 h2）', !hs.includes(3), `实际层级: ${hs.join(',')}`);
  ok('h1 之后紧跟的是 h2（不是 h2 之后的 h3）',
    hs[1] === 2, `层级序列: ${hs.join(',')}`);
  ok('CSS 选择器已同步为 .side-card h2',
    /\.side-card h2\s*\{/.test(home) && !/\.side-card h3\s*\{/.test(home));
}

console.log('\n【扫描器自检：能抓到真问题】');
{
  const caseSkip = '<h1>A</h1><h3>B</h3>';
  const hs1 = headingsOf(caseSkip);
  ok('自检：h1 → h3 被判为跳级',
    hs1.some((v, i) => i > 0 && v - hs1[i - 1] >= 2));

  const caseOk = '<h1>A</h1><h2>B</h2><h3>C</h3>';
  const hs2 = headingsOf(caseOk);
  ok('自检：h1 → h2 → h3 不报',
    !hs2.some((v, i) => i > 0 && v - hs2[i - 1] >= 2));

  const caseMultiH1 = '<h1>A</h1><h1>B</h1>';
  ok('自检：两个 h1 被识别', headingsOf(caseMultiH1).filter((n) => n === 1).length === 2);

  // 注释里的标题不该被计入 —— 这条防的是「解释性注释反而触发门禁」
  const withComment = '<h1>A</h1><!-- <h3>说明</h3> --><h2>B</h2>';
  ok('自检：HTML 注释里的 <h3> 不计入',
    headingsOf(templateOf(`<template>${withComment}</template>`)).join(',') === '1,2');

  // v-html 容器里的标题不计入（那是 markdown 正文）
  const withVhtml = '<h1>A</h1><div v-html="md"><h5>正文标题</h5></div>';
  ok('自检：v-html 容器内的标题不计入',
    headingsOf(templateOf(`<template>${withVhtml}</template>`)).join(',') === '1');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
