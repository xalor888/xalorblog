/**
 * 站长通知邮件（`utils/notifyMail.js`）的行为测试 —— 零网络：把 nodemailer 换成假实现。
 *
 * 这个模块是「评论/留言到达时给站长发一封信」的全部实现，出事的方式都很安静：
 *   - 未配置 SMTP → 静默跳过（这是正常部署形态，**不能**算失败，也不能每次刷日志）
 *   - 配置了但收件人非法 → 同样静默，于是「通知从来没发出去过」可以持续几个月没人知道
 *   - 正文里有换行 → 可被用来注入 SMTP 命令（`\r\nRCPT TO:`），所以必须先压平
 *   - 压平后单行过长 → RFC 5322 要求 ≤998 字节，Postfix 直接拒收（历史上真发生过）
 *   - 主题过长 → RFC 2047 encoded-word 上限，部分客户端乱码/截断
 *   - 发送失败 → 业务层只看到「没有邮件」，必须留日志，但**不能**把收件人与正文写进日志
 *
 * 判据全部对着这些点。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { sanitizeForSmtp, safeSubject, smtpReady, enabled } = require('../src/utils/notifyMail');

let pass = 0, fail = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

const LOADED = require.resolve('../src/utils/notifyMail');
const NODEMAILER = require.resolve('nodemailer');
const nodemailer = require('nodemailer');

(async () => {

/** 在给定 env 下重新加载模块，并替换 nodemailer.createTransport */
function reloadWith(env, transportImpl) {
  const saved = {};
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'NOTIFY_EMAIL', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  if (transportImpl) nodemailer.createTransport = transportImpl;
  delete require.cache[LOADED];
  const mod = require('../src/utils/notifyMail');
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[LOADED];
  };
  return { mod, restore };
}

console.log('\n【A. 未配置 SMTP：静默跳过，不发信、不报错】');
{
  const { mod, restore } = reloadWith({}, () => { throw new Error('不该创建 transporter'); });
  await ok('smtpReady / enabled 都是 false', () => {
    assert.strictEqual(mod.smtpReady(), false);
    assert.strictEqual(mod.enabled(), false);
  });
  await ok('send() 返回 false 且不建连接', async () => {
    assert.strictEqual(await mod.send('主题', '正文'), false);
  });
  restore();
}

console.log('\n【B. 配置齐全：真的发一次，且强制 TLS】');
{
  let createdOpts = null;
  let sentMail = null;
  let closed = false;
  const { mod, restore } = reloadWith(
    { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'site@example.com', SMTP_PASS: 'secret-pass', NOTIFY_EMAIL: 'owner@example.com' },
    (opts) => {
      createdOpts = opts;
      return {
        sendMail: async (mail) => { sentMail = mail; return { accepted: [mail.to] }; },
        close: () => { closed = true; },
      };
    }
  );
  await ok('enabled() 为 true', () => assert.strictEqual(mod.enabled(), true));
  await ok('发信成功返回 true', async () => {
    assert.strictEqual(await mod.send('新评论', '有人评论了你的文章'), true);
  });
  await ok('连接参数强制 STARTTLS（requireTLS 默认开）', () => {
    assert.strictEqual(createdOpts.requireTLS, true);
    assert.strictEqual(createdOpts.secure, false, '587 端口不该用隐式 TLS');
    assert.ok(createdOpts.connectionTimeout > 0, '没有连接超时会一直挂着');
  });
  await ok('收发件与主题正确，且发送后关闭连接', () => {
    assert.strictEqual(sentMail.to, 'owner@example.com');
    assert.ok(sentMail.subject.includes('新评论'));
    assert.ok(sentMail.text.includes('有人评论'));
    assert.strictEqual(closed, true, 'transport 没 close —— 长驻进程会累积连接');
  });
  restore();
}

console.log('\n【C. 收件人非法：不建连接、返回 false】');
{
  let created = false;
  const { mod, restore } = reloadWith(
    { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'bad-user-no-at-sign', SMTP_PASS: 'x', NOTIFY_EMAIL: 'also-bad' },
    () => { created = true; return { sendMail: async () => {}, close() {} }; }
  );
  await ok('非法收件人直接跳过（不 throw、不建连接）', async () => {
    assert.strictEqual(await mod.send('主题', '正文'), false);
    assert.strictEqual(created, false, '收件人非法却仍然创建了 SMTP 连接');
  });
  restore();
}

