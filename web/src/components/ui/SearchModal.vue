<template>
  <teleport to="body">
    <!-- 遮罩 -->
    <div v-if="open" class="search-overlay" @click.self="close" @keydown.esc="close"></div>

    <!-- 弹窗 -->
    <div v-if="open" class="search-modal" role="dialog" aria-modal="true" aria-label="全局搜索">
      <div class="search-head">
        <XIcon name="Search" :size="18" class="search-icon" />
        <input
          ref="inputRef"
          v-model="keyword"
          class="search-input"
          placeholder="搜索文章标题或内容…"
          aria-label="搜索文章"
          @input="debouncedSearch"
        />
        <!-- ESC 提示保留（告诉键盘用户怎么关），但**必须同时给一个可点的关闭按钮**：
             只有 kbd 文字时，触屏用户和只用鼠标的人除了点遮罩没有别的出口，
             而点遮罩关闭是隐式交互，不可预期。 -->
        <button type="button" class="search-close" aria-label="关闭搜索" title="关闭搜索（Esc）" @click="close">
          <XIcon name="X" :size="16" />
        </button>
        <kbd class="esc-key" aria-hidden="true">ESC</kbd>
      </div>

      <div class="search-body" aria-live="polite">
        <div v-if="loading" class="search-state">
          <span class="spinner"></span>
          <span>搜索中…</span>
        </div>

        <template v-else-if="results.length">
          <p class="result-label">共 {{ total }} 条结果</p>
          <ul class="result-list">
            <li v-for="(r, i) in results" :key="r.id">
              <a
                class="result-item"
                :class="{ active: i === activeIndex }"
                @mouseenter="activeIndex = i"
                @click="goto(r)"
              >
                <span class="ri-dot" :style="{ background: r.category_color || 'var(--accent)' }"></span>
                <span class="ri-main">
                  <span class="ri-title" v-html="highlight(r.title)"></span>
                  <span v-if="r.summary" class="ri-summary" v-html="highlight(r.summary)"></span>
                  <span class="ri-meta">
                    <span v-if="r.category_name">{{ r.category_name }}</span>
                    <span>{{ formatDate(r.published_at) }}</span>
                    <span>{{ r.views }} 阅读</span>
                  </span>
                </span>
                <span class="ri-enter">
                  <XIcon name="ArrowUpRight" :size="15" />
                </span>
              </a>
            </li>
          </ul>
        </template>

        <div v-else-if="searched" class="search-state empty">
          <XIcon name="FileSearch" :size="30" />
          <span>没有找到「{{ lastKeyword }}」相关的文章</span>
        </div>

        <div v-else-if="history.length" class="history-block">
          <div class="history-head">
            <p class="result-label">最近搜索</p>
            <button class="history-clear" @click="clearHistory">清除</button>
          </div>
          <div class="history-list">
            <button v-for="h in history" :key="h" class="history-item" @click="useHistory(h)">
              <XIcon name="Clock3" :size="14" />
              <span>{{ h }}</span>
            </button>
          </div>
        </div>

        <div v-else class="search-state hint">
          <XIcon name="Keyboard" :size="30" />
          <span>输入关键词，回车搜索，↑↓ 选择，Enter 打开</span>
        </div>
      </div>

      <div class="search-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span><kbd>ESC</kbd> 关闭</span>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import { articleApi } from '@/api';
import { formatDate } from '@/utils/format';
import { lockBodyScroll, unlockBodyScroll } from '@/utils/scrollLock';

const router = useRouter();
const route = useRoute();

// 路由变化时自动关闭搜索浮层
watch(() => route.fullPath, () => {
  if (open.value) close();
});

const open = ref(false);
const keyword = ref('');
const results = ref([]);
const total = ref(0);
const loading = ref(false);
const searched = ref(false);
const lastKeyword = ref('');
const activeIndex = ref(0);
const inputRef = ref(null);

// 搜索历史（localStorage 记忆最近 6 条）
const HISTORY_KEY = 'xalor_search_history';
const history = ref(loadHistory());

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveHistory(k) {
  const kw = k.trim();
  if (!kw) return;
  const next = [kw, ...history.value.filter((h) => h !== kw)].slice(0, 6);
  history.value = next;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch (e) {
    /* 忽略 */
  }
}

function clearHistory() {
  history.value = [];
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch (e) {
    /* 忽略 */
  }
}

function useHistory(h) {
  keyword.value = h;
  search();
}

let debounceTimer = null;
let searchSeq = 0; // 请求序号：丢弃过期响应（防快速输入时旧结果覆盖新结果）

function debouncedSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(search, 300);
}

