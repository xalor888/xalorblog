const sanitizeHtml = require('sanitize-html');

/**
 * 输入清洗工具：防御存储型 XSS 与注入
 * 规则：允许基本文本与换行，剔除一切 HTML/脚本标签
 */
function cleanText(input, maxLen = 2000) {
  if (typeof input !== 'string') return '';
  const cleaned = sanitizeHtml(input, {
    allowedTags: [],           // 不允许任何 HTML 标签
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });
  return cleaned.trim().slice(0, maxLen);
}

/** 清洗单行文本（去掉换行，用于昵称/标题等） */
function cleanLine(input, maxLen = 100) {
  return cleanText(input, maxLen).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 校验 URL 是否安全（仅 http/https，且拒绝内网/回环/保留地址）
 * 内网地址黑名单：防「友链塞内网地址」的社工/追踪场景；
 * 同时为未来可能引入的服务端抓取（如缩略图预取）预留 SSRF 防线
 */
function safeUrl(input, maxLen = 500) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim().slice(0, maxLen);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    // 拒绝 URL 内嵌凭据（https://user:pass@host 既是钓鱼样式，也可能被后续抓取滥用）
    if (url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    // 主机名黑名单：localhost 及其变体、mDNS 本地域名
    if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return '';
    // IPv6 字面量：不做解析级校验，直接拒绝（保留/链路本地地址无法廉价区分）
    if (host.includes(':')) return '';
    // 纯数字/十六进制 IP 简写（2130706433、0x7f000001、127.1）可能解析到回环地址
    if (/^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return '';
    if (host.includes('%')) return '';
    // IPv4 保留/内网段拒绝：0/8 · 10/8 · 127/8 · 169.254/16 · 172.16/12 ·
    // 192.168/16 · 100.64/10（CGNAT）· 224+（组播/保留）
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      // 八进制/前导零 IP 变体（0177.0.0.1）在部分解析器中会还原为回环地址
      if (host.split('.').some((s) => s.length > 1 && s.startsWith('0'))) return '';
      const parts = host.split('.').map(Number);
      if (parts.some((p) => p > 255)) return '';
      const [a, b] = parts;
      if (a === 0 || a === 10 || a === 127) return '';
      if (a === 169 && b === 254) return '';
      if (a === 172 && b >= 16 && b <= 31) return '';
      if (a === 192 && b === 168) return '';
      if (a === 100 && b >= 64 && b <= 127) return '';
      if (a >= 224) return '';
    }
    return trimmed;
  } catch (e) {
    return '';
  }
}

/** 校验邮箱格式 */
function safeEmail(input, maxLen = 100) {
  if (typeof input !== 'string' || !input) return '';
  const trimmed = input.trim().slice(0, maxLen);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : '';
}

/**
 * LIKE 通配符转义：防 % / _ 注入（搜索「%」即全表匹配的查询拖垮面）。
 * MySQL LIKE 默认 ESCAPE 字符为反斜杠，转义后通配符仅按字面匹配。
 */
function escapeLike(input) {
  return String(input).replace(/[\\%_]/g, (m) => `\\${m}`);
}

module.exports = { cleanText, cleanLine, safeUrl, safeEmail, escapeLike };
