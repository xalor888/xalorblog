<template>
  <router-link :to="`/article/${article.slug}`" class="article-card">
    <!-- 封面或文字排版 -->
    <div v-if="article.cover" class="cover">
      <img
        :src="article.cover"
        :alt="article.title"
        loading="lazy"
        decoding="async"
        class="cover-img"
        @load="$event.target.classList.add('loaded')"
        @error="$event.target.classList.add('failed')"
      />
      <div class="cover-shimmer"></div>
      <div class="cover-err" aria-hidden="true">
        <XIcon name="ImageOff" :size="22" />
      </div>
    </div>
    <div v-else class="cover cover-text" :class="'tone-' + (article.id % 6)">
      <span class="cover-quote">“</span>
      <p class="cover-excerpt">{{ excerpt }}</p>
      <span class="cover-line"></span>
    </div>

    <div class="body">
      <div class="meta-row">
        <span v-if="article.category_name" class="cat" :style="{ '--cat': article.category_color || 'var(--accent)' }">
          {{ article.category_name }}
        </span>
        <span v-else class="cat muted">未分类</span>
        <span class="date">{{ formatDate(article.published_at) }}</span>
      </div>

      <h3 class="title">{{ article.title }}</h3>
      <p class="summary">{{ article.summary }}</p>

      <div class="tags" v-if="article.tags.length">
        <span v-for="t in article.tags.slice(0, 2)" :key="t.id" class="tag"># {{ t.name }}</span>
      </div>

      <div class="foot">
        <span class="read-more">阅读全文 <XIcon name="ArrowRight" :size="14" /></span>
        <div class="stats">
          <span class="stat" title="阅读"><XIcon name="Eye" :size="14" /> {{ article.views }}</span>
          <span class="stat" title="评论"><XIcon name="MessageSquare" :size="14" /> {{ article.comment_count }}</span>
          <span class="stat" title="点赞"><XIcon name="Heart" :size="14" /> {{ article.likes }}</span>
        </div>
      </div>
    </div>

    <!-- 置顶角标 -->
    <span v-if="article.is_top" class="pin">
      <XIcon name="Pin" :size="13" />
    </span>

    <!-- 热门徽章 -->
    <span v-if="article.views >= 500" class="hot-badge">
      <XIcon name="Flame" :size="11" /> 热门
    </span>
  </router-link>
</template>

<script setup>
import { computed } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { formatDate } from '@/utils/format';

const props = defineProps({
  article: { type: Object, required: true },
});

// 无封面时的精选摘要（取摘要前 60 字；空摘要给友好占位）
const excerpt = computed(() => {
  const s = props.article.summary || '';
  if (!s) return '点击阅读全文 →';
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
});
</script>

<style scoped>
.article-card {
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow-1);
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease);
  position: relative;
}

.article-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-2);
  border-color: var(--line);
}

/* 封面图片 */
.cover {
  height: 168px;
  overflow: hidden;
  flex-shrink: 0;
  position: relative;
  background: var(--bg-soft);
}

/* 加载占位微光 */
.cover-shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--bg), transparent);
  background-size: 200% 100%;
  animation: coverShimmer 1.5s ease-in-out infinite;
  pointer-events: none;
}

@keyframes coverShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  filter: blur(12px);
  transform: scale(1.04);
  transition: opacity 0.5s var(--ease-out), filter 0.5s var(--ease-out), transform 0.7s var(--ease-out);
  position: relative;
  z-index: 1;
}

/* 加载完成：去模糊、清晰显现 */
.cover-img.loaded {
  opacity: 1;
  filter: blur(0);
  transform: scale(1);
}

/* 加载完成后隐藏微光 */
.cover-img.loaded + .cover-shimmer,
.cover:has(.cover-img.loaded) .cover-shimmer {
  opacity: 0;
  transition: opacity 0.3s;
}

/* 图片加载失败：隐藏破损图，显示占位 */
.cover-err {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  background: var(--bg-soft);
  z-index: 0;
}

