<template>
  <div class="article-list">
    <div class="container narrow">
      <!-- 页头 -->
      <div class="page-head fade-up">
        <p class="eyebrow">{{ eyebrow }}</p>
        <h1>{{ pageTitle }}</h1>
        <p class="lead">共 {{ total }} 篇文章</p>
        <!-- 分类描述（增强归档页语义 + SEO 描述来源） -->
        <p v-if="activeCategoryDesc" class="cat-desc">{{ activeCategoryDesc }}</p>
      </div>

      <!-- 筛选栏 -->
      <div class="filter-bar">
        <div class="filter-row sort-row">
          <span class="filter-label">排序</span>
          <div class="sort-group">
            <button
              class="sort-btn"
              :class="{ active: sort === 'latest' }"
              :aria-pressed="sort === 'latest'"
              @click="setSort('latest')"
            >
              <XIcon name="Clock3" :size="14" /> 最新
            </button>
            <button
              class="sort-btn"
              :class="{ active: sort === 'hot' }"
              :aria-pressed="sort === 'hot'"
              @click="setSort('hot')"
            >
              <XIcon name="Flame" :size="14" /> 最热
            </button>
            <button
              class="sort-btn"
              :class="{ active: sort === 'commented' }"
              :aria-pressed="sort === 'commented'"
              @click="setSort('commented')"
            >
              <XIcon name="MessageSquare" :size="14" /> 热议
            </button>
          </div>
          <!-- 视图切换：列表 / 卡片（偏好本地记忆） -->
          <div class="view-toggle" role="group" aria-label="视图切换">
            <button
              class="view-btn"
              :class="{ active: viewMode === 'list' }"
              title="列表视图"
              :aria-pressed="viewMode === 'list'"
              @click="setViewMode('list')"
            >
              <XIcon name="List" :size="15" />
            </button>
            <button
              class="view-btn"
              :class="{ active: viewMode === 'grid' }"
              title="卡片视图"
              :aria-pressed="viewMode === 'grid'"
              @click="setViewMode('grid')"
            >
              <XIcon name="LayoutDashboard" :size="15" />
            </button>
          </div>
        </div>

        <div class="filter-row">
          <span class="filter-label">分类</span>
          <div class="chips">
            <button
              class="chip"
              :class="{ active: !activeCategory }"
              @click="selectCategory('')"
            >全部</button>
            <button
              v-for="c in categories"
              :key="c.id"
              class="chip"
              :class="{ active: activeCategory === c.slug }"
              @click="selectCategory(c.slug)"
            >
              {{ c.name }}<span class="chip-count">{{ c.article_count }}</span>
            </button>
          </div>
        </div>

        <div class="filter-row">
          <span class="filter-label">标签</span>
          <div class="chips">
            <button
              class="chip"
              :class="{ active: !activeTag }"
              @click="selectTag('')"
            >全部</button>
            <button
              v-for="t in tags"
              :key="t.id"
              class="chip"
              :class="{ active: activeTag === t.slug }"
              @click="selectTag(t.slug)"
            ># {{ t.name }}</button>
          </div>
        </div>

        <div class="filter-row search-row">
          <span class="filter-label">搜索</span>
          <div class="search-box">
            <XIcon name="Search" :size="16" class="search-icon" />
            <input
              v-model="keyword"
              class="search-input"
              placeholder="输入关键词搜索…"
              @keyup.enter="applySearch"
            />
            <button v-if="keyword" class="search-clear" title="清空关键词" @click="clearSearch">
              <XIcon name="X" :size="14" />
            </button>
            <button class="search-btn" @click="applySearch">搜索</button>
          </div>
        </div>
      </div>

      <!-- 列表 -->
      <SkeletonList v-if="loading" :count="3" class="list-loading" />
      <template v-else-if="loadFailed">
        <!-- 网络/服务错误：明确提示并提供重试，避免误显示空状态 -->
        <div class="empty-state">
          <div class="icon-wrap"><XIcon name="ShieldAlert" :size="30" /></div>
          <p>加载失败，可能是网络波动或服务暂时不可用</p>
          <button class="search-btn retry-btn" @click="load(1)">重试</button>
        </div>
      </template>
      <template v-else>
        <div v-if="articles.length" class="list" :class="viewMode" v-reveal="'stagger'">
          <!-- 列表视图：紧凑行式 -->
          <template v-if="viewMode === 'list'">
            <router-link
              v-for="(a, idx) in articles"
              :key="a.id"
              :to="`/article/${a.slug}`"
              class="row-item"
            >
              <span class="row-index num">{{ String((page - 1) * pageSize + idx + 1).padStart(2, '0') }}</span>
              <div class="row-main">
                <div class="row-meta">
                  <span v-if="a.is_top" class="row-pin"><XIcon name="Pin" :size="11" /> 置顶</span>
                  <span v-if="a.category_name" class="row-cat" :style="{ '--cat': a.category_color || 'var(--accent)' }">{{ a.category_name }}</span>
                  <span v-else class="row-cat muted">未分类</span>
                  <span class="row-date">{{ formatDate(a.published_at) }}</span>
                </div>
                <h3 class="row-title" v-html="highlight(a.title)"></h3>
                <p v-if="a.summary" class="row-summary" v-html="highlight(a.summary)"></p>
                <div class="row-tags" v-if="a.tags.length">
                  <span v-for="t in a.tags.slice(0, 3)" :key="t.id" class="row-tag"># {{ t.name }}</span>
                </div>
              </div>
              <div class="row-side">
                <span class="row-views"><XIcon name="MessageSquare" :size="14" /> {{ a.comment_count }}</span>
                <span class="row-views"><XIcon name="Eye" :size="14" /> {{ formatNumber(a.views) }}</span>
                <span class="row-arrow"><XIcon name="ArrowRight" :size="17" /></span>
              </div>
            </router-link>
          </template>

          <!-- 卡片视图：封面网格 -->
          <template v-else>
            <router-link
              v-for="(a, idx) in articles"
              :key="a.id"
              :to="`/article/${a.slug}`"
              class="grid-item"
            >
              <div
                v-if="a.cover"
                class="grid-cover"
                :style="{ backgroundImage: `url(${a.cover})` }"
                :aria-label="a.title"
              ></div>
              <div v-else class="grid-cover grid-cover-empty">
                <XIcon name="ImageOff" :size="24" />
              </div>
              <div class="grid-body">
                <div class="grid-meta">
                  <span v-if="a.is_top" class="grid-pin"><XIcon name="Pin" :size="11" /> 置顶</span>
                  <span v-if="a.category_name" class="grid-cat" :style="{ '--cat': a.category_color || 'var(--accent)' }">{{ a.category_name }}</span>
                  <span v-else class="grid-cat muted">未分类</span>
                  <span class="grid-date">{{ formatDate(a.published_at) }}</span>
                </div>
                <h3 class="grid-title" v-html="highlight(a.title)"></h3>
                <p v-if="a.summary" class="grid-summary" v-html="highlight(a.summary)"></p>
                <div class="grid-foot">
                  <div class="grid-tags" v-if="a.tags.length">
                    <span v-for="t in a.tags.slice(0, 3)" :key="t.id" class="grid-tag"># {{ t.name }}</span>
                  </div>
                  <div class="grid-stats">
                    <span class="grid-views"><XIcon name="MessageSquare" :size="13" /> {{ a.comment_count }}</span>
                    <span class="grid-views"><XIcon name="Eye" :size="13" /> {{ formatNumber(a.views) }}</span>
                  </div>
                </div>
              </div>
            </router-link>
          </template>
        </div>
        <div v-else class="empty-state">
          <div class="icon-wrap"><XIcon name="FileSearch" :size="30" /></div>
          <p>{{ hasFilter ? '没有找到相关文章，换个关键词试试？' : '还没有发布文章，敬请期待' }}</p>
          <button v-if="hasFilter" class="search-btn retry-btn" :disabled="randomLoading" @click="randomArticle">
            <XIcon name="Shuffle" :size="14" /> {{ randomLoading ? '找一篇…' : '随便看看' }}
          </button>
        </div>
      </template>

      <!-- 分页 -->
      <div v-if="total > pageSize" class="pagination-wrap">
        <button class="page-btn" :disabled="page <= 1" @click="load(page - 1)" title="上一页">
          <XIcon name="ChevronLeft" :size="16" />
        </button>
        <template v-for="(p, i) in pageList" :key="i">
          <span v-if="p === '…'" class="page-ellipsis">…</span>
          <button
            v-else
            class="page-btn page-num"
            :class="{ current: p === page }"
            :disabled="p === page"
            @click="load(p)"
          >{{ p }}</button>
        </template>
        <button class="page-btn" :disabled="page >= totalPages" @click="load(page + 1)" title="下一页">
          <XIcon name="ChevronRight" :size="16" />
        </button>
        <span class="page-info">{{ page }} / {{ totalPages }}</span>

        <!-- 每页条数切换（偏好本地记忆） -->
        <span class="page-size">
          每页
          <select v-model="pageSize" class="page-size-select" title="每页条数" @change="onPageSizeChange">
            <option :value="8">8</option>
            <option :value="16">16</option>
            <option :value="32">32</option>
          </select>
          条
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import SkeletonList from '@/components/ui/SkeletonList.vue';
import { articleApi, categoryApi, tagApi } from '@/api';
import { formatDate, formatNumber } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const articles = ref([]);
const categories = ref([]);
const tags = ref([]);
const total = ref(0);
const page = ref(Number(route.query.page) || 1); // 页码随 URL 持久化（刷新/分享保持）
// 空态文案区分：有筛选 → 无匹配；无筛选 → 全站尚无文章
const hasFilter = computed(() => !!(route.query.keyword || route.query.category || route.query.tag));
// 每页条数：URL 参数优先（分享保持），其次本地记忆（8/16/32）
const urlSize = Number(route.query.pageSize);
const pageSize = ref([8, 16, 32].includes(urlSize) ? urlSize : Number(localStorage.getItem('xalor_page_size')) || 8);
if (![8, 16, 32].includes(pageSize.value)) pageSize.value = 8;
function onPageSizeChange() {
  try {
    localStorage.setItem('xalor_page_size', String(pageSize.value));
  } catch (e) { /* 隐私模式忽略 */ }
  const q = { ...route.query, page: undefined };
  delete q.page;
  if (pageSize.value !== 8) q.pageSize = String(pageSize.value);
  else delete q.pageSize;
  router.replace({ path: '/articles', query: q });
  load(1);
}
const keyword = ref('');
const loading = ref(true);
const loadFailed = ref(false);

