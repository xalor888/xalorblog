<template>
  <div class="site-layout" :class="{ 'is-home': isHome }">
    <!-- 键盘无障碍：跳过导航直达正文（仅在 Tab 聚焦时可见） -->
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <!-- 顶部导航 -->
    <header class="site-nav" :class="{ scrolled: scrolled, overlay: navOverlay }">
      <div class="nav-progress" :style="{ transform: `scaleX(${scrollPercent / 100})` }"></div>
      <div class="container nav-inner">
        <router-link to="/" class="brand">
          <img src="/logo.png" alt="logo" class="brand-mark-img" />
          <span class="brand-text">{{ site.settings.site_name || 'Xalor的小站' }}</span>
        </router-link>

        <nav class="nav-links">
          <router-link v-for="item in navItems" :key="item.to" :to="item.to" class="nav-link" :class="{ active: isActive(item) }">
            {{ item.short }}
          </router-link>
        </nav>

        <!-- 移动端菜单 -->
        <button class="hamburger" :class="{ open: mobileOpen }" :aria-expanded="mobileOpen" aria-label="菜单" @click="mobileOpen = !mobileOpen">
          <span></span><span></span><span></span>
        </button>

        <div class="nav-actions">
          <button class="icon-btn" title="搜索 (Ctrl+K)" @click="openSearch">
            <XIcon name="Search" :size="17" />
          </button>

          <button
            class="icon-btn"
            :title="theme.mode === 'auto' ? '跟随系统 · 点击切换亮色' : theme.isDark ? '点击切换自动' : '点击切换暗色'"
            @click="theme.toggleTheme"
          >
            <XIcon :name="theme.mode === 'auto' ? 'MonitorSmartphone' : theme.isDark ? 'Sun' : 'Moon'" :size="17" />
          </button>

          <el-popover placement="bottom-end" :width="230" trigger="click" popper-class="theme-popover">
            <template #reference>
              <button class="icon-btn" title="主题色">
                <span class="accent-dot" :style="{ background: theme.accent }"></span>
              </button>
            </template>
            <div class="theme-panel">
              <p class="panel-label">主题色</p>
              <div class="color-grid">
                <button
                  v-for="c in THEME_COLORS"
                  :key="c.value"
                  class="color-swatch"
                  :class="{ active: theme.accent === c.value }"
                  :style="{ background: c.value }"
                  :title="c.name"
                  @click="theme.setAccent(c.value)"
                >
                  <XIcon v-if="theme.accent === c.value" name="Check" :size="14" :stroke-width="3" />
                </button>
              </div>
            </div>
          </el-popover>

          <router-link :to="adminLink" class="icon-btn" title="管理后台">
            <XIcon name="Settings" :size="17" />
          </router-link>
        </div>
      </div>
    </header>

    <!-- 移动端抽屉菜单 -->
    <transition name="drawer">
      <div v-if="mobileOpen" class="drawer-scrim" @click="mobileOpen = false" aria-hidden="true"></div>
    </transition>
    <transition name="drawer">
      <nav v-if="mobileOpen" class="mobile-menu">
        <router-link
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="mobile-link"
          :class="{ active: isActive(item) }"
          @click="mobileOpen = false"
        >
          <span>{{ item.short }}</span>
          <span class="mobile-zh">{{ item.label }}</span>
        </router-link>
        <div class="mobile-actions">
          <button class="mobile-action" @click="openSearch">
            <XIcon name="Search" :size="16" /> 搜索
          </button>
          <button class="mobile-action" @click="theme.toggleTheme">
            <XIcon :name="theme.isDark ? 'Sun' : 'Moon'" :size="16" /> {{ theme.isDark ? '亮色模式' : '暗色模式' }}
          </button>
          <router-link :to="adminLink" class="mobile-action" @click="mobileOpen = false">
            <XIcon name="Settings" :size="16" /> 管理后台
          </router-link>
        </div>
      </nav>
    </transition>

    <!-- 公告 -->
    <transition name="ticker-slide">
      <div v-if="site.settings.announcement && !announcementClosed" class="ticker" :class="{ overlay: isHome, compact: isHome && scrolled }">
        <div class="container ticker-inner">
          <span class="ticker-icon"><XIcon name="Megaphone" :size="14" /></span>
          <span class="ticker-text">{{ site.settings.announcement }}</span>
          <button class="ticker-close" @click="closeAnnouncement" title="关闭公告">
            <XIcon name="X" :size="14" />
          </button>
        </div>
      </div>
    </transition>

    <!-- 主体 -->
    <main id="main-content" class="site-main" :class="{ 'home-main': isHome }" tabindex="-1">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <component :is="Component" :key="route.path" />
        </transition>
      </router-view>
    </main>

    <!-- 页脚 -->
    <footer class="site-footer">
      <div class="container footer-inner">
        <div class="footer-grid">
          <div class="footer-col brand-col">
            <div class="footer-brand">
              <img src="/logo.png" alt="" class="footer-logo" />
              <span class="footer-name">{{ site.settings.site_name }}</span>
            </div>
            <p class="footer-desc">{{ site.settings.site_desc }}</p>
            <div class="footer-social">
              <a v-if="site.settings.social_github" :href="site.settings.social_github" target="_blank" rel="noopener" class="social-link" title="GitHub"><XIcon name="Github" :size="16" /></a>
              <a v-if="site.settings.social_weibo" :href="site.settings.social_weibo" target="_blank" rel="noopener" class="social-link" title="微博"><XIcon name="AtSign" :size="16" /></a>
              <a v-if="site.settings.social_email" :href="'mailto:' + site.settings.social_email" class="social-link" title="邮箱"><XIcon name="Mail" :size="16" /></a>
              <a :href="`/api/rss.xml`" class="social-link rss-link" title="RSS 订阅"><XIcon name="Rss" :size="16" /></a>
            </div>
          </div>

          <div class="footer-col">
            <p class="footer-col-title">浏览</p>
            <router-link to="/articles" class="footer-link">全部文章</router-link>
            <router-link to="/archive" class="footer-link">文章归档</router-link>
            <router-link to="/tags" class="footer-link">标签云</router-link>
          </div>

          <div class="footer-col">
            <p class="footer-col-title">互动</p>
            <router-link to="/messages" class="footer-link">留言板</router-link>
            <router-link to="/links" class="footer-link">友情链接</router-link>
            <router-link to="/about" class="footer-link">关于本站</router-link>
            <router-link to="/bookmarks" class="footer-link">我的收藏</router-link>
            <a href="/api/rss.xml" class="footer-link" target="_blank" rel="noopener">RSS 订阅</a>
          </div>

          <div class="footer-col stats-col">
            <p class="footer-col-title">站点数据</p>
            <p class="footer-stat"><span class="num">{{ site.stats.article_count || 0 }}</span> 篇文章</p>
            <p class="footer-stat"><span class="num">{{ site.stats.comment_count || 0 }}</span> 条评论</p>
            <p class="footer-stat"><span class="num">{{ formatNumber(site.stats.total_pv) }}</span> 次浏览</p>
            <p class="footer-stat"><span class="num">{{ formatNumber(site.stats.total_uv) }}</span> 位访客</p>
            <p class="footer-stat"><span class="num">{{ formatNumber(site.stats.today_uv) }}</span> 今日访客</p>
          </div>
        </div>

        <div class="footer-bottom">
          <div class="footer-bottom-left">
            <span>{{ footerText }}</span>
            <a
              v-if="site.settings.icp"
              :href="'https://beian.miit.gov.cn/'"
              target="_blank"
              rel="noopener nofollow"
              class="footer-icp"
              title="工信部备案查询"
            >{{ site.settings.icp }}</a>
          </div>
          <span class="footer-powered">Designed with care · Vue 3</span>
        </div>
      </div>
    </footer>

    <AmbientParticles />

    <div class="side-tools">
      <button class="tool-btn theme-tool" :title="theme.isDark ? '切换亮色' : '切换暗色'" @click="theme.toggleTheme">
        <XIcon :name="theme.isDark ? 'Sun' : 'Moon'" :size="18" />
      </button>
      <button class="tool-btn" title="搜索" @click="openSearch">
        <XIcon name="Search" :size="17" />
      </button>
      <a class="tool-btn" href="/api/rss.xml" target="_blank" rel="noopener" title="RSS">
        <XIcon name="Rss" :size="17" />
      </a>
      <transition name="pop">
        <button v-if="showTop" class="tool-btn back-top" @click="scrollTop" title="回到顶部">
          <svg class="progress-ring" viewBox="0 0 44 44">
            <circle class="ring-bg" cx="22" cy="22" r="20" />
            <circle class="ring-fill" cx="22" cy="22" r="20" :stroke-dasharray="ringDash" :stroke-dashoffset="ringOffset" />
          </svg>
          <XIcon name="ArrowUp" :size="16" class="top-icon" />
        </button>
      </transition>
    </div>

    <!-- 全局搜索 (Ctrl+K) -->
    <SearchModal />

    <!-- 快捷键帮助 (? 键) -->
    <ShortcutHelp />
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import SearchModal from '@/components/ui/SearchModal.vue';
import ShortcutHelp from '@/components/ui/ShortcutHelp.vue';
import AmbientParticles from '@/components/site/AmbientParticles.vue';
import { useThemeStore, THEME_COLORS } from '@/stores/theme';
import { useSiteStore } from '@/stores/site';
import { statsApi } from '@/api';
import { formatNumber } from '@/utils/format';
import { adminHref, getAdminPath } from '@/utils/adminPath';
import { warmFormToken } from '@/utils/formToken';

