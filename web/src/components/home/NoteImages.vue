<template>
  <div v-if="list.length" class="note-images" :class="`n-${Math.min(list.length, 9)}`">
    <button
      v-for="(src, i) in list"
      :key="src + i"
      type="button"
      class="ni-cell"
      :aria-label="`查看第 ${i + 1} 张图片`"
      @click="open(i)"
    >
      <img :src="src" alt="" loading="lazy" decoding="async" />
    </button>
    <ImageLightbox ref="lightboxRef" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import ImageLightbox from '@/components/ui/ImageLightbox.vue';

const props = defineProps({
  images: { type: Array, default: () => [] },
});

const list = computed(() => (Array.isArray(props.images) ? props.images.filter(Boolean).slice(0, 9) : []));
const lightboxRef = ref(null);

function open(index) {
  const src = list.value[index];
  if (src) lightboxRef.value?.open(src, '');
}
</script>

<style scoped>
.note-images {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.n-1 { grid-template-columns: 1fr; }
.n-2, .n-4 { grid-template-columns: repeat(2, 1fr); }
.n-3, .n-5, .n-6, .n-7, .n-8, .n-9 { grid-template-columns: repeat(3, 1fr); }

.ni-cell {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-soft);
  cursor: zoom-in;
  aspect-ratio: 1 / 1;
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.ni-cell:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.ni-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* 单图不裁切：保留原始比例，避免人物/截图被裁掉 */
.n-1 .ni-cell {
  aspect-ratio: auto;
  max-height: 420px;
}
.n-1 .ni-cell img {
  height: auto;
  max-height: 420px;
  object-fit: contain;
  background: var(--bg-soft);
}
@media (max-width: 560px) {
  .n-3, .n-5, .n-6, .n-7, .n-8, .n-9 { grid-template-columns: repeat(3, 1fr); }
}
</style>
