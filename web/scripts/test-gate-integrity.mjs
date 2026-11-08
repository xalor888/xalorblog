/**
 * 门禁自身的完整性（元门禁）：**保证其他门禁不会假绿**。
 *
 * 这道门禁来自一次自查：我统计了 17 道门禁的「失败路径」与「自检组」，
 * 发现前几轮写的几道（`test-focus-visible` 802 条断言、`test-contrast-tokens` 52 条…）
 * **一条自检都没有**。没有自检意味着：如果那条正则写错一个字符，断言会**永远通过**，
 * 而没有人会发现 —— 一道不会红的门禁比没有门禁更危险，因为它提供了虚假的安全感。
 *
 * 检查三件事：
 *   A. **必须能失败**：文件里要有 `process.exit(...)`（非恒 0）或 `process.exitCode = 1`。
 *      这是硬要求 —— 一道无法让 build 变红的门禁等于不存在。
 *   B. **必须有断言**：至少一次 `ok(` / `assert(` / `check(` 调用。
 *   C. **建议有自检**：证明「规则能抓到真问题」。缺自检不阻塞 build，但会列出来提醒。
 *
 * 为什么不把 C 做成硬失败：给 800 条断言的老门禁补自检是几十处改动，
 * 强行让它红会阻塞所有后续工作。先立规矩，再逐步还债 —— 已还的会一直绿。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const buildChain = pkg.scripts.build.split(' && ').filter((x) => x.includes('scripts/'));
// 只取**文件名**：有些门禁带参数（`bump-assets.mjs --check`），
// 而下面要 `readFileSync(join(here, g))` —— 带参数会拼出不存在的路径然后崩。
// 参数本身是门禁的一部分（--check 与不带参数的行为不同），但它不参与文件名。
const gates = buildChain.map((x) => x.replace('node scripts/', '').trim().split(/\s+/)[0]);

console.log('\n【门禁清单：必须能失败、必须有断言】');
{
  ok(`build 链里有 ${gates.length} 道门禁`, gates.length >= 10, String(gates.length));

  // `test:scripts` 是「不想跑 vite build 时只跑门禁」的入口。
  // 它原先只串了 8 个（build 早就涨到 20 个），名字却叫「测试所有脚本」——
  // 用它的人会以为覆盖完整。现在要求两者**严格一致**（build 去掉末尾的 vite build）。
  //
  // 不改写成 `"build": "npm run test:scripts && vite build"` 的原因是：
  // 下面第 34 行解析 build 链时按 `includes('scripts/')` 找门禁，
  // 嵌套调用会让 gates 变成 0 个。
  // 文档里有一份门禁清单（docs/CODE_MAP.md §6）。它曾经写着「13 道」而实际有 20 道，
  // 顺序也不全 —— 新人照着文档排查会以为漏了什么。既然 build 链是唯一可信来源，
  // 就让文档自动对齐：清单必须与实际完全一致（含顺序）。
  {
    const docPath = resolve(here, '../../docs/CODE_MAP.md');
    let docOk = true;
    let docDetail = '';
    // 锚点必须在 try 外定义 —— 下面的自检要用它
    const firstGate = gates[0] ? gates[0].replace(/\.mjs$/, '') : 'test-gate-integrity';
    try {
      const doc = readFileSync(docPath, 'utf8');
      const block = (doc.match(new RegExp('```\\n' + firstGate + '[\\s\\S]*?```')) || [''])[0];
      // 按 '→' 切（不按空白切）：带参数的门禁名里有空格（`bump-assets --check`），
      // 按空白切会把它拆成两项，导致「文档 23 项 / 实际 22 项」的假红。
      const listed = block.replace(/```/g, '').trim().split('→')
        .map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
      const expected = gates.map((g) => g.replace(/\.mjs$/, ''));
      docOk = JSON.stringify(listed) === JSON.stringify(expected);
      if (!docOk) {
        docDetail = `文档 ${listed.length} 项 / 实际 ${expected.length} 项；`
          + `只在一处有：${[...listed.filter((x) => !expected.includes(x)), ...expected.filter((x) => !listed.includes(x))].join(', ') || '顺序不同'}`;
      }
    } catch (e) {
      docOk = false;
      docDetail = `读不到 ${docPath}：${e.message}`;
    }
    ok('docs/CODE_MAP.md 的门禁清单与实际 build 链一致（含顺序）', docOk, docDetail);
    ok('自检：清单锚点取自 build 链首项（不是写死的名字）', firstGate === gates[0].replace(/\.mjs$/, ''));
  }

  {
    const tsGates = String(pkg.scripts['test:scripts'] || '')
      .split(' && ').map((x) => x.replace('node scripts/', '').trim().split(/\s+/)[0]).filter(Boolean);
    ok('test:scripts 与 build 链的门禁完全一致（防止两处漂移）',
      JSON.stringify(tsGates) === JSON.stringify(gates),
      `test:scripts ${tsGates.length} 个 / build ${gates.length} 个；`
      + `只在一处有：${[...tsGates.filter((x) => !gates.includes(x)), ...gates.filter((x) => !tsGates.includes(x))].join(', ') || '无差异但顺序不同'}`);
  }

  const cannotFail = [];
  const noAssert = [];
  const noSelfCheck = [];
  const declaredSelfCheck = new Map(); // 门禁 → 它声明的自检文件

  for (const g of gates) {
    // 跳过自身：本文件的注释里就有「自检见 xxx.mjs」这类示例文字，
    // 自审必然自指（把说明当成真实声明）。元门禁的可信度靠它自己的自检组保证，
    // 不靠审自己。
    if (g === 'test-gate-integrity.mjs') continue;
    const src = readFileSync(join(here, g), 'utf8');

    // A. 失败路径：process.exit(...) 不是恒 0，或显式设置 exitCode = 1
    const exitCalls = [...src.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1].trim());
    const alwaysZero = exitCalls.length > 0 && exitCalls.every((arg) => arg === '0');
    const setsNonZeroExitCode = /process\.exitCode\s*=\s*1/.test(src);
    if (alwaysZero && !setsNonZeroExitCode) cannotFail.push(g);

    // B. 至少有一条断言。
    //    判据不能只认 `ok(` / `assert(` / `check(` —— 早期门禁用的是内联计数
    //    （`pass += 1` / `failed += 1` + 自己的 console.log），同样有效。
    const hasAssertFn = /\b(ok|assert|check)\s*\(/.test(src);
    const hasCounter = /\b(pass|fail|failed|bad|issues|findings|offenders|violations)\s*(\.length|\+\+|\+=)/.test(src);
    if (!hasAssertFn && !hasCounter) noAssert.push(g);

    // C. 自检组。
    //    有两种合法形态：
    //      a) 文件里自己就有「自检」段落；
    //      b) 声明 `自检见 xxx.mjs` —— 自检写在**另一个文件**里
    //         （`check-script-order.mjs` 就是这种：它的自测要造临时项目、断言真实退出码，
    //          放在同一个文件里既笨重又容易共享状态，所以拆成 `test-script-order.mjs`）。
    //    b 类要额外验证：被指名的文件存在、在 build 链里、且它自己不缺自检。
    const decl = src.match(/自检见\s*([\w.-]+\.mjs)/);
    if (decl) {
      declaredSelfCheck.set(g, decl[1]);
    } else if (!/自检/.test(src)) {
      // 门禁分两类，只有第一类才需要「自检」：
      //
      //   A. **源码检查型** —— 读文件 + 跑正则（如「不许出现 outline: none 而无补偿」）。
      //      正则写错一个字符就永远通过，所以必须自检。
      //   B. **行为测试型** —— `import` 生产模块、断言真实返回值（如 wordStats 的分词计数）。
      //      判据直接来自函数的输出，不存在「规则写错」这回事，不需要自检。
      //
      // 判定 B 类的依据：从 `../src/` 引入真实模块，且 readFileSync 用得很少
      // （少量读 .env / 配置，不是主要检查手段）。
      const importsProd = /from\s+'\.\.\/src\//.test(src);
      const readCount = (src.match(/readFileSync/g) || []).length;
      // 另一种行为测试：源码是 IIFE（不能 import），于是读文件 + vm 真实执行。
      // 判据同样是「结论来自真实执行」而不是正则匹配。
      const executesCode = /vm\.runIn(?:New)?[Cc]ontext|new Function\(|eval\(/.test(src);
      const isBehaviorTest = (importsProd && readCount <= 2) || executesCode;
      if (!isBehaviorTest) noSelfCheck.push(g);
    }
  }

  ok('每道门禁都能让 build 变红（有非恒 0 的退出路径）',
    cannotFail.length === 0, cannotFail.join(', '));
  ok('每道门禁至少有一条断言',
    noAssert.length === 0, noAssert.join(', '));

  // 声明的自检文件必须真的存在、真的在链里（否则「自检见 xxx.mjs」等于没写）
  const badDecl = [];
  for (const [gate, target] of declaredSelfCheck) {
    if (!gates.includes(target)) badDecl.push(`${gate} → ${target}（不在 build 链）`);
    try {
      readFileSync(join(here, target), 'utf8');
    } catch (e) {
      badDecl.push(`${gate} → ${target}（文件不存在）`);
    }
  }
  ok('「自检见 xxx.mjs」指向的文件都存在且在 build 链里',
    badDecl.length === 0, badDecl.join(' | '));

  // 被声明为别人的自检的文件，本身不需要再有自检（否则会无限递归）
  const selfCheckHosts = new Set(declaredSelfCheck.values());
  const stillMissing = noSelfCheck.filter((g) => !selfCheckHosts.has(g));

  // C 只报告不失败（见文件头说明）
  if (stillMissing.length) {
    console.log(`  ⚠ 缺自检组（不阻塞，但规则写错会假绿）：${stillMissing.join(', ')}`);
  }
  // 阈值钉在**当前实际值**：新增门禁时若忘了写自检，这里会红。
  // 已还债的会一直绿；要提升覆盖率就把这个数字改大。
  // 阈值钉在**当前实际值 20**（全部 20 道）新增门禁时若忘了写自检，这里会红；
  // 已还债的会一直绿，要提升覆盖率就把这个数字改大。
  const WITH_SELF_CHECK = gates.length - stillMissing.length;
  ok(`自检组覆盖率不低于当前基线（${WITH_SELF_CHECK} 道 / 共 ${gates.length} 道）`,
    WITH_SELF_CHECK >= 20,
    `已有 ${WITH_SELF_CHECK} 道；缺: ${stillMissing.join(', ')}`);
}

console.log('\n【元门禁自检：规则能抓到真问题】');
{
  // 反例 1：恒 0 退出
  const alwaysZero = 'if (fail) { } process.exit(0);';
  const calls1 = [...alwaysZero.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1].trim());
  ok('自检：只有 process.exit(0) 会被判为「无法失败」',
    calls1.length > 0 && calls1.every((a) => a === '0'));

  // 正例：条件退出
  const conditional = 'process.exit(fail === 0 ? 0 : 1);';
  const calls2 = [...conditional.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1].trim());
  ok('自检：process.exit(fail === 0 ? 0 : 1) 通过',
    !(calls2.length > 0 && calls2.every((a) => a === '0')));

  // 正例：exitCode
  const exitCode = 'process.exitCode = 1;';
  ok('自检：process.exitCode = 1 也算有失败路径',
    /process\.exitCode\s*=\s*1/.test(exitCode));

  // A 类 / B 类的分类判据
  const behaviorGate = "import { countWords } from '../src/utils/wordStats.js';\nconst fs = require('node:fs');";
  ok('自检：import 生产模块 + 少量 readFileSync 判为「行为测试型」',
    /from\s+'\.\.\/src\//.test(behaviorGate) && (behaviorGate.match(/readFileSync/g) || []).length <= 2);
  const sourceGate = "const src = readFileSync('a.vue','utf8');\nok('x', /foo/.test(src));";
  ok('自检：纯源码正则判为「源码检查型」（需要自检）',
    !(/from\s+'\.\.\/src\//.test(sourceGate) && (sourceGate.match(/readFileSync/g) || []).length <= 2));

  // 「自检见 xxx.mjs」声明机制
  const withDecl = ' * 自检见 test-script-order.mjs';
  const m1 = withDecl.match(/自检见\s*([\w.-]+\.mjs)/);
  ok('自检：能识别「自检见 xxx.mjs」声明', m1 && m1[1] === 'test-script-order.mjs', m1 && m1[1]);
  ok('自检：没有声明的文件仍按「缺自检」处理',
    !'普通的门禁文件'.match(/自检见\s*([\w.-]+\.mjs)/));
  // 声明指向一个不存在的文件时必须失败（否则「自检见」等于没写）
  const fakeDecl = '自检见 no-such-gate.mjs';
  const m2 = fakeDecl.match(/自检见\s*([\w.-]+\.mjs)/);
  ok('自检：指向不存在的文件会被验证逻辑拦下',
    !!m2 && !['check-script-order.mjs'].includes(m2[1]));

  // 反例 2：没有任何断言
  const noAssertion = 'console.log("everything is fine")';
  ok('自检：没有断言的文件会被抓出来',
    !/\b(ok|assert|check)\s*\(/.test(noAssertion) && !/\b(pass|fail|failed)\s*(\+\+|\+=)/.test(noAssertion));

  ok('自检：有 ok() 就算有断言', /\b(ok|assert|check)\s*\(/.test('ok("x", 1 === 1)'));
  // 内联计数也算断言（早期门禁都是这种写法）
  ok('自检：内联计数器也算有断言', /\b(pass|fail|failed)\s*(\+\+|\+=)/.test('if (!cond) failed += 1;'));
  // 「收集违规项再判空」是另一种常见写法（check-script-order 就是）
  ok('自检：findings 数组也算断言',
    /\b(findings)\s*(\.length|\+\+|\+=)/.test('if (!findings.length) process.exit(0);'));
}

console.log('\n【每个章节标题后面都要有断言（不许有空的章节）】');
{
  // 由来：`test-reading-prefs.mjs` 的最后一行是
  //     console.log('\n【空态文案区分层级】');
  //     process.exit(fail === 0 ? 0 : 1);
  // 标题打出来了、**一条断言都没有**就退出。读数的人会以为这一段通过了，
  // 实际是那段检查根本没写。这种「空章节」比缺断言更难发现 ——
  // 输出里明明有一个看起来正常的标题。
  const emptySections = [];
  for (const g of gates) {
    if (g === 'test-gate-integrity.mjs') continue;
    const lines = readFileSync(join(here, g), 'utf8').split('\n');
    let currentTitle = null;
    let currentLine = 0;
    let foundAssert = false;
    const flush = (endLine) => {
      if (currentTitle && !foundAssert) {
        emptySections.push(`${g}:${currentLine} 「${currentTitle}」`);
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const titleMatch = line.match(/console\.(?:log|error)\(\s*['"`]\\n?【([^】]+)】/);
      if (titleMatch) {
        flush(i);
        currentTitle = titleMatch[1];
        currentLine = i + 1;
        foundAssert = false;
        continue;
      }
      if (/\b(ok|eq|assert|check)\s*\(/.test(line)) foundAssert = true;
    }
    flush(lines.length);
  }
  ok('没有「打了标题却没有断言」的空章节',
    emptySections.length === 0, emptySections.slice(0, 6).join(' | '));
}

console.log('\n【每道门禁都真的在 build 链里（不是写了不跑）】');
{
  const allScripts = readdirSync(here).filter((f) => f.endsWith('.mjs'));
  const libFiles = allScripts.filter((f) => f === 'lib' || f.startsWith('.'));
  // `audit-*` 是**审计工具**，不是门禁：它输出报告、不判 pass/fail，不进 build 链。
  // 用命名前缀区分，而不是靠「有没有 ok(」这种启发式 —— 名字一眼能看出来是什么。
  const auditTools = allScripts.filter((f) => f.startsWith('audit-'));
  // `*-fast.mjs` 是某道门禁的**快速变体**：语义相同但省去刻意的等待
  // （如 `test-form-token-fast.mjs` 用旧时间戳跳过 MIN_SUBMIT_AGE 的 2.1 秒）。
  // 它们用于 flaky 检测与日常快速反馈，完整版仍在 build 链里跑 ——
  // 所以不进链是**设计**，不是漏写。同样用命名后缀区分，不靠启发式。
  const fastVariants = allScripts.filter((f) => f.endsWith('-fast.mjs'));
  const notInChain = allScripts
    .filter((f) => !libFiles.includes(f) && f !== 'test-gate-integrity.mjs')
    .filter((f) => !auditTools.includes(f) && !fastVariants.includes(f))
    .filter((f) => !gates.includes(f));
  ok('scripts/ 下的每个门禁脚本都在 build 链里（audit-* 与 *-fast 变体除外）',
    notInChain.length === 0, notInChain.join(', '));
  ok('audit-* 工具确实不在 build 链里（它们是给人手动跑的）',
    auditTools.every((f) => !gates.includes(f)), auditTools.join(', '));
  // 自检：快速变体的判据是「有对应的完整版在链里」，否则它就是孤立脚本
  ok('*-fast 变体都有对应的完整版在 build 链里',
    fastVariants.every((f) => gates.includes(f.replace('-fast.mjs', '.mjs'))),
    fastVariants.filter((f) => !gates.includes(f.replace('-fast.mjs', '.mjs'))).join(', '));
}

console.log('\n【测试文件不许有「收尾之后」的死代码】');
{
  // 实测踩过的坑：往 test-mobile-baseline.mjs 追加一组断言时，加到收尾行之后去了 ——
  // 而更早有一条 `process.exit(fail === 0 ? 0 : 1)`，于是新断言**一次都没跑过**，
  // 而脚本仍然 exit 0。我是靠 `grep -c '✓'` 数出 68 而不是 77 才发现的。
  //
  // 这类问题的特征：**exit 0 不等于测试跑了**。所以把它做成门禁。
  //
  // 判据：顶层（0 缩进）的 `process.exit(...)` 或 `process.exitCode = ...` 之后，
  // 不许再有顶层可执行语句。缩进的（在 if 块里）不算 —— 那才是正常写法。
  const strip = (src) => {
    const out = [];
    let inBlock = false;
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
      if (t.startsWith('//') || t.startsWith('*')) continue;
      if (t) out.push(line);
    }
    return out;
  };

  const testFiles = [];
  const serverTestDir = resolve(here, '../../server/test');
  for (const f of readdirSync(serverTestDir)) {
    if (f.endsWith('.js')) testFiles.push({ path: join(serverTestDir, f), label: `server/test/${f}` });
  }
  for (const f of readdirSync(here)) {
    if (f.endsWith('.mjs')) testFiles.push({ path: join(here, f), label: `web/scripts/${f}` });
  }

  const hasDeadCodeAfterExit = (src) => {
    const ls = strip(src);
    let last = -1;
    ls.forEach((l, i) => {
      if (/^process\.exit\(/.test(l) || /^process\.exitCode\s*=/.test(l)) last = i;
    });
    return last >= 0 && ls.slice(last + 1).length > 0;
  };

  const offenders = [];
  for (const { path: fp, label } of testFiles) {
    let src;
    try { src = readFileSync(fp, 'utf8'); } catch (e) { continue; }
    if (hasDeadCodeAfterExit(src)) offenders.push(label);
  }

  ok(`检查了 ${testFiles.length} 个测试文件`, testFiles.length > 60, String(testFiles.length));
  ok('没有「顶层收尾之后的死代码」（那些断言永远不会跑）',
    offenders.length === 0, offenders.slice(0, 5).join(', '));

  // 自检：判据真的能区分「顶层收尾」与「if 块里的收尾」
  ok('自检：缩进在 if 块里的 exit 之后有代码 → 不算问题',
    !hasDeadCodeAfterExit('if (fail) process.exit(1);\nconsole.log("done");'));
  ok('自检：顶层 exit 之后还有语句 → 判为问题',
    hasDeadCodeAfterExit('process.exit(1);\nconsole.log("永远不会打印");'));
  ok('自检：注释里的 process.exit 不算（剥注释后消失）',
    !hasDeadCodeAfterExit('// process.exit(1)\nconsole.log("x");'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
