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
        <kbd class="esc-key">ESC</kbd>
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
import { useRouter } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import { articleApi } from '@/api';
import { formatDate } from '@/utils/format';

const router = useRouter();

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
  // 记录触发元素，关闭后恢复焦点（可访问性）
  lastFocused = document.activeElement;
  open.value = true;
  activeIndex.value = 0;
  nextTick(() => inputRef.value?.focus());
}

function close() {
  open.value = false;
  keyword.value = '';
  results.value = [];
  searched.value = false;
  // 焦点还给触发元素
  if (lastFocused && typeof lastFocused.focus === 'function') {
    lastFocused.focus();
  }
  lastFocused = null;
}

/** Tab 焦点循环：保持在弹窗内（防焦点逃逸到背景页面） */
function onTabTrap(e) {
  if (!open.value || e.key !== 'Tab') return;
  const focusables = document.querySelectorAll(
    '.search-modal input, .search-modal button, .search-modal a, .search-modal kbd'
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
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
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('keydown', onTabTrap);
  window.removeEventListener('xalor-open-search', openSearch);
});
</script>

<style scoped>
.search-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 18, 14, 0.45);
  backdrop-filter: blur(3px);
  z-index: 300;
  animation: fadeIn 0.18s ease;
}

.search-modal {
  position: fixed;
  top: 12vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(620px, calc(100vw - 32px));
  background: color-mix(in srgb, var(--card) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: 22px;
  box-shadow: var(--shadow-3);
  z-index: 301;
  overflow: hidden;
  backdrop-filter: blur(22px);
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
  border-bottom: 1px solid var(--border);
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

.esc-key {
  flex-shrink: 0;
  font-family: var(--font-sans);
  font-size: 0.72rem;
  color: var(--text-3);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 5px;
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
  background: var(--bg-soft);
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
  color: var(--accent);
  background: var(--bg-soft);
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
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: 0.76rem;
}

.search-foot kbd {
  font-family: var(--font-sans);
  font-size: 0.7rem;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  margin-right: 4px;
}
</style>
