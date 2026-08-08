<template>
  <div class="home">
    <!-- 页首区 -->
    <section class="hero">
      <!-- 装饰光晕 -->
      <span class="blob blob-1"></span>
      <span class="blob blob-2"></span>
      <span class="blob blob-3"></span>

      <div class="container hero-inner">
        <p class="hero-eyebrow">XALOR'S NOTEBOOK</p>
        <h1 class="hero-title">
          <span class="hero-line">用文字，</span><br />
          <span class="hero-line">把日子过成<span class="hero-accent">诗</span>。</span>
        </h1>
        <p class="hero-desc">
          <span class="type-cursor" v-if="typed.length">{{ typed }}</span
          ><span class="type-caret"></span>
        </p>
        <div class="hero-meta">
          <span class="hm-chip"><XIcon name="FileText" :size="14" /><b>{{ display.articles }}</b> 篇文章</span>
          <span class="hm-chip"><XIcon name="MessageSquare" :size="14" /><b>{{ display.comments }}</b> 条评论</span>
          <span class="hm-chip"><XIcon name="Eye" :size="14" /><b>{{ display.pv }}</b> 次浏览</span>
        </div>
      </div>
    </section>

    <!-- 精选文章 -->
    <section v-if="featured" class="container featured-wrap">
      <div class="sec-head">
        <h2 class="sec-title">精选文章</h2>
        <router-link to="/articles" class="sec-more">全部文章 <XIcon name="ArrowRight" :size="14" /></router-link>
      </div>

      <router-link :to="`/article/${featured.slug}`" class="featured" v-reveal>
        <span class="featured-flag">
          <XIcon name="Star" :size="13" /> 精选
        </span>

        <div v-if="featured.cover" class="featured-cover">
          <img :src="featured.cover" :alt="featured.title" decoding="async" fetchpriority="high" />
        </div>
        <div v-else class="featured-cover featured-text" :class="'tone-' + (featured.id % 6)">
          <span class="fq">“</span>
        </div>

        <div class="featured-body">
          <div class="featured-meta">
            <span v-if="featured.category_name" class="cat" :style="{ '--cat': featured.category_color || 'var(--accent)' }">
              {{ featured.category_name }}
            </span>
            <span class="date">{{ formatDate(featured.published_at) }}</span>
            <span class="reading">{{ readingTime(featured.content || featured.summary) }} 分钟阅读</span>
          </div>
          <h3 class="featured-title">{{ featured.title }}</h3>
          <p class="featured-excerpt">{{ featured.summary }}</p>
          <div class="featured-foot">
            <span class="read-cta">阅读全文 <XIcon name="ArrowRight" :size="15" /></span>
            <div class="featured-stats">
              <span class="stat"><XIcon name="Eye" :size="14" /> {{ featured.views }}</span>
              <span class="stat"><XIcon name="MessageSquare" :size="14" /> {{ featured.comment_count }}</span>
              <span class="stat"><XIcon name="Heart" :size="14" /> {{ featured.likes }}</span>
            </div>
          </div>
        </div>
      </router-link>
    </section>

    <!-- 分类入口（文字式） -->
    <section v-if="categories.length" class="container cats-wrap">
      <div class="sec-head">
        <h2 class="sec-title">分类</h2>
      </div>
      <div class="cat-row" v-reveal="'stagger'">
        <router-link
          v-for="c in categories"
          :key="c.id"
          :to="{ path: '/articles', query: { category: c.slug } }"
          class="cat-item"
          :style="{ '--cat': c.color || 'var(--accent)' }"
        >
          <span class="cat-dot" :style="{ background: c.color || 'var(--accent)' }"></span>
          <span class="cat-name">{{ c.name }}</span>
          <span class="cat-count">{{ c.article_count }}</span>
          <span class="cat-arrow"><XIcon name="ArrowUpRight" :size="14" /></span>
        </router-link>
      </div>
    </section>

    <!-- 最新文章 -->
    <section class="container posts-wrap">
      <div class="sec-head">
        <h2 class="sec-title">最新文章</h2>
      </div>

      <SkeletonList v-if="loading" :count="4" />
      <div v-else-if="homeError" class="home-error">
        <p>内容加载失败，请检查网络后重试</p>
        <button class="more-btn" @click="retryHome">
          重新加载 <XIcon name="RefreshCw" :size="15" />
        </button>
      </div>
      <div v-else-if="!articles.length" class="home-empty">
        <p>还没有文章，等待第一篇诞生 ✍️</p>
      </div>
      <div v-else class="post-grid" v-reveal="'stagger'">
        <ArticleCard v-for="a in articles" :key="a.id" :article="a" />
      </div>

      <div v-if="total > articles.length && !loading" class="more-wrap">
        <router-link to="/articles" class="more-btn">
          查看全部 {{ total }} 篇文章 <XIcon name="ArrowRight" :size="15" />
        </router-link>
      </div>
    </section>

    <!-- 热门文章榜 -->
    <section class="container hot-wrap">
      <div class="sec-head">
        <h2 class="sec-title">热门排行</h2>
        <div class="hot-tabs">
          <button class='hot-tab' :class="{ active: hotSort === 'hot' }" :aria-pressed="hotSort === 'hot'" @click="setHotSort('hot')">最热</button>
          <button class='hot-tab' :class="{ active: hotSort === 'commented' }" :aria-pressed="hotSort === 'commented'" @click="setHotSort('commented')">热议</button>
        </div>
        <router-link :to="`/articles?sort=${hotSort}`" class="sec-more">{{ hotSort === 'hot' ? '最热文章' : '热议文章' }} <XIcon name="ArrowRight" :size="14" /></router-link>
      </div>

      <div v-if="hotArticles.length" class="hot-grid" v-reveal="'stagger'">
        <router-link
          v-for="(h, i) in hotArticles"
          :key="h.id"
          :to="`/article/${h.slug}`"
          class="hot-item"
          :class="{ 'hot-top': i < 3 }"
        >
          <span class="hot-rank">{{ i + 1 }}</span>
          <span class="hot-body">
            <span class="hot-title">{{ h.title }}</span>
            <span class="hot-meta">
              <span v-if="h.category_name">{{ h.category_name }}</span>
              <span><XIcon name="Eye" :size="13" /> {{ formatNumber(h.views) }}</span>
              <span v-if="hotSort === 'commented'"><XIcon name="MessageSquare" :size="13" /> {{ h.comment_count }}</span>
            </span>
          </span>
          <XIcon name="ArrowUpRight" :size="15" class="hot-arrow" />
        </router-link>
      </div>
      <div v-else class="home-empty small">暂无数据</div>
    </section>

    <!-- 最新评论 -->
    <section v-if="recentComments.length" class="container comments-wrap">
      <div class="sec-head">
        <h2 class="sec-title">最新评论</h2>
        <router-link to="/messages" class="sec-more">去留言板 <XIcon name="ArrowRight" :size="14" /></router-link>
      </div>
      <div class="comment-grid" v-reveal="'stagger'">
        <router-link
          v-for="c in recentComments"
          :key="c.id"
          :to="`/article/${c.article_slug}?comment=${c.id}`"
          class="rc-item"
        >
          <span class="rc-avatar">{{ (c.nickname || '?').charAt(0).toUpperCase() }}</span>
          <span class="rc-body">
            <span class="rc-head">
              <span class="rc-nick">{{ c.nickname }}</span>
              <span class="rc-time">{{ timeAgo(c.created_at) }}</span>
            </span>
            <span class="rc-content">{{ c.content }}</span>
            <span class="rc-article"><XIcon name="FileText" :size="12" /> {{ c.article_title }}</span>
          </span>
        </router-link>
      </div>
    </section>

    <!-- 标签云 -->
    <section v-if="tags.length" class="container tags-wrap">
      <div class="sec-head">
        <h2 class="sec-title">标签</h2>
        <router-link to="/tags" class="sec-more">全部标签 <XIcon name="ArrowRight" :size="14" /></router-link>
      </div>
      <div class="tag-row" v-reveal>
        <router-link
          v-for="t in tags.slice(0, 16)"
          :key="t.id"
          :to="{ path: '/articles', query: { tag: t.slug } }"
          class="tag-link"
        >
          <span class="tag-name"># {{ t.name }}</span>
          <span class="tag-count">{{ t.article_count }}</span>
        </router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import ArticleCard from '@/components/site/ArticleCard.vue';
