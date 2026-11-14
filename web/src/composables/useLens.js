/**
 * 液态玻璃 · 折射的应用层
 * ------------------------------------------------------------
 * 把 `utils/lensFilter` 那套 SVG 位移滤镜挂到某个元素上，并在尺寸/圆角变化时重建。
 *
 * 什么时候不上：
 *   · 不是 Chromium（`canRefract()`），因为 `backdrop-filter: url(#f)` 在 WebKit/Gecko
 *     上解析通过但什么都不画，挂上去只会白白多一个滤镜节点；
 *   · 窄屏或触屏（< 900px / 没有精确指针）：位移是逐帧重采样背景，小屏上省电优先；
 *   · 用户开了「降低透明度」或「增强对比」：这两种偏好要的正是**更少的**视觉花活。
 * 三个条件都满足才挂，任一条变化立刻摘掉 —— 摘干净包括 DOM 属性和那个 <filter> 节点。
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { canRefract, mountLens, unmountLens, nextLensId } from '@/utils/lensFilter';

export function useLens(elRef, options = {}) {
  const bevel = options.bevel ?? 18;
  const maxShift = options.maxShift ?? 10;

  const desktop =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)')
      : null;
  const calm =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)')
      : null;

  let id = null;
  let raf = 0;
  let observer = null;
  let node = null;

  const detach = () => {
    if (node) {
      node.removeAttribute('data-lens');
      node.style.removeProperty('--lens-chain');
    }
    if (id) {
      unmountLens(id);
      id = null;
    }
  };

  const refresh = () => {
    const el = node;
    if (!el) return;
    if (!canRefract() || (desktop && !desktop.matches) || (calm && calm.matches)) {
      detach();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 24) return;

    // 先摘下属性再读，否则读到的是上一轮拼好的 `url(#…) blur(…)`，越拼越长
    el.removeAttribute('data-lens');
    const cs = getComputedStyle(el);
    const native = cs.backdropFilter || cs.webkitBackdropFilter || '';
    if (!native || native === 'none') {
      detach();
      return;
    }
    if (!id) id = nextLensId();
    const radius = parseFloat(cs.borderTopLeftRadius) || 12;
    // 把「磨砂」从 CSS 搬进滤镜：`backdrop-filter: url(#f) blur(26px)` 在 Chrome 里
    // 后面的 blur 会被吃掉（整条链只剩 url），玻璃直接变透亮。所以 blur 与 saturate
    // 从当前计算值里读出来，作为参数烘进 SVG 链，CSS 侧只留一个 url()。
    const blurPx = Number((native.match(/blur\(([\d.]+)px\)/) || [])[1] ?? 26);
    const satAmt = Number((native.match(/saturate\(([\d.]+)\)/) || [])[1] ?? 1.75);
    const url = mountLens({
      id,
      width: rect.width,
      height: rect.height,
      radius,
      bevel: Math.min(bevel, Math.floor(Math.min(rect.width, rect.height) / 3)),
      maxShift,
      // 滤镜里的模糊**故意比设计值浅**（14px 上限）：太糊的底图位移上去什么都看不见，
      // 结果是「花了钱没效果」。14px 仍足以让背景文字不可读，但边缘那圈被压过
      // 的曲线还在。饱和拉到设计值，观感依旧是一块磨砂玻璃。
      blur: Math.min(blurPx, 14),
      // 锐边那层：跟着设计模糊走（约 22%），但有上下限 —— 太清会像没糊的玻璃，
      // 太糊又回到「位移看不见」的老问题。
      rimBlur: Math.min(6, Math.max(2, blurPx * 0.22)),
      saturate: satAmt,
    });
    if (!url) {
      detach();
      return;
    }
    el.style.setProperty('--lens-chain', url);
    el.setAttribute('data-lens', '');
  };

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      refresh();
    });
  };

  onMounted(() => {
    node = elRef.value;
    if (!node) return;
    refresh();
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule);
      observer.observe(node);
    }
    desktop?.addEventListener?.('change', schedule);
    calm?.addEventListener?.('change', schedule);
  });

  onBeforeUnmount(() => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    desktop?.removeEventListener?.('change', schedule);
    calm?.removeEventListener?.('change', schedule);
    detach();
    node = null;
  });

  return { refresh };
}
