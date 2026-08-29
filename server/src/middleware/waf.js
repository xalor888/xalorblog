/**
 * 应用层 WAF（特征库 + 行为分析）
 * ============ 检测维度 ============
 * 1. 特征库：SQL 注入 / XSS / 路径遍历 / 命令注入 / SSRF / XXE / SSTI / 模板注入 /
 *            反序列化 —— 每条规则带稳定 ID（安全事件可追溯到具体规则）
 * 2. 按扫描面分组：path/query/headers 扫全组；body 只扫高精度子集
 *    （CMD 不进 body、CRLF 不进 body、裸 javascript: 不进 body——昵称
 *    "JavaScript:从入门到放弃" 是合法文本，查询串里出现则是探测）
 * 3. 多层解码归一化：URL 解码 ×2 → HTML 实体 → Unicode 转义 → 全角归一
 * 4. 扫描器识别：漏洞扫描工具 + AI/SEO 爬虫 UA 直接拦截（通用客户端
 *    curl/python 等不拦 —— /api 有 PoW 闸门兜底，RSS/健康检查应可用）
 * 5. 蜜罐路径：潜伏永不该出现的管理/配置/备份路径，命中即高积分封禁
 * 6. 404 扫描行为：短时间内大量 404 → 目录爆破（浏览器默认请求豁免）
 * 7. SSRF 内网地址：仅对 URL 形态字段与 query 生效（昵称叫 localhost 不误伤）
 * 命中即 403 并联动 IP 信誉系统；规则组/单条规则可经安全中心配置禁用
 */

const { report } = require('./ipGuard');
const config = require('../config');
const securitySettings = require('../utils/securitySettings');

