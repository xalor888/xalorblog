import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { authApi } from '@/api';
import {
  clearAdminDrafts,
  clearAuthSession,
  getAuthToken,
  getCachedAuthUser,
  setAuthSession,
  setCachedAuthUser,
} from '@/utils/authSession';

export const useAuthStore = defineStore('auth', () => {
  const token = ref(getAuthToken());
  const user = ref(getCachedAuthUser());

  const isLoggedIn = computed(() => !!token.value);

  async function login(credentials) {
    const data = await authApi.login(credentials);
    token.value = data.token;
    user.value = data.user;
    // 仅保留到当前标签页；存储不可用时 authSession 自动降级为内存态。
    setAuthSession(data.token, data.user);
    return data;
  }

  async function logout() {
    // 必须先等待服务端撤销：若提前清空令牌，异步请求拦截器会发出无认证的 logout。
    let revoked = true;
    try {
      if (token.value) await authApi.logout();
    } catch (e) {
      revoked = false;
    } finally {
      clearAdminDrafts();
      clearSession();
    }
    return { revoked };
  }

  /** 清空会话（本地登出 / 401 会话失效共用） */
  function clearSession() {
    token.value = '';
    user.value = null;
    clearAuthSession();
  }

  async function fetchMe() {
    if (!token.value) return null;
    try {
      user.value = await authApi.me();
      setCachedAuthUser(user.value);
    } catch (e) {
      /* token 失效由拦截器处理 */
    }
    return user.value;
  }

  return { token, user, isLoggedIn, login, logout, clearSession, fetchMe };
});
