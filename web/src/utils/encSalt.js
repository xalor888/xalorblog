/** 与服务端 ENC_SALT 对齐的 HMAC 盐。构建期默认值可被闸门挑战覆盖。 */
export const DEFAULT_ENC_SALT = import.meta.env.VITE_ENC_SALT || 'xalor-content-v1';

let current = DEFAULT_ENC_SALT;

export function getEncSalt() {
  return current;
}

export function applyEncSalt(salt) {
  if (typeof salt !== 'string') return;
  const next = salt.trim();
  if (next.length < 8 || next.length > 128) return;
  current = next;
}
