#!/usr/bin/env node
/**
 * flaky 检测：把**涉及随机性**的测试连跑 N 次，全绿才算稳定。
 *
 * 为什么需要它：第 92 轮我写了一条断言
 * ```js
 * for (let i = 0; i < 12; i++) assert.strictEqual(new Set(col).size, 3);
 * ```
 * 语义是「三次采样的每个字节位互不相同」。单看每一位都很合理（重复概率 1.2%），
 * 但 12 个字节位一乘就是 **13.5%** —— 每跑七次随机红一次。
 *
 * 而它**单跑一次是看不出来的**。我写的时候、以及后来跑通过好几次，都没发现问题；
 * 直到某次变异测试撞上，才暴露。
 *
 * 这类缺陷的特征是：**通过率高到足以骗过抽查**。所以唯一可靠的检测方式是
 * **连跑多次**——13.5% 的失败率跑 20 次，至少撞上一次的概率是 94%。
 *
 * 用法：
 *   node scripts/check-flake.js            # 默认每个文件跑 15 次
 *   node scripts/check-flake.js --runs 30  # 更彻底
 *
 * 注意：这个脚本**不进 `npm test`** —— 15 次 × 4 个文件约 15 秒，
 * 对每次提交都跑太重。放在 CI 的夜间阶段或改动随机性相关代码后手动跑。
 */

'use strict';

const { spawnSync } = require('child_process');
const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const TEST_DIR = join(ROOT, 'test');

/** 解析 --runs N */
function argRuns() {
  const i = process.argv.indexOf('--runs');
  if (i === -1) return 15;
  const n = Number(process.argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : 15;
}
const RUNS = argRuns();

/**
 * 哪些测试涉及随机性？
 *
 * 判据不是「文件名里有 random」，而是**文件内容里出现随机源**：
 * 被测代码的随机性会传导到测试的期望值上，这是 flake 的温床。
 * 同时把「断言互不相同」的文件也算进来 —— 那是上一轮 flake 的直接形态。
 */
function pickFiles() {
  const out = [];
  for (const f of readdirSync(TEST_DIR)) {
    if (!f.endsWith('.test.js')) continue;
    let src;
    try { src = readFileSync(join(TEST_DIR, f), 'utf8'); } catch (e) { continue; }

    const reasons = [];
    if (/randomBytes|Math\.random|randomUUID|generateSecret|encryptPayload/.test(src)) {
      reasons.push('调用随机源');
    }
    if (/new Set\([^)]*\)\.size\s*[,)]/.test(src) && /notStrictEqual|strictEqual|assert|ok\(/.test(src)) {
      reasons.push('断言「互不相同」');
    }
    if (reasons.length) out.push({ file: f, reasons });
  }
  return out;
}

const targets = pickFiles();

console.log('\n=== flaky 检测（反复跑随机性相关的测试）===');
console.log(`每文件 ${RUNS} 次\n`);

if (!targets.length) {
  console.log('（没有找到涉及随机性的测试文件）');
  process.exit(0);
}

let unstable = 0;
let skipped = 0;
const unstableList = [];

for (const { file, reasons } of targets) {
  const path = join(TEST_DIR, file);
  process.stdout.write(`  ${file}（${reasons.join('、')}）… `);

  const failures = [];
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const r = spawnSync('node', [path], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      // 抓失败项那几行，方便直接定位
      const tail = (r.stdout || '').split('\n').filter((l) => l.includes('✗')).slice(0, 3).join(' | ');
      failures.push({ run: i + 1, detail: tail || (r.stderr || '').slice(0, 200) });
    }
  }
  const elapsed = Date.now() - t0;

  /* ------------------------------------------------------------
   * 区分「不稳定」与「需要外部依赖」。
   *
   * `2fa.test.js` 是**集成测试**：它要连运行中的服务，所以每次都 ECONNREFUSED。
   * 那是 100% 失败，不是 flaky —— 但如果不区分，工具就会一直报红，
   * 而真正要抓的 flake 反而被淹没（**一个永远红的检查等于没有检查**）。
   *
   * 判据：**每次都失败，且错误与外部依赖相关** → 归为「需外部依赖，跳过」。
   * 只要有**任何一次**成功过，就说明环境是通的，剩下的失败才是真 flake。
   * ------------------------------------------------------------ */
  const allFailed = failures.length === RUNS;
  const externalDep = allFailed && failures.every((f) =>
    /ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EADDRINUSE|connect |getaddrinfo/i.test(f.detail));

  if (externalDep) {
    console.log(`— 需外部依赖（${failures.length}/${RUNS} 次失败：${failures[0].detail.slice(0, 60)}…），跳过`);
    skipped++;
    continue;
  }

  if (failures.length === 0) {
    console.log(`✓ ${RUNS}/${RUNS} 稳定（${elapsed}ms）`);
  } else {
    unstable++;
    unstableList.push({ file, failures });
    const rate = ((failures.length / RUNS) * 100).toFixed(0);
    console.log(`✗ **不稳定** —— ${failures.length}/${RUNS} 次失败（${rate}%，${elapsed}ms）`);
    for (const f of failures.slice(0, 3)) {
      console.log(`      第 ${f.run} 次：${f.detail}`);
    }
    if (failures.length > 3) console.log(`      … 另有 ${failures.length - 3} 次`);
  }
}

console.log(`\n结果：${targets.length - unstable - skipped}/${targets.length - skipped} 个文件稳定`
  + (skipped ? `（${skipped} 个需外部依赖，已跳过）` : ''));

// 自检：工具本身能抓到 flake —— 判据是「能区分稳定与不稳定」，
// 而不是「报绿」。这里验证分类逻辑的三种输入。
{
  const isExternal = (f) => /ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EADDRINUSE|connect |getaddrinfo/i.test(f.detail);
  const isAllFailed = (list, runs) => list.length === runs;
  const flaky = [{ run: 3, detail: '✗ IV 第 3 字节重复' }];
  const external = [{ run: 1, detail: 'Error: connect ECONNREFUSED 127.0.0.1:3000' }];

  console.log('\n【自检：分类逻辑能区分三种情况】');
  const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) process.exitCode = 1; };
  check('无失败 → 稳定', isAllFailed([], 8) === false);
  check('偶发失败 → 不算外部依赖', !isExternal(flaky[0]));
  check('ECONNREFUSED → 算外部依赖', isExternal(external[0]));
  check('外部依赖必须每次都失败才算（只失败一次仍算 flake）',
    !(isAllFailed(flaky, 8) && isExternal(flaky[0])));
  check('每次都失败 + ECONNREFUSED → 判为外部依赖',
    isAllFailed(external, 1) && isExternal(external[0]));
}
if (unstable) {
  console.log('\n⚠ 不稳定 = 存在**概率性断言**。修法不是提高重试次数，而是换判据：');
  console.log('  · 「N 次采样互不相同」→ 改成「不是恒定不变」（size >= 2）');
  console.log('  · 或把样本数提到足够大，使误报率降到可忽略');
  console.log('  · 顺手算一下概率再决定阈值 —— 12 个位置各 1.2% 叠起来就是 13.5%');
  process.exit(1);
}
console.log('\n✓ 全部稳定 —— 这些测试的判据是确定性的');
