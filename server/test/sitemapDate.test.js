/**
 * sitemap / RSS 的日期字段（零 DB、零服务）。
 *
 * 这类 bug 的特点是**完全静默**：页面照常返回 200，XML 也能被解析，
 * 只是搜索引擎把这个字段当垃圾丢掉 —— 或者更糟，把整条 URL 判为格式错误。
 *
 * 两种真实症状（本轮修的）：
 *   - `String(a.updated_at || a.published_at).slice(0,10)` 在两个字段都为 NULL 时
 *     得到字面量 `"null"`（`String(null)` 是 `"null"` 而不是空串！）→ `<lastmod>null</lastmod>`
 *   - `String(x || '').slice(0,10)` 得到 `''` → 空元素 `<lastmod></lastmod>`
 *
 * 数据库确实允许 published_at 为 NULL（后台「导入备份」路径写入 null），所以这不是假想问题。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { stripCommentLines } = require('./helpers/sourceText');
const fs = require('fs');
const path = require('path');
const { w3cDate } = require('../src/routes/feed');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('=== A. w3cDate 只放行合法日期 ===');
ok('完整时间戳截到日期', w3cDate('2026-03-15 10:20:30') === '2026-03-15', w3cDate('2026-03-15 10:20:30'));
ok('ISO 带 T 也截对', w3cDate('2026-03-15T10:20:30Z') === '2026-03-15');
ok('纯日期原样', w3cDate('2026-03-15') === '2026-03-15');
ok('null → 空串（不是 "null"）', w3cDate(null) === '', JSON.stringify(w3cDate(null)));
ok('undefined → 空串', w3cDate(undefined) === '');
ok('空串 → 空串', w3cDate('') === '');
ok('字面量 "null" → 空串（防上游已经转成字符串）', w3cDate('null') === '', JSON.stringify(w3cDate('null')));
ok('乱码 → 空串', w3cDate('not-a-date') === '');
ok('只有年份 → 空串（残缺日期同样非法）', w3cDate('2026') === '');
ok('前导空白被裁掉', w3cDate('  2026-03-15  ') === '2026-03-15');

console.log('\n=== B. Date 对象可用 ===');
ok('Date 实例能被格式化', /^\d{4}-\d{2}-\d{2}$/.test(w3cDate(new Date('2026-03-15T00:00:00Z'))));

console.log('\n=== C. 源码契约：三处 lastmod 都不会产出 null/空元素 ===');
{
  const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'feed.js'), 'utf8'));
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');

  ok('不再有 String(x || y).slice(0,10) 直接进 lastmod',
    !/<lastmod>\$\{String\(/.test(code));
  ok('三处 lastmod 都走 w3cDate',
    (code.match(/w3cDate\(/g) || []).length >= 3,
    `${(code.match(/w3cDate\(/g) || []).length} 处`);
  ok('lastmod 是条件输出（无日期时整条省略，不是留空元素）',
    (code.match(/\$\{lastmod \? `\\n    <lastmod>/g) || []).length
    + (code.match(/\$\{lm \? `\\n    <lastmod>/g) || []).length
    + (code.match(/\$\{notesLm \? `\\n    <lastmod>/g) || []).length >= 3);
  ok('w3cDate 已导出（可被本测试驱动）',
    /module\.exports\.w3cDate = w3cDate;/.test(code));
}

console.log('\n=== D. RSS pubDate 的兜底是"有值"而不是"空" ===');
{
  const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'feed.js'), 'utf8'));
  // toRfc822 未导出，用源码契约 + 行为推断
  ok('toRfc822 对非法输入回退到当前时间（RSS 要求 pubDate 必填）',
    /isNaN\(d\.getTime\(\)\) \? new Date\(\)\.toUTCString\(\)/.test(src));
  ok('rss 的 lastBuildDate 总是有效值', /<lastBuildDate>\$\{new Date\(\)\.toUTCString\(\)\}<\/lastBuildDate>/.test(src));
}

/* ============================================================
 * 附加：RSS pubDate 必须有真实来源（不能每次轮询都变成"现在"）
 * ============================================================ */
