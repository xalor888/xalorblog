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
            <!-- aria-pressed 让「当前选中哪个」被播报出来。
                 原来只有 .active 这个视觉类，读屏用户听到的是一串按钮，
                 不知道此刻筛的是哪个分类。 -->
            <button
              class="chip"
              :class="{ active: !activeCategory }"
              :aria-pressed="!activeCategory ? 'true' : 'false'"
              @click="selectCategory('')"
            >全部</button>
            <button
              v-for="c in categories"
              :key="c.id"
              class="chip"
              :class="{ active: activeCategory === c.slug }"
              :aria-pressed="activeCategory === c.slug ? 'true' : 'false'"
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
              :aria-pressed="!activeTag ? 'true' : 'false'"
              @click="selectTag('')"
            >全部</button>
            <button
              v-for="t in tags"
              :key="t.id"
              class="chip"
              :class="{ active: activeTag === t.slug }"
              :aria-pressed="activeTag === t.slug ? 'true' : 'false'"
              @click="selectTag(t.slug)"
            ># {{ t.name }}</button>
          </div>
        </div>

        <div class="filter-row search-row">
          <span class="filter-label">搜索</span>
          <div class="search-box">
            <XIcon name="Search" :size="16" class="search-icon" />
            <!-- 搜索框必须有自己的名字。只靠 placeholder 是不行的：
                 用户一开始输入，placeholder 就消失，这个框在读屏里
                 变成一个没有标签的「编辑框」。
                 用 role=search 包一层语义，输入框用 aria-label 定名。 -->
            <input
              v-model="keyword"
              type="search"
              class="search-input"
              placeholder="输入关键词搜索…"
              aria-label="按关键词搜索文章"
              @keyup.enter="applySearch"
            />
            <button v-if="keyword" class="search-clear" title="清空关键词" aria-label="清空关键词" @click="clearSearch">
              <XIcon name="X" :size="14" />
            </button>
            <button class="search-btn" @click="applySearch">搜索</button>
          </div>
        </div>
      </div>

      <!-- 状态播报（读屏用，视觉不可见）。
           **必须放在三条分支之外** —— 以前它嵌在 v-else 里，
           而 loading 时走的是另一个分支，于是「加载中」这段时间
           播报点根本不存在：读屏用户听不到任何动静，
           直到数据到了才知道刚才发生过一次加载。
           现在它常驻，覆盖 加载中 / 失败 / 有数据 / 空态 四种状态。
           骨架屏本身 aria-hidden（纯装饰），由这里的文字承担播报职责。 -->
      <p class="sr-only" role="status" aria-live="polite" :aria-busy="loading ? 'true' : 'false'">
        {{ resultAnnouncement }}
      </p>

      <!-- 列表 -->
      <SkeletonList v-if="loading" :count="3" class="list-loading" aria-hidden="true" />
      <template v-else-if="loadFailed">
        <!-- 网络/服务错误：明确提示并提供重试，避免误显示空状态。
             加 state-error 类是为了能和「真的没有文章」区分开 ——
             两者视觉相近，但对用户的含义完全相反（一个是「换个词」，
             一个是「检查网络」）。role=alert 让读屏在失败发生时立刻播报，
             而不是等用户自己发现结果区没东西。 -->
        <div class="empty-state state-error" role="alert">
          <div class="icon-wrap"><XIcon name="ShieldAlert" :size="30" /></div>
          <p>加载失败，可能是网络波动或服务暂时不可用</p>
          <button class="search-btn retry-btn" @click="load(page)">重试</button>
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
                <!-- 文章标题用 h2：本页 h1 是页面标题，中间没有分区标题，
                     用 h3 会造成 h1→h3 跳级（实测如此）。 -->
                <h2 class="row-title" v-html="highlight(a.title)"></h2>
                <p v-if="a.summary" class="row-summary" v-html="highlight(a.summary)"></p>
                <div class="row-tags" v-if="a.tags && a.tags.length">
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
              <div class="grid-body">
                <div class="grid-meta">
                  <span v-if="a.is_top" class="grid-pin"><XIcon name="Pin" :size="11" /> 置顶</span>
                  <span v-if="a.category_name" class="grid-cat" :style="{ '--cat': a.category_color || 'var(--accent)' }">{{ a.category_name }}</span>
                  <span v-else class="grid-cat muted">未分类</span>
                  <span class="grid-date">{{ formatDate(a.published_at) }}</span>
                </div>
                <h2 class="grid-title" v-html="highlight(a.title)"></h2>
                <p v-if="a.summary" class="grid-summary" v-html="highlight(a.summary)"></p>
                <div class="grid-foot">
                  <div class="grid-tags" v-if="a.tags && a.tags.length">
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
          <p>{{ emptyTitle }}</p>
          <p v-if="emptyHint" class="empty-hint">{{ emptyHint }}</p>
          <div class="empty-actions">
            <!-- 只要有任何筛选条件就提供「清除筛选」出口。
                 原来只判断 category/tag，**关键词搜不到时没有清除按钮** ——
                 实测搜一个不存在的词，空态里只有「随便看看」，
                 读者想退回全部文章只能自己去顶端删输入框。
                 关键词恰恰是最容易搜空的一种筛选，更需要这个出口。 -->
            <button
              v-if="hasFilter"
              class="search-btn retry-btn"
              @click="clearFilter"
            >
              <XIcon name="X" :size="14" /> 清除筛选
            </button>
            <button v-if="hasFilter" class="search-btn retry-btn" :disabled="randomLoading" @click="randomArticle">
              <XIcon name="Shuffle" :size="14" /> {{ randomLoading ? '找一篇…' : '随便看看' }}
            </button>
          </div>
        </div>
      </template>

      <!-- 分页 -->
      <nav v-if="total > pageSize" class="pagination-wrap" aria-label="文章分页">
        <button class="page-btn" :disabled="page <= 1" @click="load(page - 1)" title="上一页" aria-label="上一页">
          <XIcon name="ChevronLeft" :size="16" />
        </button>
        <template v-for="(p, i) in pageList" :key="i">
          <span v-if="p === '…'" class="page-ellipsis">…</span>
          <button
            v-else
            class="page-btn page-num"
            :class="{ current: p === page }"
            :disabled="p === page"
            :aria-current="p === page ? 'page' : undefined"
            :aria-label="p === page ? `第 ${p} 页，当前页` : `第 ${p} 页`"
            @click="load(p)"
          >{{ p }}</button>
        </template>
        <button class="page-btn" :disabled="page >= totalPages" @click="load(page + 1)" title="下一页" aria-label="下一页">
          <XIcon name="ChevronRight" :size="16" />
        </button>
        <span class="page-info">第 {{ page }} / {{ totalPages }} 页</span>

        <!-- 每页条数切换（偏好本地记忆） -->
        <label class="page-size">
          每页
          <select v-model="pageSize" class="page-size-select" title="每页条数" aria-label="每页条数" @change="onPageSizeChange">
            <option :value="8">8</option>
            <option :value="16">16</option>
            <option :value="32">32</option>
          </select>
          条
        </label>
      </nav>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, watchEffect, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import SkeletonList from '@/components/ui/SkeletonList.vue';
