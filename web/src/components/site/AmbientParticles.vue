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

function tick(c) {
  const ctx = c.getContext('2d');
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  const dark = document.documentElement.dataset.theme === 'dark';
  ctx.fillStyle = dark ? '#ffffff' : '#ffffff';
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
  z-index: 2;
  pointer-events: none;
  opacity: 0.55;
}
</style>
