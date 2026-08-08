<template>
  <!-- 路由切换顶部进度条 -->
  <div class="route-progress" :class="{ visible: visible }" aria-hidden="true">
    <div class="rp-bar"></div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const visible = ref(false);
let timer = null;
let doneTimer = null;

// 路由切换时短暂显示进度条（页面组件懒加载的真实耗时感知）
router.beforeEach(() => {
  visible.value = true;
  clearTimeout(timer);
  clearTimeout(doneTimer);
});

router.afterEach(() => {
  // 最小展示时长，避免闪烁
  doneTimer = setTimeout(() => {
    visible.value = false;
  }, 350);
});

router.onError(() => {
  visible.value = false;
});
</script>

<style scoped>
.route-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 999;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s var(--ease);
}

.route-progress.visible {
  opacity: 1;
}

.rp-bar {
  height: 100%;
  width: 30%;
  border-radius: 0 3px 3px 0;
  background: linear-gradient(90deg, var(--accent), #c9900f, var(--accent));
  background-size: 200% 100%;
  animation: rpSlide 1.1s ease-in-out infinite;
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 50%, transparent);
}

@keyframes rpSlide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
</style>