import { applyPageMeta } from '@/utils/pageMeta';
import { highlightKeyword } from '@/utils/highlight';
import { articleApi, categoryApi, tagApi } from '@/api';
import { formatDate, formatNumber } from '@/utils/format';
import { useSiteStore } from '@/stores/site';

const route = useRoute();
const router = useRouter();
const site = useSiteStore();

const articles = ref([]);
const categories = ref([]);
const tags = ref([]);
const total = ref(0);
// 页码：初值只给 1，真实值在 onMounted 里从 route 读取。
// 为什么不在模块顶层读 route.query —— 实测这里拿到的是 undefined：
// 组件 setup 执行时 hash 路由的 query 还没解析完（日志见 onMounted:init 里
// route.query.page 为 "undefined"），于是带 ?page=2 的分享链接永远停在第一页。
const page = ref(1);
// 空态文案区分：有筛选 → 无匹配；无筛选 → 全站尚无文章
const hasFilter = computed(() => !!(route.query.keyword || route.query.category || route.query.tag));
// 每页条数：URL 参数优先（分享保持），其次本地记忆（8/16/32）
// 每页条数：URL 参数优先（分享保持），其次本地记忆（8/16/32）。
// 与 page 同理，初值不读 route（时序不可靠），统一在 onMounted 里校正。
const pageSize = ref((() => {
  try {
    const saved = Number(localStorage.getItem('xalor_page_size'));
    return [8, 16, 32].includes(saved) ? saved : 8;
  } catch (e) { return 8; }
})());
// 程序化校正 pageSize 时不允许走 onPageSizeChange（它会重置页码并清 URL 的 page）
let suppressPageSizeChange = false;
function onPageSizeChange() {
  if (suppressPageSizeChange) return;
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

/**
 * 空态文案：必须说清「是哪一层筛选把结果筛没了」，否则读者会去改一个
 * 根本不存在的输入框。
 *
 * 原来的实现只有一句「没有找到相关文章，换个关键词试试？」——
 * 但按分类或标签筛选时页面上根本没有关键词框，这句话会把读者引到错误的方向。
 * 现在按筛选类型分三种：关键词 / 分类 / 标签，各自给对应的事实。
 */
const emptyTitle = computed(() => {
  if (!hasFilter.value) return '还没有发布文章，敬请期待';
  /**
   * 空态必须说清**当前全部生效的筛选**。
   *
   * 筛选现在可以叠加（分类 + 标签 + 关键词），
   * 而原实现是三个互斥的 if 依次 return ——
   * 只要有分类，就永远轮不到标签那一句。
   * 实测 `?category=tech&tag=旅行` 为 0 篇时，页面只说
   * 「分类「技术笔记」下还没有文章」，
   * **读者会以为只有分类在生效**，不知道标签也在筛，
   * 更不知道「清除筛选」会一次清掉两个条件。
   */
  const parts = [];
  if (kw.value) parts.push(`「${kw.value}」`);
  if (activeCategory.value) {
    const c = categories.value.find((x) => x.slug === activeCategory.value);
    parts.push(c ? `分类「${c.name}」` : '该分类');
  }
  if (activeTag.value) {
    const t = tags.value.find((x) => x.slug === activeTag.value);
    parts.push(t ? `标签「${t.name}」` : '该标签');
  }
  if (!parts.length) return '没有找到相关文章';
  if (parts.length === 1) {
    // 单一条件沿用原来的自然说法（关键词那条本来就是这样）
    if (kw.value) return `没有匹配${parts[0]}的文章`;
    return `${parts[0]}下还没有文章`;
  }
  return `同时满足 ${parts.join(' + ')} 的文章还没有`;
});

const emptyHint = computed(() => {
  if (!hasFilter.value) return '';
  if (kw.value) return '换个关键词，或者清除筛选看看全部文章';
  return '可以清除筛选，或者随便看看其他文章';
});

/** 一次性清掉全部筛选（保留排序与每页条数这类偏好） */
function clearFilter() {
  const q = { ...route.query };
  delete q.keyword;
  delete q.category;
  delete q.tag;
  delete q.page;
  router.push({ path: '/articles', query: q });
}

/** 当前分类的描述（有筛选且该分类存在描述时展示） */
const activeCategoryDesc = computed(() => {
  if (!activeCategory.value) return '';
  const c = categories.value.find((x) => x.slug === activeCategory.value);
  return c && c.description ? String(c.description).trim() : '';
});

// 视图模式：列表 / 卡片（localStorage 记忆偏好，刷新与下次访问保持）
const viewMode = ref((() => {
  try { return localStorage.getItem('xl_view_mode') || 'grid'; } catch (e) { return 'grid'; }
})());
function setViewMode(m) {
  viewMode.value = m;
  try {
    localStorage.setItem('xl_view_mode', m);
  } catch (e) { /* 隐私模式忽略 */ }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

/**
 * 结果播报（给读屏用，视觉上不可见）。
 *
 * 为什么需要：翻页、切排序、换筛选都是**局部刷新** —— URL 变了但页面不跳转，
 * 标题不变，焦点也没有移动。读屏用户按「下一页」之后，听到的只是按钮被点击，
 * 内容换了这件事完全没有声音。
 *
 * 文案只报「多少条 / 第几页」，不报具体标题 —— 否则读屏会把整页标题念一遍。
 */
const resultAnnouncement = computed(() => {
  if (loading.value) return '正在加载文章…';
  if (loadFailed.value) return '加载失败';
  if (!total.value) return emptyTitle.value;
  const from = (page.value - 1) * pageSize.value + 1;
  const to = Math.min(page.value * pageSize.value, total.value);
  return `共 ${total.value} 篇文章，当前显示第 ${from}–${to} 篇，第 ${page.value} / ${totalPages.value} 页`;
});


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

/**
 * 分类与标签**可以叠加**，不要互相清空。
 *
 * 原来这两个函数会主动 `delete` 掉对方：
 *   选「技术笔记」→ 3 篇；再点「# Node.js」→ 分类被删掉，退回标签单独筛选。
 * 但**服务端本来就同时支持两者**（articles.js 分别读 category 与 tag，
 * 两个条件都在 where 里）。实测直接访问 `?category=tech&tag=node.js`
 * 返回正确的 2 篇，两个 chip 也都正确激活 ——
 * **能力一直在，只是被前端点击行为挡掉了。**
 *
 * 现在只改自己那一维，另一维保留；页码与搜索词仍然重置
 * （换筛选回到第 1 页是合理的）。
 */
function selectCategory(slug) {
  const q = { ...route.query };
  if (slug) q.category = slug; else delete q.category;
  delete q.page;
  router.push({ path: '/articles', query: q });
}

function selectTag(slug) {
  const q = { ...route.query };
  if (slug) q.tag = slug; else delete q.tag;
  delete q.page;
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
    if (p > 1) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
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

/**
 * 搜索关键词高亮。走共用实现（见 @/utils/highlight）——
 * 原先这里自带一份逐字复制的版本，和搜索弹层那份**带着同一个缺陷**：
 * 转义跑在匹配之前，导致搜 `A & B` 命中文章却零高亮。两处现在统一。
 */
function highlight(text = '') {
  return highlightKeyword(text, kw.value);
}

/**
 * 筛选条件指纹（稳定字符串）。
 *
 * ⚠ 这里**不能**写成 `() => [a, b, c, d]`：getter 每次运行都会返回一个新数组，
 * 而 Vue 对 getter 的返回值是按引用比较的（Object.is），新数组永远"不等于"旧数组
 * —— 结果就是**只要 route.query 有任何变化（包括翻页写入 ?page=2）watcher 就会触发**，
 * 然后执行 page.value = 1; load(1)，把刚翻过去的页码冲回第一页。
 *
 * 这正解释了「点下一页没反应」「分享链接带 ?page=2 却停在第 1 页」：
 * 翻页 → replace 写入 page=2 → 该 watcher 误触发 → load(1) → replace 删掉 page。
 *
 * 用一个字符串把四个值拼起来，值没变时字符串就不变，watcher 不会触发。
 */
const filterKey = computed(() =>
  [route.query.category || '', route.query.tag || '', route.query.keyword || '', route.query.sort || 'latest'].join('\u0000')
);

watch(filterKey, () => {
  page.value = 1;
  keyword.value = kw.value; // 前进/后退改变 ?keyword= 时搜索框同步（否则显示旧关键词）
  load(1);
  window.scrollTo({ top: 0 });
});

// 浏览器标签页标题与当前筛选联动。
// 统一走 applyPageMeta：原来这里只补了 description，
// 没有 canonical / og:url，og:image 还是 HTML 里硬编码的相对路径
// （社交平台要求绝对 URL，相对路径会被忽略 → 分享卡片没图）。
watchEffect(() => {
  const siteName = site.settings.site_name || 'Xalor的小站';
  document.title = `${pageTitle.value} · ${siteName}`;
  // canonical 与 og:url 要带上当前筛选，否则「搜 mysql」和「全部文章」
  // 会指向同一个规范地址，重复内容
  const q = route.query;
  const params = new URLSearchParams();
  for (const k of ['keyword', 'tag', 'category', 'page', 'pageSize', 'sort']) {
    if (q[k]) params.set(k, String(q[k]));
  }
  const qs = params.toString();
  applyPageMeta({
    title: pageTitle.value,
    description: `浏览${pageTitle.value}——按分类、标签或关键词筛选的博客文章列表`,
    path: '/articles' + (qs ? `?${qs}` : ''),
    site,
  });
});

/**
 * 列表滚动位置：**由路由的 scrollBehavior 统一负责，不要在这里再实现一套**。
 *
 * 这段是我最初写的版本，实测无效 —— 原因值得记下来：
 * `router.factory.js` 里的 `scrollBehavior` 返回 `savedPosition`（浏览器前进/后退时
 * Vue Router 会给出），**它在组件挂载之后执行**，会把组件里刚恢复的位置覆盖回 0。
 * 也就是说：谁最后跑谁说了算，而我抢不过路由。
 *
 * 上一轮给文章页做的 `xalor_readpos_` 是另一回事 ——
 * 那是**同一路由的重新进入**（离开站点或刷新），scrollBehavior 拿不到 savedPosition，
 * 两者不冲突。
 */

onMounted(async () => {
  // allSettled：分类/标签侧栏接口任一失败都不能拖死文章列表本体
  //（Promise.all 一处 reject 则 load(1) 永不执行，页面停在骨架屏且无提示）
  const [cats, tg] = await Promise.allSettled([categoryApi.list(), tagApi.list()]);
  categories.value = cats.status === 'fulfilled' && Array.isArray(cats.value) ? cats.value : [];
  tags.value = tg.status === 'fulfilled' && Array.isArray(tg.value) ? tg.value : [];
  keyword.value = kw.value;
  // 初始页码必须取 URL 里的 page —— 否则带 ?page=2 的分享链接永远停在第一页。
  // （page ref 在文件顶部已从 route.query 读过，但这里曾经硬编码 load(1) 把它覆盖；
  //  同时也解释了「点下一页没反应」：watch 里任何筛选变化都会 load(1)，
  //  而分页按钮依赖 route.replace 之后的稳定状态。）
  // 到这里路由的 query 才是可靠的：先用 URL 校正页码与每页条数。
  //
  // ⚠ 校正 pageSize 时必须**绕过 @change**：v-model 绑定会触发 change，
  // 而 onPageSizeChange() 里有 router.replace（删掉 page）与 load(1)。
  // 直接赋值会让「带 ?page=2 的分享链接」在挂载瞬间被重置回第一页 ——
  // 这就是「点下一页没反应 / 分享链接永远回第 1 页」的真正原因。
  // 用 suppressPageSizeChange 标记把校正与用户操作区分开。
  const urlSize = Number(route.query.pageSize);
  if ([8, 16, 32].includes(urlSize) && urlSize !== pageSize.value) {
    suppressPageSizeChange = true;
    pageSize.value = urlSize;
    suppressPageSizeChange = false;
  }
  const urlPage = Number(route.query.page);
  page.value = Number.isFinite(urlPage) && urlPage > 0 ? Math.floor(urlPage) : 1;
  await load(page.value);
  // 把 URL 与真实页码对齐（后端可能把越界页码纠正到最后一页）
  if (page.value !== (Number(route.query.page) || 1)) {
    const q = { ...route.query };
    if (page.value > 1) q.page = String(page.value);
    else delete q.page;
    router.replace({ path: '/articles', query: q });
  }
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
  color: var(--accent-text);
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
  color: var(--accent-text);
}

.sort-btn.active {
  background: var(--accent-fill);
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
  color: var(--accent-text);
}

.view-btn.active {
  background: var(--card);
  color: var(--accent-text);
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
  color: var(--accent-text);
}

.chip.active {
  background: var(--text);
  border-color: var(--text);
  color: var(--bg);
  font-weight: 600;
}

[data-theme='dark'] .chip.active {
  background: var(--accent-fill);
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
  background: transparent;
  color: var(--text);
  font-size: 0.9rem;
  padding: 9px 0;
  min-width: 0;
}

/* 输入框本身不画环：它外面套了一层胶囊 .search-box，
   环画在内层会被胶囊裁掉。焦点指示交给 .search-box:focus-within（见 main.css）。
   这里显式写 :focus-visible 的 outline:none，是为了让静态检查能识别
   「这是有意把环挪给父容器」，而不是漏掉了。 */
.search-input:focus-visible {
  outline: none;
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
  background: var(--accent-fill);
  color: #fff;
}

.search-btn {
  padding: 6px 16px;
  border-radius: 6px;
  background: var(--accent-fill);
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
  color: var(--accent-text);
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
  background: color-mix(in srgb, var(--cat) 7%, transparent);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  background: color-mix(in srgb, var(--cat, var(--accent)) 7%, transparent);
}

/* 置顶徽章（卡片视图） */
.grid-pin {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.76rem;
  font-weight: 600;
  /* 固定色（不跟分类走）：「置顶」在所有卡片上都是绛红。
     原 #c24b5e 压在 10% 绛红淡底上只有 4.01:1，提到 #9e3548 → 5.28:1。 */
  color: #9e3548;
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  background: var(--accent-fill);
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
  transition: border-color var(--dur) var(--ease);
}

.page-size-select:focus {
  border-color: var(--accent);
}

/* 键盘聚焦时必须有可见环：只靠 border-color 变化，小控件上几乎看不出 */
.page-size-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
