/**
 * 时间契约：**写入时钟与查询时钟必须同源**（零 DB、零服务）。
 *
 * 这个项目里所有时间都是「无时区的本地时间字符串」（`YYYY-MM-DD HH:mm:ss`），
 * 于是「本地」到底指哪个时区必须只有一个答案。实际曾有两个来源：
 *
 *   - `comments.created_at` 是 `timestamp DEFAULT CURRENT_TIMESTAMP`
 *     → 值由**数据库会话时区**决定，而会话时区来自 `db.js` 的 `timezone` 选项；
 *   - 评论/留言的 30 分钟查重比较值来自 `localDateTimeStr()` → 固定 `Asia/Shanghai`。
 *
 * `db.js` 原来读**进程时区**（`new Date().getTimezoneOffset()`）。本机是 +08:00，
 * 两者恰好一致，所以一直没暴露。部署在 UTC 服务器上则差 8 小时，
 * 查重窗口整体平移 → **重复提交不再被拦**，而功能表现毫无异常。
 *
 * 现在两边都从 `SITE_TZ` 推导（`siteTimezoneOffset()`），这组断言钉住它不许回退。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  siteTimezoneOffset, localDateTimeStr, localDateStr, zonedParts, SITE_TZ,
} = require('../src/utils/datetime');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SRC = path.join(__dirname, '..', 'src');
const readCode = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');

console.log('=== A. siteTimezoneOffset 的形态与取值 ===');
{
  const off = siteTimezoneOffset();
  check('形如 +HH:MM 或 -HH:MM', /^[+-]\d{2}:\d{2}$/.test(off), off);
  check(`SITE_TZ 是 ${SITE_TZ} 时偏移为 +08:00`, SITE_TZ === 'Asia/Shanghai' ? off === '+08:00' : true, off);
  check('小时部分在 00-14 之间（合法时区偏移范围）',
    Number(off.slice(1, 3)) <= 14, off);
  check('分钟部分是 00/15/30/45 之一（现实中的偏移都是 15 分钟倍数）',
    ['00', '15', '30', '45'].includes(off.slice(4, 6)), off);
  check('多次调用结果稳定', siteTimezoneOffset() === siteTimezoneOffset());
}

console.log('\n=== B. 不依赖进程时区（这是整件事的关键） ===');
{
  // 用子进程把 TZ 设成 UTC 与 America/New_York，看偏移是否仍是 +08:00。
  // 如果实现回退成 `new Date().getTimezoneOffset()`，这里会立刻红。
  const script = `
    const { siteTimezoneOffset } = require(${JSON.stringify(path.join(SRC, 'utils', 'datetime.js'))});
    process.stdout.write(siteTimezoneOffset());
  `;
  const runWithTz = (tz) => execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  }).trim();

  for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo']) {
    let got = '';
    try { got = runWithTz(tz); } catch (e) { got = `ERR:${e.message.slice(0, 40)}`; }
    check(`TZ=${tz} 时偏移仍是 +08:00（不读进程时区）`, got === '+08:00', got);
  }
}

console.log('\n=== C. db.js 与会话时区同源 ===');
{
  const dbCode = readCode('db.js');
  check('db.js 从 utils/datetime 引入 siteTimezoneOffset',
    /require\('\.\/utils\/datetime'\)/.test(dbCode) && /siteTimezoneOffset/.test(dbCode));
  check('db.js 的 timezone 选项用 siteTimezoneOffset()',
    /timezone:\s*siteTimezoneOffset\(\)/.test(dbCode));
  check('db.js **不再**读进程时区（getTimezoneOffset 不该出现）',
    !/getTimezoneOffset/.test(dbCode), '读进程时区会让 UTC 服务器上的查重窗口平移 8 小时');
  check('连接创建时按连接重算偏移（DST 安全）',
    /afterCreate[\s\S]{0,600}siteTimezoneOffset\(\)/.test(dbCode));
  check('会话时区通过 SET SESSION time_zone 下发',
    /SET SESSION time_zone/.test(dbCode));
}

console.log('\n=== D. 30 分钟查重的时间契约 ===');
{
  const comments = readCode(path.join('routes', 'comments.js'));
  const messages = readCode(path.join('routes', 'messages.js'));

  for (const [name, src] of [['评论', comments], ['留言', messages]]) {
    check(`${name}查重用 localDateTimeStr 生成比较值（不是 db.fn.now 或原始 Date）`,
      /created_at', '>', localDateTimeStr\(new Date\(Date\.now\(\) - 30 \* 60 \* 1000\)\)/.test(src));
    check(`${name}查重比较的是**清洗后**的内容（原始输入含 &/< 时永远查不中）`,
      /where\('content', cleanContent\)/.test(src));
    check(`${name}查重按 IP 隔离（否则同内容不同人会被误判）`,
      /where\('ip', req\.ip/.test(src));
  }
}

console.log('\n=== E. 30 分钟窗口的边界计算 ===');
{
  // 用固定时刻验证「30 分钟前」的字符串形态与跨日行为
  const now = new Date('2026-03-15T10:00:00Z');
  const thirtyAgo = new Date(now.getTime() - 30 * 60 * 1000);
  check('窗口起点是 30 分钟前',
    now.getTime() - thirtyAgo.getTime() === 30 * 60 * 1000);
  check('窗口起点的字符串是合法格式',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(localDateTimeStr(thirtyAgo)),
    localDateTimeStr(thirtyAgo));

  // 跨日：上海 00:10 的 30 分钟前是前一天 23:40
  // UTC 2026-03-15T16:10Z = 上海 2026-03-16 00:10
  const midnightish = new Date('2026-03-15T16:10:00Z');
  check('上海 00:10 的日期是 03-16', localDateStr(midnightish) === '2026-03-16', localDateStr(midnightish));
  const before = new Date(midnightish.getTime() - 30 * 60 * 1000);
  check('30 分钟前落到前一天 03-15', localDateStr(before) === '2026-03-15', localDateStr(before));
  check('跨日时字符串仍可做字典序比较（YYYY-MM-DD HH:mm:ss 的设计前提）',
    localDateTimeStr(before) < localDateTimeStr(midnightish),
    `${localDateTimeStr(before)} < ${localDateTimeStr(midnightish)}`);
}

console.log('\n=== F. 字典序比较的前提：补零 ===');
{
  // 字符串比较 `created_at > '2026-03-15 09:05:00'` 成立的前提是月/日/时/分/秒都补到两位。
  // 少补一位时 '2026-3-5 9:05:00' > '2026-12-31 23:59:59' 会变成 true（字符串比较 '3' > '1'）。
  for (const iso of ['2026-01-05T00:05:06Z', '2026-11-30T23:59:59Z', '2026-02-09T08:07:06Z']) {
    const s = localDateTimeStr(new Date(iso));
    check(`${s} 各段都补到两位`, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s), s);
  }
  const p = zonedParts(new Date('2026-01-05T00:05:06Z'));
  check('zonedParts 的 month/day/hour/minute/second 都是两位字符串',
    [p.month, p.day, p.hour, p.minute, p.second].every((v) => typeof v === 'string' && v.length === 2),
    JSON.stringify(p));
}

console.log('\n=== G. 回归保险：不许再出现第二套「本地时间」定义 ===');
{
  const files = ['db.js', 'utils/datetime.js'];
  for (const f of files) {
    const src = readCode(f);
    // 允许在 fallback 路径里出现一次（Intl 不支持时），但主路径必须走 SITE_TZ
    const occurrences = (src.match(/getTimezoneOffset/g) || []).length;
    check(`${f} 里 getTimezoneOffset 至多出现在回落分支（≤1 处）`, occurrences <= 1, String(occurrences));
  }
  const dt = readCode('utils/datetime.js');
  check('siteTimezoneOffset 已导出', /module\.exports[\s\S]{0,400}siteTimezoneOffset/.test(dt));
  check('偏移从 SITE_TZ 推导（用 Intl 的 longOffset）',
    /timeZoneName:\s*'longOffset'/.test(dt) && /timeZone:\s*SITE_TZ/.test(dt));
}

console.log(`\ntimeContract 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
