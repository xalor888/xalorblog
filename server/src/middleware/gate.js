/**
 * 反爬闸门（企业级核心）
 * 1. PoW 工作量证明：服务器签发挑战，客户端需计算 SHA-256 前导零，
 *    只有执行真实 JS 的环境才能通过 —— 直接淘汰 curl/requests/脚本抓取
 *    - 难度自适应：信誉积分越高的 IP 难度越大（4 → 6 档）
 * 2. 设备指纹绑定：票据与指纹(X-Fp)强绑定，盗用票据无指纹即失效
 *    - 指纹格式强制校验：必须为 32~128 位十六进制（脚本伪造成本提高）
 * 3. 票据签名：HMAC(secret, v1|ip|fp|ua|ts|jti)，constant-time 校验
 *    - 版本号：未来算法升级可平滑废弃旧票据
 * 4. 签发登记：jti 必须由本服务签发（防旧密钥残留票据重放）
 * 5. 滑动续期：到期前调用 /anti/renew 续期，无需重复 PoW
 * 6. 写请求签名：X-Sig = HMAC(ticketKey, method|path|ts|bodyHash|jti|nonce)，防篡改防重放
 */

const crypto = require('crypto');
const config = require('../config');
const { getScore } = require('./ipGuard');

const SECRET = config.jwt.secret + ':gate-v2';
const VERSION = 'v2'; // 票据版本（签名输入的一部分）
// PoW 难度（前导零位数，**bit 级**）：16 bits ≈ 平均 6.5 万次哈希（原实现误用
// hex 字符数——1 hex 字符 = 4 bits，成本是 bit 语义的 4 倍；现统一为 bit 语义，
// 与前端求解器一致，注释语义与哈希成本自洽）
const POW_DIFF = 16;
const POW_DIFF_MAX = 24; // 最高难度（24 bits ≈ 平均 1600 万次哈希）
const TICKET_TTL = config.security.ticketTtl;
const RENEW_WINDOW = config.security.renewWindow;
const PUZZLE_TTL = config.security.puzzleTtl;
const SIG_WINDOW = config.security.sigWindow;

/** 判断 hex digest 是否满足前导零 bits 位（与前端求解器同语义） */
function digestHasLeadingZeros(hexDigest, bits) {
  const bytes = Buffer.from(hexDigest, 'hex');
  if (bytes.length < 32) return false;
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) {
    if (bytes[i] !== 0) return false;
  }
  const remain = bits % 8;
  if (remain > 0 && (bytes[full] >> (8 - remain)) !== 0) return false;
  return true;
}

/** 指纹格式：64 位十六进制（前端 SHA-256 输出）；容忍 32~128 位以兼容降级环境 */
const FP_RE = /^[a-f0-9]{32,128}$/;

/** challenge_id -> { ts, prefix, ip, fp, ua } */
const puzzles = new Map();
const PUZZLE_MAX = 5000;

/** 已签发的票据 jti 集合（防重复续期/旧密钥残留重放） */
const issuedJti = new Map(); // jti -> { ts, renews }

/** 单票据最大续期次数：超过后强制重新 PoW。
 * 防「一次 PoW 无限滑动续期」长期免计算抓取全站内容；
 * 正常用户 10 分钟 × (10+1) ≈ 110 分钟连续浏览无感 */
const MAX_RENEWS = 10;

/** 校验指纹格式 */
function isValidFp(fp) {
  return typeof fp === 'string' && FP_RE.test(fp);
}

function hmac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('hex');
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normUa(ua) {
  return String(ua || '').slice(0, 120);
}

/** 自适应 PoW 难度：信誉积分越高越难（最高 6 档） */
function adaptiveDifficulty(ip) {
  const score = getScore(ip || '');
  const extra = Math.min(POW_DIFF_MAX - POW_DIFF, Math.floor(score / 4));
  return POW_DIFF + extra;
}

/* ============ 指纹-IP 关联检测（对抗代理池换 IP 绕封禁） ============
 * 正常浏览器：一个设备指纹基本固定出现在 1-2 个 IP（家庭宽带动态 IP 偶尔切换）。
 * 代理池脚本：同一指纹（脚本伪造或同一设备）会从大量不同 IP 出现。
 * 记录窗口内（1 小时）每个指纹出现过的 IP 集合，超阈值即标记，
 * 该指纹后续签发挑战时难度直接拉满（计算成本指数上升），且计入信誉。 */
const fpIpTracker = new Map(); // fp -> { ips: Set, windowStart }
const FP_IP_WINDOW = 60 * 60 * 1000;
const FP_IP_THRESHOLD = 3; // 同一指纹出现在 ≥3 个不同 IP → 疑似代理池
const FP_IP_MAX = 20000;