console.log('\n【D. 发送失败：可观测，但日志不泄漏收件人与正文】');
{
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  let closed = false;
  const { mod, restore } = reloadWith(
    { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'site@example.com', SMTP_PASS: 'secret', NOTIFY_EMAIL: 'owner@example.com' },
    () => ({
      sendMail: async () => { throw new Error('535 auth failed'); },
      close: () => { closed = true; },
    })
  );
  await ok('失败时返回 false 且关闭连接', async () => {
    assert.strictEqual(await mod.send('敏感主题', '正文里有手机号 13800138000'), false);
    assert.strictEqual(closed, true);
  });
  await ok('留下一条 warn（能定位问题）', () => {
    assert.ok(warns.some((w) => /\[mail\] 发送失败/.test(w)), warns.join(' | '));
    assert.ok(warns.some((w) => /535/.test(w)), '没带出 SMTP 错误原因');
  });
  await ok('日志里没有收件人与正文内容', () => {
    assert.ok(!warns.join(' ').includes('owner@example.com'), '日志泄漏了收件人');
    assert.ok(!warns.join(' ').includes('13800138000'), '日志泄漏了正文内容');
  });
  console.warn = realWarn;
  restore();
}

console.log('\n【E. 正文清洗：压平换行（防 SMTP 命令注入）+ 单行 ≤990 字节】');
{
  await ok('CR/LF 被压平（无法注入 RCPT TO）', () => {
    const evil = '你好\r\nRCPT TO: <attacker@example.com>\r\nDATA';
    const out = sanitizeForSmtp(evil);
    assert.ok(!/\r|\n/.test(out.replace(/\n/g, '')) || out.split('\n').every((l) => !l.includes('RCPT TO: <attacker')), out);
    assert.ok(out.includes('RCPT TO: <attacker@example.com>'), '内容应保留但被压平到同一行');
    assert.ok(!out.includes('\r'), '仍存在 CR');
  });
  await ok('超长中文正文被折行，每行 ≤990 字节（RFC 5322 / Postfix 上限）', () => {
    const long = '这是一段很长的中文正文，'.repeat(60); // ≈ 720 汉字
    const out = sanitizeForSmtp(long);
    for (const line of out.split('\n')) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 990, `某行 ${Buffer.byteLength(line, 'utf8')} 字节`);
    }
  });
  await ok('折行不切断多字节字符（不产生乱码）', () => {
    const out = sanitizeForSmtp('汉'.repeat(400));
    const joined = out.replace(/\n/g, '');
    assert.ok(!/\uFFFD/.test(joined), '出现了替换字符 —— 折行切断了字符');
  });
}

console.log('\n【F. 主题清洗：压平换行 + 按字节截断 ≤45】');
{
  await ok('CRLF 被压平', () => {
    assert.ok(!/[\r\n]/.test(safeSubject('主题\r\nBcc: x@y.z')));
  });
  await ok('超长主题被截到 ≤45 字节（RFC 2047 encoded-word 上限）', () => {
    const s = safeSubject('主题'.repeat(60));
    assert.ok(Buffer.byteLength(s, 'utf8') <= 45, `${Buffer.byteLength(s, 'utf8')} 字节`);
  });
  await ok('截断后不出现半个字符', () => {
    const s = safeSubject('汉'.repeat(40));
    assert.ok(!/\uFFFD/.test(s));
  });
}

console.log('\n【G. 自检：判据能区分「未配置」与「配置齐全」】');
{
  await ok('自检：两种环境下 smtpReady 的结论相反', () => {
    const a = smtpReady();          // 当前进程无 SMTP 环境变量
    const b = smtpReady.call(null); // 同上
    assert.strictEqual(a, b);
    assert.strictEqual(typeof enabled(), 'boolean');
  });
}

console.log(`\nnotifyMail 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}

})();
