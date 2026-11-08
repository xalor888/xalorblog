/**
 * 通用变异测试运行器。
 *
 * 为什么抽出来：第一版把「备份 → 注入 → 跑测试 → 恢复 → 统计」写死在
 * `mutation-sanitize.js` 里。第二个模块要用时只有变异清单不同，
 * 复制一份会让「恢复逻辑」出现两份 —— 而恢复逻辑一旦有 bug，会留下被改坏的源码。
 * 这种东西**只能有一份**。
 *
 * 三种结果要分清：
 *   ✓ 抓到     —— 测试红了，这条防线真的被测着
 *   ✗ 存活     —— 测试绿了，**这是盲区**，需要补断言
 *   ~ 等价变异 —— 改了代码但可观察行为不变（冗余防线），不算盲区
 *
 * 安全：每次变异都在 try/finally 里恢复原文件；进程退出/中断也会恢复。
 */

'use strict';

const { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } = require('fs');
const { spawnSync } = require('child_process');

/**
 * @param {object} opts
 * @param {string} opts.title      报告标题（模块名）
 * @param {string} opts.target     被变异的源码绝对路径
 * @param {string|string[]} opts.test 要跑的测试文件（可多个；**任一失败即算抓到**）
 * @param {Array<{id:string,desc:string,from:string,to:string,equivalent?:boolean}>} opts.mutations
 * @param {string} opts.root       spawn 的工作目录
 * @returns {{caught:number, survived:number, equivalent:number, gaps:Array}}
 */
function runMutations({ title, target, test, mutations, root }) {
  let caught = 0;
  let survived = 0;
  let equivalentCount = 0;
  const gaps = [];

  console.log(`\n=== ${title} 变异测试 ===`);
  console.log(`目标：${target.replace(root + '/', '')}`);
  const tests = Array.isArray(test) ? test : [test];
  for (const t of tests) console.log(`测试：${t.replace(root + '/', '')}`);
  console.log(`变异数：${mutations.length}\n`);

  /** 跑全部测试文件；任一失败即视为「抓到」 */
  const runAll = () => {
    for (const t of tests) {
      const r = spawnSync('node', [t], { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) return r;
    }
    return { status: 0, stdout: '' };
  };

  // 基线必须绿 —— 否则变异结果没有意义（红的基线 + 红的变异 = 分不清）
  const baseline = runAll();
  if (baseline.status !== 0) {
    console.error('✗ 基线测试未通过，无法进行变异测试');
    if (baseline.stdout) console.error(baseline.stdout.slice(-1200));
    return { caught: 0, survived: 0, equivalent: 0, gaps: [], baselineFailed: true };
  }
  console.log('✓ 基线通过\n');

  const original = readFileSync(target, 'utf8');
  const BACKUP = target + '.mutation-backup';
  copyFileSync(target, BACKUP);

  function restore() {
    try { writeFileSync(target, original); } catch (_) { /* ignore */ }
    try { if (existsSync(BACKUP)) unlinkSync(BACKUP); } catch (_) { /* ignore */ }
  }

  const onExit = () => restore();
  process.on('exit', onExit);
  const onSig = () => { restore(); process.exit(130); };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  try {
    for (const m of mutations) {
      const occurrences = original.split(m.from).length - 1;

      if (occurrences === 0) {
        console.log(`${m.id}  ✗ 变异点未命中（源码已变，需更新脚本）`);
        console.log(`     from: ${m.from.slice(0, 70)}`);
        survived++;
        gaps.push({ ...m, note: '变异点未命中' });
        continue;
      }
      if (occurrences > 1) {
        console.log(`${m.id}  ✗ 变异点不唯一（出现 ${occurrences} 次）`);
        survived++;
        gaps.push({ ...m, note: '变异点不唯一' });
        continue;
      }

      writeFileSync(target, original.replace(m.from, m.to));
      const r = runAll();
      writeFileSync(target, original);

      if (r.status !== 0) {
        caught++;
        console.log(`${m.id}  ✓ 被抓到 — ${m.desc}`);
      } else if (m.equivalent) {
        equivalentCount++;
        console.log(`${m.id}  ~ 等价变异（行为不变，不算盲区）— ${m.desc}`);
      } else {
        survived++;
        gaps.push(m);
        console.log(`${m.id}  ✗ **存活** — ${m.desc}`);
      }
    }
  } finally {
    restore();
    process.off('exit', onExit);
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }

  console.log(`\n结果：${caught} 抓到 / ${survived} 存活 / ${equivalentCount} 等价变异` +
    `（共 ${mutations.length}）`);

  if (survived > 0) {
    console.log('\n⚠ 存活变异 = 测试盲区。这些改动会改变行为，但现有测试发现不了：');
    for (const m of gaps) {
      console.log(`  - ${m.id} ${m.desc}${m.note ? `（${m.note}）` : ''}`);
    }
  } else {
    console.log('\n✓ 没有存活变异 —— 这套测试对该模块的关键防线是有效的');
    if (equivalentCount > 0) {
      console.log(`  （其中 ${equivalentCount} 条是等价变异：改了代码但行为不变，属于正常现象）`);
    }
  }

  return { caught, survived, equivalent: equivalentCount, gaps };
}

module.exports = { runMutations };
