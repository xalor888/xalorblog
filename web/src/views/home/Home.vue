<template>
  <div class="home-page">
    <div class="home-container">
      <!-- ============ 名片：圆环 ============
           不要和博客一样的「大图 + 深色玻璃板」：这里整块不打底，
           用一圈玻璃圆环把头像框住，信息落在环下的页面上。
           环是 mask-composite 挖出来的环带（同 main.css 亮环那套语法），
           所以它能吃到 backdrop-filter，也天然跟随圆形。 -->
      <section class="hero-zone" aria-label="个人名片">
        <div class="orbit">
          <!-- 环外再走一条强调色弧：这是「圆环」这套视觉的签名，
               也让淡色环在一张浅底上真的看得见边缘 -->
          <div class="orbit-arc" aria-hidden="true"></div>
          <div ref="orbitRing" class="orbit-ring">
            <span class="orbit-sheen" aria-hidden="true"></span>
          </div>
          <div class="orbit-core">
            <img class="hero-avatar" :src="avatar" :alt="siteName" />
            <span class="hero-status" :class="statusClass" :title="statusText"></span>
          </div>
        </div>

        <p class="hero-kicker">{{ hero.greeting || "Hi, I'm" }}</p>
        <h1 class="hero-title">{{ siteName }}</h1>
        <p v-if="hero.role" class="hero-role">{{ hero.role }}</p>
        <p class="hero-quote">{{ hero.quote || siteDesc }}</p>

        <div class="hero-actions">
          <a v-if="social.github" class="hero-btn primary" :href="social.github" target="_blank" rel="noopener noreferrer">
            <XIcon name="Github" :size="16" /> GitHub
          </a>
          <a v-if="social.email" class="hero-btn" :href="`mailto:${social.email}`">
            <XIcon name="Mail" :size="16" /> 邮箱
          </a>
          <a v-for="s in social.extra" :key="s.url" class="hero-btn" :href="s.url" target="_blank" rel="noopener noreferrer">
            <XIcon name="Link2" :size="15" /> {{ s.label }}
          </a>
          <a class="hero-btn ghost" :href="blogUrl('articles')">
            阅读文章 <XIcon name="ArrowUpRight" :size="14" />
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
import { computed, onMounted, ref, watchEffect } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import NoteCard from '@/components/home/NoteCard.vue';
import { useLens } from '@/composables/useLens';
import { useHomeStore } from '@/stores/home';
import { noteApi } from '@/api';
import { blogUrl } from '@/utils/siteLinks';
import { timeAgo } from '@/utils/format';
import { applyPageMeta } from '@/utils/pageMeta';

const home = useHomeStore();

/* 折射挂在**环**上，不是挂在整块名片上：环带只有 18px 厚，
   所以 bevel 就取环宽（18）、位移只给 12 —— 再大就会跨过环心、把中间的空洞也拖歪。
   参数显式给，别让它按短边自动算（自动值会是 79，等于环宽的 4 倍）。 */
const orbitRing = ref(null);
useLens(orbitRing, { bevel: 18, maxShift: 12, blur: 16, saturate: 1.4, dispersion: 0.08 });
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


/**
 * 个人主页首页的 meta。
 *
 * 这个入口原先连 document.title 都没设，标签页靠 home.html 那句静态标题，
 * og:image / canonical 全缺 —— 主页是整个站点最可能被直接分享的地址之一。
 * 标题就是主页本身，所以不重复传 title（避免「X · X」）。
 */
watchEffect(() => {
  const st = home.summary || {};
  const siteName = st.site_name || 'Xalor 的个人主页';
  document.title = siteName;
  applyPageMeta({
    description: st.site_desc || '',
    path: '/',
    site: { settings: { site_name: siteName } },
  });
});
onMounted(() => {
  home.load();
  // 票据换取是异步的：ensurePass 已在入口预热，这里直接发起即可
  loadNotes();
});
</script>