function trackFpIp(fp, ip) {
  if (!fp || !ip || fp === 'unknown') return false;
  const now = Date.now();
  let rec = fpIpTracker.get(fp);
  if (!rec || now - rec.windowStart > FP_IP_WINDOW) {
    rec = { ips: new Set(), windowStart: now };
    fpIpTracker.set(fp, rec);
  }
  const before = rec.ips.size;
  rec.ips.add(ip);
  if (fpIpTracker.size > FP_IP_MAX) {
    for (const [k, v] of fpIpTracker) {
      if (now - v.windowStart > FP_IP_WINDOW) fpIpTracker.delete(k);
    }
  }
  // 仅在「跨过阈值瞬间」返回 true（调用方计一次分）；
  // 已标记后的后续签发只拉满难度不再重复计分，防误伤家庭动态 IP 用户被快速封禁
  return before < FP_IP_THRESHOLD && rec.ips.size >= FP_IP_THRESHOLD;
}

/** 该指纹是否已被标记为疑似代理池（用于签发时拉满难度） */
function isFpFlagged(fp) {
  if (!fp) return false;
  const rec = fpIpTracker.get(fp);
  return !!(rec && rec.ips.size >= FP_IP_THRESHOLD);
}

/** 签发挑战（绑定 ip + 指纹 + UA，难度自适应）
 * 指纹已跨多 IP 出现（疑似代理池脚本）→ 难度直接拉满，计算成本指数上升 */
function issuePuzzle(req) {
  const prefix = crypto.randomBytes(12).toString('hex');
  const id = crypto.randomBytes(8).toString('hex');
  const fp = String(req.headers['x-fp'] || '').slice(0, 128);
  // 代理池对抗：同一指纹出现在多个 IP → 记信誉积分 + 本挑战难度拉满
  if (trackFpIp(fp, req.ip || 'unknown')) {
    const { report } = require('./ipGuard');
    report(req.ip, 'rate', 'FP-IP-POOL');
  }
  puzzles.set(id, {
    ts: Date.now(),
    prefix,
    ip: req.ip || 'unknown',
    fp,
    ua: normUa(req.headers['user-agent']),
    diff: isFpFlagged(fp) ? POW_DIFF_MAX : adaptiveDifficulty(req.ip),
  });
  // 池超限：优先清掉已过期的挑战（攻击者可批量申请挑战撑爆池，
  // 若无差别丢弃最早条目会挤掉正常用户的未过期挑战）；无过期条目时才按最旧丢弃
  if (puzzles.size > PUZZLE_MAX) {
    const now = Date.now();
    let removed = false;
    for (const [k, p] of puzzles) {
      if (now - p.ts > PUZZLE_TTL) {
        puzzles.delete(k);
        removed = true;
        if (puzzles.size <= PUZZLE_MAX) break;
      }
    }
    if (!removed) {
      const first = puzzles.keys().next().value;
      puzzles.delete(first);
    }
  }
  return { id, prefix, difficulty: puzzles.get(id).diff };
}

/** 验证 PoW 求解结果（单次使用） */
function verifyPow(req, body) {
  const { id, solution } = body || {};
  const pz = puzzles.get(id);
  if (!pz) return { ok: false, reason: '挑战不存在或已失效' };
  puzzles.delete(id);
  if (Date.now() - pz.ts > PUZZLE_TTL) return { ok: false, reason: '挑战已过期，请重试' };
  if ((req.ip || 'unknown') !== pz.ip) return { ok: false, reason: '请求来源不匹配' };
  // UA 一致性：换 UA 重新求解（防拼接脚本轮换 UA 绕过）
  if (normUa(req.headers['user-agent']) !== pz.ua) return { ok: false, reason: '环境信息不匹配' };
  // 指纹一致性：挑战签发时的指纹必须与提交时一致
  if (String(req.headers['x-fp'] || '').slice(0, 128) !== pz.fp) {
    return { ok: false, reason: '设备指纹不匹配' };
  }
  if (typeof solution !== 'string' || solution.length > 64 || !/^[a-zA-Z0-9]+$/.test(solution)) {
    return { ok: false, reason: '求解结果无效' };
  }
  const digest = sha256hex(pz.prefix + ':' + solution);
  // 难度以签发时为准（自适应难度下客户端按签发难度求解）
  // bit 级判断：与前端求解器（direct digest byte check）语义一致
  if (!digestHasLeadingZeros(digest, pz.diff || POW_DIFF)) {
    return { ok: false, reason: '工作量证明失败' };
  }
  return { ok: true, pz };
}

