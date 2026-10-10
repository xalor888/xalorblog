/**
 * 应用层 WAF 引擎（特征库 + 行为分析）
 *
 * 架构（参考 OWASP CRS / lua-resty-waf 的方法论重建，规则数据见 waf-rules.js）：
 *   1. 变换流水线：每个值产出 [原文, 一层解码, 深度归一化] 变体视图，
 *      规则跑遍全部变体（multiMatch 思路）——编码攻击在任一视图现形，
 *      过度解码藏不住原始编码形态。
 *   2. 异常评分：命中按严重度加权（critical=5 / error=4 / warning=3 / notice=2），
 *      请求结束时对照 anomalyThreshold（默认 5）判定阻断，不再单命中即 403：
 *      一条 critical 一票拦截；低置信度命中累计成势才拦，单条只进监控日志。
 *   3. 偏执分层：规则按误杀风险标 pl1/pl2/pl3，securitySettings.paranoiaLevel
 *      控制启用上限；高误杀规则（eval()/alert()/模板字符串等技术讨论常见形态）
 *      命中只计分不误拦正常搜索与评论。
 *   4. 兜底不变：参数化查询 + sanitize-html 输出清洗才是最后防线，
 *      WAF 是采集成本抬升层，不是唯一防线。
 *
 * 检测维度（与旧版一致）：
 *   特征规则（SQLi/XSS/路径遍历/CMDi/SSRF/XXE/SSTI/反序列化）· 扫描器 UA ·
 *   蜜罐路径 · 404 爆破 · UA 轮换 · JSON 炸弹 · 请求走私 · 方法白名单
 * 命中联动 IP 信誉系统；规则组/单条规则可经安全中心配置禁用。
 */

const { report, logEvent } = require('./ipGuard');
const config = require('../config');
const securitySettings = require('../utils/securitySettings');
const {
  SEVERITY_SCORE,
  RULE_GROUPS,
  RULE_INDEX,
  PARAM_EXEMPT_GROUPS,
  URL_FIELD_RE,
  SCANNER_UA_PATTERNS,
  INAPP_BROWSER_MARKERS,
  HONEYPOT_PATHS,
} = require('./waf-rules');

const HONEYPOT_SET = new Set(HONEYPOT_PATHS);

/* ==================== 解码归一化（变换流水线） ==================== */

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

/** 变换流水线：命名视图列表。规则匹配遍历全部视图（multiMatch）。
 *  视图去重：原文与解码结果相同时不重复匹配（省一半正则开销）。 */
function buildVariants(text) {
  const v1 = decodeLevel1(text);
  const v2 = decodeLevel2(text);
  const variants = [text];
  if (v1 !== text) variants.push(v1);
  if (v2 !== v1 && v2 !== text) variants.push(v2);
  return variants;
}

/* ==================== 检测引擎 ==================== */

/** 各扫描面激活的规则组（scope: path | query | header | body）——顺序即 scanText 首命中优先级。
 *  网络面限制（XSS-23/CMD-01..03 等）由规则自身的 zones 字段过滤，不再拆双数组。
 *  SSRF 仅 query/path：header 面不扫（本地 referer / 代理链 XFF 合法含内网地址）。 */
function scopeGroups(scope, sec) {
  const g = sec.groups;
  const on = (key) => g[key] !== false;
  const ssrfOn = (scope === 'query' || scope === 'path') && on('SSRF');
  return [
    ...(on('SQL') ? ['SQL'] : []),
    ...(on('XSS') ? ['XSS'] : []),
    ...(on('TRAVERSAL') ? ['TRAVERSAL'] : []),
    ...(on('CMD') ? ['CMD'] : []),
    ...(ssrfOn ? ['SSRF'] : []),
    ...(on('MISC') ? ['MISC'] : []),
  ];
}

/** 扫描前的公共准备：设置快照、禁用集、变体视图 */
function prepareScan(text, sec) {
  if (typeof text !== 'string' || !text.length) return null;
  if (text.length > 4000) text = text.slice(0, 4000);
  const disabled = sec.disabledRules.length ? new Set(sec.disabledRules) : null;
  return { text, sec, disabled, variants: buildVariants(text) };
}

