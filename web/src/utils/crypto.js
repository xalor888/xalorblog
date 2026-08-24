/**
 * 客户端加解密（与 server 端 utils/crypto.js 对应）
 * 密钥 = HMAC-SHA256(ENC_SALT, passTicket[|articleKey])
 * 密文格式（base64）：iv(12B) | tag(16B) | ciphertext
 * WebCrypto decrypt 的输入必须是 ciphertext||tag，不能把 IV 再拼进去。
 */

import { getTicket } from './pass';
import { getEncSalt } from './encSalt';

function keyMaterial(ticket, articleKey) {
  const extra = articleKey == null || articleKey === '' ? '' : `|${articleKey}`;
  return String(ticket || '') + extra;
}

/** 用票据（及可选篇密钥）派生 AES-GCM 密钥 */
async function deriveKey(ticket, articleKey) {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getEncSalt()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(keyMaterial(ticket, articleKey)));
  return crypto.subtle.importKey('raw', sig, { name: 'AES-GCM' }, false, ['decrypt']);
}

/**
 * 解密服务端加密的正文
 */
export async function decryptContent(payload, ticket = null, articleKey = '') {
  try {
    const useTicket = ticket || getTicket();
    if (!useTicket || !payload) return '';
    const raw = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    if (raw.length < 28) return '';
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const key = await deriveKey(useTicket, articleKey);
    const input = new Uint8Array(data.length + tag.length);
    input.set(data, 0);
    input.set(tag, data.length);
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
