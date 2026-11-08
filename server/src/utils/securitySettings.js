/**
 * 安全配置层（安全中心可视化管理的统一配置源）
 * - 默认值来自代码/环境变量；覆盖值存独立 security_config 表（单行 JSON）
 *   —— 不入 settings 表：公开 /api/settings 全量透出，安全配置（白名单等）不可泄露
 * - 读路径全同步（内存缓存）：WAF/信誉中间件每请求调用，不能等 DB
 * - 保存时强校验 + 缓存失效；DB 不可用时降级为纯默认值（防护不失效）
 */

const net = require('net');
const db = require('../db');

/* ==================== 默认值 ==================== */

const GROUP_KEYS = ['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF', 'MISC'];

const DEFAULT_CONFIG = {
  // 规则组开关（waf.js 六组特征检测）
  groups: { SQL: true, XSS: true, TRAVERSAL: true, CMD: true, SSRF: true, MISC: true },
  // 单条规则禁用（规则 ID 见 waf.js RULE_INDEX）
  disabledRules: [],
  // 扫描器/AI 爬虫 UA 硬拦
  scannerUaBlock: true,
  // 蜜罐路径
  honeypotEnabled: true,
  // 404 目录爆破检测
  scan404Enabled: true,
  // 404 扫描阈值：30 秒窗口内 ≥N 次 404 判定扫描
  scanThreshold: 12,
  // WAF 偏执等级：规则按误杀风险标 pl1/pl2/pl3，仅启用 ≤ 本等级的规则（1-3）
  paranoiaLevel: 1,
  // WAF 异常分阻断阈值：命中按严重度加权累计（critical=5/error=4/warning=3），
  // 请求总分 ≥ 阈值才 403；低分命中只进监控日志（waf-mon 事件），不记信誉分
  anomalyThreshold: 5,
  // 信誉系统：触发封禁的积分阈值与各行为权重
  banScore: 10,
  weights: { honeypot: 6, waf: 3, auth: 3, rate: 2, spam: 1 },
  // 首次封禁时长（分钟）/ 封禁上限（小时）
  baseBanMinutes: 15,
  maxBanHours: 24,
  // 距上次封禁超过 N 天，累犯轮次归零重新累计（0 = 永不重置）
  banCountResetDays: 30,
  // IP 白名单（IP 或 CIDR）：不记分、不封禁
  trustedIps: String(process.env.TRUSTED_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // 内容审核：自定义硬拒敏感词（追加到 antiSpam 词库）
  customSensitiveWords: [],
  // 豁免词：文本命中敏感词但同时包含豁免词时，跳过该敏感词判定
  // （例：豁免词「回收」→「Java 垃圾回收」不再命中辱骂词「垃圾」）
  allowWords: [],
};

/** 各数值字段的合法区间 [min, max] */
const NUMERIC_RANGES = {
  scanThreshold: [3, 100],
  paranoiaLevel: [1, 3],
  anomalyThreshold: [3, 20],
  banScore: [5, 100],
  'weights.honeypot': [1, 20],
  'weights.waf': [1, 20],
  'weights.auth': [1, 20],
  'weights.rate': [1, 20],
  'weights.spam': [1, 20],
  baseBanMinutes: [1, 1440],
  maxBanHours: [1, 720],
  banCountResetDays: [0, 365],
};

const LIST_LIMITS = {
  disabledRules: 200,
  trustedIps: 50,
  customSensitiveWords: 100,
  allowWords: 100,
};

/* ==================== IP/CIDR 匹配 ==================== */

/** 解析 "a.b.c.d/nn" 形态；返回 { bytes, prefixLen } 或 null */
function parseIpWithPrefix(token) {
  const [addr, prefixRaw] = String(token).split('/');
  if (!addr || !net.isIP(addr)) return null;
  const maxBits = net.isIP(addr) === 6 ? 128 : 32;
  let prefixLen = maxBits;
  if (prefixRaw !== undefined) {
    if (!/^\d{1,3}$/.test(prefixRaw)) return null;
    prefixLen = Number(prefixRaw);
    if (prefixLen < 0 || prefixLen > maxBits) return null;
  }
  const bytes = Buffer.from(net.isIPv4(addr) ? ip4ToBytes(addr) : ip6ToBytes(addr));
  return { bytes, prefixLen, v4: net.isIPv4(addr) };
}

function ip4ToBytes(addr) {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error('bad ipv4');
  }
  return parts;
}

