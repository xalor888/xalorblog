<template>
  <div class="home-page">
    <!-- 名片下面需要「有东西可折射」的底图。个人主页原本只有一层彩色渐变，
         玻璃压上去等于白玻璃盖白纸 —— 透镜再准也看不见。
         所以这里补一条与博客同一张插画的通栏底图，向下渐隐进页面底色。 -->
    <div class="home-hero-bg" aria-hidden="true"></div>
    <div class="home-container">
      <!-- ============ 名片 ============ -->
      <section ref="heroCard" class="hero home-hero sg-liquid" aria-label="个人名片">
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

/* 名片是主页上唯一「压在大图上」的玻璃，参数照博客头图那组厚玻璃给：
   模糊压到 8px、位移 44px、色散 9% —— 够厚才看得见弯折。
   Safari / Firefox 上 `useLens` 不会挂（那两家不渲染 backdrop-filter: url(#f)），
   它们看到的是本来的 30px 雾面。 */
const heroCard = ref(null);
useLens(heroCard, { bevel: 64, maxShift: 44, blur: 8, saturate: 1.25, dispersion: 0.09 });
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
   个人主页 · 版式
   ----------------------------------------------------------------------------
   上一版的问题（重写的原因）：
     · 一张 1000px 宽、470px 高的暗色板压在图上，中间只有几行字 —— 像个灰盒子；
     · 底图从页顶铺到卡片尾部，卡片自己也压在同一块半透明的图里，整体糊成一片；
     · 下面的「最近手记 / 最近文章 / 朋友们」全是裸行直接落在页面底色上，
       没有容器，读者分不清哪里是一段、哪里是两段；
     · 名片的身份色用 #ffb4a2 压在灰玻璃上，几乎读不出颜色。
   现在：底图收成一条 400px 的「画带」，名片**窄一半**并骑在画带下沿，
   下面每个版块都是一张实色面板 —— 玻璃只出现在名片与顶栏（控件层），
   内容层按 Apple HIG 保持实色，读起来才不累。
   ============================================================================ */

.home-page {
  width: 100%;
  position: relative;
  /* 必须建立 BFC（flow-root）：名片的 `margin-top` 是「把卡片推到画带中间」用的，
     而这个页面链路上 .home-container / .home-page 都没有 padding/border，
     于是那个 margin 会**穿透两层父级塌陷出去**，把整页（连同绝对定位的画带）
     往下推 72px —— 表现就是顶栏和插画之间凭空多出一条灰带。
     flow-root 把塌陷关在 .home-page 里面。 */
  display: flow-root;
  /* 兜底：画带用 100vw 横铺，窄屏上如果父级 flex 的 min-content 被撑大，
     页面会横向溢出（实测 390 宽下 scrollWidth 曾到 577）。这里裁掉溢出，
     真正的修法在 Layout.vue 的 `.home-main { min-width: 0 }`。 */
  max-width: 100vw;
  overflow-x: clip;
}

/* 通栏画带：100vw 冲出 .home-container 的限宽，底部用 mask 化进页面底色。
   再叠一层向下的暗角，让骑在下沿的名片有对比，而不是直接压在亮部上。 */
.home-hero-bg {
  position: absolute;
  top: -30px;
  left: 50%;
  width: 100vw;
  height: 420px;
  transform: translateX(-50%);
  background:
    linear-gradient(to bottom, rgba(10, 9, 8, 0) 46%, rgba(10, 9, 8, 0.42) 78%, rgba(10, 9, 8, 0.8) 100%),
    #14110e url('@/assets/hero.webp') center 36% / cover no-repeat;
  /* 上沿不做渐隐：底图正好落在顶栏下沿，让它是一条干净的「画带」。
     之前试过顶部也淡出，结果页面底色（浅灰）从缝里透出来，反而多出一条灰带。 */
  -webkit-mask-image: linear-gradient(to bottom, #000 0 70%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0 70%, transparent 100%);
  pointer-events: none;
  z-index: 0;
}

/* ============ 名片 ============ */
.hero {
  position: relative;
  /* 窄、且向下压：盖住画带的下沿再落回页面底色 —— 这张卡才像「浮在图上」，
     而不是「图里挖了一块」。 */
  max-width: 540px;
  margin: 48px auto 0;
  padding: 24px 22px 20px;
  text-align: center;
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  /* 三层：镜面高光 → 文字区压暗（保证白字在亮部也可读）→ 玻璃本体的暗渐变。
     只有第二层是「为了可读性」的，它从卡片下半部开始压，上半部仍让插画透进来。 */
  background:
    radial-gradient(120% 80% at 18% -10%, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0) 56%),
    linear-gradient(to bottom, rgba(10, 9, 8, 0) 30%, rgba(10, 9, 8, 0.42) 62%, rgba(10, 9, 8, 0.5) 100%),
    linear-gradient(162deg, rgba(20, 17, 15, 0.34) 0%, rgba(14, 12, 10, 0.22) 48%, rgba(22, 19, 16, 0.38) 100%);
  box-shadow:
    0 26px 70px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.3),
    inset 0 0 40px rgba(255, 255, 255, 0.06),
    inset 0 -1px 1px rgba(255, 255, 255, 0.05);
  color: #fff;
  backdrop-filter: blur(26px) saturate(1.4);
  -webkit-backdrop-filter: blur(26px) saturate(1.4);
}

