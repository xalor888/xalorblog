<template>
  <div class="home-layout">
    <header class="home-nav sg-liquid" :class="{ scrolled }">
      <div class="home-container nav-inner">
        <router-link to="/" class="brand">
          <img class="brand-avatar" :src="avatar" alt="" />
          <span class="brand-name">{{ siteName }}</span>
        </router-link>

        <nav class="nav-links">
          <router-link
            v-for="item in localItems"
            :key="item.to"
            :to="item.to"
            class="nav-link"
            :class="{ active: isActive(item) }"
          >{{ item.label }}</router-link>
          <a
            v-for="item in crossItems"
            :key="item.href"
            :href="item.href"
            class="nav-link cross"
            rel="noopener"
          >{{ item.label }}<XIcon name="ArrowUpRight" :size="12" /></a>
        </nav>

        <div class="nav-actions">
          <button
            class="icon-btn"
            :title="theme.mode === 'auto' ? '跟随系统 · 点击切换亮色' : theme.isDark ? '点击切换自动' : '点击切换暗色'"
            @click="theme.toggleTheme"
          >
            <XIcon :name="theme.mode === 'auto' ? 'MonitorSmartphone' : theme.isDark ? 'Sun' : 'Moon'" :size="17" />
          </button>
          <a class="icon-btn" href="/api/rss.xml" target="_blank" rel="noopener noreferrer" title="RSS 订阅">
            <XIcon name="Rss" :size="17" />
          </a>
          <button class="hamburger" :class="{ open: mobileOpen }" :aria-expanded="mobileOpen" aria-label="菜单" @click="mobileOpen = !mobileOpen">
            <span></span><span></span><span></span>
          </button>
        </div>
      </div>

      <transition name="drawer">
        <nav v-if="mobileOpen" class="mobile-menu">
          <router-link
            v-for="item in localItems"
            :key="item.to"
            :to="item.to"
            class="mobile-link"
            :class="{ active: isActive(item) }"
            @click="mobileOpen = false"
          >{{ item.label }}</router-link>
          <a
            v-for="item in crossItems"
            :key="item.href"
            :href="item.href"
            class="mobile-link"
            @click="mobileOpen = false"
          >{{ item.label }}<XIcon name="ArrowUpRight" :size="13" /></a>
        </nav>
      </transition>
    </header>

    <main class="home-main">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in" :duration="{ enter: 240, leave: 200 }">
          <component :is="Component" :key="route.path" />
        </transition>
      </router-view>
    </main>

    <footer class="home-footer">
      <div class="home-container footer-inner">
        <div class="footer-brand">
          <img class="footer-avatar" :src="avatar" alt="" />
          <div>
            <p class="footer-name">{{ siteName }}</p>
            <p class="footer-desc">{{ siteDesc }}</p>
          </div>
        </div>

        <div class="footer-links">
          <a v-if="socialGithub" :href="socialGithub" target="_blank" rel="noopener noreferrer" class="footer-link">
            <XIcon name="Github" :size="15" /> GitHub
          </a>
          <a v-if="socialEmail" :href="`mailto:${socialEmail}`" class="footer-link">
            <XIcon name="Mail" :size="15" /> 邮箱
          </a>
          <a :href="blogUrl('articles')" class="footer-link">
            <XIcon name="FileText" :size="15" /> 博客文章
          </a>
          <a :href="blogUrl('links')" class="footer-link">
            <XIcon name="Link2" :size="15" /> 友情链接
          </a>
          <a :href="blogUrl('about')" class="footer-link">
            <XIcon name="User" :size="15" /> 关于我
          </a>
        </div>

        <!-- 摘要没加载成功时不要显示 0/0：看起来像真实数据，会误导访客 -->
        <div v-if="!home.failed" class="footer-stats">
          <span><b>{{ stats.article_count || 0 }}</b> 文章</span>
          <span><b>{{ stats.note_count || 0 }}</b> 手记</span>
          <span v-if="runningDays"><b>{{ runningDays }}</b> 天</span>
        </div>

        <div class="footer-bottom">
          <span>{{ footerText }}</span>
          <a v-if="icp" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer nofollow">{{ icp }}</a>
          <span class="powered">Designed with care · Vue 3</span>
        </div>
      </div>
    </footer>

    <Teleport to="#float-dock">
      <div class="side-tools-group">
        <button class="dock-btn tool-btn theme-tool" :title="theme.isDark ? '切换亮色' : '切换暗色'" @click="theme.toggleTheme">
          <XIcon :name="theme.isDark ? 'Sun' : 'Moon'" :size="18" />
        </button>
        <transition name="pop">
          <button v-if="showTop" class="dock-btn tool-btn back-top" title="回到顶部" aria-label="回到顶部" @click="scrollTop">
            <XIcon name="ArrowUp" :size="18" />
          </button>
        </transition>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import { useThemeStore } from '@/stores/theme';
