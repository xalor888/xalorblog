/**
 * 绕过 axios JSON 拦截器的签名 GET（后台导出 CSV/JSON）。
 * 读接口现在也要 X-Sig，裸 fetch 会被闸门拒绝。
 *
 * ⚠ 签名算法**只**来自 utils/requestSignature.js（与 api/index.js 共用一份）。
 * 本文件曾经抄了第二份逐行相同的 HMAC 实现，随后与 axios 侧分叉：
 * 没有超时、不解析业务码、不处理 401/403/429、票据刷新后不重试，
 * 未登录时还会发出 `"Bearer "`（空 token 的假认证头）。
 *
 * 返回 `Response` 的契约保持不变（调用方 AiPanel 依赖 `res.json()`，
 * AskAi 依赖 `res.body` 读 SSE 流），业务码与 401/403/429 的语义仍由
 * axios 侧的拦截器负责 —— 这里只补齐「传输层」的两件短板：
 *   1) 15s 超时（响应头到手即撤销，避免把 SSE 长流截断）
 *   2) 未登录时不发 Authorization 头（与 api/index.js 对齐）
 */

import { getTicket } from './pass';
import { getFingerprint } from './fingerprint';
import { getAuthToken } from './authSession';
import { buildRequestSignature } from './requestSignature';

/** 传输层超时：低于 axios 侧的 20s，导出/流式接口卡死时能尽快失败 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * 组合「超时」与「调用方传入的 signal」。
 *
 * 为什么要自建 AbortController 而不是直接用 `AbortSignal.timeout`：
 * 需要同时响应调用方的中止（AiPanel 的「停止生成」）与超时，而
 * `AbortSignal.any` 的兼容面还不够宽。
 *
 * `disarm()` 必须在**拿到响应头之后**立刻调用：超时只该管「多久没有响应头」，
 * 不该管正文传输 —— AiPanel 的 SSE 流活到 60s 以上，不撤定时器会把整段回答
 * 在 15s 处掐断。调用方之后主动 abort 仍然有效（监听器一直挂着）。
 */
function createRequestSignal(outer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new DOMException(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`, 'TimeoutError'));
  }, REQUEST_TIMEOUT_MS);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener('abort', () => ctrl.abort(outer.reason), { once: true });
  }
  return {
    signal: ctrl.signal,
    disarm() {
      clearTimeout(timer);
    },
  };
}

export async function signedFetch(url, { method = 'GET', body = null, headers = {}, signal = null } = {}) {
  const ticket = getTicket();
  // url 是完整路径（含 VITE_API_PREFIX），而服务端比对的是挂载点相对路径
  const { ts, sig, nonce } = await buildRequestSignature({
    ticket,
    method,
    url,
    data: body,
    stripApiPrefix: true,
  });
  const token = getAuthToken();
  const requestSignal = createRequestSignal(signal);
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        // 未登录不发假认证头：`Bearer ` 空 token 会被后端当成无效凭证
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Pass': ticket,
        'X-Fp': await getFingerprint(),
        'X-Timestamp': ts,
        'X-Nonce': nonce,
        'X-Sig': sig,
        ...(body !== null && body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === null || body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: requestSignal.signal,
    });
  } finally {
    requestSignal.disarm();
  }
  return res;
}
