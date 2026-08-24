/**
 * 通行证票据会话管理
 * 1. 首次进入页面：获取 PoW 挑战 → 求解 → 换取票据
 * 2. 票据 10 分钟有效，第 8 分钟自动滑动续期（免重算 PoW）
 * 3. 服务端校验票据过期/失效时，自动重新走完整流程
 */

import { getFingerprint } from './fingerprint';
import { solvePow } from './pow';
import { applyEncSalt } from './encSalt';

const BASE = import.meta.env.VITE_API_PREFIX || '/api';
const RENEW_AT = 8 * 60 * 1000;
const TICKET_TTL = 10 * 60 * 1000;

let ticket = null;
let ticketTime = 0;
let inFlight = null;
let renewTimer = null;

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
    scheduleRenew();
    return ticket;
  } catch (e) {
    // 续期失败：重新走完整 PoW 流程
    return forceRefresh();
  }
}

function scheduleRenew() {
  clearRenewTimer();
  renewTimer = setTimeout(() => {
    renew().catch(() => {});
  }, RENEW_AT);
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
  return ensurePass();
}

/** 构建期默认盐；运行时以换票/续期响应的 enc_salt 为准 */
export { DEFAULT_ENC_SALT as ENC_SALT } from './encSalt';
