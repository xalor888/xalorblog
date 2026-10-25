/**
 * 整站阅读统计（无 DB / 无服务）
 * GET /api/stats/reading 的契约必须能脱离数据库被锁死：
 * 这里直接驱动组装函数 buildReadingStats 与字数函数 countWords，
 * 断言「只算已发布」「空库不出 NaN」「350 字/分钟取整」这三条硬契约。
 */
const { buildReadingStats, countWords, WORDS_PER_MINUTE, READING_FIELDS } = require('../src/routes/stats');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

const article = (title, slug, content, status) => ({ title, slug, content, status });

console.log('=== 字数口径 ===');
assert('空串为 0', countWords('') === 0);
assert('null / undefined 为 0', countWords(null) === 0 && countWords(undefined) === 0);
assert('纯中文逐字计数', countWords('中文正文') === 4);
assert('纯英文按词串计数', countWords('hello world') === 2);
assert('中英混排不粘连（Vue3使用 = 3）', countWords('Vue3使用') === 3);
assert('Markdown 标题符号不计入', countWords('# 标题') === 2);
assert('链接只算锚文本，不算 URL', countWords('[文字](https://very.long.url/x?a=1&b=2)') === 2);
assert('图片整段不计入', countWords('![img](/a/b.png)') === 0);
assert('代码块不计入（散文阅读量口径）', countWords('```js\nconst a = 1;\n```\n\n正文') === 2);
assert('行内代码保留文字', countWords('`id`') === 1);
assert('连续空白不重复计数', countWords('中文   正文') === 4);
assert('返回非负整数', Number.isInteger(countWords('a b c')) && countWords('a b c') >= 0);

console.log('\n=== 空库（没文章）===');
const empty = buildReadingStats([]);
assert('longest 为 null', empty.longest === null);
assert('total_words 为 0', empty.total_words === 0);
assert('total_articles 为 0', empty.total_articles === 0);
assert('avg_words 为 0 而不是 NaN', empty.avg_words === 0 && !Number.isNaN(empty.avg_words));
assert('total_reading_minutes 为 0', empty.total_reading_minutes === 0);
assert('字段集合与契约一致',
  JSON.stringify(Object.keys(empty).sort()) === JSON.stringify(
    ['avg_words', 'longest', 'total_articles', 'total_reading_minutes', 'total_words']));
// 脏输入降级：调用方传了非数组也不能抛
assert('非数组输入降级为空库', JSON.stringify(buildReadingStats(null)) === JSON.stringify(empty));
assert('数组内 null 被跳过', JSON.stringify(buildReadingStats([null, undefined])) === JSON.stringify(empty));

console.log('\n=== 只有草稿（必须排除）===');
const draftsOnly = buildReadingStats([
  article('草稿一', 'draft-1', '这里有十个字啊真的十个', 'draft'),
  article('草稿二', 'draft-2', '另一篇草稿内容也不少呢', 'draft'),
]);
assert('草稿不计入篇数', draftsOnly.total_articles === 0);
assert('草稿不计入字数', draftsOnly.total_words === 0);
assert('草稿不产生 longest', draftsOnly.longest === null);
assert('草稿下 avg 仍为 0', draftsOnly.avg_words === 0);
assert('草稿下时长为 0', draftsOnly.total_reading_minutes === 0);

console.log('\n=== 草稿与已发布混排（只留已发布）===');
const mixed = buildReadingStats([
  article('已发布', 'pub', '一二三四五', 'published'),
  article('大草稿', 'draft', '一二三四五六七八九十一二三四五六七八九十', 'draft'),
  article('已发布二', 'pub-2', '六七八', 'published'),
]);
assert('篇数只算已发布', mixed.total_articles === 2);
assert('字数只算已发布（5 + 3）', mixed.total_words === 8);
assert('longest 只从已发布里选', mixed.longest.slug === 'pub' && mixed.longest.words === 5);

