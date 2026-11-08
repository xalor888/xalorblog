/**
 * 手记列表的「摘要读取量」契约（零 DB、零服务）。
 *
 * 背景：列表接口原来 `select('content')` —— content 是 mediumtext，
 * 而每页最多 20 条。一篇 20 万字的手记会让单次请求把 400 万字读进内存，
 * 只为算出「前 200 字摘要」。现在改成 SQL 侧 `LEFT(content, N)`。
 *
 * 这组断言防的是三件事：
 *   A. 有人把 `LEFT(...)` 改回裸 `'content'`（性能回退，且不会报错）；
 *   B. 有人把 N 调小到不足以产出完整摘要（功能回退，且只是「摘要变短」，很难发现）；
 *   C. N 与 EXCERPT_LEN 的关系被破坏（N 必须明显大于 EXCERPT_LEN）。
 *
 * B 用**真实驱动**验证：构造一段「前面全是 Markdown 噪音」的正文，截断到 N 之后
 * 交给 noteSummary，摘要仍应达到 EXCERPT_LEN。这比断言常量大小更能说明问题。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const fs = require('fs');
const path = require('path');
const { SUMMARY_CONTENT_CHARS } = require('../src/routes/notes');
const { noteSummary, EXCERPT_LEN, MAX_NOTE_IMAGES } = require('../src/utils/notes');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const notesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'notes.js'), 'utf8');
const listWin = (notesSrc.match(/router\.get\('\/'[\s\S]{0,2000}/) || [''])[0];

console.log('=== A. SQL 侧必须截断，不能整列读 ===');
ok('列表用到 LEFT(content, ?) 截断', /db\.raw\('LEFT\(content, \?\) AS content'/.test(listWin));
ok('列表的 select 里不再出现裸 content 列', !/'id', 'content', 'images'/.test(listWin));
ok('截断参数来自 SUMMARY_CONTENT_CHARS 常量（不是魔法数字）',
  /\[SUMMARY_CONTENT_CHARS\]/.test(listWin));

console.log('\n=== B. 截断长度必须够生成完整摘要（真实驱动） ===');
ok(`SUMMARY_CONTENT_CHARS(${SUMMARY_CONTENT_CHARS}) 明显大于 EXCERPT_LEN(${EXCERPT_LEN})`,
  SUMMARY_CONTENT_CHARS >= EXCERPT_LEN * 5,
  `比例 ${SUMMARY_CONTENT_CHARS / EXCERPT_LEN}`);

{
  // 构造一段「纯 Markdown 噪音」开头的正文：前 800 个字符全是标记，
  // 之后才是正文。若 N 太小，剥完 Markdown 后正文不够 200 字。
  const noise = '**'.repeat(400); // 400 个加粗标记，plainText 后几乎全没
  const body = noise + '手'.repeat(600);
  const truncated = body.slice(0, SUMMARY_CONTENT_CHARS);
  const row = {
    id: 1, content: truncated, images: '[]', excerpt: '',
    mood: '', location: '', likes: 0, is_pinned: false,
    status: 'published', published_at: '2026-01-01 00:00:00', created_at: '2026-01-01 00:00:00',
  };
  const summary = noteSummary(row);
  ok('截断后仍能生成完整 200 字摘要（Markdown 噪音不吞掉摘要长度）',
    summary.excerpt.length >= EXCERPT_LEN,
    `实际 ${summary.excerpt.length} 字`);
  ok('摘要不含原始 Markdown 标记', !summary.excerpt.includes('**'),
    summary.excerpt.slice(0, 40));
  ok('列表行不含 content（正文只在详情以密文下发）', !('content' in summary));
}

console.log('\n=== C. 已有 excerpt 时不依赖 content（省的是纯多余读取） ===');
{
  const row = {
    id: 2, content: '手'.repeat(SUMMARY_CONTENT_CHARS), images: '[]',
    excerpt: '后台手填的摘要', mood: '', location: '', likes: 0, is_pinned: false,
    status: 'published', published_at: '2026-01-01 00:00:00', created_at: '2026-01-01 00:00:00',
  };
  ok('excerpt 优先，不被正文覆盖', noteSummary(row).excerpt === '后台手填的摘要');
}

console.log('\n=== D. 图片列同样只取必要信息 ===');
{
  const imgs = JSON.stringify(Array.from({ length: 20 }, (_, i) => `/uploads/ai/${i}.png`));
  const row = {
    id: 3, content: '', images: imgs, excerpt: 'x', mood: '', location: '', likes: 0,
    is_pinned: false, status: 'published', published_at: '2026-01-01 00:00:00', created_at: '2026-01-01 00:00:00',
  };
  const s = noteSummary(row);
  ok(`image_count 截到上限 ${MAX_NOTE_IMAGES}`, s.image_count === MAX_NOTE_IMAGES, `实际 ${s.image_count}`);
  ok('cover 是相对路径（可直接给 <img src>）', String(s.cover).startsWith('/uploads/'));
}

console.log(`\nnotesListPerf 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
