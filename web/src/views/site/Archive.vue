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

      <div class="timeline">
        <div v-for="yg in yearGroups" :key="yg.year" class="tl-year-group" :data-year="yg.year" v-reveal>
          <div class="tl-year-head">
            <span class="tl-year-big">{{ yg.year }}</span>
            <span class="tl-year-count">{{ yg.count }} 篇</span>
          </div>

          <div v-for="group in yg.months" :key="group.month" class="tl-group">
            <div class="tl-month">
              <span class="tl-month-text">{{ monthOf(group.month) }} 月</span>
              <span class="tl-count">{{ group.count }} 篇</span>
            </div>

            <div class="tl-bar">
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

// 浏览器标签页标题
watchEffect(() => {
  document.title = '归档';
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

onMounted(async () => {
  try {
    groups.value = await articleApi.archive();
  } catch (e) { /* 拦截器已提示 */ }
});
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
  color: var(--accent);
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
  color: var(--accent);
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
  color: var(--accent);
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
  color: var(--accent);
}

.tl-line {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--line);
  flex-shrink: 0;
}

.tl-title {
  flex: 1;
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}

.tl-item:hover .tl-title {
  color: var(--accent);
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
