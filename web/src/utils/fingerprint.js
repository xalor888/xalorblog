/**
 * 设备指纹采集（Canvas + WebGL + 硬件信息 + 环境特征）
 * 服务端票据与指纹强绑定，指纹不一致的请求直接拒绝
 */

let cached = null;
let pending = null;

/** 取 Canvas 指纹（同一浏览器渲染一致，headless/模拟器有明显差异） */
function canvasFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 240, 60);
    ctx.fillStyle = '#069';
    ctx.fillText('Xalor-Blog-Fingerprint-7f3a', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('xalor.site secure', 4, 40);
    return canvas.toDataURL().slice(0, 4000);
  } catch (e) {
    return 'canvas:unavailable';
  }
}

/** 取 WebGL 渲染器信息（GPU 型号是强指纹） */
function webglFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'webgl:unavailable';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    const vendor = ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return `${vendor}|${renderer}`;
  } catch (e) {
    return 'webgl:error';
  }
}

/** 汇总原始指纹特征 */
function collectRaw() {
  const nav = navigator;
  const dpr = window.devicePixelRatio || 1;
  return [
    nav.userAgent,
    nav.language || '',
    (nav.languages || []).join(','),
    nav.platform || '',
    nav.hardwareConcurrency || 0,
    screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
    dpr,
    new Date().getTimezoneOffset(),
    canvasFingerprint(),
    webglFingerprint(),
    !!window.chrome,
    nav.maxTouchPoints || 0,
  ].join('|||');
}

/** SHA-256 哈希 */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 获取设备指纹（缓存于内存 + localStorage，页面间保持一致）
 * @returns {Promise<string>} 64 位十六进制
 */
export async function getFingerprint() {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    const stored = localStorage.getItem('xalor_fp_v2');
    if (stored && stored.length === 64) {
      cached = stored;
      return stored;
    }
    const fp = await sha256(collectRaw());
    try {
      localStorage.setItem('xalor_fp_v2', fp);
    } catch (e) { /* 隐私模式忽略 */ }
    cached = fp;
    return fp;
  })().finally(() => {
    pending = null;
  });
  return pending;
}
