/**
 * adminPath 行为回归（node:vm + mock，无浏览器无网络）。
 *
 * 背景：后台地址不是固定的 `/admin`，而是由服务端 `JWT_SECRET` 派生的随机段。
 * 这个模块负责取它、缓存它、清理它、生成路由 href。
 *
 * 四个容易错、且错了都很安静或很糟的点：
 *   1. **`sanitizePath` 失效**：后台路径会拼进 URL 和 hash 路由。
 *      服务端返回什么就信什么的话，一个 `../../x` 或带空格的字符串能让路由错乱 ——
 *      而这条数据来自服务端，平时看不出问题，只在被污染时才炸。
 *      判据必须与 server 的 `config.adminPath` 白名单**一致**（`[a-zA-Z0-9_-]`、≤16）。
 *   2. **并发不去重**：多个组件同时取会发多个请求。
 *   3. **失败抛异常而不是返回 `''`**：`getAdminPath` 在登录页渲染时被调用，
 *      抛出去就是白屏；返回 `''` 则 `adminHref` 给占位符，页面还能显示。
 *   4. **`refreshAdminPath` 不同时清 localStorage**：后台路径被重置后，
 *      刷新页面又从旧缓存读回来，用户看到的是旧地址 404。
 *
 * 用法：node scripts/test-admin-path.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/utils/adminPath.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

function makeStorage(enabled = true) {
  const map = new Map();
  return {
    enabled,
    getItem(k) { if (!enabled) throw new Error('SecurityError'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (!enabled) throw new Error('SecurityError'); map.set(k, String(v)); },
    removeItem(k) { if (!enabled) throw new Error('SecurityError'); map.delete(k); },
    dump() { return [...map.entries()]; },
  };
}

/** 造一个环境：apiModule 可控返回/抛错，storage 可控 enabled */
function makeEnv({ seed = {}, storageEnabled = true, respond = null } = {}) {
  const storage = makeStorage(storageEnabled);
  for (const [k, v] of Object.entries(seed)) storage.setItem(k, v);
  const calls = [];
  const inflight = [];
  const apiModule = { default: { get: (url) => {
    calls.push(url);
    let release;
    const p = new Promise((res, rej) => { release = { res, rej }; });
    inflight.push(release);
    return p;
  } } };
  return { storage, apiModule, calls, inflight, respond };
}