import { useHomeStore } from '@/stores/home';
import { blogUrl } from '@/utils/siteLinks';

const route = useRoute();
const theme = useThemeStore();
const home = useHomeStore();

const mobileOpen = ref(false);
const scrolled = ref(false);
const showTop = ref(false);

// 本地路由项（主页域内部）；跨站项指向博客（数据仍在博客维护，见计划「友链/关于跳到博客现有页」）
const localItems = [
  { to: '/', label: '首页', exact: true },
  { to: '/notes', label: '手记' },
];
const crossItems = computed(() => [
  { href: blogUrl('articles'), label: '文章' },
  { href: blogUrl('links'), label: '友链' },
  { href: blogUrl('about'), label: '关于' },
]);

const avatar = computed(() => home.summary?.avatar || '/logo-256.webp');
const siteName = computed(() => home.summary?.site_name || 'Xalor');
const siteDesc = computed(() => home.summary?.site_desc || '手记、日常和朋友');
const socialGithub = computed(() => {
  const u = String(home.summary?.social?.github || '').trim();
  return /^https?:\/\/github\.com\/.+/i.test(u) ? u : '';
});
const socialEmail = computed(() => String(home.summary?.social?.email || '').trim());
const stats = computed(() => home.summary?.stats || {});
const runningDays = computed(() => home.summary?.running_days || 0);
const icp = computed(() => home.summary?.icp || '');
const footerText = computed(() => `© ${new Date().getFullYear()} ${siteName.value}`);

function isActive(item) {
  if (item.exact) return route.path === '/';
  return route.path.startsWith(item.to);
}

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    scrolled.value = window.scrollY > 16;
    showTop.value = window.scrollY > 480;
    ticking = false;
  });
}
function scrollTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

onMounted(() => {
  home.load();
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
});
onUnmounted(() => window.removeEventListener('scroll', onScroll));
</script>

<style scoped>
.home-layout {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(900px 460px at 12% -6%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 58%),
    radial-gradient(760px 520px at 92% 8%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 62%),
    var(--bg);
  color: var(--text);
}

.home-container {
  width: 100%;
  max-width: 1040px;
  margin: 0 auto;
  padding: 0 20px;
}