import SkeletonList from '@/components/ui/SkeletonList.vue';
import { articleApi, categoryApi, tagApi, commentApi } from '@/api';
import { useSiteStore } from '@/stores/site';
import { formatDate, formatNumber, readingTime, timeAgo } from '@/utils/format';

const site = useSiteStore();
const articles = ref([]);
const featured = ref(null);
const categories = ref([]);
const tags = ref([]);
const hotArticles = ref([]);
const recentComments = ref([]);
const hotSort = ref('hot');
const total = ref(0);
const loading = ref(true);
const homeError = ref(false);

/** 热门排行切换：最热（浏览）/ 热议（评论数），重新拉取 */
async function setHotSort(s) {
  if (hotSort.value === s) return;
  hotSort.value = s;
  const res = await articleApi.list({ pageSize: 5, sort: s }).catch(() => null);
  if (res) hotArticles.value = res.list;
}

// 打字机效果：逐字显示站点描述
const typed = ref('');
// 打字机文本：超长描述截断（≤64 字 ≈ 3.5 秒，防长文案拖慢首屏动效）
const TYPE_TEXT = computed(() => (site.settings.site_desc || '记录技术、生活与思考').slice(0, 64));
let typeTimer = null;

// 统计数字滚动动画
const display = ref({ articles: 0, comments: 0, pv: 0 });

