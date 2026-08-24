<template>
  <div class="home">
    <!-- 全屏横幅 -->
    <section class="hero" aria-label="站点横幅">
      <div ref="heroBg" class="hero-bg" aria-hidden="true"></div>
      <div class="hero-veil" aria-hidden="true"></div>
      <div class="hero-dots" aria-hidden="true"></div>

      <div class="hero-card">
        <p class="hero-kicker">XALOR</p>
        <h1 class="hero-title">{{ site.settings.site_name || 'Xalor的小站' }}</h1>
        <p class="hero-desc" :title="typedFull">
          <span>{{ typed }}</span><span class="type-caret"></span>
        </p>
        <div class="hero-actions">
          <a class="hero-btn primary" :href="githubHref" target="_blank" rel="noopener">
            <XIcon name="Github" :size="18" /> GitHub
          </a>
          <a class="hero-btn" :href="'mailto:' + mailHref">
            <XIcon name="Mail" :size="18" /> 邮箱
          </a>
          <button class="hero-btn ghost" type="button" @click="scrollToFeed">
            阅读文章 <XIcon name="ChevronDown" :size="16" />
          </button>
        </div>
        <div class="hero-meta">
          <span><b>{{ display.articles }}</b> 文章</span>
          <span><b>{{ display.comments }}</b> 评论</span>
          <span><b>{{ formatNumber(display.pv) }}</b> 浏览</span>
        </div>
      </div>
    </section>

    <div id="home-feed" class="home-body container">
      <div class="home-grid">
        <!-- 文章列 -->
        <div class="feed">
          <SkeletonList v-if="loading" :count="4" />
          <div v-else-if="homeError" class="home-error">
            <p>内容加载失败，请检查网络后重试</p>
            <button class="more-btn" @click="retryHome">
              重新加载 <XIcon name="RefreshCw" :size="15" />
            </button>
          </div>
          <div v-else-if="!feedArticles.length" class="home-empty">
            <p>还没有文章，等待第一篇诞生 ✍️</p>
          </div>
          <ul v-else class="feed-list" v-reveal="'stagger'">
            <li v-for="a in feedArticles" :key="a.id">
              <ArticleCard :article="a" variant="feed" />
            </li>
          </ul>

          <div v-if="total > feedArticles.length && !loading" class="more-wrap">
            <router-link to="/articles" class="more-btn">
              查看全部 {{ total }} 篇文章 <XIcon name="ArrowRight" :size="15" />
            </router-link>
          </div>
        </div>

        <!-- 侧栏 -->
        <aside class="sidebar">
          <div class="side-sticky">
            <div class="side-card author-card">
              <div class="author-halo">
                <img class="author-avatar" :src="site.settings.avatar || '/logo.png'" alt="" />
              </div>
              <h2>{{ site.settings.site_name || 'Xalor' }}</h2>
              <p>{{ site.settings.site_desc || '记录技术、生活与思考' }}</p>
              <div class="author-stats">
                <span><b>{{ site.stats.article_count || 0 }}</b>文章</span>
                <span><b>{{ site.stats.comment_count || 0 }}</b>评论</span>
                <span><b>{{ formatNumber(site.stats.total_uv) }}</b>访客</span>
              </div>
              <div class="author-links">
                <router-link to="/about" class="alink">关于</router-link>
                <router-link to="/archive" class="alink">归档</router-link>
                <router-link to="/messages" class="alink">留言</router-link>
              </div>
            </div>

            <div v-if="categories.length" class="side-card">
              <h3>分类</h3>
              <router-link
                v-for="c in categories"
                :key="c.id"
                :to="{ path: '/articles', query: { category: c.slug } }"
                class="side-row"
              >
                <span class="dot" :style="{ background: c.color || 'var(--accent)' }"></span>
                <span class="grow">{{ c.name }}</span>
                <span class="muted">{{ c.article_count }}</span>
              </router-link>
            </div>

            <div v-if="hotArticles.length" class="side-card">
              <div class="side-head">
                <h3>{{ hotSort === 'hot' ? '热门' : '热议' }}</h3>
                <div class="hot-tabs">
                  <button :class="{ active: hotSort === 'hot' }" @click="setHotSort('hot')">热</button>
                  <button :class="{ active: hotSort === 'commented' }" @click="setHotSort('commented')">议</button>
                </div>
              </div>
              <router-link
                v-for="(h, i) in hotArticles"
                :key="h.id"
                :to="`/article/${h.slug}`"
                class="hot-row"
              >
                <span class="rank" :class="{ top: i < 3 }">{{ i + 1 }}</span>
                <span class="hot-title">{{ h.title }}</span>
              </router-link>
            </div>

            <div v-if="recentComments.length" class="side-card">
              <h3>最新评论</h3>
              <router-link
                v-for="c in recentComments.slice(0, 5)"
                :key="c.id"
                :to="`/article/${c.article_slug}?comment=${c.id}`"
                class="comment-row"
              >
                <span class="rc-avatar">{{ (c.nickname || '?').charAt(0).toUpperCase() }}</span>
                <span>
                  <span class="rc-nick">{{ c.nickname }}</span>
                  <span class="rc-text">{{ c.content }}</span>
                </span>
              </router-link>
            </div>

            <div v-if="tags.length" class="side-card">
              <h3>标签</h3>
              <div class="tag-cloud">
                <router-link
                  v-for="t in tags.slice(0, 18)"
                  :key="t.id"
                  :to="{ path: '/articles', query: { tag: t.slug } }"
                >#{{ t.name }}</router-link>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import ArticleCard from '@/components/site/ArticleCard.vue';
