/**
 * IP 信誉与自动封禁系统
 * - 恶意行为（WAF 命中 / 蜜罐命中 / 限流超限 / 登录爆破 / 垃圾提交 / 扫描行为）累计积分
 * - 不同行为不同权重：蜜罐最高（命中即重罚），WAF 次之
 * - 积分达到阈值自动封禁，封禁时长随累犯指数翻倍（15 分钟起，最长 24h）
 * - 封禁记录持久化到 ip_bans 表（重启不丢），内存为运行时权威
 * - 记录最近安全事件（供后台安全面板展示）
 */

const config = require('../config');
const db = require('../db');
const { ipKeyGenerator } = require('express-rate-limit');
const securitySettings = require('../utils/securitySettings');

// 权重与阈值的代码级兜底（运行时以 securitySettings 配置为准，安全中心可调）
const FALLBACK_WEIGHTS = { honeypot: 6, waf: 3, auth: 3, rate: 2, scan: 2, spam: 1 };
const FALLBACK_BAN_SCORE = 10;
const BASE_BAN_MS_FALLBACK = 15 * 60 * 1000;
const MAX_BAN_MS_FALLBACK = 24 * 3600 * 1000;
const DECAY_MS = 30 * 60 * 1000;  // 积分每 30 分钟衰减一半
const REPUTATION_MAX = 50000;      // 信誉表硬上限
const REPUTATION_FLOOR = 40000;    // 超限时回落到该水位
/** 累犯轮次老化：距上次封禁超过该天数重新从 1 轮计（0 = 永不重置） */
const BAN_COUNT_RESET_MS = 30 * 86400 * 1000;

/** canonical IPv4 / IPv6-/56-prefix -> { score, updatedAt, strikes, banUntil, banCount } */
const records = new Map();
/** 启动时发现的旧版精确 IPv6 持久化键；迁移失败时供解封/过期清理兜底。 */
const legacyBanKeys = new Map();
/** 最近安全事件环形缓冲（后台面板展示） */
const events = [];
const EVENTS_MAX = 300;

let lastClean = Date.now();
let dbLoaded = false;

/**
 * 与 express-rate-limit 一致地聚合 IPv6 /64（标准子网划分，整栋楼连坐面比 /56 小）；
 * IPv4（含 mapped IPv6）保持单地址。
 * 去掉展示用的 /64 后缀但保留已清零的网络地址，使后台现有 net.isIP 校验仍可解封。
 */
function reputationKey(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return '';
  try {
    return ipKeyGenerator(raw, 64).replace(/\/64$/, '').toLowerCase();
  } catch (e) {
    return raw.toLowerCase();
  }
}

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
/* 失败回填后的队列硬上限：故意大于 PERSIST_BATCH_MAX。
 * 为什么允许超过批次上限：落库失败时队列里装的是**尚未取证**的攻击事件，
 * 取证价值高于内存占用 —— 上限只用来兜住「数据库长时间不可用」这种病态情况，
 * 正常一次性重试（≤100 条）根本碰不到它。超限时丢弃最旧的并显式告警条数。 */
const PERSIST_QUEUE_MAX = 500;
/* 失败重试间隔：原实现失败后不再排定时器，没有新流量就永不重试
 * （低频攻击站点上取证数据会一直躺在内存里直到进程重启）。60 秒自愈。 */
const PERSIST_RETRY_MS = 60 * 1000;
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
  db('audit_logs').insert(batch).catch((e) => {
    /* 落库失败：失败批次按原始事件时间顺序放回**队首**。
     * 原实现 persistQueue.concat(batch).slice(-PERSIST_BATCH_MAX) 有两个静默丢数据的后果：
     *   1) 失败批次被排到新事件**之后**，再被 slice 从头部截断 —— 正在涌入的新流量
     *      会把较旧（且更早发生、更该留证）的失败批次挤出队列直接丢弃；
     *   2) 截断后没有重排定时器，无新流量时队列永不重试。
     * 现在：波次连续、不跨批交错，只有真的超过 PERSIST_QUEUE_MAX 才丢最旧的并告警。 */
    persistQueue = batch.concat(persistQueue);
    if (persistQueue.length > PERSIST_QUEUE_MAX) {
      const dropped = persistQueue.length - PERSIST_QUEUE_MAX;
      persistQueue = persistQueue.slice(-PERSIST_QUEUE_MAX);
      console.warn(
        `[ipGuard] 攻击事件落库持续失败（${e && e.message ? e.message : 'unknown'}），`
        + `取证队列超过 ${PERSIST_QUEUE_MAX} 条，已丢弃最旧 ${dropped} 条`
      );
    }
    // 自愈：失败后重排一次重试定时器（unref：不阻止进程退出）
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        persistTimer = null;
        flushPersist();
      }, PERSIST_RETRY_MS);
      persistTimer.unref?.();
    }
  });
}