const activeCategory = computed(() => route.query.category || '');
const activeTag = computed(() => route.query.tag || '');
const kw = computed(() => route.query.keyword || '');
const sort = computed(() => route.query.sort || 'latest');

/** 当前分类的描述（有筛选且该分类存在描述时展示） */
const activeCategoryDesc = computed(() => {
  if (!activeCategory.value) return '';
  const c = categories.value.find((x) => x.slug === activeCategory.value);
  return c && c.description ? String(c.description).trim() : '';
});

// 视图模式：列表 / 卡片（localStorage 记忆偏好，刷新与下次访问保持）
const viewMode = ref(localStorage.getItem('xl_view_mode') || 'grid');
function setViewMode(m) {
  viewMode.value = m;
  localStorage.setItem('xl_view_mode', m);
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// 数字页码（两端 + 当前页前后各一页，中间省略号）
const pageList = computed(() => {
  const t = totalPages.value;
  const c = page.value;
  if (t <= 7) return Array.from({ length: t }, (_, i) => i + 1);
  const pages = [1];
  if (c > 3) pages.push('…');
  for (let p = Math.max(2, c - 1); p <= Math.min(t - 1, c + 1); p++) pages.push(p);
  if (c < t - 2) pages.push('…');
  pages.push(t);
  return pages;
});

const pageTitle = computed(() => {
  if (activeTag.value) {
    const t = tags.value.find((x) => x.slug === activeTag.value);
    return t ? `# ${t.name}` : '标签归档';
  }
  if (activeCategory.value) {
    const c = categories.value.find((x) => x.slug === activeCategory.value);
    return c ? c.name : '分类归档';
  }
  return kw.value ? `搜索：${kw.value}` : '全部文章';
});

const eyebrow = computed(() => {
  if (activeTag.value) return 'TAG';
  if (activeCategory.value) return 'CATEGORY';
  if (kw.value) return 'SEARCH';
  return 'ARCHIVES';
});

function selectCategory(slug) {
  const q = { ...route.query };
  if (slug) q.category = slug; else delete q.category;
  delete q.tag; delete q.keyword; delete q.page; // 筛选变化重置到第 1 页
  keyword.value = '';
  router.push({ path: '/articles', query: q });
}

function selectTag(slug) {
  const q = { ...route.query };
  if (slug) q.tag = slug; else delete q.tag;
  delete q.category; delete q.keyword; delete q.page;
  keyword.value = '';
  router.push({ path: '/articles', query: q });
}

function applySearch() {
  const q = { ...route.query };
  if (keyword.value.trim()) q.keyword = keyword.value.trim();
  else delete q.keyword;
  delete q.category; delete q.tag; delete q.page;
  router.push({ path: '/articles', query: q });
}

/** 清空关键词并重置搜索 */
function clearSearch() {
  keyword.value = '';
  applySearch();
}

function setSort(s) {
  const q = { ...route.query };
  if (s && s !== 'latest') q.sort = s;
  else delete q.sort;
  delete q.page; // 排序变化也重置页码（结果集顺序变了，旧页码无意义）
  router.push({ path: '/articles', query: q });
}

async function load(p = 1) {
  loading.value = true;
  loadFailed.value = false;
  try {
    const res = await articleApi.list({
      page: p,
      pageSize: pageSize.value,
      category: activeCategory.value || undefined,
      tag: activeTag.value || undefined,
      keyword: kw.value || undefined,
      sort: sort.value,
    });
    articles.value = res.list;
    total.value = res.pagination.total;
    page.value = p;
    // 页码写入 URL（replace 防历史栈膨胀；category/tag/keyword 变化由 watch 统一重置）
    const q = { ...route.query, page: p > 1 ? String(p) : undefined };
    if (!q.page) delete q.page;
    router.replace({ path: '/articles', query: q });
  } catch (e) {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

/** 空态「随便看看」：随机跳一篇已发布文章（有筛选无结果时快速离开死胡同） */
const randomLoading = ref(false);
async function randomArticle() {
  if (randomLoading.value) return;
  randomLoading.value = true;
  try {
    const r = await articleApi.random();
    if (r && r.slug) {
      router.push(`/article/${r.slug}`);
      return;
    }
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    randomLoading.value = false;
  }
}

/** 搜索关键词高亮（已由后端返回纯文本，安全转义后高亮） */
function highlight(text = '') {
  const safe = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const k = kw.value.trim();
  if (!k) return safe;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

watch(
  () => [route.query.category, route.query.tag, route.query.keyword, route.query.sort],
  () => {
    page.value = 1;
    load(1);
    window.scrollTo({ top: 0 });
  }
);

// 浏览器标签页标题与当前筛选联动
watchEffect(() => {
  document.title = pageTitle.value;
  // meta description 同步（浏览器/分享预览语义化）
  const desc = `浏览${pageTitle.value}——按分类、标签或关键词筛选的博客文章列表`;
  let el = document.querySelector('meta[name="description"]');
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('name', 'description');
    document.head.appendChild(el);
  }
  el.setAttribute('content', desc);
});

onMounted(async () => {
  const [cats, tg] = await Promise.all([categoryApi.list(), tagApi.list()]);
  categories.value = cats;
  tags.value = tg;
  keyword.value = kw.value;
  await load(1);
});
</script>

<style scoped>
.article-list {
  padding-bottom: 48px;
}

.narrow {
  max-width: 1080px;
}

.page-head .eyebrow {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--accent);
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* 分类描述 */
.cat-desc {
  margin-top: 10px;
  color: var(--text-2);
  font-size: 0.92rem;
  line-height: 1.7;
  max-width: 560px;
}

/* 筛选栏 */
.filter-bar {
  background: color-mix(in srgb, var(--card) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 8px 24px;
  margin-bottom: 30px;
  box-shadow: var(--shadow-1);
  backdrop-filter: blur(12px);
}

.filter-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 13px 0;
}

.filter-row + .filter-row {
  border-top: 1px dashed var(--border);
}

.filter-label {
  flex-shrink: 0;
  width: 38px;
  font-size: 0.82rem;
  color: var(--text-3);
  padding-top: 4px;
}

/* 排序切换 */
.sort-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 0.86rem;
  transition: all var(--dur) var(--ease);
}

.sort-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.sort-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}

/* 视图切换（列表/卡片） */
.view-toggle {
  display: flex;
  gap: 4px;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-soft);
}

