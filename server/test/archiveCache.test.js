/**
 * /api/articles/archive 的分组与缓存契约（零 DB、零服务）。
 *
 * 这个接口曾经是「一次全表读 + 全量分组，无缓存无上限」——文章量上来后是全站最贵的读接口，
 * 而内容变化频率极低。现在有 60s TTL 缓存 + 硬读上限，分组逻辑抽成纯函数 `buildArchiveGroups`。
 *
 * 断言分两组：
 *   A. 纯函数行为（可驱动，是真单测）：NULL 时间兜底、空行跳过、月份分组、排序保持、脏输入不炸。
 *   B. 源码契约（路由需要 DB，离线跑不起）：缓存读取顺序、TTL 常量、上限、导出。
 *      B 组用文本断言不理想，但它防的是「把缓存删掉/顺序写反」这类静默回退 —— 值得留。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { stripCommentLines } = require('./helpers/sourceText');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildArchiveGroups, invalidateArchiveCache } = require('../src/routes/articles');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('=== A. buildArchiveGroups：分组与兜底 ===');
{
  const rows = [
    { id: 1, title: 'A', slug: 'a', published_at: '2026-03-15 10:00:00', created_at: '2026-03-01 00:00:00', views: 5 },
    { id: 2, title: 'B', slug: 'b', published_at: null, created_at: '2026-02-20 09:00:00', views: 3 },
    { id: 3, title: 'C', slug: 'c', published_at: '2026-02-01 00:00:00', created_at: '2026-01-01 00:00:00', views: 1 },
  ];
  const out = buildArchiveGroups(rows);
  ok('按年月分组，顺序保持输入顺序', out.map((g) => g.month).join(',') === '2026-03,2026-02', JSON.stringify(out.map((g) => g.month)));
  ok('每组 count 等于该组条目数', out.every((g) => g.count === g.items.length));
  ok('published_at 为 NULL 时用 created_at 兜底（不再产生 month:"null"）',
    out.some((g) => g.month === '2026-02' && g.items.some((i) => i.id === 2)),
    JSON.stringify(out.map((g) => g.month)));
  ok('不出现字符串 "null" 分组', !out.some((g) => g.month === 'null' || g.month === ''));
  ok('day 取日期后两位', out[0].items[0].day === '15', out[0].items[0].day);
  ok('条目只带白名单字段（不泄露正文）',
    out[0].items.every((i) => Object.keys(i).sort().join(',') === 'day,id,slug,title,views'));
}

console.log('\n=== B. 脏输入不炸（防御性） ===');
ok('空数组 → 空分组', buildArchiveGroups([]).length === 0);
ok('非数组 → 空分组', buildArchiveGroups(null).length === 0 && buildArchiveGroups(undefined).length === 0);
ok('两者皆空的行被跳过（不造伪分组）',
  buildArchiveGroups([{ id: 9, published_at: null, created_at: null }]).length === 0);
ok('数组里的 null 项被跳过', buildArchiveGroups([null, { id: 1, published_at: '2026-01-02 00:00:00' }]).length === 1);

console.log('\n=== C. 源码契约：缓存与上限（路由需要 DB，用文本断言） ===');
{
  const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'articles.js'), 'utf8'));
  const routeWin = (src.match(/router\.get\('\/archive'[\s\S]{0,1600}/) || [''])[0];
  ok('先查缓存再查库（命中即返回，不进入 DB 路径）',
    /if \(archiveCache && now - archiveCacheAt < ARCHIVE_TTL\)[\s\S]{0,120}return ok\(res, archiveCache\)/.test(routeWin));
  ok('查询后有写缓存（否则缓存永不生效）',
    /archiveCache = list;/.test(routeWin) && /archiveCacheAt = now;/.test(routeWin));
  ok('TTL 常量存在且是 60 秒', /const ARCHIVE_TTL = 60 \* 1000;/.test(src));
  ok('读上限存在且写进了 SQL（.limit）',
    /const ARCHIVE_MAX_ROWS = \d+;/.test(src) && /\.limit\(ARCHIVE_MAX_ROWS\)/.test(routeWin));
  ok('触上限时告警（否则"归档不完整"永远没人发现）',
    /archiveOverflowWarned/.test(routeWin) && /console\.warn/.test(routeWin));
  ok('导出 buildArchiveGroups 与 invalidateArchiveCache（可测 + 可手动失效）',
    /module\.exports\.buildArchiveGroups = buildArchiveGroups;/.test(src)
    && /module\.exports\.invalidateArchiveCache = invalidateArchiveCache;/.test(src));
  ok('invalidateArchiveCache 可调用且不抛错', (invalidateArchiveCache(), true));
}

console.log(`\narchiveCache 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
