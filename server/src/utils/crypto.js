/**
 * 内容加密工具：AES-256-GCM
 * 密钥 = HMAC-SHA256(encSalt, passTicket[|articleKey])
 * articleKey（通常是 slug）让抓包得到的密文无法用同一张票解开另一篇。
 * 持有有效通行证仍可按篇解密；这只提高批量抓取成本，不是访问控制。
 */

const crypto = require('crypto');
const config = require('../config');

const ALGO = 'aes-256-gcm';
const TAG_LEN = 16;
const IV_LEN = 12;

function keyMaterial(passTicket, articleKey) {
  const ticket = String(passTicket || '');
  const extra = articleKey == null || articleKey === '' ? '' : `|${articleKey}`;
  return ticket + extra;
}

function deriveKey(passTicket, articleKey) {
  return crypto.createHmac('sha256', config.security.encSalt).update(keyMaterial(passTicket, articleKey)).digest();
}

/** 加密：返回 iv|tag|ciphertext（base64） */
function encryptPayload(plaintext, passTicket, articleKey) {
  const key = deriveKey(passTicket, articleKey);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密（服务端备用，正常流程由前端解密） */
function decryptPayload(payload, passTicket, articleKey) {
  try {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);
    const key = deriveKey(passTicket, articleKey);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { encryptPayload, decryptPayload, deriveKey, keyMaterial };
