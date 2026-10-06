/**
 * WAF 规则数据层（与引擎 waf.js 分离：规则即数据，引擎只负责调度）
 *
 * 规则元数据模型（对齐 OWASP CRS 的思路，见调研报告）：
 *   - sev（严重度 → 异常分权重）：critical=5 / error=4 / warning=3 / notice=2
 *     CRS 同权重。判定延后到请求末尾按累计分对照阈值（waf.js），不再单命中即 403。
 *   - pl（paranoia level，偏执等级）：规则误杀风险分层
 *     pl1 = 默认启用（正常内容不可能合法命中的形态）
 *     pl2 = 高误杀面（技术讨论常见：eval()/alert()/模板字符串/@import/实体编码讨论…）
 *     pl3 = 激进（预留）
 *     securitySettings.paranoiaLevel 控制启用上限；高于设置等级的规则不参与检测。
 *   - zones：该规则可作用的扫描面（* 全部）；引擎按面过滤。
 *
 * 每条规则带稳定 ID；ID 一旦对外（审计/安全中心）发布不再变更。
 * 修改匹配逻辑前先跑 test/waf/fixtures 语料：攻击样本必须命中、良性语料必须放行。
 */

const SEVERITY_SCORE = { critical: 5, error: 4, warning: 3, notice: 2 };

/** 规则工厂：[id, re, note, sev, pl, zones]
 *  zones：可作用的扫描面；缺省 = 全部（含 body）。网络面规则显式排除 body。 */
const R = (id, re, note, sev = 'error', pl = 1, zones = null) => ({ id, re, note, sev, pl, zones });
const NET_ONLY = ['query', 'path', 'header']; // 仅网络面（body 自由文本合法）

