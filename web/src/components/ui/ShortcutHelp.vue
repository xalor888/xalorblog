<template>
  <!-- 快捷键帮助：按 ? 或 Shift+/ 打开 -->
  <teleport to="body">
    <div v-if="open" class="help-overlay" @click.self="close"></div>
    <!-- role=dialog 必须配 aria-modal：否则读屏仍会把背景当作可读内容，
         Tab 也会穿出去。实测修前 5/5 次 Tab 都逃到背景导航。 -->
    <div
      v-if="open"
      ref="panelRef"
      class="help-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      @keydown.tab="onTabTrap"
    >
      <div class="help-head">
        <h3 id="help-title" class="help-title">快捷键</h3>
        <button class="help-close" ref="closeBtnRef" @click="close" aria-label="关闭">
          <XIcon name="X" :size="16" />
        </button>
      </div>
      <div class="help-body">
        <div v-for="group in groups" :key="group.label" class="help-group">
          <p class="group-label">{{ group.label }}</p>
          <div v-for="item in group.items" :key="item.keys" class="help-row">
            <span class="help-keys">
              <kbd v-for="k in item.keys.split(' ')" :key="k">{{ k }}</kbd>
            </span>
            <span class="help-desc">{{ item.desc }}</span>
          </div>
        </div>
      </div>
      <div class="help-foot">按 ESC 或点击空白处关闭</div>
    </div>
  </teleport>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import { lockBodyScroll, unlockBodyScroll } from '@/utils/scrollLock';

const route = useRoute();
const open = ref(false);
const panelRef = ref(null);
const closeBtnRef = ref(null);
/** 打开前的焦点，关闭时还回去（否则焦点掉到 body，键盘用户失去位置） */
let lastFocused = null;

/**
 * Tab 焦点陷阱。
 * 只处理「焦点跑到面板外」的情况 —— 无条件拉回，不依赖「是否正好在首尾」，
 * 因为那个判断在动态内容下经常漏（搜索弹窗就是这么漏的，实测 10/10 逃逸）。
 */
function onTabTrap(e) {
  const panel = panelRef.value;
  if (!panel) return;
  const focusables = [...panel.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!panel.contains(active)) {
    e.preventDefault();
    first.focus();
    return;
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  }
}

// 路由变化时自动关闭帮助弹窗
watch(() => route.path, () => {
  if (open.value) close();
});

const groups = [
  {
    label: '全局',
    items: [
      { keys: 'Ctrl/Cmd K', desc: '打开全局搜索' },
      { keys: '/', desc: '快速唤起搜索' },
      { keys: '?', desc: '打开此帮助' },
      { keys: 'ESC', desc: '关闭弹窗' },
    ],
  },
  {
    label: '文章页',
    items: [
      { keys: '← →', desc: '上一篇 / 下一篇' },
      { keys: '滚轮', desc: '灯箱图片缩放' },
      { keys: '双击', desc: '灯箱图片 1x / 2x' },
    ],
  },
  {
    label: '后台编辑',
    items: [
      { keys: 'Ctrl/Cmd S', desc: '保存草稿' },
      { keys: 'Ctrl/Cmd Enter', desc: '快速发布文章' },
    ],
  },
];

function toggle() {
  if (open.value) {
    close();
  } else {
    open.value = true;
    lockBodyScroll();
  }
}

function openHelp() {
  // 记录打开前的焦点（用 body 当返回值等于没返回）
  const active = document.activeElement;
  lastFocused = active && active !== document.body ? active : null;
  open.value = true;
  lockBodyScroll();
  // 等面板渲染后再把焦点送进去
  nextTick(() => closeBtnRef.value?.focus?.());
}

function close() {
  if (open.value) unlockBodyScroll();
  open.value = false;
  const back = lastFocused;
  lastFocused = null;
  nextTick(() => {
    // 触发元素可能已不存在（例如刚发生过导航），此时不强行聚焦
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
  });
}

function onKeydown(e) {
  // ? 或 Shift+/ 打开帮助（输入框内不触发）
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    if (open.value) close();
    else openHelp();
  } else if (e.key === 'Escape') {
    close();
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  if (open.value) unlockBodyScroll();
  document.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.help-overlay {
  position: fixed;
  inset: 0;
  background: var(--lg-scrim);
  backdrop-filter: var(--lg-scrim-blur);
  -webkit-backdrop-filter: var(--lg-scrim-blur);
  z-index: var(--z-scrim);
  animation: fadeIn 0.18s ease;
}

.help-modal {
  position: fixed;
  top: 14vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(440px, calc(100vw - 32px));
  /* 液态玻璃材质 */
  background: var(--lg-sheen), var(--lg-surface);
  border: 1px solid var(--lg-edge);
  border-radius: var(--lg-radius);
  box-shadow: var(--lg-inner), var(--lg-shadow);
  z-index: calc(var(--z-modal-2) + 10);
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

.help-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid color-mix(in srgb, var(--text) 9%, transparent);
}

.help-title {
  font-size: 1rem;
  font-weight: 700;
}

.help-close {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  transition: all var(--dur) var(--ease);
}

.help-close:hover {
  color: var(--accent-text);
  background: var(--accent-soft);
}

.help-body {
  padding: 8px 20px 12px;
  max-height: 60vh;
  overflow-y: auto;
}

.help-group {
  margin-bottom: 14px;
}

.group-label {
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 8px;
}

.help-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 0;
}

.help-keys {
  flex-shrink: 0;
  display: inline-flex;
  gap: 4px;
  min-width: 90px;
}

.help-keys kbd {
  font-family: var(--font-sans);
  font-size: 0.74rem;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  border-bottom-width: 2px;
  border-radius: 6px;
  padding: 3px 8px;
  color: var(--text-2);
}

.help-desc {
  font-size: 0.88rem;
  color: var(--text-2);
}

.help-foot {
  padding: 10px 20px;
  border-top: 1px solid color-mix(in srgb, var(--text) 9%, transparent);
  font-size: 0.76rem;
  color: var(--text-3);
  text-align: center;
}
</style>