<style scoped>
/* ============================================================================
   个人主页 · 圆环名片
   ----------------------------------------------------------------------------
   不再沿用博客那套「通栏大图 + 深色玻璃板」—— 那是博客的语言，搬到这里只是
   把同一个版式再做一遍。这一版只用**一圈玻璃环**：头像在环心，信息落在环下，
   整页没有一块压在图上的深色底板。

   环的做法：`padding: 18px` + 两层 mask（content-box ⊕ border-box）挖出环带，
   `border-radius: 50%` 让它天然是圆的；环上同时开 `backdrop-filter`，
   所以环带里的背景是被折射/模糊过的，而不是涂一层白。
   ============================================================================ */

.home-page {
  width: 100%;
  position: relative;
  /* 底部浮钮 / 环上的微光都用绝对定位，窄屏时别让它们把页面撑出横向滚动 */
  max-width: 100vw;
  overflow-x: clip;
}

/* ============ 名片 ============ */
.hero-zone {
  text-align: center;
  padding: 10px 0 4px;
}

.orbit {
  position: relative;
  width: 240px;
  height: 240px;
  margin: 2px auto 8px;
}

/* 环带本体：玻璃材质 + 亮边，挖空环心 */
.orbit-ring,
.orbit-sheen {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  padding: 16px;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}

.orbit-ring {
  /* 背后是一张很浅的纸，纯白玻璃几乎看不见 —— 这里把面加一点色温与描边，
     环才有「一圈实体」的边界，而不是一团雾。 */
  background: var(--sg-sheen), var(--sg-tint), var(--sg-surface),
    color-mix(in srgb, var(--accent) 7%, transparent);
  border: 1px solid var(--sg-edge);
  box-shadow: var(--sg-inner), 0 18px 44px rgba(26, 24, 20, 0.10);
  backdrop-filter: var(--sg-blur-soft);
  -webkit-backdrop-filter: var(--sg-blur-soft);
}

/* 折射（Chromium）：`useLens` 判定引擎后才写 data-lens；
   Safari / Firefox 上它永远不在，看到的就是上面那条普通雾面环。 */
.orbit-ring[data-lens] {
  backdrop-filter: var(--lens-chain, var(--sg-blur-soft));
  -webkit-backdrop-filter: var(--lens-chain, var(--sg-blur-soft));
}

/* 强调色弧：环外 6px 处一条 2px 宽的弧，占圆周约 26%，缓慢自转 */
.orbit-arc {
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  padding: 2px;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  background: conic-gradient(
    from 0deg,
    color-mix(in srgb, var(--accent) 85%, transparent) 0deg,
    color-mix(in srgb, var(--accent) 0%, transparent) 92deg,
    transparent 360deg
  );
  animation: orbit-spin 18s linear infinite;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .orbit-arc { animation: none; }
}

/* 环上一道缓慢绕行的镜面高光 —— 「液态」的那口气，只画在环带上 */
.orbit-sheen {
  background: conic-gradient(
    from 0deg,
    rgba(255, 255, 255, 0) 0deg,
    rgba(255, 255, 255, 0.55) 54deg,
    rgba(255, 255, 255, 0) 128deg,
    rgba(255, 255, 255, 0) 250deg,
    rgba(255, 255, 255, 0.3) 310deg,
    rgba(255, 255, 255, 0) 360deg
  );
  animation: orbit-spin 14s linear infinite;
  pointer-events: none;
}
@keyframes orbit-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .orbit-sheen { animation: none; }
}