console.log('\n=== 正常多篇：求和 / 均值 ===');
const multi = buildReadingStats([
  article('A', 'a', '一'.repeat(100), 'published'),
  article('B', 'b', '二'.repeat(200), 'published'),
  article('C', 'c', '三'.repeat(50), 'published'),
  article('D', 'd', '四'.repeat(150), 'published'),
]);
assert('总字数为各篇之和', multi.total_words === 500);
assert('篇数正确', multi.total_articles === 4);
assert('篇均字数为 500/4 = 125', multi.avg_words === 125);
assert('longest 指向最长那篇', multi.longest.slug === 'b' && multi.longest.words === 200);
assert('longest 只带 title/slug/words 三个字段',
  JSON.stringify(Object.keys(multi.longest).sort()) === JSON.stringify(['slug', 'title', 'words']));

// 均值取整：4/3 = 1.33 → 1；5/3 = 1.67 → 2
const avgDown = buildReadingStats([
  article('a', 'a', '一', 'published'),
  article('b', 'b', '二', 'published'),
  article('c', 'c', '三四', 'published'),
]);
assert('均值向下取整（4/3 → 1）', avgDown.avg_words === 1);
const avgUp = buildReadingStats([
  article('a', 'a', '一', 'published'),
  article('b', 'b', '二三', 'published'),
  article('c', 'c', '四五', 'published'),
]);
assert('均值向上取整（5/3 → 2）', avgUp.avg_words === 2);

// 并列最长：严格大于才替换 → 保留先出现的那篇
const tie = buildReadingStats([
  article('先', 'first', '一二三', 'published'),
  article('后', 'second', '四五六', 'published'),
]);
assert('并列最长保留先出现的一篇', tie.longest.slug === 'first');
assert('并列最长字数正确', tie.longest.words === 3);

// 全空正文：篇数照算、字数 0、longest 仍存在（0 字也是一篇）
const blank = buildReadingStats([
  article('空一', 'e1', '', 'published'),
  article('空二', 'e2', '', 'published'),
]);
assert('无正文时篇数仍计入', blank.total_articles === 2);
assert('无正文时字数为 0', blank.total_words === 0);
assert('无正文时 avg 为 0 不为 NaN', blank.avg_words === 0);
assert('无正文时时长为 0', blank.total_reading_minutes === 0);
assert('无正文时 longest 取首篇且 words 为 0',
  blank.longest.slug === 'e1' && blank.longest.words === 0);

console.log('\n=== 350 字/分钟 取整边界 ===');
assert('阅读速度常量是 350', WORDS_PER_MINUTE === 350);
const minutes = (words) => buildReadingStats([article('t', 't', '字'.repeat(words), 'published')]).total_reading_minutes;
assert('0 字 → 0 分钟', minutes(0) === 0);
assert('1 字 → 1 分钟（向上取整，不出现 0）', minutes(1) === 1);
assert('349 字 → 1 分钟', minutes(349) === 1);
assert('350 字 → 恰好 1 分钟', minutes(350) === 1);
assert('351 字 → 2 分钟（跨过边界即进位）', minutes(351) === 2);
assert('700 字 → 恰好 2 分钟', minutes(700) === 2);
assert('701 字 → 3 分钟', minutes(701) === 3);
assert('非整数倍总是向上取整', minutes(352) === 2 && minutes(699) === 2);

// 关键回归点：时长必须对「总量」取整，不能逐篇取整再相加。
// 100 篇各 10 字：总量 1000 → ceil(1000/350) = 3 分钟；
// 逐篇 ceil 会是 100 × 1 = 100 分钟（误差 30 倍以上）。
const many = buildReadingStats(
  Array.from({ length: 100 }, (_, i) => article(`短${i}`, `s${i}`, '字'.repeat(10), 'published'))
);
assert('短文章多篇不会把时长虚高（100 篇×10 字 → 3 分钟）', many.total_reading_minutes === 3);
assert('该场景字数为 1000', many.total_words === 1000);
assert('该场景均字为 10', many.avg_words === 10);

