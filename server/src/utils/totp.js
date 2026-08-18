/**
 * TOTP 两步验证（RFC 6238 / HOTP RFC 4226）
 * 纯 Node crypto 实现，无外部依赖：
 * - 生成 Base32 密钥
 * - 基于 HMAC-SHA1 动态截断生成 6 位验证码
 * - 校验时允许 ±1 个时间步长（30s）容差，防时钟偏差
 * - 防重放：记录最近一次成功使用的步数，拒绝同一步重复使用
 */

const crypto = require('crypto');

const STEP = 30; // 时间步长（秒）
const DIGITS = 6;
const WINDOW = 1; // 前后容差步数
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 生成随机 Base32 密钥（默认 32 字符 = 160bit 熵） */
function generateSecret(length = 32) {
  const bytes = crypto.randomBytes(Math.ceil((length * 5) / 8));
  let secret = '';
  for (let i = 0; i < length; i++) {
    const bitIndex = i * 5;
    const byteIndex = Math.floor(bitIndex / 8);
    const offset = bitIndex % 8;
    // 从 bytes 中按 5-bit 分组取字符
    let value;
    if (offset <= 3) {
      value = (bytes[byteIndex] >> (3 - offset)) & 0x1f;
    } else {
      value = ((bytes[byteIndex] << (offset - 3)) | (bytes[byteIndex + 1] >> (11 - offset))) & 0x1f;
    }
    secret += BASE32_ALPHABET[value];
  }
  return secret;
}

/** Base32 解码为 Buffer */
function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 计算指定计数步的 HOTP 验证码 */
function hotp(secretBuffer, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuffer).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** 当前时间步数 */
function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP);
}

/** 生成 otpauth:// URI（供二维码展示） */
function otpauthUri(secret, account, issuer = 'Xalor Blog') {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString()}`;
}

/**
 * 校验用户提交的验证码
 * @param {string} secret Base32 密钥
 * @param {string} code 用户输入的 6 位验证码
 * @param {Map<string,number>} [replayGuard] 防重放表：key -> 最近成功的步数
 * @param {string} [guardKey] 防重放表的键（如用户 id）
 */
function verifyCode(secret, code, replayGuard, guardKey) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
  const secretBuffer = base32Decode(secret);
  if (secretBuffer.length === 0) return false;
  const step = currentStep();
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const candidate = hotp(secretBuffer, step + offset);
    if (candidate === code.trim()) {
      // 防重放：同一步成功过则拒绝
      if (replayGuard && guardKey) {
        let used = replayGuard.get(guardKey);
        if (!(used instanceof Set)) {
          // 兼容旧版只存单个步数的内存态
          used = new Set(Number.isInteger(used) ? [used] : []);
          replayGuard.set(guardKey, used);
        }
        if (used.has(step + offset)) return false;
        used.add(step + offset);
        // 单键即时裁剪：只保留当前 ±1 窗口可能重放的步，防单用户高频登录撑爆内存
        const current = currentStep();
        for (const s of used) {
          if (current - s > 2) used.delete(s);
        }
        // 定期清理，防内存膨胀
        if (replayGuard.size > 5000) {
          const now = currentStep();
          for (const [k, steps] of replayGuard) {
            if (!(steps instanceof Set)) {
              replayGuard.delete(k);
              continue;
            }
            for (const s of steps) {
              if (now - s > 2) steps.delete(s);
            }
            if (!steps.size) replayGuard.delete(k);
          }
        }
      }
      return true;
    }
  }
  return false;
}

module.exports = { generateSecret, verifyCode, otpauthUri, currentStep };
