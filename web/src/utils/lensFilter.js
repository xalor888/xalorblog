/**
 * 液态玻璃 · 折射（SVG feDisplacementMap）
 * ------------------------------------------------------------
 * 前面那版只有「亮环 + 模糊」——边有方向了，但底下的像素**没有被弯折**。
 * 真玻璃会弯折背景：边缘一圈像透镜一样把后面的图像压进去。这件事 blur 做不到，
 * blur 只会把像素平均掉；要位移就得用 `feDisplacementMap`。
 *
 * 唯一能「对着真实页面」位移的通道是 `backdrop-filter: url(#filter)`：
 * 它的输入是元素背后**已经合成好的页面**，所以滤镜里看到的弯折是真的。
 *
 * ⚠ 这条路只有 Chromium 走得了：
 *   · Safari / Firefox 会**解析通过** `backdrop-filter: url(#f)` 然后什么都不画
 *     （不是降级，是完全没有）—— 所以 `@supports` 在这里是假阳性，**只能用引擎判定**；
 *   · 判据放在 `canRefract()` 里，理由写在那儿。
 *
 * 位移图不是预生成贴图，也不是 html2canvas 快照（那两种都跟背景无关 / 会过期），
 * 而是**按元素当前的尺寸和圆角现算一张高度图**：圆角矩形有向距离场 → 边缘 18px 环带
 * 内给出指向内侧的位移向量。规则：
 *   · 中段位移为 0（中间保持普通模糊，正文压在下面也不会糊成水波）；
 *   · 越贴边越强（`u^2` 曲线，边缘最陡）；
 *   · 只在尺寸/圆角/DPR 变化时重建，滚动时不重算。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 单例 <svg>：所有折射滤镜挂在这一个节点下，挂在 body 上，`display:none` 不影响滤镜生效 */
let host = null;
let seq = 0;

/** 已建过的滤镜：id → 生成时的几何参数，用来跳过无意义的重建 */
const built = new Map();