const route = useRoute();
const theme = useThemeStore();
const site = useSiteStore();

const scrolled = ref(false);
const showTop = ref(false);
const mobileOpen = ref(false);
const scrollPercent = ref(0);
// 抽屉打开时锁定背景滚动（防双滚动与移动端底部误触）
watch(mobileOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
});
// 管理后台链接（秘钥路径异步加载，加载完成后更新）
const adminLink = ref(adminHref());
// 公告关闭记忆：用公告内容 hash 作 key，内容变了重新显示
const announcementClosed = ref(false);
const ANNOUNCEMENT_KEY = 'xalor_announcement_hidden';

function checkAnnouncement() {
  const saved = localStorage.getItem(ANNOUNCEMENT_KEY);
  announcementClosed.value = saved === (site.settings.announcement || '');
}

// 页脚年份自动跟随当前年份（© 2026 → © 2027）
const footerText = computed(() => {
  const f = site.settings.footer || '';
  if (!f) return `© ${new Date().getFullYear()} Xalor的小站`;
  return f.replace(/©\s*\d{4}/, `© ${new Date().getFullYear()}`);
});

function closeAnnouncement() {
  announcementClosed.value = true;
  localStorage.setItem(ANNOUNCEMENT_KEY, site.settings.announcement || '');
}