.view-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}

.view-btn:hover {
  color: var(--accent);
}

.view-btn.active {
  background: var(--card);
  color: var(--accent);
  box-shadow: var(--shadow-1);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 4px 13px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 0.86rem;
  transition: all var(--dur) var(--ease);
}

.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.chip.active {
  background: var(--text);
  border-color: var(--text);
  color: var(--bg);
  font-weight: 600;
}

[data-theme='dark'] .chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.chip-count {
  font-size: 0.72rem;
  opacity: 0.6;
  margin-left: 4px;
}

/* 搜索 */
.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 440px;
  background: var(--bg-soft);
  border-radius: 8px;
  padding: 0 6px 0 12px;
  border: 1px solid transparent;
  transition: border-color var(--dur) var(--ease);
}

.search-box:focus-within {
  border-color: var(--accent);
  background: var(--card);
}

.search-icon {
  color: var(--text-3);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 0.9rem;
  padding: 9px 0;
  min-width: 0;
}

/* 关键词清除按钮 */
.search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: var(--border);
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--dur) var(--ease);
}

.search-clear:hover {
  background: var(--accent);
  color: #fff;
}

.search-btn {
  padding: 6px 16px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 0.86rem;
  font-weight: 600;
  flex-shrink: 0;
  transition: opacity var(--dur) var(--ease);
}

