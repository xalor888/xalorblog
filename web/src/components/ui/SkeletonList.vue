<template>
  <!-- 骨架屏的两个需求是**分开的**，它们不能挂在同一个元素上：
         1. 那些灰色块对读屏毫无意义 → 视觉层 aria-hidden；
         2. 但「页面正在加载」这件事必须播报 → 一条 sr-only 的 role="status"。
       原来只有 aria-hidden="true"（还是调用方传进来的），结果是：视障用户看到一片空白，
       既没有内容也没有"正在加载"，只能反复刷新或以为页面坏了。 -->
  <div class="skeleton-list">
    <span class="sr-only" role="status" aria-live="polite">内容加载中，请稍候</span>
    <div class="sk-grid" aria-hidden="true">
      <div v-for="i in count" :key="i" class="sk-item">
        <div class="skeleton sk-cover" v-if="cover"></div>
        <div class="sk-body">
          <div class="skeleton sk-line" :style="{ width: '85%' }"></div>
          <div class="skeleton sk-line" :style="{ width: '60%' }"></div>
          <div class="skeleton sk-line short" :style="{ width: '40%' }"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  count: { type: Number, default: 4 },
  cover: { type: Boolean, default: true },
});
</script>

<style scoped>
/* 网格挂在内层：外层要容纳 sr-only 文本，不能是 grid（否则那行字会占一列） */
.skeleton-list {
  display: block;
}

.sk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.sk-item {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow-1);
}

.sk-cover {
  height: 160px;
  border-radius: 0;
}

.sk-body {
  padding: 18px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sk-line {
  height: 14px;
}

.sk-line.short {
  height: 12px;
  margin-top: 2px;
}

@media (max-width: 700px) {
  .skeleton-list {
    grid-template-columns: 1fr;
  }
}
</style>
