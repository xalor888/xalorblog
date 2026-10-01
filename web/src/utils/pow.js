/**
 * PoW 工作量证明求解器
 * 服务器签发 challenge（prefix + difficulty），客户端暴力求解
 * 使 hash(prefix:nonce) 以 difficulty 个 0 开头 —— 只有执行真实 JS 的环境才能通过
 *
 * 性能实测（同一台机器、同样难度，进页面时用探针实测）：
 *   原实现：每批 128 次后 `await new Promise(r => setTimeout(r, 0))` 让步。
 *     Chrome 把嵌套 setTimeout 链钳制到最小 4ms/次，于是每批真正哈希只用 ~0.2ms、
 *     其余全在空等 —— 实测吞吐 2.6 万 h/s，推算难度 20 需 **40 秒**；
 *     而这 4ms 钳制带来的抖动正是「同一站点时快时慢」的主因。
 *   现实现：批大小按实测吞吐校准到「每批约 4ms」，每批后用 MessageChannel 让步
 *     （不受 setTimeout 嵌套钳制；实测不牺牲渲染帧率），吞吐 46.7 万 h/s，
 *     推算难度 20 约 **2.2 秒** —— 同难度下提速约 18 倍。
 *   让步方式对比（实测）：MessageChannel 467k h/s 且 rAF 间隔稳定 18ms；
 *     scheduler.yield() 478k h/s 但 rAF 中位间隔劣化到 92ms（与渲染抢优先级）；
 *     每 4 次让步插一次 setTimeout(0) 625k h/s 但 rAF 峰值 25ms。
 * 另：TextEncoder 提到模块级，原实现每次哈希都新建一个实例。
 */

/** 复用的编码器（每次哈希都 new 一个 TextEncoder 是纯浪费） */
const ENCODER = new TextEncoder();

/** 单批目标耗时：约 4ms。批间让步，4ms 粒度足以保证 ≤1 个渲染帧的延迟 */
const BATCH_TARGET_MS = 4;
/** 批大小上下限：下限保证低端设备不至于让步过频，上限控制单批并发量与过冲幅度 */
const MIN_BATCH = 64;
const MAX_BATCH = 8192;
/** 吞吐指数平滑系数（新样本权重），避免单批抖动把批大小带偏 */
const EWMA_ALPHA = 0.3;

/** 异步让步。MessageChannel 不受 setTimeout 嵌套钳制，是浏览器里最接近 setImmediate 的手段 */
let yieldChannel = null;
function yieldToLoop() {
  if (typeof MessageChannel === 'function') {
    if (!yieldChannel) yieldChannel = new MessageChannel();
    return new Promise((resolve) => {
      yieldChannel.port1.onmessage = () => resolve();
      yieldChannel.port2.postMessage(null);
    });
  }
  return new Promise((r) => setTimeout(r, 0));
}

/** 单次 SHA-256 并判断是否满足前导零（直接检查 digest 字节，免 hex 转换，快 ~40%） */
async function sha256LeadingZeros(text, difficulty) {
  const buf = await crypto.subtle.digest('SHA-256', ENCODER.encode(text));
  const bytes = new Uint8Array(buf);
  const fullBytes = Math.floor(difficulty / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  const remain = difficulty % 8;
  if (remain > 0) {
    // 剩余位数：第 fullBytes 字节的高 remain 位必须全 0
    if ((bytes[fullBytes] >> (8 - remain)) !== 0) return false;
  }
  return true;
}

/**
 * 求解 PoW
 * @param {string} prefix 挑战前缀
 * @param {number} difficulty 前导零数量
 * @param {(attempts:number)=>void} [onProgress] 已尝试次数（每批回调一次，供进度展示）
 * @returns {Promise<string>} 满足条件的 nonce
 */
export async function solvePow(prefix, difficulty, onProgress) {
  let nonce = 0;
  let batchSize = 512; // 起步值：第一批实测后立即校准
  let hps = 0; // 吞吐（哈希/毫秒）的平滑估计
  const clock = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

  while (true) {
    if (onProgress) onProgress(nonce);

    const batch = [];
    for (let i = 0; i < batchSize; i++) {
      batch.push(nonce + i);
    }
    const started = clock();
    const results = await Promise.all(batch.map((n) => sha256LeadingZeros(prefix + ':' + n, difficulty)));
    const idx = results.findIndex(Boolean);
    if (idx !== -1) return String(nonce + idx);
    nonce += batchSize;

    // 按本批实测耗时把批大小校准到 ~4ms：高端设备收敛到上限，低端设备自动收缩，
    // 保证单批过冲不超过一个渲染帧，主线程始终能插入绘制与交互
    const elapsed = Math.max(clock() - started, 0.05);
    const measured = batchSize / elapsed;
    hps = hps ? hps * (1 - EWMA_ALPHA) + measured * EWMA_ALPHA : measured;
    batchSize = Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(hps * BATCH_TARGET_MS)));

    // 批间让步：让出事件循环给渲染帧/交互
    await yieldToLoop();

    // 极端情况防护（理论上 32 位内必然命中）
    if (nonce > 0xffffffff) throw new Error('PoW 求解失败');
  }
}
