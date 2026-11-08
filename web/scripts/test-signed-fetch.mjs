/**
 * signedFetch 行为回归（node:vm + mock，无浏览器无网络）。
 *
 * 背景：这个模块是「绕过 axios JSON 拦截器的签名 GET」，给后台导出 CSV/JSON
 * 和 AskAi 的 SSE 流式回答用。它返回原生 `Response`，所以调用方依赖
 * `res.json()`（AiPanel）和 `res.body`（AskAi 读流）。
 *
 * 文件头记着一次真实事故：这里曾经**抄了第二份逐行相同的 HMAC 实现**，
 * 随后与 axios 侧分叉。所以现在签名只走 `buildRequestSignature`（共用一份）。
 *
 * 四个容易错、且错了都很安静的点：
 *   1. **超时定时器的撤销时机**：超时只该管「多久没有响应头」。
 *      SSE 流能活 60s 以上，若不撤销定时器，整段回答会在 15s 处被掐断 ——
 *      用户看到的是"回答突然停了"，而控制台什么都没有。
 *   2. **未登录发假认证头**：`Bearer `（空 token）会被后端当成无效凭证。
 *   3. **调用方的 signal 失效**：AiPanel 的「停止生成」按钮点了没反应。
 *   4. **body 为 null 时发 Content-Type**：声明了 JSON 却没有 body。
 *
 * 用法：node scripts/test-signed-fetch.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/utils/signedFetch.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/** 可控的定时器：不真的等 15s */
function makeTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    pending,
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    /** 手动触发某个定时器 */
    fire(id) {
      const t = pending.get(id);
      if (t) { pending.delete(id); t.fn(); }
    },
    fireAll() { for (const id of [...pending.keys()]) this.fire(id); },
  };
}

/**
 * 让微任务跑完一拍。
 *
 * `signedFetch` 里 `await buildRequestSignature(...)` 在 `createRequestSignal` 之前，
 * 所以定时器是在微任务里才建的 —— 调用后**同步**检查 `timers.pending.size` 会是 0。
 */
const tick = () => new Promise((r) => setImmediate(r));

/** 可控的 AbortController：记录 abort 调用 */
function makeAbortEnv() {
  const aborted = [];
  class FakeAbortController {
    constructor() {
      this.signal = {
        aborted: false, reason: undefined, _l: [],
        // ⚠ 必须有 addEventListener —— 真实 AbortSignal 有，而 mock fetch 要靠它
        //   在 abort 时 reject。漏了它，fetch 里调 addEventListener 直接抛 TypeError，
        //   被 signedFetch 的 try 捕获后走进 finally，定时器已撤销 →
        //   于是「请求期间有定时器」永远为 0，看起来像产品代码没建定时器。
        addEventListener(_e, cb) { this._l.push(cb); },
      };
    }
    abort(reason) {
      this.signal.aborted = true;
      this.signal.reason = reason;
      aborted.push(reason);
      for (const l of this.signal._l) l();
    }
  }
  return { FakeAbortController, aborted };
}