function load(env) {
  const src = readFileSync(SRC, 'utf8')
    .replace(/import\.meta\.env\.VITE_API_PREFIX \|\| '\/api'/, "__env")
    .replace(/await getRequest\(\)/, "await Promise.resolve(__apiModule)")
    .replace(/if \(!requestModule\) requestModule = import\('@\/api'\);/, "requestModule = __apiModule;")
    .replace(/let requestModule = null;/, "let requestModule = null;")
    .replace(/export function/g, 'function');
  const sandbox = {
    __env: '/api',
    __apiModule: env.apiModule,
    localStorage: env.storage,
    console, Promise, String, Number, Map,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;({ getAdminPath, getCachedAdminPath, adminHref, refreshAdminPath })`, sandbox);
  return vm.runInContext('({ getAdminPath, getCachedAdminPath, adminHref, refreshAdminPath })', sandbox);
}

/**
 * 让微任务跑完一拍。
 *
 * 为什么需要：`getAdminPath` 内部是 `const { default: request } = await Promise.resolve(__apiModule)`
 * —— 这个 await 让 `request.get` 的调用推迟到微任务里。所以
 * `api.getAdminPath()` 之后**同步**检查 `calls.length` 会是 0，
 * 紧接着 `flush()` 会因为「没有在途请求」直接抛。
 * 这不是产品代码的问题，是 mock 的时序问题。
 */
const tick = () => new Promise((r) => setImmediate(r));

/** 放行在途请求 */
function flush(env, value) {
  const next = env.inflight.shift();
  if (!next) throw new Error('没有在途请求可放行');
  next.res(value);
}
function flushError(env, msg = 'network') {
  const next = env.inflight.shift();
  if (!next) throw new Error('没有在途请求可放行');
  next.rej(new Error(msg));
}

console.log('\n【A. 基本获取：请求 + 缓存 + 落盘】');
{
  const env = makeEnv();
  const api = load(env);
  ok('未取过时 getCachedAdminPath 为空', api.getCachedAdminPath() === '');
  const p = api.getAdminPath();
  await tick();
  ok('发出一个请求', env.calls.length === 1, `实际 ${env.calls.length} 个`);
  ok('请求打到 /anti/admin-path', env.calls[0] === '/anti/admin-path', env.calls[0]);
  flush(env, { path: '3f9a2c7e51bd' });
  const path = await p;
  ok('返回服务端给的路径', path === '3f9a2c7e51bd');
  ok('之后 getCachedAdminPath 有值', api.getCachedAdminPath() === '3f9a2c7e51bd');
  ok('写进了 localStorage', env.storage.getItem('xalor_admin_path') === '3f9a2c7e51bd');
  ok('之后再取不发请求（走缓存）', (api.getAdminPath(), env.calls.length === 1));
}

console.log('\n【B. 从 localStorage 冷启动】');
{
  const env = makeEnv({ seed: { xalor_admin_path: 'deadbeef1234' } });
  const api = load(env);
  ok('模块加载即读到缓存', api.getCachedAdminPath() === 'deadbeef1234');
  const path = await api.getAdminPath();
  ok('直接返回缓存，不发请求', path === 'deadbeef1234' && env.calls.length === 0, `请求 ${env.calls.length} 个`);
}

console.log('\n【C. sanitizePath：只留白名单字符（与 server 一致）】');
{
  // 这些值模拟「服务端返回了脏数据」或「localStorage 被塞了脏值」。
  const dirty = [
    ['../../etc/passwd', 'etcpasswd'],
    ['abc def', 'abcdef'],
    ['a/b/c', 'abc'],
    ['ok-path_1', 'ok-path_1'],
    ['中文字段', ''],
    ['a'.repeat(20), 'a'.repeat(16)],        // 超过 16 位要截断
    ['', ''],
    // ⚠ localStorage.setItem(k, null) 实际存的是字符串 'null'（真实浏览器如此，
    //   mock 的 String(v) 与它一致）。所以 sanitize 之后是 'null' 而不是 '' ——
    //   第一次写期望时我按「null → ''」想当然了，假红两条。
    [null, 'null'],
    [undefined, 'undefined'],
    ['-_.', '-_'],   // '.' 不在 [a-zA-Z0-9_-] 白名单里
  ];
  for (const [input, want] of dirty) {
    const env = makeEnv({ seed: { xalor_admin_path: input } });
    const api = load(env);
    ok(`sanitize(${JSON.stringify(String(input)).slice(0, 22)}) → ${JSON.stringify(want)}`,
      api.getCachedAdminPath() === want, `实际 ${JSON.stringify(api.getCachedAdminPath())}`);
  }

  // 请求返回脏值时也要清理
  const env2 = makeEnv();
  const api2 = load(env2);
  const p = api2.getAdminPath();
  await tick();
  flush(env2, { path: '../../evil' });
  const got = await p;
  ok('服务端返回脏路径时也被清理', got === 'evil', `实际 ${JSON.stringify(got)}`);
  ok('清理后的值才落盘', env2.storage.getItem('xalor_admin_path') === 'evil');
}

console.log('\n【D. 并发去重】');
{
  const env = makeEnv();
  const api = load(env);
  const ps = [api.getAdminPath(), api.getAdminPath(), api.getAdminPath()];
  await tick();
  ok('三次并发只发一个请求', env.calls.length === 1, `实际 ${env.calls.length} 个`);
  flush(env, { path: 'abc123' });
  const rs = await Promise.all(ps);
  ok('三个 Promise 都 resolve 到同一个值', new Set(rs).size === 1 && rs[0] === 'abc123');
}

console.log('\n【E. 失败必须返回空串，不能抛】');
{
  const env = makeEnv();
  const api = load(env);
  const p = api.getAdminPath();
  await tick();
  flushError(env, '403');
  let v;
  try { v = await p; } catch (e) { v = 'THREW:' + e.message; }
  ok('请求失败不抛异常（否则登录页白屏）', typeof v === 'string' && !v.startsWith('THREW'), String(v));
  ok('失败返回空串', v === '');
  await tick();
  api.getAdminPath();
  await tick();
  ok('失败后 pending 已清（下次能重试）', env.calls.length === 2, `实际 ${env.calls.length} 个`);
  ok('空串不写进 localStorage', env.storage.getItem('xalor_admin_path') === null);
}

console.log('\n【F. adminHref：未加载时给占位符】');
{
  const env = makeEnv();
  const api = load(env);
  ok('未加载时根路径是 /_', api.adminHref() === '/_', api.adminHref());
  ok('未加载时子路径是 /_/<seg>', api.adminHref('login') === '/_/login', api.adminHref('login'));
  const p = api.getAdminPath();
  await tick();
  flush(env, { path: 'abc123' });
  await p;
  ok('加载后根路径是 /<path>', api.adminHref() === '/abc123', api.adminHref());
  ok('加载后子路径是 /<path>/<seg>', api.adminHref('login') === '/abc123/login', api.adminHref('login'));
}

console.log('\n【G. refreshAdminPath：缓存与 localStorage 都要清】');
{
  const env = makeEnv({ seed: { xalor_admin_path: 'old123' } });
  const api = load(env);
  const p = api.refreshAdminPath();
  await tick();
  ok('刷新后同步缓存立刻为空', api.getCachedAdminPath() === '');
  ok('localStorage 也被清掉', env.storage.getItem('xalor_admin_path') === null);
  flush(env, { path: 'new456' });
  const v = await p;
  ok('刷新发起了新请求', env.calls.length === 1, `实际 ${env.calls.length} 个`);
  ok('刷新拿到新值', v === 'new456');
  ok('新值落盘', env.storage.getItem('xalor_admin_path') === 'new456');
}

console.log('\n【H. 隐私模式（localStorage 抛 SecurityError）】');
{
  const env = makeEnv({ storageEnabled: false });
  let api;
  try { api = load(env); } catch (e) { api = null; }
  ok('模块加载不炸', api !== null);
  if (api) {
    ok('缓存为空', api.getCachedAdminPath() === '');
    const p = api.getAdminPath();
    await tick();
    flush(env, { path: 'abc123' });
    let v;
    try { v = await p; } catch (e) { v = 'THREW:' + e.message; }
    ok('取路径不抛', typeof v === 'string' && !v.startsWith('THREW'), String(v));
    ok('仍然返回路径（内存缓存可用）', v === 'abc123');
    ok('adminHref 正常', api.adminHref('login') === '/abc123/login');
  }
}

console.log('\n【I. 自检：判据真的能区分】');
{
  // 破坏样本：sanitizePath 不做白名单过滤
  const broken = readFileSync(SRC, 'utf8')
    .replace(/import\.meta\.env\.VITE_API_PREFIX \|\| '\/api'/, "__env")
    .replace(/await getRequest\(\)/, "await Promise.resolve(__apiModule)")
    .replace(/if \(!requestModule\) requestModule = import\('@\/api'\);/, "requestModule = __apiModule;")
    .replace(/export function/g, 'function')
    .replace(/return String\(p \|\| ''\)\.replace\(\/\[\^a-zA-Z0-9_-\]\/g, ''\)\.slice\(0, 16\);/, "return String(p || '').slice(0, 16);");
  ok('自检准备：确实剥掉了白名单过滤', !broken.includes('replace(/[^a-zA-Z0-9_-]/g'));
  const env = makeEnv({ seed: { xalor_admin_path: '../../etc' } });
  const sb = { __env: '/api', __apiModule: env.apiModule, localStorage: env.storage, console, Promise, String, Number, Map };
  vm.createContext(sb);
  vm.runInContext(`${broken}\n;({ getCachedAdminPath })`, sb);
  const bad = vm.runInContext('({ getCachedAdminPath })', sb);
  ok('自检：不过滤的版本会留下斜杠与点',
    bad.getCachedAdminPath() === '../../etc', `实际 ${bad.getCachedAdminPath()}`);
  ok('自检：真实版本过滤掉了',
    (() => { const e = makeEnv({ seed: { xalor_admin_path: '../../etc' } }); const a = load(e); return a.getCachedAdminPath() === 'etc'; })());
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
