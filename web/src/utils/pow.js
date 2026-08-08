/**
 * PoW 工作量证明求解器
 * 服务器签发 challenge（prefix + difficulty），客户端暴力求解
 * 使 hash(prefix:nonce) 以 difficulty 个 0 开头 —— 只有执行真实 JS 的环境才能通过
 * 自适应批次：按实时吞吐调整并发批次（32~512），低端设备/移动浏览器
 * 自动缩小批次，避免 WebCrypto 并发打满导致页面卡死
 */

/** 单次 SHA-256 并判断是否满足前导零（直接检查 digest 字节，免 hex 转换，快 ~40%） */
async function sha256LeadingZeros(text, difficulty) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
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
 * @returns {Promise<string>} 满足条件的 nonce
 */
export async function solvePow(prefix, difficulty) {
  let nonce = 0;
  let batchSize = 128; // 初始批次；每 2 秒按吞吐自适应
  let windowStart = Date.now();
  let windowHashes = 0;

  while (true) {
    const batch = [];
    for (let i = 0; i < batchSize; i++) {
      batch.push(nonce + i);
    }
    const results = await Promise.all(batch.map((n) => sha256LeadingZeros(prefix + ':' + n, difficulty)));
    const idx = results.findIndex(Boolean);
    if (idx !== -1) return String(nonce + idx);
    nonce += batchSize;
    windowHashes += batchSize;

    // 批间让步：让出事件循环给渲染帧/交互（低端设备批量大时防止页面无响应）
    await new Promise((r) => setTimeout(r, 0));

    // 自适应批次：目标每批约 50ms（高端设备收敛到 512 上限，低端自动下调）
    const now = Date.now();
    if (now - windowStart >= 2000) {
      const hashesPerSec = windowHashes / ((now - windowStart) / 1000);
      batchSize = Math.max(32, Math.min(512, Math.round(hashesPerSec * 0.05)));
      windowStart = now;
      windowHashes = 0;
    }
    // 极端情况防护（理论上 32 位内必然命中）
    if (nonce > 0xffffffff) throw new Error('PoW 求解失败');
  }
}
