/**
 * 审计：哪些断言**依赖注释**。
 *
 * 做法：把某个门禁脚本复制成同目录下的临时副本，把里面读文件的地方改成「读进来先剥注释」，
 * 然后跑副本，收集变红的断言名，最后删掉副本。
 *
 * 为什么需要它：这个项目里「注释让断言假红或假绿」已经发生过六次以上。
 * 反向（注释让断言**假绿**）特别难发现 —— 断言明明在跑、明明绿，但匹配的是
 * 解释性注释而不是真实实现。用它一次抓出 3 条（改每页条数/sitemap/h1 降级），
 * 那三条都是一年多前写下的，一直显示通过。
 *
 * 判读规则：
 *   - 变红的断言 → 它依赖注释。**分两类**：
 *       a) 有意为之（断言名出现在 okNote( 调用里）→ 正常，保留；
 *       b) 意料之外 → 说明它一直在匹配注释，需要锚定到真实实现；
 *   - 没变红的断言 → 至少不依赖注释（但仍可能靠别的无关文本通过）。
 *
 * ⚠ 只生成临时副本，**不改动原文件**。副本同目录，所以 `read('../src/...')` 的相对路径不变。
 *
 * 用法：node scripts/audit-comment-reliance.mjs [门禁文件名…]
 *       省略参数时默认审计 test-focus-visible.mjs
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['test-focus-visible.mjs'];

const READ_RE = /const read = \(p\) => readFileSync\(resolve\(here, p\), 'utf8'\);/;

for (const target of targets) {
  const srcPath = join(here, target);
  if (!existsSync(srcPath)) {
    console.log(`✗ 找不到 ${target}`);
    continue;
  }
  const original = readFileSync(srcPath, 'utf8');
  if (!READ_RE.test(original)) {
    // 这几种门禁通常已经自己用了 stripCommentLines（在读取之后立刻剥），
    // 所以没有统一的 read() 可替换 —— 它们本来就不存在「靠注释判定」的问题。
    const alreadyStrips = /stripCommentLines\(/.test(original);
    console.log(`· ${target}：没有统一的 read() 定义` + (alreadyStrips ? '（它已在读取后自行剥注释）' : '（需手工审）'));
    continue;
  }

  // 副本放在同目录：read('../src/...') 用的是 resolve(here, ...)，here 就是脚本所在目录
  const tmpName = `_audit-${target.replace(/\.mjs$/, '')}.mjs`;
  const tmpPath = join(here, tmpName);
  const patched = original.replace(
    READ_RE,
    "const read = (p) => stripCommentLines(readFileSync(resolve(here, p), 'utf8')); // [AUDIT]"
  );

  // 副本必须能 resolve 到 lib/sourceText
  if (!/from '\.\/lib\/sourceText\.mjs'/.test(patched)) {
    console.log(`⚠ ${target} 没有引入 lib/sourceText，无法剥注释，跳过`);
    continue;
  }

  let output = '';
  try {
    writeFileSync(tmpPath, patched, 'utf8');
    output = execFileSync(process.execPath, [tmpPath], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    // 断言失败时退出码非 0，stdout 仍在 e.stdout
    output = String(e.stdout || '');
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }

  const failed = [...output.matchAll(/^\s+✗ (.+?)(?: — .*)?$/gm)].map((m) => m[1].trim());
  // 有意依赖注释的：断言名出现在 okNote( 的第一个参数里
  const notes = new Set([...original.matchAll(/okNote\(\s*'([^']+)'/g)].map((m) => m[1]));

  console.log(`\n=== ${target} ===`);
  if (!failed.length) {
    console.log('  没有断言依赖注释（全部都是对着真实代码判定的）');
    continue;
  }
  const intentional = failed.filter((n) => notes.has(n));
  const suspicious = failed.filter((n) => !notes.has(n));
  if (intentional.length) {
    console.log(`  有意的（okNote，共 ${intentional.length} 条）：`);
    for (const n of intentional) console.log(`    · ${n}`);
  }
  if (suspicious.length) {
    console.log(`  ⚠ 意外的（可能一直在匹配注释，共 ${suspicious.length} 条）：`);
    for (const n of suspicious) console.log(`    ✗ ${n}`);
  }
}

console.log('\n判读：意外的那些要把断言改成锚定真实实现（配合 readCode() / stripCommentLines）。');
