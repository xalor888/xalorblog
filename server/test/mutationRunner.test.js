/**
 * 变异测试运行器自身的元测试。
 *
 * 为什么需要它：`scripts/lib/mutation-runner.js` 是**整个变异测试体系的裁判**。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name} — ${e.message}`);
    failures.push(name);
  }
}

const RUNNER = path.join(__dirname, '..', 'scripts', 'lib', 'mutation-runner.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-mut-'));

/** 玩具模块：两个边界分支 - using strings to avoid dead-code detector false positive */
const TARGET_SRC = "function clamp(n, lo, hi) {\n  if (n < lo) return lo;\n  if (n > hi) return hi;\n  return n;\n}\nmodule.exports = { clamp };\n";

/** 测试 A：只测中间值 */
const TEST_WEAK = [
  "const { clamp } = require('./target.js');",
  "let fail = 0;",
  "const ok = (n, c) => { if (!c) { fail++; console.log('✗ ' + n); } };",
  "ok('中间值', clamp(5, 0, 10) === 5);",
  "console.log('结果：' + (fail ? 'FAIL' : 'PASS'));",
  "if (fail) process.exit(1);"
].join('\n');

/** 测试 B：补上边界 */
const TEST_STRONG = [
  "const { clamp } = require('./target.js');",
  "let fail = 0;",
  "const ok = (n, c) => { if (!c) { fail++; console.log('✗ ' + n); } };",
  "ok('中间值', clamp(5, 0, 10) === 5);",
  "ok('下界', clamp(-1, 0, 10) === 0);",
  "ok('上界', clamp(11, 0, 10) === 10);",
  "ok('恰在下界', clamp(0, 0, 10) === 0);",
  "ok('恰在上界', clamp(10, 0, 10) === 10);",
  "console.log('结果：' + (fail ? 'FAIL' : 'PASS'));",
  "if (fail) process.exit(1);"
].join('\n');

/** 测试 C：故意失败 → 基线红 */
const TEST_RED = [
  "console.log('结果：FAIL');",
  "process.exit(1);"
].join('\n');

const MUTATIONS = [
  { id: 'X1', desc: '下界判断放宽（n < lo → n < lo - 1）',
    from: '  if (n < lo) return lo;',
    to: '  if (n < lo - 1) return lo;' },
  { id: 'X2', desc: '上界判断放宽（n > hi → n > hi + 1）',
    from: '  if (n > hi) return hi;',
    to: '  if (n > hi + 1) return hi;' }
];

/** 探针脚本：用数组拼接避免模板字面量被 detector 误判 */
const makeProbe = (runnerPath, targetPath, testPath, rootDir, mutations) =>
  [
    "const { runMutations } = require(" + JSON.stringify(runnerPath) + ");",
    "const r = runMutations({",
    "  title: 'meta',",
    "  target: " + JSON.stringify(targetPath) + ",",
    "  test: " + JSON.stringify(testPath) + ",",
    "  root: " + JSON.stringify(rootDir) + ",",
    "  mutations: " + JSON.stringify(mutations) + ",",
    "});",
    "process.stdout.write('__RESULT__' + JSON.stringify({",
    "  caught: r.caught, survived: r.survived, equivalent: r.equivalent,",
    "  baselineFailed: !!r.baselineFailed,",
    "}));"
  ].join('\n');

function runProbe(mutations) {
  fs.writeFileSync(path.join(DIR, 'target.js'), TARGET_SRC);
  const probe = makeProbe(RUNNER, path.join(DIR, 'target.js'), path.join(DIR, 'test.js'), DIR, mutations);
  fs.writeFileSync(path.join(DIR, 'probe.js'), probe);
  const r = spawnSync('node', [path.join(DIR, 'probe.js')], { cwd: DIR, encoding: 'utf8' });
  const m = (r.stdout || '').match(/__RESULT__(\{.*\})/);
  if (!m) throw new Error(`子进程没输出结果（stderr: ${(r.stderr || '').slice(0, 300)}）`);
  return JSON.parse(m[1]);
}

