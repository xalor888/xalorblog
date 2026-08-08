import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { authApi } from '@/api';

/** 安全读取 localStorage 用户缓存：损坏数据（非 JSON）回退 null 而非抛异常——
 * 模块顶层执行期异常会导致整个应用白屏且无法自行恢复 */
function readCachedUser() {
  try {
    const raw = localStorage.getItem('xalor_user');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    try { localStorage.removeItem('xalor_user'); } catch (e2) { /* 忽略 */ }
    return null;
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('xalor_token') || '');
  const user = ref(readCachedUser());

  const isLoggedIn = computed(() => !!token.value);

  async function login(username, password) {
    const data = await authApi.login({ username, password });
    token.value = data.token;
    user.value = data.user;
    // 持久化（Safari 隐私模式/存储满时降级为内存态，登录不中断）
    try {
      localStorage.setItem('xalor_token', data.token);
      localStorage.setItem('xalor_user', JSON.stringify(data.user));
    } catch (e) { /* 内存态：刷新后需重新登录，功能不受影响 */ }
    return data;
  }

  function logout() {
    // 服务端撤销当前会话（失败静默，不影响本地登出）
    if (token.value) {
      authApi.logout().catch(() => {});
    }
    clearSession();
  }

  /** 清空会话（本地登出 / 401 会话失效共用） */
  function clearSession() {
    token.value = '';
    user.value = null;
    localStorage.removeItem('xalor_token');
    localStorage.removeItem('xalor_user');
  }

  async function fetchMe() {
    if (!token.value) return null;
    try {
      user.value = await authApi.me();
      localStorage.setItem('xalor_user', JSON.stringify(user.value));
    } catch (e) {
      /* token 失效由拦截器处理 */
    }
    return user.value;
  }

  return { token, user, isLoggedIn, login, logout, clearSession, fetchMe };
});
