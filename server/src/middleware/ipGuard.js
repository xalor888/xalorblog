/**
 * IP 信誉与自动封禁系统（企业级）
 * - 恶意行为（WAF 命中 / 蜜罐命中 / 限流超限 / 登录爆破 / 垃圾提交 / 扫描行为）累计积分
 * - 不同行为不同权重：蜜罐最高（命中即重罚），WAF 次之
 * - 积分达到阈值自动封禁，封禁时长随累犯指数翻倍（15 分钟起，最长 24h）
 * - 封禁记录持久化到 ip_bans 表（重启不丢），内存为运行时权威
 * - 记录最近安全事件（供后台安全面板展示）
 */

const config = require('../config');
const db = require('../db');

const BAN_SCORE = 10;             // 触发封禁的积分阈值
const HONEYPOT_WEIGHT = 6;        // 蜜罐命中：2 次即封禁
const WAF_WEIGHT = 3;             // 一次 WAF 命中（4 次触发封禁）
const AUTH_WEIGHT = 3;            // 一次认证失败（4 次触发封禁）
const RATE_WEIGHT = 2;            // 一次限流命中（5 次触发封禁）
const SPAM_WEIGHT = 1;            // 一次垃圾提交
const BASE_BAN_MS = 15 * 60 * 1000; // 首次封禁 15 分钟
const DECAY_MS = 30 * 60 * 1000;  // 积分每 30 分钟衰减一半
const MAX_BAN_MS = 24 * 3600 * 1000; // 最长封禁 24 小时
const REPUTATION_MAX = 50000;      // 信誉表硬上限
const REPUTATION_FLOOR = 40000;    // 超限时回落到该水位

/** ip -> { score, updatedAt, strikes, banUntil, banCount } */
const records = new Map();
/** 最近安全事件环形缓冲（后台面板展示） */
const events = [];
const EVENTS_MAX = 300;

let lastClean = Date.now();
let dbLoaded = false;

/** 超限时清理未封禁的低价值记录；正在封禁的记录不丢 */
function pruneReputation(currentIp) {
  const now = Date.now();
  for (const [ip, rec] of records) {
    if (ip === currentIp) continue;
    if (rec.banUntil && rec.banUntil > now) continue;
    if (rec.score <= 0) records.delete(ip);
    if (records.size <= REPUTATION_FLOOR) return;
  }
  for (const [ip, rec] of records) {
    if (ip === currentIp) continue;
    if (rec.banUntil && rec.banUntil > now) continue;
    records.delete(ip);
    if (records.size <= REPUTATION_FLOOR) return;
  }
}

function decay() {
  const now = Date.now();
  if (now - lastClean < 60 * 1000) return;
  lastClean = now;
  for (const [ip, rec] of records) {
    if (now - rec.updatedAt > DECAY_MS) {
      rec.score = Math.floor(rec.score / 2);
      rec.updatedAt = now;
    }
    if (rec.score <= 0 && (!rec.banUntil || rec.banUntil < now)) records.delete(ip);
  }
}

function logEvent(type, ip, path, detail = '') {
  events.push({ t: Date.now(), type, ip, path: (path || '').slice(0, 120), detail: detail.slice(0, 160) });
  if (events.length > EVENTS_MAX) events.shift();
  queuePersist(type, ip, path, detail);
}

/* ---------- 攻击事件持久化（批量落库，重启不丢） ----------
 * 内存环形缓冲仅保留最近 300 条用于实时面板；全部事件异步批量写入 audit_logs
 * （action 前缀 SEC-EVENT，供事后取证/分析；90 天自动清理与审计日志同生命周期）。
 * 批量 flush 避免高频攻击时每事件一条 INSERT 拖垮 DB。 */
const PERSIST_BATCH_MAX = 100;   // 累计 100 条立即 flush
const PERSIST_INTERVAL = 30 * 1000; // 或每 30 秒 flush 一次
let persistQueue = [];
let persistTimer = null;

function queuePersist(type, ip, path, detail) {
  persistQueue.push({
    user_id: 0,
    username: 'security',
    action: `SEC-EVENT ${type}`.slice(0, 120),
    detail: String(detail || path || type || '').slice(0, 200),
    ip: String(ip || '').slice(0, 64),
    fp: '',
    created_at: db.fn.now(),
  });
  if (persistQueue.length >= PERSIST_BATCH_MAX) return flushPersist();
  if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushPersist();
    }, PERSIST_INTERVAL);
    persistTimer.unref?.();
  }
}

