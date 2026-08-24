/** 站点日历：固定 Asia/Shanghai，避免服务器 TZ=UTC 把「今天」错一天 */

const SITE_TZ = 'Asia/Shanghai';

function zonedParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) {
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

module.exports = { localDateStr, localDateTimeStr, SITE_TZ };
