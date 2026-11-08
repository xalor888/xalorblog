/** 站点日历：固定 Asia/Shanghai，避免服务器 TZ=UTC 把「今天」错一天 */

const SITE_TZ = 'Asia/Shanghai';

/**
 * 模块级单例 formatter。
 * `new Intl.DateTimeFormat()` 的构造开销比 `formatToParts()` 高一个数量级，而这两个函数
 * 在请求热路径上（PV/UV 去重、评论 30 分钟查重、访问统计）被频繁调用。
 * Intl 实例创建后不可变，跨请求复用是安全的；日期由参数传入，不依赖构造时刻。
 */
const PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SITE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * 取站点时区下的时间字段（year/month/day/hour/minute/second，全为字符串）。
 *
 * ⚠ 必须挡掉非 Date 输入。这不是洁癖 —— `Intl.formatToParts` 对**非 Date 值**的行为
 * 是「先隐式转数字时间戳」，于是：
 *
 *   formatToParts(null)      → 1970-01-01 08:00:00   （null → 0）
 *   formatToParts(0)         → 1970-01-01 08:00:00
 *   formatToParts('2026-01-01') → 抛 RangeError
 *   formatToParts(Invalid)   → 抛 RangeError
 *
 * 也就是说 `localDateStr(row.published_at)` 这种写法，一旦字段是 NULL，
 * 会**静默产出 `1970-01-01`** 并被写进库或渲染给用户 —— 没有异常、没有日志。
 * 恰恰 published_at 在「导入备份」路径上允许为 NULL，所以这不是假想场景。
 *
 * `undefined` 例外：走默认参数，语义就是「取当前时间」，是有意的。
 */
function zonedParts(d = new Date()) {
  if (!(d instanceof Date)) {
    throw new TypeError(
      `datetime: 需要 Date 实例，收到 ${d === null ? 'null' : typeof d}。` +
      '（直接传数据库字段前请先判空：null 会被 Intl 当成时间戳 0，产出 1970-01-01）'
    );
  }
  if (Number.isNaN(d.getTime())) {
    throw new TypeError('datetime: 收到 Invalid Date');
  }
  const parts = {};
  for (const p of PARTS_FMT.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return parts;
}

/** 站点日期字符串 YYYY-MM-DD（上海日历） */
function localDateStr(d = new Date()) {
  const p = zonedParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 站点日期时间字符串 YYYY-MM-DD HH:mm:ss（上海时钟） */
function localDateTimeStr(d = new Date()) {
  const p = zonedParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * 站点时区相对 UTC 的偏移字符串（形如 `+08:00`），**由 SITE_TZ 推导而不是读进程时区**。
 *
 * 为什么必须从 SITE_TZ 推导：这个值要给 `db.js` 的 mysql2 连接用（`timezone` 选项），
 * 而 mysql2 的时区决定了数据库端 `CURRENT_TIMESTAMP` 与 JS `Date` 之间的换算基准。
 *
 * 之前的实现是 `-new Date().getTimezoneOffset()`（读**进程**时区），于是出现了一个
 * 只在特定部署下暴露的错位：
 *   - `created_at` 列是 `timestamp DEFAULT CURRENT_TIMESTAMP` —— 由**数据库会话时区**生成；
 *   - 评论/留言的 30 分钟查重却用 `localDateTimeStr()` 生成比较值 —— 固定按 SITE_TZ；
 *   - 服务器跑在 UTC 时，前者是 UTC、后者是 +08:00，两者差 8 小时，
 *     查重窗口实际变成「7.5 小时前到 30 分钟前」→ **永远不命中**（或永远命中），
 *     而功能上完全看不出异常：重复提交只是不再被拦。
 * 本机是 +08:00 所以一直没暴露。改成都由 SITE_TZ 推导后，两处必然一致。
 */
function siteTimezoneOffset() {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: SITE_TZ, timeZoneName: 'longOffset' });
    const part = fmt.formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
    const m = /GMT([+-]\d{2}:\d{2})/.exec(part ? part.value : '');
    if (m) return m[1];
  } catch (e) {
    // Intl 不支持 longOffset（很老的 Node）时回落到读进程时区
  }
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

module.exports = { localDateStr, localDateTimeStr, zonedParts, siteTimezoneOffset, SITE_TZ };
