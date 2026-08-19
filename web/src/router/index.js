import { createRouter, createWebHashHistory } from 'vue-router';
import { getAdminPath, getCachedAdminPath } from '@/utils/adminPath';
import { getAuthToken } from '@/utils/authSession';

const routes = [
  // ============ 前台 ============
  {
    path: '/',
    component: () => import('@/views/site/Layout.vue'),
    children: [
      { path: '', name: 'home', component: () => import('@/views/site/Home.vue') },
      { path: 'articles', name: 'articles', component: () => import('@/views/site/ArticleList.vue') },
      { path: 'article/:slug', name: 'article-detail', component: () => import('@/views/site/ArticleDetail.vue') },
      { path: 'archive', name: 'archive', component: () => import('@/views/site/Archive.vue') },
      { path: 'tags', name: 'tags', component: () => import('@/views/site/Tags.vue') },
      { path: 'about', name: 'about', component: () => import('@/views/site/About.vue') },
      { path: 'links', name: 'links', component: () => import('@/views/site/Links.vue') },
      { path: 'messages', name: 'messages', component: () => import('@/views/site/Messages.vue') },
      { path: 'bookmarks', name: 'bookmarks', component: () => import('@/views/site/Bookmarks.vue') },
      { path: ':pathMatch(.*)*', name: 'not-found', component: () => import('@/views/site/NotFound.vue') },
    ],
  },
  // ============ 后台（秘钥路径：/:adminKey 动态段，守卫校验） ============
  {
    path: '/:adminKey/login',
    name: 'admin-login',
    component: () => import('@/views/admin/Login.vue'),
    meta: { title: '后台登录' },
  },
  {
    path: '/:adminKey',
    component: () => import('@/views/admin/Layout.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: (to) => `/${to.params.adminKey}/dashboard` },
      { path: 'dashboard', name: 'admin-dashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: { title: '仪表盘' } },
      { path: 'articles', name: 'admin-articles', component: () => import('@/views/admin/ArticleManage.vue'), meta: { title: '文章管理' } },
      { path: 'articles/new', name: 'admin-article-new', component: () => import('@/views/admin/ArticleEdit.vue'), meta: { title: '写文章' } },
      { path: 'articles/:id/edit', name: 'admin-article-edit', component: () => import('@/views/admin/ArticleEdit.vue'), meta: { title: '编辑文章' } },
      { path: 'categories', name: 'admin-categories', component: () => import('@/views/admin/CategoryManage.vue'), meta: { title: '分类管理' } },
      { path: 'tags', name: 'admin-tags', component: () => import('@/views/admin/TagManage.vue'), meta: { title: '标签管理' } },
      { path: 'comments', name: 'admin-comments', component: () => import('@/views/admin/CommentManage.vue'), meta: { title: '评论管理' } },
      { path: 'links', name: 'admin-links', component: () => import('@/views/admin/LinkManage.vue'), meta: { title: '友链管理' } },
      { path: 'messages', name: 'admin-messages', component: () => import('@/views/admin/MessageManage.vue'), meta: { title: '留言管理' } },
      { path: 'images', name: 'admin-images', component: () => import('@/views/admin/ImageManage.vue'), meta: { title: '图片管理' } },
      { path: 'security', name: 'admin-security', component: () => import('@/views/admin/SecurityManage.vue'), meta: { title: '安全中心' } },
      { path: 'audit', name: 'admin-audit', component: () => import('@/views/admin/AuditManage.vue'), meta: { title: '审计日志' } },
      { path: 'settings', name: 'admin-settings', component: () => import('@/views/admin/Settings.vue'), meta: { title: '站点设置' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    if (to.name !== from.name) return { top: 0 };
    return { top: 0 };
  },
});

// 全局前置守卫
router.beforeEach(async (to) => {
  const adminKey = to.params.adminKey;
  if (!adminKey) {
    document.title = to.meta.title ? `${to.meta.title} · Xalor的小站` : 'Xalor的小站';
    return true;
  }
  // 后台路径段：必须与服务端派生的秘钥路径一致，否则一律 404 形态。
  // 本地缓存缺失（首次访问/缓存被清）时必须先取真实路径再比较，
  // 否则任意单段 URL（如 #/foo）会被放行渲染后台登录页/空壳
  let real = getCachedAdminPath();
  if (!real) {
    try {
      real = await getAdminPath();
    } catch (e) {
      return { name: 'not-found' };
    }
  }
  if (adminKey !== real) return { name: 'not-found' };
  document.title = to.meta.title ? `${to.meta.title} · Xalor的小站` : 'Xalor的小站';
  const token = getAuthToken();
  if (to.meta.requiresAuth && !token) {
    return { path: `/${adminKey}/login`, replace: true };
  }
  return true;
});

export default router;