/** 单组内跑规则（含 zones 面过滤 / PL 门控 / 禁用 / skipGroups），返回全部命中 */
function runGroupRules(rules, ctx, scope, skipGroups) {
  const { sec, disabled, variants } = ctx;
  const pl = Number(sec.paranoiaLevel) || 1;
  const hits = [];
  for (const rule of rules) {
    if (rule.zones && !rule.zones.includes(scope)) continue; // 扫描面过滤
    if (rule.pl > pl) continue; // 偏执门控：高于当前等级的规则不参与
    if (disabled && disabled.has(rule.id)) continue;
    // 参数豁免按**规则所属组**判断，不能拿规则 ID 前缀当组名：
    // TRAVERSAL 组的规则 ID 是 TRV-xx、MISC 组是 MSC-xx，前缀与组名不一致，
    // 用 ID 前缀判断会让这两组的豁免静默失效 —— 表现为「正文里写 ../../etc/passwd
    // 或 __proto__ 这类技术讨论被 403」，与 PARAM_EXEMPT_GROUPS 的声明相反。
    // 组的权威来源是 RULE_INDEX（RULE_INDEX 覆盖全部规则，见 test/waf-fixtures.test.js 的覆盖率门禁）。
    if (skipGroups && skipGroups.includes(RULE_INDEX[rule.id]?.group)) continue;
    for (const v of variants) {
      if (rule.re.test(v)) {
        hits.push({
          id: rule.id,
          group: RULE_INDEX[rule.id]?.group || '',
          note: rule.note,
          sev: rule.sev,
          score: SEVERITY_SCORE[rule.sev] ?? 4,
          pl: rule.pl,
          variant: variants.indexOf(v),
        });
        break; // 同一规则命中即止（多视图只记首个命中视图）
      }
    }
  }
  return hits;
}

/** CRLF：日志/头注入向量，仅网络面（body 的多行文本合法）；含编码变体 */
function crlfCheck(ctx, disabled) {
  if (disabled && disabled.has('MSC-CRLF')) return null;
  for (const v of ctx.variants) {
    if (/[\r\n]/.test(v)) {
      return { id: 'MSC-CRLF', group: 'MISC', note: 'CRLF 注入', sev: 'error', score: 4, pl: 1, variant: ctx.variants.indexOf(v) };
    }
  }
  return null;
}

/**
 * 全量扫描：返回 { hits, score }。命中不提前终止（评分需要全景），
 * 每个（文本 × 组）仍按规则序展开；由调用方控制扫描面数量。
 */
function scanAll(text, scope = 'body', { urlKey = false, skipGroups = null } = {}) {
  const sec = securitySettings.getConfig();
  const ctx = prepareScan(text, sec);
  if (!ctx) return { hits: [], score: 0 };
  const groups = scopeGroups(scope, sec);
  if (scope === 'body' && urlKey && sec.groups.SSRF !== false) groups.push('SSRF');

  const hits = [];
  for (const g of groups) {
    hits.push(...runGroupRules(RULE_GROUPS[g], ctx, scope, skipGroups));
  }
  if (scope !== 'body') {
    const c = crlfCheck(ctx, ctx.disabled);
    if (c) hits.push(c);
  }
  const score = hits.reduce((sum, h) => sum + (h.score || 0), 0);
  return { hits, score };
}

/**
 * 兼容接口：返回首个命中（按扫描面组序，与旧版语义一致）。
 * 命中对象扩展了 sev/score/pl/note 字段（向后兼容：{ id, group } 仍成立）。
 */
function scanText(text, scope = 'body', opts = {}) {
  const { hits } = scanAll(text, scope, opts);
  return hits[0] || null;
}

/** 兼容旧导出：返回命中组名或 null（waf 测试/调试用） */
function detectAttack(text) {
  const hit = scanText(text, 'query');
  return hit ? hit.group : null;
}

/* ==================== 请求面辅助（与规则数据同层导出，供测试复用） ==================== */

/** 扫描器 UA 检测 */
function isScannerUA(ua) {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return SCANNER_UA_PATTERNS.some((p) => lower.includes(p));
}

function isInAppBrowserUA(ua) {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return INAPP_BROWSER_MARKERS.some((m) => lower.includes(m));
}

