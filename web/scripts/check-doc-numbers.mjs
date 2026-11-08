/**
 * 文档数字门禁：**文档里承诺的数字必须与代码一致**。
 *
 * 为什么需要：这个项目已经有三次「文档说 A、实际是 B」——
 *   - `CODE_MAP` §2 统计表写着 `web/scripts` 13 道门禁（实际 20）
 *   - `CODE_MAP` §6 门禁清单写着 13 个名字（实际 20，顺序也不全）
 *   - `README` 的「测试」小节写着 29 个 `*.test.js`（实际 53）
 *
 * 三次都是**手写的快照**，而代码一直在长。第三次核对时我自己还把「16 个集成套件」
 * 写成了 13 —— 所以这不是别人不小心，是**人的默认行为**。
 *
 * 判据：只用**可从代码推导**的数字（套件数、门禁数），不检查行数
 * （行数每次改代码都变，检查它会天天红；统计表里行数标成「约」并给 ±25% 容差）。
 *
 * 元门禁 `test-gate-integrity` 已经检查了 `CODE_MAP §6` 的门禁**清单**（含顺序），
 * 这里补的是**数量**：README 与 CODE_MAP 统计表里的那几个数字。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const WEB = join(ROOT, 'web');
const SERVER = join(ROOT, 'server');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/* ---------- 从代码推导真实数字（唯一可信来源） ---------- */
const webPkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(readFileSync(join(SERVER, 'package.json'), 'utf8'));

const offlineSuites = serverPkg.scripts.test.split(' && ').filter((x) => x.trim().endsWith('.test.js')).length;
// 用「包含 .mjs」而不是「以 .mjs 结尾」—— 有些门禁带参数（`bump-assets.mjs --check`），
// 按结尾判断会漏算，于是这个数字和 test-gate-integrity 的口径不一致（21 vs 22）。
const gateEntries = webPkg.scripts.build.split(' && ').filter((x) => /\.mjs(\s|$)/.test(x));
const gates = gateEntries.length;

const runSrc = readFileSync(join(SERVER, 'test', 'run.js'), 'utf8');
const suitesBlock = (runSrc.match(/const suites\s*=\s*process\.argv\[2\][\s\S]*?\];/) || [''])[0];
const integrationSuites = (suitesBlock.match(/'[\w.-]+\.test\.js'/g) || []).length;

const onDiskTests = readdirSync(join(SERVER, 'test')).filter((f) => f.endsWith('.test.js')).length;
// **递归**统计：`web/scripts/lib/sourceText.mjs` 在子目录里。
// 第一版用 readdirSync 只看顶层（22），而文档写 23（含 lib），于是门禁红了 ——
// 那次红是对的：它逼我把统计口径说清楚。现在统一为「递归，含 lib」。
const countMjsRecursive = (dir) => {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countMjsRecursive(join(dir, e.name));
    else if (e.name.endsWith('.mjs')) n++;
  }
  return n;
};
const webScriptFiles = countMjsRecursive(join(WEB, 'scripts'));

// 这一行是给人看的基线，不是断言 —— 所以不用【】章节格式，
// 否则元门禁会把「有标题却没有断言」判为空章节。
console.log(`\n基线（从代码推导）：离线套件 ${offlineSuites} | 集成套件 ${integrationSuites} | `
  + `磁盘 *.test.js ${onDiskTests} | 构建门禁 ${gates} | scripts/ 下 .mjs ${webScriptFiles}`);

/* ---------- 文档里声明的数字 ---------- */
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const codeMap = readFileSync(join(ROOT, 'docs', 'CODE_MAP.md'), 'utf8');

console.log('\n【README.md 的数字】');
{
  // 形如「53 个离线套件」
  const m = readme.match(/(\d+)\s*个离线套件/);
  ok('README 写了离线套件数', !!m);
  if (m) ok(`README 的离线套件数 = ${offlineSuites}`, Number(m[1]) === offlineSuites, `文档写 ${m[1]}`);

  const g = readme.match(/(\d+)\s*道门禁/);
  ok('README 写了门禁数', !!g);
  if (g) ok(`README 的门禁数 = ${gates}`, Number(g[1]) === gates, `文档写 ${g[1]}`);

  const i = readme.match(/(\d+)\s*个集成套件/);
  ok('README 写了集成套件数', !!i);
  if (i) ok(`README 的集成套件数 = ${integrationSuites}`, Number(i[1]) === integrationSuites, `文档写 ${i[1]}`);
}

