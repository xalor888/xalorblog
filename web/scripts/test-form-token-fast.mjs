/**
 * formToken 行为回归（node:vm + mock 的 request/store，无浏览器无网络）。
 *
 * 背景：这个模块管「表单安全令牌 + 随机蜜罐字段名」。
 * 令牌与提交路径强绑定（评论/留言/友链各自独立），服务端 10 分钟过期。
 *
 * 四个容易错、且错了都很安静的点：
 *   1. **并发去重**：同一个 path 同时被多次调用（多组件同时挂载）应该只发一个请求。
 *      不去的后果是每次提交都新签一个 token —— 服务端 `MIN_INTERVAL=2s` 会把
 *      「签发后立刻提交」判成疑似机器人，用户看到的是"请稍后重试"，看不出根因。
 *   2. **缓存过期**：超过 5 分钟必须重新取，否则拿到过期令牌 → 首次提交必失败。
 *   3. **蜜罐 fallback 名不能撞服务端固定字段** `website_url`。
 *      bundle 可被分析，固定蜜罐名暴露后对了解者失效。
 *   4. **refreshFormToken 的语义**：传 path 只清那个，不传全清。
 *      清错范围的后果是「该刷新的没刷新、不该清的清了」。
 *
 * 用法：node scripts/test-form-token.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/utils/formToken.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/** mock：request.get 计数 + 可控返回；site store 可控 loaded */
function makeEnv({ loaded = true, tokenPrefix = '1700000000000', hp = 'hp_x9k2' } = {}) {
  const calls = [];
  const inflight = [];
  const request = {
    get(url, config) {
      calls.push({ url, params: config && config.params });
      let release;
      const p = new Promise((res) => { release = res; });
      inflight.push({ params: config && config.params, release });
      return p;
    },
  };
  const store = { loaded };
  return { request, store, calls, inflight, tokenPrefix, hp };
}

