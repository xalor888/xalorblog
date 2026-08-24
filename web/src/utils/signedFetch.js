/**
 * 绕过 axios JSON 拦截器的签名 GET（后台导出 CSV/JSON）。
 * 读接口现在也要 X-Sig，裸 fetch 会被闸门拒绝。
 */

import { getTicket } from './pass';
import { getFingerprint } from './fingerprint';
import { getAuthToken } from './authSession';

const API_PREFIX = import.meta.env.VITE_API_PREFIX || '/api';

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sigPath(url) {
  const path = url.split('?')[0];
  const prefix = API_PREFIX.replace(/\/+$/, '');
  if (prefix && path.startsWith(prefix)) return path.slice(prefix.length) || '/';
  return path;
}

export async function signedFetch(url, { method = 'GET', headers = {} } = {}) {
  const ticket = getTicket();
  const jti = ticket ? ticket.split('.')[1] || '' : '';
  const ts = String(Date.now());
  const nonce = randomHex(16);
  const bodyHash = await sha256Hex('{}');
  const msg = [method.toUpperCase(), sigPath(url), ts, bodyHash, jti, nonce].join('|');
  const sig = await hmacHex(ticket, msg);
  return fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
      'X-Pass': ticket,
      'X-Fp': await getFingerprint(),
      'X-Timestamp': ts,
      'X-Nonce': nonce,
      'X-Sig': sig,
      ...headers,
    },
  });
}
