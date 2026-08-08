<template>
  <div class="skeleton-list" aria-hidden="true">
    <div v-for="i in count" :key="i" class="sk-item">
      <div class="skeleton sk-cover" v-if="cover"></div>
      <div class="sk-body">
        <div class="skeleton sk-line" :style="{ width: '85%' }"></div>
        <div class="skeleton sk-line" :style="{ width: '60%' }"></div>
        <div class="skeleton sk-line short" :style="{ width: '40%' }"></div>
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
.skeleton-list {
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
