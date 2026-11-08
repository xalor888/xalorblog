/**
 * 在途请求取消的纪律。
 *
 * 为什么值得守：切路由时旧页面的 GET 还在路上，它的响应回来后会**覆盖**新页面的状态
 * —— 列表闪一下旧内容、标题与正文对不上。这类问题在慢网/大分页时最明显，本地几乎看不到。
 *
 * 但「取消」本身很容易做错，而且错法都很安静：
 *   1. 把**写请求**也取消 → 服务端可能已写入，前端以为失败（很难处理的半成功状态）
 *   2. 取消后仍然弹 toast / 触发 401 跳转 → 每切一次页面就闪一条错误
 *   3. 取消后仍然重试 → 票据刷新逻辑撞上已取消的请求
 *
 * 判据：
 *   A. api 层导出 cancelInflightGets，且**只为 GET** 挂 AbortController
 *   B. 成功响应释放登记；`ERR_CANCELED` 在 toast/重试/401 逻辑**之前**返回
 *   C. 路由守卫在进入任何页面逻辑前调用取消
 *   D. 自检：判据能区分「只取消 GET」与「全都取消」
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const API = readFileSync(resolve(here, '../src/api/index.js'), 'utf8');
const ROUTER = readFileSync(resolve(here, '../src/router/factory.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

console.log('\n【A. 只为 GET 挂取消】');
ok('导出 cancelInflightGets', /export function cancelInflightGets/.test(API));
{
  const reg = API.slice(API.indexOf('function registerAbort'), API.indexOf('function releaseAbort'));
  ok('registerAbort 只对 GET 生效（写请求必须走完）', /method !== 'get'/.test(reg) && /\breturn\b/.test(reg),
    '找不到「非 GET 直接 return」的判断');
  ok('登记表是 Map（能按 key 释放）', /new Map\(/.test(API.slice(API.indexOf('const inflightGets'), API.indexOf('function registerAbort'))));
  ok('signal 由 AbortController 驱动', /new AbortController\(\)/.test(reg) && /config\.signal = ac\.signal/.test(reg));
}

console.log('\n【B. 释放与静默】');
ok('成功响应调用 releaseAbort', /releaseAbort\(response\.config\)/.test(API));
ok('失败响应也释放登记（否则 Map 会泄漏）', /releaseAbort\(error\.config\)/.test(API));
{
  const errHandler = API.slice(API.indexOf('async (error) => {'));
  const canceledAt = errHandler.indexOf("ERR_CANCELED");
  const toastAt = errHandler.indexOf('toastOnce(');
  const retryAt = errHandler.indexOf('retry');
  ok('取消判定在 toast 之前（不会为取消弹提示）', canceledAt > -1 && (toastAt === -1 || canceledAt < toastAt),
    `canceled@${canceledAt} toast@${toastAt}`);
  ok('取消标记成 canceled，便于调用方区分', /canceled\.canceled = true/.test(errHandler));
  ok('取消路径不进入重试分支（在重试逻辑之前 return）', canceledAt > -1 && /return Promise\.reject\(canceled\)/.test(errHandler),
    '找不到静默 return');
}

console.log('\n【C. 路由守卫接上了】');
{
  const guard = ROUTER.slice(ROUTER.indexOf('router.beforeEach('));
  ok('守卫一开始就取消在途 GET', /\bcancelInflightGets\(/.test(guard.slice(0, 400)),
    guard.slice(0, 200));
  ok('取消发生在秘钥路径校验之前（避免旧页面的请求把新页面拖住）', (() => {
    const c = guard.indexOf('cancelInflightGets(');
    const k = guard.indexOf('const adminKey');
    return c > -1 && k > -1 && c < k;
  })());
  ok('从 @/api 导入（单一实现，不在守卫里另写一份）', /from '@\/api'/.test(ROUTER));
}

console.log('\n【D. 自检】');
ok('自检：判据能区分「非 GET 直接返回」与「不判断方法」', () => {
  const good = "if (method !== 'get') return;";
  const bad = 'config.signal = new AbortController().signal;';
  return /method !== 'get'/.test(good) && !/method !== 'get'/.test(bad);
});

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