/** 签发票据 token = ts.jti.sig（签名含版本号）
 * renews 继承自旧票据（续期链延续计数，防换新 jti 重置上限） */
function issueTicket(ip, fp, ua, renews = 0) {
  const jti = crypto.randomBytes(9).toString('hex');
  const ts = Date.now();
  const sig = hmac([VERSION, ip, fp, ua, ts, jti].join('|'));
  issuedJti.set(jti, { ts, renews });
  if (issuedJti.size > 20000) {
    const now = Date.now();
    for (const [j, t] of issuedJti) {
      if (now - t.ts > TICKET_TTL * 2) issuedJti.delete(j);
    }
  }
  return { token: [ts, jti, sig].join('.'), jti, ts };
}

/** 验证票据（constant-time + 签发登记校验） */
function verifyTicket(req) {
  const token = req.headers['x-pass'];
  if (typeof token !== 'string') return { ok: false, reason: '缺少通行证' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: '通行证格式无效' };
  const [tsStr, jti, sig] = parts;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return { ok: false, reason: '通行证无效' };

  // 必须是本服务签发的 jti（防旧密钥残留/伪造登记）
  const issued = issuedJti.get(jti);
  if (!issued) return { ok: false, reason: '通行证无效' };

  const ip = req.ip || 'unknown';
  const fp = String(req.headers['x-fp'] || '').slice(0, 128);
  const ua = normUa(req.headers['user-agent']);
  const expect = hmac([VERSION, ip, fp, ua, ts, jti].join('|'));

  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: '通行证校验失败' };
  }
  if (Math.abs(Date.now() - ts) > TICKET_TTL) {
    return { ok: false, reason: '通行证已过期' };
  }
  return { ok: true, ts, jti, token };
}

/**
 * 写请求签名校验：X-Sig = HMAC-SHA256(key=ticket, method|path|ts|bodyHash|jti|nonce)
 * key 即票据本身 —— 只有完成 PoW 且指纹/UA/IP 全匹配的合法客户端才持有，
 * 伪造签名需要先获得票据；nonce 一次性消费，窗口内重放直接拒绝
 */
const usedNonces = new Map(); // nonce -> expiresAt
const NONCE_MAX = 8000;

function consumeNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[a-zA-Z0-9]{8,64}$/.test(nonce)) return false;
  const now = Date.now();
  const exp = usedNonces.get(nonce);
  if (exp) {
    if (exp > now) return false; // 重放
    usedNonces.delete(nonce);
  }
  usedNonces.set(nonce, now + SIG_WINDOW);
  if (usedNonces.size > NONCE_MAX) {
    for (const [k, e] of usedNonces) {
      if (e < now) usedNonces.delete(k);
    }
  }
  return true;
}

function verifySig(req, ticket) {
  const ts = req.headers['x-timestamp'];
  if (!ts || !/^\d{10,13}$/.test(String(ts))) return false;
  const t = Number(ts);
  if (Math.abs(Date.now() - t) > SIG_WINDOW) return false;

  const nonce = String(req.headers['x-nonce'] || '');
  const bodyHash = sha256hex(JSON.stringify(req.body || {}));
  const method = req.method.toUpperCase();
  // 签名路径 = 挂载点相对路径（与客户端 baseURL 相对路径一致）
  const path = req.path;
  const expect = hmacWithKey(ticket.token, [method, path, t, bodyHash, ticket.jti, nonce].join('|'));
  const got = String(req.headers['x-sig'] || '');
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return false;
  return consumeNonce(nonce);
}

function hmacWithKey(key, data) {
  return crypto.createHmac('sha256', String(key)).update(data).digest('hex');
}

