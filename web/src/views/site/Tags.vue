<template>
  <div class="tags-page">
    <div class="container narrow">
      <div class="page-head fade-up">
        <p class="eyebrow">TAGS</p>
        <h1>标签云</h1>
        <p class="lead">共 {{ tags.length }} 个标签</p>
      </div>

      <div class="cloud" v-reveal>
        <router-link
          v-for="tag in tags"
          :key="tag.id"
          :to="{ path: '/articles', query: { tag: tag.slug } }"
          class="cloud-item"
          :class="'weight-' + weightClass(tag.article_count)"
        >
          # {{ tag.name }}
          <span class="cloud-count">{{ tag.article_count }}</span>
        </router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watchEffect } from 'vue';
import { tagApi } from '@/api';

// 浏览器标签页标题
watchEffect(() => {
  document.title = '标签云';
});

const tags = ref([]);

// 按文章数分为 4 档字重，形成自然的云形
function weightClass(count) {
  const max = Math.max(...tags.value.map((t) => t.article_count), 1);
  const ratio = count / max;
  if (ratio >= 0.75) return 'xl';
  if (ratio >= 0.45) return 'lg';
  if (ratio >= 0.2) return 'md';
  return 'sm';
}

onMounted(async () => {
  try {
    tags.value = await tagApi.list();
  } catch (e) { /* 拦截器已提示 */ }
});
</script>

<style scoped>
.tags-page {
  padding-bottom: 60px;
}

.narrow {
  max-width: 720px;
}

.page-head .eyebrow {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--accent);
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* 标签云：字号分级 + 细描边 */
.cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 12px;
  justify-content: center;
  padding: 40px 0;
}

.cloud-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  background: var(--card);
  line-height: 1.4;
  transition: all var(--dur) var(--ease);
}

.cloud-item:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-2px);
}

.cloud-count {
  font-size: 0.7em;
  color: var(--text-3);
}

.weight-sm {
  font-size: 0.85rem;
}

.weight-md {
  font-size: 1rem;
  font-weight: 550;
}

.weight-lg {
  font-size: 1.2rem;
  font-weight: 650;
}

.weight-xl {
  font-size: 1.45rem;
  font-weight: 750;
  color: var(--text);
}
</style>
