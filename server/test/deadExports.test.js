/**
 * 死导出检测（server 侧）—— 补上 web 侧 `test-dead-code.mjs` 的对称缺口。
 *
 * web 侧有门禁检查「导出但无人引用的死代码」，server 侧一直没有。
 * 这轮补上，但**判据必须准确** —— 第一版我做的检测器报了 17 个"死导出"，全是假阳性：
 * 它只在 `module.exports` **之后**的源码里找内部使用，于是 `verifySig`（被同文件的
 * `gateRequired` 调用）、`NUMERIC_RANGES`（被测试用）这类全被误报。
 *
 * 正确判据：一个导出名如果满足以下**全部**条件，才算死导出：
 *   1. 在自己的文件里（**模块导出声明之外**）没有出现
 *   2. 在其它 src 文件里没有出现
 *   3. 在 test/ 里没有出现
 *   4. 在 scripts/ 里没有出现
 *
 * 为什么"在测试里出现"也算被使用：测试是消费者的合法形式。
 * 一条导出只被测试用、没人调用，值不值得留是个判断题 —— 不在这里自动判死。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const fs = require('fs');
const path = require('path');
const { stripCommentLines } = require('./helpers/sourceText');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

const ROOT = path.join(__dirname, '..');
function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

const srcFiles = walk(path.join(ROOT, 'src'));
const texts = new Map(srcFiles.map((p) => [p, stripCommentLines(fs.readFileSync(p, 'utf8'))]));
const testText = walk(path.join(ROOT, 'test')).map((p) => stripCommentLines(fs.readFileSync(p, 'utf8'))).join('\n');
const scriptText = walk(path.join(ROOT, 'scripts')).map((p) => stripCommentLines(fs.readFileSync(p, 'utf8'))).join('\n');

/** 提取一个文件里 `module.exports = { ... }` 的名字列表 */
function exportedNames(src) {
  // 两种写法都要支持：多行（`\n};`）与单行（`{ a, b };`）——
  // 第一版只认多行，自检里的单行样例直接返回 null，脚本崩了。
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  if (!m) return { names: [], span: null };
  // 按逗号切分再取每段的第一个标识符 —— 不能用 `^` 锚行首：
  // 单行写法 `{ a, b, c }` 里只有 a 在"行首"，其余名字会被漏掉（自检抓到的）。
  // 只支持「名字列表」形式（`{ a, b }` 或每行一个）；嵌套对象值不在判据范围内。
  const names = m[1]
    .split(',')
    .map((part) => part.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim())
    .filter(Boolean)
    .map((part) => (part.match(/^([A-Za-z_]\w*)\s*(?::|$)/) || [])[1])
    .filter(Boolean);
  return { names, span: [m.index, m.index + m[0].length] };
}

const dead = [];
let totalExports = 0;
for (const [p, src] of texts) {
  const { names, span } = exportedNames(src);
  if (!span) continue;
  totalExports += names.length;
  // 「自己的模块内部使用」= 扣掉 module.exports 那一段
  const ownBody = src.slice(0, span[0]) + src.slice(span[1]);
  for (const n of names) {
    const re = new RegExp(`\\b${n}\\b`, 'g');
    const inOwn = (ownBody.match(re) || []).length;
    if (inOwn > 0) continue;
    const inOthers = [...texts.entries()]
      .filter(([q]) => q !== p)
      .reduce((a, [, t]) => a + (t.match(re) || []).length, 0);
    if (inOthers > 0) continue;
    if (new RegExp(`\\b${n}\\b`).test(testText)) continue;
    if (new RegExp(`\\b${n}\\b`).test(scriptText)) continue;
    dead.push(`${p.replace(ROOT + '/', '')}: ${n}`);
  }
}

console.log('=== A. 没有死导出 ===');
ok(`扫了 ${srcFiles.length} 个源文件的 ${totalExports} 个导出`,
  totalExports > 100, `只找到 ${totalExports} 个导出，检测器可能坏了`);
ok('没有「四个地方都不出现」的导出', dead.length === 0,
  dead.slice(0, 8).join(' | '));

console.log('\n=== B. 判据自检（能区分四种引用位置）===');
{
  const fake = 'const USED_INSIDE = 1;\nfunction USED_INSIDE2() {}\nmodule.exports = { USED_INSIDE, USED_INSIDE2, TOTALLY_DEAD };\n';
  const { names, span } = exportedNames(fake);
  ok('能解析导出名', JSON.stringify(names) === JSON.stringify(['USED_INSIDE', 'USED_INSIDE2', 'TOTALLY_DEAD']),
    JSON.stringify(names));
  const own = fake.slice(0, span[0]) + fake.slice(span[1]);
  ok('自检：声明处出现 → 不算死导出',
    /\bUSED_INSIDE\b/.test(own), '这个判据错了会把所有导出都误报');
  ok('自检：只在 module.exports 里出现 → 算死导出',
    !/\bTOTALLY_DEAD\b/.test(own));
}

console.log('\n=== C. 关键模块的导出确实被消费 ===');
{
  // 这几个是「导出给测试用」的典型，必须能被找到引用
  const mustBeUsed = [
    ['utils/httpMethods.js', 'isWriteMethod'],
    ['utils/enums.js', 'REVIEW_STATUS'],
    ['middleware/waf-rules.js', 'ALL_GROUPS'],
    ['middleware/gate.js', 'gateRequired'],
  ];
  for (const [file, name] of mustBeUsed) {
    const src = texts.get(path.join(ROOT, 'src', file));
    ok(`${file} 导出了 ${name}`, !!src && new RegExp(`\\b${name}\\b`).test(src));
    ok(`${name} 在测试或别处被引用`,
      new RegExp(`\\b${name}\\b`).test(testText)
      || [...texts.entries()].some(([q, t]) => q !== path.join(ROOT, 'src', file) && new RegExp(`\\b${name}\\b`).test(t)));
  }
}

console.log(`\ndeadExports 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
