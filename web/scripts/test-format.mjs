/**
 * format.js 行为回归（node:vm + 可控时钟，无浏览器）。
 *
 * 背景：这个模块管日期/数字/阅读时长的展示。它有一个**时区**维度：
 * 服务端返回的是无时区后缀的本地时间字符串（`YYYY-MM-DD HH:mm:ss`），
 * 必须按「服务器本地时区」解释，否则跨时区访客的相对时间整体偏移。
 * 这个 bug 真实发生过（旧实现用 `-getTimezoneOffset()`，与 `SITE_TZ` 配置可能不一致）。
 *
 * 本轮修的真问题：`formatDate` 对 **Date 对象**产出 `"Thu Sep 24"` 而不是 `"2026-09-24"`。
 * 因为旧实现只有 `String(time).slice(0, 10)`，而 `String(new Date())` 是
 * "Thu Sep 24 2026 04:05:21 GMT+0800 …"。`timeAgo` 的签名明确支持 `string|Date`
 * 且超过 30 天会走到这里 —— 目前调用方都传字符串所以没触发，但承诺与实现不一致。
 *
 * 用法：node scripts/test-format.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/utils/format.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/** 造一个固定时刻的 Date（本地时区），并把 Date.now 也钉住 */
const NOW = new Date('2026-11-03T12:00:00+08:00');   // 仅作文档说明，测试用真实 Date.now
function makeEnv({ serverTzOffset = null } = {}) {
  // ⚠ 不要替换 Date 类。第一版造了个 FakeDate 塞进 sandbox，结果
  // 测试里 `new Date(...)` 创建的是**测试文件**的 Date，而 format.js 里
  // `time instanceof Date` 用的是 sandbox 的 FakeDate → 恒为 false，
  // 于是所有 Date 路径的断言全红。真实 Date + 相对时间就够，不需要假时钟。
  const sandbox = {
    Date,
    __readingMinutes: (content, opts) => {
      // 简化版 wordStats：中文按 300 字/分钟
      const n = String(content || '').length;
      const m = Math.ceil(n / 300);
      return opts && opts.minOne ? Math.max(1, m) : m;
    },
    Number, String, Math, Object, console,
  };
  return sandbox;
}

function load(env) {
  const src = readFileSync(SRC, 'utf8')
    .replace(/import \{ readingMinutes \} from '\.\/wordStats';/, "const readingMinutes = __readingMinutes;")
    .replace(/export function/g, 'function');
  vm.createContext(env);
  vm.runInContext(`${src}\n;({ setServerTzOffset, timeAgo, formatDate, formatDateTime, readingTime, formatNumber })`, env);
  return vm.runInContext('({ setServerTzOffset, timeAgo, formatDate, formatDateTime, readingTime, formatNumber })', env);
}

console.log('\n【A. formatDate：Date 与字符串必须都给 YYYY-MM-DD】');
{
  const api = load(makeEnv());
  const d = new Date(Date.now() - 40 * 86400000);   // 40 天前
  const p = (n) => String(n).padStart(2, '0');
  const want = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  ok('Date 对象 → YYYY-MM-DD（本轮修的）', api.formatDate(d) === want, `${api.formatDate(d)} ≠ ${want}`);
  ok('Date 对象不产出英文月份缩写', !/[A-Z][a-z]{2} [A-Z][a-z]{2}/.test(api.formatDate(d)));
  ok('字符串原样取前 10 位', api.formatDate('2026-09-24 12:00:00') === '2026-09-24');
  ok('ISO 字符串也行', api.formatDate('2026-09-24T12:00:00Z') === '2026-09-24');
  ok('空串返回空串', api.formatDate('') === '');
  ok('null 返回空串', api.formatDate(null) === '');
  ok('0 返回空串（不是 "0"）', api.formatDate(0) === '', JSON.stringify(api.formatDate(0)));
  // 必须剥注释再查 —— 修复说明里就提到了 `replace(/-/g, '-')` 这个字符串，
  // 不剥的话永远为 false。
  const raw = readFileSync(SRC, 'utf8');
  const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok('没有把 - 替换成 - 的死代码', !noComments.includes("replace(/-/g, '-')"));
}

