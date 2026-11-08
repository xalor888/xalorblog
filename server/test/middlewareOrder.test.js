/**
 * 中间件顺序契约（零 DB、零服务 —— 只读 app.js 源码）。
 *
 * 中间件顺序错了，功能往往**照样正常**，但防护会静默失效：
 *   - body 解析挪到 WAF 之后 → WAF 看不到 POST body，注入检测全瞎；
 *   - ipGuard 挪到 PoW 闸门之后 → 被封的 IP 还会被要求解 PoW（白费 CPU）；
 *   - apiLimiter 挪到最后 → 攻击流量先被 WAF 逐条规则匹配才限流，CPU 先炸；
 *   - audit 挪到业务路由之后 → 记不到「已认证但有副作用」的操作。
 *
 * 这些都是「改一行 app.use 的位置」就能引入的，而且没有测试会红 ——
 * 所以把顺序写成断言。每条约束都对应 app.js 里的一句注释，两边一起改才不至于漂移。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'src', 'app.js');

let passCount = 0, failCount = 0;
function check(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failCount++;
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}

/** 提取每个中间件的首次出现行号（1-based）；找不到记 -1 */
function findOrder(src) {
  const markers = {
    requestId: /req\.requestId\s*=/,
    trustProxy: /app\.set\('trust proxy'/,
    gzip: /app\.use\(createGzipMiddleware\(\)\)/,
    jsonBody: /app\.use\(express\.json\(/,
    urlencoded: /app\.use\(express\.urlencoded\(/,
    apiLimiter: /app\.use\(config\.apiPrefix,\s*apiLimiter\)/,
    waf: /app\.use\(waf\)/,
    ipGuard: /app\.use\(ipGuard\)/,
    fetchMetaGuard: /app\.use\(api,\s*fetchMetaGuard\)/,
  };
  const out = {};
  for (const [k, re] of Object.entries(markers)) {
    const m = src.match(re);
    out[k] = m ? src.slice(0, m.index).split('\n').length : -1;
  }
  // 反爬闸门与 audit 用更宽松的锚点
  const gateM = src.match(/app\.use\(api,\s*async\s*\(req,\s*res,\s*next\)\s*=>\s*\{/);
  out.gate = gateM ? src.slice(0, gateM.index).split('\n').length : -1;
  const auditM = src.match(/app\.use\(api,\s*audit\)/);
  out.audit = auditM ? src.slice(0, auditM.index).split('\n').length : -1;
  return out;
}

const src = fs.readFileSync(APP, 'utf8');
const at = findOrder(src);

console.log('=== A. 每个被检查的中间件都还在（找不到就不能比较顺序）===');
for (const k of ['requestId', 'gzip', 'jsonBody', 'urlencoded', 'apiLimiter', 'waf', 'ipGuard', 'fetchMetaGuard', 'gate', 'audit']) {
  check(`${k} 仍注册在 app.js 里`, () => {
    assert.ok(at[k] > 0, `${k} 找不到 —— 可能是改名或删了，顺序断言会失效`);
  });
}

console.log('\n=== B. 顺序约束（每条都对应 app.js 的一句注释）===');
const before = (a, b, why) => {
  check(`${a} 在 ${b} 之前`, () => {
    assert.ok(at[a] > 0 && at[b] > 0, `${a}=${at[a]} ${b}=${at[b]}`);
    assert.ok(at[a] < at[b], `${a}(第${at[a]}行) 必须在 ${b}(第${at[b]}行) 之前 — ${why}`);
  });
};

// 请求 ID 必须最先：后面所有日志/错误处理都要用它
check('requestId 属于最早的那个 app.use 块', () => {
  // 不能直接比较行号：req.requestId 在 app.use 的块里（中间还有一行 const incoming），
  // 应该比较「req.requestId 所在的那个 app.use」是不是第一个 app.use。
  const beforeReqId = src.slice(0, src.match(/req\.requestId\s*=/).index);
  const ownUseAt = beforeReqId.lastIndexOf('app.use(');
  const ownUseLine = beforeReqId.slice(0, ownUseAt).split('\n').length;
  const firstUseLine = src.slice(0, src.indexOf('app.use(')).split('\n').length;
  assert.strictEqual(ownUseLine, firstUseLine,
    `requestId 在第一个 app.use 之后（第一个 app.use 在第${firstUseLine}行，requestId 所在的块在第${ownUseLine}行）`);
});

// trust proxy 必须在任何读取 req.ip 的东西之前
before('trustProxy', 'apiLimiter', '限流的 keyGenerator 用 req.ip，伪造的 XFF 会让限流按假 IP 分桶');

// body 解析必须在 WAF 之前：WAF 要看 POST body
before('jsonBody', 'waf', 'WAF 检查请求体里的注入特征；body 未解析时它只能看到空对象');
before('urlencoded', 'waf', '同上（表单提交走 urlencoded）');

// 限流必须在 WAF 之前：先做便宜的事
before('apiLimiter', 'waf', '被限流的请求不该再逐条跑 WAF 规则（CPU 放大）');

// WAF 必须在 ipGuard 之前：注释明确写了「先规则、后信誉」
before('waf', 'ipGuard', 'app.js 注释：WAF 在限流与路由之前；ipGuard 是它在信誉层的补充');

// 封禁的 IP 不该被要求解 PoW
before('ipGuard', 'gate', '被封禁的 IP 应在闸门前就被拒，而不是先让它解一道 PoW');

// 跨站写请求应在发票据之前就被拒
before('fetchMetaGuard', 'gate', 'Fetch Metadata 是浏览器免费给的信号，比 PoW 便宜得多');

// 审计在闸门之后（记录的是「已通过闸门 + 已认证」的操作）
before('gate', 'audit', 'audit 记的是通过闸门后的操作；放到闸门前会把被拦的请求也记成操作');

console.log('\n=== C. gzip 的位置不敏感，但必须存在 ===');
check('gzip 挂在 body 解析之前（包装 res.write/res.end，与 body 无关）', () => {
  assert.ok(at.gzip > 0);
  assert.ok(at.gzip < at.jsonBody, `gzip=${at.gzip} jsonBody=${at.jsonBody}`);
});

console.log('\n=== D. 业务路由必须在所有全局中间件之后 ===');
check('第一个业务路由的注册在所有 app.use 之后', () => {
  const routeM = src.match(/app\.use\(`?\$\{api\}\/(articles|notes|auth|articles)`?\s*,/);
  assert.ok(routeM, '找不到业务路由注册');
  const routeLine = src.slice(0, routeM.index).split('\n').length;
  for (const [k, v] of Object.entries(at)) {
    if (v > 0) assert.ok(v < routeLine, `${k}(${v}) 必须在业务路由(${routeLine}) 之前`);
  }
});

console.log('\n=== E. 自检：比较函数能抓到逆序 ===');
{
  const fake = { a: 10, b: 20 };
  check('自检：a<b 判为通过', () => {
    assert.ok(fake.a < fake.b);
  });
  check('自检：b<a 判为失败（这就是逆序会被抓到的原因）', () => {
    assert.throws(() => assert.ok(fake.b < fake.a), /AssertionError|falsy/);
  });
  check('自检：找不到的中间件行号是 -1（不会与真实行号混淆）', () => {
    const fakeSrc = 'const x = 1;';
    const ord = findOrder(fakeSrc);
    assert.strictEqual(ord.waf, -1);
    assert.strictEqual(ord.gate, -1);
  });
  check('自检：能从样本里提取到行号', () => {
    const sample = 'line1\napp.use(waf);\nline3\napp.use(ipGuard);\n';
    const ord = findOrder(sample);
    assert.strictEqual(ord.waf, 2);
    assert.strictEqual(ord.ipGuard, 4);
    assert.ok(ord.waf < ord.ipGuard);
  });
}

console.log(`\nmiddlewareOrder 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