.search-btn:hover {
  opacity: 0.85;
}

/* 加载失败重试 / 空态动作按钮 */
.retry-btn {
  margin-top: 16px;
  padding: 8px 28px;
}

.retry-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 列表：竖向行卡片 */
.list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.list-loading {
  grid-template-columns: 1fr;
}

.row-item {
  display: flex;
  gap: 20px;
  padding: 22px 26px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease);
}

.row-index {
  flex-shrink: 0;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--text-3);
  opacity: 0.5;
  line-height: 1.5;
  transition: color var(--dur) var(--ease), opacity var(--dur) var(--ease);
  font-variant-numeric: tabular-nums;
}

.row-item:hover .row-index {
  color: var(--accent);
  opacity: 1;
}

.row-item:hover {
  border-color: var(--line);
  box-shadow: var(--shadow-2);
  transform: translateY(-2px);
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.row-cat {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cat);
  padding: 2px 9px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--cat) 10%, transparent);
}

.row-cat.muted {
  color: var(--text-3);
  background: none;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
  padding: 0;
}

/* 置顶徽章（行视图） */
.row-pin {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.72rem;
  font-weight: 700;
  color: #c24b5e;
  padding: 2px 9px;
  border-radius: 5px;
  background: color-mix(in srgb, #c24b5e 12%, transparent);
}

.row-date {
  font-size: 0.8rem;
  color: var(--text-3);
}

.row-title {
  font-size: 1.14rem;
  font-weight: 750;
  letter-spacing: -0.01em;
  line-height: 1.5;
  margin-bottom: 6px;
  transition: color var(--dur) var(--ease);
}

.row-item:hover .row-title {
  color: var(--accent);
}

.row-title :deep(mark),
.row-summary :deep(mark) {
  background: var(--accent-soft);
  color: var(--accent-deep);
  padding: 0 2px;
  border-radius: 3px;
}

.row-summary {
  color: var(--text-2);
  font-size: 0.9rem;
  line-height: 1.75;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.row-tags {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.row-tag {
  font-size: 0.76rem;
  color: var(--text-3);
}

.row-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  flex-shrink: 0;
}

.row-views {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.row-arrow {
  color: var(--text-3);
  transition: transform var(--dur) var(--ease), color var(--dur) var(--ease);
}

.row-item:hover .row-arrow {
  transform: translateX(3px);
  color: var(--accent);
}

/* ============ 卡片视图 ============ */
.list.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
  gap: 22px;
}

.grid-item {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease);
}

.grid-item:hover {
  transform: translateY(-3px);
  border-color: var(--accent);
  box-shadow: var(--shadow-2);
}

.grid-cover {
  height: 188px;
  flex-shrink: 0;
  background-size: cover;
  background-position: center;
  background-color: var(--bg-soft);
  transition: transform 0.4s var(--ease);
}

.grid-item:hover .grid-cover {
  transform: scale(1.04);
}

.grid-cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  opacity: 0.6;
}

