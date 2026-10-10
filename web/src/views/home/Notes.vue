<template>
  <div class="notes-page">
    <div class="home-container">
      <header class="page-head">
        <span class="page-badge"><XIcon name="Feather" :size="12" /> NOTES</span>
        <h1>手记</h1>
        <p class="page-sub">把日常、想法与正在发生的事留在时间线上。</p>
      </header>

      <div v-if="loading && !list.length" class="skeleton-list">
        <div v-for="i in 4" :key="i" class="skeleton"></div>
      </div>

      <div v-else-if="list.length" class="note-list">
        <NoteCard
          v-for="n in list"
          :key="n.id"
          :note="n"
          :avatar="avatar"
          :author-name="authorName"
          :like-action="onLike"
        />
      </div>

      <p v-else class="empty">{{ failed ? '加载失败，请刷新页面重试' : '还没有手记。' }}</p>

      <div v-if="hasMore" class="more-wrap">
        <button class="more-btn" :disabled="loading" @click="loadMore">
          <XIcon name="RefreshCw" :size="15" :class="{ spin: loading }" />
          {{ loading ? '加载中…' : '加载更多' }}
        </button>
      </div>
      <p v-else-if="list.length" class="end">没有更多了</p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import NoteCard from '@/components/home/NoteCard.vue';
import { noteApi } from '@/api';
import { useHomeStore } from '@/stores/home';

const home = useHomeStore();
const list = ref([]);
const page = ref(1);
const pageSize = 10;
const hasMore = ref(false);
const loading = ref(false);
const failed = ref(false);

const avatar = computed(() => home.summary?.avatar || '/logo-256.webp');
const authorName = computed(() => home.summary?.site_name || 'Xalor');

async function fetchPage(p) {
  loading.value = true;
  failed.value = false;
  try {
    const data = await noteApi.list({ page: p, pageSize });
    const rows = data?.list || [];
    list.value = p === 1 ? rows : [...list.value, ...rows];
    page.value = p;
    hasMore.value = !!(data?.pagination?.has_more ?? rows.length === pageSize);
  } catch (e) {
    // 追加页失败时保留已有内容，只提示失败（不要清空用户已经看到的时间线）
    failed.value = p === 1;
    if (p === 1) list.value = [];
  } finally {
    loading.value = false;
  }
}

function loadMore() {
  if (loading.value || !hasMore.value) return;
  // 只在成功后才推进页码：失败时若已推进，下一次点击会直接跳过一整页
  fetchPage(page.value + 1);
}

/** 交给 NoteCard 调用：抛出异常即表示失败，卡片据此不标记「已赞」 */
async function onLike(note) {
  const data = await noteApi.like(note.id);
  note.likes = data?.likes ?? note.likes;
}

onMounted(() => {
  home.load();
  fetchPage(1);
});
</script>

<style scoped>
.notes-page { width: 100%; }
.page-head { text-align: center; margin-bottom: 24px; }
.page-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-deep);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
}
.page-head h1 {
  margin: 10px 0 6px;
  font-size: clamp(1.5rem, 3.6vw, 2rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.page-sub {
  margin: 0;
  font-size: 13.5px;
  color: var(--text-3);
}
.note-list { display: grid; gap: 14px; }
.skeleton-list { display: grid; gap: 14px; }
.skeleton {
  height: 132px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: linear-gradient(90deg, var(--bg-soft) 25%, var(--card) 50%, var(--bg-soft) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
.empty {
  padding: 40px 20px;
  text-align: center;
  font-size: 13.5px;
  color: var(--text-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}
.more-wrap { display: flex; justify-content: center; margin-top: 22px; }
.more-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 20px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 13.5px;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.more-btn:hover:not(:disabled) { color: var(--accent-deep); border-color: var(--accent); }
.more-btn:disabled { cursor: default; opacity: 0.7; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.end {
  text-align: center;
  margin: 22px 0 0;
  font-size: 12.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
@media (prefers-reduced-motion: reduce) {
  .skeleton, .spin { animation: none; }
}
</style>
