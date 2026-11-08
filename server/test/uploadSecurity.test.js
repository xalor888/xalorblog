/**
 * 上传安全的**行为验证**（前一版只测了工具函数，没测过路由）。
 *
 * 上传是唯一「用户能把任意字节送进服务器磁盘」的入口，所以三条防线必须在路由层成立：
 *   1. 扩展名白名单（`.php` / `.exe` 等直接拒）
 *   2. magic bytes（扩展名说自己是 PNG，内容却是脚本 → 拒）
 *   3. SVG 全文扫描（`<script>` / `onload=` / 外部实体 → 拒；干净的 SVG 放行）
 * 另外两条工程性质：
 *   4. 落地文件名由服务端生成（原始文件名**不得**进入磁盘路径，否则就是穿越/覆盖/可预测）
 *   5. 拒绝时不留文件
 *
 * 前置：已 seed（admin/admin123）+ 干净 IP + DB_NAME 以 `_scratch` 结尾。
 */

const c = require('./client');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

/** 真实 1×1 PNG（89 50 4E 47 …），用于「正当上传必须成功」那一条 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

async function suite() {
  const ticket = await c.getTicket();
  const fp = 'a'.repeat(64);
  let r = await c.req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
    ticket,
    headers: { 'X-Fp': fp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' },
  });
  const token = r.body && r.body.data && r.body.data.token;
  r = await c.req('GET', '/api/anti/admin-path', { ticket, silent: true });
  const adminBase = '/api/' + (r.body && r.body.data && r.body.data.path);
  const authHeaders = { Authorization: 'Bearer ' + token, 'X-Fp': fp };
  assert('管理员登录 + 后台路径', !!token && !!adminBase, `status=${r.status}`);

  const uploadUrl = adminBase + '/upload';
  const created = [];

  console.log('\n=== 1. 扩展名白名单 ===');
  r = await c.uploadFile(uploadUrl, Buffer.from('<?php system($_GET[0]); ?>'), 'shell.php', 'image/png', ticket, authHeaders);
  assert('上传 .php 被拒', r.status !== 200, `status=${r.status} ${r.body && r.body.message}`);

  r = await c.uploadFile(uploadUrl, Buffer.from('MZ'), 'evil.exe', 'image/png', ticket, authHeaders);
  assert('上传 .exe 被拒', r.status !== 200, `status=${r.status}`);

  console.log('\n=== 2. magic bytes（扩展名撒谎） ===');
  r = await c.uploadFile(uploadUrl, Buffer.from('<?php echo 1; ?>'), 'fake.png', 'image/png', ticket, authHeaders);
  assert('内容不是 PNG 却叫 .png → 被拒', r.status !== 200, `status=${r.status} ${r.body && r.body.message}`);

  console.log('\n=== 3. SVG：干净放行、带脚本拒绝 ===');
  const cleanSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>');
  r = await c.uploadFile(uploadUrl, cleanSvg, 'clean.svg', 'image/svg+xml', ticket, authHeaders);
  assert('干净 SVG 通过', r.status === 200 && r.body && r.body.code === 0, `status=${r.status} ${r.body && r.body.message}`);
  if (r.status === 200 && r.body.data) created.push(r.body.data.filename);

  const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  r = await c.uploadFile(uploadUrl, evilSvg, 'evil.svg', 'image/svg+xml', ticket, authHeaders);
  assert('带 <script> 的 SVG 被拒', r.status !== 200, `status=${r.status} ${r.body && r.body.message}`);

  const smilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onload" to="alert(1)"/></svg>');
  r = await c.uploadFile(uploadUrl, smilSvg, 'smil.svg', 'image/svg+xml', ticket, authHeaders);
  assert('SMIL 事件变体（attributeName="on…"）被拒', r.status !== 200, `status=${r.status}`);

  const xxeSvg = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>');
  r = await c.uploadFile(uploadUrl, xxeSvg, 'xxe.svg', 'image/svg+xml', ticket, authHeaders);
  assert('SVG 外部实体（XXE）被拒', r.status !== 200, `status=${r.status}`);

  console.log('\n=== 4. 落地文件名由服务端生成 ===');
  r = await c.uploadFile(uploadUrl, PNG_1X1, '../../../evil.png', 'image/png', ticket, authHeaders);
  assert('带路径穿越的原始文件名仍能上传（改名后）', r.status === 200, `status=${r.status} ${r.body && r.body.message}`);
  if (r.status === 200 && r.body.data) {
    const fname = r.body.data.filename;
    created.push(fname);
    const url = r.body.data.url;
    assert('返回的 url 不含 .. 或原始文件名', !url.includes('..') && !url.includes('evil'), url);
    assert('落地文件名是「时间戳 + 随机 hex」形态（不可预测）', /^\d{8,}-\d{4,}[0-9a-f]*\.png$/i.test(fname)
      || /^\d{6,}-[0-9a-f]{8,}\.png$/i.test(fname), fname);
    const onDisk = path.join(UPLOAD_DIR, fname);
    assert('文件落在 uploads/ 下且名字与返回的一致', fs.existsSync(onDisk), onDisk);
  }

  console.log('\n=== 5. 拒绝时不留文件 ===');
  {
    const before = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0;
    r = await c.uploadFile(uploadUrl, Buffer.from('not-an-image'), 'nope.png', 'image/png', ticket, authHeaders);
    const after = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0;
    assert('被拒的上传没有留下文件', after === before, `before=${before} after=${after} status=${r.status}`);
  }

  console.log('\n=== 6. 正当上传可用 ===');
  r = await c.uploadFile(uploadUrl, PNG_1X1, 'photo.png', 'image/png', ticket, authHeaders);
  assert('真实 PNG 上传成功', r.status === 200 && r.body && r.body.code === 0, `status=${r.status} ${r.body && r.body.message}`);
  if (r.status === 200 && r.body.data) created.push(r.body.data.filename);

  // 清理本次造的文件（不留垃圾在 uploads/）
  for (const f of created) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch (_) { /* ignore */ }
  }
  console.log(`   （已清理 ${created.length} 个测试文件）`);

  console.log(`\nuploadSecurity 套件结果: ${passed} 通过, ${failed} 失败`);
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
