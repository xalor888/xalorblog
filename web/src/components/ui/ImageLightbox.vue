<template>
  <!-- 正文图片灯箱：点击放大查看，支持滚轮/双击/按钮缩放 -->
  <teleport to="body">
    <transition name="lightbox">
      <!-- role=dialog + aria-modal：灯箱打开时背景内容对读屏不可达。
           配合下方 onTabTrap 把键盘焦点也锁在图内 —— 只写 aria-modal
           而不管焦点，是「宣称模态却做不到」，比不写更误导。 -->
      <div
        v-if="visible"
        class="lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="alt ? `查看大图：${alt}` : '查看大图'"
        @click.self="close"
      >
        <button class="lb-close" @click="close" aria-label="关闭">
          <XIcon name="X" :size="20" />
        </button>

        <div
          ref="stageRef"
          class="lb-stage"
          :class="{ panning: dragging }"
          @wheel.prevent="onWheel"
          @dblclick="toggleZoom"
          @mousedown="onDragStart"
          @mousemove="onDragMove"
          @mouseup="onDragEnd"
          @mouseleave="onDragEnd"
          @touchstart="onTouchStart"
          @touchmove.prevent="onTouchMove"
          @touchend="onDragEnd"
        >
          <img
            :src="src"
            :alt="alt"
            class="lb-img"
            :style="imgStyle"
            :class="{ zoomed: zoom > 1 }"
            draggable="false"
          />
        </div>

        <div v-if="zoom > 1" class="lb-nav" @click.self="close">
          <button class="lb-ctrl" @click="zoomBy(-0.5)" title="缩小" aria-label="缩小"><XIcon name="ZoomOut" :size="18" /></button>
          <button class="lb-ctrl" @click="zoomBy(0.5)" title="放大" aria-label="放大"><XIcon name="ZoomIn" :size="18" /></button>
          <button class="lb-ctrl" @click="resetZoom" title="复位 100%" aria-label="复位缩放"><span class="lb-pct">{{ Math.round(zoom * 100) }}%</span></button>
        </div>

        <p v-if="alt" class="lb-caption">{{ alt }}</p>
        <div class="lb-hint">{{ zoom > 1 ? '拖拽平移 · 滚轮缩放 · 双击切换 · 点击空白处或按 ESC 关闭' : '滚轮缩放 · 双击切换 · 点击空白处或按 ESC 关闭' }}</div>
      </div>
    </transition>
  </teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { lockBodyScroll, unlockBodyScroll } from '@/utils/scrollLock';

const visible = ref(false);
const src = ref('');
const alt = ref('');
const zoom = ref(1);
const dragging = ref(false);
const stageRef = ref(null);
let dragStart = null;

const imgStyle = computed(() => ({
  transform: zoom.value > 1 ? `scale(${zoom.value})` : 'none',
}));

// 记住「是谁打开的灯箱」，关闭后把焦点还回去 —— 否则焦点落在 body，
// 键盘用户会从页面顶部重新 Tab 一遍。
let lastFocused = null;
// 打开灯箱的那张 <img> 本身不可聚焦，关闭时把焦点还给它的父级可聚焦容器
// （正文图片被包在可聚焦的 <a>/<figure> 里时就能自然恢复）。
let lastFocusedImg = null;

/**
 * @param {string} s 图片地址
 * @param {string} a 替代文本（读屏用）
 * @param {Element} [opener] 触发灯箱的元素。<img> 本身不可聚焦，关闭时
 *   要把焦点还给它 —— 所以要显式传进来，不能依赖 document.activeElement。
 */
function open(s, a, opener) {
  src.value = s;
  alt.value = a || '';
  zoom.value = 1;
  dragging.value = false;
  dragStart = null;
  // 只记录**真正可聚焦**的元素。点图片打开灯箱时 document.activeElement 是
  // body（<img> 默认不可聚焦），记下来等于「关闭后恢复到 body」——
  // 实测 Esc 后焦点确实落在 body，键盘用户得从页首重新 Tab。
  // body 不是有效返回点，记 null，关闭时退回「当前打开的那张图」。
  const active = document.activeElement;
  lastFocused = active && active !== document.body ? active : null;
  lastFocusedImg = opener || null;
  if (!visible.value) lockScroll();
  visible.value = true;
  // 聚焦关闭按钮：读屏会念出「关闭」，键盘用户立刻知道自己在弹层里
  nextTick(() => document.querySelector('.lightbox .lb-close')?.focus?.());
}

function close() {
  if (visible.value) unlockScroll();
  visible.value = false;
  dragging.value = false;
  dragStart = null;
  if (lastFocused && typeof lastFocused.focus === 'function') {
    lastFocused.focus();
  } else if (lastFocusedImg) {
    // 图片本身不可聚焦，要给它找一个「最近的」能接焦点的容器。
    //
    // ⚠ 不能直接写 closest('[tabindex]') —— 布局层的 <main> 带 tabindex="-1"
    // （skip-link 的落地目标），一路向上会匹配到它，实测焦点被送到 <main>，
    // 离用户刚才看的图很远。先试真正的可交互祖先，都没有才退化到图片本身。
    const holder =
      lastFocusedImg.closest('a[href], button, [role="button"]') || lastFocusedImg;
    if (holder && typeof holder.focus === 'function') {
      if (holder === lastFocusedImg && !holder.hasAttribute('tabindex')) {
        holder.setAttribute('tabindex', '-1');
      }
      holder.focus({ preventScroll: true });
    }
  }
  lastFocused = null;
  lastFocusedImg = null;
}

function lockScroll() {
  lockBodyScroll();
}

function unlockScroll() {
  unlockBodyScroll();
}