function ip6ToBytes(addr) {
  let head = addr;
  let tail = '';
  const dc = addr.split('::');
  if (dc.length > 2) throw new Error('bad ipv6');
  if (dc.length === 2) {
    [head, tail] = dc;
  }
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  // IPv4-mapped 尾段（::ffff:1.2.3.4）
  const last = tailParts[tailParts.length - 1];
  if (last && last.includes('.')) {
    const v4 = ip4ToBytes(last);
    tailParts.splice(-1, 1, ((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
  }
  const missing = 8 - headParts.length - tailParts.length;
  if (dc.length === 2 ? missing < 0 : missing !== 0) throw new Error('bad ipv6');
  const groups = [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) throw new Error('bad ipv6');
  return groups.map((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]).flat();
}

/** 单个 CIDR 项与来源 IP 匹配（缓存解析结果避免每请求重复解析） */
const cidrCache = new Map();
function matchesCidr(entry, ip) {
  let parsed = cidrCache.get(entry);
  if (parsed === undefined) {
    try {
      parsed = parseIpWithPrefix(entry);
    } catch (e) {
      parsed = null;
    }
    cidrCache.set(entry, parsed);
    if (cidrCache.size > 500) cidrCache.clear();
  }
  if (!parsed) return false;
  let target;
  try {
    target = net.isIPv4(ip) ? Buffer.from(ip4ToBytes(ip)) : Buffer.from(ip6ToBytes(ip));
  } catch (e) {
    return false;
  }
  // IPv4 来源与 IPv4-mapped IPv6 CIDR 互通
  if (parsed.v4 !== (target.length === 4)) {
    if (parsed.v4) {
      if (target.length !== 16) return false;
      // 检查是否为标准 IPv4-mapped 格式（前 10 字节为 0，第 11-12 字节为 0xff）
      const isMapped = target.slice(0, 10).every((b) => b === 0) && target[10] === 0xff && target[11] === 0xff;
      if (!isMapped) return false;
      target = target.slice(12);
    } else {
      if (target.length !== 4) return false;
      target = Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), target]);
    }
  }
  if (target.length !== parsed.bytes.length) return false;
  let remaining = parsed.prefixLen;
  for (let i = 0; i < target.length; i++) {
    if (remaining <= 0) break;
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((target[i] & mask) !== (parsed.bytes[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/* ==================== 缓存与加载 ==================== */

let cache = cloneDefaults();
let loaded = false;
let loadPromise = null;
// 最近一次加载失败原因（排查用；加载成功后清空）
let lastError = null;
// 同一条加载错误只记一次日志（DB 长时间不可用时每 30s 一行会把日志刷满）
let lastLoggedError = '';
// 加载失败后的重试时间点：DB 抖动不能把默认值固化整个进程生命周期
let nextRetryAt = 0;
const LOAD_RETRY_MS = 30 * 1000;

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * 解析 security_config.data 单行 JSON；损坏时抛错。
 * 解析失败不能当成「没有配置」：那会让上层把默认值写成权威值（见 saveConfig）。
 */
function parseRowData(data) {
  if (data === null || data === undefined || data === '') return null;
  // mysql2 对 JSON 列可能直接返回对象，也可能是字符串，两种形态都接受
  const parsed = typeof data === 'object' ? data : JSON.parse(data);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/**
 * 读路径（WAF/信誉中间件每请求调用，必须同步、不能等 DB）：
 * 返回此刻内存 cache，加载在后台进行。
 *
 * 这里用 nextRetryAt 限流重试，而不是「失败一次就 loaded=true」：
 * 原实现无论成功失败都置 loaded，于是启动瞬间 DB 抖一下 → 默认值被固化，
 * 之后整进程都跑在默认配置上（白名单失效、偏执等级回落、自定义敏感词消失），
 * 且日志里没有任何痕迹。现在只在真正读到配置（或确认无配置行）后才置 loaded。
 */
function getConfig() {
  if (!loaded && !loadPromise && Date.now() >= nextRetryAt) {
    loadPromise = reload()
      .catch(() => {})
      .finally(() => {
        loadPromise = null;
      });
  }
  return cache;
}

/**
 * 从库重新加载。成功才置 loaded；失败保持 cache 不变（宁可继续用上一份有效配置，
 * 也不要把默认值顶上去），并记录 lastError + 退避时间供 getConfig 下次重试。
 */
async function reload() {
  try {
    const rows = await db('security_config').where('id', 'config').select('data').limit(1);
    if (rows.length && rows[0].data) {
      const parsed = parseRowData(rows[0].data);
      cache = mergeValid(DEFAULT_CONFIG, parsed || {});
    }
    loaded = true;
    lastError = null;
    nextRetryAt = 0;
    lastLoggedError = '';
  } catch (e) {
    // 表不存在 / DB 不可用 / 行内 JSON 损坏：保持现状并等退避到点后重试。
    // 必须留一行日志：原实现静默吞掉异常，运维完全看不出「整站正跑在默认配置上」
    lastError = e;
    nextRetryAt = Date.now() + LOAD_RETRY_MS;
    const msg = e && e.message ? e.message : String(e);
    if (msg !== lastLoggedError) {
      lastLoggedError = msg;
      console.error(
        `[securitySettings] 安全配置加载失败，将每 ${Math.round(LOAD_RETRY_MS / 1000)}s 重试（同一错误只记一次）:`,
        msg,
      );
    }
  }
  return cache;
}

/**
 * 深合并已知键，仅保留类型合法的值。
 *
 * base = 当前生效配置，patch = 本次提交的增量。两者都必须参与合并：
 * 原实现从 cloneDefaults() 起步、完全忽略 base，于是「局部保存」等于
 * 「把没提交的字段全部重置成默认值」。实测连续两次 PUT：
 *   1) { trustedIps:['9.9.9.9'], customSensitiveWords:['坏词'], banScore:42, groups:{SQL:false} }
 *   2) { paranoiaLevel: 2 }
 * 第二次保存后白名单、敏感词库、封禁阈值、规则组开关全部回到默认
 * （trustedIps=[]、banScore=10、groups.SQL=true）—— 站长只是想调一个偏执等级，
 * 结果悄悄清空了可信 IP 白名单（自己开始被限流/封禁）和自定义敏感词。
 * 前端 SecurityManage 目前每次提交完整 cfg，所以这个 bug 只在
 * 部分提交（脚本、第三方面板、PATCH 语义调用）时暴露，属于典型的「安静地错」。
 */
function mergeValid(base, patch) {
  const out = cloneDefaults();
  const src = base && typeof base === 'object' ? base : {};
  // 先整体继承 base 的合法值（逐字段校验与下面 patch 分支同一套规则）
  for (const key of ['scannerUaBlock', 'honeypotEnabled', 'scan404Enabled']) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  for (const key of ['scanThreshold', 'paranoiaLevel', 'anomalyThreshold', 'banScore', 'baseBanMinutes', 'maxBanHours', 'banCountResetDays']) {
    if (src[key] !== undefined) {
      const v = Number(src[key]);
      const [min, max] = NUMERIC_RANGES[key];
      if (Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, Math.round(v)));
    }
  }
  if (src.groups && typeof src.groups === 'object') {
    for (const k of GROUP_KEYS) {
      if (typeof src.groups[k] === 'boolean') out.groups[k] = src.groups[k];
    }
  }
  if (src.weights && typeof src.weights === 'object') {
    for (const k of Object.keys(out.weights)) {
      const v = Number(src.weights[k]);
      const [min, max] = NUMERIC_RANGES[`weights.${k}`] || [0, Infinity];
      if (Number.isFinite(v)) out.weights[k] = Math.min(max, Math.max(min, Math.round(v)));
    }
  }
  if (Array.isArray(src.disabledRules)) {
    out.disabledRules = src.disabledRules
      .filter((r) => typeof r === 'string' && /^[A-Z]+-\d{1,3}$/.test(r))
      .slice(0, LIST_LIMITS.disabledRules);
  }
  if (Array.isArray(src.trustedIps)) {
    out.trustedIps = src.trustedIps
      .filter((s) => typeof s === 'string' && s.length <= 64 && isValidIpOrCidr(s))
      .slice(0, LIST_LIMITS.trustedIps);
  }
  if (Array.isArray(src.customSensitiveWords)) {
    out.customSensitiveWords = src.customSensitiveWords
      .map((s) => String(s || '').trim())
      .filter((s) => s.length >= 2 && s.length <= 40)
      .slice(0, LIST_LIMITS.customSensitiveWords);
  }
  if (Array.isArray(src.allowWords)) {
    out.allowWords = src.allowWords
      .map((s) => String(s || '').trim())
      .filter((s) => s.length >= 1 && s.length <= 40)
      .slice(0, LIST_LIMITS.allowWords);
  }

  // 再叠加本次 patch（patch 里出现的键才覆盖）
  const groups = { ...out.groups };
  if (patch.groups && typeof patch.groups === 'object') {
    for (const k of GROUP_KEYS) {
      if (typeof patch.groups[k] === 'boolean') groups[k] = patch.groups[k];
    }
  }
  out.groups = groups;
  if (patch.weights && typeof patch.weights === 'object') {
    const weights = { ...out.weights };
    for (const k of Object.keys(weights)) {
      const v = Number(patch.weights[k]);
      const [min, max] = NUMERIC_RANGES[`weights.${k}`] || [0, Infinity];
      if (Number.isFinite(v)) weights[k] = Math.min(max, Math.max(min, Math.round(v)));
    }
    out.weights = weights;
  }
  if (Array.isArray(patch.disabledRules)) {
    out.disabledRules = patch.disabledRules
      .filter((r) => typeof r === 'string' && /^[A-Z]+-\d{1,3}$/.test(r))
      .slice(0, LIST_LIMITS.disabledRules);
  }
  if (Array.isArray(patch.trustedIps)) {
    out.trustedIps = patch.trustedIps
      .filter((s) => typeof s === 'string' && s.length <= 64 && isValidIpOrCidr(s))
      .slice(0, LIST_LIMITS.trustedIps);
  }
  if (Array.isArray(patch.customSensitiveWords)) {
    out.customSensitiveWords = patch.customSensitiveWords
      .map((s) => String(s || '').trim())
      .filter((s) => s.length >= 2 && s.length <= 40)
      .slice(0, LIST_LIMITS.customSensitiveWords);
  }
  if (Array.isArray(patch.allowWords)) {
    out.allowWords = patch.allowWords
      .map((s) => String(s || '').trim())
      .filter((s) => s.length >= 1 && s.length <= 40)
      .slice(0, LIST_LIMITS.allowWords);
  }
  for (const boolKey of ['scannerUaBlock', 'honeypotEnabled', 'scan404Enabled']) {
    if (typeof patch[boolKey] === 'boolean') out[boolKey] = patch[boolKey];
  }
  for (const numKey of ['scanThreshold', 'paranoiaLevel', 'anomalyThreshold', 'banScore', 'baseBanMinutes', 'maxBanHours', 'banCountResetDays']) {
    if (patch[numKey] !== undefined) {
      const v = Number(patch[numKey]);
      const [min, max] = NUMERIC_RANGES[numKey];
      if (Number.isFinite(v)) out[numKey] = Math.min(max, Math.max(min, Math.round(v)));
    }
  }
  return out;
}

function isValidIpOrCidr(token) {
  try {
    return parseIpWithPrefix(token) !== null;
  } catch (e) {
    return false;
  }
}

/**
 * 保存（强校验后整体覆盖写入并刷新缓存）。返回合并后的完整配置。
 *
 * base 必须来自**库内权威行**，不能用 getConfig()：cache 可能正是一份「加载失败后
 * 保留下来的默认值」（见 reload），拿它做合并就等于让一次 DB 抖动 + 一次局部保存
 * 把白名单/敏感词/阈值整体洗成默认——站长只改了偏执等级，却在不知情的情况下
 * 清空了自己的可信 IP 白名单。所以默认路径是「先 await 读库，再合并，再写库」。
 * 读库失败（含行内 JSON 损坏）直接抛错，让调用方 500：宁可保存失败、站长重试，
 * 也不要写回一份基于默认值的配置把库里的真实配置覆盖掉。
 *
 * options.base / options.persist 是给测试与明确调用方的注入口：
 *   · base    跳过读库，直接用作合并基线；
 *   · persist false 只合并不落库。
 * 线上路径（admin PUT /security/config）不传 options，行为与上面完全一致——
 * 这两个选项只能「少做一次 IO」，不能绕过校验，也不改变写库内容。
 */
async function saveConfig(patch, options = {}) {
  const opts = options || {};
  let persisted = opts.base;
  if (persisted === undefined) {
    const rows = await db('security_config').where('id', 'config').select('data').limit(1);
    persisted = rows.length ? parseRowData(rows[0].data) : null;
  }
  const merged = mergeValid(persisted || DEFAULT_CONFIG, patch || {});
  if (opts.persist !== false) {
    const json = JSON.stringify(merged);
    await db('security_config')
      .insert({ id: 'config', data: json, updated_at: db.fn.now() })
      .onConflict('id')
      .merge({ data: json, updated_at: db.fn.now() });
  }
  cache = merged;
  loaded = true;
  lastError = null;
  nextRetryAt = 0;
  return merged;
}

/** 来源 IP 是否命中白名单 */
function isTrustedIp(ip) {
  const list = getConfig().trustedIps;
  if (!list.length || !ip) return false;
  const raw = String(ip).trim();
  // IPv4-mapped IPv6 归一为 IPv4 再比对
  const norm = raw.toLowerCase().startsWith('::ffff:') ? raw.slice(7) : raw;
  return list.some((entry) => entry === raw || entry === norm || matchesCidr(entry, norm));
}

/**
 * 词库豁免：判断**某一个具体敏感词**的这次命中，能否被豁免词放行。
 *
 * 语义边界（这里绕过一次，整个硬拒层就等于不存在）：
 *   · 豁免是「对某一条判定的豁免」，不是「对整段文本的豁免」。
 *   · 因此必须回答的是「被命中的词 word，是否以豁免词为上下文出现的」，
 *     而不是「这段文本里有没有出现过豁免词」。
 *
 * 原实现忽略 matchedWord，只要文本里含任一豁免词就返回 true：
 *   allowWords=['回收'] 之后，「讲垃圾回收的文章，加微信领取」里的「加微信」
 *   也被跳过 —— 一条带引流话术的垃圾评论直接通过 antiSpam 硬拒层。
 *
 * 上一版把判定改成 `lower.includes(matched) && 含任一豁免词`，仍然不够：
 * 只要那段文本里**恰好**同时出现「回收」和「加微信」，两个条件就都成立，
 * 于是「垃圾回收，加微信领取」照样放行。问题在于把两个**独立存在**的
 * 事实当成了「共存关系」，而没有任何位置约束。
 *
 * 现在按「严格相邻」判定：豁免词必须与被命中词**重叠或直接相邻**
 * （中间不隔任何字符），才算该词以它为上下文。这正好对上豁免机制的本意 ——
 * 管理员配豁免词，是为了给某个复合词放行（「垃圾回收」「暴力破解」这类
 * 由敏感词+补语构成的正常术语），而不是给整段文本开白名单。
 *
 * 用「垃圾回收」这个本意用例验一遍（敏感词含「垃圾」「加微信」，豁免词「回收」）：
 *   · 「Java 的垃圾回收机制」    → 回收[2,4) 紧邻 垃圾[0,2) → 只豁免「垃圾」（正确）
 *   · 「垃圾回收，加微信领取」    → 加微信[5,8) 与 回收[2,4) 隔着逗号 → 不豁免（正确）
 *   · 「垃圾回收，博彩网站推荐」  → 同上，博彩不被豁免（正确）
 *   · 「垃圾处理技术讨论」        → 无「回收」→ 正常命中「垃圾」（正确）
 *
 * 为什么不用「距离不超过 N 字符」的窗口：中文一句话里任意两词的间距通常都
 * 小于 20 字，任何宽松窗口都会退化成「整段放行」—— 我第一版就是 20，
 * 实测「垃圾回收，加微信领取」里两词只隔一个逗号，直接被放过。
 *
 * @param {string} text 待判定文本
 * @param {string} matchedWord 本次命中的敏感词（不传则退化为「是否含豁免词」）
 */
function isAllowedText(text, matchedWord) {
  const allow = getConfig().allowWords;
  if (!allow.length) return false;
  const lower = String(text || '').toLowerCase();
  const matched = String(matchedWord || '').trim().toLowerCase();
  // 未传命中词：保持既有调用点语义（只想知道「文本里有没有豁免词」）
  if (!matched) return allow.some((w) => lower.includes(String(w).toLowerCase()));

  // 命中词自身的所有出现位置
  const hitPositions = [];
  for (let i = lower.indexOf(matched); i !== -1; i = lower.indexOf(matched, i + 1)) {
    hitPositions.push([i, i + matched.length]);
  }
  if (!hitPositions.length) return false;

  // 任一豁免词，只要与**某一个**命中位置重叠或直接相邻，就认为该次命中是良性用法
  for (const rawAllow of allow) {
    const w = String(rawAllow || '').trim().toLowerCase();
    if (!w) continue;
    for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + 1)) {
      const allowStart = i;
      const allowEnd = i + w.length;
      for (const [hs, he] of hitPositions) {
        // 两个区间的空隙：重叠时为 0，完全相邻时也为 0，隔字符则为实际间隔数
        const gap = Math.max(0, Math.max(hs, allowStart) - Math.min(he, allowEnd));
        if (gap === 0) return true;
      }
    }
  }
  return false;
}

/** 追加自定义敏感词后的完整硬拒词库（antiSpam 调用） */
function getCustomWords() {
  return getConfig().customSensitiveWords;
}

/**
 * 测试专用：直接覆写内存配置（不落库、不失效其他进程）；仅测试套件使用。
 * 同时置 loaded：否则下一次 getConfig() 会再踢一次 reload，把注入值覆盖回库内值
 * （测试在无 DB 环境下跑，还会白等一次连接超时）。
 */
function setConfigForTest(patch) {
  cache = mergeValid(cache, patch || {});
  loaded = true;
  return cache;
}

module.exports = {
  getConfig,
  saveConfig,
  reload,
  setConfigForTest,
  isTrustedIp,
  isAllowedText,
  getCustomWords,
  isValidIpOrCidr,
  matchesCidr,
  DEFAULT_CONFIG,
  NUMERIC_RANGES,
  LIST_LIMITS,
  // 导出给测试用：这个清单必须与 waf-rules.js 的 RULE_GROUPS key 集合一致，
  // 否则会出现「规则存在但不能配置」或「能配置但不生效」（有断言钉着）
  GROUP_KEYS,
};