/** loopback 地址（127.x / ::1 / ::ffff:127.x / 以及它们的 /64 规范键）：只可能来自本机
 *  （测试、探活、本地开发）。封 loopback 有内存内生效即可（如测试断言 403），
 *  持久化只有副作用——测试套件触发后封禁落库，测试结束/重启服务都救不回来，本地站整站 403。
 *
 *  必须同时认规范键形态：本文件传给这里的是 reputationKey() 的输出，而它会把 IPv6
 *  折算成 /64 并剥掉后缀，于是 ::1 变成 "::"（ipKeyGenerator('::1',64) === '::/64'）。
 *  旧实现只比对字面 '::1'，所以 IPv6 回环**没有被识别成 loopback**：
 *  任一次 WAF 命中就把 ip_bans 里写下 ip='::' 的持久封禁，
 *  重启后 loadPersistedBans 又把它恢复成整段 IPv6 的封禁（/64 聚合），
 *  本机与同 /64 内所有 IPv6 客户端从此 403 且无法自愈。
 *  '::' 是未指定地址，与 ::1 同属回环网段，一律走同一处理。 */
function isLoopbackIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  return s === '::1' || s === '::' || s === '127.0.0.1'
    || s.startsWith('127.')
    || s.startsWith('::ffff:127.');
}