function zoomBy(delta) {
  zoom.value = Math.min(4, Math.max(1, +(zoom.value + delta).toFixed(2)));
  // 缩放后清空拖拽状态，避免位移残留
  dragging.value = false;
  dragStart = null;
}

function resetZoom() {
  zoom.value = 1;
  dragging.value = false;
  dragStart = null;
}

function toggleZoom() {
  zoom.value = zoom.value > 1 ? 1 : 2;
  dragging.value = false;
  dragStart = null;
}

function onWheel(e) {
  zoomBy(e.deltaY < 0 ? 0.25 : -0.25);
}

/** 放大状态下拖拽平移：通过滚动舞台查看图片溢出部分 */
function onDragStart(e) {
  if (zoom.value <= 1 || !stageRef.value) return;
  dragging.value = true;
  dragStart = { x: e.clientX, y: e.clientY, sl: stageRef.value.scrollLeft, st: stageRef.value.scrollTop };
}

function onDragMove(e) {
  if (!dragging.value || !dragStart || !stageRef.value) return;
  stageRef.value.scrollLeft = dragStart.sl - (e.clientX - dragStart.x);
  stageRef.value.scrollTop = dragStart.st - (e.clientY - dragStart.y);
}

function onDragEnd() {
  dragging.value = false;
  dragStart = null;
}

/** 触摸平移（移动端）+ 双指缩放（pinch） */
let pinchDist = 0;

function onTouchStart(e) {
  // 双指：记录初始间距进入捏合模式
  if (e.touches.length === 2) {
    dragging.value = false;
    dragStart = null;
    pinchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    return;
  }
  pinchDist = 0;
  const t = e.touches?.[0];
  if (!t) return;
  onDragStart({ clientX: t.clientX, clientY: t.clientY });
}

function onTouchMove(e) {
  // 双指捏合：按间距比例缩放（1x ~ 4x），并保持舞台滚动位置
  if (e.touches.length === 2 && pinchDist > 0) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const ratio = dist / pinchDist;
    if (ratio > 0.05 && Math.abs(ratio - 1) > 0.02) {
      zoom.value = Math.min(4, Math.max(1, +(zoom.value * ratio).toFixed(2)));
    }
    pinchDist = dist;
    return;
  }
  const t = e.touches?.[0];
  if (!t) return;
  onDragMove({ clientX: t.clientX, clientY: t.clientY });
}

function onKeydown(e) {
  if (e.key === 'Escape') close();
  if (!visible.value) return;
  if (e.key === '+' || e.key === '=') zoomBy(0.25);
  if (e.key === '-') zoomBy(-0.25);
  if (e.key === '0') resetZoom();
}

/**
 * 焦点陷阱：与搜索弹窗同一套做法。
 * 灯箱里可聚焦的东西很少（关闭 + 缩放按钮），但正因为少，
 * 一按 Tab 就会跑到背景页面上 —— 而背景已被 aria-modal 声明为不可达。
 * 原则：焦点不在灯箱内就无条件拉回，首尾元素上正常循环。
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function lightboxFocusables() {
  const root = document.querySelector('.lightbox');
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
}

function onTabTrap(e) {
  if (!visible.value || e.key !== 'Tab') return;
  const list = lightboxFocusables();
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (!active || !active.closest || !active.closest('.lightbox')) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
    return;
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('keydown', onTabTrap);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('keydown', onTabTrap);
  if (visible.value) unlockScroll();
});

defineExpose({ open });
</script>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-viewer);
  background: rgba(10, 9, 7, 0.8);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
}

.lb-close {
  position: absolute;
  top: 20px;
  right: 24px;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  /* 暗场景下的玻璃：靠亮边与内高光立起来 */
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s var(--ease);
  border: 1px solid rgba(255, 255, 255, 0.26);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.34), 0 10px 28px rgba(0, 0, 0, 0.42);
  z-index: 2;
}

.lb-close:hover {
  background: rgba(255, 255, 255, 0.25);
  transform: rotate(90deg);
}

/* 缩放舞台：图片居中，允许溢出滚动/拖拽查看局部 */
.lb-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 92vw;
  max-height: 80vh;
  overflow: auto;
  cursor: zoom-in;
  border-radius: 12px;
  touch-action: pan-x pan-y;
}

.lb-stage.panning {
  cursor: grabbing;
  user-select: none;
}

/* 放大后：拖拽平移 */
.lb-stage:has(.lb-img.zoomed) {
  cursor: grab;
}

.lb-stage:has(.lb-img.zoomed):active {
  cursor: grabbing;
}

.lb-img {
  max-width: min(90vw, 1100px);
  max-height: 80vh;
  object-fit: contain;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  transition: transform 0.18s var(--ease-out);
  transform-origin: center center;
  user-select: none;
  -webkit-user-drag: none;
}

.lb-img.zoomed {
  max-width: none;
  max-height: none;
}

/* 缩放控制条 */
.lb-nav {
  position: absolute;
  bottom: 64px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.26);
  border-radius: 999px;
  padding: 6px;
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.34), 0 10px 28px rgba(0, 0, 0, 0.42);
}

.lb-ctrl {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s var(--ease);
}

.lb-ctrl:hover {
  background: rgba(255, 255, 255, 0.18);
}

.lb-pct {
  font-size: 0.78rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.lb-caption {
  margin-top: 16px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 0.95rem;
  max-width: 80vw;
  text-align: center;
}

.lb-hint {
  position: absolute;
  bottom: 24px;
  color: rgba(255, 255, 255, 0.4);
  font-size: 0.8rem;
}

.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity 0.25s var(--ease);
}

.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}

.lightbox-enter-active .lb-img {
  animation: lbZoom 0.3s var(--ease-out);
}

@keyframes lbZoom {
  from { transform: scale(0.94); }
  to { transform: scale(1); }
}
</style>
