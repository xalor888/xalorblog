/**
 * 应用层 WAF（企业级特征库 + 行为分析）
 * ============ 检测维度 ============
 * 1. 特征库：SQL 注入 / XSS / 路径遍历 / 命令注入 / SSRF / XXE / SSTI / 模板注入 /
 *            Log4Shell / Spring4Shell / CRLF / 原型污染 / 反序列化
 * 2. 多层解码归一化：URL 解码 ×2 → HTML 实体解码 → Unicode 转义解码 → 全角字符归一
 *    （攻破单层编码变体的 0day 防御）
 * 3. JSON 键名检测：__proto__/constructor 等原型污染键 + 键名攻击特征
 * 4. 扫描器识别：已知漏洞扫描工具 UA（sqlmap/nikto/nuclei 等）直接拦截
 * 5. 蜜罐路径：潜伏常用管理/配置/备份路径，命中即高积分封禁
 * 6. 404 扫描行为：短时间内大量访问不存在路径 → 判定目录爆破
 * 7. SSRF 内网地址检测：私有网段/环回/链路本地/十进制/八进制 IP 变形
 * 命中即 403 并联动 IP 信誉系统自动封禁（waf 权重最高）
 */

const { report } = require('./ipGuard');
const config = require('../config');

/* ==================== SQL 注入 ==================== */
const SQL_PATTERNS = [
  /\bunion\b[\s\S]{0,60}?\bselect\b/i,
  /\bselect\b[\s\S]{0,60}?\b(?:from|where|into)\b/i,
  /\b(?:or|and)\b[\s\S]{0,20}?(?:1|2|true|false|null)\s*(?:=\s*(?:1|2|true|false|null)|!=\s*1|<>|>=|<=)/i,
  /['"]\s*(?:or|and)\s*['"]?\s*=\s*['"]/i,
  /\b(?:or|and)\b[\s\S]{0,40}?\d+\s*=\s*\d+/i,
  /(['"])\s*\d+\s*\1\s*=\s*\1\s*\d+\s*\1?/i,
  /\b(?:sleep|benchmark|waitfor\s+delay|pg_sleep|get_lock|greatest|least)\s*\(/i,
  /\b(?:insert|update|delete|drop|truncate|alter|create|replace|rename|grant|revoke|lock)\s+(?:into|table|database|from|view|procedure|function|user|index|trigger)?/i,
  /;\s*(?:select|insert|update|delete|drop|alter|create|--|#|\/\*)\b/i,
  /--[\s]*$/m,
  /#[\s]*\d/i,
  /\/\*![0-9]{4,}[\s\S]*?\*\//i,
  /\/\*[\s\S]{0,80}?\*\//i,
  /\binformation_schema\b|\bsys\.(?:schema|databases|columns|tables)\b|\bmysql\.(?:user|db|general_log)\b/i,
  /\b(?:load_file|outfile|dumpfile|into\s+outfile|into\s+dumpfile|group_concat|extractvalue|updatexml|concat_ws|@@version|@@datadir|@@hostname|version\(\)|database\(\)|current_user\(\)|user\(\))\b/i,
  /\bxp_cmdshell\b|\bmaster\.\.\b|\bsp_makewebtask\b/i,
  /\bexec(?:ute)?\s+(?:xp_|sp_)/i,
  /\bcase\s+when\b[\s\S]{0,60}\b(?:then|end)\b/i,
  /\bif\s*\(\s*(?:select|exists|char|substr|ascii|sleep)/i,
  /\b(?:substr|substring|mid|right|left)\s*\(\s*(?:[a-z_]+|\(select)/i,
  /\bconcat(?:_ws)?\s*\(/i,
  /\bchar\s*\(\s*\d+/i,
  /0x[0-9a-f]{8,}/i,
  /\b(?:from|where|order\s+by)\s+[`"'[\]]?[a-z_]+[`"'\]]?\s*=\s*['"]?[a-z_]+/i,
  /\b(?:into\s+)?outfile\s+'/i,
  /\b(?:union|select|insert|update)\s*\(\s*select/i,
  /'[\s\S]{0,10}?(?:or|and|union|select|--|#)/i,
  /(?:^|[\s('"])(?:1=1|1=2|2=1|'1'='1|"1"="1|0=0)\b/i,
  /\d+(?:\.\d+)?[eE][+-]?\d+\s*(?:=|<>|!=|>=|<=)/i, // 科学计数法盲注 1e1=1e1
  /\border\s+by\s+\d+/i, // ORDER BY 列数探测
  /\b(?:benchmark|sleep)\s*\(\s*\d{2,}/i,
];

/* ==================== XSS ==================== */
const XSS_PATTERNS = [
  /<script[\s>]/i,
  /<\/script\s*>/i,
  /<\s*iframe[\s>]/i,
  /<\s*object[\s>]/i,
  /<\s*embed[\s>]/i,
  /<\s*svg[\s>][\s\S]{0,120}?on/i,
  /<\s*math[\s>]/i,
  /<\s*form[\s>]/i,
  /<\s*base\s+[^>]*href/i,
  /<\s*link\s+[^>]*rel\s*=\s*["']?stylesheet/i,
  /<\s*meta\s+[^>]*http-equiv/i,
  /<\s*template\s+shadowroot/i,
  /<\s*details[^>]*ontoggle/i,
  /<\s*marquee[^>]*on/i,
  /<\s*video[^>]*on/i,
  /<\s*audio[^>]*on/i,
  /<style[\s>][\s\S]{0,120}?@import/i,
  /<\s*img[^>]*on[a-z]+\s*=/i,
  /\son[a-z]+\s*=\s*(['"]?[\s\S]{0,40}?)/i,
  /\bjavascript\s*:/i,
  /\bvbscript\s*:/i,
  /\bdata\s*:\s*text\/html/i,
  /expression\s*\(/i,
  /-moz-binding\s*:/i,
  /@import\s+/i,
  /document\s*\.\s*(?:cookie|location|body|write|domain)/i,
  /window\s*\.\s*location\b/i,
  /\b(?:alert|prompt|confirm)\s*\(/i,
  /\beval\s*\(/i,
  /String\s*\.\s*fromCharCode/i,
  /constructor\s*\.\s*constructor/i,
  /\\u00(?:3c|3e|22|27|60|28|29)|\\x(?:3c|3e|27|22)/i,
  /&#x?0*(?:3c|3e|60|27|22|00)[\s;]*/i,
  /%3c(?:script|img|svg|iframe|body|div)/i,
  /src\s*=\s*["']?\s*javascript/i,
  /href\s*=\s*["']?\s*(?:javascript|vbscript|data:)/i,
  /<\s*body[^>]*on/i,
  /<\s*svg[^>]*href\s*=\s*["']?\s*javascript/i,
  /\b(?:fetch|XMLHttpRequest)\s*\(\s*['"]\/\//i,
  // 无空格变体与新型向量：<svg/onload、协议相对外链、srcdoc/formaction、xlink、上下文逃逸
  /<\s*svg[^>]*\son[a-z]+\s*=/i,
  /<\s*svg\/[^>]*onload/i,
  /(?:href|src|action)\s*=\s*["']?\s*\/\/(?!w{3}\.w3\.org)/i,
  /\bsrcdoc\s*=/i,
  /\bformaction\s*=/i,
  /\bautofocus\s+[^>]*onfocus/i,
  /\bxlink:href\s*=\s*["']?\s*(?:javascript|data:)/i,
  /\bon(?:pointerrawupdate|pointerover|auxclick|beforetoggle|toggle|transitionrun|animationstart)\s*=/i,
  /<\/?(?:title|textarea|style|noscript|plaintext|xmp)[^>]*>/i,
];

/* ==================== 路径遍历 ==================== */
const TRAVERSAL_PATTERNS = [
  /\.\.(\/|\\)/i,
  /\.\.%2f|\.\.%5c/i,
  /%2e%2e/i,
  /%c0%ae|%c0%af|%e0%80%ae|%c1%9c/i,
  /\.\.%252f|\.\.%255c/i,
  /%00/,
  /\.\.[\\/]{2}/,
  /\.\.\s*[\\/]/i,
  /(?:^|[\\/])\.\.(?:$|[\\/])/i,
  // Tomcat/Spring 分号参数遍历与编码变体
  /\.\.;/i,
  /\.\.%u002e|%2e%u002e|%252e%252e/i,
];

/* ==================== 命令注入 ==================== */
const CMD_PATTERNS = [
  /`[^`]{2,}`/,
  /\$\([^)]{2,}\)/,
  /\$\{[^}]{2,}\}/,
  /;[\s]*(?:ls|dir|cat|id|whoami|uname|pwd|rm|cp|mv|wget|curl|nc|bash|sh|cmd|powershell|tasklist|net\s+user|nslookup|ping|python|perl|php|node|echo|grep|head|tail|sort|base64|awk|sed|find|env|printenv|hostname|mkdir|touch|chown|kill|dd)\b/i,
  /\|[\s]*(?:ls|dir|cat|id|whoami|uname|rm|wget|curl|sh|bash|nc|python|echo|grep|head|tail|sort|base64|awk|sed|find|env|hostname|chown|kill|dd)\b/i,
  /&&[\s]*(?:ls|dir|cat|id|whoami|rm|wget|curl|bash|sh|python|echo|grep|head|tail|sort|base64|env|hostname|chown|kill|dd)\b/i,
  /\|\|[\s]*(?:ls|dir|cat|id|whoami|rm|echo|grep|head|tail|sort|base64|env|hostname|chown|kill|dd)\b/i,
  /\b(?:ping|tracert|nslookup|nc)\s+\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i,
  /\b(?:chmod|chown|kill|dd|mkfifo|\/dev\/tcp|\/dev\/udp)\b/i,
  /\$\{IFS\}/i,
  /%0a|%0d/i,
  /(?:^|[;&|])\s*(?:curl|wget|nc|python3?|perl)\s+-[a-z]{1,10}/i,
];

/* ==================== SSRF（内网地址） ==================== */
const SSRF_PATTERNS = [
  /(?:^|[\s"'=:])(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1)(?:[:/]|$)/i,
  /(?:^|[\s"'=:])(?:https?:\/\/)?10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i,
  /(?:^|[\s"'=:])(?:https?:\/\/)?192\.168\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i,
  /(?:^|[\s"'=:])(?:https?:\/\/)?172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i,
  /(?:^|[\s"'=:])(?:https?:\/\/)?169\.254\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i,
  /(?:^|[\s"'=:])(?:https?:\/\/)?0x7f[\s\S]{0,3}/i,
  /(?:^|[\s"'=:])(?:https?:\/\/)?2130706433(?:\D|$)/i,
  /(?:^|[\s"'=:])(?:https?:\/\/)?(?:0177|017700000001)(?:\D|$)/i,
  /\b(?:file|gopher|dict|ftp|ldap|redis|expect|telnet|smb)\s*:\/\//i,
  /(?:^|[\s"'=:])https?:\/\/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(?::\d{1,5})?\/?[^\s]*metadata/i,
  /\bhttp:\/\/\[::ffff:/i,
];

/* ==================== XXE / 反序列化 / 模板注入 / 供应链漏洞 ==================== */
const MISC_PATTERNS = [
  /<!DOCTYPE[\s\S]{0,80}?(?:SYSTEM|PUBLIC)/i,
  /<!ENTITY[\s\S]{0,80}?(?:SYSTEM|PUBLIC)/i,
  /\b(?:java\.lang\.Object|java\.util\.|com\.sun\.|org\.apache\.commons)/i,
  /\$\{jndi:/i,
  /class\.module\.classLoader/i,
  /@type\s*:\s*[a-z][\w.]{2,}/i, // FastJSON 反序列化 RCE（@type 指定类）
  /"@type"\s*:\s*"[a-z][\w.]{2,}"/i, // FastJSON 标准 JSON 键形态 {"@type":"java.lang.Runtime"}（模糊测试发现仅无引号形态被拦）
  /%\{[#a-zA-Z_$]/i, // Struts2 OGNL 表达式（%{#_memberAccess 等）
  /#\{\s*T\s*\(/i, // SpEL / Thymeleaf 类引用表达式
  /Runtime\s*\.\s*getRuntime\b/i, // 命令执行载荷（getRuntime().exec）
  /__proto__|constructor\s*\.\s*prototype|prototype\s*\.\s*__|\[["']__proto__["']\]/i,
  /\{\{\s*[0-9]{1,3}\s*[\*\+]\s*[0-9]{1,3}\s*\}\}/i, // SSTI {{7*7}}
  // SSTI 探测扩展：Jinja2/Flask 全局对象探测（{{config}}/{{self}}/{{request}} 等）
  // 与字符乘法（{{7*'7'}}）—— 此前仅算术探测被拦，探测载荷放行（模糊测试发现）
  /\{\{\s*(?:config|self|request|app|g\b|session|url_for|get_flashed_messages|cycler|joiner|namespace)\s*\}\}/i,
  // SSTI 属性链探测（{{"x".__class__.__mro__}} 等 —— 高级绕过矩阵发现）
  /__class__|__mro__|__subclasses__|__globals__|__builtins__|__init__|__import__/i,
  /\{\{\s*[0-9]{1,3}\s*[\*\+]\s*['"]?[0-9]{1,3}['"]?\s*\}\}/i,
  /<%\s*=\s*[a-z_]+/i, // JSP EL
  /<%\s*[a-z_]+\s*\([^)]*\)\s*%>/i, // ASP 函数调用标签 <% exec("id") %>（模糊测试发现仅 EL 形态被拦）
  /#\{\s*\d+\s*\*\s*\d+\s*\}/i, // Thymeleaf
  /(?:^|[\s"'])\/\/[a-z0-9-]+\.[a-z0-9-]+/i, // 协议相对 URL（开放重定向，仅值开头/空白后）
  /\r\n/i,
  /\b(?:git|svn|hg)\s+clone\b/i,
  // Java 反序列化工具链与中间件协议（ysoserial 默认载荷头 rO0AB）
  /\brO0AB/i,
  /\bysoserial\b/i,
  /\bJRMPClient\b/i,
  /\b(?:rmi|iiop|t3|coherence)\s*:\/\//i,
  /\b(?:CommonsCollections|CommonsBeanutils|C3P0|ROME|Hibernate1|Spring1)\d{0,2}\b/i,
];

/* ==================== 已知漏洞扫描器 UA ==================== */
const SCANNER_UA_PATTERNS = [
  'sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab', 'gobuster', 'dirsearch',
  'wpscan', 'nuclei', 'ffuf', 'nessus', 'openvas', 'acunetix', 'appscan',
  'burpsuite', 'burp', 'arachni', 'webinspect', 'crawljax', 'fuzz',
  'zzz', 'dotdotpwn', 'joomscan', 'cmseek', 'wappalyzer', 'recon',
  'whatweb', 'test404', 'winhttp', 'python-requests', 'python-urllib',
  'aiohttp', 'scrapy', 'httpx', 'curlimages', 'libwww', 'lwp',
  'www-mechanize', 'httrack', 'wget/', 'curl/', 'okhttp', 'java/',
  'go-http-client', 'node-fetch', 'axios/', 'httpie', 'postman',
  'insomnia', 'playwright', 'puppeteer', 'phantomjs', 'selenium',
  'headless', 'webdriver', 'lighthouse', 'expanse', 'censys', 'shodan',
  'zoomeye', 'fofa', 'quake', 'netcraft', 'semrush', 'ahrefs', 'mj12bot',
  'dotbot', 'dataforseo', 'claudebot', 'gptbot', 'ccbot', 'bytespider',
  'petalbot', 'yisou', 'smider', 'facebookexternalhit', 'domaincrawler',
  'sitedomain', 'spider', 'crawler',
  // 2023-2026 活跃扫描器/工具补充
  'feroxbuster', 'wfuzz', 'katana', 'arjun', 'dalfox', 'xsstrike', 'commix',
  'tplmap', 'jwt_tool', 'rustscan', 'naabu', 'amass', 'subfinder', 'afrog',
  'fscan', 'kscan', 'netsparker', 'w3af', 'skipfish', 'webscarab', 'xray',
  'striker', 'gau', 'waybackurls', 'radare', 'ysoserial', 'jndi',
  'log4shell', 'spring4shell', 'shellshock', 'heartbleed', 'sslscan',
  'testssl', 'wapiti', 'arachni', 'jbrofuzz', 'maltrail', 'urlscan',
  'securitytrails', 'greynoise', 'abuseipdb', 'virustotal',
  'zmap', 'mobsf', 'trufflehog', 'gitleaks',
];

/* ==================== 蜜罐路径（诱捕扫描器） ==================== */
const HONEYPOT_PATHS = [
  '/admin', '/admin/', '/administrator', '/manage', '/manager', '/console',
  '/wp-admin', '/wp-login.php', '/wp-content', '/wordpress',
  '/config', '/config.php', '/config.json', '/configuration',
  '/.env', '/.git', '/.git/config', '/.svn', '/.DS_Store', '/.htaccess',
  '/backup', '/backup.zip', '/backup.sql', '/db.sql', '/database.sql',
  '/dump.sql', '/phpmyadmin', '/pma', '/mysql', '/phpinfo.php',
  '/test.php', '/info.php', '/shell.php', '/cmd.php', '/upload.php',
  '/swagger', '/swagger-ui', '/api-docs', '/v1', '/v2', '/graphql',
  '/actuator', '/actuator/health', '/h2-console', '/druid', '/nacos',
  '/jenkins', '/tomcat', '/manager/html', '/web-console',
  '/api/admin', '/api/config', '/api/users', '/api/debug', '/api/env',
  '/server-status', '/server-info', '/cgi-bin', '/bin', '/sbin',
  '/portal', '/login.php', '/register.php', '/install', '/setup',
  '/robots.txt.bak', '/crossdomain.xml',
  // 补充：API 探测 / 云原生 / 中间件 / 凭据与源码备份
  '/api/v1', '/api/v2', '/api/v3', '/api/token', '/api/login', '/api/user',
  '/api/users', '/api/healthz', '/api/debug', '/api/secret',
  '/metrics', '/prometheus', '/debug', '/trace', '/heapdump', '/threaddump',
  '/jolokia', '/solr', '/struts2', '/weblogic', '/jboss', '/webdav',
  '/cve-2017', '/cve-2018', '/cve-2019', '/cve-2020', '/cve-2021',
  '/cve-2022', '/cve-2023', '/cve-2024', '/cve-2025', '/xampp', '/wamp',
  '/web.config', '/nginx.conf', '/docker-compose.yml', '/k8s', '/helm',
  '/.npmrc', '/.ssh', '/.aws', '/credentials', '/credentials.json',
  '/secret', '/keys', '/id_rsa', '/.bash_history', '/.zsh_history',
  '/server.key', '/server.crt', '/dump', '/site.zip', '/www.zip',
  '/backup.tar.gz', '/wp-config.php.bak', '/.env.bak', '/composer.json',
  '/pom.xml', '/package-lock.json', '/yarn.lock',
];

const HONEYPOT_SET = new Set(HONEYPOT_PATHS);

/* ==================== 解码归一化 ==================== */

function decodeLevel1(text) {
  let t = text;
  try {
    t = decodeURIComponent(t.replace(/\+/g, ' '));
  } catch (e) { /* 保留原文 */ }
  return t;
}

function decodeLevel2(text) {
  // 双层 URL 解码 + 常见编码变体归一化
  let t = decodeLevel1(text);
  try {
    t = decodeURIComponent(t);
  } catch (e) { /* 保留 */ }
  // HTML 实体 → 原始字符
  t = t
    .replace(/&#x([0-9a-f]{2,6});?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#([0-9]{1,6});?/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&(?:lt|gt|quot|apos|#39);/gi, (m) => ({ lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }[m.slice(1, -1).toLowerCase()] || m));
  // Unicode 转义
  t = t.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // IE 遗留 %u 编码（%u0027 → '）
  t = t.replace(/%u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // 全角字符归一（中文输入法注入变体）：
  // 全角段整体归一（U+FF01-FE5E 全角可打印字符 → 半角 —— 含 ．｜：｛｝＆＄＃＊
  // 等符号，此前仅部分符号归一，全角符号组合可绕过 —— 绕过矩阵 2 发现）
  // 全角空格（U+3000）单独处理
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.replace(/\u3000/g, ' ');
  // 归一化后循环解码（最多 3 轮）：全角+多层编码（１％2527 → %27 → '）需多轮，
  // 单轮补解码会残留 %27 形态逃过关键词检测（绕过矩阵 2/3 发现）
  for (let i = 0; i < 3; i++) {
    try {
      const dec = decodeURIComponent(t);
      if (dec === t) break;
      t = dec;
    } catch (e) { break; }
  }
  return t;
}

/* ==================== 检测引擎 ==================== */

const CHECK_GROUPS = [
  [SQL_PATTERNS, 'SQL'],
  [XSS_PATTERNS, 'XSS'],
  [TRAVERSAL_PATTERNS, 'TRAVERSAL'],
  [CMD_PATTERNS, 'CMD'],
  [SSRF_PATTERNS, 'SSRF'],
  [MISC_PATTERNS, 'MISC'],
];

/** 头部专用检测：跳过 SSRF 组（本地开发 referer / 代理链 XFF 含内网地址属正常） */
function detectHeaderAttack(text) {
  if (typeof text !== 'string' || !text.length) return null;
  const t = text.slice(0, 2000);
  const variants = [t, decodeLevel1(t), decodeLevel2(t)];
  const groups = [SQL_PATTERNS, XSS_PATTERNS, TRAVERSAL_PATTERNS, CMD_PATTERNS, MISC_PATTERNS];
  for (const patterns of groups) {
    for (const re of patterns) {
      for (const v of variants) {
        if (re.test(v)) return true;
      }
    }
  }
  return false;
}

function detectAttack(text) {
  if (typeof text !== 'string' || !text.length) return null;
  if (text.length > 4000) text = text.slice(0, 4000);
  const variants = [text, decodeLevel1(text), decodeLevel2(text)];
  for (const [patterns, type] of CHECK_GROUPS) {
    for (const re of patterns) {
      for (const v of variants) {
        if (re.test(v)) return type;
      }
    }
  }
  return null;
}

/** 扫描器 UA 检测 */
function isScannerUA(ua) {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return SCANNER_UA_PATTERNS.some((p) => lower.includes(p));
}

/** 404 扫描行为检测：短时间大量访问不存在路径 → 目录爆破 */
const scanTracker = new Map(); // ip -> { count, windowStart }
const SCAN_THRESHOLD = 12; // 30 秒内 ≥12 次 404
const SCAN_WINDOW = 30 * 1000;

/** UA 轮换检测：同一 IP 在 5 分钟窗口内出现 ≥6 个不同 UA → 脚本轮换 UA 规避指纹识别
 * 正常用户浏览器 UA 恒定；多设备/NAT 共网 IP 罕见且无害（只计积分不封禁） */
const uaTracker = new Map(); // ip -> { uas: Set, windowStart }
const UA_DIFF_THRESHOLD = 6;
const UA_WINDOW = 5 * 60 * 1000;

function trackUaRotation(ip, ua) {
  if (!ip || typeof ua !== 'string' || !ua) return false;
  const now = Date.now();
  let rec = uaTracker.get(ip);
  if (!rec || now - rec.windowStart > UA_WINDOW) {
    rec = { uas: new Set(), windowStart: now };
    uaTracker.set(ip, rec);
  }
  // 仅对"声明是浏览器"的 UA 计数（爬虫 UA 已被独立机制拦截，不重复计）
  const lower = ua.toLowerCase();
  if (!/(mozilla|chrome|safari|edge|firefox|opera)/.test(lower)) return false;
  rec.uas.add(ua.slice(0, 200));
  if (uaTracker.size > 3000) {
    for (const [k, v] of uaTracker) {
      if (now - v.windowStart > UA_WINDOW) uaTracker.delete(k);
    }
  }
  return rec.uas.size >= UA_DIFF_THRESHOLD;
}

/** JSON 炸弹防护：深层嵌套 / 超大数组会消耗解析与循环 CPU（express.json 无深度限制） */
const MAX_BODY_DEPTH = 20;
const MAX_ARRAY_LENGTH = 1000;

function bodyShapeSafe(obj, depth = 0) {
  if (obj === null || typeof obj !== 'object') return true;
  if (depth > MAX_BODY_DEPTH) return false;
  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_LENGTH) return false;
    for (const item of obj) {
      if (!bodyShapeSafe(item, depth + 1)) return false;
    }
    return true;
  }
  for (const v of Object.values(obj)) {
    if (!bodyShapeSafe(v, depth + 1)) return false;
  }
  return true;
}

function trackMiss(ip) {
  const now = Date.now();
  let rec = scanTracker.get(ip);
  if (!rec || now - rec.windowStart > SCAN_WINDOW) {
    rec = { count: 1, windowStart: now };
  } else {
    rec.count += 1;
  }
  scanTracker.set(ip, rec);
  if (scanTracker.size > 2000) {
    for (const [k, v] of scanTracker) {
      if (now - v.windowStart > SCAN_WINDOW) scanTracker.delete(k);
    }
  }
  return rec.count >= SCAN_THRESHOLD;
}

/** 需要检测的请求头（头注入 / 恶意特征） */
const CHECK_HEADERS = ['cookie', 'x-forwarded-for', 'x-real-ip', 'referer', 'x-requested-with', 'x-auth-token', 'authorization'];

/**
 * WAF 中间件：检测 URL、query、body、headers 中的攻击特征
 * 豁免项（均已被 sanitize-html 清洗 + 参数化查询兜底，避免误伤合法内容）：
 * - content / about_content：文章与关于页 Markdown 自由文本（可含代码示例）
 * - title / summary / description：标题与描述（技术文章标题可能含 "union select" 等词汇）
 * - name：昵称/网站名/分类名/标签名（统一经 cleanLine 清洗）
 * - site_* / announcement / footer / avatar：站点设置项（管理员专属写入，前端纯文本渲染）
 * - keyword 搜索词（用户可能搜索 "union"、"<script>" 等技术词汇）
 * - form_token：签名令牌
 */
const BODY_EXEMPT_KEYS = new Set([
  'content', 'about_content', 'title', 'summary', 'description', 'name',
  'site_name', 'site_desc', 'announcement', 'footer',
  'social_github', 'social_weibo', 'social_email', 'avatar',
  // 分类主题色（管理端专用，前端 hex 校验；值形如 #123456，
  // 会被 SQL 注释模式 /#[\s]*\d/ 误伤 —— MySQL `#` 注释与 hex 颜色同形）
  'color',
  // 安全中心解封目标 IP（管理端专用；IPv6 回环 ::1 会被 SSRF 模式误伤，
  // 解封操作不涉及任何网络请求）
  'ip',
  'form_token',
]);
function waf(req, res, next) {
  const ip = req.ip || 'unknown';
  // 所有拒绝响应不落任何缓存
  res.set('Cache-Control', 'no-store');

  // ---- 0. 方法白名单 + 请求基线体积（前置防线，先于一切特征检测） ----
  // 非常见方法（TRACE/CONNECT/PATCH 等）：TRACE 可反射 XSS，CONNECT 可被滥用为代理隧道；
  // OPTIONS 保留供 CORS 预检
  const method = String(req.method || '').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(method)) {
    report(ip, 'waf', `BAD-METHOD ${method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // HTTP 请求走私检测：Content-Length 与 Transfer-Encoding 同时存在 → 前后端解析歧义，
  // 经典走私向量（CL.TE / TE.CL），直接拒绝
  const hasCL = req.headers['content-length'] !== undefined;
  const hasTE = req.headers['transfer-encoding'] !== undefined;
  if (hasCL && hasTE) {
    report(ip, 'waf', `SMUGGLING ${method} ${req.path}`);
    return res.status(400).json({ code: 1, message: '请求头冲突' });
  }
  // 重复 Content-Length 头（值不一致时 Node 会合并，但属畸形请求特征）
  if (typeof req.headers['content-length'] === 'object' || typeof req.headers['transfer-encoding'] === 'object') {
    report(ip, 'waf', `SMUGGLING-DUP ${method} ${req.path}`);
    return res.status(400).json({ code: 1, message: '请求头不合法' });
  }
  // 超长 URL（>8KB）：畸形/扫描器特征，同时防正则检测与日志落库被撑爆
  const rawUrl = String(req.originalUrl || '');
  if (rawUrl.length > 8192) {
    report(ip, 'waf', `URL-TOO-LONG ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // 单个头值上限 8KB：合法浏览器头远短于此（防 header 洪水撑爆解析内存与日志）
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string' && v.length > 8192) {
      report(ip, 'waf', `HEADER-TOO-LONG ${req.path}`);
      return res.status(403).json({ code: 1, message: '访问被拒绝' });
    }
  }
  // 请求头数量上限（纵深防御）：
  // Node 25 实测 —— server.maxHeadersCount 属性方式=「静默截断 req.headers 至 60」而非拒绝，
  // 因此此处检查正常情况下不会触发（截断后恒 ≤60）；若未来 Node 行为变化
  // （恢复拒绝语义或移除截断），此检查仍能阻止海量头进入下游路由/日志处理
  const headerCount = Object.keys(req.headers).length;
  if (headerCount > 60) {
    report(ip, 'waf', `HEADER-FLOOD ${req.path} (${headerCount})`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }

  // ---- 0b. 蜜罐路径：直接高积分封禁（不返回任何提示，与 404 同形） ----
  // 先剥离可配置的 API 前缀再匹配，改前缀也不会漏掉蜜罐
  let rawPath = req.path || '';
  const prefix = config.apiPrefix;
  if (prefix && prefix !== '/' && rawPath.startsWith(prefix)) {
    rawPath = rawPath.slice(prefix.length);
  }
  const pathOnly = rawPath.replace(/\/+$/, '') || '/';
  if (HONEYPOT_SET.has(pathOnly) || HONEYPOT_SET.has(rawPath)) {
    // 蜜罐命中即重罚（honeypot 权重在 ipGuard 中为最高档）
    report(ip, 'honeypot', `HONEYPOT ${req.method} ${req.path}`);
    return res.status(404).json({ code: 1, message: '访问被拒绝' });
  }

  // ---- 1. 扫描器 UA ----
  const ua = String(req.headers['user-agent'] || '');
  if (ua && isScannerUA(ua)) {
    report(ip, 'waf', `SCANNER ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // 超长 UA（>300 字符）：畸形/扫描器特征（合法浏览器 UA 远短于此），同时防 UA 落库撑爆字段
  if (ua.length > 300) {
    report(ip, 'waf', `UA-TOO-LONG ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // UA 轮换检测：同一 IP 窗口内切换 ≥6 个浏览器 UA → 脚本规避特征，计积分不阻断
  if (trackUaRotation(ip, ua)) {
    report(ip, 'rate', `UA-ROTATION ${req.path}`);
  }

  // ---- 1.5 参数洪水防护：query 键数量上限（防循环解析 CPU 耗尽） ----
  const queryEntries = Object.keys(req.query || {});
  if (queryEntries.length > 200) {
    report(ip, 'waf', `PARAM-FLOOD ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }

  // ---- 2. 特征检测：path / query / body 值 / body 键名 / 关键头 ----
  const targets = [];
  // 文章 slug 段由服务端 slugify 生成（仅 [a-z0-9-]），跳过特征检测防误伤
  // （如合法 slug "union-select-jiqiao" 不应触发 SQL 特征）
  targets.push(req.path.replace(/\/slug\/[^/]*$/i, '/slug/'));
  let keyInjected = false;
  // query 值递归提取：数组/嵌套参数（?search[]=...、?a[b][c]=...）的值同样纳入检测，
  // 防攻击者用数组形态绕过单值检测
  const collectQuery = (node) => {
    if (node === null || typeof node === 'undefined') return;
    if (Array.isArray(node)) {
      for (const item of node) collectQuery(item);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'keyword') continue;
        targets.push(k); // 键名也检测（防注入到参数名的攻击）
        if (/^(?:__proto__|constructor|prototype)$/i.test(k)) keyInjected = true;
        collectQuery(v);
      }
      return;
    }
    targets.push(String(node)); // 字符串/数字等原始值
  };
  collectQuery(req.query);
  // 头部仅检测注入类特征（SQL/XSS/遍历/命令/杂项），不查 SSRF：
  // referer 在本地开发/内网部署时合法指向 localhost，XFF 在代理链后含内网地址
  for (const h of CHECK_HEADERS) {
    if (req.headers[h]) targets.push('h:' + req.headers[h]);
  }

  const body = req.body || {};
  // JSON 炸弹防护：嵌套过深或数组过长（解析后仍会消耗大量循环 CPU）
  if (typeof body === 'object' && body !== null && !bodyShapeSafe(body)) {
    report(ip, 'waf', `JSON-BOMB ${req.method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }
  // 递归提取字符串值与键名：防攻击载荷藏在嵌套对象中绕过顶层检测
  // （如 {meta: {note: "1' OR 1=1"}}）；豁免键的整棵子树跳过（自由文本字段）
  const checkedValues = [];
  const checkedKeys = [];
  const walkBody = (node, exempted = false) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walkBody(item, exempted);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const isExempt = exempted || BODY_EXEMPT_KEYS.has(k);
      // 键名始终检测（对象值/数组项/原始值的键都纳入——__proto__/constructor 等
      // 注入特征与值类型无关，旧实现只查字符串值的键，对象值的键名可绕过）
      checkedKeys.push(k);
      if (typeof v === 'string') {
        if (!isExempt) checkedValues.push(v);
      } else if (typeof v === 'object' && v !== null) {
        walkBody(v, isExempt);
      } else if (!isExempt && v !== undefined) {
        checkedValues.push(String(v)); // 数字/布尔等原始值也纳入检测
      }
    }
  };
  walkBody(body);

  let hit = keyInjected ? 'KEY-INJECT' : null;
  for (const t of targets) {
    if (t.startsWith('h:')) {
      // 头部：注入类特征检测（不含 SSRF）
      if (detectHeaderAttack(t.slice(2))) {
        hit = 'HEADER';
        break;
      }
      continue;
    }
    const th = detectAttack(t);
    if (th) {
      hit = th;
      break;
    }
  }
  if (!hit) {
    for (const v of checkedValues) {
      hit = detectAttack(v);
      if (hit) break;
    }
  }
  if (!hit) {
    // 键名专用检测：孤立原型污染关键字（{constructor:{...}} 分层嵌套时
    // 连写模式无法命中单键）；仅对键名生效，避免误伤标签/昵称等用户文本
    for (const k of checkedKeys) {
      if (/^(?:__proto__|constructor|prototype)$/i.test(k)) {
        hit = 'KEY-INJECT';
        break;
      }
    }
  }
  if (!hit) {
    for (const k of checkedKeys) {
      hit = detectAttack(k);
      if (hit) break;
    }
  }

  if (hit) {
    report(ip, 'waf', `${req.method} ${req.path}`);
    console.warn(`[waf] ${hit} blocked: ${ip} ${req.method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }

  // ---- 3. 404 扫描行为（放在最外层 404 处理器前不可行，这里用命中判定） ----
  // 由 app.js 的 404 处理处调用 trackMiss 完成（见 waf.recordMiss）

  next();
}

/** 404 处理器使用：记录未命中路径（目录爆破检测） */
function recordMiss(ip, path) {
  if (!ip || typeof path !== 'string') return false;
  // 静态资源与已知引导路径不计数，避免误报
  if (path.startsWith('/uploads/') || path === '/' || path === '/robots.txt') return false;
  if (trackMiss(ip)) {
    report(ip, 'rate', `404 扫描 ${path}`);
    return true;
  }
  return false;
}

module.exports = { waf, detectAttack, recordMiss, HONEYPOT_SET };