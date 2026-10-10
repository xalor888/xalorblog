<template>
  <div class="home-page">
    <div class="home-container">
      <!-- ============ 名片 ============ -->
      <section class="hero sg-liquid" aria-label="个人名片">
        <div class="hero-avatar-wrap">
          <img class="hero-avatar" :src="avatar" :alt="siteName" />
          <span class="hero-status" :class="statusClass" :title="statusText"></span>
        </div>

        <p class="hero-kicker">{{ hero.greeting || "Hi, I'm" }}</p>
        <h1 class="hero-title">{{ siteName }}</h1>
        <p v-if="hero.role" class="hero-role">{{ hero.role }}</p>
        <p class="hero-quote">{{ hero.quote || siteDesc }}</p>

        <div class="hero-actions">
          <a v-if="social.github" class="hero-btn primary" :href="social.github" target="_blank" rel="noopener noreferrer">
            <XIcon name="Github" :size="17" /> GitHub
          </a>
          <a v-if="social.email" class="hero-btn" :href="`mailto:${social.email}`">
            <XIcon name="Mail" :size="17" /> 邮箱
          </a>
          <a v-for="s in social.extra" :key="s.url" class="hero-btn" :href="s.url" target="_blank" rel="noopener noreferrer">
            <XIcon name="Link2" :size="16" /> {{ s.label }}
          </a>
          <a class="hero-btn ghost" :href="blogUrl('articles')">
            阅读文章 <XIcon name="ArrowUpRight" :size="15" />
          </a>
        </div>

        <!-- 加载失败时不要显示「0 文章 0 手记」：那看起来像真实数据，会误导访客 -->
        <div v-if="!home.failed" class="hero-meta">
          <span><b>{{ stats.article_count || 0 }}</b> 文章</span>
          <span><b>{{ stats.note_count || 0 }}</b> 手记</span>
          <span v-if="runningDays"><b>{{ runningDays }}</b> 天</span>
        </div>
        <button v-else class="hero-retry" @click="retry">
          <XIcon name="RefreshCw" :size="14" /> 内容加载失败，点击重试
        </button>
      </section>

      <!-- ============ 最近手记 ============ -->
      <section class="block">
        <header class="block-head">
          <h2><XIcon name="MessageCircleHeart" :size="17" /> 最近手记</h2>
          <router-link to="/notes" class="block-more">全部 <XIcon name="ArrowRight" :size="13" /></router-link>
        </header>

        <div v-if="notesLoading" class="skeleton-list">
          <div v-for="i in 3" :key="i" class="skeleton"></div>
        </div>
        <div v-else-if="notes.length" class="note-list">
          <NoteCard
            v-for="n in notes"
            :key="n.id"
            :note="n"
            :avatar="avatar"
            :author-name="siteName"
            :like-action="onLike"
          />
        </div>
        <p v-else class="empty">
          {{ notesFailed ? '手记加载失败，请刷新页面重试' : '还没有手记，等待第一条 ✍️' }}
        </p>
      </section>

      <!-- ============ 最近文章 ============ -->
      <section v-if="recentPosts.length" class="block">
        <header class="block-head">
          <h2><XIcon name="FileText" :size="17" /> 最近文章</h2>
          <a class="block-more" :href="blogUrl('articles')">全部 <XIcon name="ArrowRight" :size="13" /></a>
        </header>
        <ul class="post-list">
          <li v-for="p in recentPosts" :key="p.id">
            <a class="post-item" :href="blogUrl(`article/${p.slug}`)">
              <div class="post-main">
                <span class="post-title">{{ p.title }}</span>
                <span v-if="p.summary" class="post-summary">{{ p.summary }}</span>
              </div>
              <time class="post-time" :datetime="p.published_at">{{ timeAgo(p.published_at) }}</time>
              <img v-if="p.cover" class="post-cover" :src="p.cover" alt="" loading="lazy" />
            </a>
          </li>
        </ul>
      </section>

      <!-- ============ 友链 + 关于 ============ -->
      <div class="duo" :class="{ single: !links.length }">
        <section v-if="links.length" class="block">
          <header class="block-head">
            <h2><XIcon name="Link2" :size="17" /> 朋友们</h2>
            <a class="block-more" :href="blogUrl('links')">更多 <XIcon name="ArrowRight" :size="13" /></a>
          </header>
          <div class="link-grid">
            <a v-for="l in links" :key="l.id" class="link-item" :href="l.url" target="_blank" rel="noopener noreferrer" :title="l.description">
              <img v-if="l.avatar" class="link-avatar" :src="l.avatar" alt="" loading="lazy" />
              <span v-else class="link-avatar fallback">{{ (l.name || '?').slice(0, 1) }}</span>
              <span class="link-name">{{ l.name }}</span>
            </a>
          </div>
        </section>

        <section class="block">
          <header class="block-head">
            <h2><XIcon name="User" :size="17" /> 关于我</h2>
            <a class="block-more" :href="blogUrl('about')">详情 <XIcon name="ArrowRight" :size="13" /></a>
          </header>
          <p class="about-text">{{ aboutText }}</p>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import NoteCard from '@/components/home/NoteCard.vue';
