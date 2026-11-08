/**
 * 429 必须带 `Retry-After` —— 一个**运维与客户端都用得上**的响应头。
 *
 * 现状问题：8 处 429 里原来没有一处给出等待时长（有的文案写了「N 秒」，
 * 但那只有人能读，客户端与 CDN 读不到）。后果：
 *   - 前端只能立刻重试或随便定个时间，反而继续加重限流；
 *   - 反向代理/CDN 无法按标准退避；
 *   - 排查时也不知道这次限流窗口有多长。
 *
 * 判据：
 *   A. `src/routes` 里每一处 429 响应，在**同一个 handler 窗口内**都能看到
 *      `retryAfter(...)`（或显式 `Retry-After` 头）
 *   B. 助手本身正确：秒数向上取整、至少 1、写成字符串
 *   C. 自检：去掉那一行会让 A 组红（判据有效）
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { retryAfter } = require('../src/utils/response');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const ROUTES = path.join(__dirname, '..', 'src', 'routes');

console.log('\n【A. 每一处 429 都给了等待时长】');
{
  const offenders = [];
  const sites = [];
  for (const f of fs.readdirSync(ROUTES)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // 429 的两种写法：res.status(429).json(...) 与 fail(res, ..., 429)
      const is429 = /status\(\s*429\s*\)/.test(line) || /fail\(res,[\s\S]*?,\s*429\)/.test(line);
      if (!is429) return;
      sites.push(`${f}:${i + 1}`);
      // 前后 6 行窗口里必须有 retryAfter 或显式 Retry-After
      const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
      if (!/retryAfter\s*\(|Retry-After/.test(window)) offenders.push(`${f}:${i + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  ok(`扫到 ${sites.length} 处 429（含 fail(res,...,429) 写法）`, () => assert.ok(sites.length >= 10, `只扫到 ${sites.length} 处`));
  ok('每一处都带 retryAfter(...)', () => {
    assert.deepStrictEqual(offenders, [], offenders.join(' | '));
  });
}

console.log('\n【B. 助手本身：秒数取整、至少 1、字符串头】');
{
  const mkRes = () => ({ headers: {}, set(k, v) { this.headers[k] = v; } });
  ok('整数原样写入', () => {
    const res = mkRes();
    assert.strictEqual(retryAfter(res, 60), 60);
    assert.strictEqual(res.headers['Retry-After'], '60');
  });
  ok('小数向上取整（0.4 → 1，1.2 → 2）', () => {
    const res = mkRes();
    retryAfter(res, 0.4);
    assert.strictEqual(res.headers['Retry-After'], '1');
    retryAfter(res, 1.2);
    assert.strictEqual(res.headers['Retry-After'], '2');
  });
  ok('非法/负数被夹到 1（永不出现 0 或负数）', () => {
    const res = mkRes();
    retryAfter(res, -5);
    assert.strictEqual(res.headers['Retry-After'], '1');
    retryAfter(res, 'abc');
    assert.strictEqual(res.headers['Retry-After'], '1');
  });
  ok('写的是字符串（HTTP 头只能是字符串）', () => {
    const res = mkRes();
    retryAfter(res, 10);
    assert.strictEqual(typeof res.headers['Retry-After'], 'string');
  });
}

console.log('\n【C. 已知的 8 个 429 点清单与扫描一致】');
{
  // 10 处：articles×2（阅读限流 + 点赞）、notes×2、comments×2（重复内容 + 点赞）、
  // messages×1（重复内容）、home×1（摘要限流）、ai×1（并发）、auth×1（登录锁定）
  const KNOWN = [
    'ai.js', 'articles.js', 'articles.js', 'auth.js', 'comments.js', 'comments.js',
    'home.js', 'messages.js', 'notes.js', 'notes.js',
  ].sort();
  const actual = [];
  for (const f of fs.readdirSync(ROUTES)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');
    const n = (src.match(/status\(\s*429\s*\)/g) || []).length + (src.match(/,\s*429\)/g) || []).length;
    for (let i = 0; i < n; i++) actual.push(f);
  }
  actual.sort();
  const known = [...KNOWN].sort();
  ok(`总数仍是 10（新增限流点请同步本文件）`, () => {
    assert.strictEqual(actual.length, known.length, `实际 ${actual.length} 处：${actual.join(', ')}`);
  });
  ok('每一处都在清单里', () => {
    const missing = actual.filter((f, i) => actual[i] !== known[i]);
    assert.deepStrictEqual(missing, [], `清单不一致：${missing.join(', ')}`);
  });
}

console.log('\n【D. 自检：判据能抓到「漏写 retryAfter」】');
{
  const sample = [
    "router.post('/like', async (req, res) => {",
    "  if (flood) {",
    "    return fail(res, '太频繁', 429);",
    '  }',
    '});',
  ].join('\n');
  const lines = sample.split('\n');
  const hit = lines.some((l) => /fail\(res,[\s\S]*?,\s*429\)/.test(l));
  ok('自检：能识别 fail(res, …, 429) 这种写法', () => assert.ok(hit));
  const window = lines.slice(0, 4).join('\n');
  ok('自检：缺少 retryAfter 的窗口会被判为不合格', () => assert.ok(!/retryAfter\s*\(/.test(window)));
}

console.log(`\nretryAfter 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