/* ============ 顶栏 ============ */
.home-nav {
  position: sticky;
  top: 0;
  z-index: var(--z-nav);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  background: var(--glass);
  border-bottom: 1px solid transparent;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.home-nav.scrolled {
  border-bottom-color: var(--border);
  background: var(--card-trans);
}
.nav-inner {
  height: 62px;
  display: flex;
  align-items: center;
  gap: 18px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-weight: 650;
  color: inherit;
  text-decoration: none;
  flex-shrink: 0;
}
.brand-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--border);
}
.brand-name {
  font-size: 15px;
  letter-spacing: -0.01em;
  /* 站名是后台可填的自由文本：过长时截断而不是把导航撑破 */
  max-width: 42vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-links {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.nav-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 7px 11px;
  border-radius: 999px;
  font-size: 14px;
  color: var(--text-2);
  text-decoration: none;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.nav-link:hover {
  color: var(--text);
  background: var(--accent-soft);
}
.nav-link.active {
  color: var(--accent-deep);
  background: var(--accent-soft);
  font-weight: 600;
}
.nav-link.cross {
  color: var(--text-3);
}
.nav-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.icon-btn:hover {
  background: var(--accent-soft);
  color: var(--accent-deep);
}
.hamburger {
  display: none;
  flex-direction: column;
  gap: 4px;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
}
.hamburger span {
  width: 17px;
  height: 1.6px;
  border-radius: 2px;
  background: var(--text-2);
  transition: transform var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.hamburger.open span:nth-child(1) { transform: translateY(5.6px) rotate(45deg); }
.hamburger.open span:nth-child(2) { opacity: 0; }
.hamburger.open span:nth-child(3) { transform: translateY(-5.6px) rotate(-45deg); }

.mobile-menu {
  display: none;
  flex-direction: column;
  padding: 8px 20px 16px;
  border-top: 1px solid var(--border);
  gap: 2px;
}
.mobile-link {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 11px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  text-decoration: none;
  font-size: 15px;
}
/* 高亮由 :class="{ active }" 显式控制：to="/" 与 to="/notes" 在 router-link-active
   里是包含匹配，/notes 下两个都会亮，必须自己判（与桌面导航同一套 isActive） */
.mobile-link.active {
  color: var(--accent-deep);
  background: var(--accent-soft);
}
.drawer-enter-active, .drawer-leave-active { transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease); }
.drawer-enter-from, .drawer-leave-to { opacity: 0; transform: translateY(-6px); }

/* ============ 主体 ============ */
.home-main {
  flex: 1;
  padding: 30px 0 56px;
}
/* 路由切换：与博客一致的淡入上浮 */
.page-enter-active, .page-leave-active { transition: opacity 0.24s var(--ease), transform 0.24s var(--ease); }
.page-enter-from { opacity: 0; transform: translateY(8px); }
.page-leave-to { opacity: 0; transform: translateY(-4px); }

/* ============ 页脚 ============ */
.home-footer {
  border-top: 1px solid var(--border);
  background: var(--bg-soft);
}
.footer-inner {
  padding: 30px 20px 26px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.footer-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.footer-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--border);
}
.footer-name {
  font-size: 15px;
  font-weight: 650;
  margin: 0;
}
.footer-desc {
  margin: 3px 0 0;
  font-size: 13px;
  color: var(--text-3);
}
/* 站名/简介都是后台自由文本：必须能换行，否则一个 200 字不带空格的简介
   会把页脚撑到 1900px 宽，整页出现横向滚动条 */
.footer-name,
.footer-desc {
  overflow-wrap: anywhere;
}
.footer-brand { min-width: 0; }
.footer-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.footer-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 13px;
  text-decoration: none;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.footer-link:hover {
  color: var(--accent-deep);
  border-color: var(--accent);
}
.footer-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  font-size: 13px;
  color: var(--text-3);
}
.footer-stats b {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.footer-bottom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text-3);
}
.footer-bottom a {
  color: inherit;
  text-decoration: none;
}
.footer-bottom a:hover { color: var(--accent-deep); }
.footer-bottom .powered { margin-left: auto; }

/* ============ 悬浮工具 ============ */
.side-tools-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}
.back-top {
  opacity: 0.95;
}
.pop-enter-active, .pop-leave-active { transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease); }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: scale(0.86); }

/* ============ 响应式 ============ */
@media (max-width: 860px) {
  .nav-links { display: none; }
  .hamburger { display: flex; }
  .mobile-menu { display: flex; }
  .nav-inner { justify-content: space-between; }
  .nav-actions { margin-left: auto; }
  .home-main { padding: 22px 0 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .page-enter-active, .page-leave-active,
  .drawer-enter-active, .drawer-leave-active,
  .pop-enter-active, .pop-leave-active { transition: none; }
}
</style>
