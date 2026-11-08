/**
 * 死代码门禁：**定义但从未被引用**的函数。
 *
 * 只报一类：文件内定义、**没有 export**、且全仓引用次数 ≤ 1（就是定义本身）。
 *
 * 为什么不报「导出但没人用」：
 * 那属于**模块 API 面**，不是死代码。`BREAKPOINT_ADMIN`、`BLOG_URL`、`focusablesIn`
 * 这些当前只有本文件在用，但导出它们是刻意的 —— 让其它组件能引用同一份常量/工具，
 * 而不是各自抄一份。把它们删掉只会让下一个人重新写一遍。
 *
 * 这个门禁的由来：前几轮清掉过 `.ed-kbd` 规则、`.ai-empty-tip`、`.brand-mark`、
 * `inputRef`、`parseExtra`、`$reset?.()` 调用 —— 都是「改完之后旧实现留在原地」。
 * 靠人眼复查会漏，靠这条断言能在 CI 里立刻看见。
 *
 * 扫描范围包含 `server/src`：那边同样会有「写了个辅助函数后来没用了」的情况。
 * **不扫描测试文件与门禁脚本自身**（它们本来就允许有一次性辅助函数）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 已知的「扫描器看不到引用」情况：白名单写成 `文件相对路径: 符号名` */
const ALLOW_UNUSED = new Set([
  // 例：web/src/utils/foo.js: bar —— 通过 window[名字] 动态调用（本项目当前没有）
]);

function collectFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (['.js', '.vue', '.mjs'].includes(extname(p))) out.push(p);
    }
  };
  walk(join(ROOT, 'web', 'src'));
  walk(join(ROOT, 'server', 'src'));
  return out;
}

const files = collectFiles();
const sources = files.map((f) => ({ f, src: readFileSync(f, 'utf8') }));
const corpus = sources.map((x) => x.src).join('\n');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 用 lookaround 而不是 \b：`$jsonLd` 这种以 `$` 开头的名字会让 \b 失效（$ 不是词字符） */
const countOf = (name) => (corpus.match(new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`, 'g')) || []).length;

const DEFINITION_PATTERNS = [
  /^(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/gm,
  /^(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
  /^(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?function/gm,
];

console.log('\n【定义但从未被引用的函数】');
{
  const dead = [];
  for (const { f, src } of sources) {
    const rel = f.slice(ROOT.length + 1);
    for (const re of DEFINITION_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const name = m[1];
        if (!name || name.length < 3) continue;
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const linePrefix = src.slice(lineStart, m.index);
        if (/\bexport\b/.test(linePrefix)) continue;      // 导出 = API 面，刻意保留
        if (/^\s*(\*|\/\/)/.test(linePrefix)) continue;   // 注释里出现的
        if (ALLOW_UNUSED.has(`${rel}: ${name}`)) continue;
        if (countOf(name) <= 1) dead.push(`${rel}: ${name}`);
      }
    }
  }
  ok(`扫描了 ${sources.length} 个源文件，没有「定义但从未被引用」的函数`,
    dead.length === 0, dead.slice(0, 8).join(' | '));
}

console.log('\n【扫描器自检：规则能抓到真问题】');
{
  // 造一段真的死代码，确认能被识别
  const synthetic = 'function trulyUnusedHelper(x) { return x; }\nconst alsoUnused = (y) => y;';
  const names = [...synthetic.matchAll(/function\s+([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]);
  ok('合成样本里能提取出函数名', names.includes('trulyUnusedHelper'), names.join(','));

  const arrowNames = [...synthetic.matchAll(/const\s+([a-zA-Z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>/g)].map((m) => m[1]);
  ok('能提取箭头函数常量', arrowNames.includes('alsoUnused'), arrowNames.join(','));

  // 边界：$ 前缀的名字必须能被正确定位（\b 会失效）
  const dollarName = '$jsonLd';
  const sample = 'function $jsonLd() {}\nconst x = $jsonLd();';
  const cnt = (sample.match(new RegExp(`(?<![\\w$])${esc(dollarName)}(?![\\w$])`, 'g')) || []).length;
  ok('$ 前缀的名字能被正确计数（用 lookaround 而不是 \\b）', cnt === 2, String(cnt));
  const cntBad = (sample.match(new RegExp(`\\b${esc(dollarName)}\\b`, 'g')) || []).length;
  ok('对照：用 \\b 会数错（这就是当初的假阳性原因）', cntBad !== 2, String(cntBad));

  // 导出声明的不该被当成死代码
  const exported = 'export function publicApi() {}';
  const linePrefix = exported.slice(0, exported.indexOf('function'));
  ok('带 export 的定义会被跳过', /\bexport\b/.test(linePrefix));
}

console.log('\n【已知的假阳性已排除】');
{
  // $jsonLd 在 pageMeta.js 里被 upsertJsonLd / clearPageJsonLd 调用 ——
  // 第一版扫描器用 \b 导致它被误报。这条断言钉住「它不该再出现在死代码列表里」。
  const src = readFileSync(join(ROOT, 'web', 'src', 'utils', 'pageMeta.js'), 'utf8');
  ok('$jsonLd 确实有调用点（不是死代码）',
    (src.match(/\$jsonLd\(\)/g) || []).length >= 2,
    String((src.match(/\$jsonLd\(\)/g) || []).length));
  ok('countOf 能数到它的全部出现', countOf('$jsonLd') >= 3, String(countOf('$jsonLd')));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