function flushPersist() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!persistQueue.length) return;
  const batch = persistQueue;
  persistQueue = [];
  db('audit_logs').insert(batch).catch(() => {
    // 落库失败：回填队列尾部（不无限重试，仅保留最近一批防内存膨胀）
    persistQueue = persistQueue.concat(batch).slice(-PERSIST_BATCH_MAX);
  });
}

/** 封禁持久化（异步，失败静默 —— 内存仍是权威） */
function persistBan(ip, until, count, reason = '') {
  db('ip_bans')
    .insert({
      ip,
      banned_until: new Date(until),
      ban_count: count,
      reason: String(reason || '').slice(0, 120),
      updated_at: db.fn.now(),
    })
    .onConflict('ip')
    .merge({
      banned_until: new Date(until),
      ban_count: count,
      reason: String(reason || '').slice(0, 120),
      updated_at: db.fn.now(),
    })
    .catch(() => {});
}

/** 启动时从数据库恢复有效封禁（异步一次） */
async function loadPersistedBans() {
  if (dbLoaded) return;
  dbLoaded = true;
  try {
    const rows = await db('ip_bans')
      .where('banned_until', '>', db.fn.now())
      .orderBy('updated_at', 'desc')
      .limit(REPUTATION_MAX)
      .select('ip', 'banned_until', 'ban_count', 'reason');
    const now = Date.now();
    for (const r of rows) {
      const until = new Date(r.banned_until).getTime();
      if (until > now) {
        records.set(r.ip, {
          score: 0, updatedAt: now, strikes: 0,
          banUntil: until, banCount: Number(r.ban_count) || 1,
          lastBanReason: String(r.reason || ''),
        });
      }
    }
    if (rows.length === REPUTATION_MAX) {
      console.warn(`[ipGuard] 持久化封禁达到恢复上限 ${REPUTATION_MAX}，更早封禁暂未加载`);
    }
    if (rows.length) console.log(`[ipGuard] 已恢复 ${rows.length} 个持久化封禁`);
  } catch (e) {
    // 表不存在或数据库不可用：静默降级为纯内存模式
  }
}

/** 上报恶意行为：返回是否因此触发封禁 */
function report(ip, type, path = '') {
  decay();
  if (!ip) return false;
  const now = Date.now();
  let rec = records.get(ip);
  if (!rec) {
    rec = { score: 0, updatedAt: now, strikes: 0, banUntil: 0, banCount: 0 };
    records.set(ip, rec);
    if (records.size > REPUTATION_MAX) pruneReputation(ip);
  }
  // 封禁期内的重复上报仅延长事件记录，不叠加
  if (now < rec.banUntil) {
    logEvent(type, ip, path, '重复攻击（封禁中）');
    return false;
  }

  let weight = RATE_WEIGHT;
  if (type === 'honeypot') weight = HONEYPOT_WEIGHT;
  if (type === 'waf') weight = WAF_WEIGHT;
  if (type === 'auth') weight = AUTH_WEIGHT;
  if (type === 'spam') weight = SPAM_WEIGHT;

  rec.score += weight;
  rec.updatedAt = now;
  rec.strikes += 1;
  logEvent(type, ip, path);

  if (rec.score >= BAN_SCORE) {
    rec.banCount += 1;
    const duration = Math.min(BASE_BAN_MS * Math.pow(2, rec.banCount - 1), MAX_BAN_MS);
    rec.banUntil = now + duration;
    rec.score = 0;
    // 记录本次封禁的触发原因（最近一次违规行为）
    rec.lastBanReason = String(path || type || '').slice(0, 120);
    logEvent('ban', ip, path, `封禁 ${Math.round(duration / 60000)} 分钟`);
    persistBan(ip, rec.banUntil, rec.banCount, rec.lastBanReason);
    // 邮件告警（可选）：配置 SMTP 后，每次触发新封禁通知站长；
    // 封禁期内的重复攻击不再告警（104 行提前返回），天然防告警轰炸
    if (config.security.alertOnBan !== false) {
      const { send } = require('../utils/notifyMail');
      send(
        '安全告警：有 IP 被自动封禁',
        `IP ${ip} 因恶意行为被自动封禁 ${Math.round(duration / 60000)} 分钟\n触发原因：${rec.lastBanReason}\n累计封禁次数：${rec.banCount}\n封禁至：${new Date(rec.banUntil).toLocaleString('zh-CN')}`
      ).catch(() => {});
    }
    return true;
  }
  return false;
}

