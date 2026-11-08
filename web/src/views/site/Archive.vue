<template>
  <div class="archive-page">
    <div class="container narrow">
      <div class="page-head fade-up">
        <p class="eyebrow">ARCHIVE</p>
        <h1>归档</h1>
        <p class="lead">共 {{ totalArticles }} 篇文章，时间在这里沉淀</p>
      </div>

      <!-- 年份快捷导航（点击平滑滚动到对应年份） -->
      <nav v-if="yearGroups.length > 3" class="year-nav fade-up" aria-label="年份导航">
        <button
          v-for="yg in yearGroups"
          :key="yg.year"
          class="year-chip"
          @click="scrollToYear(yg.year)"
        >
          {{ yg.year }}
        </button>
      </nav>

      <!-- 空态：`yearGroups` 为空时原来整页只剩一个 h1「归档」，正文一片空白。
           其他 6 个列表页（文章/标签/收藏/历史/友链/留言）都有空态，只有这里漏了。
           文案要给出**事实**而不是「暂无数据」：读者需要知道是"还没有文章"还是"加载失败"，
           以及下一步能去哪。加载失败另有分支（见下面的 error 块）。 -->
      <div v-if="!loading && !failed && !yearGroups.length" class="empty-state">
        <div class="icon-wrap"><XIcon name="Calendar" :size="30" /></div>
        <p>还没有已发布的文章</p>
        <p class="empty-hint">文章发布后会按年份自动出现在这里</p>
        <div class="empty-actions">
          <router-link to="/articles" class="search-btn retry-btn">去看看全部文章</router-link>
        </div>
      </div>

      <!-- 加载失败：不能和"没有文章"混为一谈 —— 前者网络恢复后重试就好，
           后者需要作者去发文章。混在一起会让读者以为站点空了。 -->
      <div v-else-if="failed" class="empty-state state-error" role="alert">
        <div class="icon-wrap"><XIcon name="ShieldAlert" :size="30" /></div>
        <p>归档加载失败，可能是网络波动或服务暂时不可用</p>
        <button class="search-btn retry-btn" @click="load()">重试</button>
      </div>

      <div v-else class="timeline">
        <div v-for="yg in yearGroups" :key="yg.year" class="tl-year-group" :data-year="yg.year" v-reveal>
          <!-- 年份用 h2，给它一个真正的标题层级。
               原来整页只有 h1「归档」，年份和月份都是 <span> ——
               读屏用户只能一路 Tab 过六个链接，没法按标题跳年份。 -->
          <div class="tl-year-head">
            <h2 class="tl-year-big">{{ yg.year }}</h2>
            <span class="tl-year-count">{{ yg.count }} 篇</span>
          </div>

          <div v-for="group in yg.months" :key="group.month" class="tl-group">
            <div class="tl-month">
              <h3 class="tl-month-text">{{ monthOf(group.month) }} 月</h3>
              <span class="tl-count">{{ group.count }} 篇</span>
            </div>

            <!-- 条形图是纯视觉的「这个月有多少篇」。
                 那个数字旁边已经用文字说了（{{ group.count }} 篇），
                 所以这里对读屏隐藏，避免同一件事被念两遍。 -->
            <div class="tl-bar" aria-hidden="true">
              <div class="tl-bar-fill" :style="{ width: barWidth(group.count) + '%' }"></div>
            </div>

            <div class="tl-items">
              <router-link v-for="item in group.items" :key="item.id" :to="`/article/${item.slug}`" class="tl-item">
                <span class="tl-day">{{ item.day }}</span>
                <span class="tl-line"></span>
                <span class="tl-title">{{ item.title }}</span>
                <span class="tl-views"><XIcon name="Eye" :size="13" /> {{ item.views }}</span>
              </router-link>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { articleApi } from '@/api';
import { useSiteStore } from '@/stores/site';
import { applyPageMeta } from '@/utils/pageMeta';

const site = useSiteStore();

// 浏览器标签页标题
watchEffect(() => {
  const siteName = site.settings.site_name || 'Xalor的小站';
  const pageTitle = '归档';
  document.title = `${pageTitle} · ${siteName}`;
  // 元信息与标题同源设置：canonical / og:url / og:image 缺一都会让分享卡片降级

  applyPageMeta({ title: pageTitle, description: '按时间浏览全部文章', path: '/archive', site });
});