import { useHomeStore } from '@/stores/home';
import { noteApi } from '@/api';
import { blogUrl } from '@/utils/siteLinks';
import { timeAgo } from '@/utils/format';

const home = useHomeStore();
const notes = ref([]);
const notesLoading = ref(true);
const notesFailed = ref(false);

const siteName = computed(() => home.summary?.site_name || 'Xalor');
const siteDesc = computed(() => home.summary?.site_desc || '手记、日常和朋友');
const avatar = computed(() => home.summary?.avatar || '/logo-256.webp');
const hero = computed(() => home.summary?.hero || {});
// 服务端保存时已用 safeUrl 清洗过，这里再过滤一次协议：
// 万一设置表被直接改写，javascript:/data: 会随 <a href> 进入 DOM（纵深防御，成本两行）
const social = computed(() => {
  const raw = home.summary?.social || {};
  const extra = (Array.isArray(raw.extra) ? raw.extra : [])
    .filter((it) => it && /^https?:\/\//i.test(String(it.url || '')))
    .map((it) => ({ label: String(it.label || ''), url: String(it.url) }));
  return { ...raw, extra };
});
const stats = computed(() => home.summary?.stats || {});
const runningDays = computed(() => home.summary?.running_days || 0);
const aboutExcerpt = computed(() => home.summary?.about_excerpt || '');
// 「加载失败」和「后台还没填」是两回事，不能都显示成「还没有填写关于内容」
const aboutText = computed(() => {
  if (home.failed) return '内容加载失败，请点击上方重试。';
  return aboutExcerpt.value || '还没有填写关于内容。';
});
const links = computed(() => home.summary?.links || []);
const recentPosts = computed(() => home.summary?.recent_posts || []);

const STATUS = {
  online: { cls: 'online', text: '在线' },
  busy: { cls: 'busy', text: '忙碌' },
  away: { cls: 'away', text: '离开' },
  offline: { cls: 'offline', text: '离线' },
};
const statusClass = computed(() => `is-${(STATUS[hero.value.status] || STATUS.online).cls}`);
const statusText = computed(() => (STATUS[hero.value.status] || STATUS.online).text);

async function loadNotes() {
  notesLoading.value = true;
  notesFailed.value = false;
  try {
    // 手记走闸门（票据 + 签名）：票据就绪前会短暂等待，于是它出现在名片之后
    const data = await noteApi.list({ page: 1, pageSize: 6 });
    notes.value = data?.list || [];
  } catch (e) {
    notesFailed.value = true;
  } finally {
    notesLoading.value = false;
  }
}

/** 交给 NoteCard 调用：抛出异常即表示失败，卡片据此不标记「已赞」 */
async function onLike(note) {
  const data = await noteApi.like(note.id);
  note.likes = data?.likes ?? note.likes;
}

function retry() {
  home.load(true);
  loadNotes();
}

onMounted(() => {
  home.load();
  // 票据换取是异步的：ensurePass 已在入口预热，这里直接发起即可
  loadNotes();
});
</script>

<style scoped>
.home-page { width: 100%; }

/* ============ 名片 ============ */
.hero {
  text-align: center;
  padding: 34px 22px 28px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--card-trans);
  box-shadow: var(--shadow-1);
}
.hero-avatar-wrap {
  position: relative;
  width: 84px;
  height: 84px;
  margin: 0 auto 14px;
}
.hero-avatar {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--card);
  box-shadow: var(--shadow-1);
}
.hero-status {
  position: absolute;
  right: 4px;
  bottom: 6px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--card);
}
.hero-status.is-online { background: #10b981; }
.hero-status.is-busy { background: #ef4444; }
.hero-status.is-away { background: #f59e0b; }
.hero-status.is-offline { background: #94a3b8; }

.hero-kicker {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.hero-title {
  margin: 6px 0 4px;
  font-size: clamp(1.6rem, 4vw, 2.2rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.hero-role {
  margin: 0;
  font-size: 14px;
  color: var(--accent-deep);
}
.hero-quote {
  margin: 10px auto 0;
  max-width: 30em;
  font-size: 14.5px;
  line-height: 1.75;
  color: var(--text-2);
}
/* 站名/身份/签名都是后台自由文本：一个 120 字不带空格的串必须能断行，
   否则名片会把 .home-container 撑宽、整页横向滚动 */
.hero-title,
.hero-role,
.hero-quote {
  overflow-wrap: anywhere;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 18px;
}
.hero-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 13.5px;
  text-decoration: none;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.hero-btn:hover {
  color: var(--accent-deep);
  border-color: var(--accent);
  transform: translateY(-1px);
}
.hero-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast);
}
.hero-btn.primary:hover { color: var(--accent-contrast); }
.hero-btn.ghost { background: transparent; }

.hero-retry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 20px;
  padding: 7px 16px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.hero-retry:hover { color: var(--accent-deep); border-color: var(--accent); }

.hero-meta {
  display: flex;
  justify-content: center;
  gap: 22px;
  margin-top: 20px;
  font-size: 13px;
  color: var(--text-3);
}
.hero-meta b {
  color: var(--text);
  font-variant-numeric: tabular-nums;
  margin-right: 3px;
}

/* ============ 版块 ============ */
.block { margin-top: 26px; }
.block-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.block-head h2 {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.block-more {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  color: var(--text-3);
  text-decoration: none;
  transition: color var(--dur) var(--ease);
}
.block-more:hover { color: var(--accent-deep); }

.note-list {
  display: grid;
  gap: 12px;
}
.skeleton-list { display: grid; gap: 12px; }
.skeleton {
  height: 106px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: linear-gradient(90deg, var(--bg-soft) 25%, var(--card) 50%, var(--bg-soft) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
.empty {
  margin: 0;
  padding: 22px;
  text-align: center;
  font-size: 13.5px;
  color: var(--text-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

/* ============ 文章列表 ============ */
.post-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.post-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-trans);
  text-decoration: none;
  color: inherit;
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.post-item:hover {
  border-color: var(--accent);
  transform: translateX(2px);
}
.post-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.post-title {
  font-size: 14.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.post-summary {
  font-size: 12.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.post-time {
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
}
.post-cover {
  width: 54px;
  height: 40px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

/* ============ 友链 / 关于 ============ */
.duo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
/* 没有友链时只剩「关于」一张卡：单列铺满，否则右半边留一大块空白 */
.duo.single { grid-template-columns: 1fr; }
.link-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}
.link-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-trans);
  text-decoration: none;
  color: var(--text-2);
  font-size: 13px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.link-item:hover { border-color: var(--accent); color: var(--accent-deep); }
.link-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.link-avatar.fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent-deep);
  font-size: 12px;
  font-weight: 700;
}
.link-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.about-text {
  margin: 0;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-trans);
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 780px) {
  .duo { grid-template-columns: 1fr; gap: 0; }
  .hero { padding: 26px 16px 22px; }
  .hero-meta { gap: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton { animation: none; }
}
</style>
