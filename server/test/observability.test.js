/**
 * 可观测性门禁：**出问题时能不能查到**。
 *
 * 这个项目的日志只有两种形态：错误日志与安全事件。排查线上「慢」时缺一条关键证据 ——
 * 哪个请求慢、慢在哪、对应哪个 requestId。而单进程部署下，慢请求的表现是
 * 「别人访问变慢」，本机完全看不出异常。
 *
 * 本文件守三件事（全部静态判据 —— 不需要起服务）：
 *   A. 每个响应都带 `X-Request-Id`（请求追踪的锚点），且只透传**合法**的外部值
 *   B. 有慢请求日志，且带上 method / path / status / 耗时 / rid
 *   C. 慢日志**不记 query**（搜索词与回调参数可能含用户数据，日志不该成为副本）
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const src = readFileSync(join(__dirname, '..', 'src', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

console.log('\n【A. 请求 ID】');
ok('响应头写 X-Request-Id', () => {
  assert.ok(/res\.set\('X-Request-Id', req\.requestId\)/.test(src),
    '找不到写 X-Request-Id 的语句 —— 错误日志与访问日志就无法关联');
});
ok('外部传入的 X-Request-Id 只透传合法形态（限长限字符）', () => {
  assert.ok(/\[A-Za-z0-9-\]\{8,64\}/.test(src),
    '外部 X-Request-Id 的取值约束不见了 —— 可能被用来注入日志字段');
});
ok('缺省用随机 UUID 而不是自增序号（不可预测）', () => {
  assert.ok(/crypto\.randomUUID\(\)/.test(src), '找不到 crypto.randomUUID()');
});

console.log('\n【B. 慢请求日志】');
ok('存在慢请求阈值（可用环境变量调整，默认 500ms）', () => {
  const m = src.match(/const SLOW_REQUEST_MS = Number\(process\.env\.SLOW_REQUEST_MS \|\| (\d+)\)/);
  assert.ok(m, '找不到 SLOW_REQUEST_MS 定义');
  assert.strictEqual(Number(m[1]), 500, `默认阈值是 ${m[1]}ms，期望 500`);
});
ok('日志带 method / path / status / 耗时 / requestId', () => {
  const line = src.match(/console\.warn\(`\[slow\]([^`]+)`\)/);
  assert.ok(line, '找不到 [slow] 日志行');
  for (const field of ['${req.method}', '${req.path}', '${res.statusCode}', 'rid=${req.requestId}']) {
    assert.ok(line[1].includes(field), `日志缺少字段 ${field}：${line[1]}`);
  }
});
ok('只在超过阈值时记（不会把每条请求都记一遍）', () => {
  assert.ok(/if \(ms >= SLOW_REQUEST_MS\)/.test(src), '缺少阈值判断');
});
ok('用 hrtime 计时（不受系统时间调整影响）', () => {
  assert.ok(/process\.hrtime\.bigint\(\)/.test(src), '找不到 process.hrtime.bigint()');
});

console.log('\n【C. 隐私：慢日志不记 query】');
ok('日志只用 req.path，不用 req.originalUrl / req.url', () => {
  const slowLine = src.slice(src.indexOf('[slow]'), src.indexOf('[slow]') + 200);
  assert.ok(!/originalUrl|req\.url/.test(slowLine), '慢日志里出现了完整 URL（含 query）');
});

console.log('\n【D. 自检：判据能抓到退化】');
ok('自检：把 req.path 换成 req.originalUrl 会被 C 组抓到', () => {
  const fake = 'console.warn(`[slow] ${req.method} ${req.originalUrl} ${res.statusCode} rid=${req.requestId}`)';
  const body = fake.slice(fake.indexOf('[slow]'));
  assert.ok(/originalUrl/.test(body));
});
ok('自检：requestId 长度约束真的会拒绝过长值', () => {
  const re = /^[A-Za-z0-9-]{8,64}$/;
  assert.ok(!re.test('x'.repeat(65)), '65 字符应当被拒');
  assert.ok(re.test('abc12345'), '8 字符应当通过');
  assert.ok(!re.test('x'.repeat(7)), '7 字符应当被拒');
});

console.log(`\nobservability 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
