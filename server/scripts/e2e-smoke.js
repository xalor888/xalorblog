#!/usr/bin/env node
/**
 * 端到端冒烟：走完整信任链 —— PoW 求解 → 换票据 → 签名 → 业务接口。
 *
 * **为什么需要它**：`npm test` 的 53 个离线套件全部零 DB 零端口，覆盖不到 HTTP 层。
 * 而 `npm run test:all` 会清库。所以「真实链路能不能走通」这件事一直没有自动化验证。
 * 这个脚本补上它，且**不碰数据库**：它只读，不写。
 *
 * 用法：
 *   node scripts/e2e-smoke.js                # 自己起服务（随机端口）
 *   node scripts/e2e-smoke.js --port 3000    # 连已在跑的服务
 *
 * 退出码：全部通过 0，否则 1。
 *
 * ⚠ 它验证的是**协议是否被正确实现**，不是业务逻辑。业务逻辑在 `test:all` 里。
 * ⚠ 求解 PoW 会占用几十到几百毫秒 CPU（难度自适应，最高 POW_DIFF_MAX 位）。
 */

require('dotenv').config();
const http = require('http');
const crypto = require('crypto');

const USE_PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : null;
})();

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * 与 `src/middleware/gate.js` 的 `digestHasLeadingZeros` **逐字一致**。
 * 第一版我凭理解写了个位运算版本，解出的 solution 服务端不认 ——
 * 验证另一侧的实现时，要照抄它的判据，不要重写。
 */
function digestHasLeadingZeros(hexDigest, bits) {
  const bytes = Buffer.from(hexDigest, 'hex');
  if (bytes.length < 32) return false;
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (bytes[i] !== 0) return false;
  const remain = bits % 8;
  if (remain > 0 && (bytes[full] >> (8 - remain)) !== 0) return false;
  return true;
}

const FP = 'a'.repeat(64);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// CORS 白名单里的来源（不是本机随机端口 —— 那会被 cors 中间件拒）
const ORIGIN = 'http://localhost:5173';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