console.log('\n=== 投影少了 status：严格判定为「不算」 ===');
// 严格判定 `status === 'published'` 是刻意的：若宽松地「无 status 即算已发布」，
// 将来某个调用方只 select 了 title/content，草稿就会静默混进整站统计。
// 严格判定的失败方式是「0 篇」这种响亮错误，而不是悄悄多算。
const noStatus = buildReadingStats([
  { title: 'x', slug: 'x', content: '一二三' },
  { title: 'y', slug: 'y', content: '四五六' },
]);
assert('缺 status 字段一律不计入（宁可报 0 篇也不混入草稿）',
  noStatus.total_articles === 0 && noStatus.total_words === 0 && noStatus.longest === null);
assert('未知 status 值不计入', buildReadingStats([
  { title: 'z', slug: 'z', content: '一二三', status: 'archived' },
]).total_articles === 0);
// 严格判定必须与路由投影配套：READING_FIELDS 一旦漏掉 status，
// 端点会安静地返回「0 篇 0 字」。这条断言把两者的耦合锁死，而不是靠人眼。
assert('路由投影包含 status（与严格判定配套）', READING_FIELDS.includes('status'));
assert('路由投影只含必要列（不多读 mediumtext 之外的字段）',
  JSON.stringify([...READING_FIELDS].sort()) === JSON.stringify(['content', 'slug', 'status', 'title']));

/* ============================================================
   前后端字数一致性
   ============================================================
   同一篇文章的字数会同时出现在三个地方：
     - 详情页「184 字」（web/src/utils/wordStats.js，唯一前端口径）
     - 后台编辑器实时字数（同上）
     - 整站阅读统计（本文件的 countWords）
   三处必须对同一段文本给出同一个数，否则页面上会出现两个互相矛盾的
   「字数」。这里直接把前端的 ESM 模块 import 进来，对同一批语料逐条比对：
   任何一边改了 CJK 区段、改了剥离规则、改了分词方式，这条断言立刻失败。
   （不能只靠 code review —— 之前的真实差异就是这样漏掉的：
     服务端只认 \u4e00-\u9fa5，漏掉扩展 A 与兼容汉字，同一段文本差 2。）
   ============================================================ */
(async () => {
  const web = await import('../../web/src/utils/wordStats.js');
  const fixtures = [
    '',
    '# 标题',
    '中文正文',
    'hello world',
    'Vue3使用',
    '中文abc中文',
    'a中b',
    '[文字](https://very.long.url/x?a=1&b=2)',
    '![img](/a/b.png)',
    '```js\nconst a = 1;\n```\n\n正文',
    '`id`',
    '中文   正文',
    'Extension A: \u3400\u3401',
    '兼容汉字: \uf900\uf901',
    'emoji 😀 test',
    '中文，标点。',
    'under_score and dash-es',
  ];
  let mismatch = 0;
  for (const text of fixtures) {
    const server = countWords(text);
    const front = web.countWords(text).total;
    if (server !== front) {
      mismatch += 1;
      console.log(`  ✗ 字数不一致 ${JSON.stringify(text)} — server=${server} web=${front}`);
    }
  }
  assert('前后端对 17 条语料的字数完全一致', mismatch === 0, `${mismatch} 条不一致`);

  // 阅读速度常量也必须一致（350），否则同一篇文章两边算出不同分钟数
  assert('前后端阅读速度常量一致（350 字/分钟）', WORDS_PER_MINUTE === web.CN_WPM,
    `server=${WORDS_PER_MINUTE} web=${web.CN_WPM}`);

  // 聚合口径也要一致：同一批文章，两边的总时长必须相等
  const sampleRows = [
    { title: 'a', slug: 'a', content: '中'.repeat(10), status: 'published' },
    { title: 'b', slug: 'b', content: 'hello world', status: 'published' },
    { title: 'c', slug: 'c', content: '', status: 'published' },
  ];
  const serverAgg = buildReadingStats(sampleRows);
  const webAgg = web.aggregateReading(sampleRows.map((r) => ({ ...r, content: r.content })));
  assert('前后端聚合结果一致（总字数/总时长/均值）',
    serverAgg.total_words === webAgg.total_words
    && serverAgg.total_reading_minutes === webAgg.total_reading_minutes
    && serverAgg.avg_words === webAgg.avg_words,
    `server=${JSON.stringify(serverAgg)} web=${JSON.stringify(webAgg)}`);

  console.log(`\nreadingStats 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
})();
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
