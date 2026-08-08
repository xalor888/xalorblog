/** 本地时间工具：生成 MySQL DATETIME/DATE 字符串（本地时区，非 UTC） */

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 本地日期字符串 YYYY-MM-DD */
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地日期时间字符串 YYYY-MM-DD HH:mm:ss */
function localDateTimeStr(d = new Date()) {
  return `${localDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = { localDateStr, localDateTimeStr };
