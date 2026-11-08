/**
 * 护栏：**技术文章正文写安全示例不会被自己的 WAF 403**。
 *
 * 背景（2026-11-08 扫描面加权）：为了拦住「单发高危载荷」，网络面（query/path/header）
 * 的命中按 ×1.25 折算，于是单条 error 级规则在网络面就是 5 分 = 阈值。
 * 这条改动的**代价**全压在正文面 —— 一篇讲 SQL 注入的文章不能被自己拦下。
 *
 * 正文面其实有两道保险，本文件把两道都钉住：
 *   1. **参数豁免**（waf-rules.js PARAM_EXEMPT_GROUPS）：`content`/`title`/`summary` 等
 *      自由文本字段对全部规则组豁免 —— 讲注入的文章在 `content` 里一个规则都不参与。
 *   2. **扫描面权重**：非豁免的正文字段（`nickname`/`email`/`website` …）按 ×1 计权，
 *      单条 error 命中 = 4 分 < 阈值 5 → 放行；只有多条叠加才拦。
 * 而同样的字符串出现在 query/header 里，×1.25 后单发即达标。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const waf = require('../src/middleware/waf.js');
const { getConfig, DEFAULT_CONFIG } = require('../src/utils/securitySettings.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const THRESHOLD = Number(getConfig().anomalyThreshold) || DEFAULT_CONFIG.anomalyThreshold;

/** 一篇「真实技术文章」的正文：这些片段在安全博客里全是合法内容 */
const TECHNICAL_ARTICLE = [
  '# SQL 注入入门',
  '',
  "登录框里输入 `admin'--` 就能截断后面的条件，这是最经典的绕过方式。",
  '再看布尔盲注：`1 union select 1,2,3` 或者 `or 1=1`。',
  '',
  '## 命令注入',
  '',
  '如果过滤不严，`$(id)`、`` `id` ``、`|whoami` 都能执行。',
  '读取文件常用 `file:///etc/passwd`，目录上跳是 `../../etc/passwd`。',
  '',
  '```js',
  'const el = "<script>alert(1)</script>";',
  '```',
  '',
  'XSS 里 `javascript:alert(1)` 这种伪协议也值得提一句。',
].join('\n');

console.log('\n【A. 正文面第一道保险：自由文本字段整体豁免】');
ok('整篇技术文章放在 content 里零命中（不会被 403）', () => {
  const r = waf.scanRequestBody({ content: TECHNICAL_ARTICLE });
  assert.strictEqual(r.hits.length, 0,
    `content 字段不该有任何命中，实际命中=${JSON.stringify(r.hits.map((h) => [h.id, h.score]))}`);
  assert.strictEqual(r.score, 0);
});

ok('title / summary 同样豁免（后台标题里写 or 1=1 不会 403）', () => {
  for (const key of ['title', 'summary']) {
    const r = waf.scanRequestBody({ [key]: 'or 1=1' });
    assert.strictEqual(r.hits.length, 0, `${key} 字段产生了命中`);
  }
});

console.log('\n【B. 正文面第二道保险：非豁免字段单发不达标】');
ok('nickname 里写 admin\'-- → 有命中但低于阈值（放行）', () => {
  const r = waf.scanRequestBody({ nickname: "admin'--" });
  assert.ok(r.hits.length > 0, 'nickname 是非豁免字段，应当有命中 —— 否则豁免表扩张了');
  assert.ok(r.score < THRESHOLD, `得分 ${r.score} ≥ 阈值 ${THRESHOLD}`);
  for (const h of r.hits) {
    assert.strictEqual(h.scope, 'body', `命中 ${h.id} 的 scope=${h.scope}`);
    assert.strictEqual(h.w, h.score, `命中 ${h.id} 权重 ${h.w} ≠ 原始分 ${h.score}`);
  }
});

ok('website 里写伪协议 → body 面不按 ×1.25 计权', () => {
  const r = waf.scanRequestBody({ website: 'javascript:alert(1)' });
  assert.ok(r.score < THRESHOLD, `得分 ${r.score} ≥ 阈值 —— 正文面被按网络面计权了`);
});

console.log('\n【C. 网络面：同样的字符串单发即拦】');
const NET_CASES = [
  "admin'--",
  '1 union select 1,2,3',
  'javascript:alert(1)',
  'file:///etc/passwd',
  '../../etc/passwd',
];
for (const payload of NET_CASES) {
  ok(`query 侧「${payload}」达到阈值`, () => {
    const r = waf.scanAll(payload, 'query');
    assert.ok(r.score >= THRESHOLD, `得分 ${r.score} < 阈值 ${THRESHOLD}`);
    for (const h of r.hits) assert.strictEqual(h.scope, 'query');
  });
}

ok('header 侧的 CRLF 注入达到阈值', () => {
  const r = waf.scanAll('a\r\nSet-Cookie: evil=1', 'header');
  assert.ok(r.score >= THRESHOLD, `得分 ${r.score} < 阈值 ${THRESHOLD}`);
});

console.log('\n【D. 自由文本参数：搜索框不按网络面计权】');
ok('搜索框里敲同样的载荷不会 403（weight=1）', () => {
  const r = waf.scanAll("admin'--", 'query', { weight: 1 });
  assert.ok(r.score < THRESHOLD, `搜索框得分 ${r.score} ≥ 阈值`);
});

console.log('\n【E. 自检：护栏能抓到「取消分面」的回归】');
ok('自检：若非豁免正文字段也按 ×1.25，B 组那条会红', () => {
  const hits = waf.scanRequestBody({ nickname: "admin'--" }).hits;
  const simulated = hits.reduce((s, h) => s + h.score, 0) * 1.25;
  assert.ok(simulated >= THRESHOLD,
    `模拟值 ${simulated} 低于阈值 ${THRESHOLD} —— 语料太弱，护栏抓不到回归`);
});

ok('自检：网络面权重确实 >1（若有人改回 1，C 组会红）', () => {
  const netScore = waf.scanAll("admin'--", 'query').score;
  const rawScore = waf.scanAll("admin'--", 'query', { weight: 1 }).score;
  assert.ok(netScore > rawScore, `网络面 ${netScore} 未高于原始 ${rawScore}`);
  assert.strictEqual(netScore, rawScore * 1.25, `折算系数不是 1.25：${netScore} / ${rawScore}`);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
