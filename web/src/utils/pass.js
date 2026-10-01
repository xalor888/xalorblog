/**
 * 通行证票据会话管理
 * 1. 首次进入页面：获取 PoW 挑战 → 求解 → 换取票据
 * 2. 票据 10 分钟有效，第 8 分钟自动滑动续期（免重算 PoW）
 * 3. 服务端校验票据过期/失效时，自动重新走完整流程
 * 4. 票据与派生内容密钥所需的会话盐一起写入浏览器存储：
 *    刷新页面 / 同标签页内二次进入直接复用，不再重算 PoW
 *    （PoW 是实测秒级开销，而票据本来就有 10 分钟有效期与 10 次续期上限，
 *     只在内存里持有等于让每个刷新都白付一次计算成本）
 *    - sessionStorage：本标签页副本，刷新即可复用
 *    - localStorage：跨标签页副本，票据有效期内新开标签页也不必重算
 *    两份都按 TICKET_TTL 判活，过期即弃。localStorage 副本是「持久敏感数据」，
 *    与项目「敏感数据只留 sessionStorage」的约定相比是有意放宽的一档：
 *    权衡点是 PoW 的算力成本，且副本本身有 10 分钟硬上限、与票据绑定的
 *    指纹/UA/HMAC 依然生效，泄露它并不等于拿到长期凭据。
 */

import { getFingerprint } from './fingerprint';
import { solvePow } from './pow';
import { applyEncSalt, getEncSalt } from './encSalt';

const BASE = import.meta.env.VITE_API_PREFIX || '/api';
const RENEW_AT = 8 * 60 * 1000;
const TICKET_TTL = 10 * 60 * 1000;
/** 恢复的票据已过续期点时的补续期延迟，避开首屏接口爆发的同一时刻 */
const RENEW_GRACE = 3000;

/** 本标签页副本键 */
const STORE_KEY = 'xalor_pass_v1';
/** 跨标签页副本键（独立命名，避免被 secureStorage 的「迁移后清除 localStorage」逻辑删掉） */
const PERSIST_KEY = 'xalor_pass_keep_v1';

let ticket = null;
let ticketTime = 0;
let inFlight = null;
let renewTimer = null;

/** 存储访问一律容错：隐私模式 / 存储被禁用时静默退回纯内存行为 */
function readRaw(storage, key) {
  try {
    return storage?.getItem(key) || '';
  } catch (e) {
    return '';
  }
}

function writeRaw(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch (e) {
    /* 忽略 */
  }
}

