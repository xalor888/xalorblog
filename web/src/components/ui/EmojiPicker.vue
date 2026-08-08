<template>
  <div class="emoji-picker">
    <div v-for="group in groups" :key="group.name" class="emoji-group">
      <span class="emoji-group-label">{{ group.name }}</span>
      <div class="emoji-row">
        <button
          v-for="e in group.items"
          :key="e"
          class="emoji-btn"
          type="button"
          :title="e"
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
  width: 30px;
  height: 30px;
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