import SkeletonList from '@/components/ui/SkeletonList.vue';
import { articleApi, categoryApi, tagApi, commentApi } from '@/api';
import { useSiteStore } from '@/stores/site';
import { formatNumber } from '@/utils/format';

const site = useSiteStore();
const heroBg = ref(null);
const articles = ref([]);
const categories = ref([]);
const tags = ref([]);
const hotArticles = ref([]);
const recentComments = ref([]);
const hotSort = ref('hot');
const total = ref(0);
const loading = ref(true);
const homeError = ref(false);

const feedArticles = computed(() => articles.value);
const githubHref = computed(() => {
  const u = String(site.settings.social_github || '').trim();
  if (!u || /^https?:\/\/github\.com\/?$/i.test(u)) return 'https://github.com/xalor888';
  return u;
});
const mailHref = computed(() => {
  const u = String(site.settings.social_email || '').trim();
  return u || 'xalor888@gmail.com';
});

async function setHotSort(s) {
  if (hotSort.value === s) return;
  hotSort.value = s;
  const res = await articleApi.list({ pageSize: 5, sort: s }).catch(() => null);
  if (res) hotArticles.value = res.list;
}

const typed = ref('');
const typedFull = ref('');
const INTRO_LINES = [
  "👋 Hello, I'm Xalor, 一个普普通通的学生开发者",
  'The future is now. Infinite. Relentless. Evolving',
];
let typeTimer = null;
let hitokotoRetry = null;

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
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    Object.assign(display.value, targets);
    return;
  }
  Object.entries(targets).forEach(([key, target], i) => {
    setTimeout(() => animateNumber(target, (v) => { display.value[key] = v; }), i * 140);
  });
}

function stopTyping() {
  clearInterval(typeTimer);
  typeTimer = null;
}

function typeText(text, { hold = false, onDone } = {}) {
  stopTyping();
  const full = String(text || '');
  typedFull.value = full;
  let i = 0;
  let deleting = false;
  let pause = 0;
  typed.value = '';
  typeTimer = setInterval(() => {
    if (pause > 0) {
      pause -= 1;
      return;
    }
    if (!deleting) {
      i += 1;
      typed.value = full.slice(0, i);
      if (i >= full.length) {
        if (hold) {
          stopTyping();
          onDone?.();
          return;
        }
        deleting = true;
        pause = full.length > 40 ? 36 : 28;
      }
    } else {
      i -= 1;
      typed.value = full.slice(0, Math.max(0, i));
      if (i <= 0) {
        stopTyping();
        onDone?.();
      }
    }
  }, 42);
}

async function fetchHitokoto() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch('https://v1.hitokoto.cn/?encode=json&charset=utf-8', {
      signal: ctrl.signal,
    });
    if (!res.ok) return '';
    const data = await res.json();
    const quote = String(data.hitokoto || '').trim();
    if (!quote) return '';
    const from = String(data.from || '').trim();
    return (from ? `${quote} —— ${from}` : quote).slice(0, 120);
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function showHitokotoAndHold() {
  const quote = await fetchHitokoto();
  if (!quote) {
    clearTimeout(hitokotoRetry);
    hitokotoRetry = setTimeout(showHitokotoAndHold, 8000);
    return;
  }
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    typed.value = quote;
    typedFull.value = quote;
    return;
  }
  typeText(quote, { hold: true });
}

