<template>
  <!-- 正文图片灯箱：点击放大查看，支持滚轮/双击/按钮缩放 -->
  <teleport to="body">
    <transition name="lightbox">
      <div v-if="visible" class="lightbox" @click.self="close">
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
import { ref, computed, onMounted, onUnmounted } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';

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

function open(s, a) {
  src.value = s;
  alt.value = a || '';
  zoom.value = 1;
  dragging.value = false;
  dragStart = null;
  visible.value = true;
  lockScroll();
}

function close() {
  visible.value = false;
  dragging.value = false;
  dragStart = null;
  unlockScroll();
}

/** 背景滚动锁定：弹窗打开时禁止页面滚动，关闭恢复 */
function lockScroll() {
  document.body.style.overflow = 'hidden';
}

function unlockScroll() {
  document.body.style.overflow = '';
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

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  unlockScroll(); // 兜底：组件卸载时确保解锁
});

defineExpose({ open });
</script>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: rgba(12, 10, 8, 0.88);
  backdrop-filter: blur(6px);
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
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s var(--ease);
  border: 1px solid rgba(255, 255, 255, 0.2);
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
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  padding: 6px;
  backdrop-filter: blur(8px);
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
