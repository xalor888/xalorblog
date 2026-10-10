/**
 * 主页首屏摘要的「免票」直连
 *
 * 为什么不走 @/api 的 axios 实例：那个实例的请求拦截器会 `await ensurePass()`，
 * 也就是每次请求前先确保 PoW 票据就绪 —— 首访要等秒级计算。而
 * /api/home/summary 是服务端唯一有意放行的免票读接口（GATE_SKIP），
 * 目的正是让主页壳（名片/关于/友链预览/最近文章）立刻可见。
 *
 * 因此这里用裸 fetch：不带票据、不带签名，也不等待 PoW。
 * 该接口仍受 WAF、IP 信誉闸门、antiBot（UA 特征）与独立限流保护。
 */
const BASE = import.meta.env.VITE_API_PREFIX || '/api';

/**
 * 请求超时：axios 实例有 20s 超时，裸 fetch 没有 —— 缺了它，遇到挂住的连接
 * （CDN 半开、中间代理吞包）时 Promise 永不 settle，主页会永远停在占位文案上，
 * 且因为没抛错而没有任何「重试」入口。这里给一个更短的独立超时，
 * 让失败态可达（失败态由 Home.vue 渲染重试入口）。
 */
const TIMEOUT_MS = 8000;

export async function fetchHomeSummary({ signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(`${BASE}/home/summary`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || json.code !== 0) throw new Error((json && json.message) || '请求失败');
    return json.data;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