/** 年份快捷导航：平滑滚动到对应分组 */
function scrollToYear(year) {
  const el = document.querySelector(`[data-year="${year}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const groups = ref([]);

const totalArticles = computed(() => groups.value.reduce((s, g) => s + g.items.length, 0));

// 按年份分组：年份大标题只出现一次，下方是各月
const yearGroups = computed(() => {
  const map = new Map();
  for (const g of groups.value) {
    const y = yearOf(g.month);
    if (!map.has(y)) map.set(y, []);
    map.get(y).push(g);
  }
  return [...map.entries()].map(([year, months]) => ({
    year,
    months,
    count: months.reduce((s, m) => s + m.count, 0),
  }));
});

function yearOf(month) {
  return month.split('-')[0];
}

function monthOf(month) {
  return parseInt(month.split('-')[1]);
}

// 月份产出进度条（相对最多产出的月份，最少 8% 保证可见）
function barWidth(count) {
  const max = Math.max(...groups.value.map((g) => g.count), 1);
  return Math.max(8, Math.round((count / max) * 100));
}

// 加载中 / 加载失败两个状态都要显式建模：
// 原来只有一个 `catch (e) { /* 拦截器已提示 */ }`，失败后 groups 仍是 []，
// 于是「还没加载完」「加载失败」「确实没有文章」三种情况长得一模一样 —— 都是空白页。
// 空态文案里说的是「还没有已发布的文章」，如果实际上是网络失败，那就是**说假话**。
const loading = ref(true);
const failed = ref(false);

async function load() {
  loading.value = true;
  failed.value = false;
  try {
    groups.value = await articleApi.archive();
  } catch (e) {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
/* 年份快捷导航 */
.year-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 28px;
}

.year-chip {
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.85rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  transition: all var(--dur) var(--ease);
  cursor: pointer;
}

.year-chip:hover {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.archive-page {
  padding-bottom: 60px;
}

.narrow {
  max-width: 760px;
}

.page-head .eyebrow {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--accent-text);
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* 时间线 */
.timeline {
  position: relative;
  padding-left: 26px;
}

.timeline::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--border);
}

.tl-group {
  margin-bottom: 36px;
}

/* 年份分组大标题 */
.tl-year-group {
  margin-bottom: 8px;
}

.tl-year-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 26px;
  position: relative;
}

.tl-year-head::before {
  content: '';
  position: absolute;
  left: -26px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  border: 3px solid var(--card);
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 5px var(--bg);
}

.tl-year-big {
  font-size: 2rem;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
  background: linear-gradient(90deg, var(--text), var(--accent));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.tl-year-count {
  font-size: 0.8rem;
  color: var(--text-3);
}

.tl-month {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 18px;
  position: relative;
}

.tl-month::before {
  content: '';
  position: absolute;
  left: -26px;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--card);
  border: 2.5px solid var(--accent);
  box-shadow: 0 0 0 4px var(--bg);
}

.tl-month-text {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
}

.tl-count {
  font-size: 0.76rem;
  color: var(--accent-text);
  background: var(--accent-soft);
  padding: 2px 10px;
  border-radius: 999px;
  font-weight: 650;
}

/* 月份产出进度条 */
.tl-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-soft);
  margin: 0 0 14px;
  overflow: hidden;
}

.tl-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent), var(--accent));
  transition: width 0.8s var(--ease-out);
}

/* 条目 */
.tl-items {
  display: flex;
  flex-direction: column;
}

.tl-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 14px;
  border-radius: var(--radius-sm);
  transition: background var(--dur) var(--ease);
  margin-left: -14px;
}

.tl-item:hover {
  background: var(--card);
}

.tl-day {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-3);
  width: 26px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.tl-item:hover .tl-day {
  color: var(--accent-text);
}

.tl-line {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--line);
  flex-shrink: 0;
}

.tl-title {
  /* 归档条目标题同样来自文章标题，超长串会撑出时间线 */
  overflow-wrap: anywhere;

  flex: 1;
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}

.tl-item:hover .tl-title {
  color: var(--accent-text);
}

.tl-views {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.76rem;
  color: var(--text-3);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}

.tl-item:hover .tl-views {
  opacity: 1;
}
</style>
