<template>
  <!-- 路由切换顶部进度条。文章页已有自己的阅读进度条（两条平行细线看着像重复），这里让位 -->
  <div v-show="!onArticle" class="route-progress" :class="{ visible: visible }" aria-hidden="true">
    <div class="rp-bar"></div>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

const router = useRouter();
const route = useRoute();
// 文章详情页顶部是阅读进度条，路由进度条不叠加
const onArticle = computed(() => /^\/article\//.test(route.path || ''));
const visible = ref(false);
let doneTimer = null;

/**
 * 三个路由钩子的**注销函数必须留着**。
 *
 * 原来这里直接 `router.beforeEach(fn)` 而丢弃返回值，onUnmounted 里只清 timer。
 * 后果：这个组件每挂载一次就多注册一套全局钩子，且永不注销 —— 反复进出
 * （比如把 Layout 拆了新实例、HMR 多次热更）之后，一次导航会触发 N 次
 * `visible.value = true` 和 N 个 350ms 定时器。现象是进度条卡住不收尾，
 * 或者切换瞬间闪几下。dev 下 HMR 最容易复现，所以以前一直没被当回事。
 *
 * 另外原来的 `let timer` 从未被赋过值（只在 clearTimeout 里出现），是死变量；
 * 真正控制收尾的只有 doneTimer。
 */
const offBefore = router.beforeEach(() => {
  visible.value = true;
  clearTimeout(doneTimer);
});

const offAfter = router.afterEach(() => {
  // 最小展示时长，避免闪烁
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => {
    visible.value = false;
  }, 350);
});

const offError = router.onError(() => {
  clearTimeout(doneTimer);
  visible.value = false;
});

onUnmounted(() => {
  // 先注销钩子再清定时器：顺序反了会在注销前的最后一个回调里再种一个定时器
  offBefore();
  offAfter();
  offError();
  clearTimeout(doneTimer);
});
</script>

<style scoped>
.route-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  /* 必须裁剪。
     .rp-bar 用 translateX(-100% → 400%) 做持续滑动，
     没有裁剪时它会真的跑到容器外 ——
     实测 375px 视口下条形右边缘在 421px，**溢出 46px**，
     那 3px 高的渐变光晕会贴在屏幕右侧外面。
     桌面端因为宽度大不容易察觉，窄屏上一眼就能看到。 */
  overflow: hidden;
  z-index: var(--z-toast);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s var(--ease);
  /* 不可见时把动画停掉。
     实测：这个条在**页面空闲时也一直有 animation 在 running 状态**
     （document.getAnimations() 里能抓到 rpSlide），
     而它此刻 opacity:0 —— 一帧都看不见，却仍在参与合成。
     visibility:hidden + 暂停，让浏览器真正把它从动画时间线上摘下来。 */
  visibility: hidden;
}

.route-progress:not(.visible) .rp-bar {
  animation-play-state: paused;
}

.route-progress.visible {
  visibility: visible;
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
