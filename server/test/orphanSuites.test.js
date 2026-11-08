/**
 * 孤儿测试文件检测（零 DB、零服务）。
 *
 * 背景：`test/run.js` 里已经有一段 `warnOrphanSuites()`，逻辑是对的
 * （列出既不在离线链、也不在集成 suites 里的 `.test.js`，并 `process.exitCode = 1`）。
 * **但它只在 `npm run test:all` 里调用** —— 而那条命令会清库，实际上从不运行。
 * 于是这套检查等于不存在，孤儿文件照样永远不会被执行。
 *
 * 这里把它搬到离线链：每次 `npm test` 都会检查一遍。
 *
 * 判据：`test/` 下的每个 `*.test.js` 必须至少属于下面之一：
 *   A. `package.json` 的 `scripts.test`（离线链 —— 每轮都跑）
 *   B. `test/run.js` 的 suites 数组（集成链 —— 需要 DB 和 3000 端口）
 * 两边都没有 = 写了但永远不跑，是最坏的情况：它看起来是测试覆盖，实际是死的。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const TEST_DIR = path.join(SERVER, 'test');

let passCount = 0, failCount = 0;
function check(name, fn) {
  try { fn(); passCount++; console.log(`  ✓ ${name}`); }
  catch (e) { failCount++; console.log(`  ✗ ${name} — ${e.message}`); }
}

const { stripCommentLines } = require('./helpers/sourceText');
const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
const testScript = String(pkg.scripts.test || '');

// A. 离线链里注册的
const offline = new Set(
  [...testScript.matchAll(/node test\/([\w.-]+\.test\.js)/g)].map((m) => m[1])
);

// B. run.js 里 suites 数组的（剥注释后取，避免读到自己注释里的示例）
const runSrc = stripCommentLines(fs.readFileSync(path.join(TEST_DIR, 'run.js'), 'utf8'));
// 不用长度上限：suites 数组本身就有 16 项，2000 字符不够（第一次写死上限时漏了 8 个）
const suitesBlock = (runSrc.match(/const suites\s*=\s*process\.argv\[2\][\s\S]*?\];/) || [''])[0];
const integrated = new Set(
  [...suitesBlock.matchAll(/'([\w.-]+\.test\.js)'/g)].map((m) => m[1])
);

// 磁盘上实际存在的
const onDisk = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js')).sort();

console.log('=== A. 三条清单都读到了 ===');
check(`离线链注册了 ${offline.size} 个`, () => {
  assert.ok(offline.size > 30, `只读到 ${offline.size} 个 —— package.json 的 test 链可能换了写法`);
});
check(`集成链注册了 ${integrated.size} 个`, () => {
  assert.ok(integrated.size >= 10, `只读到 ${integrated.size} 个 —— suites 数组的格式可能变了`);
});
check(`磁盘上有 ${onDisk.length} 个 *.test.js`, () => {
  assert.ok(onDisk.length >= offline.size, `磁盘 ${onDisk.length} < 离线链 ${offline.size}，说明清单读错了`);
});

console.log('\n=== B. 没有孤儿（写了但永远不跑） ===');
check('每个 *.test.js 至少属于一条链', () => {
  const orphans = onDisk.filter((f) => !offline.has(f) && !integrated.has(f));
  assert.deepStrictEqual(orphans, [],
    `以下文件永远不会被执行：${orphans.join(', ')} —— 加进 package.json 的 test 链，或 test/run.js 的 suites`);
});

console.log('\n=== C. 反向：清单里不许有已删除的文件 ===');
check('离线链里没有指向不存在文件的条目', () => {
  const missing = [...offline].filter((f) => !onDisk.includes(f));
  assert.deepStrictEqual(missing, [], `package.json 的 test 链引用了不存在的文件：${missing.join(', ')}`);
});
check('集成链里没有指向不存在文件的条目', () => {
  const missing = [...integrated].filter((f) => !onDisk.includes(f));
  assert.deepStrictEqual(missing, [], `run.js 的 suites 引用了不存在的文件：${missing.join(', ')}`);
});

console.log('\n=== D. 离线链内部不许重复注册 ===');
check('每个文件在 test 链里只出现一次', () => {
  const all = [...testScript.matchAll(/node test\/([\w.-]+\.test\.js)/g)].map((m) => m[1]);
  const dupes = all.filter((f, i) => all.indexOf(f) !== i);
  assert.deepStrictEqual([...new Set(dupes)], [], `重复注册：${[...new Set(dupes)].join(', ')} —— 会被跑两遍，浪费时间`);
});

console.log('\n=== E. 自检：孤儿判定真的能区分三种状态 ===');
{
  const fake = {
    disk: ['a.test.js', 'b.test.js', 'c.test.js'],
    offline: new Set(['a.test.js']),
    integrated: new Set(['b.test.js']),
  };
  const orphans = fake.disk.filter((f) => !fake.offline.has(f) && !fake.integrated.has(f));
  check('自检：只在一处注册的不算孤儿', () => {
    assert.deepStrictEqual(orphans, ['c.test.js']);
  });
  check('自检：两处都没注册的才算孤儿', () => {
    assert.ok(orphans.includes('c.test.js') && !orphans.includes('a.test.js') && !orphans.includes('b.test.js'));
  });
  check('自检：全注册时孤儿为空', () => {
    const none = fake.disk.filter((f) => !new Set(['a.test.js', 'b.test.js', 'c.test.js']).has(f));
    assert.deepStrictEqual(none, []);
  });
}

console.log('\n=== F. 那些「只在集成链」的文件要被说明（它们不会每轮跑） ===');
{
  const integrationOnly = [...integrated].filter((f) => !offline.has(f)).sort();
  // 这不是失败项 —— 集成测试需要 DB 与端口，本来就不该进离线链。
  // 但要把数量印出来，让人知道「npm test 全绿」并不覆盖这些文件。
  console.log(`  仅集成链（需 DB + 3000 端口，${integrationOnly.length} 个）：${integrationOnly.join(', ')}`);
  check('仅集成链的文件都不是纯静态断言（它们应该真的需要服务）', () => {
    // 粗略判据：文件里出现 http/https 请求或 listen 才允许只在集成链。
    const suspects = [];
    for (const f of integrationOnly) {
      const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
      // 集成测试不一定直接用 http 模块 —— 本项目的都走 test/client.js 这个 helper
      if (!/http\.request|http\.get|fetch\(|listen\(|axios|require\('\.\/client'\)|client\.req|c\.req\(/.test(src)) {
        suspects.push(f);
      }
    }
    assert.deepStrictEqual(suspects, [],
      `这些文件没发请求却只在集成链 —— 挪进离线链更安全：${suspects.join(', ')}`);
  });
}

console.log(`\norphanSuites 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