function animateNumber(target, onFrame, duration = 1200) {
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function step(now) {
    const p = Math.min(1, (now - start) / duration);
    onFrame(Math.round(target * ease(p)));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function runCountUps() {
  const targets = {
    articles: site.stats.article_count || 0,
    comments: site.stats.comment_count || 0,
    pv: site.stats.total_pv || 0,
  };
  // 用户偏好减效：直接显示最终值，不播动画
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    Object.assign(display.value, targets);
    return;
  }
  Object.entries(targets).forEach(([key, target], i) => {
    setTimeout(() => animateNumber(target, (v) => { display.value[key] = v; }), i * 140);
  });
}

function startTyping() {
  typed.value = '';
  let i = 0;
  const text = TYPE_TEXT.value;
  // 用户偏好减效：直接显示完整文本
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    typed.value = text;
    return;
  }
  clearInterval(typeTimer);
  typeTimer = setInterval(() => {
    i += 1;
    typed.value = text.slice(0, i);
    if (i >= text.length) {
      clearInterval(typeTimer);
      typeTimer = null;
    }
  }, 55);
}

onMounted(async () => {
  // 统计先行：子组件 onMounted 先于父组件 Layout 执行，
  // 若不等 init，动画目标值全为 0（统计数字永远不显示）。
  // site.init() 幂等（loaded 防重入），与 Layout 并发调用安全。
  await site.init();
  // 容错加载：任一接口失败不阻塞整页（allSettled 而非 all，防永久骨架屏）
  const [articleRes, catRes, tagRes, hotRes, commentRes] = await Promise.allSettled([
    articleApi.list({ pageSize: 6 }),
    categoryApi.list(),
    tagApi.list(),
    articleApi.list({ pageSize: 5, sort: 'hot' }),
    commentApi.recent(),
  ]);
  if (articleRes.status === 'fulfilled') {
    const list = articleRes.value.list;
    const top = list.find((a) => a.is_top) || list[0];
    featured.value = top || null;
    articles.value = list.filter((a) => a.id !== top?.id);
    total.value = articleRes.value.pagination.total;
  }
  if (catRes.status === 'fulfilled') categories.value = catRes.value;
  if (tagRes.status === 'fulfilled') tags.value = tagRes.value;
  if (hotRes.status === 'fulfilled') hotArticles.value = hotRes.value.list;
  if (commentRes.status === 'fulfilled') recentComments.value = commentRes.value;
  // 全部接口失败（如断网/服务不可用）：显示明确错误与重试，而非静默空页
  homeError.value =
    articleRes.status === 'rejected' &&
    catRes.status === 'rejected' &&
    tagRes.status === 'rejected' &&
    hotRes.status === 'rejected';
  loading.value = false;
  startTyping();
  runCountUps();
});

