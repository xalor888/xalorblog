<template>
  <div class="bookmarks-page">
    <div class="container">
      <div class="page-head fade-up">
        <p class="eyebrow">BOOKMARKS</p>
        <h1>我的收藏</h1>
        <p class="lead">共 {{ bookmarks.length }} 篇收藏的文章</p>
        <button v-if="bookmarks.length" class="bm-clear" @click="clearAll">
          <XIcon name="Trash2" :size="13" /> 清空全部
        </button>
      </div>

      <div v-if="bookmarks.length" class="bm-grid" v-reveal="'stagger'">
        <div v-for="b in bookmarks" :key="b.id" class="bm-item">
          <ArticleCard :article="toArticle(b)" />
          <button class="bm-remove" :title="'取消收藏 ' + b.title" @click="remove(b.id)">
            <XIcon name="Trash2" :size="14" />
          </button>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="icon-wrap"><XIcon name="Bookmark" :size="30" /></div>
        <p>还没有收藏任何文章</p>
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
import { getBookmarks, removeBookmark, clearBookmarks, onBookmarksChange } from '@/utils/bookmark';
import { useSiteStore } from '@/stores/site';
import { applyPageMeta } from '@/utils/pageMeta';
import { articleApi } from '@/api';

const site = useSiteStore();

// 浏览器标签页标题
watchEffect(() => {
  const siteName = site.settings.site_name || 'Xalor的小站';
  const pageTitle = '我的收藏';
  document.title = `${pageTitle} · ${siteName}`;
  // 元信息与标题同源设置：canonical / og:url / og:image 缺一都会让分享卡片降级

  applyPageMeta({ title: pageTitle, description: '我在本站收藏的文章', path: '/bookmarks', site });
});

const bookmarks = ref(getBookmarks());

// 失效条目清理：收藏快照存在 localStorage 里，文章被删除/改 slug 之后它不会自动消失，
// 于是收藏页会一直展示一条**点进去是 404** 的卡片（实测：注入 slug=deleted-article-xyz
// 的条目，页面照常显示「共 1 篇」并给出链接）。
// 这里做一次轻校验：只对**当前可见**的条目去请求详情，返回 404 的就剔掉。
// 注意三点：
//   1) 失败要区分「404 真的没了」和「网络抖动」—— 后者不能删用户的收藏；
//   2) 逐条清理**不能并发打一堆请求**，收藏多了会被限流（本站有速率限制）；
//   3) 清理是**静默**的，只更新本地列表，不弹提示打扰。
const checking = ref(false);
async function pruneStale() {
  if (checking.value || !bookmarks.value.length) return;
  checking.value = true;
  const stale = [];
  for (const b of bookmarks.value) {
    try {
      await articleApi.detail(b.slug);
    } catch (e) {
      // 只有明确的 404 才算失效；超时/网络错误一律保留
      if (e?.response?.status === 404) stale.push(b.id);
    }
  }
  if (stale.length) {
    stale.forEach((id) => removeBookmark(id));
    bookmarks.value = getBookmarks();
  }
  checking.value = false;
}

onMounted(pruneStale);

// 另一个标签页增删收藏时，本页列表同步刷新（storage 事件不会在当前页触发，不会自激）
const offSync = onBookmarksChange((list) => { bookmarks.value = list; });
onUnmounted(() => offSync());

/** 把书签对象包装成文章卡片所需结构 */
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

function remove(id) {
  bookmarks.value = removeBookmark(id);
  ElMessage.success('已取消收藏');
}

/** 清空全部收藏（二次确认防误触） */
async function clearAll() {
  try {
    await ElMessageBox.confirm(`确定清空全部 ${bookmarks.value.length} 篇收藏吗？此操作不可恢复。`, '清空收藏', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    });
    clearBookmarks();
    bookmarks.value = [];
    ElMessage.success('已清空全部收藏');
  } catch (e) {
    /* 用户取消 */
  }
}
</script>

<style scoped>
.bookmarks-page {
  padding-bottom: 60px;
}

.page-head .eyebrow {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--accent-text);
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* 清空全部按钮（页头右侧） */
.bm-clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 14px;
  padding: 6px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 0.82rem;
  transition: all var(--dur) var(--ease);
}

.bm-clear:hover {
  color: #c24b5e;
  border-color: #c24b5e;
  background: color-mix(in srgb, #c24b5e 8%, transparent);
}

.bm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 22px;
}

/* 收藏项：卡片 + 右上角删除按钮 */
.bm-item {
  position: relative;
}

.bm-remove {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 5;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: rgba(29, 27, 22, 0.72);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
  opacity: 0;
  transform: translateY(-3px);
  transition: all var(--dur) var(--ease);
}

.bm-item:hover .bm-remove {
  opacity: 1;
  transform: none;
}

/* 触屏设备无 hover：删除按钮常显 */
@media (hover: none), (max-width: 640px) {
  .bm-remove {
    opacity: 1;
    transform: none;
  }
}

.bm-remove:hover {
  background: rgba(194, 75, 94, 0.9);
}

.bm-go {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 14px;
  padding: 8px 20px;
  border-radius: 999px;
  border: 1px solid var(--text);
  font-size: 0.88rem;
  font-weight: 600;
  transition: all var(--dur) var(--ease);
}

.bm-go:hover {
  background: var(--text);
  color: var(--bg);
}

@media (max-width: 700px) {
  .bm-grid {
    grid-template-columns: 1fr;
  }
  .bm-remove {
    opacity: 1;
    transform: none;
  }
}
</style>
