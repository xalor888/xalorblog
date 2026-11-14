/**
 * 液态玻璃 · 折射（SVG feDisplacementMap）
 * ------------------------------------------------------------
 * 亮环只让「边」有方向；模糊只把像素平均。这两件事都不叫折射。
 * 真玻璃会**弯折**背后的内容，而且边缘那一圈会稍微「分开」颜色（色散）——
 * 这就是 Apple 那张图里玻璃边看起来有厚度、有彩色细边的原因。
 *
 * 唯一能对着真实页面位移的通道是 `backdrop-filter: url(#filter)`：
 * 它的输入是元素背后**已经合成好的页面**，所以弯折是真的，不是贴图。
 *
 * ⚠ 只有 Chromium 渲染 `backdrop-filter: url(#f)`：
 *   Safari / Firefox 会**解析通过**然后什么都不画 —— `@supports` 在这里是假阳性，
 *   所以能不能挂由 `canRefract()`（引擎判定）说了算，CSS 侧只认 `data-lens` 属性。
 *
 * 滤镜链（一次构建，尺寸变了才重建）：
 *
 *   soft  = blur(SourceGraphic, 设计模糊) → saturate      ← 整块雾面
 *   rim   = blur(SourceGraphic, 浅模糊)   → saturate      ← 只有边缘那圈是清的
 *   map   = 现算的圆角矩形距离场位移图（R/G 位移，B 当环带权重）
 *   三个位移通道 dR / dG / dB（scale 依次 +6% / +12%）= 色散
 *   sum   = dR ⊕ dG ⊕ dB
 *   rim   = sum ∩ 环带权重
 *   out   = rim over soft
 *
 * 为什么要分两层：只把一张均匀模糊的底图位移出去，屏幕上是一片更脏的灰 ——
 * 位移看不见。清的那层只在边缘，弯折才看得见，中间仍是雾面（正文不会糊成水波）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SAT_MATRIX = 'saturate';

let host = null;
let seq = 0;
const built = new Map();

/**
 * 引擎判定：能不能真的渲染 `backdrop-filter: url(#f)`。
 * 没有任何运行时探针能区分「画了」和「没画」（backdrop-filter 的结果读不出来），
 * 剩下的事实只有引擎身份 —— 顺带排除 iOS 上的 Chrome/Edge/Firefox（UA 带 Chrome 但内核是 WebKit）。
 */