/** 需要检测的请求头（头注入 / 恶意特征） */
const CHECK_HEADERS = ['cookie', 'x-forwarded-for', 'x-real-ip', 'referer', 'x-requested-with', 'x-auth-token', 'authorization'];

/**
 * body 递归扫描（纯函数，供中间件与语料测试共用）。
 * 豁免是数据驱动的参数 × 规则组作用域豁免（waf-rules.js PARAM_EXEMPT_GROUPS）：
 * 豁免只作用于该键自身的值，嵌套子对象照常检测（防塞进豁免键的嵌套对象绕过）。
 * 返回 { hits, score, scanned }（scanned = 本次实际扫描的字符串数，用于成本上限）。
 */
const MAX_SCANNED_VALUES = 200; // 单请求扫描字符串上限：防超大 body 拖垮正则预算

function scanRequestBody(body) {
  const hits = [];
  let scanned = 0;
  const walk = (node) => {
    if (scanned >= MAX_SCANNED_VALUES) return;
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      // 键名本身也过检测（旧版行为；键名不受参数豁免影响）
      if (scanned < MAX_SCANNED_VALUES) {
        scanned += 1;
        hits.push(...scanAll(k, 'body').hits);
      }
      if (v && typeof v === 'object') {
        walk(v);
        continue;
      }
      if (scanned >= MAX_SCANNED_VALUES) return;
      scanned += 1;
      const exemptGroups = PARAM_EXEMPT_GROUPS[String(k).toLowerCase()];
      const skipGroups = exemptGroups && exemptGroups.length ? exemptGroups : null;
      const urlKey = !skipGroups && URL_FIELD_RE.test(k);
      const r = scanAll(typeof v === 'string' ? v : String(v), 'body', { urlKey, skipGroups });
      hits.push(...r.hits);
      if (hits.length > 32) return; // 命中足够多，评分必然过阈，省预算
    }
  };
  walk(body);
  const score = hits.reduce((sum, h) => sum + (h.score || 0), 0);
  return { hits, score, scanned };
}

/* ==================== 行为检测（404 爆破 / UA 轮换） ==================== */

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
  /^\/health(?:\/(?:live|ready))?$/i,
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
  rec.uas.add(ua.slice(0, 200));
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

/* ==================== JSON 炸弹防护 ==================== */

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

/* ==================== WAF 中间件 ==================== */

/**
 * WAF 中间件：基线检查（硬拦，与 CRS 内部规则同位）+ 特征评分（延后判定）。
 * 免检的 body 字段见 waf-rules.js PARAM_EXEMPT_GROUPS（数据驱动，可按组裁剪）。
 */
