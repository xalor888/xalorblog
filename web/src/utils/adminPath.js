/**
 * 管理后台秘钥路径
 * 后台地址不再是固定的 /admin，而是由服务端 JWT_SECRET 派生的随机段（默认 12 位 hex，
 * 可用 ADMIN_PATH 环境变量自定义为字母数字下划线中划线，最长 16 位）
 * 每个实例路径不同；该接口要求持有有效通行证票据（PoW 换取的浏览器才能拿到后台地址），
 * 未完成 PoW 的脚本/爬虫请求一律返回「访问被拒绝」。
 * 通过动态 import 使用 axios（携带票据），避免与 api/index.js 静态循环依赖。
 */

const BASE = import.meta.env.VITE_API_PREFIX || '/api';

let cached = '';
try {
  cached = sanitizePath(localStorage.getItem('xalor_admin_path') || '');
} catch (e) { /* 隐私模式忽略 */ }

let pending = null;
let requestModule = null;

async function getRequest() {
  if (!requestModule) requestModule = import('@/api');
  return requestModule;
}

/** 与 server config.adminPath 一致的白名单清理 */
function sanitizePath(p) {
  return String(p || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
}

/**
 * 获取管理后台秘钥路径
 * @returns {Promise<string>} 如 "3f9a2c7e51bd" 或自定义 "my-admin"
 */
export function getAdminPath() {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = (async () => {
    try {
      const { default: request } = await getRequest();
      const data = await request.get('/anti/admin-path');
      const path = sanitizePath(data && data.path);
      if (path) {
        cached = path;
        try {
          localStorage.setItem('xalor_admin_path', path);
        } catch (e) { /* 隐私模式忽略 */ }
      }
      return path;
    } catch (e) {
      return '';
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** 同步读取已缓存的路径（未加载则空字符串） */
export function getCachedAdminPath() {
  return cached;
}

/**
 * 生成管理后台路由路径
 * @param {string} seg 子路径，如 'dashboard'、'security'
 * @returns {string} 如 "/3f9a2c7e51bd/dashboard"；未加载时返回占位
 */
export function adminHref(seg = '') {
  if (!cached) return seg ? `/_/${seg}` : '/_';
  return seg ? `/${cached}/${seg}` : `/${cached}`;
}

/** 强制刷新（后台路径在设置中被重置时调用） */
export function refreshAdminPath() {
  cached = '';
  try {
    localStorage.removeItem('xalor_admin_path');
  } catch (e) { /* 忽略 */ }
  return getAdminPath();
}
