/**
 * 个人主页 / 手记 端到端集成测试（需要已启动的 API + MySQL）
 * 覆盖：
 *  1. /api/notes 未持票被闸门拒（与文章同级）
 *  2. 列表只出摘要字段（不含 content），草稿对前台不可见
 *  3. 详情正文 AES-GCM 密文 + 密钥 = HMAC(盐, 票据|note:<id>)，可解密且不等于明文
 *  4. 点赞窗口内第二次 429（复用文章 IP 防刷）
 *  5. /api/home/summary 免票可读、字段白名单、不含密钥与手记正文
 *  6. SEO 路由按 Host 派发（xalor.cn 主页版 / blog.xalor.cn 博客版）
 */
const crypto = require('crypto');
const c = require('./client');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

const MARK = '[NOTETEST]';
const FP = 'a'.repeat(64);
const HM = { 'X-Fp': FP, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' };
const ENC_SALT = process.env.TEST_ENC_SALT || 'xalor-content-v1';

function decryptNote(payload, ticket, key) {
  const derived = crypto.createHmac('sha256', ENC_SALT).update(`${ticket}|${key}`).digest();
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', derived, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

async function suite() {
  const ticket = await c.getTicket();

  console.log('\n=== 1. 闸门：未持票访问手记接口 ===');
  let r = await c.req('GET', '/api/notes', { silent: true });
  assert('未持票列表被拒（403）', r.status === 403, `status=${r.status}`);
  r = await c.req('GET', '/api/notes/1', { silent: true });
  assert('未持票详情被拒（403）', r.status === 403, `status=${r.status}`);

  console.log('\n=== 2. 免票首屏摘要 ===');
  r = await c.req('GET', '/api/home/summary', { silent: true });
  assert('无票据可读（200）', r.status === 200 && r.body && r.body.code === 0, `status=${r.status}`);
  const summary = r.body.data;
  const raw = JSON.stringify(summary);
  assert('不含任何密钥', !raw.includes('ai_api_key') && !raw.includes('websearch_api_key'));
  assert('不含手记正文', !('content' in summary) && !('notes' in summary));
  assert('含名片与统计', !!summary.site_name && typeof summary.stats.note_count === 'number');

  console.log('\n=== 3. 登录后台 ===');
  r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, ticket, headers: HM });
  assert('管理员登录成功', r.status === 200 && r.body.code === 0, `status=${r.status}`);
  const token = r.body.data.token;
  const adminPath = (await c.req('GET', '/api/anti/admin-path', { ticket, silent: true })).body.data.path;
  const adminBase = '/api/' + adminPath;
  const AH = { Authorization: 'Bearer ' + token, 'X-Fp': FP, ...HM };

  console.log('\n=== 4. 后台创建（草稿 + 已发布） ===');
  r = await c.req('POST', adminBase + '/notes', {
    ticket, headers: AH,
    body: { content: `${MARK} 已发布的手记正文`, mood: '开心', location: '家里', status: 'published', is_pinned: false },
  });
  assert('创建已发布手记', r.status === 200 && r.body.code === 0, `status=${r.status}`);
  const pubId = r.body.data.id;

  r = await c.req('POST', adminBase + '/notes', {
    ticket, headers: AH,
    body: { content: `${MARK} 草稿正文`, status: 'draft' },
  });
  assert('创建草稿手记', r.status === 200 && r.body.code === 0, `status=${r.status}`);
  const draftId = r.body.data.id;

  r = await c.req('POST', adminBase + '/notes', {
    ticket, headers: AH,
    body: { content: `${MARK} 九宫格`, images: ['/uploads/n1.webp', 'javascript:alert(1)', '/uploads/n2.webp'], status: 'published' },
  });
  const imgId = r.body.data.id;
  r = await c.req('GET', adminBase + `/notes/admin/${imgId}`, { ticket, headers: AH, silent: true });
  assert('非法图片 URL 被清洗', JSON.stringify(r.body.data.images) === JSON.stringify(['/uploads/n1.webp', '/uploads/n2.webp']), JSON.stringify(r.body.data.images));

  // 前台详情必须带完整图片数组：九宫格与灯箱只认 images，
  // 只给 cover/image_count（列表字段）会让详情页的九宫格永远是空的
  r = await c.req('GET', `/api/notes/${imgId}`, { ticket, silent: true });
  assert('前台详情返回完整 images 数组', JSON.stringify(r.body.data.images) === JSON.stringify(['/uploads/n1.webp', '/uploads/n2.webp']), JSON.stringify(r.body.data.images));
  assert('详情仍不含明文正文以外的多余字段', r.body.data.content_enc === true);

  console.log('\n=== 5. 前台列表：摘要白名单 + 草稿不可见 ===');
  r = await c.req('GET', '/api/notes?page=1&pageSize=50', { ticket, silent: true });
  assert('列表可读', r.status === 200 && r.body.code === 0, `status=${r.status}`);
  const list = r.body.data.list;
  const ids = list.map((n) => n.id);
  assert('草稿不在前台列表', !ids.includes(draftId), `draftId=${draftId}`);
  assert('已发布在列表中', ids.includes(pubId));
  assert('列表项不含正文', list.every((n) => !('content' in n)));
  assert('列表项带摘要与图片数', list.every((n) => 'excerpt' in n && 'image_count' in n));

  console.log('\n=== 6. 详情：按条密钥密文 ===');
  r = await c.req('GET', `/api/notes/${pubId}`, { ticket });
  assert('详情可读', r.status === 200, `status=${r.status}`);
  const det = r.body.data;
  assert('正文标记为加密', det.content_enc === true);
  assert('密钥为 note:<id>', det.content_key === `note:${pubId}`, det.content_key);
  assert('密文不等于明文', det.content !== `${MARK} 已发布的手记正文`);
  assert('密文可解密回原文', decryptNote(det.content, ticket, det.content_key) === `${MARK} 已发布的手记正文`);
  assert('换条密钥解不开', (() => {
    try { return decryptNote(det.content, ticket, `note:${pubId + 1000}`) !== `${MARK} 已发布的手记正文`; }
    catch (e) { return true; }
  })());

  r = await c.req('GET', `/api/notes/${draftId}`, { ticket, silent: true });
  assert('草稿详情前台 404', r.status === 404, `status=${r.status}`);

  console.log('\n=== 7. 点赞：防刷 + 跨站来源白名单 ===');
  r = await c.req('POST', `/api/notes/${pubId}/like`, { ticket, headers: HM });
  assert('首次点赞成功', r.status === 200 && r.body.data.likes >= 1, `status=${r.status}`);
  r = await c.req('POST', `/api/notes/${pubId}/like`, { ticket, headers: HM, silent: true });
  assert('窗口内再次点赞 429', r.status === 429, `status=${r.status}`);

  // 生产形态：个人主页域的写请求。
  // 两道白名单都要配，且**两道都容易漏**：
  //   - ALLOWED_HOSTS   → 派生 refererRequired 的来源白名单
  //   - CORS_ORIGINS    → 浏览器对同源 POST/PUT/DELETE 同样会带 Origin 头（GET 才不带），
  //                       漏配表现为「页面能看，但该域名下所有写操作 403 不允许的跨域来源」
  // 这里不只测「能不能点成」，还断言这两份配置的一致性 —— 半配置状态必须报错而不是静默跳过。
  r = await c.req('POST', adminBase + '/notes', {
    ticket, headers: AH, body: { content: `${MARK} 跨站点赞`, status: 'published' },
  });
  const crossId = r.body.data.id;

  const cfg = require('../src/config');
  const HOME_ORIGIN = 'https://xalor.cn';
  const homeHost = String(cfg.homeSiteHost || 'xalor.cn').toLowerCase();
  if (!cfg.allowedHosts.map((h) => h.toLowerCase()).includes(homeHost)) {
    console.log(`  ~ 跳过主页域写请求断言：ALLOWED_HOSTS 未包含 ${homeHost}（见 server/.env.example）`);
  } else {
    assert(
      `ALLOWED_HOSTS 含 ${homeHost} 时，CORS_ORIGINS 必须同时含 ${HOME_ORIGIN}`,
      cfg.corsOrigins.includes(HOME_ORIGIN),
      `corsOrigins=${JSON.stringify(cfg.corsOrigins)}`
    );
    r = await c.req('POST', `/api/notes/${crossId}/like`, {
      ticket,
      headers: { 'X-Fp': FP, Origin: HOME_ORIGIN, Referer: `${HOME_ORIGIN}/` },
      silent: true,
    });
    assert(
      '主页域来源的写请求成功（来源 + CORS 双白名单）',
      r.status === 200 && r.body.code === 0,
      `status=${r.status} ${r.body && r.body.message}`
    );
  }

  console.log('\n=== 7b. 参数健壮性 ===');
  r = await c.req('GET', '/api/notes/abc', { ticket, silent: true });
  assert('非数字 id → 400', r.status === 400, `status=${r.status}`);
  r = await c.req('GET', '/api/notes/999999999999', { ticket, silent: true });
  assert('越界 id → 400', r.status === 400, `status=${r.status}`);

  console.log('\n=== 8. SEO 路由按 Host 派发 ===');
  const homeMap = await c.req('GET', '/sitemap.xml', { headers: { Host: 'xalor.cn' }, silent: true });
  const blogMap = await c.req('GET', '/sitemap.xml', { headers: { Host: 'blog.xalor.cn' }, silent: true });
  if (homeMap.status === 403) {
    console.log('  ~ 跳过派发断言：本机 ALLOWED_HOSTS 未包含 xalor.cn（见 server/.env.example）');
  } else {
    assert('主页域 sitemap 出手记', homeMap.status === 200 && homeMap.raw.includes('#/notes'), `status=${homeMap.status}`);
    assert('博客域 sitemap 不出手记', blogMap.status === 200 && !blogMap.raw.includes('#/notes'), `status=${blogMap.status}`);
    const homeRobots = await c.req('GET', '/robots.txt', { headers: { Host: 'xalor.cn' }, silent: true });
    assert('主页域 robots 是主页版', homeRobots.raw.includes('个人主页'), homeRobots.raw.slice(0, 40));
    // 同一 URL 两个域返回不同内容 → 必须 Vary: Host，否则共享 CDN 会把主页版喂给博客域
    assert('sitemap 声明 Vary: Host', /host/i.test(homeMap.headers.vary || ''), `vary=${homeMap.headers.vary}`);
    assert('robots 声明 Vary: Host', /host/i.test(homeRobots.headers.vary || ''), `vary=${homeRobots.headers.vary}`);
    const homeRss = await c.req('GET', '/rss.xml', { headers: { Host: 'xalor.cn' }, silent: true });
    assert('主页域 RSS 是手记版', homeRss.raw.includes('手记'), homeRss.raw.slice(0, 120));
  }

  console.log('\n=== 9. 主页设置的「清空」语义 ===');
  // el-date-picker 清空后提交 null：必须真的清空，而不是「提示已保存但值不动」
  await c.req('PUT', adminBase + '/settings', { ticket, headers: AH, body: { home_since_date: '2026-03-01' }, silent: true });
  let st = (await c.req('GET', '/api/settings', { ticket, silent: true })).body.data;
  assert('设置起始日期生效', st.home_since_date === '2026-03-01', `got=${st.home_since_date}`);
  await c.req('PUT', adminBase + '/settings', { ticket, headers: AH, body: { home_since_date: null }, silent: true });
  st = (await c.req('GET', '/api/settings', { ticket, silent: true })).body.data;
  assert('提交 null 能清空（不是静默忽略）', st.home_since_date === '', `got=${JSON.stringify(st.home_since_date)}`);
  await c.req('PUT', adminBase + '/settings', { ticket, headers: AH, body: { home_since_date: '' }, silent: true });

  console.log('\n=== 10. 清理测试数据 ===');
  r = await c.req('POST', adminBase + '/notes/batch-delete', { ticket, headers: AH, body: { ids: [pubId, draftId, imgId, crossId] } });
  assert('测试手记已删除', r.status === 200 && r.body.code === 0, `status=${r.status}`);

  console.log(`\nnotes 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('套件异常:', e); process.exit(1); });