export function canRefract() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/CriOS|EdgiOS|FxiOS|OPT\/|OPiOS/.test(ua)) return false;
  return /Chrome\/|Chromium\/|Edg\//.test(ua);
}

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.createElementNS(SVG_NS, 'svg');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.setAttribute('focusable', 'false');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  document.body.appendChild(host);
  return host;
}

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 圆角矩形的有向距离场：内部为负、外部为正，|值| = 到边界的距离 */
function signedDistance(x, y, hw, hh, r) {
  const qx = Math.abs(x) - (hw - r);
  const qy = Math.abs(y) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * 位移图：R/G = 位移向量（128 为原点），B = 环带权重（0 = 中段，255 = 贴边）。
 * B 空着不用是故意的 —— feDisplacementMap 只读 R/G，B 正好留给「只在边缘生效」的遮罩。
 */
function buildMapUrl(w, h, radius, bevel, maxShift) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const mw = Math.max(8, Math.round(w * dpr));
  const mh = Math.max(8, Math.round(h * dpr));
  const canvas = document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(mw, mh);
  const data = img.data;

  const hw = w / 2;
  const hh = h / 2;
  const r = Math.max(0, Math.min(radius, hw, hh));
  for (let py = 0; py < mh; py++) {
    const y = py / dpr - hh;
    for (let px = 0; px < mw; px++) {
      const x = px / dpr - hw;
      const i = (py * mw + px) * 4;
      data[i + 3] = 255;
      const d = signedDistance(x, y, hw, hh, r);
      if (d >= 0) {
        data[i] = 128;
        data[i + 1] = 128;
        continue;
      }
      const inside = -d;
      if (inside >= bevel) {
        data[i] = 128;
        data[i + 1] = 128;
        continue;
      }
      // 越贴边越陡：透镜的曲率集中在最外圈
      const u = 1 - inside / bevel;
      const strength = u * u;
      const eps = 0.5;
      const gx = signedDistance(x + eps, y, hw, hh, r) - signedDistance(x - eps, y, hw, hh, r);
      const gy = signedDistance(x, y + eps, hw, hh, r) - signedDistance(x, y - eps, hw, hh, r);
      const len = Math.hypot(gx, gy) || 1;
      const nx = -gx / len;
      const ny = -gy / len;
      data[i] = 128 + Math.round(nx * strength * 127);
      data[i + 1] = 128 + Math.round(ny * strength * 127);
      data[i + 2] = Math.round(strength * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** 只保留一个颜色通道，alpha 置 1（给色散求和用） */
function channelMatrix(channel) {
  const rows = ['0 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0'];
  rows[channel] = channel === 0 ? '1 0 0 0 0' : channel === 1 ? '0 1 0 0 0' : '0 0 1 0 0';
  return `${rows.join('  ')}  0 0 0 0 1`;
}

/**
 * 建滤镜。参数变化（尺寸 / 圆角 / 模糊 / 色散）就整条重建 ——
 * 重建比「原地改属性」简单得多，而这些参数只在 resize 时变。
 */
function buildFilter({ id, width, height, radius, bevel, maxShift, blur, rimBlur, saturate, dispersion }) {
  const svg = ensureHost();
  const old = svg.querySelector(`#${id}`);
  if (old) old.remove();

  const filter = el('filter', {
    id,
    x: '0',
    y: '0',
    width: '100%',
    height: '100%',
    filterUnits: 'objectBoundingBox',
    primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  });

  const mapUrl = buildMapUrl(width, height, radius, bevel, maxShift);
  if (!mapUrl) return null;

  // ① 雾面主体
  const soft0 = el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: blur, result: 'soft0' });
  const soft = el('feColorMatrix', { in: 'soft0', type: SAT_MATRIX, values: saturate, result: 'soft' });
  // ② 清边（只在环带里露出）
  const rim0 = el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: rimBlur, result: 'rim0' });
  const rim = el('feColorMatrix', { in: 'rim0', type: SAT_MATRIX, values: saturate, result: 'rim' });
  // ③ 位移图 + 环带权重（B 通道 → alpha）
  const img = el('feImage', {
    href: mapUrl,
    result: 'map',
    preserveAspectRatio: 'none',
    x: '0',
    y: '0',
    width: '100%',
    height: '100%',
  });
  const mask = el('feColorMatrix', {
    in: 'map',
    type: 'matrix',
    // A_out = B_in：只留下环带那一圈
    values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0',
    result: 'rimMask',
  });

  // ④ 色散：R / G / B 各位移一次，scale 递增；dispersion=0 时三通道同 scale（等价单次位移）
  const base = maxShift * 2;
  const channels = [0, 1, 2].map((ch) => {
    const scale = base * (1 + dispersion * ch);
    const disp = el('feDisplacementMap', {
      in: 'rim',
      in2: 'map',
      scale: Number(scale.toFixed(2)),
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      result: `d${ch}`,
    });
    const keep = el('feColorMatrix', {
      in: `d${ch}`,
      type: 'matrix',
      values: channelMatrix(ch),
      result: `c${ch}`,
    });
    return [disp, keep];
  });

  filter.appendChild(soft0);
  filter.appendChild(soft);
  filter.appendChild(rim0);
  filter.appendChild(rim);
  filter.appendChild(img);
  filter.appendChild(mask);
  channels.forEach(([disp, keep]) => {
    filter.appendChild(disp);
    filter.appendChild(keep);
  });
  // 求和必须在输入之后就位（滤镜原语按声明顺序求值，引用后面的结果无效）
  filter.appendChild(el('feComposite', { in: 'c0', in2: 'c1', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: 'sum1' }));
  filter.appendChild(el('feComposite', { in: 'sum1', in2: 'c2', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: 'sum2' }));

  const cut = el('feComposite', {
    in: 'sum2',
    in2: 'rimMask',
    operator: 'in',
    result: 'rimFinal',
  });
  const over = el('feComposite', { in: 'rimFinal', in2: 'soft', operator: 'over' });

  filter.appendChild(cut);
  filter.appendChild(over);
  svg.appendChild(filter);
  return `url(#${id})`;
}

export function mountLens(options) {
  if (!canRefract()) return null;
  const { id, width, height, radius, bevel = 18, maxShift = 10, blur = 26, rimBlur = 4, saturate = 1.7, dispersion = 0.06 } = options;
  const key = `${Math.round(width)}x${Math.round(height)}r${Math.round(radius)}b${bevel}s${maxShift}f${blur}rf${rimBlur}t${saturate}d${dispersion}`;
  if (built.get(id) === key) return `url(#${id})`;
  const url = buildFilter({ id, width, height, radius, bevel, maxShift, blur, rimBlur, saturate, dispersion });
  if (url) built.set(id, key);
  return url;
}

export function unmountLens(id) {
  if (!id) return;
  built.delete(id);
  if (!host) return;
  const filter = host.querySelector(`#${id}`);
  if (filter) filter.remove();
  if (host.childElementCount === 0) {
    host.remove();
    host = null;
  }
}

export function nextLensId() {
  seq += 1;
  return `xalor-lens-${seq}`;
}
