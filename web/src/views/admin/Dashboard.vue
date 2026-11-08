<template>
  <div class="dashboard">
    <!-- 页头：标题 + 刷新 -->
    <div class="dash-head">
      <h2 class="dash-title">数据总览</h2>
      <button class="dash-refresh" :disabled="refreshing" title="刷新数据" @click="loadAll">
        <XIcon name="RefreshCw" :size="14" :class="{ 'spin-icon': refreshing }" /> 刷新
      </button>
    </div>

    <!-- 整页取数失败：必须说出来并提供重试。
         这张卡片的初值全是 0 / 空数组，静默失败时整页看起来就是「没有任何待办、
         没有任何访问」——把取数失败演成了健康态。 -->
    <div v-if="loadError" class="card load-error" role="alert">
      <XIcon name="ShieldAlert" :size="22" />
      <p>数据加载失败，可能是网络波动或服务暂时不可用</p>
      <button class="dash-retry" type="button" :disabled="refreshing" @click="loadAll">重试</button>
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
          <span class="stat-value" :class="{ unavailable: loadError }">{{ loadError ? '数据不可用' : s.value }}</span>
          <span class="stat-label">{{ s.label }}</span>
        </div>
      </component>
    </div>

    <!-- 待审事项 -->
    <div class="pending-row">
      <!-- 取数失败时计数显示「—」而不是 0：0 的意思是「没有待审的」，与「没取到」相反 -->
      <router-link :to="adminHref('comments')" class="pending-card card">
        <div class="pending-left">
          <span class="pending-dot" :class="{ done: !loadError && pending.comments === 0 }"></span>
          <span class="pending-label">待审核评论</span>
        </div>
        <span class="pending-count" :class="{ zero: !loadError && pending.comments === 0 }">{{ loadError ? '—' : pending.comments }}</span>
      </router-link>
      <router-link :to="adminHref('links')" class="pending-card card">
        <div class="pending-left">
          <span class="pending-dot" :class="{ done: !loadError && pending.links === 0 }"></span>
          <span class="pending-label">待审核友链</span>
        </div>
        <span class="pending-count" :class="{ zero: !loadError && pending.links === 0 }">{{ loadError ? '—' : pending.links }}</span>
      </router-link>
      <router-link :to="adminHref('messages')" class="pending-card card">
        <div class="pending-left">
          <span class="pending-dot" :class="{ done: !loadError && pending.messages === 0 }"></span>
          <span class="pending-label">待审核留言</span>
        </div>
        <span class="pending-count" :class="{ zero: !loadError && pending.messages === 0 }">{{ loadError ? '—' : pending.messages }}</span>
      </router-link>
    </div>

    <!-- 安全概览：单独失败时只降级这一块，其它数据照常渲染。
         重试按钮必须放在卡片外面 —— 卡片本身是 router-link，按钮嵌进去是
         「链接里套按钮」的非法交互嵌套，键盘与读屏都会乱。 -->
    <div v-if="securityError" class="card load-error" role="alert">
      <XIcon name="ShieldAlert" :size="22" />
      <p>安全数据加载失败，已拦截与封禁数据不可用</p>
      <button class="dash-retry" type="button" :disabled="refreshing" @click="loadAll">重试</button>
    </div>
    <div class="sec-overview">
      <router-link :to="adminHref('security')" class="sec-overview-card card">
        <div class="so-icon"><XIcon name="ShieldCheck" :size="19" /></div>
        <div class="so-body">
          <span class="so-value" :class="{ unavailable: securityError }">{{ securityError ? '数据不可用' : security.event_total || 0 }}</span>
          <span class="so-label">已拦截攻击</span>
        </div>
        <span class="so-arrow"><XIcon name="ArrowRight" :size="15" /></span>
      </router-link>
      <router-link :to="adminHref('security')" class="sec-overview-card card">
        <div class="so-icon ban"><XIcon name="Ban" :size="19" /></div>
        <div class="so-body">
          <span class="so-value" :class="{ unavailable: securityError }">{{ securityError ? '数据不可用' : security.banned?.length || 0 }}</span>
          <span class="so-label">封禁中的 IP</span>
        </div>
        <span class="so-arrow"><XIcon name="ArrowRight" :size="15" /></span>
      </router-link>
      <router-link :to="adminHref('security')" class="sec-overview-card card">
        <div class="so-icon warn"><XIcon name="Activity" :size="19" /></div>
        <div class="so-body">
          <!-- 三态：未知 / 有事件 / 无事件。口径见 script 里的 securityStatus -->
          <span class="so-value" :class="{ unavailable: securityError }">{{ securityStatus }}</span>
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
        <!-- 局部降级：趋势取数失败只影响这张卡，其余卡片照常渲染 -->
        <div v-if="loadError" class="load-inline">
          <p>访问趋势加载失败</p>
          <button class="dash-retry" type="button" :disabled="refreshing" @click="loadAll">重试</button>
        </div>
        <div v-else-if="trendEmpty" class="chart-empty">暂无访问数据</div>
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
        <div v-if="loadError" class="load-inline">
          <p>分类分布加载失败</p>
          <button class="dash-retry" type="button" :disabled="refreshing" @click="loadAll">重试</button>
        </div>
        <div v-else-if="byCategory.length" class="cat-chart">
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
        <div v-if="loadError" class="load-inline">
          <p>互动趋势加载失败</p>
          <button class="dash-retry" type="button" :disabled="refreshing" @click="loadAll">重试</button>
        </div>
        <div v-else-if="!interactEmpty" class="int-bars">
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

    <!-- 热门文章 + 最新动态：取数失败时给占位，而不是让这两块整片消失
         （消失会被读成「最近什么都没发生」）。成功时按原条件渲染。 -->
    <div v-if="loadError" class="chart-card card top-card">
      <h3 class="chart-title">热门文章 / 最新动态</h3>
      <div class="load-inline">
        <p>列表数据加载失败</p>
        <button class="dash-retry" type="button" :disabled="refreshing" @click="loadAll">重试</button>
      </div>
    </div>
    <template v-else>
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
              <router-link v-if="it.link" :to="it.link" class="feed-link" :target="it.kind === 'article' ? '_blank' : undefined">{{ it.title }}</router-link>
              <span v-else class="feed-title">{{ it.title }}</span>
              <span class="feed-meta">{{ it.nickname }} · {{ timeAgo(it.created_at) }}</span>
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useAdminStore } from '@/stores/admin';
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