.cover:has(.cover-img.failed) .cover-err {
  display: flex;
}

.cover:has(.cover-img.failed) .cover-img {
  display: none;
}

.article-card:hover .cover-img.loaded {
  transform: scale(1.05);
}

/* 无封面：抽象纹理排版（6 组低饱和色调 + 几何纹理） */
.cover-text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 22px 26px;
  gap: 8px;
  position: relative;
  overflow: hidden;
}

/* 几何纹理：细网点 */
.cover-text::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: radial-gradient(circle, currentColor 1px, transparent 1px);
  background-size: 14px 14px;
  opacity: 0.06;
  pointer-events: none;
}

/* 右上角装饰圆弧 */
.cover-text::after {
  content: '';
  position: absolute;
  top: -30px;
  right: -30px;
  width: 90px;
  height: 90px;
  border-radius: 50%;
  border: 1px solid currentColor;
  opacity: 0.1;
  pointer-events: none;
}

.tone-0 { background: #f5ede6; color: #c4754a; }
.tone-1 { background: #eef0e4; color: #6b7a3a; }
.tone-2 { background: #e8eef1; color: #3a6b7a; }
.tone-3 { background: #f3e9ee; color: #9a4a5e; }
.tone-4 { background: #edeaf3; color: #5a4a9a; }
.tone-5 { background: #f2efe4; color: #a0824a; }

[data-theme='dark'] .tone-0 { background: #2a241d; color: #d49a72; }
[data-theme='dark'] .tone-1 { background: #26281f; color: #9aa86a; }
[data-theme='dark'] .tone-2 { background: #1f2830; color: #6a9aaa; }
[data-theme='dark'] .tone-3 { background: #2a2126; color: #c47a8e; }
[data-theme='dark'] .tone-4 { background: #252130; color: #8a7ab8; }
[data-theme='dark'] .tone-5 { background: #292720; color: #b8985a; }

.cover-quote {
  font-family: Georgia, serif;
  font-size: 2.2rem;
  line-height: 1;
  color: currentColor;
  opacity: 0.55;
}

.cover-excerpt {
  font-size: 0.95rem;
  color: var(--text-2);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.cover-line {
  width: 34px;
  height: 3px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.7;
}

/* 内容 */
.body {
  padding: 20px 22px 18px;
  display: flex;
  flex-direction: column;
  flex: 1;
}

.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.cat {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cat);
  padding: 3px 10px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--cat) 10%, transparent);
}

.cat.muted {
  color: var(--text-3);
  background: none;
  padding: 0;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
}

.date {
  font-size: 0.78rem;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.title {
  font-size: 1.12rem;
  font-weight: 750;
  line-height: 1.5;
  letter-spacing: -0.01em;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  transition: color var(--dur) var(--ease);
}

.article-card:hover .title {
  color: var(--accent);
}

.summary {
  color: var(--text-2);
  font-size: 0.89rem;
  line-height: 1.75;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
}

.tags {
  display: flex;
  gap: 8px;
  margin: 12px 0 14px;
  min-height: 18px;
}

.tag {
  font-size: 0.76rem;
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}

.article-card:hover .tag {
  color: var(--text-2);
}

/* 底部 */
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.read-more {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--accent);
  opacity: 0.9;
}

.read-more :deep(svg) {
  transition: transform var(--dur) var(--ease);
}

.article-card:hover .read-more :deep(svg) {
  transform: translateX(3px);
}

.stats {
  display: flex;
  gap: 12px;
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.76rem;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* 图片封面底部渐变，增强纵深 */
.cover:not(.cover-text)::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 58%, rgba(20, 18, 14, 0.18));
  pointer-events: none;
  z-index: 1;
}

/* 热门徽章 */
.hot-badge {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 999px;
  background: linear-gradient(135deg, #ff8a3d, #ff4d4d);
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: 0 3px 10px rgba(255, 77, 77, 0.35);
}

/* 置顶角标 */
.pin {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(29, 27, 22, 0.72);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
}
</style>
