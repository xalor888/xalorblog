/**
 * flaky 检测（web 侧）：把**涉及随机性/时钟**的门禁连跑 N 次，全绿才算稳定。
 *
 * 为什么需要：server 侧曾撞上过一条 13.5% 失败率的断言 ——
 * 单跑一次看不出来，连跑七次才撞一次，**人工抽查几乎必然放过**。
 * 那次的工具在 `server/scripts/check-flake.js`。web 侧同样有 36 道门禁，
 * 其中不少涉及 `Math.random` / `Date.now` / 集合去重断言，同样值得反复跑。
 *
 * 两侧判据保持一致：
 *   · 按**内容**挑文件（出现随机源，或出现「断言互不相同」的形态），不是按文件名
 *   · 任何一次失败 → 不稳定
 *   · **每次都失败且错误指向外部依赖** → 归为「需外部依赖」跳过
 *     （一个永远红的检查等于没有检查）
 *
 * 用法：
 *   node scripts/check-flake.mjs            # 每个文件 15 次
 *   node scripts/check-flake.mjs --runs 30
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, '..');

function argRuns() {
  const i = process.argv.indexOf('--runs');
  if (i === -1) return 15;
  const n = Number(process.argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : 15;
}
const RUNS = argRuns();

/** 按内容挑文件：随机源 + 「断言互不相同」的形态 */
function pickFiles() {
  const out = [];
  for (const f of readdirSync(here)) {
    if (!f.endsWith('.mjs')) continue;
    if (f === 'check-flake.mjs') continue;   // 跳过自己（否则无限递归）
    let src;
    try { src = readFileSync(join(here, f), 'utf8'); } catch (e) { continue; }

    const reasons = [];
    if (/Math\.random|randomBytes|randomUUID|crypto\.randomValues/.test(src)) reasons.push('调用随机源');
    if (/Date\.now\(\s*\)/.test(src) && /assert|ok\(/.test(src)) reasons.push('依赖真实时钟');
    if (/new Set\([^)]*\)\.size/.test(src) && /assert|ok\(/.test(src)) reasons.push('断言集合大小');
    if (reasons.length) out.push({ file: f, reasons });
  }
  return out;
}

/** 外部依赖相关的错误特征 */
const EXTERNAL_RE = /ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EADDRINUSE|ENOTFOUND|getaddrinfo|ENOSPC/i;

const targets = pickFiles();

console.log('\n=== flaky 检测（web 门禁）===');
console.log(`每文件 ${RUNS} 次\n`);

if (!targets.length) {
  console.log('（没有找到涉及随机性/时钟的门禁）');
  process.exit(0);
}

let unstable = 0;
let skipped = 0;
const unstableList = [];

for (const { file, reasons } of targets) {
  const path = join(here, file);
  process.stdout.write(`  ${file}（${reasons.join('、')}）… `);

  const failures = [];
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const r = spawnSync('node', [path], { cwd: WEB, encoding: 'utf8' });
    if (r.status !== 0) {
      const tail = (r.stdout || '').split('\n').filter((l) => l.includes('✗')).slice(0, 2).join(' | ');
      failures.push({ run: i + 1, detail: tail || (r.stderr || '').slice(0, 200) });
    }
  }
  const elapsed = Date.now() - t0;

  const allFailed = failures.length === RUNS;
  const externalDep = allFailed && failures.every((f) => EXTERNAL_RE.test(f.detail));

  if (externalDep) {
    console.log(`— 需外部依赖（${failures.length}/${RUNS}），跳过`);
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

console.log(`\n结果：${targets.length - unstable - skipped}/${targets.length - skipped} 个门禁稳定`
  + (skipped ? `（${skipped} 个需外部依赖，已跳过）` : ''));

// 自检：分类逻辑能区分三种情况
{
  const isExternal = (f) => EXTERNAL_RE.test(f.detail);
  const isAllFailed = (list, runs) => list.length === runs;
  const flaky = [{ run: 3, detail: '✗ 集合大小不符' }];
  const external = [{ run: 1, detail: 'Error: connect ECONNREFUSED 127.0.0.1:3080' }];

  console.log('\n【自检：分类逻辑能区分三种情况】');
  const check = (name, cond) => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}`);
    if (!cond) process.exitCode = 1;
  };
  check('无失败 → 稳定', isAllFailed([], 8) === false);
  check('偶发失败 → 不算外部依赖', !isExternal(flaky[0]));
  check('ECONNREFUSED → 算外部依赖', isExternal(external[0]));
  check('ENOSPC（磁盘满）也算环境问题', isExternal({ detail: 'ENOSPC: no space left' }));
  check('外部依赖必须每次都失败才算', !(isAllFailed(flaky, 8) && isExternal(flaky[0])));
}

if (unstable) {
  console.log('\n⚠ 不稳定 = 存在**概率性断言**。修法不是提高重试次数，而是换判据：');
  console.log('  · 「N 次采样互不相同」→「不是恒定不变」（size >= 2）');
  console.log('  · 依赖真实时钟 → 覆盖 Date.now 把时间钉死');
  console.log('  · 顺手算概率：12 个位置各 1.2% 叠起来就是 13.5%');
  process.exit(1);
}
console.log('\n✓ 全部稳定 —— 这些门禁的判据是确定性的');
