/**
 * 内容加密工具：AES-256-GCM
 * 密钥 = HMAC-SHA256(encSalt, passTicket)
 * 浏览器端持有同样的 pass 票据，可自行派生密钥解密；
 * 脚本抓包只能拿到密文，无法还原正文 → 防直接抓取文章内容
 */

const crypto = require('crypto');
const config = require('../config');

const ALGO = 'aes-256-gcm';
const TAG_LEN = 16;
const IV_LEN = 12;

function deriveKey(passTicket) {
  return crypto.createHmac('sha256', config.security.encSalt).update(String(passTicket)).digest();
}

/** 加密：返回 `iv:tag:ciphertext`（base64） */
function encryptPayload(plaintext, passTicket) {
  const key = deriveKey(passTicket);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密（服务端备用，正常流程由前端解密） */
function decryptPayload(payload, passTicket) {
  try {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);
    const key = deriveKey(passTicket);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { encryptPayload, decryptPayload, deriveKey };