/** 首页整体重试：复位状态后重新执行加载 */
async function retryHome() {
  homeError.value = false;
  loading.value = true;
  try {
    await site.init();
    const [articleRes] = await Promise.allSettled([
      articleApi.list({ pageSize: 6 }),
      articleApi.list({ pageSize: 5, sort: 'hot' }),
    ]);
    if (articleRes.status === 'fulfilled') {
      const list = articleRes.value.list;
      const top = list.find((a) => a.is_top) || list[0];
      featured.value = top || null;
      articles.value = list.filter((a) => a.id !== top?.id);
      total.value = articleRes.value.pagination.total;
    }
  } catch (e) {
    homeError.value = true;
  } finally {
    loading.value = false;
  }
}

onUnmounted(() => {
  clearInterval(typeTimer);
});
</script>

<style scoped>
/* ============ 页首 ============ */
.hero {
  position: relative;
  overflow: hidden;
  padding: 88px 0 56px;
  border-bottom: 1px solid var(--border);
  background:
    radial-gradient(60% 100% at 15% 0%, var(--accent-soft) 0%, transparent 55%),
    radial-gradient(50% 90% at 90% 10%, rgba(201, 144, 15, 0.07) 0%, transparent 50%);
}

/* 强调色柔光斑（装饰层，不拦截交互） */
.hero::before {
  content: '';
  position: absolute;
  width: 440px;
  height: 440px;
  border-radius: 50%;
  top: -160px;
  right: -100px;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 16%, transparent) 0%, transparent 68%);
  pointer-events: none;
}

.hero::after {
  content: '';
  position: absolute;
  width: 300px;
  height: 300px;
  border-radius: 50%;
  bottom: -140px;
  left: -90px;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 10%, transparent) 0%, transparent 65%);
  pointer-events: none;
}

[data-theme='dark'] .hero {
  background:
    radial-gradient(60% 100% at 15% 0%, rgba(228, 87, 61, 0.08) 0%, transparent 55%),
    radial-gradient(50% 90% at 90% 10%, rgba(201, 144, 15, 0.05) 0%, transparent 50%);
}

/* 装饰光晕：缓慢漂浮，营造呼吸感 */
.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(60px);
  pointer-events: none;
  opacity: 0.5;
}

.blob-1 {
  width: 320px;
  height: 320px;
  top: -120px;
  left: -80px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  animation: blobFloat 14s ease-in-out infinite;
}

.blob-2 {
  width: 240px;
  height: 240px;
  top: 40px;
  right: -60px;
  background: color-mix(in srgb, #c9900f 10%, transparent);
  animation: blobFloat 17s ease-in-out infinite reverse;
}

.blob-3 {
  width: 180px;
  height: 180px;
  bottom: -80px;
  left: 36%;
  background: color-mix(in srgb, #2f6fb3 8%, transparent);
  animation: blobFloat 20s ease-in-out 2s infinite;
}

@keyframes blobFloat {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(24px, -18px) scale(1.06); }
  66% { transform: translate(-16px, 14px) scale(0.96); }
}

.hero-inner {
  position: relative;
  max-width: 760px;
  margin: 0 auto;
  padding: 0 24px;
}

.hero-eyebrow {
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--accent);
  margin-bottom: 20px;
  text-transform: uppercase;
  animation: fadeUp 0.6s var(--ease-out) both;
}

.hero-title {
  font-family: var(--font-serif);
  font-size: clamp(2.2rem, 5.5vw, 3.3rem);
  font-weight: 700;
  line-height: 1.22;
  letter-spacing: -0.035em;
  margin-bottom: 18px;
}

.hero-line {
  display: inline-block;
  animation: fadeUp 0.6s var(--ease-out) both;
}

.hero-line:nth-child(2) {
  animation-delay: 0.08s;
}

.hero-accent {
  color: var(--accent);
  position: relative;
}

.hero-accent::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 4px;
  height: 7px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 26%, transparent);
  z-index: -1;
}

.hero-desc {
  font-size: 1.06rem;
  color: var(--text-2);
  margin-bottom: 26px;
  min-height: 1.8em;
  animation: fadeUp 0.6s var(--ease-out) 0.16s both;
}

.type-caret {
  display: inline-block;
  width: 2px;
  height: 1.1em;
  background: var(--accent);
  vertical-align: -0.18em;
  margin-left: 2px;
  animation: caretBlink 1s steps(2) infinite;
}

@keyframes caretBlink {
  50% { opacity: 0; }
}

.hero-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  animation: fadeUp 0.6s var(--ease-out) 0.24s both;
}