function dropRaw(storage, key) {
  try {
    storage?.removeItem(key);
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 写入两份副本。
 * 会话盐必须与票据同行：正文解密密钥 = HMAC(ENC_SALT, ticket[|articleKey])，
 * 只恢复票据而丢掉服务端下发的盐，正文会静默解不出来。
 */
function persist() {
  if (!ticket) return;
  const rec = JSON.stringify({ t: ticket, ts: ticketTime, s: getEncSalt() });
  writeRaw(globalThis.sessionStorage, STORE_KEY, rec);
  writeRaw(globalThis.localStorage, PERSIST_KEY, rec);
}

function clearPersisted() {
  dropRaw(globalThis.sessionStorage, STORE_KEY);
  dropRaw(globalThis.localStorage, PERSIST_KEY);
}

/** 解析并校验副本（票据过期或结构损坏一律丢弃） */
function parseRecord(raw) {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (!rec || typeof rec.t !== 'string' || !rec.t.includes('.')) return null;
    if (!Number.isFinite(rec.ts) || Date.now() - rec.ts >= TICKET_TTL) return null;
    return rec;
  } catch (e) {
    return null;
  }
}

/** 取可用副本：优先本标签页，其次跨标签页（命中后提升一份到本标签页） */
function readPersisted() {
  const session = parseRecord(readRaw(globalThis.sessionStorage, STORE_KEY));
  if (session) return session;

  const kept = parseRecord(readRaw(globalThis.localStorage, PERSIST_KEY));
  if (kept) {
    writeRaw(globalThis.sessionStorage, STORE_KEY, JSON.stringify(kept));
    return kept;
  }
  // 过期副本不再保留，免得下次再解析一遍
  dropRaw(globalThis.sessionStorage, STORE_KEY);
  dropRaw(globalThis.localStorage, PERSIST_KEY);
  return null;
}

function clearRenewTimer() {
  if (renewTimer) {
    clearTimeout(renewTimer);
    renewTimer = null;
  }
}

/** 低层请求（不经过 axios 拦截器，避免循环依赖；10 秒超时防挂起） */
async function raw(path, options = {}) {
  const headers = Object.assign(
    { 'X-Fp': await getFingerprint() },
    options.headers || {}
  );
  if (ticket) headers['X-Pass'] = ticket;
  if (options.method && options.method !== 'GET') {
    headers['X-Timestamp'] = String(Date.now());
  }
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(BASE + path, {
      method: options.method || 'GET',
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status >= 400 || data.code !== 0) {
      const err = new Error(data.message || '安全通道建立失败');
      err.status = res.status;
      throw err;
    }
    return data.data;
  } finally {
    clearTimeout(timer);
  }
}

/** 完成 PoW 并获取票据 */
async function acquire() {
  const fp = await getFingerprint();
  const puzzle = await raw('/anti/puzzle', {
    headers: { 'X-Fp': fp },
  });
  const solution = await solvePow(puzzle.prefix, puzzle.difficulty);
  const issued = await raw('/anti/ticket', {
    method: 'POST',
    headers: { 'X-Fp': fp },
    json: { id: puzzle.id, solution },
  });
  if (issued.enc_salt) applyEncSalt(issued.enc_salt);
  ticket = issued.token;
  ticketTime = Date.now();
  persist();
  scheduleRenew();
  return ticket;
}

/** 滑动续期（旧票据有效期内无需重复 PoW） */
async function renew() {
  if (!ticket) return ensurePass();
  const fp = await getFingerprint();
  try {
    const issued = await raw('/anti/renew', {
      method: 'POST',
      headers: { 'X-Fp': fp },
      json: {},
    });
    if (issued.enc_salt) applyEncSalt(issued.enc_salt);
    ticket = issued.token;
    ticketTime = Date.now();
    persist();
    scheduleRenew();
    return ticket;
  } catch (e) {
    // 续期失败：重新走完整 PoW 流程
    return forceRefresh();
  }
}

function scheduleRenew() {
  clearRenewTimer();
  // 恢复自持久副本的票据可能已越过续期点：按剩余时间排程（过点则延后一点，避开首屏接口爆发）
  const remain = RENEW_AT - (Date.now() - ticketTime);
  const delay = remain > 0 ? remain : RENEW_GRACE;
  renewTimer = setTimeout(() => {
    renew().catch(() => {});
  }, delay);
}

/**
 * 确保已有有效票据（应用启动 / 首次请求前调用）
 * @returns {Promise<string>}
 */
export function ensurePass() {
  if (ticket && Date.now() - ticketTime < TICKET_TTL) {
    return Promise.resolve(ticket);
  }
  if (inFlight) return inFlight;
  inFlight = acquire()
    .then((t) => t)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** 同步读取当前票据（无则 null） */
export function getTicket() {
  return ticket;
}

/** 强制重新获取（票据被服务端判废时调用） */
export async function forceRefresh() {
  clearRenewTimer();
  ticket = null;
  ticketTime = 0;
  clearPersisted();
  return ensurePass();
}

// 启动即尝试复用已有票据（本标签页副本优先，其次跨标签页副本）：命中则完全跳过 PoW，
// 否则 ensurePass() 会照常走完整挑战流程
const restored = readPersisted();
if (restored) {
  ticket = restored.t;
  ticketTime = restored.ts;
  if (typeof restored.s === 'string') applyEncSalt(restored.s);
  scheduleRenew();
}

/** 构建期默认盐；运行时以换票/续期响应的 enc_salt 为准 */
export { DEFAULT_ENC_SALT as ENC_SALT } from './encSalt';
