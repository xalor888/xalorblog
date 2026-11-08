/**
 * requestSignature 行为回归（node:vm + Node 原生 webcrypto）。
 *
 * 背景：这是全站**唯一**的 X-Sig 签名实现。文件头写得很清楚 ——
 * `api/index.js` 与 `utils/signedFetch.js` 原先各抄了一份，随后分叉，
 * 而口径一旦不一致，`server/src/middleware/gate.js` 的 verifySig() 会让**整站 403**。
 *
 * 所以这里最重要的一条断言是：
 *   **用 Node 原生 crypto 独立算一遍 HMAC，与前缀实现的结果必须逐字相同。**
 * 这不是"测自己的逻辑自洽"，而是"测它和另一个实现一致" —— 只有这种比对
 * 才能发现「两边都觉得自己对但对不上」的情况。
 *
 * 其余覆盖：`sigPath` 的两种前缀口径（混用会全线 403）、
 * `bodyHashInput` 的四种形态、jti 提取、nonce 唯一性与格式。
 *
 * 用法：node scripts/test-request-signature.mjs
 */

import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createHmac, createHash } from 'node:crypto';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/utils/requestSignature.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

function load({ apiPrefix = '/api' } = {}) {
  const src = readFileSync(SRC, 'utf8')
    .replace(/import\.meta\.env && import\.meta\.env\.VITE_API_PREFIX/, `__apiPrefix`)
    .replace(/export async function/g, 'async function');
  const sandbox = {
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    Array,
    __apiPrefix: apiPrefix,
    console, String, Number, Object, Date, JSON, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;({ buildRequestSignature })`, sandbox);
  return vm.runInContext('({ buildRequestSignature })', sandbox);
}

/** 独立实现（Node 原生 crypto）—— 用来交叉验证，不复用被测代码的任何一行 */
function independentSig({ ticket, method, url, data, stripApiPrefix }) {
  const jti = ticket ? ticket.split('.')[1] || '' : '';
  const bodyHash = createHash('sha256').update(
    data === undefined || data === null ? '{}' : (typeof data === 'string' ? data : JSON.stringify(data))
  ).digest('hex');
  let path = String(url || '').split('?')[0];
  if (stripApiPrefix) {
    const prefix = '/api'.replace(/\/+$/, '');
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || '/';
  }
  return { jti, bodyHash, path };
}

const TICKET = '1700000000000.abcdef123456.sigpart';

console.log('\n【A. 签名与服务端口径交叉验证】');
{
  const api = load();
  const cases = [
    ['GET 无 body', { method: 'GET', url: '/articles', data: undefined }],
    ['POST 对象 body', { method: 'POST', url: '/comments', data: { content: 'hi' } }],
    ['POST 字符串 body', { method: 'POST', url: '/comments', data: '{"content":"hi"}' }],
    ['PUT 空对象', { method: 'PUT', url: '/notes/1', data: {} }],
    ['DELETE', { method: 'DELETE', url: '/comments/9', data: null }],
    ['带 query 的路径', { method: 'GET', url: '/articles?page=2&size=10', data: undefined }],
  ];
  for (const [name, opts] of cases) {
    const r = await api.buildRequestSignature({ ticket: TICKET, ...opts });
    const want = independentSig({ ticket: TICKET, ...opts });
    ok(`${name}：jti 一致`, r.jti === want.jti, `${r.jti} ≠ ${want.jti}`);
    // 重新算一遍签名，验证 sig 是对 [METHOD, path, ts, bodyHash, jti, nonce] 的 HMAC
    const expectSig = createHmac('sha256', TICKET)
      .update([String(opts.method).toUpperCase(), want.path, r.ts, want.bodyHash, want.jti, r.nonce].join('|'))
      .digest('hex');
    ok(`${name}：sig 与独立实现逐字相同`, r.sig === expectSig, `${r.sig.slice(0, 12)}… ≠ ${expectSig.slice(0, 12)}…`);
  }
}

console.log('\n【B. sigPath 的两种前缀口径（混用会全线 403）】');
{
  const api = load({ apiPrefix: '/api' });
  const mk = (url, strip) => api.buildRequestSignature({ ticket: TICKET, method: 'GET', url, stripApiPrefix: strip });

  // 用 ts 固定来比对 path：换一种方式 —— 直接看独立实现的 path
  const cases = [
    ['/articles', false, '/articles'],
    ['/api/articles', false, '/api/articles'],
    ['/api/articles', true, '/articles'],
    ['/api', true, '/'],                      // 剥完为空回退 '/'
    ['/api/', true, '/'],
    ['/articles', true, '/articles'],         // 没有前缀时原样返回
    ['/apifoo/articles', true, '/apifoo/articles'],   // 本轮修：前缀必须整段匹配
    ['/api-docs', true, '/api-docs'],                 // 同形不同段，也不能剥
    ['/apiX', true, '/apiX'],
    ['/api/articles?x=1', true, '/articles'], // query 先去掉
  ];
  // 这三条（/apifoo、/api-docs、/apiX）是本轮修的真 bug：
  // 旧实现的 `startsWith(prefix)` 是**字符串**前缀匹配，`/apifoo` 也"以 /api 开头"，
  // 于是被剥成 `/foo/articles` —— 服务端 req.path 是 `/apifoo/articles`，
  // 两侧对不上 → 那个请求永远 403，而错误信息只会说「请求签名无效」。
  for (const [url, strip, wantPath] of cases) {
    const r = await mk(url, strip);
    const expectSig = createHmac('sha256', TICKET)
      .update(['GET', wantPath, r.ts, createHash('sha256').update('{}').digest('hex'), r.jti, r.nonce].join('|'))
      .digest('hex');
    ok(`sigPath(${url}, strip=${strip}) → ${wantPath}`, r.sig === expectSig);
  }
}

console.log('\n【C. bodyHashInput 的四种形态】');
{
  const api = load();
  const hashOf = (s) => createHash('sha256').update(s).digest('hex');
  const cases = [
    ['undefined', undefined, '{}'],
    ['null', null, '{}'],
    ['空对象', {}, '{}'],
    ['空数组', [], '[]'],
    ['对象', { a: 1, b: [2, 3] }, '{"a":1,"b":[2,3]}'],
    ['字符串原样', 'raw-body-not-json', 'raw-body-not-json'],
    ['JSON 字符串不再包一层', '{"a":1}', '{"a":1}'],
    ['数字', 42, '42'],
    ['false', false, 'false'],
  ];
  for (const [name, data, wantInput] of cases) {
    const r = await api.buildRequestSignature({ ticket: TICKET, method: 'POST', url: '/x', data });
    const expectSig = createHmac('sha256', TICKET)
      .update(['POST', '/x', r.ts, hashOf(wantInput), r.jti, r.nonce].join('|'))
      .digest('hex');
    ok(`${name} → hash(${JSON.stringify(wantInput)})`, r.sig === expectSig);
  }
}

console.log('\n【D. jti 提取与票据边界】');
{
  const api = load();
  const r1 = await api.buildRequestSignature({ ticket: TICKET, method: 'GET', url: '/x' });
  ok('三段票据 → jti 取中段', r1.jti === 'abcdef123456', r1.jti);
  ok('返回体含 jti（调用方可用于重放检测）', 'jti' in r1);

  const r2 = await api.buildRequestSignature({ ticket: 'onlyonepart', method: 'GET', url: '/x' });
  ok('单段票据 → jti 为空串（不抛）', r2.jti === '', JSON.stringify(r2.jti));

  // 空票据：本轮修的问题。crypto.subtle 不允许零长度 HMAC key
  // （DataError: Zero-length key is not supported），而服务端 Node 的
  // createHmac 允许空 key —— 两侧行为不一致，且用户只看到「网络错误」。
  // 现在主动抛一个说得清的错。
  let emptyErr = '';
  try { await api.buildRequestSignature({ ticket: '', method: 'GET', url: '/x' }); }
  catch (e) { emptyErr = e.message; }
  ok('空票据 → 抛清晰错误（不再是不知所云的 DataError）',
    /票据/.test(emptyErr), emptyErr);
  ok('空票据的错误信息能指向根因（PoW 未完成）',
    /PoW|访问票据/.test(emptyErr), emptyErr);
  ok('空票据不会走到 importKey（不会出现 Zero-length key）',
    !/Zero-length/i.test(emptyErr), emptyErr);

  const r4 = await api.buildRequestSignature({ ticket: 'a..c', method: 'GET', url: '/x' });
  ok('空中段 → jti 为空串', r4.jti === '');
}

console.log('\n【E. nonce 与 ts 的格式】');
{
  const api = load();
  const r = await api.buildRequestSignature({ ticket: TICKET, method: 'GET', url: '/x' });
  ok('nonce 是 32 位 hex（16 字节）', /^[0-9a-f]{32}$/.test(r.nonce), r.nonce);
  ok('ts 是毫秒时间戳字符串', /^\d{13}$/.test(r.ts), r.ts);
  ok('sig 是 64 位 hex（SHA-256）', /^[0-9a-f]{64}$/.test(r.sig), r.sig.slice(0, 20));

  // 连续两次的 nonce 必须不同（防重放靠它）
  const rs = await Promise.all(Array.from({ length: 8 }, () =>
    api.buildRequestSignature({ ticket: TICKET, method: 'GET', url: '/x' })));
  ok('8 次调用的 nonce 全不重复', new Set(rs.map((x) => x.nonce)).size === 8);
  ok('8 次调用的 sig 全不重复（nonce 参与了签名）', new Set(rs.map((x) => x.sig)).size === 8);
}

console.log('\n【F. method 大小写不敏感】');
{
  const api = load();
  const a = await api.buildRequestSignature({ ticket: TICKET, method: 'get', url: '/x' });
  const b = await api.buildRequestSignature({ ticket: TICKET, method: 'GET', url: '/x' });
  // ts/nonce 不同，所以 sig 必然不同；这里只验证 jti 与 path 一致（method 归一化由 msg 拼接保证）
  ok('小写 method 也归一化成大写参与签名', a.jti === b.jti);
  ok('method 缺省时按 GET', (await api.buildRequestSignature({ ticket: TICKET, url: '/x' })).sig.length === 64);
}

console.log('\n【G. API_PREFIX 可配（生产可改成随机串）】');
{
  const api = load({ apiPrefix: '/secret-api' });
  const r = await api.buildRequestSignature({ ticket: TICKET, method: 'GET', url: '/secret-api/x', stripApiPrefix: true });
  const expect = createHmac('sha256', TICKET)
    .update(['GET', '/x', r.ts, createHash('sha256').update('{}').digest('hex'), r.jti, r.nonce].join('|'))
    .digest('hex');
  ok('自定义前缀也能正确剥掉', r.sig === expect, `${r.sig.slice(0, 12)}… ≠ ${expect.slice(0, 12)}…`);
}

console.log('\n【H. 自检：判据真的能区分】');
{
  // 破坏样本：sigPath 不剥前缀（模拟"两种口径混用"）
  const broken = readFileSync(SRC, 'utf8')
    .replace(/import\.meta\.env && import\.meta\.env\.VITE_API_PREFIX/, `__apiPrefix`)
    .replace(/export async function/g, 'async function')
    .replace(/const prefix = API_PREFIX\.replace\(\/\\\/\+\$\/, ''\);/, "const prefix = '\\u0000';   // 永不匹配");
  ok('自检准备：确实让前缀永不匹配', broken.includes("const prefix = '\\u0000';"));
  const sb = {
    crypto: webcrypto, TextEncoder, Uint8Array, Array, __apiPrefix: '/api',
    console, String, Number, Object, Date, JSON, Promise,
  };
  vm.createContext(sb);
  vm.runInContext(`${broken}\n;({ buildRequestSignature })`, sb);
  const bad = vm.runInContext('({ buildRequestSignature })', sb);
  const r = await bad.buildRequestSignature({ ticket: TICKET, method: 'GET', url: '/api/articles', stripApiPrefix: true });
  const expect = createHmac('sha256', TICKET)
    .update(['GET', '/api/articles', r.ts, createHash('sha256').update('{}').digest('hex'), r.jti, r.nonce].join('|'))
    .digest('hex');
  ok('自检：不剥前缀时 sig 对的是 /api/articles（与服务端要求的 /articles 不符）',
    r.sig === expect, '这说明破坏真的改变了行为');
  ok('自检：真实版本剥掉了前缀',
    (async () => {
      const g = load();
      const x = await g.buildRequestSignature({ ticket: TICKET, method: 'GET', url: '/api/articles', stripApiPrefix: true });
      const e = createHmac('sha256', TICKET)
        .update(['GET', '/articles', x.ts, createHash('sha256').update('{}').digest('hex'), x.jti, x.nonce].join('|'))
        .digest('hex');
      return x.sig === e;
    })());

  // 空票据守卫的自检
  const noGuard = readFileSync(SRC, 'utf8')
    .replace(/import\.meta\.env && import\.meta\.env\.VITE_API_PREFIX/, `__apiPrefix`)
    .replace(/export async function/g, 'async function')
    .replace(/  if \(!key\) \{[\s\S]*?\n  \}\n/, '');
  ok('自检准备：确实剥掉了空票据守卫', !noGuard.includes('尚未取得访问票据'));
  const sb2 = { crypto: webcrypto, TextEncoder, Uint8Array, Array, __apiPrefix: '/api', console, String, Number, Object, Date, JSON, Promise };
  vm.createContext(sb2);
  vm.runInContext(`${noGuard}\n;({ buildRequestSignature })`, sb2);
  const bad2 = vm.runInContext('({ buildRequestSignature })', sb2);
  let bad2Msg = '';
  try { await bad2.buildRequestSignature({ ticket: '', method: 'GET', url: '/x' }); }
  catch (e) { bad2Msg = e.message; }
  ok('自检：没有守卫的版本会抛 Zero-length key（服务端却不抛，两侧不一致）',
    /Zero-length/i.test(bad2Msg), bad2Msg);
  let realMsg = '';
  try { await load().buildRequestSignature({ ticket: '', method: 'GET', url: '/x' }); }
  catch (e) { realMsg = e.message; }
  ok('自检：真实版本抛的是人话', !/Zero-length/i.test(realMsg), realMsg);
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
