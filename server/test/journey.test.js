/**
 * 全链路用户旅程验收测试
 * 模拟真实用户完整路径：浏览 → 阅读（解密）→ 评论 → 留言 → 友链 → 搜索 → 后台管理
 * 前置：干净 IP + 种子数据
 */
const c = require('./client');
const { decryptPayload } = require('../src/utils/crypto');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function suite() {
  const ticket = await c.getTicket();

  console.log('\n=== 1. 前台浏览 ===');
  let r = await c.req('GET', '/api/articles?page=1&pageSize=8', { ticket, silent: true });
  assert('首页文章列表', r.status === 200 && r.body.data.list.length > 0, `status=${r.status}`);
  r = await c.req('GET', '/api/stats/summary', { ticket, silent: true });
  assert('站点统计', r.status === 200 && r.body.data.total_pv >= 0, `status=${r.status}`);
  r = await c.req('GET', '/api/comments/recent', { ticket, silent: true });
  assert('最新评论', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/settings', { ticket, silent: true });
  // 服务器时区偏移必须存在（前端相对时间显示依赖它，缺失则跨时区访客显示偏差）
  assert('站点设置含时区偏移', r.status === 200 && typeof r.body.data.server_tz_offset_min === 'number', `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 2. 文章阅读（加密→解密） ===');
  r = await c.req('GET', '/api/articles/slug/welcome-to-xalor-blog', { ticket, silent: true });
  assert('详情返回加密正文', r.status === 200 && r.body.data.content_enc === true, `status=${r.status}`);
  const plain = decryptPayload(r.body.data.content, ticket);
  assert('票据可解密正文', !!plain && plain.includes('欢迎'), `len=${plain ? plain.length : 0}`);

  console.log('\n=== 3. 互动 ===');
  r = await c.formPost('/api/comments', { nickname: '旅程测试', content: '全链路验收评论', article_id: 1, email: '' }, ticket);
  assert('发表评论', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  r = await c.formPost('/api/messages', { nickname: '旅程测试', content: '留言板验收' }, ticket);
  assert('留言板', r.status === 200, `status=${r.status}`);
  r = await c.formPost('/api/links', { name: '验收站点', url: 'https://example.com', description: '测试' }, ticket);
  assert('友链申请', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 4. 发现 ===');
  r = await c.req('GET', '/api/articles?keyword=' + encodeURIComponent('Vue'), { ticket, silent: true });
  assert('关键词搜索', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/articles/archive', { ticket, silent: true });
  assert('归档', r.status === 200 && r.body.data.length > 0, `status=${r.status}`);
  r = await c.req('GET', '/api/tags', { ticket, silent: true });
  assert('标签云', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/categories', { ticket, silent: true });
  assert('分类', r.status === 200, `status=${r.status}`);

  console.log('\n=== 5. SEO/订阅通道 ===');
  r = await c.req('GET', '/api/rss.xml', { silent: true });
  assert('RSS', r.status === 200 && r.raw.includes('<item>'), `status=${r.status}`);
  r = await c.req('GET', '/api/sitemap.xml', { silent: true });
  assert('Sitemap', r.status === 200 && r.raw.includes('<urlset'), `status=${r.status}`);
  r = await c.req('GET', '/api/share/welcome-to-xalor-blog', { silent: true });
  assert('分享页', r.status === 200 && r.raw.includes('og:title'), `status=${r.status}`);

  console.log('\n=== 6. 后台管理 ===');
  const fp = 'a'.repeat(64);
  r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, ticket, headers: { 'X-Fp': fp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' } });
  assert('后台登录', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  const token = r.body.data.token;
  const path = (await c.req('GET', '/api/anti/admin-path', { ticket, silent: true })).body.data.path;
  const base = '/api/' + path;
  const ah = { Authorization: 'Bearer ' + token, 'X-Fp': fp };
  r = await c.req('GET', base + '/stats/dashboard', { ticket, headers: ah, silent: true });
  assert('仪表盘', r.status === 200 && r.body.data.total_articles > 0, `status=${r.status}`);
  r = await c.req('GET', base + '/security', { ticket, headers: ah, silent: true });
  assert('安全中心', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', base + '/audit/logs', { ticket, headers: ah, silent: true });
  assert('审计日志', r.status === 200, `status=${r.status}`);

  console.log('\n=== 7. 留言站长回复（全新建库列完整性回归） ===');
  const msgUniq = '回复测试' + Date.now().toString(36);
  r = await c.formPost('/api/messages', { nickname: '留言者', content: msgUniq }, ticket);
  assert('留言提交', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  r = await c.req('GET', base + '/messages/admin/list?keyword=' + msgUniq, { ticket, headers: ah, silent: true });
  const mid = r.body.data.list[0].id;
  r = await c.req('PUT', base + '/messages/' + mid + '/reply', { body: { reply: '站长已回复' }, ticket, headers: ah, silent: true });
  assert('站长回复', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  r = await c.req('GET', '/api/messages', { ticket, silent: true });
  const replied = r.body.data.list.find((m) => m.id === mid);
  assert('访客可见站长回复', !!replied && replied.reply === '站长已回复', JSON.stringify(replied));

  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
