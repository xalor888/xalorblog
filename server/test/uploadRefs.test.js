/**
 * `extractUploadRefs` 与它的 SQL 预过滤（零 DB、零服务）。
 *
 * 这条链路决定「哪些图还在用」。判错的后果是不对称的：
 *   - 漏判（该算引用的没算）→ 图片管理页显示「未引用」、孤儿清理**真的删掉**，正文变破图；
 *   - 多判（不算引用的算成引用）→ 只是删不掉一个真正的孤儿，无害。
 *
 * 所以断言的重点在**漏判侧**：一层子目录（AI 转存图）、各种引号/括号包裹、
 * 正文与图片集两条来源。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const {
  extractUploadRefs,
  UPLOAD_REF_SQL_LIKE,
  listUploadFiles,
} = require('../src/utils/uploads');

let passCount = 0, failCount = 0;
function check(name, fn) {
  try { fn(); passCount++; console.log(`  ✓ ${name}`); }
  catch (e) { failCount++; console.log(`  ✗ ${name} — ${e.message}`); }
}

const refs = (text) => [...extractUploadRefs(text)];

console.log('=== A. 基本提取 ===');
check('单个顶层文件', () => {
  assert.deepStrictEqual(refs('![x](/uploads/a.png)'), ['a.png']);
});
check('一层子目录（AI 转存图）', () => {
  assert.deepStrictEqual(refs('/uploads/ai/b.jpg'), ['ai/b.jpg']);
});
check('同一段里多个引用', () => {
  assert.deepStrictEqual(refs('/uploads/a.png 和 /uploads/b.png').sort(), ['a.png', 'b.png']);
});
check('重复引用只记一次', () => {
  const set = extractUploadRefs('/uploads/a.png /uploads/a.png');
  assert.strictEqual(set.size, 1);
});

console.log('\n=== B. 各种包裹形式都要认（漏了就会删掉在用的图）===');
for (const [label, text, want] of [
  ['Markdown 图片', '![alt](/uploads/x.png)', 'x.png'],
  ['Markdown 带 title', '![alt](/uploads/x.png "标题")', 'x.png'],
  ['HTML img', '<img src="/uploads/x.png">', 'x.png'],
  ['HTML 单引号', "<img src='/uploads/x.png'>", 'x.png'],
  ['裸 URL 带查询串', '/uploads/x.png?w=300', 'x.png'],
  ['裸 URL 带 hash', '/uploads/x.png#top', 'x.png'],
  ['JSON 里的字符串', '{"url":"/uploads/x.png"}', 'x.png'],
  ['中文紧邻', '看这张图/uploads/x.png很漂亮', 'x.png'],
  ['换行分隔', 'a\n/uploads/x.png\nb', 'x.png'],
]) {
  check(`${label} → ${want}`, () => {
    assert.ok(refs(text).includes(want), `没提取到 ${want}，实际 ${JSON.stringify(refs(text))}`);
  });
}

console.log('\n=== C. 三层以上不提取（这是已知限制，写出来免得误以为支持）===');
check('两层路径只提取第一层子目录的部分', () => {
  // /uploads/a/b/c.png → 正则匹配到 a/b，剩下 /c.png 不再匹配
  assert.deepStrictEqual(refs('/uploads/a/b/c.png'), ['a/b']);
});
check('反斜杠不是路径分隔符（URL 里本来就该是 /）', () => {
  assert.deepStrictEqual(refs('/uploads\\a.png'), []);
});

console.log('\n=== D. 不该误报的形式 ===');
for (const [label, text] of [
  ['大写目录名（路径区分大小写）', '/Uploads/x.png'],
  ['只有目录没有文件名', '/uploads/'],
  ['空串', ''],
  ['非字符串', null],
  ['数字', 123],
]) {
  check(`${label} 不产生引用`, () => {
    assert.deepStrictEqual(refs(text), []);
  });
}

console.log('\n=== D2. 「多判」方向的两种误报：无害，但写出来 ===');
// 这两条其实是**会**提取到的。判成「已引用」的后果只是那个真正的孤儿删不掉，
// 属于安全的一侧（漏判才会删掉在用的图）。所以不修，只记录。
check('外部 CDN 上同名路径也会被当成引用（多判，无害）', () => {
  assert.deepStrictEqual(refs('https://cdn.example.com/uploads/x.png'), ['x.png']);
});
check('相对路径 ./uploads/ 也会被当成引用（多判，无害）', () => {
  assert.deepStrictEqual(refs('./uploads/x.png'), ['x.png']);
});
check('说明：多判只让孤儿删不掉，漏判才会破图 —— 所以正则宁宽勿窄', () => {
  // 用一条断言表达这个取舍，而不是只写在注释里
  const wide = refs('https://elsewhere/uploads/only-there.png');
  assert.ok(wide.length > 0, '如果这里变成空，说明正则被收窄了 —— 收窄会带来漏判风险');
});

console.log('\n=== E. 边界：/uploads/ai/ 这种「只有目录」的形态 ===');
check('提取出一个目录名（会进集合，但无害 —— 它不对应真实文件）', () => {
  // 记录这个行为而不是「修」它：多判一个不存在的名字只会让那个名字「不可删」，
  // 而它本来就没有对应文件。真正的风险方向是漏判，不是多判。
  assert.deepStrictEqual(refs('/uploads/ai/'), ['ai']);
});

console.log('\n=== F. SQL 预过滤的必要条件（这条是性能优化的正确性依据）===');
check('任何能被提取的文本都包含字面量 /uploads/', () => {
  const samples = [
    '![x](/uploads/a.png)',
    '/uploads/ai/b.jpg',
    '前文/uploads/c.gif?w=1后文',
    '{"images":["/uploads/d.webp"]}',
  ];
  for (const s of samples) {
    const found = refs(s);
    assert.ok(found.length > 0, `样本应能提取出引用：${s}`);
    assert.ok(s.includes('/uploads/'),
      `提取出了 ${JSON.stringify(found)} 但文本不含 /uploads/ —— 那 LIKE 预过滤会漏掉它`);
  }
});
check('UPLOAD_REF_SQL_LIKE 就是 /uploads/ 的包含匹配', () => {
  assert.strictEqual(UPLOAD_REF_SQL_LIKE, '%/uploads/%');
});
check('SQL LIKE 模式的两端通配符没写反', () => {
  assert.ok(UPLOAD_REF_SQL_LIKE.startsWith('%'), '开头要有 % —— 否则只能匹配以 /uploads/ 开头的文本');
  assert.ok(UPLOAD_REF_SQL_LIKE.endsWith('%'), '结尾要有 % —— 否则只能匹配以 /uploads/ 结尾的文本');
});

console.log('\n=== F2. 首字符类：点开头的名字不得进引用集合 ===');
// ⚠ 变异 U14（把首字符类放开成 `[A-Za-z0-9._-]+`）第一版没被抓到。
// 一旦放开，`/uploads/../etc/passwd` 会被解析成引用 `..`，
// 而引用集合正是**孤儿清理的排除名单** —— 带 `..` 的条目会让清理逻辑比对错位。
check('点开头的名字不产生引用（../ 不能被当成文件名）', () => {
  assert.deepStrictEqual([...extractUploadRefs('/uploads/../etc/passwd')], []);
  assert.deepStrictEqual([...extractUploadRefs('/uploads/..')], []);
  assert.deepStrictEqual([...extractUploadRefs('/uploads/.')], []);
  assert.deepStrictEqual([...extractUploadRefs('/uploads/.htaccess')], []);
  assert.deepStrictEqual([...extractUploadRefs('/uploads/.git/config')], []);
});
check('下划线/减号开头的名字仍合法（不是把整个字符类收紧）', () => {
  assert.deepStrictEqual([...extractUploadRefs('/uploads/_a.png')], ['_a.png']);
  assert.deepStrictEqual([...extractUploadRefs('/uploads/-b.png')], ['-b.png']);
});

console.log('\n=== G. 复用同一个 Set（collectReferencedUploads 的用法）===');
check('into 参数可累加', () => {
  const acc = new Set();
  extractUploadRefs('/uploads/a.png', acc);
  extractUploadRefs('/uploads/b.png', acc);
  assert.deepStrictEqual([...acc].sort(), ['a.png', 'b.png']);
});
check('不传 into 时返回新 Set', () => {
  const s1 = extractUploadRefs('/uploads/a.png');
  const s2 = extractUploadRefs('/uploads/b.png');
  assert.notStrictEqual(s1, s2);
  assert.strictEqual(s1.size, 1);
});

console.log('\n=== H. 自检：g 正则的状态陷阱 ===');
check('连续调用不互相干扰（lastIndex 必须重置）', () => {
  const a = refs('/uploads/one.png');
  const b = refs('/uploads/two.png');
  assert.deepStrictEqual(a, ['one.png']);
  assert.deepStrictEqual(b, ['two.png'], '第二次调用受上次 lastIndex 影响 —— 会漏结果');
});
check('自检：不重置 lastIndex 确实会漏（证明这条断言有意义）', () => {
  const re = /\/uploads\/([A-Za-z0-9._-]+)/g;
  const s = '/uploads/one.png';
  const first = s.match(re);
  const second = s.match(re); // match 带 g 会重置，这里演示 String.match 与 exec 的差别
  assert.deepStrictEqual(first, second, 'String.match 带 g 每次重置，所以这里相等');
  // 换成 exec 就会暴露状态：
  const re2 = /\/uploads\/([A-Za-z0-9._-]+)/g;
  re2.exec(s);
  assert.strictEqual(re2.lastIndex, s.length, 'exec 会留下 lastIndex，复用前必须手动清零');
});

console.log('\n=== I. listUploadFiles 仍在（回归：不能因为重构把导出弄丢）===');
check('listUploadFiles 是函数', () => {
  assert.strictEqual(typeof listUploadFiles, 'function');
});

console.log(`\nuploadRefs 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
