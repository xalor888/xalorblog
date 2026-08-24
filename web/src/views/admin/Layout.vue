<template>
  <div class="admin-layout">
    <!-- 侧边栏 -->
    <aside class="admin-side" :class="{ collapsed }">
      <router-link :to="adminHref('dashboard')" class="side-brand">
        <img src="/logo.png" alt="logo" class="brand-mark-img" />
        <span v-show="!collapsed" class="brand-text">管理后台</span>
      </router-link>

      <nav class="side-nav">
        <router-link
          v-for="item in menus"
          :key="item.path"
          :to="adminHref(item.path)"
          class="side-link"
          active-class="active"
          :title="collapsed ? item.title : undefined"
        >
          <XIcon :name="item.icon" :size="17" />
          <span v-show="!collapsed">{{ item.title }}</span>
          <span v-if="badgeFor(item)" class="side-badge" :class="{ hide: collapsed }">{{ badgeFor(item) }}</span>
        </router-link>
      </nav>

      <div class="side-bottom">
        <router-link to="/" class="side-link">
          <XIcon name="House" :size="17" />
          <span v-show="!collapsed">返回前台</span>
        </router-link>
        <a class="side-link" @click="logout">
          <XIcon name="LogOut" :size="17" />
          <span v-show="!collapsed">退出登录</span>
        </a>
      </div>
    </aside>

    <!-- 主区域 -->
    <div class="admin-main">
      <header class="admin-header">
        <button class="collapse-btn" :title="collapsed ? '展开侧栏' : '收起侧栏'" :aria-label="collapsed ? '展开侧栏' : '收起侧栏'" @click="collapsed = !collapsed">
          <XIcon :name="collapsed ? 'PanelLeftOpen' : 'PanelLeftClose'" :size="18" />
        </button>
        <span class="header-title">{{ currentTitle }}</span>
        <div class="header-right">
          <span class="admin-user">
            <span class="user-avatar">{{ (auth.user?.nickname || auth.user?.username || 'A').charAt(0).toUpperCase() }}</span>
            {{ auth.user?.nickname || auth.user?.username || 'admin' }}
          </span>
          <button
            class="theme-btn"
            :title="theme.mode === 'auto' ? '跟随系统 · 点击切换亮色' : theme.isDark ? '点击切换自动' : '点击切换暗色'"
            @click="theme.toggleTheme"
          >
            <XIcon :name="theme.mode === 'auto' ? 'MonitorSmartphone' : theme.isDark ? 'Sun' : 'Moon'" :size="17" />
          </button>
          <!-- 强调色选择（与前台同一色板，localStorage 共享记忆） -->
          <div class="accent-wrap" @mouseenter="accentOpen = true" @mouseleave="accentOpen = false">
            <button class="theme-btn" title="主题强调色" @click="accentOpen = !accentOpen">
              <span class="accent-dot" :style="{ background: theme.accent }"></span>
            </button>
            <div v-if="accentOpen" class="accent-pop">
              <button
                v-for="c in THEME_COLORS"
                :key="c.value"
                class="accent-opt"
                :class="{ active: theme.accent === c.value }"
                :title="c.name"
                :style="{ background: c.value }"
                @click="theme.setAccent(c.value)"
              >
                <XIcon v-if="theme.accent === c.value" name="Check" :size="12" :stroke-width="3" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main class="admin-content">
        <router-view v-slot="{ Component }">
          <transition name="page-fade" mode="out-in">
            <component :is="Component" :key="route.path" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore, THEME_COLORS } from '@/stores/theme';
import { useAdminStore } from '@/stores/admin';
import { adminHref } from '@/utils/adminPath';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const theme = useThemeStore();
const admin = useAdminStore();

// 侧栏折叠偏好本地记忆（每次进后台保持上次状态）
const collapsed = ref((() => {
  try { return localStorage.getItem('xalor_admin_side') === '1'; } catch (e) { return false; }
})());
watch(collapsed, (v) => {
  try {
    localStorage.setItem('xalor_admin_side', v ? '1' : '0');
  } catch (e) { /* 隐私模式忽略 */ }
});
const accentOpen = ref(false);

