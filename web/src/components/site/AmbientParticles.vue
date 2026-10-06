<template>
  <canvas ref="canvasRef" class="ambient" aria-hidden="true"></canvas>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue';

const canvasRef = ref(null);
let raf = 0;
let particles = [];
let reduce = false;

function resize(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.floor(window.innerWidth * dpr);
  c.height = Math.floor(window.innerHeight * dpr);
  c.style.width = '100%';
  c.style.height = '100%';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function seed() {
  const n = window.innerWidth < 720 ? 36 : 72;
  particles = Array.from({ length: n }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: Math.random() * 1.8 + 0.4,
    s: Math.random() * 0.45 + 0.15,
    a: Math.random() * 0.45 + 0.12,
    drift: (Math.random() - 0.5) * 0.35,
  }));
}

// 粒子颜色不随主题瞬时翻转：每帧向目标色插值（约 400ms 收敛），
// 否则整层画布在主题切换的单帧内黑白反转，加剧"马赛克/闪动"观感
const FILL_LIGHT = [26, 24, 20]; // #1a1814
const FILL_DARK = [255, 255, 255];
let fillCur = FILL_LIGHT.slice();

function nextFillColor() {
  const target = document.documentElement.dataset.theme === 'dark' ? FILL_DARK : FILL_LIGHT;
  for (let i = 0; i < 3; i++) {
    fillCur[i] += (target[i] - fillCur[i]) * 0.12;
    if (Math.abs(target[i] - fillCur[i]) < 0.6) fillCur[i] = target[i];
  }
  return `rgb(${Math.round(fillCur[0])}, ${Math.round(fillCur[1])}, ${Math.round(fillCur[2])})`;
}

function tick(c) {
  const ctx = c.getContext('2d');
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = nextFillColor();
  for (const p of particles) {
    p.y += p.s;
    p.x += p.drift;
    if (p.y > h + 8) {
      p.y = -8;
      p.x = Math.random() * w;
    }
    if (p.x > w + 8) p.x = -8;
    if (p.x < -8) p.x = w + 8;
    ctx.globalAlpha = p.a;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  raf = requestAnimationFrame(() => tick(c));
}

function onResize() {
  const c = canvasRef.value;
  if (!c) return;
  resize(c);
  seed();
}

onMounted(() => {
  reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const c = canvasRef.value;
  if (!c || reduce) return;
  fillCur = (document.documentElement.dataset.theme === 'dark' ? FILL_DARK : FILL_LIGHT).slice();
  resize(c);
  seed();
  tick(c);
  window.addEventListener('resize', onResize, { passive: true });
});

onUnmounted(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('resize', onResize);
});
</script>

<style scoped>
.ambient {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.55;
}
</style>