.grid-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  padding: 16px 18px 18px;
}

.grid-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.grid-cat {
  font-size: 0.76rem;
  font-weight: 600;
  color: var(--cat, var(--accent));
  padding: 2px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--cat, var(--accent)) 12%, transparent);
}

/* 置顶徽章（卡片视图） */
.grid-pin {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.76rem;
  font-weight: 600;
  color: #c24b5e;
  padding: 2px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, #c24b5e 12%, transparent);
}

.grid-date {
  font-size: 0.76rem;
  color: var(--text-3);
}

.grid-title {
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  transition: color var(--dur) var(--ease);
}

.grid-item:hover .grid-title {
  color: var(--accent);
}

.grid-summary {
  margin-top: 8px;
  color: var(--text-2);
  font-size: 0.86rem;
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.grid-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  padding-top: 12px;
}

.grid-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.grid-tag {
  font-size: 0.74rem;
  color: var(--text-3);
  white-space: nowrap;
}

.grid-views {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.76rem;
  color: var(--text-3);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.grid-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 40px;
}

.page-btn {
  width: 38px;
  height: 38px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
}

.page-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 数字页码 */
.page-num {
  width: auto;
  min-width: 38px;
  padding: 0 6px;
  font-size: 0.9rem;
  font-weight: 600;
}

.page-num.current {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  cursor: default;
}

.page-ellipsis {
  color: var(--text-3);
  font-size: 0.9rem;
  padding: 0 2px;
  user-select: none;
}

.page-info {
  font-size: 0.9rem;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

/* 每页条数切换 */
.page-size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--text-3);
}

.page-size-select {
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
  font-size: 0.82rem;
  cursor: pointer;
  outline: none;
  transition: border-color var(--dur) var(--ease);
}

.page-size-select:focus {
  border-color: var(--accent);
}

@media (max-width: 640px) {
  .filter-bar {
    padding: 6px 16px;
  }
  .filter-row {
    flex-direction: column;
    gap: 8px;
  }
  .view-toggle {
    margin-left: 0;
  }
  .row-item {
    padding: 18px;
    gap: 12px;
  }
  .row-side {
    display: none;
  }
}
</style>