console.log('\n【B. timeAgo 的相对区间】');
{
  const api = load(makeEnv());
  const ago = (ms) => api.timeAgo(new Date(Date.now() - ms));
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  ok('30 秒前 → 刚刚', ago(30 * 1000) === '刚刚', ago(30 * 1000));
  ok('5 分钟前 → "5 分钟前"', ago(5 * MIN) === '5 分钟前', ago(5 * MIN));
  ok('59 分钟前仍是分钟', ago(59 * MIN) === '59 分钟前', ago(59 * MIN));
  ok('3 小时前 → "3 小时前"', ago(3 * HOUR) === '3 小时前', ago(3 * HOUR));
  ok('23 小时前仍是小时', ago(23 * HOUR) === '23 小时前', ago(23 * HOUR));
  ok('5 天前 → "5 天前"', ago(5 * DAY) === '5 天前', ago(5 * DAY));
  ok('29 天前仍是天', ago(29 * DAY) === '29 天前', ago(29 * DAY));
  ok('40 天前 → 日期（且是 YYYY-MM-DD）', /^\d{4}-\d{2}-\d{2}$/.test(ago(40 * DAY)), ago(40 * DAY));
  ok('空值返回空串', api.timeAgo('') === '' && api.timeAgo(null) === '');
}

console.log('\n【C. timeAgo 的时区维度（服务端本地时间字符串）】');
{
  // 服务器在东八区（offset = -480），返回 "2026-11-03 11:00:00"（服务器本地 11 点）
  // 对服务器而言那是 1 小时前。
  const api = load(makeEnv());
  api.setServerTzOffset(-480);
  // 服务器在东八区：把「1 小时前」换算成服务器本地时间字符串
  const srvLocal = (msAgo) => {
    const d = new Date(Date.now() - msAgo);
    // 服务端 offset=-480 表示 UTC = 本地 + (-480min)，即本地 = UTC + 8h
    const utcMs = d.getTime();
    const localMs = utcMs - (-480) * 60 * 1000;
    const ld = new Date(localMs);
    const q = (n) => String(n).padStart(2, '0');
    return `${ld.getUTCFullYear()}-${q(ld.getUTCMonth() + 1)}-${q(ld.getUTCDate())} ${q(ld.getUTCHours())}:${q(ld.getUTCMinutes())}:${q(ld.getUTCSeconds())}`;
  };
  ok('设了服务端偏移后按服务器本地解释',
    api.timeAgo(srvLocal(3600000)) === '1 小时前', api.timeAgo(srvLocal(3600000)));
  ok('刚过去的服务器时间 → 刚刚', api.timeAgo(srvLocal(30000)) === '刚刚',
    api.timeAgo(srvLocal(30000)));

  // 不设偏移时回退浏览器本机偏移（同服务器时区的访客结果正确）
  const api2 = load(makeEnv());
  const localOffset = new Date().getTimezoneOffset();
  const oneHourAgoLocal = new Date(Date.now() - 3600000);
  const p = (n) => String(n).padStart(2, '0');
  const s = `${oneHourAgoLocal.getFullYear()}-${p(oneHourAgoLocal.getMonth() + 1)}-${p(oneHourAgoLocal.getDate())} ${p(oneHourAgoLocal.getHours())}:${p(oneHourAgoLocal.getMinutes())}:00`;
  ok(`未设偏移时回退本机（offset=${localOffset}）`, api2.timeAgo(s) === '1 小时前', api2.timeAgo(s));

  // 非法字符串不能抛，回退成取前 10 位
  ok('非法时间字符串不抛，回退为前 10 位', api.timeAgo('not-a-date') === 'not-a-date',
    api.timeAgo('not-a-date'));
  ok('空对象不抛', api.timeAgo({}) !== undefined);
}

console.log('\n【D. setServerTzOffset 的入参校验】');
{
  const api = load(makeEnv());
  api.setServerTzOffset(-480);
  const srvOneHourAgo = (() => {
    const d = new Date(Date.now() - 3600000);
    const ld = new Date(d.getTime() + 480 * 60 * 1000);
    const q = (n) => String(n).padStart(2, '0');
    return `${ld.getUTCFullYear()}-${q(ld.getUTCMonth() + 1)}-${q(ld.getUTCDate())} ${q(ld.getUTCHours())}:${q(ld.getUTCMinutes())}:00`;
  })();
  ok('合法数值生效', api.timeAgo(srvOneHourAgo) === '1 小时前');
  api.setServerTzOffset(NaN);
  ok('NaN 被忽略（不改偏移）', api.timeAgo(srvOneHourAgo) === '1 小时前',
    api.timeAgo(srvOneHourAgo));
  api.setServerTzOffset('abc');
  ok('字符串被忽略', api.timeAgo(srvOneHourAgo) === '1 小时前');
  api.setServerTzOffset(null);
  ok('null 被忽略', api.timeAgo(srvOneHourAgo) === '1 小时前');
}