/** 闸门中间件：公开接口必须携带有效票据 */
function gateRequired(req, res, next) {
  const t = verifyTicket(req);
  if (!t.ok) {
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  req.passTicket = t;
  next();
}

/** 写接口闸门：票据 + 时间戳 + 签名三重校验 */
function gateWriteRequired(req, res, next) {
  const t = verifyTicket(req);
  if (!t.ok) {
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  if (!verifySig(req, t)) {
    return res.status(403).json({ code: 1, message: '请求签名无效' });
  }
  req.passTicket = t;
  // 显式标记「签名已验证」：供 refererRequired 等下游中间件据此旁路，
  // 而非依赖裸 X-Sig 头存在（头可伪造，标记只能由本函数设置）
  req.sigVerified = true;
  next();
}

/** 续期：验证旧票据并签发新票据（滑动窗口，且要求指纹格式合法）
 * 续期次数上限 MAX_RENEWS：防一次 PoW 无限滑动续期免计算抓取全站内容 */
function renewTicket(req) {
  const t = verifyTicket(req);
  if (!t.ok) return { ok: false, reason: t.reason };
  if (Date.now() - t.ts > RENEW_WINDOW) {
    // 超出滑动窗口，要求重新 PoW
    return { ok: false, reason: '需要重新验证' };
  }
  const issued = issuedJti.get(t.jti);
  let renews = 0;
  if (issued) {
    renews = Number(issued.renews) + 1;
    if (renews > MAX_RENEWS) {
      // 续期次数用尽：强制重新 PoW（防脚本一次求解后无限期抓取）
      return { ok: false, reason: '需要重新验证' };
    }
  }
  const fp = String(req.headers['x-fp'] || '').slice(0, 128);
  const issued2 = issueTicket(req.ip || 'unknown', fp, normUa(req.headers['user-agent']), renews);
  return { ok: true, token: issued2.token };
}

/** 搜索引擎爬虫白名单（收录通道，仅限读接口） */
const SEARCH_BOT_RE = /(googlebot|bingbot|baiduspider|sogou|360spider|yandex|duckduckbot|smider|bytespider|petalbot|yisou)/i;

function isSearchBot(ua) {
  return !!ua && SEARCH_BOT_RE.test(ua);
}

/**
 * 爬虫 IP 反向 DNS 核验：UA 自称 Googlebot 等主流爬虫时，
 * 必须其来源 IP 的 PTR 记录归属对应搜索引擎（防伪造 UA 批量抓取元数据）
 * - 校验通过/失败结果缓存 1 小时，避免每请求 DNS 开销
 * - 无法核验的 UA 与 DNS 查询失败一律 fail-closed（拒绝）：安全优先
 */
const dns = require('dns').promises;
const crawlerVerifyCache = new Map(); // ip -> { ok, ts }
const CRAWLER_CACHE_TTL = 60 * 60 * 1000;
const CRAWLER_MAX = 5000;

// UA 关键词 → 期望的 PTR 域关键词（bytespider 为字节跳动爬虫，PTR 归属 bytedance.com）
const CRAWLER_DOMAINS = [
  ['googlebot', 'google'],
  ['bingbot', 'bing'],
  ['baiduspider', 'baidu'],
  ['sogou', 'sogou'],
  ['yandex', 'yandex'],
  ['duckduckbot', 'duckduckgo'],
  ['bytespider', 'bytedance'],
  // 国内爬虫：神马（sm.cn）/ 华为（huawei.com）/ 360（360.cn）
  ['smider', 'sm.cn'],
  ['petalbot', 'huawei'],
  ['360spider', '360'],
];

async function verifyCrawlerIp(ip, ua) {
  const lower = String(ua || '').toLowerCase();
  const entry = CRAWLER_DOMAINS.find(([kw]) => lower.includes(kw));
  // 无法核验归属的爬虫 UA 一律拒绝（fail-closed）：
  // 攻击者最常见的闸门旁路就是随便声明一个爬虫 UA 免 PoW；
  // 真实搜索引擎爬虫（Google/Bing/Baidu 等）全部有可核验的反向 DNS 域名
  if (!entry) return { ok: false, checked: false };
  const domain = entry[1];

  const cached = crawlerVerifyCache.get(ip);
  if (cached && Date.now() - cached.ts < CRAWLER_CACHE_TTL) {
    return { ok: cached.ok, checked: true, cached: true };
  }
  try {
    const hostnames = await dns.reverse(ip);
    const ok = hostnames.some((h) => h.toLowerCase().includes(domain));
    crawlerVerifyCache.set(ip, { ok, ts: Date.now() });
    if (crawlerVerifyCache.size > CRAWLER_MAX) {
      const now = Date.now();
      for (const [k, v] of crawlerVerifyCache) {
        if (now - v.ts > CRAWLER_CACHE_TTL) crawlerVerifyCache.delete(k);
      }
    }
    return { ok, checked: true };
  } catch (e) {
    // DNS 查询失败：fail-closed（拒绝）。正常浏览器不走此路径（走 PoW），
    // 误伤面仅限「DNS 解析失败时自称爬虫的请求」，安全性优先
    return { ok: false, checked: false };
  }
}

module.exports = {
  issuePuzzle,
  verifyPow,
  issueTicket,
  verifyTicket,
  verifySig,
  gateRequired,
  gateWriteRequired,
  renewTicket,
  isSearchBot,
  isValidFp,
  adaptiveDifficulty,
  verifyCrawlerIp,
  trackFpIp,
  isFpFlagged,
};