// 进度环参数
const RING_R = 20;
const RING_C = 2 * Math.PI * RING_R;
const ringDash = RING_C;
const ringOffset = computed(() => RING_C * (1 - scrollPercent.value / 100));

const navItems = [
  { to: '/', label: '首页', short: 'HOME', exact: true },
  { to: '/articles', label: '文章', short: 'POSTS' },
  { to: '/archive', label: '归档', short: 'ARCHIVE' },
  { to: '/tags', label: '标签', short: 'TAGS' },
  { to: '/bookmarks', label: '书签', short: 'SAVED' },
  { to: '/messages', label: '留言', short: 'BOARD' },
  { to: '/links', label: '友链', short: 'LINKS' },
  { to: '/about', label: '关于', short: 'ABOUT' },
];

const isHome = computed(() => route.path === '/');
const navOverlay = computed(() => isHome.value && !scrolled.value);

function isActive(item) {
  if (item.exact) return route.path === '/';
  return route.path.startsWith(item.to);
}

function onScroll() {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrolled.value = window.scrollY > 24;
    showTop.value = window.scrollY > 480;
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    scrollPercent.value = max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0;
    scrollTicking = false;
  });
}
let scrollTicking = false;

function scrollTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openSearch() {
  mobileOpen.value = false; // 搜索弹窗打开前收起抽屉（避免两层 UI 叠加）
  window.dispatchEvent(new Event('xalor-open-search'));
}

