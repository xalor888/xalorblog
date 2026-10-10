<template>
  <article class="note-card sg-liquid" :class="{ pinned: note.is_pinned }">
    <header class="nc-head">
      <img class="nc-avatar" :src="avatar" alt="" loading="lazy" />
      <div class="nc-who">
        <span class="nc-name">{{ authorName }}</span>
        <span class="nc-meta">
          <time :datetime="note.published_at">{{ timeAgo(note.published_at) }}</time>
          <span v-if="note.location" class="nc-loc"><XIcon name="Globe" :size="11" />{{ note.location }}</span>
        </span>
      </div>
      <span v-if="note.is_pinned" class="nc-pin" title="置顶"><XIcon name="Pin" :size="13" /></span>
      <span v-if="note.mood" class="nc-mood">{{ note.mood }}</span>
    </header>

    <router-link :to="`/notes/${note.id}`" class="nc-body">
      <p class="nc-excerpt">{{ note.excerpt }}<span v-if="truncated" class="nc-more">…… 展开</span></p>
      <!-- 卡片只出首图 + 余数角标：九宫格与灯箱留给详情页，
           列表里铺满九宫格会把时间线拉得很长，也失去「扫一眼」的节奏 -->
      <div v-if="note.cover" class="nc-cover">
        <img :src="note.cover" alt="" loading="lazy" decoding="async" />
        <span v-if="note.image_count > 1" class="nc-count">+{{ note.image_count - 1 }}</span>
      </div>
    </router-link>

    <footer class="nc-foot">
      <router-link :to="`/notes/${note.id}`" class="nc-action">查看全文 <XIcon name="ArrowRight" :size="13" /></router-link>
      <button class="nc-action like" :class="{ liked: liked }" :disabled="liking" @click="onLike">
        <XIcon name="Heart" :size="14" />{{ note.likes || 0 }}
      </button>
    </footer>
  </article>
</template>

<script setup>
import { computed, ref } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { timeAgo } from '@/utils/format';

const props = defineProps({
  note: { type: Object, required: true },
  avatar: { type: String, default: '' },
  authorName: { type: String, default: 'Xalor' },
  /**
   * 点赞动作（异步函数，由父组件注入）。
   * 用函数 prop 而不是 emit：emit 没有返回值，`await emit(...)` 会立刻 resolve，
   * 接口失败（如 429 频繁点赞）也会把按钮标记成「已赞」且计数不更新。
   * 这里 await 真正的请求，失败就不置位，用户可以直接重试。
   */
  likeAction: { type: Function, default: null },
});

const liked = ref(false);
const liking = ref(false);

const truncated = computed(() => String(props.note.excerpt || '').length >= 200);

async function onLike() {
  if (liking.value || liked.value || !props.likeAction) return;
  liking.value = true;
  try {
    await props.likeAction(props.note);
    liked.value = true;
  } catch (e) {
    /* 失败原因由 api 拦截器统一提示（429 会给出「太频繁」） */
  } finally {
    liking.value = false;
  }
}
</script>

<style scoped>
.note-card {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius);
  padding: 14px 16px 10px;
  background: var(--card-trans);
  box-shadow: var(--shadow-1);
  transition: box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.note-card:hover {
  box-shadow: var(--shadow-2);
  transform: translateY(-2px);
}
.note-card.pinned {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--glass-border));
}

.nc-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.nc-avatar {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.nc-who {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.nc-name {
  font-size: 14px;
  font-weight: 620;
  color: var(--text);
  /* 卡片头部显示的是「站名」——后台可填的自由文本。
     不截断的话，一个 40 字不带空格的站名在 390px 屏上会把整页顶出 200px 横向滚动 */
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3);
}
.nc-loc {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.nc-mood {
  margin-left: auto;
  max-width: 45%;
  overflow-wrap: anywhere;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-deep);
  flex-shrink: 0;
}
.nc-pin {
  color: var(--accent);
  display: inline-flex;
  margin-left: auto;
}
.nc-pin + .nc-mood { margin-left: 0; }

.nc-body {
  display: block;
  text-decoration: none;
  color: inherit;
  margin-top: 10px;
}
.nc-excerpt {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.72;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.nc-more {
  color: var(--accent-deep);
  font-size: 13px;
}
.nc-cover {
  position: relative;
  margin-top: 10px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border);
  max-height: 220px;
}
.nc-cover img {
  width: 100%;
  height: 100%;
  max-height: 220px;
  object-fit: cover;
  display: block;
}
.nc-count {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
}

.nc-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.nc-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.nc-action:hover {
  color: var(--accent-deep);
  background: var(--accent-soft);
}
.nc-action.like { margin-left: auto; font-variant-numeric: tabular-nums; }
.nc-action.like.liked { color: var(--accent); }
.nc-action:disabled { cursor: default; opacity: 0.8; }
</style>
