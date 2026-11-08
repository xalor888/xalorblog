/**
 * 安全回归测试套件
 * 覆盖：闸门（PoW/票据/签名）、表单令牌、反爬 UA、Host 校验、方法白名单、
 *       Referer/Origin 校验、JSON 炸弹、上传安全、安全响应头、robots/security.txt
 * 顺序设计：成功类测试前置；会累积 IP 信誉积分的测试（Host/Origin/超长 URL/JSON 炸弹）
 * 放中间；攻击载荷（WAF/蜜罐）触发封禁放最后。
 * 注意：IP 信誉系统会在测试过程中自动封禁测试 IP——这是预期行为，
 *       因此「封禁后全站拒绝」作为独立断言验证。
 */
const c = require('./client');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function suite() {
  console.log('\n=== 1. 闸门（无票据请求必须被拒） ===');
  let r = await c.req('GET', '/api/articles');
  assert('无票据读请求被拒', r.status === 403);

  r = await c.req('POST', '/api/comments', { body: { nickname: 'x', content: 'y' } });
  assert('无票据写请求被拒', r.status === 403);

  console.log('\n=== 2. PoW + 票据流程 ===');
  const ticket = await c.getTicket();
  assert('PoW 求解并换票成功', !!ticket);

  r = await c.req('GET', '/api/articles', { ticket });
  assert('带票据读文章成功', r.status === 200 && r.body && r.body.code === 0);

  console.log('\n=== 3. 签名校验（写请求） ===');
  r = await c.req('POST', '/api/comments', { body: { nickname: '测试', content: '你好' }, headers: { 'X-Pass': ticket, 'X-Timestamp': String(Date.now()), 'X-Nonce': 'nonce1234567890', 'X-Sig': 'deadbeef' } });
  assert('伪造签名被拒', r.status === 403);

  // 合法签名 + 表单令牌（formPost 内部完成 seed → 2s 间隔 → 签名提交）
  // 内容带一次性后缀：comments 有「同 IP 30 分钟内完全相同内容」判重（429），
  // 不带后缀时单独重跑本套件（不经 run.js 清库）会因判重变红，掩盖真实回归
  r = await c.formPost('/api/comments', { nickname: '测试', content: `你好世界 ${Date.now()}`, article_id: 1, email: '' }, ticket);
  assert(
    '签名 + 表单令牌正确的写请求必须成功（HTTP 200 且 code=0）',
    r.status === 200 && r.body && r.body.code === 0,
    `status=${r.status} code=${r.body && r.body.code} ${r.body && r.body.message}`
  );

  // 重放 nonce
  console.log('\n=== 4. 重放防护（同 nonce 二次请求被拒） ===');
  const http = require('http');
  const body = JSON.stringify({ nickname: '重放', content: 'test-replay' });
  const ts = Date.now();
  const nonce = 'replaynonce1234';
  const sig = c.hmac(ticket, `POST|/comments|${ts}|${c.sha256hex(body)}|${ticket.split('.')[1]}|${nonce}`);
  const headers = {
    'User-Agent': c.UA, 'X-Fp': 'a'.repeat(64), 'Content-Type': 'application/json',
    'X-Pass': ticket, 'X-Timestamp': String(ts), 'X-Nonce': nonce, 'X-Sig': sig,
    'Origin': 'http://localhost:5173', 'Referer': 'http://localhost:5173/',
  };
  const sendReplay = () => new Promise((resolve) => {
    const u = new URL(c.BASE + '/api/comments');
    const rq = http.request(u, { method: 'POST', headers }, (res) => {
      let b = ''; res.on('data', (x) => (b += x)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    rq.write(body); rq.end();
  });
  const s1 = await sendReplay();
  const s2 = await sendReplay();
  const firstBody = JSON.parse(s1.body || '{}');
  assert('首次签名通过（未被签名层拒绝）', s1.status !== 403 || firstBody.message !== '请求签名无效', `s1=${s1.status} ${firstBody.message}`);
  const secondBody = JSON.parse(s2.body || '{}');
  assert('nonce 重放被签名层拒绝', s2.status === 403 && secondBody.message === '请求签名无效', `s2=${s2.status} ${secondBody.message}`);

  // 点赞防刷（HTTP 层）：防刷键仅 IP 维度；仅做 1 次 429（rate +2 分），
  // 保持前置积分 < 蜜罐(+6) + 10 = 封禁阈值，不干扰 10b UA 轮换全 200 断言；
  // 换 fp 不可绕的键语义由 likeGuard.test.js 单元套件覆盖
  console.log('\n=== 4b. 点赞防刷（HTTP 层） ===');
  const listR = await c.req('GET', '/api/articles', { ticket });
  const aid = listR.body && listR.body.data && listR.body.data.list && listR.body.data.list[0] && listR.body.data.list[0].id;
  assert('可取到文章 id 用于点赞测试', Number.isInteger(aid) && aid > 0, `aid=${aid}`);
  r = await c.req('POST', `/api/articles/${aid}/like`, { body: {}, ticket });
  assert('首次点赞成功', r.status === 200 && r.body.code === 0, `status=${r.status} ${r.body && r.body.message}`);
  r = await c.req('POST', `/api/articles/${aid}/like`, { body: {}, ticket });
  assert('同 IP 10 秒内再赞被拒 429', r.status === 429, `status=${r.status} ${r.body && r.body.message}`);

  // 续期链上限（进程内单测：绕过 HTTP 限流，直接验证 MAX_RENEWS 计数链）
  console.log('\n=== 4b. 续期链上限（MAX_RENEWS=10，进程内） ===');
  {
    const gate = require('../src/middleware/gate');
    const mkReq = (ip, fp, ua, xpass) => ({
      ip,
      headers: { 'x-fp': fp, 'user-agent': ua, ...(xpass ? { 'x-pass': xpass } : {}) },
    });
    const IP = '127.0.0.1', FP = 'f'.repeat(64), UA = 'Mozilla/5.0 RenewTest';
    let chain = gate.issueTicket(FP, UA, 0).token;
    let okRenews = 0, rejected = null;
    for (let i = 1; i <= 12; i++) {
      const r = gate.renewTicket(mkReq(IP, FP, UA, chain));
      if (r.ok) { chain = r.token; okRenews++; }
      else { rejected = { at: i, reason: r.reason }; break; }
    }
    assert('续期链成功 10 次', okRenews === 10, `实际 ${okRenews}`);
    assert('第 11 次续期强制重新 PoW', !!rejected && rejected.at === 11 && rejected.reason === '需要重新验证', JSON.stringify(rejected));
    // 新票据链计数独立（不全局污染）
    let chain2 = gate.issueTicket(FP, UA, 0).token;
    let c2 = 0;
    for (let i = 0; i < 11; i++) {
      const r = gate.renewTicket(mkReq(IP, FP, UA, chain2));
      if (r.ok) { chain2 = r.token; c2++; } else break;
    }
    assert('新票据链同样可续 10 次（计数按链独立）', c2 === 10, `实际 ${c2}`);
  }

  // 表单令牌单次使用
  console.log('\n=== 5. 表单令牌单次使用 ===');
  const seed1 = await c.getFormToken(ticket, '/comments');
  await new Promise((r2) => setTimeout(r2, 2100));
  const tokenBody = { nickname: '令牌测试', content: '单次令牌验证', article_id: 1, email: '', form_token: seed1.token };
  r = await c.req('POST', '/api/comments', { body: tokenBody, ticket, headers: { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' } });
  const firstUse = r.status;
  r = await c.req('POST', '/api/comments', { body: tokenBody, ticket, headers: { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' } });
  assert('表单令牌重放被拒', r.status === 403 && (r.body.message || '').includes('已被使用'), `status=${r.status} ${r.body && r.body.message}`);
  assert('表单令牌首次使用通过（非 403）', firstUse !== 403, `first=${firstUse}`);

  // 蜜罐字段
  console.log('\n=== 5b. 蜜罐字段 ===');
  r = await c.formPost('/api/comments', { nickname: '蜜罐测试', content: '蜜罐内容', article_id: 1, email: '' }, ticket, { fillHoneypot: true });
  assert('蜜罐字段被填 → 提交被拒', r.status === 403, `status=${r.status}`);

  console.log('\n=== 6. robots.txt / security.txt ===');
  r = await c.req('GET', '/robots.txt', { headers: { 'User-Agent': 'Googlebot' } });
  assert('robots.txt 可访问', r.status === 200);
  r = await c.req('GET', '/api/robots.txt', { headers: { 'User-Agent': 'Googlebot' } });
  assert('/api/robots.txt 可访问（GATE_SKIP）', r.status === 200);
  r = await c.req('GET', '/.well-known/security.txt', { headers: { 'User-Agent': c.UA } });
  assert('security.txt 可访问', r.status === 200);

  console.log('\n=== 7. 安全响应头 ===');
  r = await c.req('GET', '/api/articles', { ticket });
  const hdrs = r.headers;
  assert('X-Frame-Options DENY', (hdrs['x-frame-options'] || '').includes('DENY'));
  assert('Referrer-Policy', !!hdrs['referrer-policy']);
  assert('X-Content-Type-Options nosniff', (hdrs['x-content-type-options'] || '').includes('nosniff'));
  assert('CORP same-origin', (hdrs['cross-origin-resource-policy'] || '').includes('same-origin'));
  assert('Cache-Control no-store', (hdrs['cache-control'] || '').includes('no-store'));
  assert('无 X-Powered-By', !hdrs['x-powered-by']);

  console.log('\n=== 8. 未知 API 路径同形 ===');
  r = await c.req('GET', '/api/nonexistent-xyz', { headers: { 'User-Agent': c.UA } });
  assert('未知接口 404/403 同形', [403, 404].includes(r.status) && r.body.message === '访问被拒绝', `status=${r.status}`);

  console.log('\n=== 9. 上传目录禁止列表 ===');
  r = await c.req('GET', '/uploads/', { headers: { 'User-Agent': c.UA } });
  assert('上传目录禁止列表', r.status === 403 || r.status === 404, `status=${r.status}`);

  console.log('\n=== 10. HTTP 方法白名单 + HEAD 只读语义 ===');
  r = await c.req('TRACE', '/api/health', { headers: { Host: 'localhost:3000' } });
  assert('TRACE 被拒 405', r.status === 405, `status=${r.status}`);
  r = await c.req('PATCH', '/api/health', { headers: { Host: 'localhost:3000' } });
  assert('PATCH 被拒 405', r.status === 405, `status=${r.status}`);
  // HEAD 与 GET 同等只读：只需票据，无需写签名（CDN/监控探活兼容）
  r = await c.req('HEAD', '/api/articles', { headers: { 'X-Pass': ticket }, silent: true });
  assert('HEAD 无签名（带票据）通过', r.status === 200, `status=${r.status}`);
  r = await c.req('HEAD', '/api/articles', { silent: true });
  assert('HEAD 无票据被拒', r.status === 403, `status=${r.status}`);

  // ---- 以下测试会累积 IP 信誉积分（可能触发封禁），全部为拒绝类断言 ----
  // 注意：UA 拦截（+9 积分/次×3）与 Host 校验（+3）共 12 分会触发封禁，
  // 必须放在所有「要求成功/特定错误消息」的测试之后
  console.log('\n=== 10b. UA 轮换检测（≥6 个浏览器 UA → 计分 → 自动封禁） ===');
  // 本段真实触发 IP 封禁（15 分钟），须在积分累计段（11 起）之前执行：
  // 前 6 个 UA 需保持 IP 未被封禁才能验证「正常访问」；后续请求复用同一票据与 UA，
  // 每请求 +2 积分，累计触发封禁（该封禁对后续拒绝类断言无影响）
  // 限流约束：ticketLimiter 10 次/分 → 6 张票分两批签发，中间暂停跨窗口
  const rotateUas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/210.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/211.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/212.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/213.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edge/210.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/19.0',
  ];
  const rotationIp = '192.0.2.60';
  const rotationHeaders = { 'X-Forwarded-For': rotationIp };
  let rotateAllOk = true;
  let rotateFailInfo = '';
  let lastRotateTicket = null;
  let sixthUaStatus = null;
  for (let i = 0; i < rotateUas.length; i++) {
    if (i === 3) await new Promise((r2) => setTimeout(r2, 40000)); // 跨限流窗口
    const tRot = await c.getTicket(undefined, rotateUas[i], rotationHeaders);
    let rRot = await c.req('GET', '/api/articles?page=1', { ticket: tRot, silent: true, ua: rotateUas[i], headers: rotationHeaders });
    if (rRot.status !== 200) {
      // 全局 apiLimiter 瞬时 429：等 2s 重试一次再判定
      await new Promise((r2) => setTimeout(r2, 2000));
      rRot = await c.req('GET', '/api/articles?page=1', { ticket: tRot, silent: true, ua: rotateUas[i], headers: rotationHeaders });
    }
    if (i < 5 && rRot.status !== 200) {
      rotateAllOk = false;
      rotateFailInfo = `UA#${i} → ${rRot.status} ${rRot.body && rRot.body.message || ''}`;
    }
    if (i === 5) sixthUaStatus = rRot.status; // 第 6 个 UA：跨过 UA_DIFF_THRESHOLD 的那一次
    lastRotateTicket = tRot;
    await new Promise((r2) => setTimeout(r2, 2300));
  }
  assert('5 个不同浏览器 UA（常规轮换）均可正常访问', rotateAllOk, rotateFailInfo);
  // 第 6 个 UA 让该 IP 的 UA 集合跨过 UA_DIFF_THRESHOLD(=6)：
  // waf.js 的 trackUaRotation 只做「记一次积分」（rate 权重 2 < banScore 10），
  // 记分后请求照常放行 —— 所以精确期望是 200，而不是「200 或 403 都算过」。
  // 若这里变成 403，说明轮换检测被当成了阻断条件，NAT/校园网出口的真实访客会被
  // 一起打死，那是回归而不是「检测生效」的另一种合理形态。
  assert(
    '第 6 个 UA 仍正常返回 200（轮换检测只记分、不阻断）',
    sixthUaStatus === 200,
    `第 6 个 UA → ${sixthUaStatus}（期望 200）`
  );
  // 第 6 个 UA 已触发检测。
  //
  // ⚠ 这里曾经断言「同 UA 继续请求 → 积分累计到自动封禁」。
  // 那条期望本身就是缺陷：跨过 UA_DIFF_THRESHOLD 之后，**窗口内每一次请求**
  // 都会 report 一次（waf 权重 3 / banScore 10），于是第 6 个 UA 之后的第 2 个
  // 请求就触发封禁。而 UA 轮换在真实世界里最典型的来源是 NAT 出口 ——
  // 公司/校园/运营商 CGNAT 后面几台设备的浏览器 UA 凑满 6 个是常态，
  // 结果是该出口上**所有**真实访客被一起封 15 分钟，且每次重犯翻倍。
  //
  // 现在的语义是「跨阈值瞬间只记一次分」（waf.js 的 markUaReportedOnce，
  // 与 gate.js 的 trackFpIp 同一原则）：检测照常触发、证据照常留痕，
  // 但不会因为持续轮换而无限累加。所以这里断言的是「分数有涨，但不因此封禁」。
  //
  // 要验证封禁仍然有效，看下一组「扫描器 / AI 爬虫 UA」—— 那些是明确的
  // 单一恶意指纹，每次命中都该计分。
  let sawReject = false;
  for (let k = 0; k < 8; k++) {
    const rRot = await c.req('GET', '/api/articles?page=1', { ticket: lastRotateTicket, silent: true, ua: rotateUas[5], headers: rotationHeaders });
    if (rRot.status === 403) { sawReject = true; break; }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  assert(
    'UA 轮换跨阈值只记一次分，不因持续轮换把 NAT 出口封死',
    !sawReject,
    '跨阈值后每请求重复计分会让 NAT/校园网出口的全部真实访客被一起封禁'
  );

  console.log('\n=== 11. 扫描器 / AI 爬虫 UA 拦截（+3 积分/次，累计封禁） ===');
  // 通用客户端（python-requests/curl/空 UA）已不再被 WAF 拦截计分：
  // 它们在 /api 上由闸门拒绝（无票据 403，不计信誉分），RSS 等放行通道可用
  r = await c.asBotUA('/api/articles');
  assert('python-requests 无票据被闸门拒绝（不记分）', r.status === 403);
  // 扫描器与 AI 爬虫 UA 在 gate-skip 通道（rss.xml）上由 WAF 硬拦并计分
  r = await c.asBotUA('/api/rss.xml', 'sqlmap/1.7');
  assert('sqlmap UA 被拒', r.status === 403);
  r = await c.asBotUA('/api/rss.xml', 'nikto/2.5.0');
  assert('nikto UA 被拒', r.status === 403);
  r = await c.asBotUA('/api/rss.xml', 'GPTBot/1.0');
  assert('GPTBot UA 被拒', r.status === 403);

  console.log('\n=== 12. Host 头校验（+3 积分 → 累计封禁） ===');
  r = await c.req('GET', '/api/health', { headers: { Host: 'evil.com', 'User-Agent': c.UA } });
  assert('非法 Host 被拒', r.status === 403, `status=${r.status}`);

  // WAF 攻击载荷 / 来源校验 / 蜜罐路径等测试已迁移至独立套件 waf.test.js
  // （run.js 会在套件间重置 IP 信誉 —— 原 13-17 节在封禁后运行，
  //   403 断言被封禁状态"喂饱"，无法证明 WAF 引擎真实拦截）

  console.log('\n=== 18. 封禁生效验证（攻击后 IP 应被封禁，连公开接口也拒绝） ===');
  r = await c.req('GET', '/robots.txt', { headers: { 'User-Agent': 'Googlebot' } });
  assert('攻击后 IP 被全站封禁（403）', r.status === 403, `status=${r.status}`);

  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