function makeClient(port) {
  return (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'X-Fp': FP,
        'User-Agent': UA,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (e) { /* HTML 响应（分享页） */ }
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 求解 PoW：找 s 使 sha256(prefix + ':' + s) 前 diff 位为 0 */
function solvePow(prefix, diff, maxAttempts = 8_000_000) {
  const started = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    const s = i.toString(36);
    if (digestHasLeadingZeros(sha256hex(`${prefix}:${s}`), diff)) {
      return { solution: s, ms: Date.now() - started };
    }
  }
  return { solution: null, ms: Date.now() - started };
}

async function run(get) {
  console.log('\n=== 1. PoW 挑战 ===');
  const pz = await get('GET', '/api/anti/puzzle');
  ok('GET /api/anti/puzzle 返回 200', pz.status === 200, `status=${pz.status}`);
  const puzzle = pz.body && pz.body.data;
  ok('谜题含 id / prefix / difficulty',
    !!puzzle && typeof puzzle.id === 'string' && typeof puzzle.prefix === 'string'
      && typeof puzzle.difficulty === 'number',
    puzzle ? JSON.stringify(Object.keys(puzzle)) : '(无 data)');
  if (!puzzle || !puzzle.id) return;

  console.log('\n=== 2. 求解 ===');
  const { solution, ms } = solvePow(puzzle.prefix, puzzle.difficulty);
  ok('解出 PoW', !!solution, solution ? `solution=${solution} 耗时 ${ms}ms` : '达到尝试上限');
  if (!solution) return;

  console.log('\n=== 3. 换票据 ===');
  const tk = await get('POST', '/api/anti/ticket', { id: puzzle.id, solution });
  ok('POST /api/anti/ticket 返回 200', tk.status === 200,
    `status=${tk.status} ${(tk.body && tk.body.message) || ''}`);
  const token = tk.body && tk.body.data && tk.body.data.token;
  ok('拿到票据（ts.jti.sig 三段）', !!token && token.split('.').length === 3);
  if (!token) return;

  console.log('\n=== 4. 签名访问业务接口 ===');
  // 读请求也要签名：X-Sig = HMAC-SHA256(key=ticket, method|path|ts|bodyHash|jti|nonce)
  // path 是挂载点相对路径（去掉 /api），且要 decodeURIComponent
  const jti = token.split('.')[1];
  let seq = 0;
  const sign = (method, fullPath) => {
    const ts = Date.now();
    const nonce = `e2e${++seq}${Math.random().toString(36).slice(2, 10)}`;
    const relPath = decodeURIComponent(fullPath.replace(/^\/api/, '').split('?')[0]);
    const data = [method.toUpperCase(), relPath, ts, sha256hex(JSON.stringify({})), jti, nonce].join('|');
    const sig = crypto.createHmac('sha256', String(token)).update(data).digest('hex');
    // 票据头是 X-Pass（不是 X-Ticket）
    return { 'X-Pass': token, 'X-Timestamp': String(ts), 'X-Nonce': nonce, 'X-Sig': sig };
  };

  const arts = await get('GET', '/api/articles?page=1&pageSize=5', null, sign('GET', '/api/articles'));
  ok('持票 + 签名 GET /api/articles 返回 200', arts.status === 200,
    `status=${arts.status} ${(arts.body && arts.body.message) || ''}`);
  const list = arts.body && arts.body.data && arts.body.data.list;
  ok('返回文章列表', Array.isArray(list), list ? `${list.length} 篇` : '(无 list)');

  const notes = await get('GET', '/api/notes?page=1', null, sign('GET', '/api/notes'));
  ok('持票 + 签名 GET /api/notes 返回 200', notes.status === 200,
    `status=${notes.status} ${(notes.body && notes.body.message) || ''}`);

  console.log('\n=== 5. 防护仍然生效（反向断言）===');
  const noTicket = await get('GET', '/api/articles?page=1');
  ok('无票据被拒（403）', noTicket.status === 403, `status=${noTicket.status}`);

  const badFp = await get('POST', '/api/anti/ticket', { id: puzzle.id, solution }, { 'X-Fp': 'not-hex' });
  ok('伪造指纹换票被拒（403）', badFp.status === 403, `status=${badFp.status}`);

  const reusePuzzle = await get('POST', '/api/anti/ticket', { id: puzzle.id, solution });
  ok('同一个谜题不能换第二次票（一次性）', reusePuzzle.status === 403, `status=${reusePuzzle.status}`);

  const badSig = await get('GET', '/api/articles?page=1', null, { 'X-Pass': token, 'X-Sig': 'x'.repeat(64),
    'X-Timestamp': String(Date.now()), 'X-Nonce': 'bad12345' });
  ok('票据正确但签名错误被拒（403）', badSig.status === 403, `status=${badSig.status}`);

  console.log('\n=== 6. 免票的 SEO 落地页（share-page）===');
  // 这类页面**不走闸门**（在 GATE_SKIP 里），因为爬虫不会解 PoW。
  // 它们要能被匿名 GET 到，且必须渲染出真实内容 —— 空壳落地页在 SEO 上等于没提交。
  for (const path of ['/api/share-page', '/api/share-page/articles', '/api/share-page/archive']) {
    const r = await get('GET', path);
    ok(`匿名 GET ${path} 返回 200`, r.status === 200, `status=${r.status}`);
    const isHtml = /^<!DOCTYPE html>/i.test((r.raw || '').trim());
    ok(`${path} 返回 HTML`, isHtml, r.raw ? r.raw.slice(0, 40) : '(空)');
    // 必须有 canonical（否则重复内容会被爬虫当成多个独立页）
    ok(`${path} 含 rel="canonical"`, /rel=["']canonical["']/i.test(r.raw || ''));
    // 必须有 title，且不能是 undefined（原型链键那个缺陷就会产出 undefined）
    const title = ((r.raw || '').match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    ok(`${path} 的 title 非空且不含 undefined`, title.trim().length > 0 && !/undefined/i.test(title),
      JSON.stringify(title.slice(0, 40)));
    ok(`${path} 没有渲染出 undefined 字样`, !/undefined/.test(r.raw || ''));
  }

  // 原型链键不能被当成合法页面（第 44 轮修的 bug 的回归测试）
  for (const k of ['constructor', 'toString', 'valueOf']) {
    const r = await get('GET', `/api/share-page/${k}`);
    ok(`/api/share-page/${k} 返回 404（原型链键不是页面）`, r.status === 404, `status=${r.status}`);
  }

  console.log('\n=== 7. sitemap / robots 可达 ===');
  const sm = await get('GET', '/api/sitemap.xml');
  ok('sitemap 返回 200', sm.status === 200, `status=${sm.status}`);
  const locs = [...(sm.raw || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok('sitemap 有 URL', locs.length > 5, `${locs.length} 条`);
  ok('sitemap 包含文章列表页（第 46 轮修的那处）',
    locs.some((u) => /\/share-page\/articles$/.test(u)), locs.join(' ').slice(0, 120));
  ok('sitemap 不含 hash 路由（# 之后会被爬虫丢弃）',
    locs.every((u) => !u.includes('#')), locs.filter((u) => u.includes('#')).join(' '));

  const rb = await get('GET', '/api/robots.txt');
  ok('robots.txt 返回 200', rb.status === 200, `status=${rb.status}`);
  ok('robots.txt 里 sitemap 地址是真实路径（不是 hash）',
    /Sitemap:\s*https?:\/\/\S+\/api\/sitemap\.xml/.test(rb.raw || ''));
}

async function main() {
  let server = null;
  let port = USE_PORT;
  if (!port) {
    const app = require('../src/app');
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    port = server.address().port;
    console.log(`（自己起了服务，随机端口 ${port}）`);
  } else {
    console.log(`（连已在跑的服务，端口 ${port}）`);
  }

  try {
    await run(makeClient(port));
  } catch (e) {
    fail++;
    failures.push('未捕获异常：' + e.message);
    console.log('  ✗ 未捕获异常 — ' + e.message);
  } finally {
    if (server) await new Promise((r) => server.close(r));
  }

  console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main();
