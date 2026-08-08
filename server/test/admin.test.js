/**
 * 后台管理接口冒烟测试（认证 + 核心 CRUD + 导出/导入 + 安全中心）
 * 前置：干净 IP（未被封禁）+ 已 seed（admin/admin123）
 * 注意：本套件不含攻击载荷，不会触发封禁
 */
const c = require('./client');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function suite() {
  console.log('\n=== 1. 登录（票据 + 签名 + 指纹） ===');
  const ticket = await c.getTicket();
  const fp = 'a'.repeat(64);
  let r = await c.req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, ticket, headers: { 'X-Fp': fp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' } });
  assert('管理员登录成功', r.status === 200 && r.body && r.body.code === 0, `status=${r.status} ${r.body && r.body.message}`);
  const token = r.body.data.token;
  assert('JWT token 返回', !!token);

  console.log('\n=== 2. 指纹一致性（换指纹访问被拒） ===');
  const path = (await c.req('GET', '/api/anti/admin-path', { ticket, silent: true })).body.data.path;
  const adminBase = '/api/' + path;
  const authHeaders = { Authorization: 'Bearer ' + token, 'X-Fp': fp };
  // 换指纹后闸门票据校验先失败（403）；即使伪造新票据通过闸门，JWT 指纹比对也会 401
  r = await c.req('GET', adminBase + '/articles/admin/list', { ticket, headers: { Authorization: 'Bearer ' + token, 'X-Fp': 'c'.repeat(64) }, silent: true });
  assert('换指纹 → 401/403 拒绝', [401, 403].includes(r.status), `status=${r.status}`);

  console.log('\n=== 3. 无票据访问后台 → 403（闸门） ===');
  r = await c.req('GET', adminBase + '/articles/admin/list', { headers: authHeaders, silent: true });
  assert('无票据后台请求被拒', r.status === 403, `status=${r.status}`);

  console.log('\n=== 4. 后台列表接口 ===');
  r = await c.req('GET', adminBase + '/articles/admin/list', { ticket, headers: authHeaders, silent: true });
  assert('文章列表', r.status === 200 && r.body.data.pagination, `status=${r.status}`);
  r = await c.req('GET', adminBase + '/comments/admin/list', { ticket, headers: authHeaders, silent: true });
  assert('评论列表', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', adminBase + '/messages/admin/list', { ticket, headers: authHeaders, silent: true });
  assert('留言列表', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', adminBase + '/links/admin/list', { ticket, headers: authHeaders, silent: true });
  assert('友链列表', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', adminBase + '/stats/dashboard', { ticket, headers: authHeaders, silent: true });
  assert('仪表盘统计', r.status === 200 && r.body.data.total_articles >= 0, `status=${r.status}`);
  r = await c.req('GET', adminBase + '/security', { ticket, headers: authHeaders, silent: true });
  assert('安全中心', r.status === 200 && Array.isArray(r.body.data.banned), `status=${r.status}`);
  r = await c.req('GET', adminBase + '/audit/logs', { ticket, headers: authHeaders, silent: true });
  assert('审计日志', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', adminBase + '/uploads/list', { ticket, headers: authHeaders, silent: true });
  assert('上传文件列表', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', adminBase + '/articles/admin/export', { ticket, headers: authHeaders, silent: true });
  assert('文章导出（路由顺序修复回归）', r.status === 200 && r.body && r.body.meta && r.body.meta.type === 'articles-backup', `status=${r.status} ${r.status === 200 ? '' : JSON.stringify(r.body)}`);
  r = await c.req('GET', adminBase + '/settings/export', { ticket, headers: authHeaders, silent: true });
  assert('设置导出', r.status === 200, `status=${r.status}`);

  console.log('\n=== 5. 审计记录（登录已入账） ===');
  r = await c.req('GET', adminBase + '/audit/logs?keyword=LOGIN', { ticket, headers: authHeaders, silent: true });
  const auditRows = r.body && r.body.data ? r.body.data.list : [];
  assert('登录事件已审计', r.status === 200 && auditRows.some((a) => (a.action || '').includes('LOGIN')), `rows=${auditRows.length}`);

  console.log('\n=== 6. 前台公开接口（带票据） ===');
  r = await c.req('GET', '/api/articles', { ticket, silent: true });
  assert('文章列表', r.status === 200 && r.body.code === 0, `status=${r.status}`);
  r = await c.req('GET', '/api/categories', { ticket, silent: true });
  assert('分类列表', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/tags', { ticket, silent: true });
  assert('标签列表', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/stats/summary', { ticket, silent: true });
  assert('统计摘要', r.status === 200, `status=${r.status}`);
  r = await c.req('GET', '/api/settings', { ticket, silent: true });
  assert('站点设置', r.status === 200 && r.body.data.site_name, `status=${r.status}`);
  r = await c.req('GET', '/api/rss.xml', { silent: true });
  assert('RSS 公开可访问', r.status === 200 && r.raw.includes('<rss'), `status=${r.status}`);
  r = await c.req('GET', '/api/sitemap.xml', { silent: true });
  assert('Sitemap 公开可访问', r.status === 200 && r.raw.includes('<urlset'), `status=${r.status}`);

  console.log('\n=== 7. 文章详情（正文加密） ===');
  r = await c.req('GET', '/api/articles/slug/welcome-to-xalor-blog', { ticket, silent: true });
  assert('文章详情', r.status === 200 && r.body.data.content_enc === true, `status=${r.status} ${r.body && r.body.message}`);
  // 无票据时正文应为空（不泄露）
  r = await c.req('GET', '/api/articles/slug/welcome-to-xalor-blog', { silent: true });
  assert('无票据详情被闸门拒（正文不泄露）', r.status === 403, `status=${r.status}`);

  console.log('\n=== 8. PV 防刷（10 秒窗口内只计一次） ===');
  r = await c.req('POST', '/api/stats/record', { body: {}, ticket, headers: { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' } });
  const first = r.body && r.body.data;
  r = await c.req('POST', '/api/stats/record', { body: {}, ticket, headers: { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' } });
  const second = r.body && r.body.data;
  assert('首次 PV 计入', r.status === 200 && first && first.pv_counted === true, `status=${r.status} ${JSON.stringify(first)}`);
  assert('10 秒内重复 PV 不计入', second && second.pv_counted === false, JSON.stringify(second));

  console.log('\n=== 9. 文章 CRUD 闭环（创建→发布→前台可见→更新→删除） ===');
  const uniq = Date.now().toString(36);
  const title = `测试文章 ${uniq}`;
  // 创建草稿
  r = await c.req('POST', adminBase + '/articles', { body: { title, content: '# 标题\n\n正文内容', status: 'draft' }, ticket, headers: authHeaders, silent: true });
  assert('创建草稿', r.status === 200 && r.body.data && r.body.data.id > 0, `status=${r.status} ${r.body && r.body.message}`);
  const aid = r.body.data.id;
  // 草稿不应出现在前台
  r = await c.req('GET', '/api/articles?keyword=' + encodeURIComponent(title), { ticket, silent: true });
  assert('草稿前台不可见', r.status === 200 && r.body.data.list.length === 0, `status=${r.status} count=${r.body.data && r.body.data.list.length}`);
  // 发布
  r = await c.req('PUT', adminBase + '/articles/' + aid, { body: { status: 'published' }, ticket, headers: authHeaders, silent: true });
  assert('发布文章', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  // 前台可见 + 正文加密
  r = await c.req('GET', '/api/articles?keyword=' + encodeURIComponent(title), { ticket, silent: true });
  assert('发布后前台可见', r.status === 200 && r.body.data.list.length >= 1, `status=${r.status}`);
  const slug = r.body.data.list[0].slug;
  r = await c.req('GET', '/api/articles/slug/' + slug, { ticket, silent: true });
  assert('详情正文加密', r.status === 200 && r.body.data.content_enc === true, `status=${r.status}`);
  // 更新标题
  const title2 = `测试文章已更新 ${uniq}`;
  r = await c.req('PUT', adminBase + '/articles/' + aid, { body: { title: title2 }, ticket, headers: authHeaders, silent: true });
  assert('更新文章', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  // 删除
  r = await c.req('DELETE', adminBase + '/articles/' + aid, { ticket, headers: authHeaders, silent: true });
  assert('删除文章', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  // 删除后前台不可见
  r = await c.req('GET', '/api/articles?keyword=' + encodeURIComponent(title2), { ticket, silent: true });
  assert('删除后前台不可见', r.status === 200 && r.body.data.list.length === 0, `status=${r.status}`);

  console.log('\n=== 10. 上传安全（magic bytes + SVG 扫描） ===');
  // 合法 PNG（1x1 透明像素）
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72b51c80000000049454e44ae426082', 'hex');
  r = await c.uploadFile(adminBase + '/upload', png, 'test.png', 'image/png', ticket, authHeaders);
  assert('合法 PNG 上传成功', r.status === 200 && r.body && r.body.data && r.body.data.url, `status=${r.status} ${r.body && r.body.message}`);
  const upUrl = r.body.data.url;
  // 静态访问上传文件
  r = await c.req('GET', upUrl, { headers: { 'User-Agent': c.UA }, silent: true });
  assert('上传文件可访问', r.status === 200, `status=${r.status}`);
  // 伪造扩展名：PNG 内容 + .jpg 扩展名（magic bytes 校验应拒绝）
  r = await c.uploadFile(adminBase + '/upload', png, 'fake.jpg', 'image/jpeg', ticket, authHeaders);
  assert('伪造扩展名被拒', r.status === 400, `status=${r.status} ${r.body && r.body.message}`);
  // 危险 SVG（内嵌脚本）被拒
  const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  r = await c.uploadFile(adminBase + '/upload', evilSvg, 'evil.svg', 'image/svg+xml', ticket, authHeaders);
  assert('危险 SVG 被拒', r.status === 400, `status=${r.status} ${r.body && r.body.message}`);
  // 非图片扩展名被拒
  const php = Buffer.from('<?php echo 1; ?>');
  r = await c.uploadFile(adminBase + '/upload', php, 'shell.php', 'application/x-php', ticket, authHeaders);
  assert('PHP 文件被拒', r.status === 400, `status=${r.status} ${r.body && r.body.message}`);
  // 清理上传的测试文件
  const fname = upUrl.split('/').pop();
  r = await c.req('DELETE', adminBase + '/uploads/' + fname, { ticket, headers: authHeaders, silent: true });
  assert('清理测试上传文件', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 11. 设置备份往返（导出→改→导入→恢复） ===');
  const origName = (await c.req('GET', '/api/settings', { ticket, silent: true })).body.data.site_name;
  await c.req('PUT', adminBase + '/settings', { body: { site_name: '备份测试站' }, ticket, headers: authHeaders, silent: true });
  r = await c.req('GET', adminBase + '/settings/export', { ticket, headers: authHeaders, silent: true });
  assert('设置导出（原始 JSON 格式）', r.status === 200 && r.body.site_name === '备份测试站', `status=${r.status}`);
  const backup = r.body;
  await c.req('PUT', adminBase + '/settings', { body: { site_name: origName }, ticket, headers: authHeaders, silent: true });
  r = await c.req('POST', adminBase + '/settings/import', { body: backup, ticket, headers: authHeaders, silent: true });
  assert('设置导入', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  r = await c.req('GET', '/api/settings', { ticket, silent: true });
  assert('设置恢复验证', r.body.data.site_name === '备份测试站', `got=${r.body.data.site_name}`);
  await c.req('PUT', adminBase + '/settings', { body: { site_name: origName }, ticket, headers: authHeaders, silent: true });

  console.log(`\n===== 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
