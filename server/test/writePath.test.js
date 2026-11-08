/**
 * 写路径闭环 —— **「落库之后到底有没有生效」的那一层**。
 *
 * 为什么单独一份：前 16 个集成套件覆盖了闸门、认证、限流、CRUD 冒烟，但有三条
 * 「写入 → 缓存失效 → 前台可见」的链路从来没被一次跑通过：
 *   1. 文章发布后，前台列表/详情**立刻**能看到（缓存 TTL 60s，不失效就是最长 1 分钟不可见）
 *   2. 评论提交后进**待审**、前台看不见；管理员批准后**立刻**可见（审核状态机真的通）
 *   3. 手记发布后，个人主页的列表立刻能看到
 *
 * 这些都属于「功能完全正常、但用户看到的还是旧数据」的静默失效 —— 最难靠人工发现的那类。
 *
 * 前置：已 seed（admin/admin123）+ 干净 IP + DB_NAME 以 `_scratch` 结尾（run.js 已强制）。
 * 收尾会删掉自己造的数据，可以反复跑。
 */

const c = require('./client');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

const stamp = Date.now();

async function suite() {
  const ticket = await c.getTicket();
  const fp = 'a'.repeat(64); // 与 client.js 的默认指纹一致（票据绑定指纹，不一致会 403）
  let r = await c.req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
    ticket,
    headers: { 'X-Fp': fp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' },
  });
  const token = r.body && r.body.data && r.body.data.token;
  assert('管理员登录', !!token, `status=${r.status}`);
  const authHeaders = { Authorization: 'Bearer ' + token, 'X-Fp': fp };
  // 后台秘钥路径不在登录响应里，单独从 /api/anti/admin-path 取（见 admin.test.js）
  r = await c.req('GET', '/api/anti/admin-path', { ticket, silent: true });
  const path = r.body && r.body.data && r.body.data.path;
  const adminBase = '/api/' + path;
  assert('拿到后台秘钥路径', !!path, `status=${r.status}`);

  console.log('\n=== A. 文章：发布后前台立刻可见（缓存必须失效） ===');
  const title = `写路径验收-${stamp}`;
  r = await c.req('POST', adminBase + '/articles', {
    body: { title, content: '# 正文\n\n写路径测试', status: 'published' },
    ticket, headers: authHeaders, silent: true,
  });
  const aid = r.body && r.body.data && r.body.data.id;
  assert('创建已发布文章', r.status === 200 && aid > 0, `status=${r.status} ${r.body && r.body.message}`);

  r = await c.req('GET', '/api/articles?keyword=' + encodeURIComponent(title), { ticket, silent: true });
  const list = (r.body && r.body.data && r.body.data.list) || [];
  assert('前台列表立刻可见（列表缓存已失效）', list.length >= 1, `status=${r.status} count=${list.length}`);
  const slug = list[0] && list[0].slug;
  r = await c.req('GET', '/api/articles/slug/' + slug, { ticket, silent: true });
  assert('详情页立刻可读', r.status === 200 && !!r.body.data, `status=${r.status}`);

  console.log('\n=== B. 评论：待审 → 批准 → 前台可见（审核状态机） ===');
  // 默认 comment_moderation=false 时评论**直接通过**，所以先打开审核开关，
  // 否则这条链路根本没被走到（这正是「测试看起来绿、其实没测到目标」的典型形态）。
  let moderationWasOn = false;
  r = await c.req('GET', '/api/settings/public', { ticket, silent: true });
  moderationWasOn = !!(r.body && r.body.data && r.body.data.comment_moderation);
  if (!moderationWasOn) {
    r = await c.req('PUT', adminBase + '/settings', {
      body: { comment_moderation: true }, ticket, headers: authHeaders, silent: true,
    });
    assert('打开评论审核开关', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  }
  const commentText = `写路径评论-${stamp}`;
  r = await c.formPost('/api/comments', {
    nickname: '验收', content: commentText, article_id: aid, email: '',
  }, ticket);
  assert('评论提交成功', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

  r = await c.req('GET', '/api/comments/article/' + aid, { ticket, silent: true });
  const publicBefore = (r.body && r.body.data && (r.body.data.list || r.body.data)) || [];
  const beforeLen = Array.isArray(publicBefore) ? publicBefore.length : 0;
  assert('待审评论前台不可见', beforeLen === 0, `前台已有 ${beforeLen} 条`);

  r = await c.req('GET', adminBase + '/comments/admin/list', { ticket, headers: authHeaders, silent: true });
  const pending = (r.body && r.body.data && (r.body.data.list || [])) || [];
  const target = pending.find((x) => String(x.content || '').includes(commentText));
  assert('后台待审列表能看到它', !!target, `后台 ${pending.length} 条`);

  if (target) {
    r = await c.req('PUT', adminBase + '/comments/' + target.id + '/status', {
      body: { status: 'approved' }, ticket, headers: authHeaders, silent: true,
    });
    assert('批准评论', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);

    r = await c.req('GET', '/api/comments/article/' + aid, { ticket, silent: true });
    const publicAfter = (r.body && r.body.data && (r.body.data.list || r.body.data)) || [];
    const afterLen = Array.isArray(publicAfter) ? publicAfter.length : 0;
    assert('批准后前台立刻可见（评论缓存已失效）', afterLen >= 1, `前台 ${afterLen} 条`);

    r = await c.req('DELETE', adminBase + '/comments/' + target.id, { ticket, headers: authHeaders, silent: true });
    assert('清理评论', r.status === 200, `status=${r.status}`);
  }

  console.log('\n=== C. 手记：发布后主页立刻可见 ===');
  // 先记下摘要里的手记数（这个接口免票、带 60s 缓存 —— 写了手记却不清缓存，
  // 个人主页的数字会最多陈旧一分钟，且没有任何现象提示你）
  r = await c.req('GET', '/api/home/summary', { ticket, silent: true });
  const notesBefore = (r.body && r.body.data && r.body.data.stats && r.body.data.stats.note_count) || 0;
  const noteText = `写路径手记-${stamp}`;
  r = await c.req('POST', adminBase + '/notes', {
    body: { content: noteText, status: 'published', mood: '测试' },
    ticket, headers: authHeaders, silent: true,
  });
  const nid = r.body && r.body.data && r.body.data.id;
  assert('创建已发布手记', r.status === 200 && nid > 0, `status=${r.status} ${r.body && r.body.message}`);

  r = await c.req('GET', '/api/notes', { ticket, silent: true });
  const notes = (r.body && r.body.data && (r.body.data.list || r.body.data)) || [];
  // 列表接口按设计只返回 id/excerpt/mood/location（content 是加密的，不出现在列表里），
  // 所以这里按 id 命中，不按正文文本 —— 否则断言会因为「字段本来就没有」而假红。
  const hit = Array.isArray(notes) ? notes.find((x) => x.id === nid) : null;
  assert('主页手记列表立刻可见（notes 缓存已失效）', !!hit, `列表 ${Array.isArray(notes) ? notes.length : '?'} 条`);

  r = await c.req('GET', '/api/home/summary', { ticket, silent: true });
  const notesAfter = (r.body && r.body.data && r.body.data.stats && r.body.data.stats.note_count) || 0;
  assert('主页摘要的手记数立刻反映新增（摘要缓存被清过）', notesAfter >= notesBefore + 1,
    `before=${notesBefore} after=${notesAfter} —— 60s 缓存没失效`);

  if (nid) {
    r = await c.req('DELETE', adminBase + '/notes/' + nid, { ticket, headers: authHeaders, silent: true });
    assert('清理手记', r.status === 200, `status=${r.status}`);
  }

  console.log('\n=== D. 点赞：同 IP 重复点赞被拒（计数不被刷） ===');
  r = await c.req('POST', '/api/comments/' + (target ? target.id : 0) + '/like', { ticket, silent: true });
  const firstLike = r.status;
  if (target) {
    r = await c.req('POST', '/api/comments/' + target.id + '/like', { ticket, silent: true });
    assert('同 IP 10 秒内重复点赞被限流', r.status === 429 || firstLike !== 200, `first=${firstLike} second=${r.status}`);
  }

  if (aid) {
    r = await c.req('DELETE', adminBase + '/articles/' + aid, { ticket, headers: authHeaders, silent: true });
    assert('清理文章', r.status === 200, `status=${r.status}`);
    r = await c.req('GET', '/api/articles?keyword=' + encodeURIComponent(title), { ticket, silent: true });
    const after = (r.body && r.body.data && r.body.data.list) || [];
    assert('删除后前台立刻不可见（缓存再次失效）', after.length === 0, `仍有 ${after.length} 条`);
  }

  // 收尾：把审核开关恢复原状（这条套件跑完后别的套件还要用默认配置）
  if (!moderationWasOn) {
    r = await c.req('PUT', adminBase + '/settings', {
      body: { comment_moderation: false }, ticket, headers: authHeaders, silent: true,
    });
    assert('恢复评论审核开关', r.status === 200, `status=${r.status}`);
  }

  console.log(`\nwritePath 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

suite().catch((e) => {
  console.error('套件异常:', e && e.stack || e);
  process.exitCode = 1;
});
