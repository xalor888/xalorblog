/**
 * 正文刮取检测（无需服务器）
 */
const { noteArticleRead, resetScrapeGuard, MAX_UNIQUE, MAX_HITS } = require('../src/middleware/scrapeGuard');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

resetScrapeGuard();
const ip = '203.0.113.9';
const fp = 'b'.repeat(64);

for (let i = 1; i <= MAX_UNIQUE; i++) {
  const r = noteArticleRead(ip, fp, `slug-${i}`);
  assert(`第 ${i} 篇不同文章放行`, r.ok === true, JSON.stringify(r));
}
let r = noteArticleRead(ip, fp, 'slug-overflow');
assert('超过独立篇数被拒', r.ok === false && r.reason === 'scrape', JSON.stringify(r));

resetScrapeGuard();
r = noteArticleRead(ip, fp, 'same-slug');
assert('同篇首次放行', r.ok === true);
for (let i = 2; i <= MAX_HITS; i++) {
  r = noteArticleRead(ip, fp, 'same-slug');
}
assert(`同篇刷到 ${MAX_HITS} 次仍在窗内`, r.ok === true, JSON.stringify(r));
r = noteArticleRead(ip, fp, 'same-slug');
assert('同篇超过命中上限被拒', r.ok === false, JSON.stringify(r));

resetScrapeGuard();
r = noteArticleRead('198.51.100.1', fp, 'a');
const r2 = noteArticleRead('198.51.100.2', fp, 'a');
assert('不同 IP 窗口独立', r.ok && r2.ok);

resetScrapeGuard();
for (let i = 1; i <= MAX_UNIQUE; i++) {
  noteArticleRead(ip, `fp-${i}`, `slug-${i}`);
}
r = noteArticleRead(ip, 'fp-overflow', 'slug-overflow');
assert('同一 IP 轮换指纹仍计入刮取窗', r.ok === false, JSON.stringify(r));

console.log(`\nscrapeGuard 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
