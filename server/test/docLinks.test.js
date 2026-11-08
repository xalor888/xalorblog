/**
 * 文档内链有效性（零依赖）。
 *
 * 为什么值得检查：`README.md` 指向 `docs/CODE_MAP.md`，`CODE_MAP.md` 又指向
 * `docs/code-map/` 下的分区笔记。任何一个路径写错，读者点进去就是 404
 * —— 而这**不会让任何门禁变红**。
 *
 * 和前面几轮修的「文档数字过时」「npm script 不存在」是同一族：
 * 文档是照着用/照着点的地方，它的错误没有运行时反馈。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

const ROOT = path.join(__dirname, '..', '..');
const DOCS = ['README.md', 'docs/CODE_MAP.md'];

/** 提取 markdown 里的相对链接目标（跳过外链、锚点、图片） */
function relativeLinks(src) {
  const out = [];
  for (const m of src.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const target = m[2].split('#')[0].split('?')[0].trim();
    if (!target) continue;
    if (/^[a-z]+:/i.test(target)) continue;   // http: / https: / mailto:
    if (target.startsWith('//')) continue;
    out.push({ label: m[1], target });
  }
  return out;
}

console.log('=== A. 文档内链都指向真实文件 ===');
{
  const broken = [];
  let checked = 0;
  for (const doc of DOCS) {
    const abs = path.join(ROOT, doc);
    if (!fs.existsSync(abs)) { broken.push(`${doc}（文档本身不存在）`); continue; }
    const src = fs.readFileSync(abs, 'utf8');
    for (const { target } of relativeLinks(src)) {
      checked++;
      const resolved = path.resolve(path.dirname(abs), target);
      if (!fs.existsSync(resolved)) broken.push(`${doc} → ${target}`);
    }
  }
  ok(`检查了 ${checked} 条相对链接`, checked >= 5, `只找到 ${checked} 条`);
  ok('没有失效链接', broken.length === 0, broken.slice(0, 5).join(' | '));
}

console.log('\n=== B. 入口文档必须存在且互相可达 ===');
{
  // README 是入口，必须指向代码索引；索引必须指向分区笔记。
  // 第三条是守卫：这个批次的过程记录（`AUTOPILOT*` / `HANDOVER`）已按用户要求删除，
  // 谁把它们写回文档，链接就会指向不存在的文件 —— 而错误只发生在读者点进去的那一刻。
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const codeMap = fs.readFileSync(path.join(ROOT, 'docs/CODE_MAP.md'), 'utf8');
  ok('README 指向 CODE_MAP', /\[[^\]]*\]\([^)]*CODE_MAP\.md/.test(readme));
  ok('CODE_MAP 指向 code-map 分区笔记', /\[[^\]]*\]\([^)]*code-map\//.test(codeMap));
  const removed = ['AUTOPILOT.md', 'AUTOPILOT_LOG.md', 'HANDOVER.md']
    .filter((n) => readme.includes(n) || codeMap.includes(n));
  ok('已删除的过程记录没有被文档引用回来', removed.length === 0, removed.join(' | '));
}

console.log('\n=== C. 判据自检 ===');
{
  ok('自检：能提取相对链接', relativeLinks('[a](docs/x.md)').length === 1);
  ok('自检：跳外链', relativeLinks('[a](https://e.com/x)').length === 0);
  ok('自检：保留锚点前缀但去掉锚',
    relativeLinks('[a](docs/x.md#sec)')[0].target === 'docs/x.md');
  ok('自检：能识别不存在的路径',
    !fs.existsSync(path.join(ROOT, 'docs', '__definitely_not_here__.md')));
  ok('自检：图片语法也会被当成链接（已知限制，所以文档里图片都用绝对路径）',
    relativeLinks('![x](docs/i.png)').length === 1);
}

console.log(`\ndocLinks 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
