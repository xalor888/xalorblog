/** 日期格式化工具 */

// 服务器本地时区偏移（分钟，UTC-本地，如中国 -480）：
// 由 /api/settings 的 server_tz_offset_min 提供；未加载时回退浏览器本机偏移
// （同服务器时区的访客结果正确；跨时区访客在设置加载前短暂显示偏差，
//   设置加载后自动校正）
let serverTzOffset = null;

/** 由站点设置注入服务器时区偏移（site store 加载设置时调用） */
export function setServerTzOffset(minutes) {
  if (typeof minutes === 'number' && Number.isFinite(minutes)) {
    serverTzOffset = minutes;
  }
}

/**
 * 解析服务器返回的本地时间字符串（YYYY-MM-DD HH:mm:ss，无时区后缀）
 * 为绝对时间戳：按「服务器本地时区」解释而非浏览器时区，
 * 否则跨时区访客的相对时间整体偏移（如 +8 服务器上 1 小时前的评论
 * 在 UTC 访客端显示为 9 小时前）
 */
function parseServerTime(time) {
  const s = String(time).replace(' ', 'T');
  const offset = serverTzOffset ?? new Date().getTimezoneOffset();
  // 先按 UTC 解析，再按服务器偏移换算真实时刻：
  // UTC = 本地 + offset（中国 offset=-480 → 12:00 本地 = 12:00-8h = 04:00 UTC）
  const asUtc = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
  if (isNaN(asUtc.getTime())) return NaN;
  return asUtc.getTime() + offset * 60 * 1000;
}

/**
 * 相对时间：x 分钟前 / x 小时前 / x 天前 / 日期
 * @param {string|Date} time
 */
export function timeAgo(time) {
  if (!time) return '';
  if (time instanceof Date) {
    const diff = Date.now() - time.getTime();
    return rel(diff, time);
  }
  const ts = parseServerTime(time);
  if (isNaN(ts)) return String(time).slice(0, 10);
  return rel(Date.now() - ts, time);
}

function rel(diff, time) {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(time);
}

/** 格式化日期 YYYY-MM-DD */
export function formatDate(time) {
  if (!time) return '';
  const s = String(time).slice(0, 10);
  return s.replace(/-/g, '-');
}

/** 格式化日期时间 YYYY-MM-DD HH:mm */
export function formatDateTime(time) {
  if (!time) return '';
  const s = String(time).slice(0, 16);
  return s.replace('T', ' ');
}

/**
 * 估算阅读时长：中文按 300 字/分钟，英文按 250 词/分钟（词数直接计入，
 * 此前误把英文词数除以 5 当作字符数 —— 1500 词只算 1 分钟，实际约 6 分钟）
 */
export function readingTime(content = '') {
  const cn = (content.match(/[\u4e00-\u9fa5]/g) || []).length;
  const en = (content.match(/[a-zA-Z0-9]+/g) || []).length;
  const minutes = Math.ceil(cn / 300 + en / 250);
  return Math.max(1, minutes);
}

/** 数字格式化：1.2k；缺省/非法值按 0，避免页脚出现 "undefined" */
export function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}
