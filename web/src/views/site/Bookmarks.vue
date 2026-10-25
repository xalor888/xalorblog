<template>
  <div class="bookmarks-page">
    <div class="container">
      <div class="page-head fade-up">
        <p class="eyebrow">BOOKMARKS</p>
        <h1>我的收藏</h1>
        <p class="lead">共 {{ bookmarks.length }} 篇收藏的文章</p>
        <button v-if="bookmarks.length" class="bm-clear" :aria-label="'清空全部收藏（共 ' + bookmarks.length + ' 条）'" @click="clearAll">
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
import { getCachedStatus, setCachedStatus } from '@/utils/slugCheck';

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
    // 先看缓存：24 小时内问过的 slug 不再重复请求。
    // 不这么做的话，每进一次页面就是二十来个（足迹上限 20）语义完全重复的请求。
    const cached = getCachedStatus(b.slug);
    if (cached === 'gone') { stale.push(b.id); continue; }
    if (cached === 'ok') continue;
    try {
      await articleApi.detail(b.slug);
      setCachedStatus(b.slug, 'ok');
    } catch (e) {
      // 只有明确的 404 才算失效；网络错误/超时一律不缓存，下次还会再问
      if (e?.response?.status === 404) {
        setCachedStatus(b.slug, 'gone');
        stale.push(b.id);
      }
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
@import '@/styles/list-page.css';
</style>
