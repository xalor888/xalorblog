<template>
  <!-- 快捷键帮助：按 ? 或 Shift+/ 打开 -->
  <teleport to="body">
    <div v-if="open" class="help-overlay" @click.self="close"></div>
    <!-- role=dialog 必须配 aria-modal：否则读屏仍会把背景当作可读内容，
         Tab 也会穿出去。实测修前 5/5 次 Tab 都逃到背景导航。

         ⚠ 焦点约束**不能**绑在面板上（原来的 @keydown.tab 就是这样）：
         焦点在面板外时事件根本不冒泡到这里，宣称的约束形同虚设。
         现在由 useFocusTrap 在 document 级接管，和另外三处弹层同一份实现。 -->
    <div
      v-if="open"
      ref="panelRef"
      class="help-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
    >
      <div class="help-head">
        <h3 id="help-title" class="help-title">快捷键</h3>
        <button class="help-close" @click="close" aria-label="关闭">
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
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import { lockBodyScroll, unlockBodyScroll } from '@/utils/scrollLock';
import { useFocusTrap } from '@/composables/useFocusTrap';

const route = useRoute();
const open = ref(false);
const panelRef = ref(null);

/**
 * 焦点管理统一交给 useFocusTrap（打开移入 / Tab 首尾循环 / Esc 关闭 / 关闭还焦）。
 *
 * 这里曾经有两条各自为政的实现：面板上的 `@keydown.tab` 陷阱，以及打开/关闭
 * 时自己记的 lastFocused。前者的问题是**绑定位置错了** —— 焦点在面板外时
 * 按键事件不会冒泡到面板，`aria-modal="true"` 宣称的约束完全落空；
 * 后者和另外三个弹层各写一遍，还各自漏了「元素已从 DOM 移除」的分支。
 * 差异只剩一个：进入面板时聚焦关闭按钮。
 */
useFocusTrap(panelRef, open, {
  onClose: () => close(),
  initialFocus: '.help-close',
});

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

function openHelp() {
  open.value = true;
  lockBodyScroll();
  // 焦点由 useFocusTrap 移入面板（见上面的 initialFocus）
}

function close() {
  if (open.value) unlockBodyScroll();
  open.value = false;
  // 焦点由 useFocusTrap 还给打开前的元素（元素已不在 DOM 时退回 body）
}

/**
 * 这里只管「打开/关闭」这一个键位（? / Shift+/）。
 * Esc 不在这里：它是模态约束，和 Tab 一起由 useFocusTrap 在 document 级处理。
 */
function onKeydown(e) {
  // ? 或 Shift+/ 打开帮助（输入框内不触发）
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    if (open.value) close();
    else openHelp();
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  if (open.value) unlockBodyScroll();
  document.removeEventListener('keydown', onKeydown);
});
/**
 * 对外暴露 openHelp：让导航栏的「快捷键」按钮能打开它。
 *
 * 原来只有 `?` 键能触发，而页面上**没有任何入口告诉用户有 `?` 这个键** ——
 * 实测全站 0 个 kbd 提示、0 个帮助按钮，等于这个功能对所有人都不存在。
 * 快捷键的价值完全取决于能否被发现。
 */
defineExpose({ openHelp });
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
