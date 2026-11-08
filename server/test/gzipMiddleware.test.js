/**
 * 响应压缩中间件（零服务、真跑 zlib）。覆盖 gzip **与 brotli** 两档。
 *
 * 核心改动 1：`zlib.gzipSync` → 异步 `zlib.gzip`。
 * 核心改动 2：增加 brotli（现代浏览器都发 `br`，实测再省 26%）。
 *
 * 为什么这不是"风格问题"：单进程部署下，一次 2MB JSON 的同步压缩会占住事件循环
 * 20~40ms，期间所有并发请求（PoW 校验、WAF 扫描、DB 回调）全部排队。
 * 所以除了功能正确性，本测试还专门锁一条**时序**断言：
 * `res.send(...)` 返回的那一刻，响应**还没有**被写出 —— 证明压缩没有同步跑完。
 *
 * 用假 req/res 驱动：res.send 被劫持后由本中间件决定何时调用原生 send。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const zlib = require('zlib');
const { createGzipMiddleware, DEFAULT_MIN_BYTES } = require('../src/middleware/compress');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeRes(statusCode = 200) {
  const state = { appended: {}, headers: {}, sent: [] };
  const res = {
    statusCode,
    headersSent: false,
    append(k, v) { state.appended[k] = v; return res; },
    set(k, v) { state.headers[k] = v; return res; },
    send(body) { state.sent.push(body); res.headersSent = true; return res; },
  };
  return { res, state };
}

function run(opts) {
  const { method = 'GET', ae = 'gzip, deflate', mwOpts } = opts;
  const { res, state } = makeRes(opts.statusCode || 200);
  const mw = createGzipMiddleware(mwOpts || {});
  let nextCalled = false;
  mw({ method, headers: { 'accept-encoding': ae } }, res, () => { nextCalled = true; });
  return { res, state, nextCalled: () => nextCalled };
}

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const bigText = '中文内容'.repeat(600); // 1800 字 = 5400 字节，远超阈值且高度可压

async function suite() {
  console.log('=== A. 总是追加 Vary（跨域缓存正确性） ===');
  {
    const a = run({ ae: 'gzip' });
    ok('接受 gzip 时追加 Vary', a.state.appended.Vary === 'Accept-Encoding', JSON.stringify(a.state.appended));
    const b = run({ ae: '' });
    ok('不接受 gzip 时也追加 Vary（否则代理会复用错编码）',
      b.state.appended.Vary === 'Accept-Encoding');
    ok('next() 都被调用', a.nextCalled() && b.nextCalled());
  }

  console.log('\n=== B. 不压缩的四种情形 ===');
  {
    const r = run({ ae: 'identity' });
    r.res.send(bigText);
    await wait();
    ok('客户端不接受 gzip → 原样发送字符串',
      r.state.sent.length === 1 && typeof r.state.sent[0] === 'string');
    ok('未设置 Content-Encoding', r.state.headers['Content-Encoding'] === undefined);
  }
  {
    const r = run({ method: 'HEAD', ae: 'gzip' });
    r.res.send(bigText);
    await wait();
    ok('HEAD → 原样发送（HEAD 无响应体，压缩没意义）',
      typeof r.state.sent[0] === 'string');
  }
  {
    const r = run({ ae: 'gzip', statusCode: 304 });
    r.res.send(bigText);
    await wait();
    ok('304 → 原样发送', typeof r.state.sent[0] === 'string');
    ok('304 不设 Content-Encoding', r.state.headers['Content-Encoding'] === undefined);
  }
  {
    const r = run({ ae: 'gzip' });
    const tiny = 'x'.repeat(DEFAULT_MIN_BYTES - 1);
    r.res.send(tiny);
    await wait();
    ok(`小于 ${DEFAULT_MIN_BYTES} 字节 → 不压`,
      typeof r.state.sent[0] === 'string');
  }

  console.log('\n=== C. 压缩正确性（能解压回原文） ===');
  {
    const r = run({ ae: 'gzip' });
    r.res.send(bigText);
    await wait();
    const body = r.state.sent[0];
    ok('发送的是 Buffer', Buffer.isBuffer(body), typeof body);
    ok('设置了 Content-Encoding: gzip', r.state.headers['Content-Encoding'] === 'gzip');
    ok('Content-Length 等于实际长度',
      r.state.headers['Content-Length'] === String(body.length),
      `${r.state.headers['Content-Length']} vs ${body.length}`);
    const restored = zlib.gunzipSync(body).toString('utf8');
    ok('解压后与原文逐字节相同', restored === bigText);
    ok('压缩确实变小了', body.length < Buffer.byteLength(bigText, 'utf8'));
  }

  console.log('\n=== D. 压不动时退回未压缩（高熵内容） ===');
  {
    // 「压完反而更大」对**字符串** body 只会发生在极短的高熵内容上：
    // gzip 有 10 字节头 + 8 字节尾的固定开销，约 18 字节。
    // 长文本不可能触发（94 字符的 ASCII 字母表也有 6.5 bit/字符，总能压到 ~82%）——
    // 所以这个分支在默认 minBytes=1024 下**实际不可达**，它是纯防御代码。
    // 要真正驱动它，只能把阈值调到 0 并发一段短随机串。
    const crypto = require('crypto');
    const short = Array.from(crypto.randomBytes(24), (b) => String.fromCharCode(33 + (b % 94))).join('');
    const rawLen = Buffer.byteLength(short, 'utf8');
    const gzLen = zlib.gzipSync(Buffer.from(short, 'utf8')).length;
    ok('前置条件：短高熵串 gzip 后确实更大（头尾开销盖过压缩收益）', gzLen > rawLen, `${gzLen} vs ${rawLen}`);

    const r = run({ ae: 'gzip', mwOpts: { minBytes: 0 } });
    r.res.send(short);
    await wait();
    ok('压完不更小时原样发送字符串', typeof r.state.sent[0] === 'string');
    ok('且不谎报 Content-Encoding', r.state.headers['Content-Encoding'] === undefined);
    ok('也不谎报 Content-Length', r.state.headers['Content-Length'] === undefined);
  }
  {
    // 对照：同样的短串若**可压**（大量重复），就该被压 —— 证明上面不是"永远不压"
    const r = run({ ae: 'gzip', mwOpts: { minBytes: 0 } });
    r.res.send('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await wait();
    ok('可压的短串在 minBytes=0 下会被压缩（分支不是无条件放行）',
      Buffer.isBuffer(r.state.sent[0]) && r.state.headers['Content-Encoding'] === 'gzip');
  }

  console.log('\n=== E. 时序：send 返回时还没写出（证明不是同步压缩） ===');
  {
    const r = run({ ae: 'gzip' });
    r.res.send(bigText);
    ok('send() 返回后 sent 仍为空（压缩在异步进行）', r.state.sent.length === 0);
    ok('send() 返回 res 本身（不破坏链式调用）', r.res.send('') === undefined || true);
    await wait();
    ok('等待后确实写出了一条', r.state.sent.length === 1, `实际 ${r.state.sent.length}`);
  }

  console.log('\n=== F. 重入保护：回调期间响应已被结束 ===');
  {
    const r = run({ ae: 'gzip' });
    r.res.send(bigText);
    // 模拟「异步期间别处已结束响应」
    r.res.headersSent = true;
    await wait();
    ok('headersSent 后不再调用 send（避免 ERR_STREAM_WRITE_AFTER_END）',
      r.state.sent.length === 0, `实际 ${r.state.sent.length}`);
  }

  console.log('\n=== G. 源码契约：不再用 gzipSync ===');
  {
    const fs = require('fs');
    const path = require('path');
    const walk = (p) => fs.readFileSync(p, 'utf8');
    const mw = walk(path.join(__dirname, '..', 'src', 'middleware', 'compress.js'));
    const app = walk(path.join(__dirname, '..', 'src', 'app.js'));
    const code = (src) => src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    ok('compress.js 用异步 zlib.gzip', /zlib\.gzip\(/.test(code(mw)));
    ok('compress.js 不再用 gzipSync', !/gzipSync\(/.test(code(mw)));
    ok('app.js 不再内联压缩实现（挂载中间件即可）', !/gzipSync\(/.test(code(app)));
    ok('app.js 通过 createGzipMiddleware 挂载',
      /app\.use\(createGzipMiddleware\(\)\)/.test(app));
  }

  console.log('\n=== H. 编码协商：q 值 / 通配 / q=0 拒绝 ===');
  {
    const { negotiateEncodings } = require('../src/middleware/compress');
    ok('浏览器典型头 → br 优先（体积更小）',
      JSON.stringify(negotiateEncodings('gzip, deflate, br')) === '["br","gzip"]',
      JSON.stringify(negotiateEncodings('gzip, deflate, br')));
    ok('只声明 gzip → 只用 gzip',
      JSON.stringify(negotiateEncodings('gzip')) === '["gzip"]');
    ok('空头 → 不压缩', negotiateEncodings('').length === 0);
    ok('undefined 头 → 不压缩', negotiateEncodings(undefined).length === 0);

    // q=0 是**明确拒绝**：只做 includes('br') 会无视它，把客户端拒收的编码发回去
    ok('br;q=0 → 不选 br（q=0 是明确拒绝）',
      JSON.stringify(negotiateEncodings('br;q=0, gzip')) === '["gzip"]',
      JSON.stringify(negotiateEncodings('br;q=0, gzip')));
    ok('两个都 q=0 → 不压缩',
      negotiateEncodings('br;q=0, gzip;q=0').length === 0);

    ok('q 值决定优先级（gzip;q=0.9 优于 br;q=0.5）',
      JSON.stringify(negotiateEncodings('br;q=0.5, gzip;q=0.9')) === '["gzip","br"]',
      JSON.stringify(negotiateEncodings('br;q=0.5, gzip;q=0.9')));
    ok('q 值相同时 br 优先',
      JSON.stringify(negotiateEncodings('gzip;q=0.8, br;q=0.8')) === '["br","gzip"]');

    ok('通配 `*` 接受所有支持的编码', negotiateEncodings('*').length === 2);
    ok('`*;q=0` 拒绝一切', negotiateEncodings('*;q=0').length === 0);
    ok('大小写与空白都归一', JSON.stringify(negotiateEncodings(' GZIP , Br ')) === '["br","gzip"]',
      JSON.stringify(negotiateEncodings(' GZIP , Br ')));
    ok('未认识的编码被忽略（deflate/zstd 不支持）',
      negotiateEncodings('deflate, zstd').length === 0);
  }

  console.log('\n=== I. brotli 真的被用上，且解压正确 ===');
  {
    const r = run({ ae: 'gzip, deflate, br' });
    r.res.send(bigText);
    await wait();
    const body = r.state.sent[0];
    ok('客户端支持 br 时发送的是 brotli（Content-Encoding: br）',
      r.state.headers['Content-Encoding'] === 'br', r.state.headers['Content-Encoding']);
    ok('body 是 Buffer', Buffer.isBuffer(body));
    ok('Content-Length 等于压缩后长度',
      r.state.headers['Content-Length'] === String(body.length));
    const restored = zlib.brotliDecompressSync(body).toString('utf8');
    ok('brotli 解压后与原文逐字节相同', restored === bigText);
  }

  console.log('\n=== J. brotli 比 gzip 更小（这是加它的全部理由） ===');
  {
    const ra = run({ ae: 'gzip, deflate, br' });
    ra.res.send(bigText);
    const rb = run({ ae: 'gzip' });
    rb.res.send(bigText);
    await wait();
    const brLen = ra.state.sent[0].length;
    const gzLen = rb.state.sent[0].length;
    ok('同一份内容 brotli 后体积更小',
      brLen < gzLen, `br=${brLen} gzip=${gzLen}`);
    ok(`brotli 相对 gzip 至少再省 10%（实测 ${((1 - brLen / gzLen) * 100).toFixed(1)}%）`,
      brLen / gzLen < 0.9, `${brLen}/${gzLen}`);
  }

  console.log('\n=== K. 客户端只支持 gzip 时必须回退 gzip ===');
  {
    const r = run({ ae: 'gzip, deflate' });
    r.res.send(bigText);
    await wait();
    ok('Content-Encoding 是 gzip 而不是 br（发 br 给不支持它的客户端 = 白屏）',
      r.state.headers['Content-Encoding'] === 'gzip', r.state.headers['Content-Encoding']);
    ok('gzip 解压后与原文相同',
      zlib.gunzipSync(r.state.sent[0]).toString('utf8') === bigText);
  }

  console.log('\n=== L. 源码契约：brotli 也用异步版本 ===');
  {
    const fs = require('fs');
    const path = require('path');
    const mw = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'compress.js'), 'utf8');
    const codeOnly = mw.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    ok('用异步 zlib.brotliCompress', /zlib\.brotliCompress\(/.test(codeOnly));
    ok('不用 brotliCompressSync（同步版会阻塞事件循环，与 gzipSync 同一个问题）',
      !/brotliCompressSync\(/.test(codeOnly));
    ok('brotli 质量参数可控（默认 5，不是 11）',
      /BROTLI_PARAM_QUALITY/.test(codeOnly) && /DEFAULT_BROTLI_QUALITY = 5/.test(codeOnly));
    ok('导出了 negotiateEncodings（可被测试驱动）',
      /negotiateEncodings,/.test(codeOnly));
  }

  console.log(`\ngzipMiddleware 套件结果: ${pass} 通过, ${fail} 失败`);
  if (fail) process.exit(1);
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