/** 当前是否被封禁 */
function isBanned(ip) {
  if (!ip) return false;
  decay();
  const rec = records.get(ip);
  if (!rec) return false;
  if (rec.banUntil > Date.now()) return true;
  if (rec.banUntil && rec.banUntil <= Date.now()) {
    rec.banUntil = 0;
    // 解除持久化记录
    db('ip_bans').where('ip', ip).del().catch(() => {});
  }
  return false;
}

/** 查询封禁剩余秒数 */
function banRemain(ip) {
  const rec = records.get(ip);
  if (!rec) return 0;
  return Math.max(0, Math.ceil((rec.banUntil - Date.now()) / 1000));
}

/** 查询当前信誉积分（供自适应难度/限流使用） */
function getScore(ip) {
  if (!ip) return 0;
  decay();
  const rec = records.get(ip);
  return rec ? rec.score : 0;
}

/** 是否处于封禁期 */
function isBannedNow(ip) {
  return isBanned(ip);
}

/** 手动解封（后台安全中心） */
function unban(ip) {
  records.delete(ip);
  db('ip_bans').where('ip', ip).del().catch(() => {});
  logEvent('unban', ip, '后台手动解封');
}

/** 中间件：被封禁 IP 直接拒绝（放行引导/登录/后台，避免封禁死锁） */
function ipGuard(req, res, next) {
  // 这些路径自身受密码/签名令牌/双因素保护，必须始终可达：
  // <prefix>/anti 引导通道、<prefix>/auth/login 登录、<prefix>/<adminPath> 整个后台
  // 前缀必须用 config.apiPrefix（可配置），硬编码会导致改前缀后死锁
  const p = req.originalUrl.split('?')[0];
  const prefix = config.apiPrefix;
  if (
    p.startsWith(`${prefix}/anti`) ||
    p === `${prefix}/auth/login` ||
    p.startsWith(`${prefix}/${config.adminPath}`)
  ) {
    return next();
  }
  if (isBanned(req.ip)) {
    const remain = banRemain(req.ip);
    res.set('Retry-After', String(remain || 1));
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  next();
}

/** 后台面板数据（实时内存事件 + 持久化历史事件） */
async function securityStats() {
  const now = Date.now();
  const banned = [];
  for (const [ip, rec] of records) {
    if (rec.banUntil > now) {
      banned.push({
        ip,
        remain: Math.ceil((rec.banUntil - now) / 1000),
        strikes: rec.strikes,
        banCount: rec.banCount,
        reason: rec.lastBanReason || '',
      });
    }
  }
  // 攻击类型分布（内存实时 + DB 历史合并，重启后统计不归零）
  const typeCounts = {};
  const countType = (type) => {
    const key = type === 'ban' || type === 'unban' ? 'ban' : type;
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  };
  for (const e of events) countType(e.type);
  let persisted = [];
  try {
    // 持久化历史（最近 50 条；与实时事件按时间倒序合并展示）
    persisted = await db('audit_logs')
      .where('action', 'like', 'SEC-EVENT%')
      .orderBy('id', 'desc')
      .limit(50)
      .select('id', 'action', 'detail', 'ip', 'created_at');
  } catch (e) { /* 表不可用忽略 */ }
  const persistedEvents = persisted.map((p) => ({
    t: new Date(p.created_at).getTime(),
    type: String(p.action).replace('SEC-EVENT ', '') || 'event',
    ip: p.ip,
    path: '',
    detail: p.detail,
    persisted: true,
  }));
  // 去重合并：内存实时事件 + DB 历史（事件总数含历史）
  const merged = [...persistedEvents, ...events.slice(-50).reverse()];
  for (const p of persisted) countType(String(p.action).replace('SEC-EVENT ', ''));
  return {
    banned,
    events: merged.slice(0, 50),
    event_total: merged.length,
    type_counts: typeCounts,
  };
}

module.exports = {
  report,
  isBanned,
  banRemain,
  getScore,
  isBannedNow,
  ipGuard,
  securityStats,
  logEvent,
  unban,
  loadPersistedBans,
};