function makeEnv({
  ticket = 'TICKET',
  fp = 'FP',
  authToken = null,
  sig = { ts: '1700000000000', sig: 'SIGVALUE', nonce: 'NONCE123' },
  timers, abortEnv,
} = {}) {
  const t = timers || makeTimers();
  const a = abortEnv || makeAbortEnv();
  const fetchCalls = [];
  let fetchImpl = (url, opts) => {
    fetchCalls.push({ url, opts });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const sandbox = {
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
    AbortController: a.FakeAbortController,
    DOMException: class DOMException extends Error {
      constructor(m, n) { super(m); this.name = n || 'Error'; }
    },
    __ticket: ticket,
    __fp: fp,
    __authToken: authToken,
    __sig: sig,
    // 代码用的是全局 fetch。这里给一个转发到闭包变量 fetchImpl 的壳 ——
    // 这样测试可以事后用 env.setFetch(fn) 换掉行为（E/F 组就这么做）。
    //
    // ⚠ 两个失败尝试，记下来省得再踩：
    //   a) `fetch: (u, o) => __fetch(u, o)` —— 箭头函数在**测试文件**作用域求值，
    //      `__fetch` 在那里不存在 → ReferenceError。
    //   b) `fetch: function (u, o) { return globalThis.__fetch(u, o) }` 且预先
    //      `sb.globalThis = sb` —— vm.createContext 之后全局对象是**新的**，
    //      预置的属性不映射过去 → "globalThis.__fetch is not a function"。
    fetch: (url, opts) => fetchImpl(url, opts),
    Promise, JSON, String, Object, Error, console,
  };
  return {
    sandbox, fetchCalls, timers: t, abortEnv: a,
    /** 换掉 fetch 的实现（返回永不 resolve 的 Promise 就能模拟卡住） */
    setFetch(fn) { fetchImpl = fn; },
  };
}

/** 把 ES import 换成注入的 mock，再 vm 加载 */
function load(env) {
  const src = readFileSync(SRC, 'utf8')
    .replace(/import \{ getTicket \} from '\.\/pass';/, "const getTicket = () => __ticket;")
    .replace(/import \{ getFingerprint \} from '\.\/fingerprint';/, "const getFingerprint = async () => __fp;")
    .replace(/import \{ getAuthToken \} from '\.\/authSession';/, "const getAuthToken = () => __authToken;")
    .replace(/import \{ buildRequestSignature \} from '\.\/requestSignature';/, "const buildRequestSignature = async (o) => __sig;")
    .replace(/export async function/g, 'async function');
  const sb = env.sandbox;
  vm.createContext(sb);
  vm.runInContext(`${src}\n;({ signedFetch, createRequestSignal })`, sb);
  return vm.runInContext('({ signedFetch, createRequestSignal })', sb);
}

console.log('\n【A. 基本请求：签名头齐全】');
{
  const env = makeEnv();
  const api = load(env);
  await api.signedFetch('/api/notes/export');
  ok('fetch 被调用一次', env.fetchCalls.length === 1);
  const h = env.fetchCalls[0].opts.headers;
  ok('带 X-Pass（票据）', h['X-Pass'] === 'TICKET', JSON.stringify(h['X-Pass']));
  ok('带 X-Fp（设备指纹）', h['X-Fp'] === 'FP');
  ok('带 X-Timestamp', h['X-Timestamp'] === '1700000000000');
  ok('带 X-Nonce', h['X-Nonce'] === 'NONCE123');
  ok('带 X-Sig（来自 buildRequestSignature，不自己算）', h['X-Sig'] === 'SIGVALUE');
  ok('GET 不带 Content-Type', !('Content-Type' in h), JSON.stringify(Object.keys(h)));
  ok('默认 method 是 GET', env.fetchCalls[0].opts.method === 'GET');
  ok('credentials 是 same-origin', env.fetchCalls[0].opts.credentials === 'same-origin');
  ok('带了 signal', !!env.fetchCalls[0].opts.signal);
}

console.log('\n【B. 未登录不发假认证头】');
{
  const env = makeEnv({ authToken: null });
  const api = load(env);
  await api.signedFetch('/api/notes/export');
  ok('authToken 为空时没有 Authorization 头', !('Authorization' in env.fetchCalls[0].opts.headers));

  const env2 = makeEnv({ authToken: 'JWT123' });
  const api2 = load(env2);
  await api2.signedFetch('/api/notes/export');
  ok('authToken 有值时发 Bearer', env2.fetchCalls[0].opts.headers.Authorization === 'Bearer JWT123');
}

console.log('\n【C. body 的三种形态】');
{
  for (const [name, body, wantCT, wantBody] of [
    ['null', null, false, undefined],
    ['undefined', undefined, false, undefined],
    ['对象', { a: 1 }, true, '{"a":1}'],
    ['字符串', 'raw-text', true, 'raw-text'],
  ]) {
    const env = makeEnv();
    const api = load(env);
    await api.signedFetch('/api/x', { method: 'POST', body });
    const { headers, body: got } = env.fetchCalls[0].opts;
    ok(`${name}：Content-Type ${wantCT ? '有' : '没有'}`, ('Content-Type' in headers) === wantCT,
      JSON.stringify(Object.keys(headers)));
    ok(`${name}：body ${wantBody === undefined ? 'undefined' : '序列化'}`, got === wantBody, JSON.stringify(got));
  }
}

console.log('\n【D. 超时定时器必须在响应头到手后撤销】');
{
  const env = makeEnv();
  const api = load(env);
  ok('调用前没有定时器', env.timers.pending.size === 0);
  // fetch 延后一拍才 resolve —— 立即 resolve 的话 `finally { disarm() }` 会在
  // 我们检查之前就跑掉，于是「请求期间有定时器」永远为 0（假红）。
  let releaseFetch;
  env.setFetch(() => new Promise((r) => { releaseFetch = r; }));
  const p = api.signedFetch('/api/notes/export');
  await tick();
  ok('请求期间有一个 15s 定时器', env.timers.pending.size === 1, `实际 ${env.timers.pending.size} 个`);
  const [[id, t]] = [...env.timers.pending.entries()];
  ok('超时时长是 15000ms', t.ms === 15000, `${t.ms}ms`);
  releaseFetch({ ok: true, status: 200, json: async () => ({}) });
  await p;
  ok('**响应头到手后定时器被撤销**（否则 SSE 流会在 15s 处被掐断）',
    env.timers.pending.size === 0, `还剩 ${env.timers.pending.size} 个`);
  ok('撤销后 abort 没被调用（不能误伤正常流）', env.abortEnv.aborted.length === 0);
}

console.log('\n【E. 超时真的会 abort，且带 TimeoutError】');
{
  const env = makeEnv();
  const api = load(env);
  // 让 fetch 永不 resolve
  // 真实的 fetch 在 signal abort 时会 reject。mock 必须也这样，
  // 否则 `ctrl.abort()` 之后 Promise 永远挂着，测试自己先超时。
  env.setFetch((url, opts) => new Promise((_res, rej) => {
    if (opts.signal.aborted) return rej(opts.signal.reason || new Error('aborted'));
    opts.signal.addEventListener('abort', () => rej(opts.signal.reason || new Error('aborted')));
  }));
  const p = api.signedFetch('/api/hangs').catch((e) => 'CAUGHT:' + (e && e.name));
  await tick();
  const [[id]] = [...env.timers.pending.entries()];
  env.timers.fire(id);
  const r = await p;
  ok('超时触发 abort', env.abortEnv.aborted.length === 1);
  ok('abort 原因带 TimeoutError（调用方可区分超时与用户取消）',
    env.abortEnv.aborted[0] && env.abortEnv.aborted[0].name === 'TimeoutError',
    JSON.stringify(String(env.abortEnv.aborted[0])));
  ok('fetch 的 Promise 被 reject（不然调用方以为还在跑）', r.startsWith('CAUGHT:'), r);
}

console.log('\n【F. 调用方的 signal 也能中止】');
{
  const env = makeEnv();
  const api = load(env);
  let outerAborted = false;
  const outer = {
    aborted: false,
    reason: undefined,
    addEventListener(_e, cb) { this._cb = cb; },
  };
  env.setFetch((url, opts) => new Promise((_res, rej) => {
    if (opts.signal.aborted) return rej(opts.signal.reason || new Error('aborted'));
    opts.signal.addEventListener('abort', () => rej(opts.signal.reason || new Error('aborted')));
  }));
  api.signedFetch('/api/stream', { signal: outer }).catch(() => {});
  await tick();
  ok('外部 signal 已注册监听', typeof outer._cb === 'function');
  outer._cb();   // 模拟用户点「停止生成」
  ok('外部 abort 传递到内部 controller', env.abortEnv.aborted.length === 1);
  ok('外部已 aborted 时不再重复监听',
    (() => {
      const e2 = makeEnv();
      const a2 = load(e2);
      const alreadyAborted = { aborted: true, reason: 'x', addEventListener() { throw new Error('不该再注册'); } };
      a2.signedFetch('/api/x', { signal: alreadyAborted }).catch(() => {});
      return true;
    })());
}

console.log('\n【G. 自检：判据真的能区分】');
{
  // 破坏样本：把 disarm() 从 finally 里挪走（模拟"忘了撤销定时器"）
  const broken = readFileSync(SRC, 'utf8')
    .replace(/import \{ getTicket \} from '\.\/pass';/, "const getTicket = () => __ticket;")
    .replace(/import \{ getFingerprint \} from '\.\/fingerprint';/, "const getFingerprint = async () => __fp;")
    .replace(/import \{ getAuthToken \} from '\.\/authSession';/, "const getAuthToken = () => __authToken;")
    .replace(/import \{ buildRequestSignature \} from '\.\/requestSignature';/, "const buildRequestSignature = async (o) => __sig;")
    .replace(/export async function/g, 'async function')
    // 只删 disarm() 调用，保留 finally 块本身 ——
    // 第一版把整段 `} finally { ... }` 删掉，得到的是语法错误的代码，
    // vm.runInContext 直接抛 SyntaxError，什么也没测到。
    .replace(/\} finally \{\n    requestSignal\.disarm\(\);\n  \}/, '} finally { /* 忘了撤销 */ }');
  ok('自检准备：确实把 disarm 从 finally 里删了', !broken.includes('requestSignal.disarm();'));
  const env = makeEnv();
  const sb = env.sandbox;
  vm.createContext(sb);
  vm.runInContext(`${broken}\n;({ signedFetch })`, sb);
  const bad = vm.runInContext('({ signedFetch })', sb);
  await bad.signedFetch('/api/x');
  await tick();
  ok('自检：不撤销定时器的版本会被判为「还剩定时器」',
    env.timers.pending.size === 1, `实际 ${env.timers.pending.size} 个`);
  ok('自检：真实版本撤销了',
    (() => { const e = makeEnv(); const a = load(e); return a.signedFetch('/api/x').then(tick).then(() => e.timers.pending.size === 0); })());
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
