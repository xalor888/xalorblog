<template>
  <div class="dashboard">
    <!-- 页头：标题 + 刷新 -->
    <div class="dash-head">
      <h2 class="dash-title">数据总览</h2>
      <button class="dash-refresh" title="刷新数据" @click="loadAll">
        <XIcon name="RefreshCw" :size="14" /> 刷新
      </button>
    </div>

    <!-- 统计卡片（带 link 的可点击直达对应管理页） -->
    <div class="stat-grid">
      <component
        :is="s.link ? 'router-link' : 'div'"
        v-for="s in statCards"
        :key="s.label"
        :to="s.link"
        class="stat-card card"
        :class="{ 'stat-clickable': !!s.link }"
        :style="{ '--sc': s.color }"
      >
        <div class="stat-icon"><XIcon :name="s.icon" :size="21" /></div>
        <div class="stat-info">
          <span class="stat-value">{{ s.value }}</span>
          <span class="stat-label">{{ s.label }}</span>
        </div>
      </component>
    </div>

    <!-- 待审事项 -->
    <div class="pending-row">
      <router-link :to="adminHref('comments')" class="pending-card card">
        <div class="pending-left">
          <span class="pending-dot" :class="{ done: pending.comments === 0 }"></span>
          <span class="pending-label">待审核评论</span>
        </div>
        <span class="pending-count" :class="{ zero: pending.comments === 0 }">{{ pending.comments }}</span>
      </router-link>
      <router-link :to="adminHref('links')" class="pending-card card">
        <div class="pending-left">
          <span class="pending-dot" :class="{ done: pending.links === 0 }"></span>
          <span class="pending-label">待审核友链</span>
        </div>
        <span class="pending-count" :class="{ zero: pending.links === 0 }">{{ pending.links }}</span>
      </router-link>
      <router-link :to="adminHref('messages')" class="pending-card card">
        <div class="pending-left">
          <span class="pending-dot" :class="{ done: pending.messages === 0 }"></span>
          <span class="pending-label">待审核留言</span>
        </div>
        <span class="pending-count" :class="{ zero: pending.messages === 0 }">{{ pending.messages }}</span>
      </router-link>
    </div>

    <!-- 安全概览 -->
    <div class="sec-overview">
      <router-link :to="adminHref('security')" class="sec-overview-card card">
        <div class="so-icon"><XIcon name="ShieldCheck" :size="19" /></div>
        <div class="so-body">
          <span class="so-value">{{ security.event_total || 0 }}</span>
          <span class="so-label">已拦截攻击</span>
        </div>
        <span class="so-arrow"><XIcon name="ArrowRight" :size="15" /></span>
      </router-link>
      <router-link :to="adminHref('security')" class="sec-overview-card card">
        <div class="so-icon ban"><XIcon name="Ban" :size="19" /></div>
        <div class="so-body">
          <span class="so-value">{{ security.banned?.length || 0 }}</span>
          <span class="so-label">封禁中的 IP</span>
        </div>
        <span class="so-arrow"><XIcon name="ArrowRight" :size="15" /></span>
      </router-link>
      <router-link :to="adminHref('security')" class="sec-overview-card card">
        <div class="so-icon warn"><XIcon name="Activity" :size="19" /></div>
        <div class="so-body">
          <span class="so-value">{{ security.event_total ? '实时' : '稳定' }}</span>
          <span class="so-label">防护状态</span>
        </div>
        <span class="so-arrow"><XIcon name="ArrowRight" :size="15" /></span>
      </router-link>
    </div>

    <!-- 图表 -->
    <div class="chart-grid">
      <div class="chart-card card">
        <div class="chart-head">
          <h3 class="chart-title">访问趋势</h3>
          <div class="range-group">
            <button v-for="d in [7, 14, 30]" :key="d" class="range-btn" :class="{ active: rangeDays === d }" @click="setRange(d)">
              {{ d }} 天
            </button>
          </div>
        </div>
        <div v-if="trendEmpty" class="chart-empty">暂无访问数据</div>
        <div v-else class="trend-chart">
          <svg class="trend-svg" :viewBox="`0 0 ${TW} ${TH}`" role="img" aria-label="访问趋势">
            <polyline class="trend-line pv" fill="none" :points="pvLine" />
            <polyline class="trend-line uv" fill="none" :points="uvLine" />
            <g v-for="p in trendPoints" :key="p.day">
              <circle class="trend-dot pv" :cx="p.x" :cy="p.pvY" r="3">
                <title>{{ p.day }} · PV {{ p.pv }}</title>
              </circle>
              <circle class="trend-dot uv" :cx="p.x" :cy="p.uvY" r="3">
                <title>{{ p.day }} · UV {{ p.uv }}</title>
              </circle>
            </g>
          </svg>
          <div class="trend-labels">
            <span v-for="d in trendLabels" :key="d">{{ d }}</span>
          </div>
        </div>
        <div class="legend">
          <span class="legend-item"><i class="dot pv-dot"></i> PV</span>
          <span class="legend-item"><i class="dot uv-dot"></i> UV</span>
        </div>
      </div>

      <div class="chart-card card">
        <h3 class="chart-title">分类分布</h3>
        <div v-if="byCategory.length" class="cat-chart">
          <div v-for="c in byCategory" :key="c.name" class="cat-row">
            <span class="cat-name">{{ c.name }}</span>
            <div class="cat-track">
              <div class="cat-fill" :style="{ width: catWidth(c.count) }"></div>
            </div>
            <span class="cat-count">{{ c.count }}</span>
          </div>
        </div>
        <div v-else class="chart-empty">暂无分类数据</div>
      </div>

      <!-- 互动趋势：近 14 天评论/留言 -->
      <div class="chart-card card">
        <h3 class="chart-title">互动趋势</h3>
        <div v-if="!interactEmpty" class="int-bars">
          <div v-for="d in interactTrend" :key="d.day" class="int-col" :title="`${d.day} · 评论 ${d.comments} / 留言 ${d.messages}`">
            <div class="int-stack">
              <div class="int-bar cm" :style="{ height: intBarHeight(d.comments, 'cm') }"></div>
              <div class="int-bar msg" :style="{ height: intBarHeight(d.messages, 'msg') }"></div>
            </div>
            <span class="int-label">{{ String(d.day || '').slice(5) }}</span>
          </div>
        </div>
        <div v-else class="chart-empty">暂无互动数据</div>
        <div class="legend">
          <span class="legend-item"><i class="dot cm-dot"></i> 评论</span>
          <span class="legend-item"><i class="dot msg-dot"></i> 留言</span>
        </div>
      </div>
    </div>

    <!-- 热门文章 TOP -->
    <div v-if="topArticles.length" class="chart-card card top-card">
      <h3 class="chart-title">热门文章 TOP {{ topArticles.length }}</h3>
      <div class="top-list">
        <router-link v-for="(a, i) in topArticles" :key="a.id" :to="`/article/${a.slug}`" class="top-item" target="_blank">
          <span class="top-rank" :class="{ hot: i < 3 }">{{ i + 1 }}</span>
          <span class="top-title">{{ a.title }}</span>
          <span class="top-views"><XIcon name="Eye" :size="13" /> {{ a.views }}</span>
          <span class="top-likes"><XIcon name="Heart" :size="13" /> {{ a.likes }}</span>
        </router-link>
      </div>
    </div>

    <!-- 最新动态（评论 / 留言 / 文章，按时间合并排序） -->
    <div v-if="recentItems.length" class="chart-card card top-card">
      <h3 class="chart-title">最新动态</h3>
      <div class="feed-list">
        <div v-for="(it, i) in recentItems" :key="i" class="feed-item">
          <span class="feed-tag" :class="it.kind">{{ it.tag }}</span>
          <span class="feed-text">
            <router-link v-if="it.link" :to="it.link" class="feed-link" target="_blank">{{ it.title }}</router-link>
            <span v-else class="feed-title">{{ it.title }}</span>
            <span class="feed-meta">{{ it.nickname }} · {{ timeAgo(it.created_at) }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { statsApi, securityApi } from '@/api';
import { adminHref, getAdminPath } from '@/utils/adminPath';
import { timeAgo } from '@/utils/format';

const dashboard = ref({
  trend: [],
  by_category: [],
  interact_trend: [],
  pending: { comments: 0, links: 0, messages: 0 },
  counts: {},
  total_articles: 0,
  top_articles: [],
  recent_comments: [],
  recent_messages: [],
  recent_articles: [],
});
const security = ref({ event_total: 0, banned: [] });

const pending = computed(() => dashboard.value.pending || { comments: 0, links: 0, messages: 0 });
const trend = computed(() => dashboard.value.trend || []);
const byCategory = computed(() => dashboard.value.by_category || []);
const topArticles = computed(() => dashboard.value.top_articles || []);
// 趋势全 0（新站尚无访问数据）：显示空态而非 14 根空柱
const trendEmpty = computed(() => !trend.value.length || trend.value.every((t) => Number(t.pv) === 0 && Number(t.uv) === 0));

// 互动趋势（近 14 天评论/留言）
const interactTrend = computed(() => dashboard.value.interact_trend || []);
const interactEmpty = computed(() => interactTrend.value.every((d) => Number(d.comments) === 0 && Number(d.messages) === 0));
const maxInteract = computed(() => Math.max(...interactTrend.value.map((d) => Math.max(Number(d.comments), Number(d.messages))), 1));
function intBarHeight(v, kind) {
  const pct = Math.max(4, (Number(v) / maxInteract.value) * 100);
  return `${kind === 'msg' ? pct * 0.7 : pct}%`;
}

const maxPv = computed(() => Math.max(...trend.value.map((t) => Math.max(Number(t.pv) || 0, Number(t.uv) || 0)), 1));
const maxCount = computed(() => Math.max(...byCategory.value.map((c) => c.count), 1));
const TW = 320;
const TH = 150;
const trendPoints = computed(() => {
  const rows = trend.value;
  const n = rows.length;
  const max = maxPv.value;
  const padX = 10;
  const padY = 12;
  return rows.map((t, i) => {
    const x = n <= 1 ? TW / 2 : padX + (i / (n - 1)) * (TW - padX * 2);
    const yOf = (v) => TH - padY - ((Number(v) || 0) / max) * (TH - padY * 2);
    return {
      day: t.day,
      pv: Number(t.pv) || 0,
      uv: Number(t.uv) || 0,
      x,
      pvY: yOf(t.pv),
      uvY: yOf(t.uv),
    };
  });
});
const pvLine = computed(() => trendPoints.value.map((p) => `${p.x},${p.pvY}`).join(' '));
const uvLine = computed(() => trendPoints.value.map((p) => `${p.x},${p.uvY}`).join(' '));
const trendLabels = computed(() => {
  const rows = trend.value;
  if (!rows.length) return [];
  const want = Math.min(7, rows.length);
  const idx = new Set([0, rows.length - 1]);
  if (want > 2) {
    const step = (rows.length - 1) / (want - 1);
    for (let i = 1; i < want - 1; i++) idx.add(Math.round(i * step));
  }
  return [...idx].sort((a, b) => a - b).map((i) => String(rows[i].day || '').slice(5));
});

const today = computed(() => trend.value[trend.value.length - 1] || { pv: 0, uv: 0 });

const counts = computed(() => dashboard.value.counts || {});

/** 大数字美化：≥1 万显示 x.xw，≥1 亿显示 x.x亿 */
function formatNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}w`;
  return String(v);
}

const statCards = computed(() => [
  { label: '文章总数', value: dashboard.value.total_articles ?? 0, icon: 'FileText', color: 'var(--accent)', link: adminHref('articles') },
  { label: '草稿', value: counts.value.drafts ?? 0, icon: 'FileClock', color: '#8a6d3b', link: adminHref('articles') },
  { label: '总浏览量', value: formatNum(counts.value.views ?? 0), icon: 'BarChart3', color: '#c9900f' },
  { label: '今日 PV', value: today.value.pv ?? 0, icon: 'Eye', color: '#217a5e' },
  { label: '今日 UV', value: today.value.uv ?? 0, icon: 'Users', color: '#2f6fb3' },
  { label: '评论', value: counts.value.comments ?? 0, icon: 'MessageSquare', color: '#7a5fbf', link: adminHref('comments') },
  { label: '留言', value: counts.value.messages ?? 0, icon: 'MessagesSquare', color: '#3b8a8a', link: adminHref('messages') },
]);

/** 最新动态：评论/留言/文章合并后按时间倒序，取前 10 条 */
const recentItems = computed(() => {
  const items = [];
  for (const c of dashboard.value.recent_comments || []) {
    items.push({ kind: 'comment', tag: '评论', nickname: c.nickname, title: c.content, created_at: c.created_at, link: adminHref('comments') });
  }
  for (const m of dashboard.value.recent_messages || []) {
    items.push({ kind: 'message', tag: '留言', nickname: m.nickname, title: m.content, created_at: m.created_at, link: adminHref('messages') });
  }
  for (const a of dashboard.value.recent_articles || []) {
    items.push({ kind: 'article', tag: '文章', nickname: '发布', title: a.title, created_at: a.published_at, link: `/article/${a.slug}` });
  }
  return items.sort((x, y) => new Date(y.created_at) - new Date(x.created_at)).slice(0, 10);
});

function catWidth(count) {
  return `${(count / maxCount.value) * 100}%`;
}

async function loadAll() {
  try {
    await getAdminPath();
    dashboard.value = await statsApi.dashboard(rangeDays.value);
    security.value = await securityApi.overview();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

/** 切换趋势时间范围（7/14/30 天，选择本地记忆） */
const RANGE_KEY = 'xalor_dash_range';
const rangeDays = ref((() => {
  try { return Number(localStorage.getItem(RANGE_KEY)) || 14; } catch (e) { return 14; }
})());
function setRange(d) {
  rangeDays.value = d;
  try {
    localStorage.setItem(RANGE_KEY, String(d));
  } catch (e) { /* 隐私模式忽略 */ }
  loadAll();
}

onMounted(loadAll);
</script>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 页头 */
.dash-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dash-title {
  font-size: 1.15rem;
  font-weight: 750;
  letter-spacing: -0.01em;
}

.dash-refresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.84rem;
  transition: all var(--dur) var(--ease);
}

.dash-refresh:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.dash-refresh:active :deep(svg) {
  transform: rotate(180deg);
}

.dash-refresh :deep(svg) {
  transition: transform 0.4s var(--ease);
}

/* 统计卡片 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}

/* 安全概览 */
.sec-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}

.sec-overview-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  transition: all var(--dur) var(--ease);
}

.sec-overview-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-2);
  transform: translateY(-2px);
}

.so-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: color-mix(in srgb, #217a5e 12%, transparent);
  color: #217a5e;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.so-icon.ban {
  background: color-mix(in srgb, #c24b5e 12%, transparent);
  color: #c24b5e;
}

.so-icon.warn {
  background: color-mix(in srgb, #c9900f 12%, transparent);
  color: #c9900f;
}

.so-body {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.so-value {
  font-size: 1.15rem;
  font-weight: 750;
}

.so-label {
  font-size: 0.78rem;
  color: var(--text-3);
}

.so-arrow {
  color: var(--text-3);
  opacity: 0;
  transform: translateX(-4px);
  transition: all var(--dur) var(--ease);
}

.sec-overview-card:hover .so-arrow {
  opacity: 1;
  transform: none;
  color: var(--accent);
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 22px;
  text-decoration: none;
  color: inherit;
}

/* 可点击统计卡：hover 反馈提示可跳转 */
.stat-card.stat-clickable {
  cursor: pointer;
  transition: transform var(--dur) var(--ease), border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.stat-card.stat-clickable:hover {
  transform: translateY(-2px);
  border-color: var(--sc);
  box-shadow: var(--shadow-2);
}

.stat-icon {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: var(--bg-soft);
  color: var(--sc);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid var(--border);
}

.stat-info {
  display: flex;
  flex-direction: column;
}

.stat-value {
  font-size: 1.55rem;
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.stat-label {
  color: var(--text-3);
  font-size: 0.82rem;
}

/* 待审 */
.pending-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}

.pending-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  transition: all var(--dur) var(--ease);
}

.pending-card:hover {
  border-color: var(--line);
  box-shadow: var(--shadow-2);
}

.pending-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pending-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c9900f;
}

.pending-dot.done {
  background: #217a5e;
}

.pending-label {
  color: var(--text-2);
  font-size: 0.92rem;
}

.pending-count {
  font-size: 1.4rem;
  font-weight: 800;
  color: #c9900f;
  font-variant-numeric: tabular-nums;
}

.pending-count.zero {
  color: var(--text-3);
}

/* ============ 热门文章 TOP ============ */
.top-card {
  padding: 20px 24px;
}

.top-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.top-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  transition: all var(--dur) var(--ease);
}

.top-item:hover {
  background: var(--bg-soft);
}

.top-rank {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--bg-soft);
  color: var(--text-3);
  font-size: 0.8rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.top-rank.hot {
  background: var(--accent-soft);
  color: var(--accent-deep);
}

.top-title {
  flex: 1;
  min-width: 0;
  font-size: 0.9rem;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}

.top-item:hover .top-title {
  color: var(--accent);
}

.top-views,
.top-likes {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--text-3);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* ============ 最新动态 ============ */
.feed-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.feed-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  transition: background var(--dur) var(--ease);
}

.feed-item:hover {
  background: var(--bg-soft);
}

.feed-tag {
  flex-shrink: 0;
  font-size: 0.68rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  color: #fff;
}

.feed-tag.comment { background: #2f6fb3; }
.feed-tag.message { background: #8b5fb0; }
.feed-tag.article { background: #217a5e; }

.feed-text {
  flex: 1;
  min-width: 0;
  font-size: 0.88rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.feed-link {
  color: var(--text);
  transition: color var(--dur) var(--ease);
}

.feed-link:hover {
  color: var(--accent);
}

.feed-title {
  color: var(--text-2);
}

.feed-meta {
  font-size: 0.75rem;
  color: var(--text-3);
  margin-left: 6px;
  flex-shrink: 0;
}

/* 仪表盘图表区 */
.chart-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 14px;
}

.chart-card {
  padding: 22px 24px;
}

.chart-title {
  font-size: 0.98rem;
  font-weight: 700;
  margin-bottom: 18px;
  letter-spacing: -0.01em;
}

.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

.chart-head .chart-title {
  margin-bottom: 0;
}

.range-group {
  display: flex;
  gap: 4px;
}

.range-btn {
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-3);
  font-size: 0.74rem;
  font-weight: 600;
  transition: all var(--dur) var(--ease);
}

.range-btn.active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.range-btn:hover:not(.active) {
  color: var(--text-2);
  border-color: var(--line);
}

.trend-chart {
  padding-top: 8px;
}

.trend-svg {
  width: 100%;
  height: 168px;
  display: block;
  overflow: visible;
}

.trend-line {
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.trend-line.pv {
  stroke: var(--accent);
}

.trend-line.uv {
  stroke: #2f6fb3;
}

.trend-dot.pv {
  fill: var(--accent);
}

.trend-dot.uv {
  fill: #2f6fb3;
}

[data-theme='dark'] .trend-line.uv,
[data-theme='dark'] .trend-dot.uv {
  stroke: #5b8def;
  fill: #5b8def;
}

.trend-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 0.66rem;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.legend {
  display: flex;
  gap: 18px;
  justify-content: flex-end;
  margin-top: 12px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  color: var(--text-2);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
}

.pv-dot {
  background: var(--accent);
}

.uv-dot {
  background: #2f6fb3;
}

/* 分类 */
.cat-chart {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cat-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cat-name {
  width: 70px;
  font-size: 0.84rem;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

.cat-track {
  flex: 1;
  height: 9px;
  border-radius: 999px;
  background: var(--bg-soft);
  overflow: hidden;
}

.cat-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.5s var(--ease-out);
}

.cat-count {
  font-size: 0.82rem;
  font-weight: 650;
  color: var(--text-2);
  width: 22px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.chart-empty {
  color: var(--text-3);
  text-align: center;
  padding: 40px 0;
  font-size: 0.9rem;
}

@media (max-width: 980px) {
  .chart-grid {
    grid-template-columns: 1fr;
  }
}

/* 互动趋势双柱 */
.int-bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 160px;
  overflow-x: auto;
}

.int-col {
  flex: 1;
  min-width: 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.int-stack {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 100%;
  width: 100%;
  justify-content: center;
}

.int-bar {
  width: 7px;
  border-radius: 3px 3px 0 0;
  transition: height 0.3s var(--ease);
}

.int-bar.cm {
  background: var(--accent);
}

.int-bar.msg {
  background: var(--text-3);
}

.int-label {
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
}

.cm-dot {
  background: var(--accent);
}

.msg-dot {
  background: var(--text-3);
}

</style>
