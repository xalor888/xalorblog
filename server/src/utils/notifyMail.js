/**
 * 站长邮件通知（配置化）
 * 仅当设置了 SMTP 环境变量时启用；未配置则静默跳过，不影响功能。
 * 环境变量：
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / NOTIFY_EMAIL
 * 使用 Node 内置 net 模块实现最小化 SMTP 发送，不依赖 nodemailer。
 */

const net = require('net');

const cfg = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  to: process.env.NOTIFY_EMAIL || '',
};

/** SMTP 凭据是否就绪（发送任何邮件的前提） */
function smtpReady() {
  return !!(cfg.host && cfg.user && cfg.pass);
}

/** 站长通知是否启用（需配置收件人） */
function enabled() {
  return smtpReady() && !!cfg.to;
}

/** 校验收件人邮箱格式（防 SMTP 命令注入到 RCPT TO） */
function validRecipient(to) {
  return typeof to === 'string' && /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/.test(to);
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
 * 简单 SMTP 发送（STARTTLS 前 AUTH LOGIN）
 * @param {string} subject 主题（自动清洗 + UTF-8 编码）
 * @param {string} text 正文（自动清洗）
 * @param {string} [to] 自定义收件人；缺省发给站长（NOTIFY_EMAIL）
 */
function send(subject, text, to) {
  return new Promise((resolve) => {
    if (!smtpReady()) return resolve(false);
    // 收件人：优先自定义（须通过格式校验），否则回退站长邮箱
    const recipient = validRecipient(to) ? to : cfg.to;
    if (!validRecipient(recipient)) return resolve(false);
    // 注入防护：正文与主题中的换行一律清洗（DATA 段的 CRLF.CRLF 终止序列）；
    // 主题另做 RFC 2047 字节截断（encoded-word ≤75 字符）
    const safeSubject2 = safeSubject(subject);
    const safeText = sanitizeForSmtp(text);
    const sock = net.createConnection(cfg.port, cfg.host);
    let step = 0;
    let buffer = '';
    // 每步命令及其期望的服务器响应码前缀：
    // 响应码不符（如 530 认证失败 / 550 收件人拒绝）→ 终止，避免在错误状态下继续发送
    const commands = [
      { cmd: `EHLO xalor-blog\r\n`, expect: ['250'] },
      { cmd: `AUTH LOGIN\r\n`, expect: ['334'] },
      { cmd: `${Buffer.from(cfg.user).toString('base64')}\r\n`, expect: ['334'] },
      { cmd: `${Buffer.from(cfg.pass).toString('base64')}\r\n`, expect: ['235'] },
      { cmd: `MAIL FROM:<${cfg.user}>\r\n`, expect: ['250'] },
      { cmd: `RCPT TO:<${recipient}>\r\n`, expect: ['250', '251'] },
      { cmd: `DATA\r\n`, expect: ['354'] },
      { cmd: `From: Xalor的小站 <${cfg.user}>\r\nTo: <${recipient}>\r\nSubject: =?UTF-8?B?${Buffer.from(safeSubject2).toString('base64')}?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${safeText}\r\n.\r\n`, expect: ['250'], data: true },
      { cmd: `QUIT\r\n`, expect: ['221'], final: true },
    ];
    sock.setEncoding('utf8');
    let failed = false;
    sock.on('data', (chunk) => {
      if (failed) return;
      buffer += chunk;
      // 多行响应（250- 前缀）需收完整
      while (buffer.includes('\r\n')) {
        const lineEnd = buffer.indexOf('\r\n');
        const response = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const code = response.slice(0, 3);
        // EHLO 多行块（250-...250 ...）继续收下一行
        if (code === '250' && response[3] === '-' && !buffer.includes('\r\n')) return;
        const cur = commands[step];
        if (!cur) { sock.destroy(); return; }
        if (!cur.expect.some((p) => code.startsWith(p))) {
          // 服务器拒绝当前命令（认证失败/收件人拒绝等）→ 终止并关闭
          failed = true;
          sock.destroy();
          resolve(false);
          return;
        }
        if (cur.final) {
          sock.destroy();
          resolve(true);
          return;
        }
        // DATA 内容发送完成（收到 250）即视为投递成功；后续 QUIT 仅为礼貌收尾
        if (cur.data) {
          sock.write(`QUIT\r\n`);
          sock.destroy();
          resolve(true);
          return;
        }
        step += 1;
        if (step < commands.length) {
          sock.write(commands[step].cmd);
        } else {
          sock.destroy();
          resolve(true);
        }
      }
    });
    sock.on('close', () => resolve(false));
    sock.on('error', () => resolve(false));
    sock.setTimeout(15000, () => { sock.destroy(); resolve(false); });
  });
}

module.exports = { send, enabled, smtpReady, sanitizeForSmtp, safeSubject };
