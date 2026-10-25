<template>
  <div class="bookmarks-page">
    <div class="container">
      <div class="page-head fade-up">
        <p class="eyebrow">HISTORY</p>
        <h1>阅读足迹</h1>
        <p class="lead">
          本机最近读过 {{ history.length }} 篇文章<template v-if="history.length">，只存在这台设备上，不上传</template>
        </p>
        <button v-if="history.length" class="bm-clear" :aria-label="'清空全部阅读足迹（共 ' + history.length + ' 条）'" @click="clearAll">
          <XIcon name="Trash2" :size="13" /> 清空足迹
        </button>
      </div>

      <div v-if="history.length" class="bm-grid" v-reveal="'stagger'">
        <div v-for="b in history" :key="b.slug" class="bm-item">
          <ArticleCard :article="toArticle(b)" />
          <button class="bm-remove" :title="'从足迹移除 ' + b.title" @click="remove(b.slug)">
            <XIcon name="Trash2" :size="14" />
          </button>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="icon-wrap"><XIcon name="History" :size="30" /></div>
        <p>还没有阅读记录</p>
        <router-link to="/articles" class="bm-go">去逛逛文章 <XIcon name="ArrowRight" :size="14" /></router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watchEffect, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import ArticleCard from '@/components/site/ArticleCard.vue';
import { getHistory, removeHistory, clearHistory, onHistoryChange } from '@/utils/history';
import { articleApi } from '@/api';
import { useSiteStore } from '@/stores/site';
import { applyPageMeta } from '@/utils/pageMeta';

const site = useSiteStore();
const history = ref(getHistory());

watchEffect(() => {
  const siteName = site.settings.site_name || 'Xalor的小站';
  const pageTitle = '阅读足迹';
  document.title = `${pageTitle} · ${siteName}`;
  applyPageMeta({ title: pageTitle, description: '我最近在本站读过的文章', path: '/history', site });
});

/** 足迹是快照，字段与收藏同构，直接喂给文章卡片 */
function toArticle(b) {
  return {
    ...b,
    views: b.views || 0,
    comment_count: b.comment_count || 0,
    likes: b.likes || 0,
    is_top: false,
    tags: b.tags || [],
  };
}

function remove(slug) {
  history.value = removeHistory(slug);
  ElMessage.success('已从足迹移除');
}

async function clearAll() {
  try {
    await ElMessageBox.confirm(
      `确定清空全部 ${history.value.length} 条阅读足迹吗？此操作不可恢复。`,
      '清空足迹',
      { confirmButtonText: '确定清空', cancelButtonText: '取消', type: 'warning' }
    );
  } catch (e) {
    return; // 用户取消
  }
  clearHistory();
  history.value = [];
  ElMessage.success('已清空阅读足迹');
}

/**
 * 足迹是快照，文章被删/改 slug 后它会失效，点进去就是 404。
 * 与收藏页同一套处理：只剔 404、串行请求（避免撞本站限速）、静默清理。
 */
const checking = ref(false);
async function pruneStale() {
  if (checking.value || !history.value.length) return;
  checking.value = true;
  const stale = [];
  for (const b of history.value) {
    try {
      await articleApi.detail(b.slug);
    } catch (e) {
      if (e?.response?.status === 404) stale.push(b.slug);
    }
  }
  if (stale.length) {
    stale.forEach((slug) => removeHistory(slug));
    history.value = getHistory();
  }
  checking.value = false;
}

onMounted(pruneStale);

const offSync = onHistoryChange((list) => { history.value = list; });
onUnmounted(() => offSync());
</script>

<style scoped>
/* 与收藏页共用同一份样式：同一套液态玻璃外观，不新造一套、也不会两边各自漂移 */
@import '@/styles/list-page.css';
</style>
