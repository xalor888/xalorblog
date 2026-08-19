import {
  clearStoredPrefix,
  readSessionValue,
  removeStoredValue,
  writeSessionValue,
} from './secureStorage.js';

const TOKEN_KEY = 'xalor_token';
const USER_KEY = 'xalor_user';

// sessionStorage 不可用时仍允许当前页面维持登录，但不回退到持久存储。
let memoryToken = '';
let memoryUser = null;

export function getAuthToken() {
  if (!memoryToken) memoryToken = readSessionValue(TOKEN_KEY);
  return memoryToken;
}

export function getCachedAuthUser() {
  if (memoryUser) return memoryUser;
  const raw = readSessionValue(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    memoryUser = parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    removeStoredValue(USER_KEY);
    memoryUser = null;
  }
  return memoryUser;
}

export function setAuthSession(token, user) {
  memoryToken = String(token || '');
  memoryUser = user && typeof user === 'object' ? user : null;
  writeSessionValue(TOKEN_KEY, memoryToken);
  writeSessionValue(USER_KEY, memoryUser ? JSON.stringify(memoryUser) : '');
}

export function setCachedAuthUser(user) {
  memoryUser = user && typeof user === 'object' ? user : null;
  writeSessionValue(USER_KEY, memoryUser ? JSON.stringify(memoryUser) : '');
}

export function clearAuthSession() {
  memoryToken = '';
  memoryUser = null;
  removeStoredValue(TOKEN_KEY);
  removeStoredValue(USER_KEY);
}

/** 明确登出时不把未发布文章草稿留给同一标签页中的下一位用户。 */
export function clearAdminDrafts() {
  clearStoredPrefix('xalor_draft_');
}