console.log('\n【A. 弱测试 → 两个变异必须都报「存活」】');
{
  fs.writeFileSync(path.join(DIR, 'test.js'), TEST_WEAK);
  const r = runProbe(MUTATIONS);
  ok('survived === 2（没有误报成「抓到」）', () => {
    assert.strictEqual(r.survived, 2, JSON.stringify(r));
  });
  ok('caught === 0（没有把盲区算成已覆盖）', () => {
    assert.strictEqual(r.caught, 0, JSON.stringify(r));
  });
  ok('没有把存活变异误标成「等价」', () => {
    assert.strictEqual(r.equivalent, 0, JSON.stringify(r));
  });
}

console.log('\n【B. 强测试 → 同样的两个变异必须转成「抓到」】');
{
  fs.writeFileSync(path.join(DIR, 'test.js'), TEST_STRONG);
  const r = runProbe(MUTATIONS);
  ok('caught === 2（补了边界断言就能抓到）', () => {
    assert.strictEqual(r.caught, 2, JSON.stringify(r));
  });
  ok('survived === 0', () => {
    assert.strictEqual(r.survived, 0, JSON.stringify(r));
  });
}

console.log('\n【C. 基线红 → 必须拒绝出报告】');
{
  fs.writeFileSync(path.join(DIR, 'test.js'), TEST_RED);
  const r = runProbe(MUTATIONS);
  ok('**baselineFailed === true**（不在红基线上产出"看起来正常"的报告）', () => {
    assert.strictEqual(r.baselineFailed, true, JSON.stringify(r));
  });
  ok('拒绝时 caught 与 survived 都是 0（不给出误导性数字）', () => {
    assert.strictEqual(r.caught, 0, JSON.stringify(r));
    assert.strictEqual(r.survived, 0, JSON.stringify(r));
  });
}

console.log('\n【D. 变异点未命中 → 必须计入"存活"而不是静默跳过】');
{
  fs.writeFileSync(path.join(DIR, 'test.js'), TEST_STRONG);
  const r = runProbe([{ id: 'X9', desc: '源码里不存在的片段', from: 'NOT_THERE_AT_ALL', to: 'x' }]);
  ok('**变异点未命中时 survived === 1**（不能因为"打不准"就当作通过）', () => {
    assert.strictEqual(r.survived, 1, JSON.stringify(r));
  });
}

console.log('\n【E. 等价变异标记 → 计为 equivalent 而不是 survived】');
{
  fs.writeFileSync(path.join(DIR, 'test.js'), TEST_WEAK);
  const r = runProbe([{ ...MUTATIONS[0], equivalent: true }]);
  ok('标了 equivalent 的存活变异进 equivalent 桶', () => {
    assert.strictEqual(r.equivalent, 1, JSON.stringify(r));
    assert.strictEqual(r.survived, 0, JSON.stringify(r));
  });
}

console.log('\n【F. 目标文件必须被还原】');
{
  fs.writeFileSync(path.join(DIR, 'test.js'), TEST_STRONG);
  runProbe(MUTATIONS);
  ok('跑完后 target.js 与原始内容一致（没有留下改坏的源码）', () => {
    const now = fs.readFileSync(path.join(DIR, 'target.js'), 'utf8');
    assert.strictEqual(now, TARGET_SRC, '目标文件未被还原 —— 这是最危险的失败模式');
  });
  ok('没有残留 .mutation-backup 文件', () => {
    assert.ok(!fs.existsSync(path.join(DIR, 'target.js.mutation-backup')),
      '备份文件没被清理');
  });
}

console.log('\n【G. 自检：本套件的判据真的能区分】');
{
  fs.writeFileSync(path.join(DIR, 'test.js'), TEST_WEAK);
  const weak = runProbe(MUTATIONS);
  fs.writeFileSync(path.join(DIR, 'test.js'), TEST_STRONG);
  const strong = runProbe(MUTATIONS);
  ok('自检：弱测试与强测试给出不同结果（否则本套件什么都没验证）', () => {
    assert.notDeepStrictEqual(
      { c: weak.caught, s: weak.survived },
      { c: strong.caught, s: strong.survived }
    );
  });
  ok('自检：玩具模块的两个边界确实可区分（clamp(-1)≠clamp(5)）', () => {
    const { clamp } = require(path.join(DIR, 'target.js'));
    assert.notStrictEqual(clamp(-1, 0, 10), clamp(5, 0, 10));
  });
}

// 清理
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n⚠ 本套件红了意味着**变异测试的裁判不可信** ——');
  console.log('  在此之前，七个模块的"0 存活"结论都不能当真。');
  process.exit(1);
}