async function search() {
  const seq = ++searchSeq;
  const k = keyword.value.trim();
  if (!k) {
    results.value = [];
    searched.value = false;
    return;
  }
  loading.value = true;
  try {
    const res = await articleApi.list({ pageSize: 8, keyword: k });
    if (seq !== searchSeq) return; // 已有更新的搜索，丢弃本次响应
    results.value = res.list;
    total.value = res.pagination.total;
    searched.value = true;
    lastKeyword.value = k;
    activeIndex.value = 0;
    saveHistory(k); // 记录搜索历史
  } catch (e) {
    /* 忽略 */
  } finally {
    loading.value = false;
  }
}

function goto(r) {
  close();
  router.push(`/article/${r.slug}`);
}

function highlight(text = '') {
  const safe = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const k = keyword.value.trim();
  if (!k) return safe;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

let lastFocused = null;

function openSearch() {
  // 记录触发元素，关闭后恢复焦点（可访问性）。
  //
  // ⚠ 不能无条件记 document.activeElement：用 `/` 或 Ctrl+K 打开时，
  // 焦点本来就在 body 上，记下来等于「关闭后恢复到 body」—— 实测焦点
  // 确实落在 body，键盘用户得从页首重新 Tab 一遍。body 不是有效的返回点，
  // 这种情况记 null，关闭时退回到搜索入口按钮（顶栏那颗），
  // 那才是用户心里「搜索是从这儿打开的」。
  const active = document.activeElement;
  lastFocused = active && active !== document.body ? active : null;
  open.value = true;
  lockBodyScroll();
  activeIndex.value = 0;
  nextTick(() => inputRef.value?.focus());
}

function close() {
  if (open.value) unlockBodyScroll();
  open.value = false;
  keyword.value = '';
  results.value = [];
  searched.value = false;
  // 焦点还给触发元素；没有有效触发元素时退回搜索入口按钮
  if (lastFocused && typeof lastFocused.focus === 'function') {
    lastFocused.focus();
  } else {
    document.querySelector('.search-btn, [data-open-search]')?.focus?.();
  }
  lastFocused = null;
}

/**
 * Tab 焦点循环：把焦点限制在弹窗内。
 *
 * 之前这里只判断「焦点是否恰好落在第一个或最后一个元素上」，
 * 但只要焦点**不在弹窗内**（例如落到 body、或用户点了一下遮罩外），
 * 两个分支都不成立，函数直接返回 —— Tab 就顺畅地跑到背景页面的导航链接上。
 * 实测：打开搜索框后连按 Tab 10 次，**10 次全部逃逸**到背后的
 * skip-link / nav-link。而弹窗标了 aria-modal="true"，等于向读屏宣称
 * 「这是模态，背景不可达」却做不到，是最糟的一类误导。
 *
 * 现在的做法：
 * 1. 焦点不在弹窗内 → 直接拉回第一个可聚焦元素（无论从哪个方向进来）；
 * 2. 在首/尾元素上 → 正常循环。
 * 另外把「可聚焦元素」的选择器放宽：任何 tabindex 非 -1 的可交互元素都算，
 * 不再靠列举标签名（漏一个 kbd/div[role=button] 就会开个口子）。
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function modalFocusables() {
  const root = document.querySelector('.search-modal');
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

function onTabTrap(e) {
  if (!open.value || e.key !== 'Tab') return;
  const list = modalFocusables();
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;

  // 焦点不在弹窗里（或落在 body）：无条件拉回，不区分方向
  if (!active || !active.closest || !active.closest('.search-modal')) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
    return;
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function onKeydown(e) {
  // Ctrl+K / Cmd+K 打开
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
    return;
  }
  // 单独按 / 打开（输入框中除外）
  if (!open.value && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = e.target?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !e.target?.isContentEditable) {
      e.preventDefault();
      openSearch();
      return;
    }
  }
  if (!open.value) return;

  if (e.key === 'Escape') {
    close();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, results.value.length - 1);
    scrollActiveIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
    scrollActiveIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (results.value[activeIndex.value]) {
      goto(results.value[activeIndex.value]);
    }
  }
}

/** 键盘导航时保持选中项可见（结果超出弹窗高度时自动滚动） */
function scrollActiveIntoView() {
  nextTick(() => {
    const el = document.querySelector('.result-item.active');
    el?.scrollIntoView({ block: 'nearest' });
  });
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('keydown', onTabTrap);
  window.addEventListener('xalor-open-search', openSearch);
  // 路由变化（后退/导航跳转等）时关闭弹窗，防残留覆盖
  watch(
    () => router.currentRoute.value.fullPath,
    () => {
      if (open.value) close();
    }
  );
});

