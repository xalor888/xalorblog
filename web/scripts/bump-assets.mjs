/**
 * 把入口 HTML 里的 `?v=` 缓存破坏参数更新为**文件内容的 hash 前缀**。
 *
 * 为什么不用日期：这个项目原来用的是 `?v=20261025` 这种"像日期"的编号。
 * 问题有两个：
 *   1. **改文件忘了改版本号** → 已部署用户的浏览器/CDN 继续用旧脚本。
 *      而证据只是"我明明改了怎么没生效"—— 这类问题极难排查。
 *   2. **编号与内容没有绑定关系**。工作树里一度出现 `?v=20261103`
 *      （比当前日期还晚两天），读者看到会以为文件是那天改的。
 *
 * 用内容 hash 后：改文件 → hash 变 → 版本自动变；不改文件 → hash 不变 → 缓存正常。
 * 语义从"我以为的日期"变成"这段字节的指纹"。
 *
 * 用法：
 *   node scripts/bump-assets.mjs          # 写入
 *   node scripts/bump-assets.mjs --check  # 只检查（门禁用，不匹配则 exit 1）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, '..');
const CHECK_ONLY = process.argv.includes('--check');

/** 入口 HTML 里引用的 public 资源（只处理本地 public/ 下的 JS） */
const ENTRIES = ['index.html', 'home.html'];

/** 扫一个 HTML 里所有 `/xxx.js?v=...` 形式的引用 */
function findRefs(html) {
  return [...html.matchAll(/("?)(\/[A-Za-z0-9_-]+\.js)\?v=([A-Za-z0-9]+)\1/g)].map((m) => ({
    raw: m[0],
    path: m[2],
    version: m[3],
  }));
}

const hashOf = (rel) => createHash('sha256').update(readFileSync(join(WEB, 'public', rel.replace(/^\//, '')))).digest('hex').slice(0, 8);

let changed = 0;
const issues = [];

for (const entry of ENTRIES) {
  const file = join(WEB, entry);
  const original = readFileSync(file, 'utf8');
  let next = original;

  for (const ref of findRefs(original)) {
    const rel = ref.path.replace(/^\//, '');
    let want;
    try {
      want = hashOf(rel);
    } catch {
      // 不是 public/ 下的文件（比如打包产物或外链）—— 跳过，不猜
      continue;
    }
    if (ref.version === want) continue;
    if (CHECK_ONLY) {
      issues.push(`${entry}: ${ref.path} 的版本 ${ref.version} ≠ 内容 hash ${want}`);
    } else {
      next = next.replace(ref.raw, ref.raw.replace(`v=${ref.version}`, `v=${want}`));
      changed++;
    }
  }

  if (!CHECK_ONLY && next !== original) writeFileSync(file, next);
}

if (CHECK_ONLY) {
  if (issues.length) {
    console.error('✗ 缓存破坏参数与文件内容不一致（改过文件但没更新 ?v=）：');
    for (const s of issues) console.error('  - ' + s);
    console.error('\n  修复：node scripts/bump-assets.mjs');
    process.exit(1);
  }
  console.log('✓ 缓存破坏参数与文件内容一致');
} else {
  console.log(changed ? `✓ 更新了 ${changed} 处 ?v=` : '✓ 无需更新');
}