const menus = [
  { path: 'dashboard', title: '仪表盘', icon: 'LayoutDashboard' },
  { path: 'articles', title: '文章管理', icon: 'FileText' },
  { path: 'articles/new', title: '写文章', icon: 'SquarePen' },
  { path: 'categories', title: '分类管理', icon: 'FolderOpen' },
  { path: 'tags', title: '标签管理', icon: 'Tags' },
  { path: 'comments', title: '评论管理', icon: 'MessagesSquare' },
  { path: 'links', title: '友链管理', icon: 'Link2' },
  { path: 'messages', title: '留言管理', icon: 'MailOpen' },
  { path: 'images', title: '图片管理', icon: 'Image' },
  { path: 'security', title: '安全中心', icon: 'ShieldCheck' },
  { path: 'audit', title: '审计日志', icon: 'History' },
  { path: 'settings', title: '站点设置', icon: 'Settings2' },
];

const currentTitle = computed(() => route.meta.title || '管理后台');

// 浏览器标签页标题随后台路由联动
watchEffect(() => {
  document.title = `${currentTitle.value} · 管理后台`;
});

// 待审角标
function badgeFor(item) {
  const p = admin.pending;
  if (item.path === 'comments') return p.comments > 0 ? p.comments : '';
  if (item.path === 'links') return p.links > 0 ? p.links : '';
  if (item.path === 'messages') return p.messages > 0 ? p.messages : '';
  return '';
}

// 进入后台及路由切换时刷新待审数
admin.fetchPending();
watch(() => route.path, () => admin.fetchPending());

async function logout() {
  const { revoked } = await auth.logout();
  if (!revoked) {
    ElMessage.warning('已退出本机，但服务端会话撤销失败；请重新登录后在安全中心撤销旧会话');
  }
  router.push(adminHref('login'));
}
</script>

<style scoped>
.admin-layout {
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bg);
}

/* ============ 侧边栏 ============ */
.admin-side {
  width: 224px;
  background: var(--card);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 60;
  transition: width 0.25s var(--ease);
}

.admin-side.collapsed {
  width: 64px;
}

.side-brand {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.brand-mark-img {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  object-fit: cover;
  flex-shrink: 0;
}

.brand-text {
  font-weight: 700;
  font-size: 0.98rem;
  white-space: nowrap;
}

.side-nav {
  flex: 1;
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
}

.side-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 13px;
  border-radius: 8px;
  color: var(--text-2);
  font-size: 0.9rem;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
  white-space: nowrap;
  border: none;
  background: transparent;
  text-align: left;
  width: 100%;
}

.side-link:hover {
  color: var(--text);
  background: var(--bg-soft);
}

.side-link.active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}

/* 待审角标 */
.side-badge {
  margin-left: auto;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.side-badge.hide {
  display: none;
}

.side-bottom {
  padding: 14px 10px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* ============ 主区域 ============ */
.admin-main {
  flex: 1;
  margin-left: 224px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  transition: margin-left 0.25s var(--ease);
}

.admin-side.collapsed + .admin-main {
  margin-left: 64px;
}

.admin-header {
  height: 64px;
  background: var(--card-trans);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 24px;
  position: sticky;
  top: 0;
  z-index: 50;
}

.collapse-btn {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
}

.collapse-btn:hover {
  color: var(--text);
  background: var(--bg-soft);
}

.header-title {
  font-weight: 650;
  font-size: 0.98rem;
}

.header-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.admin-user {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 0.88rem;
  background: var(--bg-soft);
  padding: 5px 14px 5px 5px;
  border-radius: 999px;
}

.user-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.76rem;
  font-weight: 700;
}

.theme-btn {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
}

.theme-btn:hover {
  color: var(--text);
  background: var(--bg-soft);
}

/* 强调色选择器 */
.accent-wrap {
  position: relative;
}

.accent-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--card);
  box-shadow: 0 0 0 1px var(--border);
}

.accent-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 50;
  display: grid;
  grid-template-columns: repeat(4, 26px);
  gap: 8px;
  padding: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-1);
}

.accent-opt {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  transition: transform 0.15s var(--ease);
}

.accent-opt:hover {
  transform: scale(1.15);
}

.accent-opt.active {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.admin-content {
  flex: 1;
  padding: 28px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

/* 超宽屏：内容限宽居中，避免表格行过长影响可读性 */
@media (min-width: 1600px) {
  .admin-content {
    max-width: 1480px;
    margin: 0 auto;
    width: 100%;
  }
}

@media (max-width: 820px) {
  .admin-side {
    width: 64px;
  }
  .admin-side .brand-text,
  .admin-side .side-link span {
    display: none !important;
  }
  .admin-main {
    margin-left: 64px;
  }
  .admin-content {
    padding: 18px;
  }
}
</style>