function startTyping() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    typed.value = INTRO_LINES[0];
    typedFull.value = INTRO_LINES[0];
    hitokotoRetry = setTimeout(() => {
      typed.value = INTRO_LINES[1];
      typedFull.value = INTRO_LINES[1];
      hitokotoRetry = setTimeout(showHitokotoAndHold, 1800);
    }, 1800);
    return;
  }
  typeText(INTRO_LINES[0], {
    onDone: () => {
      typeText(INTRO_LINES[1], { onDone: showHitokotoAndHold });
    },
  });
}

function scrollToFeed() {
  document.getElementById('home-feed')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadHome() {
  const [articleRes, catRes, tagRes, hotRes, commentRes] = await Promise.allSettled([
    articleApi.list({ pageSize: 8 }),
    categoryApi.list(),
    tagApi.list(),
    articleApi.list({ pageSize: 5, sort: 'hot' }),
    commentApi.recent(),
  ]);
  if (articleRes.status === 'fulfilled') {
    articles.value = articleRes.value.list;
    total.value = articleRes.value.pagination.total;
  }
  if (catRes.status === 'fulfilled') categories.value = catRes.value;
  if (tagRes.status === 'fulfilled') tags.value = tagRes.value;
  if (hotRes.status === 'fulfilled') hotArticles.value = hotRes.value.list;
  if (commentRes.status === 'fulfilled') recentComments.value = commentRes.value;
  homeError.value =
    articleRes.status === 'rejected' &&
    catRes.status === 'rejected' &&
    tagRes.status === 'rejected' &&
    hotRes.status === 'rejected';
}

function onHeroScroll() {
  const hero = heroBg.value;
  if (!hero) return;
  const y = Math.min(window.scrollY, window.innerHeight);
  hero.style.transform = `scale(1.08) translateY(${y * 0.18}px)`;
}

watch(() => site.stats.total_uv, () => runCountUps());

onMounted(async () => {
  await site.init();
  await loadHome();
  loading.value = false;
  startTyping();
  runCountUps();
  window.addEventListener('scroll', onHeroScroll, { passive: true });
});

async function retryHome() {
  homeError.value = false;
  loading.value = true;
  try {
    await site.init();
    await loadHome();
  } catch (e) {
    homeError.value = true;
  } finally {
    loading.value = false;
  }
}

onUnmounted(() => {
  stopTyping();
  clearTimeout(hitokotoRetry);
  window.removeEventListener('scroll', onHeroScroll);
});
</script>

<style scoped>
.home {
  --hero-h: 100vh;
}

.hero {
  position: relative;
  height: var(--hero-h);
  min-height: 560px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: #fff;
}

.hero-bg {
  position: absolute;
  inset: -8%;
  z-index: 0;
  background-color: #14110e;
  background-image: url('@/assets/hero.jpg');
  background-size: cover;
  background-position: center 40%;
  background-repeat: no-repeat;
  transform: scale(1.08);
}

.hero-veil {
  position: absolute;
  inset: 0;
  z-index: 1;
  background:
    linear-gradient(180deg, rgba(10, 8, 6, 0.42) 0%, rgba(10, 8, 6, 0.28) 42%, rgba(10, 8, 6, 0.62) 100%),
    radial-gradient(60% 80% at 50% 40%, rgba(0, 0, 0, 0.18), transparent 70%);
}

.hero-dots {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background-image: radial-gradient(rgba(255, 255, 255, 0.55) 1px, transparent 1px);
  background-size: 72px 72px;
  opacity: 0.18;
  animation: drift 28s linear infinite;
}

@keyframes drift {
  from { background-position: 0 0; }
  to { background-position: 0 72px; }
}

.hero-card {
  position: relative;
  z-index: 3;
  width: min(920px, calc(100% - 40px));
  padding: 42px 36px 36px;
  text-align: center;
  border-radius: 28px;
  background: rgba(8, 7, 6, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(28px) saturate(1.3);
  -webkit-backdrop-filter: blur(28px) saturate(1.3);
}

.hero-kicker {
  font-size: 0.78rem;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  opacity: 0.78;
  margin-bottom: 10px;
}

.hero-title {
  font-size: clamp(2.1rem, 5vw, 3.4rem);
  font-weight: 800;
  letter-spacing: 0.04em;
  line-height: 1.15;
}

.hero-desc {
  margin: 18px auto 0;
  min-height: 3.2em;
  max-width: 36em;
  font-size: clamp(1.02rem, 2.1vw, 1.32rem);
  font-weight: 500;
  line-height: 1.55;
  opacity: 0.94;
}

.hero-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}

.hero-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 0.92rem;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.hero-btn.primary {
  background: #fff;
  color: #1a1814;
  border-color: #fff;
}

.hero-btn.ghost {
  background: transparent;
}

.hero-btn:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.2);
}