onUnmounted(() => {
  if (open.value) unlockBodyScroll();
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('keydown', onTabTrap);
  window.removeEventListener('xalor-open-search', openSearch);
  clearTimeout(debounceTimer); // 卸载后 300ms 内不再触发一次多余的搜索请求
});
</script>

<style scoped>
.search-overlay {
  position: fixed;
  inset: 0;
  background: var(--lg-scrim);
  backdrop-filter: var(--lg-scrim-blur);
  -webkit-backdrop-filter: var(--lg-scrim-blur);
  z-index: var(--z-scrim);
  animation: fadeIn 0.18s ease;
}

.search-modal {
  position: fixed;
  top: 12vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(640px, calc(100vw - 32px));
  /* 液态玻璃：底色渐变 + 左上角镜面高光（高光必须作为背景层，不能做成伪元素） */
  background: var(--lg-sheen), var(--lg-surface);
  border: 1px solid var(--lg-edge);
  border-radius: var(--lg-radius);
  box-shadow: var(--lg-inner), var(--lg-shadow);
  z-index: var(--z-modal-2);
  overflow: hidden;
  backdrop-filter: var(--lg-blur);
  -webkit-backdrop-filter: var(--lg-blur);
  animation: slideDown 0.22s var(--ease-out);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideDown {
  from { opacity: 0; transform: translate(-50%, -8px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}

/* 头部 */
.search-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  /* 玻璃面上的分隔线要用极淡的半透明边，实色边框会把玻璃切成硬块 */
  border-bottom: 1px solid color-mix(in srgb, var(--text) 9%, transparent);
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
  font-size: 1.02rem;
  min-width: 0;
}

.search-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.search-close:hover {
  background: var(--bg-soft);
  color: var(--text);
}

/* 触屏上 32px 偏小，按项目的触摸目标约定放到 40px */
@media (pointer: coarse) {
  .search-close {
    width: 40px;
    height: 40px;
  }
}

.esc-key {
  flex-shrink: 0;
  font-family: var(--font-sans);
  font-size: 0.72rem;
  color: var(--text-3);
  background: color-mix(in srgb, var(--text) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  border-radius: 6px;
  padding: 2px 8px;
}

/* 主体 */
.search-body {
  min-height: 180px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 8px 0;
}

.result-label {
  font-size: 0.76rem;
  color: var(--text-3);
  padding: 8px 18px 4px;
}

.result-list {
  list-style: none;
}

.result-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 18px;
  cursor: pointer;
}

.result-item:hover,
.result-item.active {
  background: color-mix(in srgb, var(--text) 7%, transparent);
}

.ri-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ri-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ri-title {
  font-size: 0.95rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ri-title :deep(mark) {
  background: var(--accent-soft);
  color: var(--accent-deep);
  border-radius: 3px;
  padding: 0 2px;
}

/* 搜索结果摘要（2 行截断 + 关键词高亮） */
.ri-summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 0.8rem;
  color: var(--text-2);
  line-height: 1.55;
}

.ri-summary :deep(mark) {
  background: var(--accent-soft);
  color: var(--accent-deep);
  border-radius: 3px;
  padding: 0 2px;
}

.ri-meta {
  display: flex;
  gap: 12px;
  font-size: 0.76rem;
  color: var(--text-3);
}

.ri-enter {
  color: var(--text-3);
  flex-shrink: 0;
}

/* 状态 */
.search-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 20px;
  color: var(--text-3);
  font-size: 0.9rem;
}

/* 搜索历史 */
.history-block {
  padding-bottom: 8px;
}

.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
}

.history-clear {
  font-size: 0.78rem;
  color: var(--text-3);
  padding: 2px 8px;
  border-radius: 5px;
  transition: all var(--dur) var(--ease);
}

.history-clear:hover {
  color: #c24b5e;
  background: rgba(194, 75, 94, 0.08);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 10px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-radius: 8px;
  font-size: 0.9rem;
  color: var(--text-2);
  width: 100%;
  text-align: left;
  transition: all var(--dur) var(--ease);
  border: none;
  background: none;
  cursor: pointer;
}

.history-item:hover {
  color: var(--accent-text);
  background: color-mix(in srgb, var(--text) 7%, transparent);
}

.spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid var(--border);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 底部 */
.search-foot {
  display: flex;
  gap: 16px;
  padding: 10px 18px;
  border-top: 1px solid color-mix(in srgb, var(--text) 9%, transparent);
  color: var(--text-3);
  font-size: 0.76rem;
}

.search-foot kbd {
  font-family: var(--font-sans);
  font-size: 0.7rem;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
  margin-right: 4px;
}
</style>
