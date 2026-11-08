const sanitizeHtml = require('sanitize-html');

/**
 * 输入清洗工具：防御存储型 XSS 与注入
 * 规则：允许基本文本与换行，剔除一切 HTML/脚本标签
 */
/**
 * 按 UTF-16 码元截断，但不切断代理对。
 *
 * String.prototype.slice 按码元计数，一个 emoji（如 😀 = D83D DE00）占 2 个码元。
 * 恰好在中间截断会留下**孤立的高位代理**：这个值 JSON 能序列化、Node 能持有，
 * 但 Buffer.from(v,'utf8') 会把孤立代理悄悄换成 U+FFFD，于是
 * 「页面上显示的长度」与「库里存的字符」不一致，且该字符永远无法还原。
 * 昵称/标题（cleanLine maxLen=100）只要第 100 个码元落在 emoji 中间就会中招。
 * 向前退一个码元即可，代价最多 1 个字符。
 */
function sliceSafe(s, maxLen) {
  if (s.length <= maxLen) return s;
  let cut = s.slice(0, maxLen);
  // 末尾是被劈开的代理对（高位代理结尾）→ 丢掉它
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

function cleanText(input, maxLen = 2000) {
  if (typeof input !== 'string') return '';
  const cleaned = sanitizeHtml(input, {
    allowedTags: [],           // 不允许任何 HTML 标签
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });
  return sliceSafe(cleaned.trim(), maxLen);
}

/** 清洗单行文本（去掉换行，用于昵称/标题等） */
function cleanLine(input, maxLen = 100) {
  return cleanText(input, maxLen).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 校验 URL 是否安全（仅 http/https，且拒绝一切 IP 字面量与内网主机名）
 * 用途：防「友链塞内网地址」的社工/追踪场景；
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
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    // 主机名黑名单：localhost 及其变体、mDNS 本地域名
    const privateSuffixes = ['.local', '.localhost', '.localdomain', '.internal', '.lan', '.home'];
    if (!host || host === 'localhost' || privateSuffixes.some((s) => host.endsWith(s))) return '';
    const rebindDomains = ['localtest.me', 'lvh.me', 'nip.io', 'sslip.io'];
    if (rebindDomains.some((d) => host === d || host.endsWith('.' + d))) return '';
    // IPv6 字面量：不做解析级校验，直接拒绝（保留/链路本地地址无法廉价区分）
    if (host.includes(':')) return '';
    // IPv4 字面量（含 2130706433、0x7f000001、127.1 这类简写——WHATWG 解析器会
    // 把它们补零/还原成点分十进制）一律拒绝，不做「按保留段放行」。
    //
    // 为什么不做段级判断：IP 目标的风险与「哪一段」无关。站点里指向 IP 的友链
    // 极罕见（正常站点都有域名），而 IP 直链正是 SSRF 与跨站追踪的常用手法
    // （127/8 回环、169.254.169.254 云元数据、100.64/10 CGNAT、172.16/12 内网
    // 全在同一套语法里，且公网 IP 同样可用于绕过域名黑名单做追踪/探测）。
    // 段表既要随云环境变化维护，又永远漏得掉新段；一条「只认域名」的规则
    // 可验证、无状态，也不会因为漏写某段而留后门。
    if (/^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return '';
    if (host.includes('%')) return '';
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

/**
 * 上传目录内的相对路径（`x.png` 或 `ai/x.png`）白名单校验，返回规范化 rel，非法返回 ''。
 *
 * 为什么允许一层子目录：AI 转存图落在 `/uploads/ai/`（admin.js 的 /ai/save-image）。
 * 旧白名单只认单段，于是这类图既**当不了封面**（safeCover 判非法 → 静默置空，
 * 前端表现为"选了图但封面没变"），也**被孤儿清理漏掉**（磁盘只增不减）。
 * 为什么限制两段：每多一层，引用扫描、孤儿清理、删除校验都要多一套边界，
 * 而当前没有第三层的生产者 —— 先把真实存在的层级覆盖掉，不为假想需求放开。
 *
 * 段规则：`[A-Za-z0-9_-]` 开头 + `[A-Za-z0-9._-]`（服务端随机名/带点扩展名），
 * 显式拒绝 `.` 与 `..` —— 后者能被旧正则 `[A-Za-z0-9._-]+` 匹配，
 * 于是 `/uploads/..` 一直能通过白名单（做 <img src> 无害，但一旦被删除接口复用就是路径穿越）。
 */
function safeUploadRel(input) {
  if (typeof input !== 'string') return '';
  const rel = input.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) return '';
  const segs = rel.split('/');
  if (segs.length > 2) return '';
  for (const seg of segs) {
    if (seg === '.' || seg === '..') return '';
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/.test(seg)) return '';
  }
  return segs.join('/');
}

/**
 * 封面/头像站内路径白名单：默认 logo 或 /uploads/ 下的服务端生成文件名（可含一层子目录）。
 * 任意站内路径会把 javascript 风格或 CSS 注入带进 <img src>。
 */
function safeCover(input) {
  if (typeof input !== 'string') return '';
  const v = input.trim().replace(/[\r\n]+/g, '').slice(0, 500);
  if (!v) return '';
  if (v === '/logo.png') return v;
  if (v.startsWith('/uploads/')) {
    const rel = safeUploadRel(v.slice('/uploads/'.length));
    return rel ? `/uploads/${rel}` : '';
  }
  return safeUrl(v, 500);
}

/* 文章正文中永远不应落库的可执行/嵌入标签（连同内容一起丢弃） */
const MARKDOWN_BAD_TAGS = ['script', 'iframe', 'object', 'embed', 'applet', 'style'];

/**
 * 清洗 Markdown 文章内容：
 * 保留 Markdown 语法与一般 HTML 标签（展示层再由前端 DOMPurify 严格净化），
 * 但剔除高危可执行标签（<script>, <iframe>, <object>, <embed>, <applet>, <style>）。
 *
 * 注意：sanitize-html 的 allowedTags:false 是「全部放行」，光靠 nonTextTags 并不
 * 会删掉这些标签（它只对「未被允许」的标签生效）。必须叠加 exclusiveFilter 才能
 * 真正丢弃整个标签帧——否则 <script> 会原样入库。
 */
function cleanMarkdown(input, maxLen = 100000) {
  if (typeof input !== 'string') return '';
  const cleaned = sanitizeHtml(input, {
    allowedTags: false, // 允许一般 HTML 标签（如 <div>, <span>, <table>, <img>, <details> 等）
    allowedAttributes: false, // 由前端 DOMPurify 负责展示层属性过滤
    disallowedTagsMode: 'discard',
    nonTextTags: MARKDOWN_BAD_TAGS,
    // 正文里出现 <style> 之类的裸标签时，仍由 exclusiveFilter 统一丢弃
    allowVulnerableTags: true,
    exclusiveFilter: (frame) => MARKDOWN_BAD_TAGS.includes(frame.tag),
  });
  // 与 cleanText 同一套截断规则：正文 10 万码元处若正好劈开 emoji，
  // 会留下入库即损坏的孤立代理（JSON 能存、渲染成 U+FFFD 且永远无法还原）。
  return sliceSafe(cleaned.trim(), maxLen);
}

module.exports = {
  cleanText,
  cleanLine,
  cleanMarkdown,
  safeUrl,
  safeEmail,
  escapeLike,
  safeCover,
  safeUploadRel,
};
