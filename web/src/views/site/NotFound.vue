<template>
  <div class="not-found">
    <div class="container">
      <div class="nf-inner fade-up">
        <span class="nf-float" aria-hidden="true">?</span>
        <p class="nf-code">404</p>
        <h1 class="nf-title">页面走丢了</h1>
        <p class="nf-desc">你要找的内容可能被移动或删除了<span class="nf-countdown" v-if="countdown > 0">（{{ countdown }} 秒后自动返回首页）</span></p>
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
import XIcon from '@/components/ui/XIcon.vue';
import { articleApi } from '@/api';

// 浏览器标签页标题
watchEffect(() => {
  document.title = '页面不存在';
});

const router = useRouter();
const countdown = ref(5);
const loadingRandom = ref(false);
const searchKeyword = ref('');
let timer = null;

/** 站内搜索：跳转文章列表并应用关键词 */
function doSearch() {
  const kw = searchKeyword.value.trim();
  clearInterval(timer); // 打断自动跳首页
  router.push(kw ? { path: '/articles', query: { keyword: kw } } : '/articles');
}

/** 随机跳转一篇已发布文章（发现内容；倒计时暂停避免打断跳转） */
async function randomArticle() {
  if (loadingRandom.value) return;
  loadingRandom.value = true;
  try {
    const r = await articleApi.random();
    if (r && r.slug) {
      clearInterval(timer);
      router.push(`/article/${r.slug}`);
      return;
    }
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    loadingRandom.value = false;
  }
}

onMounted(() => {
  // 404 页声明 noindex：防搜索引擎收录错误页
  const noindex = document.createElement('meta');
  noindex.setAttribute('name', 'robots');
  noindex.setAttribute('content', 'noindex,nofollow');
  document.head.appendChild(noindex);
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) {
      clearInterval(timer);
      router.replace('/');
    }
  }, 1000);
});

onUnmounted(() => {
  clearInterval(timer);
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
}

/* 漂浮问号装饰 */
.nf-float {
  position: absolute;
  font-family: Georgia, serif;
  font-size: 9rem;
  font-weight: 800;
  color: var(--accent);
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

.nf-countdown {
  color: var(--text-3);
  font-size: 0.85rem;
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
  background: var(--accent);
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
