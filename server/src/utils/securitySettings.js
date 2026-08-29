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
      if (target.slice(0, 12).some((b) => b !== 0)) return false;
      target = target.slice(12);
    } else {
      if (target.length !== 4) return false;
      target = Buffer.concat([Buffer.alloc(12), target]);
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

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function getConfig() {
  if (!loaded && !loadPromise) loadPromise = reload().catch(() => {});
  return cache;
}

async function reload() {
  try {
    const rows = await db('security_config').where('id', 'config').select('data').limit(1);
    if (rows.length && rows[0].data) {
      const parsed = JSON.parse(rows[0].data);
      cache = mergeValid(DEFAULT_CONFIG, parsed);
    }
  } catch (e) {
    // 表不存在/DB 不可用：保持默认（migrate 后自动恢复）
  }
  loaded = true;
  return cache;
}

/** 深合并已知键，仅保留类型合法的值 */
function mergeValid(base, patch) {
  const out = cloneDefaults();
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
  for (const numKey of ['scanThreshold', 'banScore', 'baseBanMinutes', 'maxBanHours', 'banCountResetDays']) {
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

/** 保存（强校验后整体覆盖写入并失效缓存）。返回 { ok, config } */
async function saveConfig(patch) {
  const merged = mergeValid(getConfig(), patch || {});
  const json = JSON.stringify(merged);
  await db('security_config')
    .insert({ id: 'config', data: json, updated_at: db.fn.now() })
    .onConflict('id')
    .merge({ data: json, updated_at: db.fn.now() });
  cache = merged;
  loaded = true;
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

/** 词库豁免：文本命中敏感词但包含任一豁免词时跳过该判定 */
function isAllowedText(text, matchedWord) {
  const allow = getConfig().allowWords;
  if (!allow.length) return false;
  const lower = String(text || '').toLowerCase();
  return allow.some((w) => lower.includes(String(w).toLowerCase()));
}

/** 追加自定义敏感词后的完整硬拒词库（antiSpam 调用） */
function getCustomWords() {
  return getConfig().customSensitiveWords;
}

module.exports = {
  getConfig,
  saveConfig,
  reload,
  isTrustedIp,
  isAllowedText,
  getCustomWords,
  isValidIpOrCidr,
  DEFAULT_CONFIG,
  NUMERIC_RANGES,
  LIST_LIMITS,
};