// 快捷键：/ 快速唤起搜索（输入框内不触发）
function onGlobalKeydown(e) {
  // ESC：关闭移动端菜单（键盘导航完整性）
  if (e.key === 'Escape' && mobileOpen.value) {
    mobileOpen.value = false;
    return;
  }
  if (e.key !== '/') return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  e.preventDefault();
  openSearch();
}

onMounted(async () => {
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('keydown', onGlobalKeydown);
  await site.init();
  checkAnnouncement();
  // 预热管理后台秘钥路径（导航「管理后台」入口需要）
  getAdminPath().then((key) => {
    if (key) adminLink.value = `/${key}`;
  }).catch(() => {});
  // 预热评论表单令牌（减少首次提交等待）
  warmFormToken();
  // 空闲时预取常用页面 chunk（浏览器空闲期提前加载，导航即点即开）
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 2000));
  idle(() => {
    import('@/views/site/ArticleList.vue').catch(() => {});
    import('@/views/site/ArticleDetail.vue').catch(() => {});
    import('@/views/site/Archive.vue').catch(() => {});
    import('@/views/site/Tags.vue').catch(() => {});
    import('@/views/site/Messages.vue').catch(() => {});
    import('@/views/site/About.vue').catch(() => {});
  });
  try {
    await statsApi.record();
    await site.fetchStats();
  } catch (e) {
    /* 忽略统计失败 */
  }
  applyWebSiteLd();
});

/** 注入全站 WebSite 结构化数据（与文章页 BlogPosting 互补，卸载时移除防叠加） */
function applyWebSiteLd() {
  const name = site.settings.site_name || 'Xalor的小站';
  const url = site.settings.site_url || location.origin;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name,
    url,
    description: (site.settings.site_desc || '').slice(0, 300) || undefined,
  };
  let el = document.getElementById('jsonld-website');
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = 'jsonld-website';
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(ld);
}

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('keydown', onGlobalKeydown);
  document.getElementById('jsonld-website')?.remove();
});
</script>

<style scoped>
.site-layout {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  position: relative;
}

.site-layout.is-home {
  --nav-h: 72px;
}

.site-layout.is-home .site-nav {
  position: fixed;
  left: 0;
  right: 0;
}

/* 键盘无障碍跳转链接：默认移出视口，Tab 聚焦时置顶显示 */
.skip-link {
  position: fixed;
  top: -60px;
  left: 16px;
  z-index: 1000;
  padding: 10px 18px;
  border-radius: 0 0 10px 10px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: top 0.2s;
}

.skip-link:focus {
  top: 0;
  outline: none;
}

.skip-link:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.site-main:focus {
  outline: none;
}

/* ============ 顶部导航 ============ */
.site-nav {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--card-trans);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border-bottom: 1px solid transparent;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), background var(--dur) var(--ease);
}

.site-nav.overlay {
  position: fixed;
  left: 0;
  right: 0;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.site-nav.overlay .brand-text,
.site-nav.overlay .icon-btn {
  color: rgba(255, 255, 255, 0.92);
}

.site-nav.overlay .nav-link {
  color: rgba(255, 255, 255, 0.78);
}

.site-nav.overlay .nav-link:hover,
.site-nav.overlay .nav-link.active {
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
}

.site-nav.overlay .nav-link.active::after {
  background: #fff;
}

.site-nav.overlay .icon-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

.site-nav.overlay .hamburger span {
  background: #fff;
}

.site-nav.scrolled {
  border-bottom-color: var(--border);
  box-shadow: 0 8px 28px rgba(26, 24, 20, 0.08);
}

.nav-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--nav-h);
  gap: 20px;
}

/* 品牌 */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.brand-mark-img {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
}

.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--text);
  color: var(--bg);
  font-weight: 800;
  font-size: 0.98rem;
  display: flex;
  align-items: center;
  justify-content: center;
  letter-spacing: -0.02em;
  transition: background var(--dur) var(--ease);
}

.brand-mark.sm {
  width: 26px;
  height: 26px;
  font-size: 0.85rem;
}