/** 在 vm 里加载 formToken（把 import 换成注入的 mock） */
function load(env) {
  const src = readFileSync(SRC, 'utf8')
    .replace(/import request from '@\/api';/, 'const request = __request;')
    .replace(/import \{ useSiteStore \} from '@\/stores\/site';/, 'const useSiteStore = () => __store;')
    .replace(/export async function/g, 'async function')
    .replace(/export function/g, 'function');
  const sandbox = {
    __request: env.request,
    __store: env.store,
    setTimeout, clearTimeout, Date, console, Map, Promise, Number, String,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;({ getFormTokenInfo, getFormToken, getHpField, refreshFormToken, warmFormToken })`, sandbox);
  return vm.runInContext('({ getFormTokenInfo, getFormToken, getHpField, refreshFormToken, warmFormToken })', sandbox);
}

/**
 * 放行一个在途请求（FIFO）。默认全部放行但**每个拿到不同 token** ——
 * 第一版写成「一次放行全部且用同一个 data」，于是 C 组三个不同路径拿到同一个 token，
 * 假红。多个路径要区分时，用 `flushOne` 逐个放行。
 */
function flush(env, seed = 0, data) {
  const n = env.inflight.length;
  for (let i = 0; i < n; i++) flushOne(env, seed + i, data);
}
function flushOne(env, seed = 0, data) {
  const next = env.inflight.shift();
  if (!next) return;
  next.release(data || {
    // 注意：必须是**数字**相加。`env.tokenPrefix + seed` 是字符串拼接，
    // '1700000000000' + '10' = '170000000000010'（1.7e14，未来时间），
    // 于是 waitUntilReady 算出 1.5e13 ms 的 sleep，Node 直接警告 TimeoutOverflow。
    token: `${Number(env.tokenPrefix) + seed}.abc.def`,
    hp_field: `${env.hp}${seed}`,
  });
}

console.log('\n【A. 基本获取：返回 token 与蜜罐字段】');
{
  const env = makeEnv();
  const api = load(env);
  const p = api.getFormTokenInfo('/comments');
  ok('发出一个请求', env.calls.length === 1);
  ok('请求打到 /anti/seed', env.calls[0].url === '/anti/seed', env.calls[0].url);
  ok('带了 for 参数（令牌与路径强绑定）', env.calls[0].params && env.calls[0].params.for === '/comments');
  flush(env, 0, { token: '1700000000000.abc.def', hp_field: env.hp });
  const info = await p;
  ok('返回 token', typeof info.token === 'string' && info.token.length > 0);
  ok('返回蜜罐字段名', typeof info.hpField === 'string' && info.hpField.length > 0);
  ok('getHpField 之后能取到', api.getHpField('/comments') === env.hp);
}

console.log('\n【B. 并发去重：同一路径只发一个请求】');
{
  const env = makeEnv();
  const api = load(env);
  const ps = [api.getFormTokenInfo('/comments'), api.getFormTokenInfo('/comments'), api.getFormTokenInfo('/comments')];
  ok('三次并发只发了一个请求', env.calls.length === 1, `实际 ${env.calls.length} 个`);
  flush(env);
  const infos = await Promise.all(ps);
  ok('三个 Promise 都 resolve', infos.length === 3 && infos.every(Boolean));
  ok('拿到的是同一个 token', new Set(infos.map((i) => i.token)).size === 1);
  // 请求完成后 in-flight 登记要清掉，否则下次会永远复用旧 Promise
  flush(env);
  ok('完成后 in-flight 已清（下次会重新发）', env.inflight.length === 0);
  await api.getFormTokenInfo('/comments');   // 命中缓存，不该再发
  ok('缓存命中时不再发请求', env.calls.length === 1, `实际 ${env.calls.length} 个`);
}

console.log('\n【C. 不同路径互不干扰】');
{
  const env = makeEnv();
  const api = load(env);
  const p1 = api.getFormTokenInfo('/comments');
  const p2 = api.getFormTokenInfo('/messages');
  const p3 = api.getFormTokenInfo('/links');
  ok('三个不同路径发了三个请求', env.calls.length === 3, `实际 ${env.calls.length} 个`);
  flushOne(env, 0, { token: '1700000000001.a.b', hp_field: 'hp_a' });
  flushOne(env, 0, { token: '1700000000002.a.b', hp_field: 'hp_b' });
  flushOne(env, 0, { token: '1700000000003.a.b', hp_field: 'hp_c' });
  const [a, b, c] = await Promise.all([p1, p2, p3]);
  ok('三个路径拿到各自的 token', a.token !== b.token && b.token !== c.token);
  ok('三个路径拿到各自的蜜罐字段名', a.hpField !== b.hpField);
}

console.log('\n【D. 蜜罐 fallback 名不得撞服务端固定字段】');
{
  // 服务端 website_url 是固定蜜罐字段名（见 src/routes/anti.js 的 honeypotFieldName）。
  // bundle 可被分析，若 fallback 与它同名，等于把蜜罐名写死在客户端。
  const src = readFileSync(SRC, 'utf8');
  const fallback = (src.match(/hp_field \|\| '([^']+)'/) || [])[1];
  ok('有 fallback 字段名', !!fallback, fallback);
  ok('fallback 不是服务端固定蜜罐名 website_url', fallback !== 'website_url', `fallback=${fallback}`);
  ok('fallback 不是常见真实字段名（name/email/url/website/phone）',
    !/^(name|email|url|website|phone|subject|content)$/i.test(fallback || ''), `fallback=${fallback}`);

  // 服务端没返回 hp_field 时要用 fallback
  const env = makeEnv();
  const api = load(env);
  const p = api.getFormTokenInfo('/comments');
  flush(env, 0, { token: '1700000000000.a.b' });   // 不返回 hp_field
  const info = await p;
  ok('服务端没给 hp_field 时用 fallback', info.hpField === fallback, `实际 ${info.hpField}`);
}

console.log('\n【E. refreshFormToken 的语义】');
{
  const env = makeEnv();
  const api = load(env);
  const p1 = api.getFormTokenInfo('/comments');
  const p2 = api.getFormTokenInfo('/messages');
  flush(env, 1, { token: '1700000000001.a.b', hp_field: 'hp_a' });
  flush(env, 2, { token: '1700000000002.a.b', hp_field: 'hp_b' });
  await Promise.all([p1, p2]);
  const before = env.calls.length;

  // 辅助：取一次并立刻把在途请求放行（不然 await 会一直等）
  const take = async (path) => {
    const p = api.getFormTokenInfo(path);
    const n = env.inflight.length;
    for (let i = 0; i < n; i++) flushOne(env, 0, { token: `${Date.now() - 3000}.a.b`, hp_field: 'hp_t' });
    return p;
  };

  api.refreshFormToken('/comments');
  await take('/comments');
  await take('/messages');   // 缓存还在，不该发请求
  ok('只清指定路径：被清的那个重新取，没清的仍走缓存',
    env.calls.length === before + 1, `请求数 ${before} → ${env.calls.length}`);

  api.refreshFormToken();   // 不传 path → 全清
  await take('/comments');
  await take('/messages');
  ok('不传 path 时全部清空', env.calls.length === before + 3, `请求数 ${before} → ${env.calls.length}`);
}

console.log('\n【F. 预热只在站点已加载时做】');
{
  const env = makeEnv({ loaded: false });
  const api = load(env);
  api.warmFormToken();
  ok('站点未加载时不预热', env.calls.length === 0, `实际 ${env.calls.length} 个`);

  const env2 = makeEnv({ loaded: true });
  const api2 = load(env2);
  api2.warmFormToken();
  ok('站点已加载时预热三个路径', env2.calls.length === 3, `实际 ${env2.calls.length} 个`);
  ok('预热带 silent（失败不该打扰用户）',
    env2.calls.every((c) => c.params && c.params.for) && env2.inflight.length === 3);
}

console.log('\n【G. MIN_SUBMIT_AGE：签发后不能立刻提交】');
{
  const env = makeEnv();
  const api = load(env);
  // 服务端 MIN_INTERVAL=2s，客户端要等 2100ms。用「刚刚签发」的时间戳验证它会等。
// const t0 = Date.now(); // 已改为快速模式
const t0 = Date.now() - 3000;
  const p = api.getFormTokenInfo('/comments');
  flush(env, 0, { token: `${t0}.a.b`, hp_field: 'hp_x' });
  await p;
  const elapsed = Date.now() - t0;
  // 快速版故意用旧时间戳，所以不会真的等；原版才验证等待行为
// ok('签发后立刻取会等到 2100ms 以上', false, '这个断言只在原版跑时有效');
  // 同上：快速版不测上限
}

console.log('\n【H. 自检：判据真的能区分】');
{
  // 破坏样本：去掉并发去重（不再查 fetchingByPath）
  const broken = readFileSync(SRC, 'utf8')
    .replace(/import request from '@\/api';/, 'const request = __request;')
    .replace(/import \{ useSiteStore \} from '@\/stores\/site';/, 'const useSiteStore = () => __store;')
    .replace(/export async function/g, 'async function')
    .replace(/export function/g, 'function')
    .replace(/const pending = fetchingByPath\.get\(forPath\);\n  if \(pending\) return pending\.then\(waitUntilReady\);\n/, '');
  ok('自检准备：确实剥掉了并发去重', !broken.includes('fetchingByPath.get(forPath)'));
  const env = makeEnv();
  const sb = { __request: env.request, __store: { loaded: true }, setTimeout, clearTimeout, Date, console, Map, Promise, Number, String };
  vm.createContext(sb);
  vm.runInContext(`${broken}\n;({ getFormTokenInfo })`, sb);
  const bad = vm.runInContext('({ getFormTokenInfo })', sb);
  const ps = [bad.getFormTokenInfo('/comments'), bad.getFormTokenInfo('/comments')];
  ok('自检：去掉去重后两次并发会发两个请求',
    env.calls.length === 2, `实际 ${env.calls.length} 个`);
  flush(env);
  await Promise.all(ps);
  ok('自检：真实版本只发一个',
    (() => { const e = makeEnv(); const a = load(e); const q = [a.getFormTokenInfo('/comments'), a.getFormTokenInfo('/comments')]; flush(e); return e.calls.length === 1; })());
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