console.log('\n【E. formatDateTime / formatNumber 的边界】');
{
  const api = load(makeEnv());
  ok('formatDateTime 取到分钟', api.formatDateTime('2026-09-24 12:34:56') === '2026-09-24 12:34');
  ok('formatDateTime 把 T 换成空格', api.formatDateTime('2026-09-24T12:34:56') === '2026-09-24 12:34');
  ok('formatDateTime 空值返回空串', api.formatDateTime('') === '' && api.formatDateTime(null) === '');

  ok('formatNumber(0) → "0"（不出现 undefined）', api.formatNumber(0) === '0');
  ok('formatNumber(-5) → "0"', api.formatNumber(-5) === '0', api.formatNumber(-5));
  ok('formatNumber(NaN) → "0"', api.formatNumber(NaN) === '0');
  ok('formatNumber(null) → "0"', api.formatNumber(null) === '0');
  ok('formatNumber(999) → "999"', api.formatNumber(999) === '999');
  ok('formatNumber(1000) → "1k"（小数尾零去掉）', api.formatNumber(1000) === '1k', api.formatNumber(1000));
  ok('formatNumber(1200) → "1.2k"', api.formatNumber(1200) === '1.2k', api.formatNumber(1200));
  ok('formatNumber(9999) → "10k"（进位后去尾零）', api.formatNumber(9999) === '10k', api.formatNumber(9999));
  ok('formatNumber(10000) → "1w"', api.formatNumber(10000) === '1w', api.formatNumber(10000));
  ok('formatNumber(12345) → "1.2w"', api.formatNumber(12345) === '1.2w', api.formatNumber(12345));
  ok('formatNumber(3.6) → "4"（取整）', api.formatNumber(3.6) === '4', api.formatNumber(3.6));
}

console.log('\n【F. readingTime 至少 1 分钟】');
{
  const api = load(makeEnv());
  ok('空内容 → 1（不出现 0 分钟）', api.readingTime('') === 1, String(api.readingTime('')));
  ok('短内容 → 1', api.readingTime('一句话') === 1);
  ok('不抛', typeof api.readingTime(undefined) === 'number');
}

console.log('\n【G. 自检：判据真的能区分】');
{
  // 破坏样本：formatDate 回到只处理字符串的旧实现
  // 用**字符串替换**而不是正则 —— 正则要匹配跨多行的 if 块，
  // 第一次写得太严没匹配上，结果把函数体整个删掉，vm 报 formatDate is not defined。
  const DATE_BRANCH = `  if (time instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return \`\${time.getFullYear()}-\${p(time.getMonth() + 1)}-\${p(time.getDate())}\`;
  }
  return String(time).slice(0, 10);`;
  const broken = readFileSync(SRC, 'utf8')
    .replace(/import \{ readingMinutes \} from '\.\/wordStats';/, "const readingMinutes = __readingMinutes;")
    .replace(/export function/g, 'function')
    .replace(DATE_BRANCH, "return String(time).slice(0, 10);");
  // 只检查 formatDate 函数体 —— timeAgo 里也有一个合法的 `instanceof Date`，
  // 用全文 includes 会误判成「没剥干净」。
  const fdStart = broken.indexOf('function formatDate');
  const fdBody = fdStart >= 0 ? broken.slice(fdStart, broken.indexOf('\n}', fdStart)) : '';
  ok('自检准备：确实剥掉了 formatDate 里的 Date 分支',
    !!fdBody && !fdBody.includes('instanceof Date') && fdBody.includes('slice(0, 10)'), JSON.stringify(fdBody.slice(0, 60)));
  const env = makeEnv();
  vm.createContext(env);
  vm.runInContext(`${broken}\n;({ formatDate })`, env);
  const bad = vm.runInContext('({ formatDate })', env);
  const d = new Date(Date.now() - 40 * 86400000);
  ok('自检：旧实现对 Date 会产出英文月份', /[A-Z][a-z]{2} [A-Z][a-z]{2}/.test(bad.formatDate(d)),
    JSON.stringify(bad.formatDate(d)));
  ok('自检：真实版本不会',
    !/[A-Z][a-z]{2} [A-Z][a-z]{2}/.test(load(makeEnv()).formatDate(d)));
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