.brand-text {
  font-weight: 700;
  font-size: 1.08rem;
  letter-spacing: 0.02em;
}

/* 导航链接 */
.nav-links {
  display: flex;
  gap: 2px;
  flex: 1;
  justify-content: center;
}

.nav-link {
  padding: 7px 11px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--text-2);
  position: relative;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.nav-link:hover {
  color: var(--text);
  background: var(--bg-soft);
}

.nav-link.active {
  color: var(--text);
  font-weight: 600;
}

.nav-link.active::after {
  content: '';
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 2px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
}

/* 右侧操作 */
.nav-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  border: 1px solid transparent;
  transition: all var(--dur) var(--ease);
}

.icon-btn:hover {
  color: var(--text);
  background: var(--bg-soft);
}

.accent-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: block;
  box-shadow: inset 0 0 0 2px var(--card);
  border: 1px solid var(--line);
}

/* 主题色面板 */
.theme-panel {
  padding: 4px 0;
}

.panel-label {
  font-size: 0.78rem;
  color: var(--text-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 12px;
}

.color-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.color-swatch {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  transition: transform var(--dur) var(--ease);
  border: 2px solid var(--card);
  box-shadow: 0 1px 4px rgba(29, 27, 22, 0.18);
}

.color-swatch:hover {
  transform: scale(1.12);
}

.color-swatch.active {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

/* ============ 公告 ============ */
.ticker {
  background: var(--bg-soft);
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
  color: var(--text-2);
}

.ticker.overlay {
  position: fixed;
  top: var(--nav-h);
  left: 0;
  right: 0;
  z-index: 90;
  background: rgba(8, 7, 6, 0.28);
  color: rgba(255, 255, 255, 0.88);
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(16px);
}

.ticker.overlay.compact {
  background: var(--card-trans);
  color: var(--text-2);
  border-bottom-color: var(--border);
}

.ticker.overlay.compact .ticker-close {
  color: var(--text-3);
}

.ticker.overlay .ticker-close {
  color: rgba(255, 255, 255, 0.7);
}

.ticker-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 24px;
}

.ticker-icon {
  color: var(--accent);
  display: flex;
  flex-shrink: 0;
}

.ticker-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ticker-close {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  transition: all var(--dur) var(--ease);
}

.ticker-close:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.ticker-slide-enter-active,
.ticker-slide-leave-active {
  transition: all 0.25s var(--ease-out);
  overflow: hidden;
}

.ticker-slide-enter-from,
.ticker-slide-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
}

/* ============ 主体 ============ */
.site-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.site-main.home-main {
  padding-top: 0;
}

/* 路由过渡 */
.page-enter-active,
.page-leave-active {
  transition: opacity 0.22s var(--ease), transform 0.22s var(--ease);
}

.page-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* ============ 页脚 ============ */
.site-footer {
  margin-top: 0;
  background: color-mix(in srgb, var(--bg-soft) 88%, var(--card));
  border-top: 1px solid var(--border);
}

.footer-inner {
  padding: 52px 24px 24px;
}

.footer-grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: 36px;
  margin-bottom: 40px;
}

.footer-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.footer-logo {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
}

.footer-name {
  font-weight: 700;
  font-size: 1.05rem;
}

.footer-desc {
  color: var(--text-3);
  font-size: 0.88rem;
  line-height: 1.8;
  max-width: 280px;
  margin-bottom: 16px;
}

.footer-social {
  display: flex;
  gap: 8px;
}

.social-link {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  transition: all var(--dur) var(--ease);
  background: var(--card);
}

/* RSS 订阅：橙色强调，一眼可辨 */
.social-link.rss-link {
  color: #ee802f;
}

.social-link.rss-link:hover {
  color: #fff;
  background: #ee802f;
  border-color: #ee802f;
}

.social-link:hover {
  color: var(--accent);
  border-color: var(--accent);
  transform: translateY(-2px);
}

.footer-col-title {
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 16px;
}

.footer-link {
  display: block;
  color: var(--text-2);
  font-size: 0.92rem;
  padding: 4px 0;
  transition: color var(--dur) var(--ease), transform var(--dur) var(--ease);
}

