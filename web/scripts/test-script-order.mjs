#!/usr/bin/env node
/**
 * check-script-order.mjs 的自测（回归护栏）。
 *
 * 为什么需要它：那个检查器是启发式的，很容易「看着通过其实瞎了」——
 * 历史上就出过两种静默漏报：
 *   1. 模板字符串字面量把 `${expr}` 里的真实代码整段吞掉；
 *   2. 声明行被 SKIP_RE 整行跳过，于是 `const a = b`（b 晚声明）永远发现不了。
 * 这两种情况检查器都会打印「✓ 检查通过」，比不检查更危险。
 * 所以每个用例都必须断言**退出码**，而不是只看输出。
 *
 * 用法：node scripts/test-script-order.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-script-order.mjs');

/** 用例：files = { 文件名: 内容 }，expectExit = 期望退出码 */
const cases = [
  {
    name: '顶层箭头函数体提前引用后声明的 ref',
    files: { 'A.js': 'const doubled = computed(() => count.value * 2)\nconst count = ref(0)\n' },
    expectExit: 1,
  },
  {
    name: '模板字符串 ${} 里的引用（旧版被整段吞掉）',
    files: { 'B.js': 'const tpl = `${late}`\nconst late = 1\n' },
    expectExit: 1,
  },
  {
    name: '.vue 里 <script setup lang="js"> 带额外属性（旧版提取不到正文）',
    files: { 'C.vue': '<script setup lang="js">\nconst a = helper(b)\nconst b = 1\n</script>\n<template><div/></template>\n' },
    expectExit: 1,
  },
  {
    name: '声明行右侧引用后声明变量（旧版整行跳过）',
    files: { 'D.js': 'const a = b + 1\nconst b = 2\n' },
    expectExit: 1,
  },
  {
    name: '函数体内引用后声明变量：合法，不得误报',
    files: { 'E.js': 'function init() { return later; }\nconst later = 1\n' },
    expectExit: 0,
  },
  {
    name: 'var / function 提升：合法，不得误报',
    files: { 'F.js': 'const x = helper()\nvar helper = function () { return 1; }\n' },
    expectExit: 0,
  },
  {
    name: '属性访问不算引用，不得误报',
    files: { 'G.js': 'const s = route.query.keyword\nconst keyword = 1\n' },
    expectExit: 0,
  },
  {
    name: '对象字面量的键不算引用，不得误报',
    files: { 'H.js': 'const stats = ref({ events: [], total: 0 })\nconst events = 1\n' },
    expectExit: 0,
  },
  {
    name: '字符串字面量里的同名文本不算引用',
    files: { 'I.js': "const s = 'pageSize 是每页条数'\nconst pageSize = 10\n" },
    expectExit: 0,
  },
  {
    name: '注释里的同名文本不算引用',
    files: { 'J.js': '// pageSize 稍后声明\nconst pageSize = 10\nconst n = 1\n' },
    expectExit: 0,
  },
  {
    name: '正常顺序：先声明后使用',
    files: { 'K.js': 'const count = ref(0)\nconst doubled = computed(() => count.value * 2)\n' },
    expectExit: 0,
  },
];

const root = mkdtempSync(path.join(tmpdir(), 'script-order-'));
let failed = 0;

for (const c of cases) {
  const dir = path.join(root, c.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(c.files)) {
    writeFileSync(path.join(dir, name), body, 'utf8');
  }
  let exit = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [script, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    exit = e.status ?? 1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const ok = exit === c.expectExit;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${c.name}（期望退出码 ${c.expectExit}，实际 ${exit}）`);
  if (!ok) console.log(`      ${out.split('\n').filter(Boolean).slice(0, 4).join('\n      ')}`);
}

rmSync(root, { recursive: true, force: true });

console.log(`\n结果：${cases.length - failed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