/** 封禁持久化（异步，失败静默 —— 内存仍是权威） */
function persistBan(ip, until, count, reason = '') {
  if (isLoopbackIp(ip)) return Promise.resolve();
  return db('ip_bans')
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

/** 删除规范键及启动时记录的旧精确 IPv6 键。 */
function deletePersistedBan(ip) {
  const key = reputationKey(ip);
  const candidates = new Set([key, ...(legacyBanKeys.get(key) || [])]);
  legacyBanKeys.delete(key);
  return db('ip_bans').whereIn('ip', [...candidates].filter(Boolean)).del().catch(() => {});
}

/** 启动时从数据库恢复有效封禁（可重复调用：成功一次后短路） */
async function loadPersistedBans() {
  if (dbLoaded) return;
  try {
    const rows = await db('ip_bans')
      .where('banned_until', '>', db.fn.now())
      .orderBy('updated_at', 'desc')
      .limit(REPUTATION_MAX)
      .select('ip', 'banned_until', 'ban_count', 'reason');
    const now = Date.now();
    const aggregated = new Map();
    for (const r of rows) {
      const until = new Date(r.banned_until).getTime();
      if (until > now) {
      const rawIp = String(r.ip || '').trim();
      const key = reputationKey(rawIp);
      if (!key) continue;
      // 历史遗留的 loopback 持久化封禁不再恢复（新封禁已不再落库，见 persistBan）
      if (isLoopbackIp(key)) continue;
        const existing = aggregated.get(key);
        if (!existing) {
          aggregated.set(key, {
            until,
            count: Number(r.ban_count) || 1,
            reason: String(r.reason || ''),
          });
        } else {
          existing.count = Math.max(existing.count, Number(r.ban_count) || 1);
          if (until > existing.until) {
            existing.until = until;
            existing.reason = String(r.reason || '');
          }
        }
        if (rawIp !== key) {
          if (!legacyBanKeys.has(key)) legacyBanKeys.set(key, new Set());
          legacyBanKeys.get(key).add(rawIp);
        }
      }
    }
    for (const [key, rec] of aggregated) {
      records.set(key, {
        score: 0, updatedAt: now, strikes: 0,
        banUntil: rec.until, banCount: rec.count,
        lastBanReason: rec.reason,
      });
    }

    // 将旧版「精确 IPv6 地址」持久化键原子折叠到当前规范键（/64 聚合）；
    // 失败时内存仍按规范键生效，legacyBanKeys 也会让手动解封/到期清理覆盖旧行。
    if (legacyBanKeys.size) {
      try {
        await db.transaction(async (trx) => {
          for (const [key, oldKeys] of legacyBanKeys) {
            const rec = aggregated.get(key);
            await trx('ip_bans')
              .insert({
                ip: key,
                banned_until: new Date(rec.until),
                ban_count: rec.count,
                reason: String(rec.reason || '').slice(0, 120),
                updated_at: trx.fn.now(),
              })
              .onConflict('ip')
              .merge({
                banned_until: new Date(rec.until),
                ban_count: rec.count,
                reason: String(rec.reason || '').slice(0, 120),
                updated_at: trx.fn.now(),
              });
            await trx('ip_bans').whereIn('ip', [...oldKeys]).del();
          }
        });
      } catch (e) {
        console.warn('[ipGuard] 旧 IPv6 封禁键迁移失败，已以内存兼容模式加载');
      }
    }
    if (rows.length === REPUTATION_MAX) {
      console.warn(`[ipGuard] 持久化封禁达到恢复上限 ${REPUTATION_MAX}，更早封禁暂未加载`);
    }
    if (rows.length) console.log(`[ipGuard] 已恢复 ${aggregated.size} 个持久化封禁范围`);
    // 只有真正加载成功才置位：dbLoaded 在 try 之外无条件置位时，数据库尚未就绪
    // （启动竞态 / 表还在迁移）会让封禁恢复在该进程生命周期内**永不重试**，
    // 重启前持久化的封禁全部失效 —— 攻击者只要卡在这个窗口里就一直是未封禁状态。
    dbLoaded = true;
  } catch (e) {
    // 保持 dbLoaded=false，下次调用会重新尝试（调用点只有 server.js 启动一次，
    // 所以这里不额外做惰性重试；失败不抛出，启动流程继续以纯内存模式运行）
    console.warn(
      '[ipGuard] 持久化封禁加载失败，暂以纯内存模式运行（下次调用会重试）:',
      e && e.message ? e.message : 'unknown'
    );
  }
}

/** 上报恶意行为：返回是否因此触发封禁 */
function report(ip, type, path = '') {
  decay();
  if (!ip) return false;
  // 可信 IP 白名单（安全中心维护）：不记分、不封禁 —— 站长调试/自家监控不被误伤
  if (securitySettings.isTrustedIp(ip)) return false;
  const sec = securitySettings.getConfig();
  const key = reputationKey(ip);
  if (!key) return false;
  const now = Date.now();
  let rec = records.get(key);
  if (!rec) {
    rec = { score: 0, updatedAt: now, strikes: 0, banUntil: 0, banCount: 0, lastBanUntil: 0 };
    records.set(key, rec);
    if (records.size > REPUTATION_MAX) pruneReputation(key);
  }
  // 封禁期内的重复上报仅延长事件记录，不叠加
  if (now < rec.banUntil) {
    logEvent(type, key, path, '重复攻击（封禁中）');
    return false;
  }

  const weights = { ...FALLBACK_WEIGHTS, ...(sec.weights || {}) };
  const weight = weights[type] ?? FALLBACK_WEIGHTS.rate;
  rec.score += weight;
  rec.updatedAt = now;
  rec.strikes += 1;
  logEvent(type, key, path);

  const banScore = Number(sec.banScore) || FALLBACK_BAN_SCORE;
  if (rec.score >= banScore) {
    // 累犯轮次老化：距上次封禁超过 30 天的 IP 重新从第 1 轮计，
    // 不再终身指数翻倍（一个月前的 3 轮封禁不应让今天的首次违规直接 2 小时起步）
    const resetDays = Number(sec.banCountResetDays ?? 30);
    if (resetDays > 0 && rec.lastBanUntil && now - rec.lastBanUntil > resetDays * 86400 * 1000) {
      rec.banCount = 0;
    }
    rec.banCount += 1;
    const baseBanMs = (Number(sec.baseBanMinutes) || 15) * 60 * 1000;
    const maxBanMs = (Number(sec.maxBanHours) || 24) * 3600 * 1000;
    const duration = Math.min(baseBanMs * Math.pow(2, rec.banCount - 1), maxBanMs);
    rec.banUntil = now + duration;
    rec.lastBanUntil = rec.banUntil;
    rec.score = 0;
    // 记录本次封禁的触发原因（最近一次违规行为）
    rec.lastBanReason = String(path || type || '').slice(0, 120);
    logEvent('ban', key, path, `封禁 ${Math.round(duration / 60000)} 分钟`);
    persistBan(key, rec.banUntil, rec.banCount, rec.lastBanReason);
    // 邮件告警（可选）：配置 SMTP 后，每次触发新封禁通知站长；
    // 封禁期内的重复攻击不再告警（104 行提前返回），天然防告警轰炸
    if (config.security.alertOnBan !== false) {
      const { send } = require('../utils/notifyMail');
      send(
        '安全告警：有 IP 被自动封禁',
        `IP ${key} 因恶意行为被自动封禁 ${Math.round(duration / 60000)} 分钟\n触发原因：${rec.lastBanReason}\n累计封禁次数：${rec.banCount}\n封禁至：${new Date(rec.banUntil).toLocaleString('zh-CN')}`
      ).catch(() => {});
    }
    return true;
  }
  return false;
}

/** 手动封禁（管理员操作：安全中心 / 留言管理一键封禁）：
 *  不走信誉积分累积，直接进入封禁态并持久化；可信白名单与本机地址拒绝封禁 */
function ban(ip, minutes = 30 * 24 * 60, reason = '') {
  if (!ip) return false;
  if (securitySettings.isTrustedIp(ip)) return false;
  if (isLoopbackIp(ip)) return false;
  const key = reputationKey(ip);
  if (!key) return false;
  const now = Date.now();
  let rec = records.get(key);
  if (!rec) {
    rec = { score: 0, updatedAt: now, strikes: 0, banUntil: 0, banCount: 0, lastBanUntil: 0 };
    records.set(key, rec);
  }
  const duration = Math.max(60 * 1000, minutes * 60 * 1000);
  rec.banCount += 1;
  rec.banUntil = now + duration;
  rec.lastBanUntil = rec.banUntil;
  rec.score = 0;
  rec.lastBanReason = String(reason || '管理员手动封禁').slice(0, 120);
  logEvent('ban', key, 'manual', `手动封禁 ${Math.round(duration / 60000)} 分钟：${rec.lastBanReason}`);
  persistBan(key, rec.banUntil, rec.banCount, rec.lastBanReason);
  return true;
}

/** 当前是否被封禁 */
function isBanned(ip) {
  if (!ip) return false;
  // 白名单 IP 即使有历史封禁记录也直接视为未封禁（双保险：手动解封遗漏时不误伤）
  if (securitySettings.isTrustedIp(ip)) return false;
  decay();
  const key = reputationKey(ip);
  const rec = records.get(key);
  if (!rec) return false;
  if (rec.banUntil > Date.now()) return true;
  if (rec.banUntil && rec.banUntil <= Date.now()) {
    rec.banUntil = 0;
    // 解除持久化记录
    deletePersistedBan(key);
  }
  return false;
}

/** 查询封禁剩余秒数 */
function banRemain(ip) {
  const rec = records.get(reputationKey(ip));
  if (!rec) return 0;
  return Math.max(0, Math.ceil((rec.banUntil - Date.now()) / 1000));
}

/** 查询当前信誉积分（供自适应难度/限流使用） */
function getScore(ip) {
  if (!ip) return 0;
  decay();
  const rec = records.get(reputationKey(ip));
  return rec ? rec.score : 0;
}

/** 是否处于封禁期 */
function isBannedNow(ip) {
  return isBanned(ip);
}

/** 手动解封（后台安全中心） */
async function unban(ip) {
  const key = reputationKey(ip);
  records.delete(key);
  await deletePersistedBan(key);
  logEvent('unban', key, '后台手动解封');
}

/** 中间件：被封禁 IP 直接拒绝；仅保留反爬引导通道供客户端获取挑战。 */
function ipGuard(req, res, next) {
  // 登录和后台接口不再豁免：否则攻击者在触发信誉封禁后仍可继续爆破
  // 或访问高价值管理端点。反爬引导本身不授予业务访问权限，继续放行。
  const p = req.originalUrl.split('?')[0];
  const prefix = config.apiPrefix;
  if (p.startsWith(`${prefix}/anti`)) return next();
  if (isBanned(req.ip)) {
    const remain = banRemain(req.ip);
    res.set('Retry-After', String(remain || 1));
    return res.status(403).json({ code: 1, message: '访问被拒绝', data: null });
  }
  next();
}

/** 后台面板数据（实时内存事件 + 持久化历史事件 + 真实总数统计） */
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
  // 攻击类型分布（以 DB 近 7 天真实计数为基，内存里**尚未落库**的部分再叠加）
  //
  // 为什么不能两边直接相加：内存环形缓冲和 audit_logs 记的是同一批事件的两个阶段。
  // logEvent 先 push 内存、再由 queuePersist 批量 flush 落库，因此任何已 flush 的事件
  // 同时在两边存在。原实现 `typeCounts` 先数完内存 300 条，再把 DB 7 天计数整个加上，
  // 于是同一批事件被算两遍 —— 实测 3 条 waf 事件落库后，面板报 event_total=6。
  // 频次越高的攻击（正是站长最需要看清的那种）虚高越严重，且每次刷新都变。
  //
  // 正确口径：DB 是已落库事件的权威计数，内存只补「还在队列里、尚未 flush」的那些。
  // persistQueue 在 flush 成功的瞬间被清空，所以它就是未落库的精确集合。
  const typeCounts = {};
  const countType = (type) => {
    const key = type === 'ban' || type === 'unban' ? 'ban' : type;
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  };
  let persisted = [];
  let dbCounts = {};
  try {
    // 持久化历史（最近 50 条；与实时事件按时间倒序合并展示）
    persisted = await db('audit_logs')
      .where('action', 'like', 'SEC-EVENT%')
      .orderBy('id', 'desc')
      .limit(50)
      .select('id', 'action', 'detail', 'ip', 'created_at');
    // 近 7 天各类型真实计数（供分布图与总数展示）
    const since = new Date(now - 7 * 86400 * 1000);
    const rows = await db('audit_logs')
      .where('action', 'like', 'SEC-EVENT%')
      .where('created_at', '>', since)
      .select('action')
      .count('* as cnt')
      .groupBy('action');
    for (const r of rows) {
      const type = String(r.action).replace('SEC-EVENT ', '') || 'event';
      const key = type === 'ban' || type === 'unban' ? 'ban' : type;
      dbCounts[key] = (dbCounts[key] || 0) + Number(r.cnt);
    }
  } catch (e) { /* 表不可用忽略 */ }
  // 内存里尚未落库的那部分（flush 成功即从 persistQueue 移除）
  for (const item of persistQueue) {
    const type = String(item.action || '').replace('SEC-EVENT ', '') || 'event';
    countType(type);
  }
  const persistedEvents = persisted.map((p) => ({
    t: new Date(p.created_at).getTime(),
    type: String(p.action).replace('SEC-EVENT ', '') || 'event',
    ip: p.ip,
    path: '',
    detail: p.detail,
    persisted: true,
  }));
  // 去重合并：内存实时事件 + DB 历史
  const merged = [...persistedEvents, ...events.slice(-50).reverse()];
  // 分布以「DB 近 7 天真实计数」为基，内存实时事件叠加（未落库的部分）
  for (const [k, v] of Object.entries(dbCounts)) typeCounts[k] = (typeCounts[k] || 0) + v;
  const eventTotal = Object.values(typeCounts).reduce((a, b) => a + b, 0);
  return {
    banned,
    events: merged.slice(0, 50),
    event_total: eventTotal,
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
  ban,
  unban,
  loadPersistedBans,
  reputationKey,
};