.footer-link:hover {
  color: var(--accent);
  transform: translateX(3px);
}

.footer-stat {
  color: var(--text-2);
  font-size: 0.92rem;
  padding: 4px 0;
}

.footer-stat .num {
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.footer-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding-top: 22px;
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: 0.82rem;
  flex-wrap: wrap;
}

.footer-bottom-left {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.footer-icp {
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}

.footer-icp:hover {
  color: var(--accent);
}

.footer-powered em {
  font-style: normal;
  color: var(--accent);
  font-weight: 600;
}

.nav-progress {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: var(--accent);
  transform-origin: left center;
  pointer-events: none;
}

.side-tools {
  position: fixed;
  right: 22px;
  bottom: 28px;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-btn {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--text-2);
  box-shadow: var(--shadow-1);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease), transform var(--dur) var(--ease), border-color var(--dur) var(--ease);
}

.tool-btn:hover {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
  transform: translateY(-2px);
}

.theme-tool {
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 50%, #ffb4a2));
  color: #fff;
  border-color: transparent;
}

.theme-tool:hover {
  transform: translateY(-3px);
}

.tool-btn.back-top {
  overflow: hidden;
}

.progress-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.ring-bg {
  fill: none;
  stroke: var(--border);
  stroke-width: 2;
}

.ring-fill {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2.5;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.1s linear;
}

.top-icon {
  position: relative;
  z-index: 1;
}

.pop-enter-active,
.pop-leave-active {
  transition: all 0.25s var(--ease);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

/* 汉堡按钮（移动端） */
.hamburger {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  width: 36px;
  height: 36px;
  padding: 8px;
  border-radius: 8px;
  transition: background var(--dur) var(--ease);
}

.hamburger span {
  display: block;
  height: 2px;
  border-radius: 1px;
  background: var(--text-2);
  transition: transform var(--dur) var(--ease), opacity var(--dur) var(--ease);
}

.hamburger.open span:nth-child(1) {
  transform: translateY(6px) rotate(45deg);
}

.hamburger.open span:nth-child(2) {
  opacity: 0;
}

.hamburger.open span:nth-child(3) {
  transform: translateY(-6px) rotate(-45deg);
}

/* 移动端抽屉菜单 */
.mobile-menu {
  display: none;
  flex-direction: column;
  padding: 18px 22px 22px;
  background: color-mix(in srgb, var(--card) 92%, transparent);
  border-bottom: 1px solid var(--border);
  position: fixed;
  top: var(--nav-h);
  left: 0;
  right: 0;
  z-index: 95;
  max-height: calc(100dvh - var(--nav-h));
  overflow: auto;
  backdrop-filter: blur(22px);
}

/* 抽屉遮罩：点击菜单外区域关闭（移动端导航完整性） */
.drawer-scrim {
  position: fixed;
  inset: 0;
  z-index: 94;
  background: rgba(20, 18, 14, 0.42);
  backdrop-filter: blur(6px);
}

.mobile-link {
  padding: 14px 8px;
  border-radius: 0;
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  transition: all var(--dur) var(--ease);
}

.mobile-zh {
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  color: var(--text-3);
}

.mobile-link.active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}

/* 抽屉内的辅助操作 */
.mobile-actions {
  display: flex;
  gap: 8px;
  padding: 10px 14px 4px;
}

.mobile-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 0.86rem;
  transition: all var(--dur) var(--ease);
}

.mobile-action:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.drawer-enter-active,
.drawer-leave-active {
  transition: all 0.22s var(--ease-out);
}

.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* ============ 响应式 ============ */
@media (max-width: 900px) {
  .nav-links {
    display: none;
  }
  .hamburger {
    display: flex;
  }
  .mobile-menu {
    display: flex;
  }
  .nav-actions {
    margin-left: auto;
  }
  .footer-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 560px) {
  .brand-text {
    display: none;
  }
  .side-tools {
    right: 12px;
    bottom: 16px;
  }
  .tool-btn {
    width: 40px;
    height: 40px;
  }
  .footer-grid {
    grid-template-columns: 1fr;
    gap: 24px;
  }
  .footer-bottom {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
