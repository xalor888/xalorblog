import request from '@/api';
import { useSiteStore } from '@/stores/site';

// 令牌与提交路径强绑定，缓存按路径分片（评论/留言/友链各自独立）
// 服务端令牌 10 分钟过期：缓存 5 分钟后自动刷新，避免过期令牌导致首次提交必失败
const TOKEN_MAX_AGE = 5 * 60 * 1000;
// 服务端 MIN_INTERVAL=2s：签发后立刻提交会被判「疑似机器人」
const MIN_SUBMIT_AGE = 2100;
const cachedByPath = new Map(); // path -> { token, hpField, ts }
const fetchingByPath = new Map(); // path -> Promise

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenIssuedAt(token, fallback = Date.now()) {
  const ts = Number(String(token || '').split('.')[0]);
  return Number.isFinite(ts) && ts > 0 ? ts : fallback;
}

async function waitUntilReady(info) {
  const issued = tokenIssuedAt(info.token, info.ts);
  const wait = MIN_SUBMIT_AGE - (Date.now() - issued);
  if (wait > 0) await sleep(wait);
  return info;
}

/**
 * 获取表单安全令牌 + 随机蜜罐字段名
 * @param {string} forPath 目标提交接口（如 /comments），令牌与路径强绑定
 * @returns {Promise<{token: string, hpField: string}>}
 */
export async function getFormTokenInfo(forPath = '/comments') {
  const cached = cachedByPath.get(forPath);
  if (cached && Date.now() - cached.ts < TOKEN_MAX_AGE) return waitUntilReady(cached);
  const pending = fetchingByPath.get(forPath);
  if (pending) return pending.then(waitUntilReady);
  const p = request
    .get('/anti/seed', { params: { for: forPath } })
    .then((data) => {
      const info = {
        token: data.token,
        // 注意：fallback 名称不得与服务端固定蜜罐字段（website_url）同名 ——
        // bundle 可被分析，暴露固定蜜罐名会使其对了解者失效；
        // 任意未被真实表单使用的名称均可（动态蜜罐按 X-Hp-Field 声明检查）
        hpField: data.hp_field || 'hp_website',
        ts: Date.now(),
      };
      cachedByPath.set(forPath, info);
      return info;
    })
    .finally(() => {
      fetchingByPath.delete(forPath);
    });
  fetchingByPath.set(forPath, p);
  return p.then(waitUntilReady);
}

/** 兼容旧调用：仅取令牌 */
export async function getFormToken(forPath = '/comments') {
  const info = await getFormTokenInfo(forPath);
  return info.token;
}

/** 当前蜜罐字段名（按路径） */
export function getHpField(forPath = '/comments') {
  return cachedByPath.get(forPath)?.hpField || 'hp_website';
}

/** 强制刷新令牌（提交失败后调用，避免重复使用已消费的令牌） */
export function refreshFormToken(forPath) {
  if (forPath) cachedByPath.delete(forPath);
  else cachedByPath.clear();
}

/**
 * 加载站点时预热令牌（减少首次提交等待）
 */
export function warmFormToken() {
  if (!useSiteStore().loaded) return;
  ['/comments', '/messages', '/links'].forEach((path) => {
    getFormTokenInfo(path).catch(() => {});
  });
}