/* ==================== SQL 注入 ==================== */
const SQL_PATTERNS = [
  R('SQL-01', /\bunion\b[\s\S]{0,40}?\bselect\b/i, 'UNION SELECT 联合查询', 'error'),
  R('SQL-02', /\b(?:or|and)\b\s*['"]\s*\d+\s*['"]?\s*=\s*['"]?\s*\d+/i, "引号同义态 or '1'='1", 'error'),
  R('SQL-03', /(['"])\s*\d+\s*\1\s*=\s*\1\s*\d+\s*\1?/i, "引号同义态 '1'='1", 'error'),
  R('SQL-04', /\b(?:or|and|having)\b[\s\S]{0,6}?\d+\s*=\s*\d+/i, '数字同义态 or 1=1', 'error'),
  R('SQL-05', /\bsleep\s*\(\s*\d/i, 'SLEEP 盲注', 'critical'),
  R('SQL-06', /\bbenchmark\s*\(/i, 'BENCHMARK 盲注', 'critical'),
  R('SQL-07', /\bwaitfor\s+delay\b/i, 'WAITFOR DELAY 盲注', 'critical'),
  R('SQL-08', /\bpg_sleep\s*\(/i, 'pg_sleep 盲注', 'critical'),
  R('SQL-09', /\bget_lock\s*\(/i, 'get_lock 盲注', 'critical'),
  R('SQL-10', /\binformation_schema\b/i, 'information_schema 探测', 'error'),
  R('SQL-11', /\bload_file\s*\(/i, 'load_file 读文件', 'critical'),
  R('SQL-12', /\binto\s+(?:out|dump)file\b/i, 'into outfile 写文件', 'critical'),
  R('SQL-13', /\b(?:group_concat|concat_ws)\s*\(/i, 'group_concat/concat_ws 聚合注入', 'error'),
  R('SQL-14', /\bextractvalue\s*\(/i, 'extractvalue 报错注入', 'error'),
  R('SQL-15', /\bupdatexml\s*\(/i, 'updatexml 报错注入', 'error'),
  R('SQL-16', /@@version|@@datadir|@@hostname/i, '@@version 等系统变量', 'error'),
  R('SQL-17', /\bxp_cmdshell\b/i, 'xp_cmdshell', 'critical'),
  R('SQL-18', /\bexec(?:ute)?\s+(?:xp_|sp_)/i, '存储过程调用', 'error'),
  R('SQL-19', /\/\*![0-9]{4,}/i, 'MySQL 版本注释', 'critical'),
  R('SQL-20', /\border\s+by\s+\d{1,3}\b/i, 'ORDER BY 列数探测', 'warning', 2),
  R('SQL-21', /\b(?:insert\s+into|delete\s+from|drop\s+(?:table|database|index|view)\b|truncate\s+(?:table|database)\b|alter\s+table\b|create\s+(?:table|database|user)\b|rename\s+table\b)/i, '精确 DDL/DML 语句', 'error'),
  R('SQL-22', /['"]\s*(?:#|--)/i, '引号后接 SQL 注释符', 'warning'),
  R('SQL-23', /;\s*(?:select|insert|update|delete|drop|alter|create|--)\b/i, '堆叠查询', 'error'),
  R('SQL-24', /\bcase\s+when\b[\s\S]{0,60}\b(?:then|end)\b/i, 'CASE WHEN 条件注入', 'warning', 2),
  R('SQL-25', /\bif\s*\(\s*(?:select|exists|ascii|substr|sleep)/i, 'IF 条件盲注', 'error'),
  R('SQL-26', /\b(?:substr|substring|mid)\s*\(\s*(?:select|\d)/i, '截取函数盲注', 'error'),
  R('SQL-27', /0x[0-9a-f]{8,}/i, '长十六进制载荷', 'warning', 2),
  R('SQL-28', /\b(?:union|select)\s*\(\s*select/i, '嵌套 SELECT', 'error'),
  R('SQL-29', /\bchar\s*\(\s*\d{2,}\s*,/i, 'CHAR 编码链', 'error'),
  R('SQL-30', /\b(?:from|where)\s+[`"'[\]]?[a-z_]+[`"'\]]?\s*=\s*['"]?[a-z_]+\s*(?:--|#|$)/i, 'WHERE 子句注入尾注', 'warning', 2),
  R('SQL-31', /\/\*[\s\S]{0,80}?\*\//, '内联注释混淆（uni/*x*/on 等）', 'error'),
];

/* ==================== XSS ====================
 * XSS-23 为网络面规则（裸 javascript: 对昵称等自由文本是合法写法） */
const XSS_SHARED = [
  R('XSS-01', /<script[\s/>]/i, 'script 标签', 'critical'),
  R('XSS-02', /<\/script/i, 'script 闭合', 'critical'),
  R('XSS-03', /<\s*(?:iframe|object|embed|form|base|link|meta|math|marquee|style|template)\b/i, '高危 HTML 标签', 'error'),
  R('XSS-04', /<[a-z][^>]*\son[a-z]+\s*=/i, '标签内事件处理器', 'critical'),
  R('XSS-05', /\son[a-z]+\s*=\s*["']?\s*(?:javascript:|alert\(|prompt\(|confirm\(|eval\()/i, '属性注入事件+执行体', 'critical'),
  R('XSS-06', /\battributeName\s*=\s*["']?on[a-z]+/i, 'SVG animate 属性注入', 'error'),
  R('XSS-07', /\bsrcdoc\s*=/i, 'iframe srcdoc', 'error'),
  R('XSS-08', /\bformaction\s*=/i, 'formaction 劫持', 'error'),
  R('XSS-09', /(?:href|src|xlink:href|action|data)\s*=\s*["']?\s*(?:javascript|vbscript)\s*:/i, '伪协议赋值', 'error'),
  R('XSS-10', /(?:href|src|action)\s*=\s*["']?\s*data\s*:\s*text\/html/i, 'data:text/html 赋值', 'critical'),
  R('XSS-11', /\bdata\s*:\s*text\/html/i, 'data:text/html 载荷', 'error'),
  R('XSS-12', /\bexpression\s*\(/i, 'CSS expression', 'warning', 2),
  R('XSS-13', /@import\s+/i, 'CSS @import', 'warning', 2),
  R('XSS-14', /document\s*\.\s*(?:cookie|domain|write)\b/i, 'document 对象访问', 'warning', 2),
  R('XSS-15', /String\s*\.\s*fromCharCode/i, 'fromCharCode 混淆', 'error'),
  R('XSS-16', /\beval\s*\(/i, 'eval 执行', 'warning', 2),
  R('XSS-17', /\\u00(?:3c|3e|22|27)|\\x(?:3c|3e|27|22)/i, '转义尖括号/引号', 'error'),
  R('XSS-18', /&#x?0*(?:3c|3e|60|27|22|00)/i, 'HTML 实体编码载荷', 'warning', 2),
  R('XSS-19', /%3c(?:script|img|svg|iframe|body|div)/i, 'URL 编码标签', 'error'),
  R('XSS-20', /\b(?:alert|prompt|confirm)\s*\(/i, '弹窗函数调用', 'warning', 2),
  R('XSS-21', /<\s*(?:title|textarea|style|noscript|plaintext|xmp)\b[^>]*>/i, '上下文逃逸标签', 'error'),
  R('XSS-22', /constructor\s*\.\s*constructor/i, '原型链构造器', 'error'),
  // 斜杠分隔的事件处理器（<svg/onload=…>）：无空格标签注入形态，合法内容不存在
  R('XSS-24', /<[a-z][^>]*\/\s*on[a-z]+\s*=/i, '斜杠分隔事件处理器', 'critical'),
];
const XSS_NET_ONLY = [
  R('XSS-23', /\b(?:javascript|vbscript)\s*:/i, '裸伪协议（网络面）', 'warning', 1, NET_ONLY),
];

/* ==================== 路径遍历 ==================== */
const TRAVERSAL_PATTERNS = [
  R('TRV-01', /\.\.(?:\/|\\)/i, '目录上跳', 'critical'),
  R('TRV-02', /\.\.%2f|\.\.%5c/i, '编码目录上跳', 'critical'),
  R('TRV-03', /%2e%2e/i, '双点编码', 'error'),
  R('TRV-04', /%c0%ae|%c0%af|%e0%80%ae|%c1%9c/i, '超长 UTF-8 编码', 'critical'),
  R('TRV-05', /\.\.%252f|\.\.%255c/i, '双重编码上跳', 'critical'),
  R('TRV-06', /%00|\u0000/, '空字节', 'critical'),
  R('TRV-07', /\.\.[\\/]{2}/, '连续分隔符上跳', 'error'),
  R('TRV-08', /(?:^|[\\/])\.\.(?:$|[\\/])/i, '独立路径段上跳', 'error'),
  R('TRV-09', /\.\.;/i, '分号参数遍历', 'error'),
  R('TRV-10', /\.\.%u002e|%2e%u002e|%252e%252e/i, '混合编码遍历', 'error'),
];

/* ==================== 命令注入 ====================
 * CMD-01..03 为网络面规则（反引号/$()/${} 在昵称等自由文本是合法写法，
 * 模板字符串 ${name} 不拦）；分号/管道接命令任何字段都属攻击，body 也生效 */
const CMD_NET = [
  R('CMD-01', /`[^`]{2,}`/, '反引号执行', 'error', 1, NET_ONLY),
  R('CMD-02', /\$\([^)]{2,}\)/, '$() 命令替换', 'error', 1, NET_ONLY),
  R('CMD-03', /\$\{[^}]{2,}\}/, '${} 变量展开', 'error', 1, NET_ONLY),
];
const CMD_BODY = [
  R('CMD-04', /;[\s]*(?:ls|dir|cat|id|whoami|uname|pwd|rm|cp|mv|wget|curl|nc|bash|sh|cmd|powershell|tasklist|net\s+user|nslookup|ping|python|perl|php|node|echo|grep|head|tail|sort|base64|awk|sed|find|env|printenv|hostname|mkdir|touch|chown|kill|dd)\b/i, '分号接命令', 'critical'),
  R('CMD-05', /\|[\s]*(?:ls|dir|cat|id|whoami|uname|rm|wget|curl|sh|bash|nc|python|echo|grep|head|tail|sort|base64|awk|sed|find|env|hostname|chown|kill|dd)\b/i, '管道接命令', 'critical'),
  R('CMD-06', /&&[\s]*(?:ls|dir|cat|id|whoami|rm|wget|curl|bash|sh|python|echo|grep|head|tail|sort|base64|env|hostname|chown|kill|dd)\b/i, '&& 接命令', 'critical'),
  R('CMD-07', /\|\|[\s]*(?:ls|dir|cat|id|whoami|rm|echo|grep|head|tail|sort|base64|env|hostname|chown|kill|dd)\b/i, '|| 接命令', 'critical'),
  R('CMD-08', /\b(?:ping|tracert|nslookup|nc)\s+\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i, '网络探测命令', 'critical'),
  R('CMD-09', /\$\{IFS\}/i, 'IFS 变量绕过', 'critical'),
  R('CMD-10', /\b(?:chmod|chown|mkfifo|\/dev\/tcp|\/dev\/udp)\b/i, '权限/设备文件操作', 'critical'),
  R('CMD-11', /(?:^|[;&|])\s*(?:curl|wget|nc|python3?|perl)\s+-[a-z]{1,10}/i, '命令行工具带参', 'critical'),
];

/* ==================== SSRF（仅 query/path 与 body 的 URL 形态字段） ==================== */
const SSRF_PATTERNS = [
  R('SSRF-01', /(?:^|[\s"'=:])(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1)(?:[:/]|$)/i, '环回地址', 'critical'),
  R('SSRF-02', /(?:^|[\s"'=:])(?:https?:\/\/)?10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i, '10 段内网', 'critical'),
  R('SSRF-03', /(?:^|[\s"'=:])(?:https?:\/\/)?192\.168\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i, '192.168 内网', 'critical'),
  R('SSRF-04', /(?:^|[\s"'=:])(?:https?:\/\/)?172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i, '172.16-31 内网', 'critical'),
  R('SSRF-05', /(?:^|[\s"'=:])(?:https?:\/\/)?169\.254\.\d{1,3}\.\d{1,3}(?:[:/]|$)/i, '链路本地/云元数据', 'critical'),
  R('SSRF-06', /(?:^|[\s"'=:])(?:https?:\/\/)?0x7f[\s\S]{0,3}/i, '十六进制 IP 变形', 'critical'),
  R('SSRF-07', /(?:^|[\s"'=:])(?:https?:\/\/)?2130706433(?:\D|$)/i, '十进制 IP 变形', 'critical'),
  R('SSRF-08', /(?:^|[\s"'=:])(?:https?:\/\/)?(?:0177|017700000001)(?:\D|$)/i, '八进制 IP 变形', 'critical'),
  R('SSRF-09', /\b(?:file|gopher|dict|ftp|ldap|redis|expect|telnet|smb)\s*:\/\//i, '非 HTTP 协议', 'error'),
  R('SSRF-10', /(?:^|[\s"'=:])https?:\/\/[0-9.]+(?::\d{1,5})?\/?[^\s]*metadata/i, '云元数据端点', 'critical'),
  R('SSRF-11', /\bhttp:\/\/\[::ffff:/i, 'IPv4-mapped 变形', 'error'),
];

/* ==================== XXE / 反序列化 / 模板注入 ==================== */
const MISC_PATTERNS = [
  R('MSC-01', /<!DOCTYPE[\s\S]{0,80}?(?:SYSTEM|PUBLIC)/i, 'XXE DOCTYPE', 'critical'),
  R('MSC-02', /<!ENTITY[\s\S]{0,80}?(?:SYSTEM|PUBLIC)/i, 'XXE ENTITY', 'critical'),
  R('MSC-03', /\b(?:java\.lang\.|com\.sun\.|org\.apache\.commons)/i, 'Java 内部类引用', 'error'),
  R('MSC-04', /\$\{jndi:/i, 'JNDI 注入', 'critical'),
  R('MSC-05', /class\.module\.classLoader/i, 'Spring classLoader', 'error'),
  R('MSC-06', /["']?@type["']?\s*:\s*["'][a-z][\w.]{2,}["']/i, 'FastJSON 反序列化', 'critical'),
  R('MSC-07', /%\{[#a-zA-Z_$]/i, 'Struts2 OGNL', 'error'),
  R('MSC-08', /#\{\s*T\s*\(/i, 'SpEL 表达式', 'error'),
  R('MSC-09', /Runtime\s*\.\s*getRuntime\b/i, 'getRuntime 命令执行', 'error'),
  R('MSC-10', /__proto__|constructor\s*\.\s*prototype|\[["']__proto__["']\]/i, '原型污染', 'critical'),
  R('MSC-11', /\{\{\s*[0-9]{1,3}\s*[\*\+]\s*['"]?[0-9]{1,3}['"]?\s*\}\}/i, 'SSTI 算术探测', 'warning'),
  R('MSC-12', /\{\{\s*(?:config|self|request|app|g\b|session|url_for|get_flashed_messages|cycler|joiner|namespace)\s*\}\}/i, 'SSTI 全局对象', 'critical'),
  R('MSC-13', /__class__|__mro__|__subclasses__|__globals__|__builtins__|__init__|__import__/i, 'Python 魔术属性', 'warning', 2),
  R('MSC-14', /<%\s*=\s*[a-z_]+/i, 'JSP EL', 'warning', 2),
  R('MSC-15', /<%\s*[a-z_]+\s*\([^)]*\)\s*%>/i, 'ASP 标签', 'critical'),
  R('MSC-16', /#\{\s*\d+\s*\*\s*\d+\s*\}/i, 'Thymeleaf 表达式', 'warning', 2),
  R('MSC-17', /\brO0AB/i, 'Java 序列化载荷', 'error'),
  R('MSC-18', /\b(?:ysoserial|JRMPClient)\b/i, 'Java 反序列化工具', 'error'),
  R('MSC-19', /\b(?:rmi|iiop|t3|coherence)\s*:\/\//i, 'Java 中间件协议', 'error'),
  R('MSC-20', /\b(?:CommonsCollections|CommonsBeanutils|C3P0|ROME|Hibernate1|Spring1)\d{0,2}\b/i, '反序列化链', 'error'),
];

const RULE_GROUPS = {
  SQL: SQL_PATTERNS,
  XSS: [...XSS_SHARED, ...XSS_NET_ONLY],
  TRAVERSAL: TRAVERSAL_PATTERNS,
  CMD: [...CMD_NET, ...CMD_BODY],
  SSRF: SSRF_PATTERNS,
  MISC: MISC_PATTERNS,
};

/** 规则索引（安全中心展示/禁用 + 测试器） */
const RULE_INDEX = {};
for (const [group, rules] of Object.entries(RULE_GROUPS)) {
  for (const r of rules) RULE_INDEX[r.id] = { id: r.id, group, note: r.note, sev: r.sev, pl: r.pl };
}

/* ==================== 豁免即数据：参数 × 规则组作用域化豁免 ====================
 * key（body 字段名，大小写不敏感）→ 该字段自身值豁免的规则组列表。
 * 旧版是整键豁免（等于豁免全部组）；数据化后可按组裁剪——例如给 content
 * 保留 TRAVERSAL 检测只需要从这里删掉 'TRAVERSAL'，不用改引擎。
 * 嵌套子对象不受豁免影响（防把载荷塞进豁免键的嵌套对象绕过）。 */
const PARAM_EXEMPT_GROUPS = {
  content: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  about_content: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  title: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  summary: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  description: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  name: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  site_name: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  site_desc: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  announcement: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  footer: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  social_github: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  social_weibo: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  social_email: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  avatar: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  // 分类主题色（管理端专用，前端 hex 校验；值形如 #123456）
  color: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  // 安全中心解封目标 IP（管理端专用；IPv6 回环 ::1 会被 SSRF 模式误伤）
  ip: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
  form_token: ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'],
};

/** body 中视为「URL 形态」的字段名（SSRF 规则只对这些字段在 body 面生效） */
const URL_FIELD_RE = /^(?:url|link|site|website|homepage|callback|redirect|next|target|src|href|source|domain|host|feed|icon|logo|image|img|cover|avatar|webhook|endpoint|origin)/i;

/* ==================== 扫描器 UA / 蜜罐路径（数据与规则同层维护） ==================== */
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

const INAPP_BROWSER_MARKERS = [
  'micromessenger', 'weixin', 'mmwebsdk', 'mmwebid', 'xweb/',
  'qqbrowser', 'dingtalk', 'alipayclient', 'alipay',
  'baiduboxapp', 'ucbrowser', 'quark', 'lark/', 'feishu',
  'weibo', 'zhihu', 'douyin', 'aweme', 'toutiao',
  'xiaohongshu', 'miuibrowser', 'huaweibrowser', 'heytapbrowser',
  'vivobrowser', 'oppobrowser', 'honorbrowser', 'samsungbrowser',
];

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

module.exports = {
  SEVERITY_SCORE,
  RULE_GROUPS,
  RULE_INDEX,
  PARAM_EXEMPT_GROUPS,
  URL_FIELD_RE,
  SCANNER_UA_PATTERNS,
  INAPP_BROWSER_MARKERS,
  HONEYPOT_PATHS,
};
