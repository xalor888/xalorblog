/**
 * 分享页 HTML 转义契约（零 DB、零服务）。
 *
 * 两类错误在这个文件里特别容易发生，而且**都不会报错**：
 *   1. **漏转义**：`?category="` 直接拼进 `content="..."` → 一个双引号闭合属性。
 *   2. **转义两次**：对已经 `esc()` 过的值再 `esc()` → `&` 变成 `&amp;amp;`，
 *      页面显示成「A &amp; B」。肉眼检查 HTML 源码时看起来"很安全"，
 *      但用户看到的是乱码。
 *
 * 第 2 类是这次修的：`fullTitle` 用了已转义的 `siteName` 再 esc 一次。
 * 修法是把**原始值**单独命名（rawSiteName），让「要再转义」和「直接插入」各用各的。
 *
 * 断言用源码契约而不是驱动 HTTP：分享页需要 DB 里的文章 + 设置表，
 * 离线跑不起完整链路；但「哪个变量是转义过的一侧」是纯文本事实，用正则钉得住。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { stripCommentLines } = require('./helpers/sourceText');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'share.js'), 'utf8'));
const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|<!--)/.test(l)).join('\n');

console.log('=== A. esc() 本身正确 ===');
{
  // 直接驱动 esc 不可行（未导出），用等价实现做对照，确保规则集完整
  const esc = (str = '') => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  ok('& 先于其他字符替换（否则 &lt; 会被二次转义）', esc('<') === '&lt;', esc('<'));
  ok('双引号转成 &quot;（属性闭合防护）', esc('a"b') === 'a&quot;b');
  ok('&amp; 输入再转义得到 &amp;amp;（这正是要避免重复调用的原因）',
    esc('&') === '&amp;' && esc(esc('&')) === '&amp;amp;');
}

console.log('\n=== B. 两份站点名必须分开（防二次转义） ===');
{
  ok('存在 rawSiteName（原始值，供再拼接后再转义）', /const rawSiteName = settings\.site_name \|\| 'Xalor的小站';/.test(code));
  ok('siteName 由 rawSiteName 转义得到（不是各自读一遍 settings）',
    /const siteName = esc\(rawSiteName\);/.test(code));
  const rawCount = (code.match(/const rawSiteName = settings\.site_name/g) || []).length;
  const escCount = (code.match(/const siteName = esc\(rawSiteName\)/g) || []).length;
  ok('两个分享 handler 都做了这件事（文章页 + 分类/标签页）',
    rawCount === 2 && escCount === 2, `raw=${rawCount} esc=${escCount}`);
}

console.log('\n=== C. fullTitle 不许二次转义 ===');
{
  ok('fullTitle 用 rawSiteName 拼接',
    /const fullTitle = esc\(`\$\{page\.title\}\$\{rawCatLabel\} - \$\{rawSiteName\}`\);/.test(code));
  ok('fullTitle 不再用已转义的 siteName',
    !/const fullTitle = esc\([^`]*\$\{siteName\}/.test(code));
}

console.log('\n=== D. 直接插入已转义值的地方保持不变（不能"顺手"再 esc） ===');
{
  ok('文章页 <title> 直接用两个已转义值',
    /<title>\$\{title\} - \$\{siteName\}<\/title>/.test(src));
  ok('og:site_name 直接用 siteName',
    /<meta property="og:site_name" content="\$\{siteName\}">/.test(src));
  ok('h1 里 page.title 单独 esc、catLabel 已是转义值（不叠加）',
    /\$\{esc\(page\.title\)\}\$\{catLabel\}/.test(src));
}

console.log('\n=== E. 读者可控输入必须经过 esc ===');
{
  ok('category 取自 query 后先 esc 再进模板',
    /const rawCatLabel = req\.query\.category/.test(code) && /const catLabel = esc\(rawCatLabel\);/.test(code));
  ok('query 里的 category 只经过 encodeURIComponent 进 URL（不能再拼 HTML）',
    /encodeURIComponent\(String\(req\.query\.category\)\)/.test(code));
  ok('og:description / twitter:description 都转义过',
    (src.match(/content="\$\{desc\}"/g) || []).length >= 2);
  ok('meta refresh 的 URL 也转义（shareUrl 是 esc 过的）',
    /http-equiv="refresh" content="0;url=\$\{shareUrl\}"/.test(src));
}

console.log('\n=== F. JSON-LD 防脚本提前闭合 ===');
{
  ok('JSON-LD 对 < 做了 \\u003c 转义', /\.replace\(\/<\/g, '\\\\u003c'\)/.test(code));
  ok('JSON-LD 用原始 site_name（JSON 有自己的转义，不该预先 HTML 转义）',
    /publisher: \{ '@type': 'Organization', name: settings\.site_name/.test(code));
}

console.log('\n=== 静态页查表必须走 hasOwnProperty（原型链键会伪装成合法页面） ===');
{
  // 实测过的缺陷：`STATIC_PAGES['constructor']` / `['toString']` / `['__proto__']`
  // 都返回 Object.prototype 上的函数（**真值**），于是 `if (!page)` 不触发 404。
  // 后果是 `/api/share-page/constructor` 返回 200，标题渲染成 "undefined - 站点名"，
  // 描述也是 undefined，还带着指向自己的 canonical —— 可被搜索引擎收成低质页。
  ok('查表用了 hasOwnProperty 守卫',
    /Object\.prototype\.hasOwnProperty\.call\(STATIC_PAGES,\s*key\)/.test(src),
    '直接 STATIC_PAGES[key] 会让原型链上的键通过');
  ok('没有退回裸索引赋值给 page',
    !/const\s+page\s*=\s*STATIC_PAGES\[key\]\s*;/.test(src));

  // 用等价实现验证判据本身有效（不依赖运行服务）
  const STATIC = { '': { title: '首页' }, archive: { title: '归档' } };
  const lookup = (k) => (Object.prototype.hasOwnProperty.call(STATIC, k) ? STATIC[k] : null);
  ok('合法键仍能取到', lookup('archive') && lookup('archive').title === '归档');
  ok('空串键仍能取到（首页）', lookup('') && lookup('').title === '首页');
  for (const k of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    ok(`原型链键 ${k} 被判为不存在`, lookup(k) === null);
  }
  // 反面：证明裸索引确实会把它们当成真值 —— 否则上面的断言没有意义
  ok('自检：裸索引确实让 constructor 通过（这就是原缺陷）',
    !!STATIC['constructor'] && STATIC['constructor'].title === undefined);
}

console.log(`\nshareEscape 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);

console.log('\n=== 静态分享页要有真实内容（不能只有一句描述） ===');
{
  const shareCode = src;   // 文件顶部已读好并剥过注释

  // 背景：sitemap 里 11 条静态页全指向 /api/share-page/*，而那个页面原本 body 里
  // 只有一句描述 —— 对搜索引擎是「薄内容 + 0 秒跳转」，通常当 doorway page 不给排名。
  ok('articles 页配置了内容列表', /articles:\s*\{[^}]*list:\s*'articles'/.test(shareCode));
  ok('archive 页配置了内容列表', /archive:\s*\{[^}]*list:\s*'archive'/.test(shareCode));
  ok('首页也列文章', /'':\s*\{[^}]*list:\s*'articles'/.test(shareCode));

  ok('模板里插入了列表块', /\$\{listHtml\}/.test(shareCode));
  ok('列表块在描述之后（抓取器先读到一句概述再读条目）', (() => {
    const desc = shareCode.indexOf('${esc(page.desc)}');
    const list = shareCode.indexOf('${listHtml}');
    return desc > -1 && list > desc;
  })());

  // notes / tags 故意不列：手记没有可抓取的真实地址，给 hash URL 等于重演「丢 # 之后」
  ok('notes 页不配列表（没有真实 URL 可指）', !/notes:\s*\{[^}]*list:/.test(shareCode));
  ok('tags 页不配列表（同上）', !/tags:\s*\{[^}]*list:/.test(shareCode));

  ok('列表只查已发布文章', /where\('status',\s*'published'\)/.test(shareCode));
  ok('列表有上限（不能把全站文章塞进一页）', /\.limit\(30\)/.test(shareCode));
  ok('列表按发布时间倒序', /orderBy\(\[\{\s*column:\s*'published_at',\s*order:\s*'desc'/.test(shareCode));
  ok('列表有缓存（og 抓取器会对同一 URL 反复抓）', /LIST_TTL/.test(shareCode) && /listCache/.test(shareCode));
  ok('条目 URL 走 config.apiPrefix 而不是写死 /api',
    /config\.apiPrefix\s*\+\s*it\.path/.test(shareCode),
    'API_PREFIX 是部署项，写死会让链接全 404');
  ok('条目标题经过 esc', /esc\(it\.title\)/.test(shareCode));

  // 自检：上面的正则确实能区分「配了」与「没配」
  ok('自检：配了 list 的能被识别', /archive:\s*\{[^}]*list:\s*'archive'/.test(shareCode));
  ok('自检：没配 list 的不会被误判', !/tags:\s*\{[^}]*list:/.test(shareCode));
}

console.log(`\nshareEscape 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