/**
 * 引擎判定：能不能真的渲染 `backdrop-filter: url(#f)`。
 *
 * 为什么不用 @supports —— 上面写的那个假阳性。为什么不用「量像素」——
 *
 * backdrop-filter 的结果读不出来（getDisplayMedia 要权限、html2canvas 拍不到滤镜），
 * 所以没有任何运行时探针能区分「画了」和「没画」。剩下的唯一事实是引擎身份：
 * Chromium 家族能画，WebKit 与 Gecko 不能。
 *
 * 这里把 iOS 上的 Chrome/Edge/Firefox 都排除掉（CriOS / EdgiOS / FxiOS）——
 * 它们的 UA 里带 Chrome 字样，但内核是 WebKit，一样画不出来。
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

/** 圆角矩形的有向距离场：内部为负、外部为正，|值| = 到边界的距离 */
function signedDistance(x, y, hw, hh, r) {
  const qx = Math.abs(x) - (hw - r);
  const qy = Math.abs(y) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * 生成位移图（dataURL）。
 * 编码约定（feDisplacementMap 的约定）：R/G 通道 128 = 不位移，
 * 差多少就位移多少，`scale` 会把 (通道值/255 - 0.5) 再放大一倍 —— 所以
 * 这里按 maxShift 归一化，滤镜那边用 `scale = 2 * maxShift` 就能得到像素级位移。
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
  // 位移图按 CSS 像素算，写进设备像素网格时乘 dpr
  for (let py = 0; py < mh; py++) {
    const y = py / dpr - hh;
    for (let px = 0; px < mw; px++) {
      const x = px / dpr - hw;
      const i = (py * mw + px) * 4;
      data[i + 3] = 255;
      const d = signedDistance(x, y, hw, hh, r);
      if (d >= 0) { data[i] = 128; data[i + 1] = 128; continue; } // 形状外：不位移
      const inside = -d;                                           // 到边界的内向距离
      if (inside >= bevel) { data[i] = 128; data[i + 1] = 128; continue; }
      // 边缘最陡 → 中段归零；指数 2 让过渡更像透镜而不是斜坡
      const u = 1 - inside / bevel;
      const strength = u * u;
      // 内向法线 = -∇sdf（数值差分，步长半个设备像素就够）
      const eps = 0.5;
      const gx = signedDistance(x + eps, y, hw, hh, r) - signedDistance(x - eps, y, hw, hh, r);
      const gy = signedDistance(x, y + eps, hw, hh, r) - signedDistance(x, y - eps, hw, hh, r);
      const len = Math.hypot(gx, gy) || 1;
      const nx = -gx / len;
      const ny = -gy / len;
      const shift = strength * maxShift;
      data[i] = 128 + Math.round((nx * shift) / maxShift * 127);
      data[i + 1] = 128 + Math.round((ny * shift) / maxShift * 127);
      // B 不做位移（feDisplacementMap 只读 R/G），借它当「环带权重」：
      // 滤镜里用 feColorMatrix 把 B 提成 alpha，就得到一条只在边缘生效的遮罩。
      // 有它才能做到「中间是雾、边缘是透镜」—— 只靠一张均匀模糊的底图，位移出来
      // 只是一片更脏的灰，看不出弯折（这正是第一版的毛病）。
      data[i + 2] = Math.round(strength * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * 为一个元素装折射滤镜。返回 `url(#id)`，调用方把它拼进 backdrop-filter。
 * 同尺寸重复调用会命中缓存，不重建位移图（resize 抖动时不至于每帧算一遍）。
 */
export function mountLens({ id, width, height, radius, bevel = 18, maxShift = 10, blur = 26, rimBlur = 3.5, saturate = 1.75 }) {
  if (!canRefract()) return null;
  const key = `${Math.round(width)}x${Math.round(height)}r${Math.round(radius)}b${bevel}f${blur}rf${rimBlur}s${saturate}`;
  const prev = built.get(id);
  if (prev && prev.key === key) return `url(#${id})`;

  const svg = ensureHost();
  let filter = svg.querySelector(`#${id}`);
  if (!filter) {
    filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', '100%');
    filter.setAttribute('height', '100%');
    filter.setAttribute('filterUnits', 'objectBoundingBox');
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    /* 滤镜链的顺序就是「材质」的顺序：
       ① feGaussianBlur —— 磨砂；
       ② feColorMatrix saturate —— 把模糊平均掉的饱和度补回来；
       ③ feDisplacementMap —— 对**已经糊好**的那层做边缘位移。
       为什么模糊必须烘进来而不是留在 CSS 里：实测 `backdrop-filter: url(#f) blur(26px)`
       在 Chrome 里后面的 blur 会被吃掉（整条链只剩 url），玻璃会变得透亮、
       背景文字重新可读 —— 那不是折射，是穿帮。所以模糊进 SVG，CSS 只给一个 url()。 */
    /* 材质分两层，最后叠起来：
       ① soft —— 整块雾面（stdDeviation = 设计模糊值）；
       ② rim  —— 只有边缘那圈，模糊**刻意浅**（rimBlur），位移作用在它上面，
          所以弯折看得见；中间那片仍然是雾，正文压过去不会糊成水波。
       把两层合成用的权重来自位移图的 B 通道（见 buildMapUrl 里那段注释）。 */
    const softBlur = document.createElementNS(SVG_NS, 'feGaussianBlur');
    softBlur.setAttribute('in', 'SourceGraphic');
    softBlur.setAttribute('result', 'soft0');

    const softSat = document.createElementNS(SVG_NS, 'feColorMatrix');
    softSat.setAttribute('in', 'soft0');
    softSat.setAttribute('type', 'saturate');
    softSat.setAttribute('result', 'soft');

    const rimBlur = document.createElementNS(SVG_NS, 'feGaussianBlur');
    rimBlur.setAttribute('in', 'SourceGraphic');
    rimBlur.setAttribute('result', 'rim0');

    const rimSat = document.createElementNS(SVG_NS, 'feColorMatrix');
    rimSat.setAttribute('in', 'rim0');
    rimSat.setAttribute('type', 'saturate');
    rimSat.setAttribute('result', 'rim');

    /* B 通道 → alpha：只在环带上保留锐边层 */
    const rimMask = document.createElementNS(SVG_NS, 'feColorMatrix');
    rimMask.setAttribute('in', 'map');
    rimMask.setAttribute('type', 'matrix');
    rimMask.setAttribute('values', '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0');
    rimMask.setAttribute('result', 'rimMask');

    const imgEl = document.createElementNS(SVG_NS, 'feImage');
    imgEl.setAttribute('result', 'map');
    // 拉伸铺满滤镜区域：位移图不必与元素尺寸逐像素对齐，尺寸变了也不会留空隙
    imgEl.setAttribute('preserveAspectRatio', 'none');
    imgEl.setAttribute('x', '0');
    imgEl.setAttribute('y', '0');
    imgEl.setAttribute('width', '100%');
    imgEl.setAttribute('height', '100%');

    const disp = document.createElementNS(SVG_NS, 'feDisplacementMap');
    disp.setAttribute('in', 'rim');
    disp.setAttribute('in2', 'map');
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'G');
    disp.setAttribute('result', 'rimDisp');

    const cut = document.createElementNS(SVG_NS, 'feComposite');
    cut.setAttribute('in', 'rimDisp');
    cut.setAttribute('in2', 'rimMask');
    cut.setAttribute('operator', 'in');
    cut.setAttribute('result', 'rimFinal');

    const over = document.createElementNS(SVG_NS, 'feComposite');
    over.setAttribute('in', 'rimFinal');
    over.setAttribute('in2', 'soft');
    over.setAttribute('operator', 'over');

    filter.appendChild(softBlur);
    filter.appendChild(softSat);
    filter.appendChild(imgEl);
    filter.appendChild(rimMask);
    filter.appendChild(rimBlur);
    filter.appendChild(rimSat);
    filter.appendChild(disp);
    filter.appendChild(cut);
    filter.appendChild(over);
    svg.appendChild(filter);
  }

  const url = buildMapUrl(width, height, radius, bevel, maxShift);
  if (!url) return null;
  const imgEl = filter.querySelector('feImage');
  imgEl.setAttribute('href', url);
  const blurs = filter.querySelectorAll('feGaussianBlur');
  blurs[0].setAttribute('stdDeviation', String(blur));
  blurs[1].setAttribute('stdDeviation', String(rimBlur));
  const sats = filter.querySelectorAll('feColorMatrix[type="saturate"]');
  sats[0].setAttribute('values', String(saturate));
  sats[1].setAttribute('values', String(saturate));
  // 单位是 userSpaceOnUse（CSS px）；scale 取 2×maxShift，与上面的编码约定对应
  filter.querySelector('feDisplacementMap').setAttribute('scale', String(maxShift * 2));
  filter.setAttribute('data-geometry', key);
  built.set(id, { key });
  return `url(#${id})`;
}

/** 卸载滤镜：连带把没用的 <svg> 宿主一起收掉，避免挂钩子留在 body 上 */
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

/** 供调试/演示用：给一个没被占用过的 id */
export function nextLensId() {
  seq += 1;
  return `xalor-lens-${seq}`;
}
