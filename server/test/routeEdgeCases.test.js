/**
 * 路由边界回归（无 DB / 无服务）
 *
 * 三处缺陷的共同点：本地数据都是「正常值」时永远测不出来，一旦出现
 * 空值或通配符字符就静默给错结果 —— 这类错不会报 500，只会安静地返回
 * 一个看起来合理的空集合，所以必须用静态契约锁住，而不是靠手工点击。
 *
 * 用法：node test/routeEdgeCases.test.js
 */
// 源码断言一律剥注释：注释里复述写法会让正向断言假绿、否定断言假红
const { stripCommentLines } = require('./helpers/sourceText');
const fs = require('fs');
const path = require('path');
const { escapeLike } = require('../src/utils/sanitize');

let passed = 0;
let failed = 0;
const failures = [];
function assert(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` | ${extra}` : ''));
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const articlesSrc = stripCommentLines(fs.readFileSync(path.join(__dirname, '../src/routes/articles.js'), 'utf8'));
const aiSrc = stripCommentLines(fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8'));

console.log('=== escapeLike：通配符必须按字面匹配 ===');
assert('_ 被转义（未转义时 LIKE 退化为任意单字符，检索变成全表匹配）',
  escapeLike('_') === '\\_', `得到 ${JSON.stringify(escapeLike('_'))}`);
assert('% 被转义', escapeLike('%') === '\\%', `得到 ${JSON.stringify(escapeLike('%'))}`);
assert('反斜杠自身被转义（否则可构造 \\_ 反逃逸）', escapeLike('\\') === '\\\\');
assert('普通文本原样保留', escapeLike('Vue 组合式') === 'Vue 组合式');

console.log('\n=== ai.js：站内检索工具也要转义 ===');
assert('引入了 escapeLike', /require\([\'"]\.\.\/utils\/sanitize[\'"]\)[\s\S]{0,80}escapeLike|escapeLike[\s\S]{0,80}require/.test(aiSrc),
  '未引入就只能裸拼 LIKE');
// 取 search_site_articles 分支的 like 构造行，断言它包了 escapeLike
const toolBlock = aiSrc.indexOf("if (name === 'search_site_articles')");
assert('能找到 search_site_articles 分支', toolBlock !== -1);
if (toolBlock !== -1) {
  const window = aiSrc.slice(toolBlock, toolBlock + 900);
  assert('该分支的 LIKE 参数经过 escapeLike',
    /const like = `%\$\{escapeLike\(/.test(window),
    '读者传 "_" / "%" 时结果会变成「最近 5 篇」而不是「匹配 5 篇」');
}

console.log('\n=== articles.js /archive：published_at 为空时不能造伪分组 ===');
assert('投影里带上 created_at 作为兜底',
  /\.select\('id', 'title', 'slug', 'published_at', 'created_at', 'views'\)/.test(articlesSrc),
  '只选 published_at 就无从兜底');
// 分组逻辑已抽成纯函数 buildArchiveGroups（可单测，见 archiveCache.test.js），
// 这里只钉「形参上确实做了 published_at 优先、created_at 兜底」这一语义，
// 不钉 String(...) 的具体包裹形态 —— 否则一次合理重构就会红在无关细节上。
assert('分组键对 published_at 做了 created_at 兜底',
  /published_at \|\| r\.created_at/.test(articlesSrc),
  'String(null) 会得到 "null"，归档页因此多出 month:"null" 的伪分组');
assert('两者皆空的行被跳过而非归入伪分组',
  /if \(!dayStr\) continue;/.test(articlesSrc));

console.log('\n=== articles.js /neighbors：NULL 时间轴必须参与比较 ===');
assert('查询当前文章时取回 created_at',
  /select\('published_at', 'created_at'\)\.first\(\)/.test(articlesSrc));
assert('当前时间轴做了 COALESCE 兜底',
  /const curAt = cur\.published_at \|\| cur\.created_at;/.test(articlesSrc),
  'published_at < NULL 恒为 UNKNOWN，本篇会既无上一篇也无下一篇');
const coalesceCount = (articlesSrc.match(/COALESCE\(published_at, created_at\)/g) || []).length;
assert('过滤与排序都走同一条时间轴（4 处）', coalesceCount >= 4,
  `实际 ${coalesceCount} 处；只改过滤不改排序会出现邻居关系不自洽`);

/* ============================================================
 * 附加：每个 *.test.js 都必须至少被一条链执行（不许有"写了但从不跑"的文件）
 * ============================================================ */
console.log('\n【测试文件登记完整性】');
{
  const fs = require('fs');
  const path = require('path');
  const testDir = __dirname;
  const serverDir = path.join(testDir, '..');

  const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
  const offline = new Set(
    [...String(pkg.scripts.test || '').matchAll(/node test\/([\w.-]+\.test\.js)/g)].map((m) => m[1])
  );
  const runSrc = stripCommentLines(fs.readFileSync(path.join(testDir, 'run.js'), 'utf8'));
  const suitesBlock = (runSrc.match(/\[\s*'(?:admin|2fa)[\s\S]*?\]/) || [''])[0];
  const integration = new Set([...suitesBlock.matchAll(/'([\w.-]+\.test\.js)'/g)].map((m) => m[1]));

  const onDisk = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js'));
  const orphans = onDisk.filter((f) => !offline.has(f) && !integration.has(f));

  assert(`磁盘上 ${onDisk.length} 个测试文件都至少被一条链登记`,
    orphans.length === 0, orphans.join(', '));
  assert('离线链非空', offline.size > 20, String(offline.size));
  assert('集成链非空', integration.size > 5, String(integration.size));

  // 两个集合必须有交集（sanitize/feed 这类不需要 DB 的套件两边都跑），
  // 若交集为空说明有人把集成列表换成了完全独立的一套，值得复核
  const both = [...offline].filter((f) => integration.has(f));
  assert('有同时出现在两条链里的套件（说明分层是"能离线就先离线"）', both.length > 0, both.join(', '));

  // 孤儿检测必须还在 run.js 里（否则新增集成测试会静默不执行）
  assert('run.js 保留了孤儿套件检测', /warnOrphanSuites/.test(runSrc));
  assert('孤儿检测会把退出码置 1（不只是打印）',
    /warnOrphanSuites[\s\S]{0,1200}process\.exitCode\s*=\s*1/.test(runSrc)
    || /process\.exitCode\s*=\s*1[\s\S]{0,200}warnOrphanSuites/.test(runSrc));
  assert('孤儿检测读的是 package.json 的 test 链（口径与实际执行一致）',
    /scripts\.test/.test(runSrc));
}

console.log(`\nrouteEdgeCases 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