.hm-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 16px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--card) 68%, transparent);
  backdrop-filter: blur(8px);
  color: var(--text-2);
  font-size: 0.86rem;
  transition: all var(--dur) var(--ease);
}

.hm-chip:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  transform: translateY(-1px);
}

.hm-chip :deep(svg) {
  color: var(--accent);
}

.hm-chip b {
  color: var(--text);
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  font-size: 0.98rem;
}

/* ============ 区块公共 ============ */
.featured-wrap,
.cats-wrap,
.posts-wrap,
.tags-wrap,
.hot-wrap,
.comments-wrap {
  padding-top: 56px;
}

/* ============ 最新评论 ============ */
.comment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
  gap: 14px;
}

.rc-item {
  display: flex;
  gap: 12px;
  padding: 16px 18px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  transition: transform var(--dur) var(--ease), border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.rc-item:hover {
  transform: translateY(-2px);
  border-color: var(--accent);
  box-shadow: var(--shadow-2);
}

.rc-avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), #ec4899);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  font-weight: 700;
}

.rc-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.rc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rc-nick {
  font-size: 0.84rem;
  font-weight: 650;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rc-time {
  font-size: 0.72rem;
  color: var(--text-3);
  margin-left: auto;
  flex-shrink: 0;
}

.rc-content {
  font-size: 0.84rem;
  color: var(--text-2);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.rc-article {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.74rem;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rc-item:hover .rc-article {
  color: var(--accent);
}

.sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 22px;
}

.sec-title {
  font-size: 1.3rem;
  font-weight: 750;
  letter-spacing: -0.02em;
  position: relative;
  padding-left: 14px;
}

.sec-title::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.3em;
  bottom: 0.3em;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}

.sec-more {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.86rem;
  color: var(--text-2);
  transition: color var(--dur) var(--ease);
}

.sec-more:hover {
  color: var(--accent);
}

/* 热门排行 tab 切换 */
.hot-tabs {
  display: inline-flex;
  gap: 3px;
  margin-left: auto;
  margin-right: 14px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-soft);
}

.hot-tab {
  padding: 4px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}

.hot-tab:hover {
  color: var(--accent);
}

.hot-tab.active {
  background: var(--card);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}

.home-empty.small {
  padding: 30px 0;
  font-size: 0.9rem;
}

/* ============ 精选卡片（横向） ============ */
.featured {
  display: grid;
  grid-template-columns: 5fr 7fr;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-1);
  transition: box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
  position: relative;
}

.featured:hover {
  box-shadow: var(--shadow-2);
  border-color: var(--line);
  transform: translateY(-2px);
}

/* 精选角标 */
.featured-flag {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 0.74rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 35%, transparent);
}

.featured-cover {
  min-height: 300px;
  overflow: hidden;
  position: relative;
}

.featured-cover::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 55%, rgba(20, 18, 14, 0.22));
  pointer-events: none;
}

.featured-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.7s var(--ease-out);
}

.featured:hover .featured-cover img {
  transform: scale(1.045);
}

