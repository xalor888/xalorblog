import axios from 'axios';
import { ElMessage } from 'element-plus';
import { ensurePass, getTicket, forceRefresh } from '@/utils/pass';
import { getFingerprint } from '@/utils/fingerprint';
import { decryptContent } from '@/utils/crypto';
import { getCachedAdminPath, getAdminPath, refreshAdminPath } from '@/utils/adminPath';

// 接口前缀与后端一致（生产可改为随机字符串，前端同环境变量注入）
const API_PREFIX = import.meta.env.VITE_API_PREFIX || '/api';

const request = axios.create({
  baseURL: API_PREFIX,
  timeout: 20000,
});

/** 请求签名：X-Sig = HMAC(key=ticket, method|path|ts|bodyHash|jti|nonce)，与服务端同源逻辑 */
async function signRequest(config) {
  const ticket = getTicket();
  const jti = ticket ? ticket.split('.')[1] || '' : '';
  const ts = String(Date.now());
  const nonce = randomHex(16);
  const bodyHash = await sha256Hex(JSON.stringify(config.data ?? {}));
  const path = config.url.split('?')[0];
  const msg = [config.method.toUpperCase(), path, ts, bodyHash, jti, nonce].join('|');
  const sig = await hmacHex(ticket, msg);
  return { ts, sig, nonce };
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 请求拦截：附加票据 + 指纹 + JWT + 时间戳 + 签名
request.interceptors.request.use(async (config) => {
  await ensurePass();
  const fp = await getFingerprint();
  config.headers['X-Fp'] = fp;
  config.headers['X-Pass'] = getTicket();
  // 记录本次请求所用的票据：正文加密与请求时的票据绑定 ——
  // 若请求在途期间票据被 8 分钟自动续期替换，响应到达时 getTicket()
  // 已指向新票据，直接解密会因密钥不匹配而失败（正文渲染为空）
  config._ticket = getTicket();
  // JWT 认证头：后台接口依赖它通过 authRequired
  const token = localStorage.getItem('xalor_token');
  if (token) config.headers['Authorization'] = `Bearer ${token}`;
  if (['post', 'put', 'delete'].includes((config.method || '').toLowerCase())) {
    const { ts, sig, nonce } = await signRequest(config);
    config.headers['X-Timestamp'] = ts;
    config.headers['X-Sig'] = sig;
    config.headers['X-Nonce'] = nonce;
  }
  return config;
});

// 响应拦截：统一错误处理 + 正文解密
request.interceptors.response.use(
  async (response) => {
    const res = response.data;
    if (res.code !== 0) {
      ElMessage.error(res.message || '请求失败');
      return Promise.reject(new Error(res.message || '请求失败'));
    }
    // 解密加密正文（用请求时的票据，防在途续期导致密钥不匹配）
    const data = res.data;
    if (data && data.content_enc && typeof data.content === 'string') {
      try {
        data.content = await decryptContent(data.content, response.config?._ticket);
        data.content_enc = false;
      } catch (e) {
        data.content = '';
      }
    }
    return data;
  },
  async (error) => {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message || '网络错误';
    const isGateError = status === 403 && /通行证|访问被拒绝|安全通道/.test(message);
    if (status === 401) {
      // 已在登录页（如密码/验证码错误）：直接提示，不跳转
      const cached = getCachedAdminPath();
      const onLoginPage = cached && location.hash.includes(`/${cached}/login`);
      // 同步清空 Pinia store（防 isLoggedIn 残留 true 显示已登录状态）；
      // 动态 import 避免 api ↔ store 循环依赖
      try {
        const { useAuthStore } = await import('@/stores/auth');
        useAuthStore().clearSession();
      } catch (e) { /* 忽略 */ }
      if (!cached) {
        try {
          await getAdminPath();
        } catch (e) { /* 忽略 */ }
      }
      const key = getCachedAdminPath();
      if (onLoginPage || !key) {
        ElMessage.error(message || '请先登录');
      } else if (!location.hash.includes(`/${key}/login`)) {
        ElMessage.error(message || '请先登录');
        location.hash = `#/${key}/login`;
      }
    } else if (isGateError) {
      // 票据失效：强制重新建立安全通道后重试一次
      try {
        await forceRefresh();
        const cfg = error.config;
        if (cfg && !cfg._retried) {
          cfg._retried = true;
          return request(cfg);
        }
      } catch (e) {
        ElMessage.error('安全通道失效，请刷新页面');
      }
    } else if (
      status === 404 &&
      getCachedAdminPath() &&
      error.config?.url?.includes(`/${getCachedAdminPath()}/`)
    ) {
      // 后台秘钥路径失效（服务端更换了 JWT_SECRET / ADMIN_PATH）：
      // 刷新路径后重试一次
      try {
        const cfg = error.config;
        const oldKey = getCachedAdminPath();
        await refreshAdminPath();
        const newKey = getCachedAdminPath();
        if (cfg && !cfg._retried && newKey && newKey !== oldKey) {
          cfg._retried = true;
          cfg.url = cfg.url.replace(new RegExp(`^/${oldKey}/`), `/${newKey}/`);
          return request(cfg);
        }
      } catch (e) { /* 忽略 */ }
    } else if (status === 429) {
      // 限流（防刷/读取频率上限）：非错误语义，用 warning 提示避免误报
      ElMessage.warning(message || '操作过于频繁，请稍后再试');
    } else if (status === 403 && error.response?.headers?.['retry-after']) {
      // IP 被自动封禁：给出剩余时间（Retry-After 秒数），可操作提示替代通用错误
      const remain = Math.ceil(Number(error.response.headers['retry-after']) / 60);
      ElMessage.warning(`访问被拒绝：该 IP 因异常行为被临时封禁，约 ${remain} 分钟后自动解除`);
    } else {
      ElMessage.error(message);
    }
    return Promise.reject(error);
  }
);

/* ============ 后台接口辅助：拼入秘钥路径 ============
 * 全部管理接口（写操作 + 管理列表）都挂在 /api/<秘钥路径>/ 之下，
 * 与前台接口完全隔离，公共前缀下探测不到任何后台路由 */
function adminUrl(path) {
  const key = getCachedAdminPath();
  return key ? `/${key}${path}` : '';
}

function adminGet(path, params) {
  const url = adminUrl(path);
  if (!url) return Promise.reject(new Error('后台路径未加载'));
  return request.get(url, { params });
}

function adminPost(path, data, config) {
  const url = adminUrl(path);
  if (!url) return Promise.reject(new Error('后台路径未加载'));
  return request.post(url, data, config);
}

function adminPut(path, data) {
  const url = adminUrl(path);
  if (!url) return Promise.reject(new Error('后台路径未加载'));
  return request.put(url, data);
}

function adminDelete(path, config) {
  const url = adminUrl(path);
  if (!url) return Promise.reject(new Error('后台路径未加载'));
  return request.delete(url, config);
}

export default request;

/* ============ 业务 API ============ */

export const authApi = {
  login: (data) => request.post('/auth/login', data),
  me: () => request.get('/auth/me'),
  changePassword: (data) => request.put('/auth/password', data),
  sessions: () => request.get('/auth/sessions'),
  revokeSession: (jti) => request.delete(`/auth/sessions/${jti}`),
  logout: () => request.post('/auth/logout'),
  logoutAll: () => request.post('/auth/logout-all'),
  // 两步验证（TOTP）
  twoFaStatus: () => request.get('/auth/2fa/status'),
  twoFaSetup: () => request.post('/auth/2fa/setup'),
  twoFaVerify: (code) => request.post('/auth/2fa/verify', { code }),
  twoFaDisable: (code) => request.post('/auth/2fa/disable', { code }),
};

export const articleApi = {
  list: (params) => request.get('/articles', { params }),
  detail: (slug) => request.get(`/articles/slug/${slug}`),
  random: () => request.get('/articles/random'),
  archive: () => request.get('/articles/archive'),
  neighbors: (id) => request.get(`/articles/neighbors/${id}`),
  related: (id) => request.get(`/articles/related/${id}`),
  like: (id) => request.post(`/articles/${id}/like`),
  // 以下为后台接口（秘钥路径下）
  adminList: (params) => adminGet('/articles/admin/list', params),
  adminDetail: (id) => adminGet(`/articles/admin/${id}`),
  create: (data) => adminPost('/articles', data),
  update: (id, data) => adminPut(`/articles/${id}`, data),
  remove: (id) => adminDelete(`/articles/${id}`),
  batchDelete: (ids) => adminPost('/articles/batch-delete', { ids }),
  batchUpdate: (ids, action, extra = {}) => adminPost('/articles/batch-update', { ids, action, ...extra }),
  duplicate: (id) => adminPost(`/articles/${id}/duplicate`),
  importBackup: (items) => adminPost('/articles/admin/import', { items }),
};

export const categoryApi = {
  list: () => request.get('/categories'),
  create: (data) => adminPost('/categories', data),
  update: (id, data) => adminPut(`/categories/${id}`, data),
  remove: (id) => adminDelete(`/categories/${id}`),
};

export const tagApi = {
  list: () => request.get('/tags'),
  create: (data) => adminPost('/tags', data),
  remove: (id) => adminDelete(`/tags/${id}`),
  merge: (fromId, toId) => adminPost('/tags/merge', { from_id: fromId, to_id: toId }),
};

export const commentApi = {
  list: (articleId, sort) => request.get(`/comments/article/${articleId}`, { params: { sort } }),
  recent: () => request.get('/comments/recent'),
  create: (data, config) => request.post('/comments', data, config),
  like: (id) => request.post(`/comments/${id}/like`),
  reAi: (id) => request.post(`/comments/${id}/re-ai`),
  adminList: (params) => adminGet('/comments/admin/list', params),
  adminExport: (params) => adminGet('/comments/admin/export', params),
  updateStatus: (id, status) => adminPut(`/comments/${id}/status`, { status }),
  remove: (id) => adminDelete(`/comments/${id}`),
  batchDelete: (ids) => adminPost('/comments/batch-delete', { ids }),
  batchStatus: (ids, status) => adminPost('/comments/batch-status', { ids, status }),
  approveAll: () => adminPost('/comments/approve-all'),
};

export const linkApi = {
  list: () => request.get('/links'),
  apply: (data, config) => request.post('/links', data, config),
  adminList: (params) => adminGet('/links/admin/list', params),
  updateStatus: (id, data) => adminPut(`/links/${id}/status`, data),
  remove: (id) => adminDelete(`/links/${id}`),
  batchDelete: (ids) => adminPost('/links/batch-delete', { ids }),
  approveAll: () => adminPost('/links/approve-all'),
};

export const messageApi = {
  list: (params) => request.get('/messages', { params }),
  create: (data, config) => request.post('/messages', data, config),
  reAi: (id) => request.post(`/messages/${id}/re-ai`),
  adminList: (params) => adminGet('/messages/admin/list', params),
  updateStatus: (id, status) => adminPut(`/messages/${id}/status`, { status }),
  remove: (id) => adminDelete(`/messages/${id}`),
  batchDelete: (ids) => adminPost('/messages/batch-delete', { ids }),
  reply: (id, reply) => adminPut(`/messages/${id}/reply`, { reply }),
  approveAll: () => adminPost('/messages/approve-all'),
};

export const statsApi = {
  record: () => request.post('/stats/record'),
  summary: () => request.get('/stats/summary'),
  dashboard: (days) => adminGet('/stats/dashboard', days ? { days } : {}),
};

export const settingsApi = {
  get: () => request.get('/settings'),
  save: (data) => adminPut('/settings', data),
  exportBackup: () => adminGet('/settings/export'),
  importBackup: (data) => adminPost('/settings/import', data),
  testMail: () => adminPost('/settings/test-mail'),
};

export const securityApi = {
  overview: () => adminGet('/security'),
  audit: () => adminGet('/security/audit'),
  unban: (ip) => adminPost('/security/unban', { ip }),
};

export const auditApi = {
  list: (params) => adminGet('/audit/logs', params),
  clear: () => adminDelete('/audit/logs', { data: { confirm: true } }),
};
export const uploadApi = {
  upload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return adminPost('/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
};

export const imagesApi = {
  list: () => adminGet('/uploads/list'),
  remove: (name) => adminDelete(`/uploads/${encodeURIComponent(name)}`),
  cleanupOrphans: () => adminPost('/uploads/cleanup-orphans'),
};