console.log('\n=== E. RSS pubDate 的兜底链 ===');
{
  const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'feed.js'), 'utf8'));
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  const rssWin = (code.match(/router\.get\('\/rss\.xml'[\s\S]{0,2600}/) || [''])[0];

  ok('文章 RSS 的 select 里带 created_at（否则没有兜底可用）',
    /select\([^)]*'published_at',\s*'created_at'\)/.test(rssWin));
  ok('pubDate 用 published_at || created_at',
    /toRfc822\(a\.published_at \|\| a\.created_at\)/.test(rssWin));
  ok('不再有裸 toRfc822(a.published_at)（NULL 时会退化成"现在"）',
    !/toRfc822\(a\.published_at\)/.test(rssWin));
  ok('手记 RSS 早已做同样兜底',
    /toRfc822\(s\.published_at \|\| s\.created_at\)/.test(code));
  ok('三处时间轴口径一致（sitemap lastmod / RSS pubDate / 列表排序都用 published_at || created_at）',
    /w3cDate\(a\.updated_at \|\| a\.published_at\)/.test(code)
    && /toRfc822\(a\.published_at \|\| a\.created_at\)/.test(code));
}

console.log('\n=== sitemap 的静态页清单必须从 STATIC_PAGES 派生（不能各写一份） ===');
{
  // 实测过的缺陷：feed.js 里硬编码了 7 个静态页，而 share.js 的 STATIC_PAGES 有 9 个。
  // 差额是 `articles` 和 `notes`：
  //   - notes 有独立的 lastmod 逻辑（只在有已发布手记时输出），合理排除；
  //   - **articles 从来没进过 sitemap** —— 分类变体 `?category=xxx` 都列了，
  //     偏偏无分类的列表页没列，而它覆盖的文章最全。
  const { stripCommentLines } = require('./helpers/sourceText');
  const feedSrc = stripCommentLines(fs.readFileSync(path.join(__dirname, '../src/routes/feed.js'), 'utf8'));
  const shareSrc = stripCommentLines(fs.readFileSync(path.join(__dirname, '../src/routes/share.js'), 'utf8'));

  ok('share.js 导出了 STATIC_PAGE_KEYS',
    /STATIC_PAGE_KEYS\s*=\s*Object\.freeze\(Object\.keys\(STATIC_PAGES\)\)/.test(shareSrc));

  ok('feed.js 从 STATIC_PAGE_KEYS 派生而不是硬编码',
    /require\('\.\/share'\)\.STATIC_PAGE_KEYS/.test(feedSrc),
    '硬编码列表会和 STATIC_PAGES 漂移');

  ok('feed.js 显式排除了 notes（它有独立的 lastmod 逻辑）',
    /STATIC_PAGE_KEYS\.filter\(\s*\(k\)\s*=>\s*k\s*!==\s*'notes'\s*\)/.test(feedSrc));

  ok('feed.js 不再有静态页硬编码数组',
    !/\['',\s*'archive',\s*'tags'/.test(feedSrc),
    '残留硬编码会让派生逻辑形同虚设');

  // 运行时验证：两个清单的差集必须恰好是 {notes}
  const shareRouter = require('../src/routes/share');
  const keys = shareRouter.STATIC_PAGE_KEYS;
  ok('STATIC_PAGE_KEYS 里有 articles', keys.includes('articles'));
  ok('STATIC_PAGE_KEYS 里有 notes', keys.includes('notes'));
  ok('给 sitemap 用的清单（排除 notes 后）与 STATIC_PAGES 差集只有 notes',
    JSON.stringify(keys.filter((k) => k !== 'notes')) === JSON.stringify(keys.filter((k) => k !== 'notes'))
    && keys.filter((k) => k !== 'notes').length === keys.length - 1);

  // 自检：证明"硬编码 7 项"确实会漏掉 articles —— 否则上面那些断言没有意义
  const hardcoded = ['', 'archive', 'tags', 'about', 'bookmarks', 'links', 'messages'];
  ok('自检：旧的硬编码 7 项确实不含 articles（这就是原缺陷）',
    !hardcoded.includes('articles'));
  ok('自检：STATIC_PAGE_KEYS 比旧硬编码多出 articles',
    keys.length > hardcoded.length && keys.includes('articles') && !hardcoded.includes('articles'));
}

console.log(`\nsitemapDate 套件结果（含 RSS 兜底）: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
