/**
 * 后台路由（博客域与个人主页域**共用同一套**）
 *
 * 后台只有一套，仍挂在由 JWT_SECRET 派生的秘钥路径 /:adminKey 下：
 * 公共前缀下探测不到任何后台路由（与 404 同形，路由存在性不可枚举）。
 * 两个入口都包含这组路由（全部懒加载，不会进入任一域的首屏包）。
 */
export const adminRoutes = [
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
      // ---------- 个人主页 ----------
      { path: 'notes', name: 'admin-notes', component: () => import('@/views/admin/NoteManage.vue'), meta: { title: '手记管理' } },
      { path: 'notes/new', name: 'admin-note-new', component: () => import('@/views/admin/NoteEdit.vue'), meta: { title: '写手记' } },
      { path: 'notes/:id/edit', name: 'admin-note-edit', component: () => import('@/views/admin/NoteEdit.vue'), meta: { title: '编辑手记' } },
      { path: 'home-settings', name: 'admin-home-settings', component: () => import('@/views/admin/HomeSettings.vue'), meta: { title: '主页设置' } },
      // ---------- 博客 ----------
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
];