console.log('\n【CODE_MAP.md 统计表的数字】');
{
  // 找 `web/scripts` 那一行，取「文件数」与「N 道构建门禁」
  const row = (codeMap.match(/\| `web\/scripts` \| (\d+) \| ([\d,]+) \| \*\*(\d+) 道构建门禁\*\*/) || []);
  ok('CODE_MAP 有 web/scripts 那一行且格式完整', row.length === 4, row[0] || '(没匹配到)');
  if (row.length === 4) {
    ok(`CODE_MAP 的文件数与磁盘一致（${webScriptFiles}）`, Number(row[1]) === webScriptFiles, `文档 ${row[1]} / 实际 ${webScriptFiles}`);
    ok(`CODE_MAP 的门禁数与 build 链一致（${gates}）`, Number(row[3]) === gates, `文档 ${row[3]} / 实际 ${gates}`);
  }

  // 只匹配数字，不匹配措辞 —— 表述可以改（而且确实改过一次：从「A 离线 + B 集成」
  // 改成「A 在离线链、B 在集成链，其中 7 个两条都跑」，因为两条链有交集，相加是错的）。
  // 门禁要守的是「数字对」，不是「话说得跟上次一样」。
  const m2 = codeMap.match(/\*\*(\d+) 个 `\*\.test\.js`\*\*/);
  ok('CODE_MAP 写了测试文件总数', !!m2);
  if (m2) ok(`CODE_MAP 的测试文件总数 = ${onDiskTests}`, Number(m2[1]) === onDiskTests, `文档 ${m2[1]}`);

  const m3 = codeMap.match(/(\d+) 个在离线链/);
  ok('CODE_MAP 写了离线链的套件数', !!m3);
  if (m3) ok(`CODE_MAP 的离线链套件数 = ${offlineSuites}`, Number(m3[1]) === offlineSuites, `文档 ${m3[1]}`);

  const m4 = codeMap.match(/(\d+) 个在集成链/);
  ok('CODE_MAP 写了集成链的套件数', !!m4);
  if (m4) ok(`CODE_MAP 的集成链套件数 = ${integrationSuites}`, Number(m4[1]) === integrationSuites, `文档 ${m4[1]}`);

  // 两条链的交集也要写明 —— 否则读者会以为加起来等于总数（我第一版就是这么写的）
  const m5 = codeMap.match(/其中 (\d+) 个两条链都跑/);
  ok('CODE_MAP 写明了离线链与集成链的交集数', !!m5);
  if (m5) {
    const overlap = (() => {
      const off = new Set([...serverPkg.scripts.test.matchAll(/node test\/([\w.-]+\.test\.js)/g)].map((x) => x[1]));
      const blk = (runSrc.match(/const suites\s*=\s*process\.argv\[2\][\s\S]*?\];/) || [''])[0];
      const itg = new Set([...blk.matchAll(/'([\w.-]+\.test\.js)'/g)].map((x) => x[1]));
      return [...off].filter((f) => itg.has(f)).length;
    })();
    ok(`CODE_MAP 的交集数 = ${overlap}`, Number(m5[1]) === overlap, `文档 ${m5[1]}`);
  }
}

console.log('\n【文档里提到的 npm script 必须真的存在】');
{
  // 实测风险：文档是新人照着敲的地方。写了 `npm run e2e` 而 package.json 里没有，
  // 他第一件事就卡住 —— 而这不会让任何门禁变红。
  const allScripts = { ...serverPkg.scripts, ...webPkg.scripts };
  const mentioned = new Set();
  for (const text of [readme, codeMap]) {
    for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) mentioned.add(m[1]);
    // `npm test` 没有 run
    if (/npm test\b/.test(text)) mentioned.add('test');
  }
  const missing = [...mentioned].filter((n) => !allScripts[n]);
  ok(`文档里提到的 ${mentioned.size} 个 npm script 都存在`, missing.length === 0,
    `缺：${missing.join(', ')}`);
  // 自检：判据能认出「提了但不存在的脚本」
  ok('自检：不存在的脚本名会被判为缺失',
    ['zsh-only-thing'].filter((n) => !allScripts[n]).length === 1);
}

console.log('\n【自检：判据能抓到数字漂移】');
{
  // 模拟「文档写 29、实际 53」的情形
  const stale = 'npm test # 29 个离线套件';
  const parsed = Number((stale.match(/(\d+)\s*个离线套件/) || [])[1]);
  ok('自检：能从不符的文本里解析出旧数字', parsed === 29);
  ok('自检：旧数字 ≠ 实际数字（这正是曾修过的那处）', parsed !== offlineSuites);
  ok('自检：解析不到时不会误判为通过', (() => {
    const m = '一段没有数字的话'.match(/(\d+)\s*个离线套件/);
    return m === null;   // 调用方用 `ok('写了…', !!m)` 先拦住
  })());
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
