<template>
  <!-- 快捷键帮助：按 ? 或 Shift+/ 打开 -->
  <teleport to="body">
    <div v-if="open" class="help-overlay" @click.self="close"></div>
    <div v-if="open" class="help-modal" role="dialog" aria-label="快捷键帮助">
      <div class="help-head">
        <h3 class="help-title">快捷键</h3>
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
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';

const route = useRoute();
const open = ref(false);

const groups = [
  {
    label: '全局',
    items: [
      { keys: 'Ctrl K', desc: '打开全局搜索' },
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
];

function toggle() {
  open.value = !open.value;
}

function close() {
  open.value = false;
}

function onKeydown(e) {
  // ? 或 Shift+/ 打开帮助（输入框内不触发）
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    toggle();
  } else if (e.key === 'Escape') {
    close();
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.help-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 18, 14, 0.45);
  backdrop-filter: blur(3px);
  z-index: 300;
  animation: fadeIn 0.18s ease;
}

.help-modal {
  position: fixed;
  top: 14vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(420px, calc(100vw - 32px));
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
  z-index: 301;
  overflow: hidden;
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
  border-bottom: 1px solid var(--border);
}

.help-title {
  font-size: 1rem;
  font-weight: 700;
}

.help-close {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  transition: all var(--dur) var(--ease);
}

.help-close:hover {
  color: var(--accent);
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
  background: var(--bg-soft);
  border: 1px solid var(--border);
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
  border-top: 1px solid var(--border);
  font-size: 0.76rem;
  color: var(--text-3);
  text-align: center;
}
</style>