.hero-btn.primary:hover {
  background: #f4f0ea;
}

.type-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  background: currentColor;
  vertical-align: -0.12em;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.hero-meta {
  display: flex;
  justify-content: center;
  gap: 28px;
  margin-top: 26px;
  font-size: 0.88rem;
  letter-spacing: 0.08em;
  opacity: 0.86;
}

.hero-meta b {
  font-variant-numeric: tabular-nums;
  margin-right: 6px;
}

.home-body {
  position: relative;
  z-index: 4;
  margin-top: -48px;
  padding-bottom: 80px;
}

.home-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 28px;
  align-items: start;
}

.feed-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.more-wrap {
  display: flex;
  justify-content: center;
  margin-top: 28px;
}

.more-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 22px;
  border-radius: 999px;
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-1);
  font-weight: 600;
}

.more-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.home-error,
.home-empty {
  padding: 48px 20px;
  text-align: center;
  color: var(--text-3);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.side-sticky {
  position: sticky;
  top: calc(var(--nav-h) + 18px);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.side-card {
  background: color-mix(in srgb, var(--card) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  padding: 18px 16px 14px;
  backdrop-filter: blur(16px);
}

.side-card h3 {
  font-size: 0.82rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 12px;
}

.author-card {
  text-align: center;
  padding-top: 26px;
}

.author-halo {
  width: 96px;
  height: 96px;
  margin: 0 auto 14px;
  border-radius: 50%;
  padding: 3px;
  background: conic-gradient(from 180deg, var(--accent), #ffb4a2, var(--accent));
}

.author-avatar {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  background: var(--card);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.author-card h2 {
  font-size: 1.05rem;
}

.author-card p {
  margin-top: 6px;
  color: var(--text-3);
  font-size: 0.86rem;
  line-height: 1.6;
}

.author-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin: 16px 0 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-size: 0.75rem;
  color: var(--text-3);
}

.author-stats b {
  display: block;
  color: var(--text);
  font-size: 1rem;
}

.author-links {
  display: flex;
  justify-content: center;
  gap: 8px;
  font-size: 0.82rem;
  font-weight: 600;
}

.alink {
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--bg-soft);
}

.alink:hover {
  color: #fff;
  background: var(--accent);
}

.side-row,
.hot-row,
.comment-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px;
  font-size: 0.88rem;
  color: var(--text-2);
}

.side-row:hover,
.hot-row:hover,
.comment-row:hover {
  color: var(--accent);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.grow { flex: 1; }
.muted { color: var(--text-3); font-variant-numeric: tabular-nums; }

.side-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.hot-tabs {
  display: flex;
  gap: 4px;
}

.hot-tabs button {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.72rem;
  color: var(--text-3);
}

.hot-tabs button.active {
  background: var(--accent);
  color: #fff;
}

.rank {
  width: 18px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--text-3);
}

.rank.top { color: var(--accent); }

.hot-title,
.rc-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.rc-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
}

.rc-nick {
  display: block;
  font-size: 0.75rem;
  color: var(--text-3);
}

.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag-cloud a {
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-soft);
  font-size: 0.78rem;
  color: var(--text-2);
}

.tag-cloud a:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

@media (max-width: 960px) {
  .home-grid {
    grid-template-columns: 1fr;
  }
  .sidebar {
    order: 2;
  }
  .side-sticky {
    position: static;
  }
}

@media (max-width: 640px) {
  .hero-card {
    padding: 28px 18px;
    border-radius: 20px;
  }
  .hero-meta {
    gap: 14px;
  }
  .home-body {
    margin-top: -32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-dots, .type-caret { animation: none; }
}
</style>