/* 环心：头像 + 状态点 */
.orbit-core {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}
.hero-avatar {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--line);
  background: var(--card);
  box-shadow:
    0 14px 34px rgba(26, 24, 20, 0.16),
    0 0 0 1px color-mix(in srgb, var(--card) 90%, transparent);
}
.hero-status {
  position: absolute;
  right: 44px;
  bottom: 48px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid var(--card);
}
.hero-status.is-online { background: #10b981; }
.hero-status.is-busy { background: #ef4444; }
.hero-status.is-away { background: #f59e0b; }
.hero-status.is-offline { background: #94a3b8; }

.hero-kicker {
  margin: 10px 0 0;
  font-size: 11.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.hero-title {
  margin: 4px 0 2px;
  font-size: clamp(1.6rem, 4vw, 2.05rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--text);
}
.hero-role {
  margin: 0;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: var(--accent-text);
}
.hero-quote {
  margin: 8px auto 0;
  max-width: 24em;
  font-size: 14px;
  line-height: 1.75;
  color: var(--text-2);
}
/* 站名/身份/签名都是后台自由文本：一个 120 字不带空格的串必须能断行 */
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
  margin-top: 16px;
}
.hero-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 13px;
  text-decoration: none;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.hero-btn:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-text);
  transform: translateY(-1px);
}
.hero-btn.primary {
  background: var(--accent-fill);
  border-color: transparent;
  color: var(--accent-contrast);
}
.hero-btn.primary:hover { color: var(--accent-contrast); }
.hero-btn.ghost { background: transparent; }
.hero-btn.ghost:hover { background: var(--accent-soft); }

.hero-retry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.hero-retry:hover { border-color: var(--accent); color: var(--accent-text); }

/* 统计：每个数字放进一枚小圆环里，和上面的环呼应 */
.hero-meta {
  display: flex;
  justify-content: center;
  gap: 18px;
  margin-top: 18px;
  font-size: 12.5px;
  color: var(--text-3);
}
.hero-meta span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.hero-meta b {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--sg-sheen), var(--sg-surface);
  border: 1px solid var(--sg-hairline);
  box-shadow: var(--sg-inner);
  color: var(--text);
  font-size: 12px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

/* ============ 版块：内容层用实色卡片，不用玻璃 ============ */
.block {
  margin-top: 16px;
  padding: 16px;
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--card);
  box-shadow: var(--shadow-1);
}
.block-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;
}
.block-head h2 {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--text);
}
.block-head h2 :deep(svg) { color: var(--accent-text); }
.block-more {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  /* 触摸目标：原来 42×23，手指点「全部 / 更多 / 详情」经常落空。
     视觉上字号不变，靠 min-height + 负 margin 把可点区域撑到 40px，
     不改变这一行的排版节奏。 */
  min-height: 40px;
  margin-top: -8px;
  margin-bottom: -8px;
  padding: 0 2px;
  font-size: 12.5px;
  color: var(--text-3);
  text-decoration: none;
  transition: color var(--dur) var(--ease);
}
.block-more:hover { color: var(--accent-text); }

.note-list { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
.skeleton-list { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
.skeleton {
  height: 100px;
  border-radius: 14px;
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
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
  border: 1px dashed var(--line);
  border-radius: 14px;
}

/* ============ 文章列表：行在卡片里，所以行本身不再叠一层框 ============ */
.post-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  /* 一定要显式给列：grid 的隐式列是 `auto`，会被标题的 max-content 撑开，
     390 宽的屏上曾经把行撑到 562（整页横向溢出 187px、标题被切在屏幕外）。
     minmax(0, 1fr) 才允许行比内容窄，`text-overflow: ellipsis` 这时才生效。 */
  grid-template-columns: minmax(0, 1fr);
}
.post-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
  text-decoration: none;
  color: inherit;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.post-item:hover {
  background: var(--accent-soft);
  transform: translateX(2px);
}
.post-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.post-title {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.post-summary {
  font-size: 12px;
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
  width: 52px;
  height: 38px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
}

/* ============ 友链 / 关于 ============ */
.duo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 16px;
}
.duo > .block { margin-top: 0; }
/* 没有友链时只剩「关于」一张卡：单列铺满，否则右半边留一大块空白 */
.duo.single { grid-template-columns: 1fr; }
.link-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 6px;
}
.link-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 6px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
  text-decoration: none;
  color: var(--text-2);
  font-size: 12.5px;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.link-item:hover { background: var(--accent-soft); color: var(--accent-text); }
.link-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.link-avatar.fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 700;
}
.link-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.about-text {
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-2);
}

/* ============ 窄屏：环收小一档，其余照旧 ============ */
@media (max-width: 640px) {
  .orbit { width: 200px; height: 200px; }
  .orbit-ring, .orbit-sheen { padding: 13px; }
  .hero-avatar {
    width: 116px;
    height: 116px;
    box-shadow:
      0 10px 24px rgba(26, 24, 20, 0.14),
      0 0 0 8px color-mix(in srgb, var(--card) 55%, transparent);
  }
  .hero-status { right: 40px; bottom: 44px; }
  .hero-meta { gap: 14px; font-size: 12px; }
  .block { padding: 14px; }
  .duo { grid-template-columns: 1fr; }
  .post-cover { display: none; }
}
</style>