/* 折射（Chromium）：`useLens` 判定引擎后才写 data-lens；Safari/Firefox 上它永远不在，
   那就是上面那条普通雾面 —— 两种形态各自完整。 */
.hero[data-lens] {
  backdrop-filter: var(--lens-chain, blur(26px) saturate(1.4));
  -webkit-backdrop-filter: var(--lens-chain, blur(26px) saturate(1.4));
}

/* 头像：外圈一圈亮线当「玻璃匙扣」，比两像素白描边更像材质 */
.hero-avatar-wrap {
  position: relative;
  width: 68px;
  height: 68px;
  margin: 0 auto 10px;
}
.hero-avatar {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}
.hero-status {
  position: absolute;
  right: 3px;
  bottom: 4px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid rgba(20, 17, 15, 0.9);
}
.hero-status.is-online { background: #34d399; }
.hero-status.is-busy { background: #f87171; }
.hero-status.is-away { background: #fbbf24; }
.hero-status.is-offline { background: #94a3b8; }

.hero-kicker {
  margin: 0;
  font-size: 11.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.6);
  font-family: var(--font-mono);
}
.hero-title {
  margin: 4px 0 2px;
  font-size: clamp(1.55rem, 3.4vw, 1.95rem);
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.25;
  text-shadow: 0 1px 10px rgba(0, 0, 0, 0.35);
}
.hero-role {
  margin: 0;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--accent) 42%, #fff);
}
.hero-quote {
  margin: 8px auto 0;
  max-width: 26em;
  font-size: 14px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.76);
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
  margin-top: 16px;
}
.hero-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: rgba(255, 255, 255, 0.10);
  color: rgba(255, 255, 255, 0.92);
  font-size: 13px;
  text-decoration: none;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.hero-btn:hover {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.46);
  transform: translateY(-1px);
}
.hero-btn.primary {
  background: var(--accent-fill);
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  color: var(--accent-contrast);
}
.hero-btn.primary:hover { background: color-mix(in srgb, var(--accent-fill) 88%, #fff); }
.hero-btn.ghost { background: transparent; }

.hero-retry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.26);
  background: rgba(255, 255, 255, 0.10);
  color: rgba(255, 255, 255, 0.9);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.hero-retry:hover { background: rgba(255, 255, 255, 0.18); }

/* 统计条：细线分隔，不做成第二个盒子 */
.hero-meta {
  display: flex;
  justify-content: center;
  gap: 0;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.6);
}
.hero-meta span {
  padding: 0 16px;
}
.hero-meta span + span {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}
.hero-meta b {
  color: #fff;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  margin-right: 4px;
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

/* ============ 窄屏：画带收短，名片完全落进页面底色 ============ */
@media (max-width: 640px) {
  .home-hero-bg {
    height: 300px;
    background-position: center 24%;
    -webkit-mask-image: linear-gradient(to bottom, #000 0 52%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0 52%, transparent 100%);
  }
  .hero {
    margin-top: 56px;
    padding: 22px 18px 18px;
    border-radius: 20px;
  }
  .hero-avatar-wrap,
  .hero-avatar { width: 66px; height: 66px; }
  .hero-meta { gap: 0; font-size: 12px; }
  .hero-meta span { padding: 0 12px; }
  .block { padding: 14px; }
  .duo { grid-template-columns: 1fr; }
  .post-cover { display: none; }
}
</style>