.featured-text {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 无封面排版区不加渐变遮罩 */
.featured-text::after {
  display: none;
}

.fq {
  font-family: Georgia, serif;
  font-size: 6rem;
  line-height: 1;
  color: currentColor;
  opacity: 0.3;
}

.tone-0 { background: #f5ede6; color: #c4754a; }
.tone-1 { background: #eef0e4; color: #6b7a3a; }
.tone-2 { background: #e8eef1; color: #3a6b7a; }
.tone-3 { background: #f3e9ee; color: #9a4a5e; }
.tone-4 { background: #edeaf3; color: #5a4a9a; }
.tone-5 { background: #f2efe4; color: #a0824a; }

[data-theme='dark'] .tone-0 { background: #2a241d; color: #d49a72; }
[data-theme='dark'] .tone-1 { background: #26281f; color: #9aa86a; }
[data-theme='dark'] .tone-2 { background: #1f2830; color: #6a9aaa; }
[data-theme='dark'] .tone-3 { background: #2a2126; color: #c47a8e; }
[data-theme='dark'] .tone-4 { background: #252130; color: #8a7ab8; }
[data-theme='dark'] .tone-5 { background: #292720; color: #b8985a; }

.featured-body {
  padding: 34px 36px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.featured-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}

.cat {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cat);
  padding: 3px 10px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--cat) 10%, transparent);
}

.date {
  font-size: 0.8rem;
  color: var(--text-3);
}

.reading {
  font-size: 0.8rem;
  color: var(--text-3);
  padding-left: 14px;
  border-left: 1px solid var(--line);
}

.featured-title {
  font-size: 1.55rem;
  font-weight: 800;
  line-height: 1.4;
  letter-spacing: -0.02em;
  margin-bottom: 12px;
  transition: color var(--dur) var(--ease);
}

.featured:hover .featured-title {
  color: var(--accent);
}

.featured-excerpt {
  color: var(--text-2);
  font-size: 0.95rem;
  line-height: 1.85;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 20px;
}

.featured-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 18px;
  border-top: 1px solid var(--border);
}

.read-cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.88rem;
  font-weight: 650;
  color: var(--accent);
}

.read-cta :deep(svg) {
  transition: transform var(--dur) var(--ease);
}

.featured:hover .read-cta :deep(svg) {
  transform: translateX(3px);
}

.featured-stats {
  display: flex;
  gap: 14px;
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--text-3);
}

/* ============ 分类（文字式） ============ */
.cat-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}

.cat-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: all var(--dur) var(--ease);
}

.cat-dot {
  width: 12px;
  height: 12px;
  border-radius: 4px;
  flex-shrink: 0;
  box-shadow: 0 2px 6px color-mix(in srgb, var(--cat) 30%, transparent);
}

.cat-item:hover {
  border-color: var(--cat);
  transform: translateY(-2px);
  box-shadow: var(--shadow-1);
}

.cat-name {
  font-weight: 600;
  font-size: 0.94rem;
}

.cat-count {
  font-size: 0.78rem;
  color: var(--text-3);
  margin-left: auto;
}

.cat-arrow {
  color: var(--text-3);
  display: flex;
  opacity: 0;
  transform: translateX(-4px);
  transition: all var(--dur) var(--ease);
}

.cat-item:hover .cat-arrow {
  opacity: 1;
  transform: none;
  color: var(--cat);
}

/* ============ 文章网格 ============ */
.post-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 22px;
}

.more-wrap {
  text-align: center;
  margin-top: 40px;
}

.more-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 11px 30px;
  border-radius: 999px;
  border: 1px solid var(--text);
  font-size: 0.92rem;
  font-weight: 600;
  transition: all var(--dur) var(--ease);
}

.more-btn:hover {
  background: var(--text);
  color: var(--bg);
}

/* ============ 标签 ============ */
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.tag-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 15px;
  border-radius: 7px;
  background: var(--card);
  border: 1px solid var(--border);
  font-size: 0.86rem;
  color: var(--text-2);
  transition: all var(--dur) var(--ease);
}

.tag-link:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.tag-count {
  font-size: 0.72rem;
  color: var(--text-3);
}

/* ============ 热门排行 ============ */
.hot-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hot-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: all var(--dur) var(--ease);
}

.hot-item:hover {
  border-color: var(--line);
  box-shadow: var(--shadow-1);
  transform: translateX(3px);
}

.hot-rank {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--bg-soft);
  color: var(--text-3);
  font-weight: 800;
  font-family: Georgia, serif;
  font-size: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}

.hot-top .hot-rank {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 35%, transparent);
}

.hot-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hot-title {
  font-size: 0.96rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}

.hot-item:hover .hot-title {
  color: var(--accent);
}

.hot-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 0.76rem;
  color: var(--text-3);
}

.hot-meta span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.hot-arrow {
  color: var(--text-3);
  opacity: 0;
  transform: translate(-4px, 4px);
  transition: all var(--dur) var(--ease);
  flex-shrink: 0;
}

.hot-item:hover .hot-arrow {
  opacity: 1;
  transform: none;
  color: var(--accent);
}

/* ============ 响应式 ============ */
@media (max-width: 900px) {
  .featured {
    grid-template-columns: 1fr;
  }
  .featured-cover {
    min-height: 200px;
    max-height: 240px;
  }
  .featured-body {
    padding: 24px;
  }
}

@media (max-width: 700px) {
  .hero {
    padding: 60px 0 40px;
  }
  .post-grid {
    grid-template-columns: 1fr;
  }
}
</style>