/* ==================== SQL 注入 ==================== */
const SQL_PATTERNS = [
  ['SQL-01', /\bunion\b[\s\S]{0,40}?\bselect\b/i, 'UNION SELECT 联合查询'],
  ['SQL-02', /\b(?:or|and)\b\s*['"]\s*\d+\s*['"]?\s*=\s*['"]?\s*\d+/i, "引号同义态 or '1'='1"],
  ['SQL-03', /(['"])\s*\d+\s*\1\s*=\s*\1\s*\d+\s*\1?/i, "引号同义态 '1'='1"],
  ['SQL-04', /\b(?:or|and|having)\b[\s\S]{0,6}?\d+\s*=\s*\d+/i, '数字同义态 or 1=1'],
  ['SQL-05', /\bsleep\s*\(\s*\d/i, 'SLEEP 盲注'],
  ['SQL-06', /\bbenchmark\s*\(/i, 'BENCHMARK 盲注'],
  ['SQL-07', /\bwaitfor\s+delay\b/i, 'WAITFOR DELAY 盲注'],
  ['SQL-08', /\bpg_sleep\s*\(/i, 'pg_sleep 盲注'],
  ['SQL-09', /\bget_lock\s*\(/i, 'get_lock 盲注'],
  ['SQL-10', /\binformation_schema\b/i, 'information_schema 探测'],
  ['SQL-11', /\bload_file\s*\(/i, 'load_file 读文件'],
  ['SQL-12', /\binto\s+(?:out|dump)file\b/i, 'into outfile 写文件'],
  ['SQL-13', /\b(?:group_concat|concat_ws)\s*\(/i, 'group_concat/concat_ws 聚合注入'],
  ['SQL-14', /\bextractvalue\s*\(/i, 'extractvalue 报错注入'],
  ['SQL-15', /\bupdatexml\s*\(/i, 'updatexml 报错注入'],
  ['SQL-16', /@@version|@@datadir|@@hostname/i, '@@version 等系统变量'],
  ['SQL-17', /\bxp_cmdshell\b/i, 'xp_cmdshell'],
  ['SQL-18', /\bexec(?:ute)?\s+(?:xp_|sp_)/i, '存储过程调用'],
  ['SQL-19', /\/\*![0-9]{4,}/i, 'MySQL 版本注释'],
  ['SQL-20', /\border\s+by\s+\d{1,3}\b/i, 'ORDER BY 列数探测'],
  ['SQL-21', /\b(?:insert\s+into|delete\s+from|drop\s+(?:table|database|index|view)\b|truncate\s+(?:table|database)\b|alter\s+table\b|create\s+(?:table|database|user)\b|rename\s+table\b)/i, '精确 DDL/DML 语句'],
  ['SQL-22', /['"]\s*(?:#|--)/i, '引号后接 SQL 注释符'],
  ['SQL-23', /;\s*(?:select|insert|update|delete|drop|alter|create|--)\b/i, '堆叠查询'],
  ['SQL-24', /\bcase\s+when\b[\s\S]{0,60}\b(?:then|end)\b/i, 'CASE WHEN 条件注入'],
  ['SQL-25', /\bif\s*\(\s*(?:select|exists|ascii|substr|sleep)/i, 'IF 条件盲注'],
  ['SQL-26', /\b(?:substr|substring|mid)\s*\(\s*(?:select|\d)/i, '截取函数盲注'],
  ['SQL-27', /0x[0-9a-f]{8,}/i, '长十六进制载荷'],
  ['SQL-28', /\b(?:union|select)\s*\(\s*select/i, '嵌套 SELECT'],
  ['SQL-29', /\bchar\s*\(\s*\d{2,}\s*,/i, 'CHAR 编码链'],
  ['SQL-30', /\b(?:from|where)\s+[`"'[\]]?[a-z_]+[`"'\]]?\s*=\s*['"]?[a-z_]+\s*(?:--|#|$)/i, 'WHERE 子句注入尾注'],
  ['SQL-31', /\/\*[\s\S]{0,80}?\*\//, '内联注释混淆（uni/*x*/on 等）'],
];

/* ==================== XSS ====================
 * XSS_NET：仅在 path/query/header 生效（裸 javascript: 对昵称等自由文本是误杀）
 * XSS_BODY：全范围生效（含 body 非豁免字段） */
const XSS_SHARED = [
  ['XSS-01', /<script[\s/>]/i, 'script 标签'],
  ['XSS-02', /<\/script/i, 'script 闭合'],
  ['XSS-03', /<\s*(?:iframe|object|embed|form|base|link|meta|math|marquee|style|template)\b/i, '高危 HTML 标签'],
  ['XSS-04', /<[a-z][^>]*\son[a-z]+\s*=/i, '标签内事件处理器'],
  ['XSS-05', /\son[a-z]+\s*=\s*["']?\s*(?:javascript:|alert\(|prompt\(|confirm\(|eval\()/i, '属性注入事件+执行体'],
  ['XSS-06', /\battributeName\s*=\s*["']?on[a-z]+/i, 'SVG animate 属性注入'],
  ['XSS-07', /\bsrcdoc\s*=/i, 'iframe srcdoc'],
  ['XSS-08', /\bformaction\s*=/i, 'formaction 劫持'],
  ['XSS-09', /(?:href|src|xlink:href|action|data)\s*=\s*["']?\s*(?:javascript|vbscript)\s*:/i, '伪协议赋值'],
  ['XSS-10', /(?:href|src|action)\s*=\s*["']?\s*data\s*:\s*text\/html/i, 'data:text/html 赋值'],
  ['XSS-11', /\bdata\s*:\s*text\/html/i, 'data:text/html 载荷'],
  ['XSS-12', /\bexpression\s*\(/i, 'CSS expression'],
  ['XSS-13', /@import\s+/i, 'CSS @import'],
  ['XSS-14', /document\s*\.\s*(?:cookie|domain|write)\b/i, 'document 对象访问'],
  ['XSS-15', /String\s*\.\s*fromCharCode/i, 'fromCharCode 混淆'],
  ['XSS-16', /\beval\s*\(/i, 'eval 执行'],
  ['XSS-17', /\\u00(?:3c|3e|22|27)|\\x(?:3c|3e|27|22)/i, '转义尖括号/引号'],
  ['XSS-18', /&#x?0*(?:3c|3e|60|27|22|00)/i, 'HTML 实体编码载荷'],
  ['XSS-19', /%3c(?:script|img|svg|iframe|body|div)/i, 'URL 编码标签'],
  ['XSS-20', /\b(?:alert|prompt|confirm)\s*\(/i, '弹窗函数调用'],
  ['XSS-21', /<\s*(?:title|textarea|style|noscript|plaintext|xmp)\b[^>]*>/i, '上下文逃逸标签'],
  ['XSS-22', /constructor\s*\.\s*constructor/i, '原型链构造器'],
];
const XSS_NET_ONLY = [
  ['XSS-23', /\b(?:javascript|vbscript)\s*:/i, '裸伪协议（网络面）'],
];

/* ==================== 路径遍历 ==================== */
const TRAVERSAL_PATTERNS = [
  ['TRV-01', /\.\.(?:\/|\\)/i, '目录上跳'],
  ['TRV-02', /\.\.%2f|\.\.%5c/i, '编码目录上跳'],
  ['TRV-03', /%2e%2e/i, '双点编码'],
  ['TRV-04', /%c0%ae|%c0%af|%e0%80%ae|%c1%9c/i, '超长 UTF-8 编码'],
  ['TRV-05', /\.\.%252f|\.\.%255c/i, '双重编码上跳'],
  ['TRV-06', /%00|\u0000/, '空字节'],
  ['TRV-07', /\.\.[\\/]{2}/, '连续分隔符上跳'],
  ['TRV-08', /(?:^|[\\/])\.\.(?:$|[\\/])/i, '独立路径段上跳'],
  ['TRV-09', /\.\.;/i, '分号参数遍历'],
  ['TRV-10', /\.\.%u002e|%2e%u002e|%252e%252e/i, '混合编码遍历'],
];

/* ==================== 命令注入 ====================
 * CMD_NET：仅 path/query/header（反引号、$()、${} 在昵称等短字段是合法
 * 文本 —— 模板字符串 ${name}、讨论文字；查询串中出现则是探测）
 * CMD_BODY：全范围生效（含 body 非豁免字段；分号/管道接命令任何字段都属攻击） */
const CMD_NET = [
  ['CMD-01', /`[^`]{2,}`/, '反引号执行'],
  ['CMD-02', /\$\([^)]{2,}\)/, '$() 命令替换'],
  ['CMD-03', /\$\{[^}]{2,}\}/, '${} 变量展开'],
];
const CMD_BODY = [
  ['CMD-04', /;[\s]*(?:ls|dir|cat|id|whoami|uname|pwd|rm|cp|mv|wget|curl|nc|bash|sh|cmd|powershell|tasklist|net\s+user|nslookup|ping|python|perl|php|node|echo|grep|head|tail|sort|base64|awk|sed|find|env|printenv|hostname|mkdir|touch|chown|kill|dd)\b/i, '分号接命令'],
  ['CMD-05', /\|[\s]*(?:ls|dir|cat|id|whoami|uname|rm|wget|curl|sh|bash|nc|python|echo|grep|head|tail|sort|base64|awk|sed|find|env|hostname|chown|kill|dd)\b/i, '管道接命令'],
  ['CMD-06', /&&[\s]*(?:ls|dir|cat|id|whoami|rm|wget|curl|bash|sh|python|echo|grep|head|tail|sort|base64|env|hostname|chown|kill|dd)\b/i, '&& 接命令'],
  ['CMD-07', /\|\|[\s]*(?:ls|dir|cat|id|whoami|rm|echo|grep|head|tail|sort|base64|env|hostname|chown|kill|dd)\b/i, '|| 接命令'],
  ['CMD-08', /\b(?:ping|tracert|nslookup|nc)\s+\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i, '网络探测命令'],
  ['CMD-09', /\$\{IFS\}/i, 'IFS 变量绕过'],
  ['CMD-10', /\b(?:chmod|chown|mkfifo|\/dev\/tcp|\/dev\/udp)\b/i, '权限/设备文件操作'],
  ['CMD-11', /(?:^|[;&|])\s*(?:curl|wget|nc|python3?|perl)\s+-[a-z]{1,10}/i, '命令行工具带参'],
];
const CMD_PATTERNS = [...CMD_NET, ...CMD_BODY];

/* ==================== SSRF（仅 query/path 与 body 的 URL 形态字段） ==================== */
const SSRF_PATTERNS = [
  ['SSRF-01', /(?:^|[\s"'=:])(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1)(?:[:/]|$)/i, '环回地址'],
  ['SSRF-02', /(?:^|[\s"'=:])(?:https?:\/\/)?10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i, '10 段内网'],
  ['SSRF-03', /(?:^|[\s"'=:])(?:https?:\/\/)?192\.168\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i, '192.168 内网'],
  ['SSRF-04', /(?:^|[\s"'=:])(?:https?:\/\/)?172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i, '172.16-31 内网'],
  ['SSRF-05', /(?:^|[\s"'=:])(?:https?:\/\/)?169\.254\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i, '链路本地/云元数据'],
  ['SSRF-06', /(?:^|[\s"'=:])(?:https?:\/\/)?0x7f[\s\S]{0,3}/i, '十六进制 IP 变形'],
  ['SSRF-07', /(?:^|[\s"'=:])(?:https?:\/\/)?2130706433(?:\D|$)/i, '十进制 IP 变形'],
  ['SSRF-08', /(?:^|[\s"'=:])(?:https?:\/\/)?(?:0177|017700000001)(?:\D|$)/i, '八进制 IP 变形'],
  ['SSRF-09', /\b(?:file|gopher|dict|ftp|ldap|redis|expect|telnet|smb)\s*:\/\//i, '非 HTTP 协议'],
  ['SSRF-10', /(?:^|[\s"'=:])https?:\/\/[0-9.]+(?::\d{1,5})?\/?[^\s]*metadata/i, '云元数据端点'],
  ['SSRF-11', /\bhttp:\/\/\[::ffff:/i, 'IPv4-mapped 变形'],
];

/* ==================== XXE / 反序列化 / 模板注入 ==================== */
const MISC_PATTERNS = [
  ['MSC-01', /<!DOCTYPE[\s\S]{0,80}?(?:SYSTEM|PUBLIC)/i, 'XXE DOCTYPE'],
  ['MSC-02', /<!ENTITY[\s\S]{0,80}?(?:SYSTEM|PUBLIC)/i, 'XXE ENTITY'],
  ['MSC-03', /\b(?:java\.lang\.|com\.sun\.|org\.apache\.commons)/i, 'Java 内部类引用'],
  ['MSC-04', /\$\{jndi:/i, 'JNDI 注入'],
  ['MSC-05', /class\.module\.classLoader/i, 'Spring classLoader'],
  ['MSC-06', /["']?@type["']?\s*:\s*["'][a-z][\w.]{2,}["']/i, 'FastJSON 反序列化'],
  ['MSC-07', /%\{[#a-zA-Z_$]/i, 'Struts2 OGNL'],
  ['MSC-08', /#\{\s*T\s*\(/i, 'SpEL 表达式'],
  ['MSC-09', /Runtime\s*\.\s*getRuntime\b/i, 'getRuntime 命令执行'],
  ['MSC-10', /__proto__|constructor\s*\.\s*prototype|\[["']__proto__["']\]/i, '原型污染'],
  ['MSC-11', /\{\{\s*[0-9]{1,3}\s*[\*\+]\s*['"]?[0-9]{1,3}['"]?\s*\}\}/i, 'SSTI 算术探测'],
  ['MSC-12', /\{\{\s*(?:config|self|request|app|g\b|session|url_for|get_flashed_messages|cycler|joiner|namespace)\s*\}\}/i, 'SSTI 全局对象'],
  ['MSC-13', /__class__|__mro__|__subclasses__|__globals__|__builtins__|__init__|__import__/i, 'Python 魔术属性'],
  ['MSC-14', /<%\s*=\s*[a-z_]+/i, 'JSP EL'],
  ['MSC-15', /<%\s*[a-z_]+\s*\([^)]*\)\s*%>/i, 'ASP 标签'],
  ['MSC-16', /#\{\s*\d+\s*\*\s*\d+\s*\}/i, 'Thymeleaf 表达式'],
  ['MSC-17', /\brO0AB/i, 'Java 序列化载荷'],
  ['MSC-18', /\b(?:ysoserial|JRMPClient)\b/i, 'Java 反序列化工具'],
  ['MSC-19', /\b(?:rmi|iiop|t3|coherence)\s*:\/\//i, 'Java 中间件协议'],
  ['MSC-20', /\b(?:CommonsCollections|CommonsBeanutils|C3P0|ROME|Hibernate1|Spring1)\d{0,2}\b/i, '反序列化链'],
];

/* ==================== 漏洞扫描工具 + AI/SEO 爬虫 UA（硬拦 + 记分） ====================
 * 通用客户端（curl/wget/python/axios 等）不在列：/api 有 PoW 闸门兜底，
 * 这些客户端访问 RSS/健康检查/分享页是合法场景；含 FP 的荒精子串已移除 */
const SCANNER_UA_PATTERNS = [
  // 漏洞扫描 / 暴力破解工具
  'sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab', 'zmap', 'gobuster', 'dirsearch', 'dirbuster',
  'feroxbuster', 'wfuzz', 'ffuf', 'wpscan', 'nuclei', 'nessus', 'openvas', 'acunetix', 'appscan',
  'netsparker', 'w3af', 'arachni', 'webinspect', 'whatweb', 'cmseek', 'joomscan', 'dotdotpwn',
  'test404', 'katana', 'dalfox', 'xsstrike', 'commix', 'tplmap', 'arjun', 'rustscan', 'naabu',
  'amass', 'subfinder', 'afrog', 'fscan', 'kscan', 'skipfish', 'wapiti', 'xray', 'striker',
  'mobsf', 'trufflehog', 'gitleaks', 'burpsuite', 'crawljax', 'jbrofuzz', 'sslscan', 'testssl',
  'urlscan', 'maltrail',
  // 无头浏览器自动化（真实用户不会出现）
  'headless', 'webdriver', 'phantomjs', 'selenium',
  // AI 训练 / SEO 内容爬虫（站长决定硬拦并记分）
  'claudebot', 'gptbot', 'ccbot', 'bytespider', 'perplexitybot', 'oai-searchbot', 'chatgpt-user',
  'semrush', 'ahrefs', 'mj12bot', 'dotbot', 'dataforseo', 'domaincrawler', 'sitedomain',
  'censys', 'shodan', 'zoomeye', 'fofa', 'quake', 'netcraft', 'expanse', 'securitytrails',
  'greynoise',
];

/* ==================== 蜜罐路径（诱捕扫描器） ====================
 * 仅保留本博客永不该合法出现的路径；/v1、/graphql、/config、/metrics 等
 * 未来可能用到的通用路径已移除（避免加路由即踩雷封禁真实用户） */
const HONEYPOT_PATHS = [
  '/admin', '/admin/', '/administrator', '/manage', '/manager', '/manager/html', '/console',
  '/wp-admin', '/wp-login.php', '/wp-content', '/wordpress', '/wp-config.php.bak', '/xmlrpc.php',
  '/.env', '/.env.bak', '/.git', '/.git/config', '/.svn', '/.DS_Store', '/.htaccess',
  '/.npmrc', '/.ssh', '/.aws', '/.bash_history', '/.zsh_history',
  '/backup', '/backup.zip', '/backup.sql', '/backup.tar.gz', '/db.sql', '/database.sql',
  '/dump.sql', '/site.zip', '/www.zip', '/phpmyadmin', '/pma', '/mysql', '/phpinfo.php',
  '/info.php', '/test.php', '/shell.php', '/cmd.php', '/upload.php', '/login.php', '/register.php',
  '/swagger', '/swagger-ui', '/api-docs',
  '/actuator', '/actuator/health', '/heapdump', '/jolokia', '/h2-console', '/druid', '/nacos',
  '/jenkins', '/tomcat', '/weblogic', '/jboss', '/solr', '/struts2', '/webdav', '/web-console',
  '/server-status', '/server-info', '/cgi-bin', '/server.key', '/server.crt', '/id_rsa',
  '/credentials.json', '/web.config', '/nginx.conf', '/docker-compose.yml',
  '/composer.json', '/package-lock.json', '/yarn.lock', '/pom.xml',
  '/api/admin', '/api/config', '/api/users', '/api/user', '/api/token', '/api/login',
  '/api/debug', '/api/env', '/api/secret', '/api/healthz',
  '/robots.txt.bak', '/crossdomain.xml',
  '/cve-2017', '/cve-2018', '/cve-2019', '/cve-2020', '/cve-2021',
  '/cve-2022', '/cve-2023', '/cve-2024', '/cve-2025',
];

const HONEYPOT_SET = new Set(HONEYPOT_PATHS);

/* ==================== 规则索引（安全中心展示/禁用 + 测试器） ==================== */
const RULE_GROUPS = {
  SQL: SQL_PATTERNS,
  XSS: XSS_SHARED,
  TRAVERSAL: TRAVERSAL_PATTERNS,
  CMD: CMD_PATTERNS,
  SSRF: SSRF_PATTERNS,
  MISC: MISC_PATTERNS,
};

const RULE_INDEX = {};
for (const [group, rules] of Object.entries(RULE_GROUPS)) {
  for (const [id, re, note] of rules) RULE_INDEX[id] = { id, group, note: note || '' };
}

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
  // 字面转义序列（\t/\n 等两字符形态）→ 空格：脚本常用字面转义替代真实空白
  // 规避 \b 词边界（union\tselect → union select）；转成空格保持词边界语义
  t = t.replace(/\\([tnrvf])/g, ' ');
  // 全角字符归一（中文输入法注入变体）：U+FF01-FE5E 全角 → 半角
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.replace(/\u3000/g, ' ');
  // 归一化后循环解码（最多 3 轮）：全角+多层编码需多轮才能还原
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

/** 各扫描面激活的规则组（scope: path | query | header | body） */
function scopeGroups(scope, sec) {
  const g = sec.groups;
  const on = (key) => g[key] !== false;
  if (scope === 'query') {
    return [
      ...(on('SQL') ? [SQL_PATTERNS] : []),
      ...(on('XSS') ? [XSS_SHARED, XSS_NET_ONLY] : []),
      ...(on('TRAVERSAL') ? [TRAVERSAL_PATTERNS] : []),
      ...(on('CMD') ? [CMD_PATTERNS] : []),
      ...(on('SSRF') ? [SSRF_PATTERNS] : []),
      ...(on('MISC') ? [MISC_PATTERNS] : []),
    ];
  }
  if (scope === 'path') {
    return [
      ...(on('SQL') ? [SQL_PATTERNS] : []),
      ...(on('XSS') ? [XSS_SHARED, XSS_NET_ONLY] : []),
      ...(on('TRAVERSAL') ? [TRAVERSAL_PATTERNS] : []),
      ...(on('CMD') ? [CMD_PATTERNS] : []),
      ...(on('SSRF') ? [SSRF_PATTERNS] : []),
      ...(on('MISC') ? [MISC_PATTERNS] : []),
    ];
  }
  if (scope === 'header') {
    return [
      ...(on('SQL') ? [SQL_PATTERNS] : []),
      ...(on('XSS') ? [XSS_SHARED, XSS_NET_ONLY] : []),
      ...(on('TRAVERSAL') ? [TRAVERSAL_PATTERNS] : []),
      ...(on('CMD') ? [CMD_PATTERNS] : []),
      ...(on('MISC') ? [MISC_PATTERNS] : []),
    ];
  }
  // body：不扫裸 javascript:（昵称等自由文本合法）、不扫反引号/$()/${}
  // （模板字符串等合法文本）、CRLF 单独豁免；分号/管道接命令仍全范围拦截
  return [
    ...(on('SQL') ? [SQL_PATTERNS] : []),
    ...(on('XSS') ? [XSS_SHARED] : []),
    ...(on('TRAVERSAL') ? [TRAVERSAL_PATTERNS] : []),
    ...(on('CMD') ? [CMD_BODY] : []),
    ...(on('MISC') ? [MISC_PATTERNS] : []),
  ];
}

/**
 * 扫描一段文本，返回命中规则 { id, group } 或 null。
 * scope 决定规则集；urlKey 仅对 body 面 SSRF 生效。
 */
function scanText(text, scope = 'body', { urlKey = false } = {}) {
  if (typeof text !== 'string' || !text.length) return null;
  if (text.length > 4000) text = text.slice(0, 4000);
  const sec = securitySettings.getConfig();
  const disabled = sec.disabledRules.length ? new Set(sec.disabledRules) : null;

  // 解码变体只算一次（原实现与收紧版都在全部规则间复用）
  const variants = [text, decodeLevel1(text), decodeLevel2(text)];
  const runGroup = (patterns) => {
    for (const [id, re] of patterns) {
      if (disabled && disabled.has(id)) continue;
      for (const v of variants) {
        if (re.test(v)) return { id, group: RULE_INDEX[id]?.group || '' };
      }
    }
    return null;
  };

  const groups = scopeGroups(scope, sec);
  if (scope === 'body' && urlKey && sec.groups.SSRF !== false) groups.push(SSRF_PATTERNS);

  for (const patterns of groups) {
    const hit = runGroup(patterns);
    if (hit) return hit;
  }
  // CRLF：日志/头注入向量，仅网络面（body 的多行文本合法）；含编码变体
  if (scope !== 'body' && !(disabled && disabled.has('MSC-CRLF'))) {
    for (const v of variants) {
      if (/[\r\n]/.test(v)) return { id: 'MSC-CRLF', group: 'MISC' };
    }
  }
  return null;
}

/** 兼容旧导出：返回命中组名或 null（waf 测试/调试用） */
function detectAttack(text) {
  const hit = scanText(text, 'query');
  return hit ? hit.group : null;
}

/** 扫描器 UA 检测 */
function isScannerUA(ua) {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return SCANNER_UA_PATTERNS.some((p) => lower.includes(p));
}

/** body 中视为「URL 形态」的字段名（SSRF 规则只作用于这些字段） */
const URL_FIELD_RE = /^(?:url|link|site|website|homepage|callback|redirect|next|target|src|href|source|domain|host|feed|icon|logo|image|img|cover|avatar|webhook|endpoint|origin)/i;

/** 需要检测的请求头（头注入 / 恶意特征） */
const CHECK_HEADERS = ['cookie', 'x-forwarded-for', 'x-real-ip', 'referer', 'x-requested-with', 'x-auth-token', 'authorization'];

/** 404 扫描行为检测：短时间大量访问不存在路径 → 目录爆破 */
const scanTracker = new Map(); // ip -> { count, windowStart }
const SCAN_WINDOW = 30 * 1000;

/** 浏览器/标准客户端默认请求（不存在的也算正常探测，不计 404 扫描） */
const MISS_EXEMPT_RE = [
  /^\/favicon(?:-\d+x\d+)?\.(?:ico|png)$/i,
  /^\/favicon-/i,
  /^\/apple-touch-icon/i,
  /^\/android-chrome-/i,
  /^\/mstile-/i,
  /^\/safari-pinned-tab\.svg$/i,
  /^\/(?:manifest\.json|site\.webmanifest|browserconfig\.xml|opensearch\.xml)$/i,
  /^\/(?:humans|ads|app-ads)\.txt$/i,
  /^\/\.well-known\//i,
  /^\/(?:rss|feed|sitemap)(?:\.xml)?$/i,
];

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
  // 仅对「声明是浏览器」的 UA 计数（爬虫 UA 已被独立机制拦截，不重复计）
  const lower = ua.toLowerCase();
  if (!/(mozilla|chrome|safari|edge|firefox|opera)/.test(lower)) return false;
  if (rec.uas.size < UA_DIFF_THRESHOLD) rec.uas.add(ua.slice(0, 200));
  if (uaTracker.size > 3000) {
    for (const [k, v] of uaTracker) {
      if (now - v.windowStart > UA_WINDOW) uaTracker.delete(k);
    }
    while (uaTracker.size > 2400) {
      const oldest = uaTracker.keys().next().value;
      if (oldest === undefined) break;
      uaTracker.delete(oldest);
    }
  }
  return rec.uas.size >= UA_DIFF_THRESHOLD;
}

/** JSON 炸弹防护：深层嵌套 / 超大数组会消耗解析与循环 CPU（express.json 无深度限制） */
const MAX_BODY_DEPTH = 20;
const MAX_ARRAY_LENGTH = 1000;
const MAX_OBJECT_KEYS = 1000;

function bodyShapeSafe(obj, depth = 0) {
  if (obj === null || typeof obj !== 'object') return true;
  if (depth > MAX_BODY_DEPTH) return false;
  if (Object.keys(obj).length > MAX_OBJECT_KEYS) return false;
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

function trackMiss(ip, threshold) {
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
    while (scanTracker.size > 1500) {
      const oldest = scanTracker.keys().next().value;
      if (oldest === undefined) break;
      scanTracker.delete(oldest);
    }
  }
  return rec.count >= threshold;
}

/**
 * WAF 中间件：检测 URL、query、body、headers 中的攻击特征
 * 豁免项（均已被 sanitize-html 清洗 + 参数化查询兜底，避免误伤合法内容）：
 * content/title/summary/description/name/site_* 与 keyword/color/ip/form_token 等
 * 自由文本与专用字段 —— 豁免只作用于该键自身的值，其嵌套子对象仍照常检测
 */
const BODY_EXEMPT_KEYS = new Set([
  'content', 'about_content', 'title', 'summary', 'description', 'name',
  'site_name', 'site_desc', 'announcement', 'footer',
  'social_github', 'social_weibo', 'social_email', 'avatar',
  // 分类主题色（管理端专用，前端 hex 校验；值形如 #123456）
  'color',
  // 安全中心解封目标 IP（管理端专用；IPv6 回环 ::1 会被 SSRF 模式误伤）
  'ip',
  'form_token',
]);

function waf(req, res, next) {
  const ip = req.ip || 'unknown';
  const sec = securitySettings.getConfig();
  // 所有拒绝响应不落任何缓存
  res.set('Cache-Control', 'no-store');

  // ---- 0. 方法白名单 + 请求基线体积（前置防线，先于一切特征检测） ----
  const method = String(req.method || '').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(method)) {
    report(ip, 'waf', `BAD-METHOD ${method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // HTTP 请求走私检测：CL 与 TE 同时存在 → 前后端解析歧义
  const hasCL = req.headers['content-length'] !== undefined;
  const hasTE = req.headers['transfer-encoding'] !== undefined;
  if (hasCL && hasTE) {
    report(ip, 'waf', `SMUGGLING ${method} ${req.path}`);
    return res.status(400).json({ code: 1, message: '请求头冲突' });
  }
  if (typeof req.headers['content-length'] === 'object' || typeof req.headers['transfer-encoding'] === 'object') {
    report(ip, 'waf', `SMUGGLING-DUP ${method} ${req.path}`);
    return res.status(400).json({ code: 1, message: '请求头不合法' });
  }
  // 超长 URL（>8KB）：畸形/扫描器特征
  const rawUrl = String(req.originalUrl || '');
  if (rawUrl.length > 8192) {
    report(ip, 'waf', `URL-TOO-LONG ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // 单个头值上限 8KB
  for (const v of Object.values(req.headers)) {
    if (typeof v === 'string' && v.length > 8192) {
      report(ip, 'waf', `HEADER-TOO-LONG ${req.path}`);
      return res.status(403).json({ code: 1, message: '访问被拒绝' });
    }
  }
  const headerCount = Object.keys(req.headers).length;
  if (headerCount > 60) {
    report(ip, 'waf', `HEADER-FLOOD ${req.path} (${headerCount})`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }

  // ---- 0b. 蜜罐路径：直接高积分封禁（不返回任何提示，与 404 同形） ----
  let rawPath = req.path || '';
  const prefix = config.apiPrefix;
  if (prefix && prefix !== '/' && rawPath.startsWith(prefix)) {
    rawPath = rawPath.slice(prefix.length);
  }
  const pathOnly = rawPath.replace(/\/+$/, '') || '/';
  const adminBase = `/${config.adminPath}`;
  const isAdminRoute = pathOnly === adminBase || pathOnly.startsWith(`${adminBase}/`);
  if (sec.honeypotEnabled && !isAdminRoute && (HONEYPOT_SET.has(pathOnly) || HONEYPOT_SET.has(rawPath))) {
    report(ip, 'honeypot', `HONEYPOT ${req.method} ${req.path}`);
    return res.status(404).json({ code: 1, message: '访问被拒绝' });
  }

  // ---- 1. 扫描器 UA ----
  const ua = String(req.headers['user-agent'] || '');
  if (sec.scannerUaBlock && ua && isScannerUA(ua)) {
    report(ip, 'waf', `SCANNER ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // 超长 UA（>300 字符）：畸形/扫描器特征
  if (ua.length > 300) {
    report(ip, 'waf', `UA-TOO-LONG ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // UA 轮换检测：同一 IP 窗口内切换 ≥6 个浏览器 UA → 脚本规避特征，计积分不阻断
  if (trackUaRotation(ip, ua)) {
    report(ip, 'rate', `UA-ROTATION ${req.path}`);
  }

  // ---- 1.5 参数洪水防护：query 键数量上限 ----
  const queryEntries = Object.keys(req.query || {});
  if (queryEntries.length > 200) {
    report(ip, 'waf', `PARAM-FLOOD ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }

  // ---- 2. 特征检测：path / query / body 值 / body 键名 / 关键头 ----
  const hits = [];
  // 文章 slug 段由服务端 slugify 生成（仅 [a-z0-9-]），跳过特征检测防误伤
  const pathTarget = req.path.replace(/\/slug\/[^/]*$/i, '/slug/');
  const pathHit = scanText(pathTarget, 'path');
  if (pathHit) hits.push(pathHit);
  // query 键名与值递归提取：数组/嵌套参数同样纳入检测
  let keyInjected = false;
  const collectQuery = (node) => {
    if (node === null || typeof node === 'undefined') return;
    if (Array.isArray(node)) {
      for (const item of node) collectQuery(item);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'keyword') continue;
        if (!keyInjected && /^(?:__proto__|constructor|prototype)$/i.test(k)) keyInjected = true;
        const kh = scanText(k, 'query');
        if (kh) hits.push(kh);
        collectQuery(v);
      }
      return;
    }
    const vh = scanText(String(node), 'query');
    if (vh) hits.push(vh);
  };
  collectQuery(req.query);
  // 头部：注入类特征检测（不含 SSRF —— 本地 referer / 代理链 XFF 合法含内网地址）
  for (const h of CHECK_HEADERS) {
    if (req.headers[h]) {
      const hh = scanText(String(req.headers[h]).slice(0, 2000), 'header');
      if (hh) hits.push(hh);
    }
  }

  const body = req.body || {};
  // JSON 炸弹防护：嵌套过深或数组过长
  if (typeof body === 'object' && body !== null && !bodyShapeSafe(body)) {
    report(ip, 'waf', `JSON-BOMB ${req.method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }
  // 递归提取字符串值与键名；豁免键只豁免自身值，嵌套子对象照常检测
  // （防把载荷塞进豁免键的嵌套对象绕过 WAF）
  const checkedKeys = [];
  const walkBody = (node) => {
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      checkedKeys.push(k);
      if (v && typeof v === 'object') {
        walkBody(v);
        continue;
      }
      if (BODY_EXEMPT_KEYS.has(k)) continue;
      const hit = scanText(typeof v === 'string' ? v : String(v), 'body', { urlKey: URL_FIELD_RE.test(k) });
      if (hit) hits.push(hit);
      if (hits.length > 3) return;
    }
  };
  walkBody(body);

  let hit = hits[0] || null;
  if (!hit && keyInjected) hit = { id: 'MSC-KEY-INJECT', group: 'MISC' };
  if (!hit) {
    // 键名专用检测：孤立原型污染关键字；其余键名走 body 子集规则
    for (const k of checkedKeys) {
      if (/^(?:__proto__|constructor|prototype)$/i.test(k)) {
        hit = { id: 'MSC-KEY-INJECT', group: 'MISC' };
        break;
      }
      const kh = scanText(k, 'body');
      if (kh) { hit = kh; break; }
    }
  }

  if (hit) {
    report(ip, 'waf', `${hit.id} ${req.method} ${req.path}`);
    console.warn(`[waf] ${hit.id}(${hit.group}) blocked: ${ip} ${req.method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }

  next();
}

/** 404 处理器使用：记录未命中路径（目录爆破检测） */
function recordMiss(ip, path) {
  if (!ip || typeof path !== 'string') return false;
  const sec = securitySettings.getConfig();
  if (!sec.scan404Enabled) return false;
  // 静态资源、已知引导路径与浏览器默认请求不计数，避免误报
  if (path.startsWith('/uploads/') || path === '/' || path === '/robots.txt') return false;
  if (MISS_EXEMPT_RE.some((re) => re.test(path))) return false;
  if (trackMiss(ip, sec.scanThreshold)) {
    report(ip, 'scan', `404 扫描 ${path}`);
    return true;
  }
  return false;
}

module.exports = { waf, scanText, detectAttack, recordMiss, HONEYPOT_SET, RULE_INDEX, RULE_GROUPS };