/**
 * 两层失败标志，粒度不同：
 *  - loadError：仪表盘主体（统计卡 / 图表 / 列表）没取到 —— 这些卡片的初值都是
 *    0 与空数组，静默失败会被读成「没有访问、没有事件」；
 *  - securityError：只有安全概览这一块失败，其余照常渲染（局部降级）。
 * 取数失败必须与「真的为 0」在界面上可区分，否则运维会以为一切正常。
 */
const loadError = ref(false);
const securityError = ref(false);

/**
 * 防护状态三态。
 *
 * 为什么不能拿 event_total 的真假当「防护状态」：这个数是**近 7 天累计**的
 * 拦截事件总数（DB 已落库 + 内存里尚未落库的部分），不是当前现场。
 * 它为 0 只说明这一周没出过事，说成「稳定」等于把历史数据冒充实时判断；
 * 不为 0 说成「实时」也一样错 —— 昨天的事件今天还在数里。所以只能说
 * 「近 7 天有/无事件」；取数失败时更只能给「未知」，不能落到「稳定」。
 */
const securityStatus = computed(() => {
  if (securityError.value) return '未知';
  return Number(security.value?.event_total) > 0 ? '近 7 天有事件' : '近 7 天无事件';
});

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
  if (Number(v) === 0) return '0%';
  const pct = Math.max(4, (Number(v) / maxInteract.value) * 100);
  return `${pct}%`;
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
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
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

const refreshing = ref(false);

async function loadAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  loadError.value = false;
  securityError.value = false;
  try {
    await getAdminPath();
    // 两块取数互不阻塞：趋势图拿到了就照常画，安全概览失败只在它自己那块提示。
    // 用 allSettled 而不是 all —— all 会让一块失败把整页拖进同一个 catch，
    // 于是「安全概览 500」也能把访问趋势清空。
    const [statsRes, secRes] = await Promise.allSettled([
      statsApi.dashboard(rangeDays.value),
      securityApi.overview(),
    ]);
    if (statsRes.status === 'fulfilled') {
      dashboard.value = statsRes.value;
    } else {
      loadError.value = true;
    }
    if (secRes.status === 'fulfilled') {
      security.value = secRes.value || { event_total: 0, banned: [] };
    } else {
      securityError.value = true;
    }
    // 侧边栏待审角标：失败只影响角标本身，不该把整页标成失败。
    //
    // 这里原本是 `await import('@/stores/admin')` 包在 try 里 —— 两个问题：
    //   1. `CommentManage` / `MessageManage` 都是**静态** import 这个 store，
    //      它本来就在主 chunk 里，动态导入不省任何体积，只多一次异步跳跃；
    //   2. 那个 try 只捕获 import 失败，而 `fetchPending()` 是 async 且没被 await，
    //      它自己的失败根本进不来 —— 于是这个 catch 唯一的作用是**吞掉 chunk 加载失败**，
    //      角标不动、没有任何提示。
    // 现在改成静态 import：store 内部的 `failed` 状态负责表达「拉取失败」，
    // 不再需要这一层静默。
    useAdminStore().fetchPending();
  } catch (e) {
    // 后台秘钥路径都拿不到：两块数据无从取起，只能整页降级
    loadError.value = true;
    securityError.value = true;
  } finally {
    refreshing.value = false;
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

.dash-refresh:hover:not(:disabled) {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.dash-refresh:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dash-refresh :deep(.spin-icon) {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.dash-refresh:active:not(:disabled) :deep(svg:not(.spin-icon)) {
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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

/* ============ 取数失败态 ============
   失败必须与「0」「空态」看得出区别：明确一句原因 + 一个重试出口。
   文字一律用实色 token（var(--text-2)），不用 opacity 淡化 ——
   暗色主题下淡化后的正文对比度不够，读起来像被禁用的装饰。 */
.load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 22px 20px;
  color: var(--text-2);
  text-align: center;
}

/* 卡片内部的失败占位（图表 / 列表），高度按原区域留白，避免整页跳动 */
.load-inline {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 34px 0;
  color: var(--text-2);
  font-size: 0.9rem;
}

.dash-retry {
  padding: 4px 16px;
  border-radius: 8px;
  border: 1px solid var(--accent);
  background: var(--card);
  color: var(--accent-text);
  font-size: 0.8rem;
  font-weight: 650;
  transition: all var(--dur) var(--ease);
}

.dash-retry:hover:not(:disabled) {
  background: var(--accent-soft);
}

.dash-retry:disabled {
  border-color: var(--line);
  color: var(--text-3);
  cursor: not-allowed;
}

/* 「数据不可用」比数字长得多：缩字号，别把卡片撑变形 */
.stat-value.unavailable,
.so-value.unavailable {
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: 0;
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