function waf(req, res, next) {
  const ip = req.ip || 'unknown';
  const sec = securitySettings.getConfig();
  // 所有拒绝响应不落任何缓存
  res.set('Cache-Control', 'no-store');

  // ---- 0. 方法白名单 + 请求基线体积（前置防线，先于一切特征检测；一票硬拦） ----
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

  // ---- 1. 扫描器 UA（一票硬拦）----
  const ua = String(req.headers['user-agent'] || '');
  if (sec.scannerUaBlock && ua && isScannerUA(ua)) {
    report(ip, 'waf', `SCANNER ${req.path}`);
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  // 超长 UA：畸形/扫描器特征。阈值按客户端类型分档 —— 普通客户端 512，
  // 应用内 WebView（微信 380+、支付宝/QQ 同类）给 2048。
  const uaLimit = isInAppBrowserUA(ua) ? 2048 : 512;
  if (ua.length > uaLimit) {
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

  // ---- 2. 特征检测：path / query / body 值 / body 键名 / 关键头（评分累积） ----
  const hits = [];
  // 文章 slug 段由服务端 slugify 生成（仅 [a-z0-9-]），跳过特征检测防误伤
  const pathTarget = req.path.replace(/\/slug\/[^/]*$/i, '/slug/');
  hits.push(...scanAll(pathTarget, 'path').hits);
  // query 键名与值递归提取：数组/嵌套参数同样纳入检测。
  // keyword 是自由文本搜索词：键名跳过，但**值必须照常检测**（SSRF 组除外——
  // 搜索词里出现内网 IP 文本属正常讨论内容）。
  let keyInjected = false;
  const collectQuery = (node) => {
    if (node === null || typeof node === 'undefined') return;
    if (Array.isArray(node)) {
      for (const item of node) collectQuery(item);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (!keyInjected && /^(?:__proto__|constructor|prototype)$/i.test(k)) keyInjected = true;
        const isKeyword = /^keyword$/i.test(k);
        if (!isKeyword) {
          hits.push(...scanAll(k, 'query').hits);
        }
        if (v !== null && typeof v === 'object') {
          collectQuery(v);
          continue;
        }
        hits.push(...scanAll(String(v), 'query', isKeyword ? { skipGroups: ['SSRF'] } : {}).hits);
      }
      return;
    }
    hits.push(...scanAll(String(node), 'query').hits);
  };
  collectQuery(req.query);
  // 头部：注入类特征检测（不含 SSRF —— 本地 referer / 代理链 XFF 合法含内网地址）
  for (const h of CHECK_HEADERS) {
    if (req.headers[h]) {
      hits.push(...scanAll(String(req.headers[h]).slice(0, 2000), 'header').hits);
    }
  }

  const body = req.body || {};
  // JSON 炸弹防护：嵌套过深或数组过长
  if (typeof body === 'object' && body !== null && !bodyShapeSafe(body)) {
    report(ip, 'waf', `JSON-BOMB ${req.method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }
  const bodyScan = scanRequestBody(body);
  hits.push(...bodyScan.hits);
  // 键名专用检测：孤立原型污染关键字（键名不在值检测的豁免范围内）
  for (const k of collectKeys(body)) {
    if (/^(?:__proto__|constructor|prototype)$/i.test(k)) keyInjected = true;
  }

  // ---- 3. 判定：硬特征（键名注入）一票拦截；其余按异常分对照阈值 ----
  const threshold = Number(sec.anomalyThreshold) || 5;
  const score = hits.reduce((sum, h) => sum + (h.score || 0), 0);
  const topIds = [...new Set(hits.map((h) => h.id))].slice(0, 4).join(',');

  if (keyInjected) {
    report(ip, 'waf', `MSC-KEY-INJECT ${req.method} ${req.path}`);
    console.warn(`[waf] MSC-KEY-INJECT(MISC) blocked: ${ip} ${req.method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }
  if (score >= threshold) {
    report(ip, 'waf', `SCORE:${score} ${topIds} ${req.method} ${req.path}`);
    console.warn(`[waf] score=${score} (${topIds}) blocked: ${ip} ${req.method} ${req.path}`);
    return res.status(403).json({ code: 1, message: '请求被拒绝' });
  }
  if (score > 0) {
    // 监控态：低分可疑请求不拦截、不记信誉分，只留安全事件供调参
    logEvent('waf-mon', ip, `${req.method} ${req.path}`, `score=${score} ${topIds}`);
  }

  next();
}

/** 收集 body 全部键名（供原型污染键检测） */
function collectKeys(node, out = [], depth = 0) {
  if (depth > MAX_BODY_DEPTH || node === null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    out.push(k);
    if (v && typeof v === 'object' && out.length < 500) collectKeys(v, out, depth + 1);
  }
  return out;
}

/** 404 处理器使用：记录未命中路径（目录爆破检测） */
function recordMiss(ip, path) {
  if (!ip || typeof path !== 'string') return false;
  const sec = securitySettings.getConfig();
  if (!sec.scan404Enabled) return false;
  // 静态资源、已知引导路径与浏览器默认请求不计数，避免误报
  if (path.startsWith('/uploads/') || path === '/' || path === '/robots.txt' || path === '/sitemap.xml' || path === '/rss.xml') return false;
  if (MISS_EXEMPT_RE.some((re) => re.test(path))) return false;
  if (trackMiss(ip, sec.scanThreshold)) {
    report(ip, 'scan', `404 扫描 ${path}`);
    return true;
  }
  return false;
}

module.exports = {
  waf,
  scanText,
  scanAll,
  detectAttack,
  recordMiss,
  isScannerUA,
  scanRequestBody,
  HONEYPOT_SET,
  RULE_INDEX,
  RULE_GROUPS,
  SEVERITY_SCORE,
};
