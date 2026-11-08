<template>
  <div class="not-found">
    <div class="container">
      <div class="nf-inner fade-up">
        <span class="nf-float" aria-hidden="true">?</span>
        <p class="nf-code">404</p>
        <h1 class="nf-title">页面走丢了</h1>
        <p class="nf-desc">你要找的内容可能被移动或删除了</p>
        <div class="nf-actions">
          <router-link to="/" class="btn-primary">
            <XIcon name="House" :size="16" /> 回到首页
          </router-link>
          <router-link to="/articles" class="btn-ghost">
            <XIcon name="FileText" :size="16" /> 浏览文章
          </router-link>
          <button class="btn-ghost" :disabled="loadingRandom" @click="randomArticle">
            <XIcon name="Shuffle" :size="16" /> {{ loadingRandom ? '找一篇…' : '随便看看' }}
          </button>
        </div>
        <!-- 站内搜索：输入关键词直达文章列表搜索结果 -->
        <form class="nf-search" role="search" @submit.prevent="doSearch">
          <XIcon name="Search" :size="16" class="nf-search-icon" />
          <input
            v-model="searchKeyword"
            class="nf-search-input"
            placeholder="搜索全站文章…"
            maxlength="50"
            aria-label="站内搜索"
          />
          <button class="nf-search-btn" type="submit">搜索</button>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watchEffect } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import request from '@/api';
import { useSiteStore } from '@/stores/site';

const site = useSiteStore();

// 浏览器标签页标题
watchEffect(() => {
  const siteName = site.settings.site_name || 'Xalor的小站';
  document.title = `页面不存在 · ${siteName}`;
});

const router = useRouter();
// 这个页面**不做**倒计时自动跳转。
// 原实现倒计时 5 秒后 router.replace('/')，而同一页摆着
// 「回到首页 / 浏览文章 / 随便看看 / 搜索」四个出口 —— 跳走后它们都用不了了，
// 读者没时间点，读屏用户更没时间听完。404 页应该等人，不该催人。
const loadingRandom = ref(false);
const searchKeyword = ref('');

/** 站内搜索：跳转文章列表并应用关键词 */
function doSearch() {
  const kw = searchKeyword.value.trim();
  router.push(kw ? { path: '/articles', query: { keyword: kw } } : '/articles');
}

/** 随机跳转一篇已发布文章（给读者一个「随便看看」的出口） */
async function randomArticle() {
  if (loadingRandom.value) return;
  loadingRandom.value = true;
  try {
    // silent：提示由下面分流，避免拦截器再弹一条意思相反的 toast（404 不是错误）
    const r = await request.get('/articles/random', { silent: true });
    if (r && r.slug) {
          router.push(`/article/${r.slug}`);
      return;
    }
  } catch (e) {
    // 404 = 站内还没有文章（正常状态，不是失败）；其余才是网络/服务问题。
    // 原来只写一句「拦截器已提示」：既分不清这两种情况，也无法确认提示真的出现过——
    // 读者点了按钮却什么也没发生，只能反复点。
    const status = e && e.response && e.response.status;
    if (status === 404) ElMessage.info('还没有可跳转的文章');
    else ElMessage.error('跳转失败，请稍后重试');
  } finally {
    loadingRandom.value = false;
  }
}

onMounted(() => {
  // 404 页声明 noindex：防搜索引擎收录错误页（卸载时必须移除，
  // 否则访客再浏览正常页面时 head 里残留 noindex 会导致全站不被收录）
  const noindex = document.createElement('meta');
  noindex.setAttribute('name', 'robots');
  noindex.setAttribute('content', 'noindex,nofollow');
  noindex.setAttribute('id', 'nf-robots-noindex');
  document.head.appendChild(noindex);
});

onUnmounted(() => {
  document.getElementById('nf-robots-noindex')?.remove();
});
</script>

<style scoped>
.not-found {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 80px 0;
  min-height: 60vh;
}

.nf-inner {
  text-align: center;
  position: relative;
  padding: 48px 36px;
  border-radius: 28px;
  background: color-mix(in srgb, var(--card) 86%, transparent);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-2);
  backdrop-filter: blur(16px);
}

/* 漂浮问号装饰 */
.nf-float {
  position: absolute;
  font-family: Georgia, serif;
  font-size: 9rem;
  font-weight: 800;
  color: var(--accent-text);
  opacity: 0.08;
  left: 50%;
  top: -30px;
  transform: translateX(-50%);
  pointer-events: none;
  animation: floatQ 4s ease-in-out infinite;
}

@keyframes floatQ {
  0%, 100% { transform: translateX(-50%) translateY(0) rotate(-4deg); }
  50% { transform: translateX(-50%) translateY(-12px) rotate(4deg); }
}

.nf-code {
  font-family: Georgia, serif;
  font-size: clamp(5rem, 12vw, 8rem);
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.04em;
  background: linear-gradient(135deg, var(--text) 30%, var(--text-3));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.nf-title {
  font-size: 1.5rem;
  font-weight: 750;
  margin: 18px 0 8px;
  letter-spacing: -0.02em;
}

.nf-desc {
  color: var(--text-2);
  font-size: 0.98rem;
  margin-bottom: 32px;
}

.nf-actions {
  display: flex;
  justify-content: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* 站内搜索框 */
.nf-search {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  margin: 26px auto 0;
  padding: 6px 6px 6px 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 999px;
  box-shadow: var(--shadow-1);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.nf-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
}

.nf-search-icon {
  color: var(--text-3);
  flex-shrink: 0;
}

.nf-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 0.92rem;
}

.nf-search-btn {
  flex-shrink: 0;
  padding: 8px 20px;
  border: none;
  border-radius: 999px;
  background: var(--accent-fill);
  color: #fff;
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease);
}

.nf-search-btn:hover {
  opacity: 0.88;
}
</style>
