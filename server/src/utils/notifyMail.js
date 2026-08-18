/**
 * 站长邮件通知（配置化）
 * 仅当设置了 SMTP 环境变量时启用；未配置则静默跳过，不影响功能。
 * 环境变量：
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / NOTIFY_EMAIL
 *   SMTP_SECURE=1  使用隐式 TLS（通常端口 465）
 *   SMTP_REQUIRE_TLS=0  显式关闭 STARTTLS 强制（默认开启，不推荐关闭）
 * 使用 nodemailer 收发，默认拒绝不加密的 SMTP 会话。
 */

const nodemailer = require('nodemailer');

const cfg = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  to: process.env.NOTIFY_EMAIL || '',
  secure: process.env.SMTP_SECURE === '1' || Number(process.env.SMTP_PORT) === 465,
  requireTls: process.env.SMTP_REQUIRE_TLS !== '0',
};

/** SMTP 凭据是否就绪（发送任何邮件的前提） */
function smtpReady() {
  const raw = `${cfg.host}|${cfg.user}|${cfg.pass}|${cfg.to}`;
  return !!(cfg.host && cfg.user && cfg.pass) && !/[\r\n]/.test(raw);
}

/** 站长通知是否启用（需配置收件人） */
function enabled() {
  return smtpReady() && !!cfg.to;
}

/** 校验收件人邮箱格式（防 SMTP 命令注入到 RCPT TO） */
function validRecipient(to) {
  return typeof to === 'string' && /^[^\s@<>]{1,64}@[^\s@<>]+\.[^\s@<>]{2,}$/.test(to);
}

/** SMTP 协议清洗：剥离 CR/LF，防评论/留言内容注入 SMTP 命令或伪造邮件 */
function sanitizeForSmtp(s) {
  // 清洗 CR/LF：防 SMTP 命令注入与 DATA 终止序列（正则须单行，\r \n 为转义序列）
  const flat = String(s).replace(/[\r\n]+/g, ' ').trim();
  // 折叠超长行：RFC 5322 要求行 ≤ 998 字符（含 CRLF），Postfix 等服务器
  // 直接拒绝超长行 → 邮件投递失败（此前防注入把换行压平后单行可达 2000 字符）。
  // 在 990 处断行（DATA 段内换行合法，语义无损）
  return flat.replace(/(.{990})/g, '$1\n').replace(/\n\s*/g, '\n').trim();
}

/**
 * 主题清洗 + 截断：RFC 2047 encoded-word 上限 75 字符（含 =?UTF-8?B??= 头尾 9 字符），
 * 内容 base64 上限 66 字符 ≈ 49.5 字节 → 按 UTF-8 字节截断到 45 字节
 * （≤15 个中文字符，恰好合规）；超长主题会导致部分客户端显示乱码或整体截断
 */
function safeSubject(s) {
  const flat = String(s).replace(/[\r\n]+/g, ' ').trim();
  const full = Buffer.from(flat, 'utf8');
  if (full.length <= 45) return flat;
  // 截前 45 字节；若末尾字符被截半（代理对/多字节），剥掉直至字节数合规
  let cut = full.subarray(0, 45).toString('utf8');
  while (Buffer.byteLength(cut) > 45) cut = cut.slice(0, -1);
  return cut;
}

/**
 * 发送邮件：强制 TLS/STARTTLS（默认），避免 SMTP 凭据与内容明文传输。
 * @param {string} subject 主题（自动清洗 + 截断）
 * @param {string} text 正文（自动清洗）
 * @param {string} [to] 自定义收件人；缺省发给站长（NOTIFY_EMAIL）
 */
function send(subject, text, to) {
  return new Promise((resolve) => {
    if (!smtpReady()) return resolve(false);
    // 收件人：优先自定义（须通过格式校验），否则回退站长邮箱
    const recipient = validRecipient(to) ? to : cfg.to;
    if (!validRecipient(recipient)) return resolve(false);

    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: cfg.requireTls,
      auth: { user: cfg.user, pass: cfg.pass },
    });

    transporter
      .sendMail({
        from: `"Xalor的小站" <${cfg.user}>`,
        to: recipient,
        subject: safeSubject(subject),
        text: sanitizeForSmtp(text),
      })
      .then(() => {
        transporter.close();
        resolve(true);
      })
      .catch(() => {
        transporter.close();
        resolve(false);
      });
  });
}

module.exports = { send, enabled, smtpReady, sanitizeForSmtp, safeSubject };
