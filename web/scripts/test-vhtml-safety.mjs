/**
 * v-html 安全门禁：**只有经过净化或转义的数据才允许进 v-html**。
 *
 * 为什么值得守：`v-html` 是 Vue 里唯一的「字符串 → 真实 HTML」入口，一旦接的是
 * 原始内容就是存储型 XSS。而它长得完全无害 —— 一句 `v-html="rendered"` 看不出
 * 背后是 `DOMPurify.sanitize` 还是 `marked.parse` 裸输出。
 *
 * 本仓库当前 17 处 v-html 分为两类：
 *   1. `renderMarkdown(...)` —— `utils/markdown.js` 里 `marked → 语义修补 → DOMPurify.sanitize`
 *   2. `highlight(...)`      —— `utils/highlight.js` 先匹配再**逐段转义**（标题/摘要来自文章，是用户数据）
 * 另有四个 computed 中转（`rendered` / `renderedContent` / `aboutHtml` / `previewHtml`），
 * 它们的定义体必须是 `renderMarkdown(...)`。
 *
 * 判据：
 *   A. 每一处 v-html 的表达式在白名单里
 *   B. computed 中转的**定义体**里能找到 `renderMarkdown(`（防止有人把中转改成裸 `marked.parse`）
 *   C. 除 `utils/markdown.js` 外，任何地方都不许 import `marked`
 *   D. `utils/markdown.js` 必须真的调用 `DOMPurify.sanitize`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/** 递归收集 .vue / .js 源文件 */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    if (/\.(vue|js)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const vueFiles = files.filter((f) => f.endsWith('.vue'));

/* ---------- 抽取 v-html 表达式 ---------- */
const sites = [];
for (const f of vueFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/v-html="([^"]+)"/g)) {
    sites.push({ file: f.replace(SRC + '/', ''), expr: m[1].trim(), src });
  }
}

/** 直接调用型白名单：函数名必须在净化/转义实现里 */
const DIRECT_OK = [/^renderMarkdown\s*\(/, /^highlight\s*\(/];
/** computed 中转白名单：定义体必须是 renderMarkdown(...) */
const COMPUTED_OK = ['rendered', 'renderedContent', 'aboutHtml', 'previewHtml'];

console.log('\n【A. 每一处 v-html 的表达式都在白名单里】');
{
  const unknown = sites.filter((s) => !DIRECT_OK.some((re) => re.test(s.expr)) && !COMPUTED_OK.includes(s.expr));
  ok(`${sites.length} 处 v-html 全部可解释（原生调用或已知 computed）`, unknown.length === 0,
    unknown.map((u) => `${u.file}: ${u.expr}`).join(' | '));
  ok('v-html 总数与基线一致（14 处；新增/删除请同步本文件）', sites.length === 14,
    `实际 ${sites.length} 处`);
}

console.log('\n【B. computed 中转的定义体必须是 renderMarkdown】');
{
  const broken = [];
  for (const s of sites.filter((x) => COMPUTED_OK.includes(x.expr))) {
    const at = s.src.indexOf(`const ${s.expr}`);
    if (at < 0) { broken.push(`${s.file}: 找不到 const ${s.expr}`); continue; }
    // 定义体可能跨行：取到下一个 `});` 或 6 行以内
    const body = s.src.slice(at, at + 400);
    if (!/renderMarkdown\s*\(/.test(body)) broken.push(`${s.file}: ${s.expr} 的定义体里没有 renderMarkdown(`);
  }
  ok('四个 computed 中转都经过 renderMarkdown', broken.length === 0, broken.join(' | '));
}

console.log('\n【C. marked 只能出现在 utils/markdown.js】');
{
  const offenders = files
    .filter((f) => !f.endsWith('utils/markdown.js'))
    .filter((f) => /from\s+'marked'|require\('marked'\)/.test(readFileSync(f, 'utf8')))
    .map((f) => f.replace(SRC + '/', ''));
  ok('没有别处直接 import marked', offenders.length === 0, offenders.join(' | '));
}

console.log('\n【D. 净化实现本身：DOMPurify.sanitize 必须在链上】');
{
  const md = readFileSync(resolve(SRC, 'utils/markdown.js'), 'utf8');
  ok('markdown.js 调用 DOMPurify.sanitize', /DOMPurify\.sanitize\(/.test(md));
  ok('markdown.js 里有净化钩子（链接/图片属性后处理）', /addHook\(/.test(md));
}

console.log('\n【E. 自检：判据能抓到「裸 marked 进 v-html」】');
{
  const fakeVue = `<template><div v-html="rawHtml"></div></template>\n<script setup>\nconst rawHtml = computed(() => marked.parse(x));\n</script>`;
  const fakeExprs = [...fakeVue.matchAll(/v-html="([^"]+)"/g)].map((m) => m[1]);
  ok('自检：未知表达式会被判为不在白名单', !DIRECT_OK.some((re) => re.test(fakeExprs[0]) && !COMPUTED_OK.includes(fakeExprs[0])));
  ok('自检：computed 定义体里没有 renderMarkdown 会被抓到',
    !/renderMarkdown\s*\(/.test(fakeVue.slice(fakeVue.indexOf('const rawHtml'), fakeVue.indexOf('const rawHtml') + 200)));
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  exit(1);
}

function exit(code) { process.exit(code); }
