/**
 * requestGuard 单元测试套件（无需服务器/数据库：纯中间件分支覆盖）
 *
 * 背景：refererRequired/timestampRequired 是纵深防御层，位于 gate（签名强校验）之后。
 * 由于所有通过 gate 的写请求都携带有效签名，拒绝分支在 HTTP 集成测试中永远不可达
 * （CORS 层先拦外域 Origin；gate 层先拦无签名请求），因此用 mock 直接驱动中间件。
 *
 * 覆盖重点：
 * 1. refererRequired 旁路条件必须为「签名已验证标记」（req.sigVerified，仅 gateWriteRequired
 *    验签成功后写入），而非裸 X-Sig 头 —— 头可伪造，标记不可（核心回归断言）
 * 2. Origin: null / 双头不一致 / 外域来源 一律拒绝
 * 3. timestampRequired 缺失/非法/超窗拒绝，窗口内放行
 * 4. gateWriteRequired 验签通过后真实写入 req.sigVerified
 */
const c = require('./client');
const rg = require('../src/middleware/requestGuard');
const gate = require('../src/middleware/gate');

const FP = 'a'.repeat(64);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GOOD_ORIGIN = 'http://localhost:5173';
const GOOD_REFERER = 'http://localhost:5173/';

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function mockRes() {
  return {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function mockReq(headers = {}, extra = {}) {
  return { headers: { ...headers }, ip: '1.2.3.4', method: 'POST', path: '/comments', ...extra };
}

/** 同步驱动 refererRequired：返回 { nexted, status, message } */
function runRef(req) {
  let nexted = false;
  const res = mockRes();
  rg.refererRequired(req, res, () => { nexted = true; });
  return { nexted, status: res.statusCode, message: res.body && res.body.message };
}

/** 同步驱动 timestampRequired */
function runTs(req) {
  let nexted = false;
  const res = mockRes();
  rg.timestampRequired(req, res, () => { nexted = true; });
  return { nexted, status: res.statusCode, message: res.body && res.body.message };
}

async function suite() {
  console.log('=== A. refererRequired：拒绝分支 ===');
  let r = runRef(mockReq({}));
  assert('无来源无标记 → 403', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  r = runRef(mockReq({ origin: 'null' }));
  assert('Origin:null → 403（沙箱/隐私容器）', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  r = runRef(mockReq({ origin: 'http://evil.com' }));
  assert('外域 Origin → 403', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  r = runRef(mockReq({ referer: 'http://evil.com/' }));
  assert('外域 Referer → 403', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  r = runRef(mockReq({ origin: GOOD_ORIGIN, referer: 'http://evil.com/' }));
  assert('双头不一致 → 403', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  r = runRef(mockReq({ origin: 'http://localhost:5173.evil.com' }));
  assert('后缀伪装域 → 403（精确匹配，非前缀匹配）', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  r = runRef(mockReq({ origin: 'not a url' }));
  assert('非法 URL Origin → 403（safeHost 解析失败）', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  console.log('=== B. refererRequired：放行分支 ===');
  r = runRef(mockReq({ origin: GOOD_ORIGIN }));
  assert('合法 Origin → 放行', r.nexted === true, JSON.stringify(r));

  r = runRef(mockReq({ referer: GOOD_REFERER }));
  assert('合法 Referer → 放行', r.nexted === true, JSON.stringify(r));

  r = runRef(mockReq({ origin: GOOD_ORIGIN, referer: GOOD_REFERER }));
  assert('双头一致合法 → 放行', r.nexted === true, JSON.stringify(r));

  r = runRef(mockReq({ origin: 'http://127.0.0.1:8080' }));
  assert('本地开发来源 → 放行', r.nexted === true, JSON.stringify(r));

  r = runRef(mockReq({ origin: 'http://[::1]:8080' }));
  assert('本地 IPv6 开发来源 → 放行', r.nexted === true, JSON.stringify(r));

  console.log('=== C. refererRequired：签名旁路语义（核心回归） ===');
  r = runRef(mockReq({ 'x-sig': 'deadbeef', origin: 'http://evil.com' }));
  assert('裸 X-Sig 头 + 外域来源 → 403（头不可伪造旁路）', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  r = runRef(mockReq({ 'x-sig': 'deadbeef' }));
  assert('裸 X-Sig 头 + 无来源 → 403（旁路仅认签名已验证标记）', r.status === 403 && r.message === '来源不合法', JSON.stringify(r));

  r = runRef(mockReq({ origin: 'http://evil.com' }, { sigVerified: true }));
  assert('sigVerified=true + 外域来源 → 放行（签名强度高于 Referer）', r.nexted === true, JSON.stringify(r));

  console.log('=== D. timestampRequired ===');
  r = runTs(mockReq({}));
  assert('缺 X-Timestamp → 403', r.status === 403 && r.message === '请求时间戳缺失', JSON.stringify(r));

  r = runTs(mockReq({ 'x-timestamp': 'abc' }));
  assert('非数字 X-Timestamp → 403', r.status === 403 && r.message === '请求时间戳缺失', JSON.stringify(r));

  r = runTs(mockReq({ 'x-timestamp': String(Date.now() - 6 * 60 * 1000) }));
  assert('6 分钟前 → 403 已过期', r.status === 403 && r.message === '请求已过期，请刷新页面', JSON.stringify(r));

  r = runTs(mockReq({ 'x-timestamp': String(Date.now() + 6 * 60 * 1000) }));
  assert('6 分钟后 → 403 已过期', r.status === 403 && r.message === '请求已过期，请刷新页面', JSON.stringify(r));

  r = runTs(mockReq({ 'x-timestamp': String(Date.now()) }));
  assert('当前时间 → 放行', r.nexted === true, JSON.stringify(r));

  r = runTs(mockReq({ 'x-timestamp': String(Date.now() + 4 * 60 * 1000) }));
  assert('+4 分钟（窗口内）→ 放行', r.nexted === true, JSON.stringify(r));

  console.log('=== E. gateWriteRequired 写入 sigVerified 标记（签名链路闭环） ===');
  // 构造合法票据 + 签名（与 client.js 签名格式一致）
  const t = gate.issueTicket('1.2.3.4', FP, UA);
  const ts = Date.now();
  const nonce = 'testnonce123456';
  const bodyHash = c.sha256hex('{}');
  const sig = c.hmac(t.token, `POST|/comments|${ts}|${bodyHash}|${t.jti}|${nonce}`);

  let nexted = false;
  let res = mockRes();
  const goodReq = mockReq({
    'user-agent': UA,
    'x-pass': t.token,
    'x-fp': FP,
    'x-timestamp': String(ts),
    'x-nonce': nonce,
    'x-sig': sig,
  });
  gate.gateWriteRequired(goodReq, res, () => { nexted = true; });
  assert('有效签名 → 放行且 req.sigVerified===true', nexted === true && goodReq.sigVerified === true, `sigVerified=${goodReq.sigVerified}`);

  nexted = false;
  res = mockRes();
  const badReq = mockReq({
    'user-agent': UA,
    'x-pass': t.token,
    'x-fp': FP,
    'x-timestamp': String(ts),
    'x-nonce': nonce,
    'x-sig': 'deadbeef',
  });
  gate.gateWriteRequired(badReq, res, () => { nexted = true; });
  assert('伪签名 → 403 且不写标记', !nexted && res.statusCode === 403 && badReq.sigVerified !== true, `status=${res.statusCode} sigVerified=${badReq.sigVerified}`);

  // 旁路闭环：通过 gate 的请求（sigVerified）→ refererRequired 放行
  const end2end = runRef({ ...goodReq, headers: { ...goodReq.headers }, sigVerified: true });
  assert('sigVerified → refererRequired 放行（端到端链路）', end2end.nexted === true, JSON.stringify(end2end));

  console.log('=== F. gateRequired：读请求也要签名 ===');
  {
    const t2 = gate.issueTicket('1.2.3.4', FP, UA);
    const ts2 = Date.now();
    const nonce2 = 'getnonce12345678';
    const bodyHash2 = c.sha256hex('{}');
    const getSig = c.hmac(t2.token, `GET|/articles|${ts2}|${bodyHash2}|${t2.jti}|${nonce2}`);
    let nextGet = false;
    let resGet = mockRes();
    const signedGet = mockReq({
      'user-agent': UA,
      'x-pass': t2.token,
      'x-fp': FP,
      'x-timestamp': String(ts2),
      'x-nonce': nonce2,
      'x-sig': getSig,
    }, { method: 'GET', path: '/articles' });
    gate.gateRequired(signedGet, resGet, () => { nextGet = true; });
    assert('带签名 GET → 放行', nextGet === true && signedGet.sigVerified === true, `sigVerified=${signedGet.sigVerified}`);

    nextGet = false;
    resGet = mockRes();
    const bareGet = mockReq({
      'user-agent': UA,
      'x-pass': t2.token,
      'x-fp': FP,
    }, { method: 'GET', path: '/articles' });
    gate.gateRequired(bareGet, resGet, () => { nextGet = true; });
    assert('裸票无签名 GET → 403', !nextGet && resGet.statusCode === 403, `status=${resGet.statusCode}`);
  }

  console.log(`\nrequestGuard 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error(failures.join('\n')); process.exit(1); }
}

suite().catch((e) => { console.error('套件异常:', e); process.exit(1); });
