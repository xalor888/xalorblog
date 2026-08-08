/**
 * 客户端加解密（与 server 端 utils/crypto.js 对应）
 * 密钥 = HMAC-SHA256(ENC_SALT, passTicket)，服务端返回的密文只有持有票据的浏览器能解开
 */

import { getTicket, ENC_SALT } from './pass';

const encSaltBuf = new TextEncoder().encode(ENC_SALT);

/** 用票据派生 AES-GCM 密钥（与服务端派生逻辑一致） */
async function deriveKey(ticket) {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encSaltBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(ticket));
  return crypto.subtle.importKey('raw', sig, { name: 'AES-GCM' }, false, ['decrypt']);
}

/**
 * 解密服务端加密的正文
 * 密文格式（base64）：iv(12B) | tag(16B) | ciphertext
 * @param {string} payload
 * @returns {Promise<string>} 明文或空字符串
 */
export async function decryptContent(payload, ticket = null) {
  try {
    const useTicket = ticket || getTicket();
    if (!useTicket || !payload) return '';
    const raw = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    if (raw.length < 28) return '';
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const data = raw.slice(28);
    const key = await deriveKey(useTicket);
    // WebCrypto 期望输入为 iv || ciphertext || tag
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
