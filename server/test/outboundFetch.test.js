/**
 * 出站请求的重定向纪律 —— **SSRF 闸门之外的第二道门**。
 *
 * 保存设置时，AI base URL 会过 `netGuard.isPrivateUrl`（IP 字面量判内网直接拒）。
 * 但 `fetch()` 默认 **follow** 重定向：一个合法的公网地址可以 302 到
 * `169.254.169.254`（云元数据）或任意内网服务，于是「保存时合法」变成「运行时打内网」，
 * 而且响应内容会顺着文章预览回到攻击者手里。
 *
 * 判据：
 *   A. 任何以**用户可配置的 base URL** 为目标的 fetch，必须显式写 `redirect:`（'error' 或 'manual'）
 *   B. 其余 fetch 只允许指向**写死的常量地址**（https:// 字面量），由人工判断
 *   C. 现存清单必须与扫描结果一致 —— 新增一处出站请求时，本文件会红，强迫你想清楚它的重定向策略
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const SRC = path.join(__dirname, '..', 'src');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 抽每一处 `fetch(` 的调用窗口（到下一个 `);` 或 600 字符） */
function fetchSites() {
  const sites = [];
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/await fetch\(|= fetch\(/.test(line)) return;
      const window = lines.slice(i, i + 16).join('\n');
      // 用「文件 + 目标表达式」作为身份，而不是行号 —— 行号会随无关改动漂移，
      // 那种漂移会让门禁在完全无关的提交里变红（它只是想说「新增了出站请求」）。
      const expr = (line.split('fetch(')[1] || '').replace(/^\s*/, '').split(/[,\n]/)[0].replace(/`/g, '').trim().slice(0, 46);
      sites.push({ file: path.relative(SRC, file), line: i + 1, window, urlLine: line.trim(), id: `${path.relative(SRC, file)}|${expr}` });
    });
  }
  return sites;
}

const sites = fetchSites();

console.log('\n【A. 用户可配置地址：必须显式禁止重定向】');
{
  const dynamic = sites.filter((s) => /ai\.baseUrl|settings\.|req\.body|req\.query/.test(s.urlLine + s.window));
  ok(`找到 ${dynamic.length} 处「目标来自配置」的出站请求`, () => {
    assert.ok(dynamic.length >= 3, `只找到 ${dynamic.length} 处 —— 扫描可能失效（aiClient×2 / aiModeration / 后台图片抓取）`);
  });
  const unguarded = dynamic.filter((s) => !/redirect:\s*'error'|redirect:\s*'manual'|redirect:\s*'follow'/.test(s.window));
  // redirect:'follow' 也算「有写」，但下面单独断言不许用它
  ok('每一处都显式写了 redirect 策略', () => {
    assert.deepStrictEqual(unguarded.map((s) => `${s.file}:${s.line}`), [],
      `这些出站请求会跟随 302 打进内网：${unguarded.map((s) => `${s.file}:${s.line}`).join(', ')}`);
  });
  ok('策略不是 follow（follow 等于没写）', () => {
    const following = dynamic.filter((s) => /redirect:\s*'follow'/.test(s.window));
    assert.deepStrictEqual(following.map((s) => `${s.file}:${s.line}`), []);
  });
}

console.log('\n【B. 固定地址：允许，但必须写死成 https:// 字面量】');
{
  // 「固定」= 目标不是用户配置**且没有写 redirect 策略**；
  // 写了 redirect（如后台图片抓取的 'manual'）的属于「自己管好了」，不在这里要求 https 字面量。
  const fixed = sites.filter((s) => !/ai\.baseUrl|settings\.|req\.body|req\.query/.test(s.urlLine + s.window)
    && !/redirect:/.test(s.window));
  ok(`找到 ${fixed.length} 处固定地址请求`, () => assert.ok(fixed.length >= 3, `只找到 ${fixed.length} 处`));
  const notLiteral = fixed.filter((s) => !/https:\/\/|HTTP[A-Z_]*=|UPSTREAM/.test(s.urlLine));
  ok('每一处固定请求都指向写死的常量地址', () => {
    assert.deepStrictEqual(notLiteral.map((s) => `${s.file}:${s.line}`), [],
      notLiteral.map((s) => `${s.file}:${s.line} ${s.urlLine}`).join(' | '));
  });
}

console.log('\n【C. 清单与扫描结果一致（新增出站请求必须显式登记）】');
{
  // 用「文件 + 目标表达式前缀」标识，而不是行号或完整字符串：
  //   行号会随无关改动漂移；完整字符串里带引号/模板串，写进清单反而脆。
  const KNOWN_TARGETS = [
    'utils/aiClient.js|${ai.baseUrl}',
    'utils/aiModeration.js|${ai.baseUrl',
    "utils/webSearch.js|'https",
    'routes/admin.js|https://commons',
    'routes/admin.js|raw',
    'routes/hitokoto.js|UPSTREAM',
  ];
  const ids = sites.map((s) => s.id);
  ok(`出站请求总数仍是 ${sites.length}（新增/删除请同步本文件）`, () => {
    assert.strictEqual(sites.length, 7, `实际 ${sites.length} 处：${ids.join(', ')}`);
  });
  ok('每一处目标都登记过（按「文件 + 目标表达式」比对，不按行号）', () => {
    const unknown = ids.filter((id) => !KNOWN_TARGETS.some((k) => id.startsWith(k)));
    assert.deepStrictEqual(unknown, [], `未登记的出站请求：${unknown.join(', ')}`);
  });
  ok('清单里每个目标都能在源码里找到对应调用（防止清单变成化石）', () => {
    const missing = KNOWN_TARGETS.filter((k) => !ids.some((id) => id.startsWith(k)));
    assert.deepStrictEqual(missing, [], `清单里这些目标已经不存在：${missing.join(', ')}`);
  });
}

console.log('\n【D. 自检：判据能抓到「没写 redirect」的退化】');
{
  ok('自检：无 redirect 的窗口会被 A 组判为未防护', () => {
    const fake = "await fetch(`${ai.baseUrl}/x`, {\n  method: 'POST',\n});";
    assert.ok(!/redirect:/.test(fake));
  });
  ok('自检：redirect: manual 会被视为已写策略', () => {
    const fake = "await fetch(raw, { redirect: 'manual' });";
    assert.ok(/redirect:\s*'manual'/.test(fake));
  });
}

console.log(`\noutboundFetch 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
