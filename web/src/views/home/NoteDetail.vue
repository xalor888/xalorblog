<template>
  <div class="note-detail">
    <div class="home-container narrow">
      <div class="back-row">
        <router-link to="/notes" class="back-link"><XIcon name="ArrowLeft" :size="15" /> 全部手记</router-link>
      </div>

      <div v-if="loading" class="skeleton-detail">
        <div class="sk sk-head"></div>
        <div class="sk"></div>
        <div class="sk"></div>
        <div class="sk short"></div>
      </div>

      <div v-else-if="notFound" class="empty-card sg-liquid">
        <p class="empty-code">404</p>
        <p>这条手记不存在，或者已被隐藏。</p>
        <router-link to="/notes" class="back-btn">返回手记列表</router-link>
      </div>

      <!-- 读失败（429 刮取窗 / 403 闸门 / 网络错误）必须有独立分支。
           若与 404 共用 v-else 落到下面的 article，note 仍是 null，
           模板读 note.published_at 会抛渲染异常 → 整页空白 -->
      <div v-else-if="!note" class="empty-card sg-liquid">
        <p class="empty-code">!</p>
        <p>{{ failedHint }}</p>
        <button class="back-btn" @click="reload">重试</button>
        <router-link to="/notes" class="back-btn">返回手记列表</router-link>
      </div>

      <article v-else class="note-article sg-liquid">
        <header class="na-head">
          <img class="na-avatar" :src="avatar" alt="" />
          <div class="na-who">
            <span class="na-name">{{ authorName }}</span>
            <span class="na-meta">
              <time :datetime="note.published_at">{{ formatDateTime(note.published_at) }}</time>
              <span v-if="note.location" class="na-tag"><XIcon name="MapPin" :size="11" />{{ note.location }}</span>
              <span v-if="note.mood" class="na-tag mood">{{ note.mood }}</span>
            </span>
          </div>
          <span v-if="note.is_pinned" class="na-pin" title="置顶"><XIcon name="Pin" :size="14" /></span>
        </header>

        <div v-if="note.content_decrypt_failed" class="decrypt-warn">
          正文解密失败（安全通道可能已失效），请刷新页面后重试。
        </div>
        <div v-else class="markdown-body na-body" v-html="rendered" @click="onBodyClick"></div>

        <NoteImages v-if="images.length" :images="images" class="na-images" />

        <footer class="na-foot">
          <button class="like-btn" :class="{ liked }" :disabled="liking" @click="onLike">
            <XIcon name="Heart" :size="16" /> {{ note.likes || 0 }}
          </button>
          <button class="share-btn" @click="copyLink">
            <XIcon :name="copied ? 'Check' : 'Link'" :size="15" /> {{ copied ? '已复制' : '复制链接' }}
          </button>
        </footer>
      </article>
    </div>

    <ImageLightbox ref="lightboxRef" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import ImageLightbox from '@/components/ui/ImageLightbox.vue';
import NoteImages from '@/components/home/NoteImages.vue';
import { noteApi } from '@/api';
import { useHomeStore } from '@/stores/home';
import { renderMarkdown, addImgAttrs } from '@/utils/markdown';
import { formatDateTime } from '@/utils/format';

const route = useRoute();
const home = useHomeStore();

const note = ref(null);
const loading = ref(true);
const notFound = ref(false);
/** 读失败的原因文案（429 与其它错误要区分，前者是「稍后再来」而非「坏了」） */
const failedHint = ref('手记加载失败，请稍后重试。');
const liked = ref(false);
const liking = ref(false);
const copied = ref(false);
const lightboxRef = ref(null);

const avatar = computed(() => home.summary?.avatar || '/logo-256.webp');
const authorName = computed(() => home.summary?.site_name || 'Xalor');
const images = computed(() => (Array.isArray(note.value?.images) ? note.value.images.filter(Boolean) : []));
const rendered = computed(() => addImgAttrs(renderMarkdown(note.value?.content || '')));

async function load(id) {
  loading.value = true;
  notFound.value = false;
  note.value = null;
  try {
    note.value = await noteApi.detail(id);
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404) {
      notFound.value = true;
    } else if (status === 429) {
      failedHint.value = '阅读过于频繁，请稍等一会儿再试。';
    } else {
      failedHint.value = '手记加载失败，请稍后重试。';
    }
  } finally {
    loading.value = false;
  }
}

function reload() {
  load(route.params.id);
}

async function onLike() {
  if (liking.value || liked.value || !note.value) return;
  liking.value = true;
  try {
    const data = await noteApi.like(note.value.id);
    note.value.likes = data?.likes ?? note.value.likes;
    liked.value = true;
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    liking.value = false;
  }
}

function onBodyClick(e) {
  const img = e.target.closest('img');
  if (img) lightboxRef.value?.open(img.src, img.alt);
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1800);
  } catch (e) { /* 剪贴板不可用时忽略 */ }
}

watch(() => route.params.id, (id) => { if (id) load(id); });
onMounted(() => {
  home.load();
  load(route.params.id);
});
</script>

<style scoped>
.note-detail { width: 100%; }
.narrow { max-width: 760px; }
.back-row { margin-bottom: 14px; }
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13.5px;
  color: var(--text-3);
  text-decoration: none;
  transition: color var(--dur) var(--ease);
}
.back-link:hover { color: var(--accent-deep); }

.note-article {
  padding: 20px 22px 16px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--card-trans);
  box-shadow: var(--shadow-1);
}
.na-head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.na-avatar {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  border: 1px solid var(--border);
}
.na-who { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.na-name {
  font-size: 15px;
  font-weight: 650;
  /* 同卡片：站名过长必须截断，否则详情页头部会把整页顶宽 */
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.na-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-3);
  min-width: 0;
}
.na-tag { overflow-wrap: anywhere; }
.na-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-soft);
}
.na-tag.mood { background: var(--accent-soft); color: var(--accent-deep); }
.na-pin { margin-left: auto; color: var(--accent); }

.na-body { margin-top: 14px; }
.na-images { margin-top: 14px; }

.decrypt-warn {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 13.5px;
}

.na-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.like-btn, .share-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 13.5px;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.like-btn:hover:not(:disabled), .share-btn:hover { color: var(--accent-deep); border-color: var(--accent); }
.like-btn.liked { color: var(--accent); border-color: var(--accent); }
.like-btn:disabled { cursor: default; }
.share-btn { margin-left: auto; }

.skeleton-detail {
  padding: 20px 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card-trans);
  display: grid;
  gap: 12px;
}
.sk {
  height: 16px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-soft) 25%, var(--card) 50%, var(--bg-soft) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s linear infinite;
}
.sk-head { height: 46px; }
.sk.short { width: 45%; }
@keyframes shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.empty-card {
  text-align: center;
  padding: 40px 22px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--card-trans);
}
.empty-code {
  margin: 0 0 6px;
  font-family: var(--font-mono);
  font-size: 32px;
  font-weight: 700;
  color: var(--accent);
}
.empty-card p { margin: 0; color: var(--text-2); font-size: 14px; }
.back-btn {
  display: inline-block;
  margin: 16px 6px 0;
  padding: 8px 18px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-family: inherit;
  font-size: 13.5px;
  text-decoration: none;
  cursor: pointer;
}
.back-btn:hover { color: var(--accent-deep); border-color: var(--accent); }

@media (max-width: 560px) {
  .note-article { padding: 16px 14px 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .sk { animation: none; }
}
</style>
