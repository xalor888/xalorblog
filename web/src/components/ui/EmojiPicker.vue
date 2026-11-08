<template>
  <div class="emoji-picker">
    <div v-for="group in groups" :key="group.name" class="emoji-group">
      <span class="emoji-group-label">{{ group.name }}</span>
      <div class="emoji-row">
        <!-- aria-label 而不是只靠 title：title 是鼠标悬停提示，
             触屏与读屏都不保证能拿到（部分读屏把 title 当 fallback，部分不认）。
             两个都留 —— title 给人看，aria-label 给辅助技术。 -->
        <button
          v-for="e in group.items"
          :key="e"
          class="emoji-btn"
          type="button"
          :title="e"
          :aria-label="'插入表情 ' + e"
          @click="$emit('insert', e)"
        >{{ e }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineEmits(['insert']);

// 精选常用表情（克制数量，避免选择器太重）；分组提升查找效率
const groups = [
  {
    name: '情绪',
    items: ['😀', '😂', '🤣', '😍', '🥰', '😎', '🤔', '😴', '😅', '🥺', '😭', '😡', '🤩', '🫡', '🤯', '👋'],
  },
  {
    name: '手势',
    items: ['👍', '👏', '🙌', '💪', '🤝', '🙏', '✌️', '🤞'],
  },
  {
    name: '物品',
    items: ['❤️', '🔥', '✨', '🎉', '💯', '☕', '🌟', '📌', '🐱', '🌸', '🌙', '🍀', '🎂', '🚀', '💡', '📚'],
  },
];
</script>

<style scoped>
.emoji-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
  padding: 8px 10px;
  background: var(--bg-soft);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

.emoji-group-label {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-3);
  letter-spacing: 0.08em;
}

.emoji-group + .emoji-group {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}

.emoji-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.emoji-btn {
  /* 30px 只过了 WCAG 2.5.8 的 24×24 下限，但配 4px 间距后中心距 34px —— 密集网格里
     手指容易点到隔壁。改成 32px 后中心距 36px，正好达到项目里 .emoji-toggle 的同一标准，
     而 8 列总宽 284px 仍在面板可用宽度内（flex-wrap 会自动换行）。
     不做到 36px 是因为 8 列 × 36 + 7 × 4 = 316px，窄屏上面板会被撑破换行成一列一列。 */
  width: 32px;
  height: 32px;
  border-radius: 7px;
  font-size: 1.15rem;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
}

.emoji-btn:hover {
  background: var(--card);
  transform: scale(1.2);
}
</style>
