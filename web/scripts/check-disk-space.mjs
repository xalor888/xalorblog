/**
 * 磁盘空间门禁：**构建开始前就告诉你会不会写不下**。
 *
 * 为什么需要：曾有一次 `npm run build` 失败，报的是
 * ```
 * Error: ENOSPC: no space left on device, write
 * ```
 * 这条信息**指向完全错误的方向**：它看起来像「某个文件写失败」，
 * 而实际原因是系统盘只剩 4.4G（460G 盘用了 429G）。
 * 我为此查了 `df`、`du`、临时文件、项目缓存 —— 花了十几分钟才定位。
 *
 * 更糟的是它**会伪装成代码问题**：`ENOSPC` 出现的位置是 vite 写 dist 的时候，
 * 而那天我刚改过几个模块。如果当时先去改代码，就会陷入"改了半天还是 ENOSPC"。
 *
 * 所以这个门禁做一件事：**在 build 链的最前面**检查可用空间，
 * 不足时给出一句话诊断 + 清理建议，而不是让下游抛一个指向错误方向的错误。
 *
 * 阈值：200MB。构建实际需要（dist 3.6M + vite 临时文件）远小于此，
 * 留足余量是为了避免在"刚好够"的边缘失败 —— 那种失败最难复现。
 *
 * 这个检查**明确不清理任何东西**。删文件是不可逆的，必须由人决定。
 */

import { statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, '..');

/** 低于这个值就报警 —— 构建实际用量远小于它，余量是为了不在边缘失败 */
const MIN_FREE_BYTES = 200 * 1024 * 1024;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\n【构建前的磁盘空间检查】');

/**
 * 纯函数：给定空闲字节数与阈值，判断是否足够。
 * 抽出来是为了能离线测（自检组会喂各种数值）。
 * @param {number} freeBytes
 * @param {number} minBytes
 * @returns {{ok: boolean, reason: string}}
 */
function verdict(freeBytes, minBytes) {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) {
    return { ok: false, reason: '读不到可用空间' };
  }
  if (freeBytes < minBytes) {
    const freeMb = Math.round(freeBytes / 1024 / 1024);
    const minMb = Math.round(minBytes / 1024 / 1024);
    return { ok: false, reason: `可用 ${freeMb}MB，低于 ${minMb}MB 下限` };
  }
  return { ok: true, reason: '' };
}

let freeBytes = -1;
try {
  // statfsSync 返回 { bavail, bsize }；可用字节 = bavail * bsize
  const st = statfsSync(WEB);
  freeBytes = Number(st.bavail) * Number(st.bsize);
} catch (e) {
  freeBytes = -1;
}

const v = verdict(freeBytes, MIN_FREE_BYTES);
ok(
  `可用空间 ${Math.round(freeBytes / 1024 / 1024)}MB ≥ ${Math.round(MIN_FREE_BYTES / 1024 / 1024)}MB`,
  v.ok,
  v.reason
);

if (!v.ok) {
  console.log('');
  console.log('  ⚠ 磁盘空间不足 —— 构建会失败，而 vite 报的是：');
  console.log('      Error: ENOSPC: no space left on device, write');
  console.log('    那条信息**看起来像代码问题**，实际是磁盘满。先清空间，别改代码。');
  console.log('');
  console.log('  排查顺序（找占用最大的，不要盲删）：');
  console.log(`    df -h ${'/'}                        # 确认哪个分区满`);
  console.log('    du -sh ~/Library/Caches           # 用户级缓存（最大常见项）');
  console.log('    du -sh /tmp/* | sort -rh | head   # 临时文件');
  console.log('    du -sh web/node_modules server/node_modules');
  console.log('');
  console.log('  ⚠ 本门禁**不会**自动清理任何东西 —— 删文件不可逆，必须由人决定。');
}

console.log('\n【自检：判据真的能区分】');
{
  ok('恰好等于阈值 → 通过（不是 < 而是 <）', verdict(MIN_FREE_BYTES, MIN_FREE_BYTES).ok === true);
  ok('比阈值少 1 字节 → 失败', verdict(MIN_FREE_BYTES - 1, MIN_FREE_BYTES).ok === false);
  ok('多 1 字节 → 通过', verdict(MIN_FREE_BYTES + 1, MIN_FREE_BYTES).ok === true);
  ok('0 字节 → 失败', verdict(0, MIN_FREE_BYTES).ok === false);
  ok('负数（读不到）→ 失败', verdict(-1, MIN_FREE_BYTES).ok === false);
  ok('NaN → 失败（不是静默通过）', verdict(NaN, MIN_FREE_BYTES).ok === false);
  ok('失败时 reason 带具体数字（能直接照着排查）', /可用 \d+MB/.test(verdict(0, MIN_FREE_BYTES).reason));
  ok('自检：真实磁盘读数是个有效正数（否则上面的检查是空的）', Number.isFinite(freeBytes) && freeBytes > 0);
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
