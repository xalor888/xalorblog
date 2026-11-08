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

/**
 * 按 UTF-8 **字节**折行到 maxBytes 以内（遇到多字节字符整字前移，不切半个字符）。
 * 为什么不能按字符折行：RFC 5322 的 998 是**字节**上限（octets），
 * 而中文 UTF-8 一个字符占 3 字节 —— 按字符每 990 断行，
 * 一行 990 个汉字就是 2970 字节，Postfix 等 MTA 会直接回 500 Line too long，
 * 评论/留言通知邮件整封投递失败。实测 360 个汉字的正文折完仍是一行 1080 字节。
 */
const SMTP_LINE_BYTES = 990; // 留 8 字节余量给 CRLF 与编码开销

function foldByBytes(text, maxBytes = SMTP_LINE_BYTES) {
  const out = [];
  let line = '';
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes && line) {
      out.push(line);
      line = '';
      bytes = 0;
    }
    line += ch;
    bytes += n;
  }
  if (line) out.push(line);
  return out.join('\n');
}

/** SMTP 协议清洗：剥离 CR/LF，防评论/留言内容注入 SMTP 命令或伪造邮件 */
function sanitizeForSmtp(s) {
  // 清洗 CR/LF：防 SMTP 命令注入与 DATA 终止序列（正则须单行，\r \n 为转义序列）
  const flat = String(s).replace(/[\r\n]+/g, ' ').trim();
  // 折叠超长行：RFC 5322 要求行 ≤ 998 字节（含 CRLF），Postfix 等服务器
  // 直接拒绝超长行 → 邮件投递失败（此前防注入把换行压平后单行可达 2000 字符）。
  // 按 UTF-8 字节折行，中文一行 330 字以内（≈990 字节），ASCII 仍是 990 字符。
  return foldByBytes(flat).replace(/\n\s*/g, '\n').trim();
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

/** 未配置 SMTP 时的「跳过」提示只记一次（模块级标记），避免每次评论都刷日志 */
let loggedNotConfigured = false;
/** 配置了 SMTP 但收件人不可用同样只记一次（配置错误，不是运行时噪声） */
let loggedBadRecipient = false;

/**
 * 发送邮件：强制 TLS/STARTTLS（默认），避免 SMTP 凭据与内容明文传输。
 * @param {string} subject 主题（自动清洗 + 截断）
 * @param {string} text 正文（自动清洗）
 * @param {string} [to] 自定义收件人；缺省发给站长（NOTIFY_EMAIL）
 */
function send(subject, text, to) {
  return new Promise((resolve) => {
    if (!smtpReady()) {
      // 「未配置 SMTP 而跳过」是正常部署形态（本地开发 / 未启用通知），用 debug 级
      // 且只记一次：与下面「配置了但发送失败」的 warn 在级别和措辞上都能区分开，
      // 既不刷屏，也不会再让「根本没配」和「配了发不出去」在日志里长得一样。
      if (!loggedNotConfigured) {
        loggedNotConfigured = true;
        console.debug('[mail] SMTP 未配置，通知邮件已跳过（本进程仅提示一次）');
      }
      return resolve(false);
    }
    // 收件人：优先自定义（须通过格式校验），其次站长邮箱，最后回退 SMTP 用户名
    let recipient = validRecipient(to) ? to : cfg.to;
    if (!validRecipient(recipient) && validRecipient(cfg.user)) recipient = cfg.user;
    if (!validRecipient(recipient)) {
      // 配了 SMTP 却没有一个合法收件人：静默 false 会让「通知从来没发出过」无从察觉
      if (!loggedBadRecipient) {
        loggedBadRecipient = true;
        console.warn('[mail] 收件人地址无效（NOTIFY_EMAIL / SMTP_USER），通知邮件已跳过；本进程仅提示一次');
      }
      return resolve(false);
    }

    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: cfg.requireTls,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
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
      .catch((err) => {
        transporter.close();
        // 发送失败必须可观测：原来 catch 里只 resolve(false)，SMTP 认证失败 / 被拒信 /
        // 超时在业务层全部表现为「没收到邮件」，线上完全无法定位。
        // 只记错误信息（类别 + 原因），**不打印收件人与正文** —— 日志会外泄隐私。
        console.warn('[mail] 发送失败:', err && err.message);
        resolve(false);
      });
  });
}

module.exports = { send, enabled, smtpReady, sanitizeForSmtp, safeSubject };
