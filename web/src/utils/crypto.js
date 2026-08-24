/**
 * 客户端加解密（与 server 端 utils/crypto.js 对应）
 * 密钥 = HMAC-SHA256(ENC_SALT, passTicket[|articleKey])
 * articleKey 让同一张票解开的密文不能复用到另一篇。
 */

import { getTicket, ENC_SALT } from './pass';

const encSaltBuf = new TextEncoder().encode(ENC_SALT);

function keyMaterial(ticket, articleKey) {
  const extra = articleKey == null || articleKey === '' ? '' : `|${articleKey}`;
  return String(ticket || '') + extra;
}

/** 用票据（及可选篇密钥）派生 AES-GCM 密钥 */
async function deriveKey(ticket, articleKey) {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encSaltBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(keyMaterial(ticket, articleKey)));
  return crypto.subtle.importKey('raw', sig, { name: 'AES-GCM' }, false, ['decrypt']);
}

/**
 * 解密服务端加密的正文
 * 密文格式（base64）：iv(12B) | tag(16B) | ciphertext
 */
export async function decryptContent(payload, ticket = null, articleKey = '') {
  try {
    const useTicket = ticket || getTicket();
    if (!useTicket || !payload) return '';
    const raw = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    if (raw.length < 28) return '';
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const data = raw.slice(28);
    const key = await deriveKey(useTicket, articleKey);
    const input = Uint8Array.from([...iv, ...data, ...tag]);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      input
    );
    return new TextDecoder().decode(plain);
  } catch (e) {
    return '';
  }
}
