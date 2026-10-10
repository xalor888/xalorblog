/** 个人主页前台路由（xalor.cn） */
export const homeSiteRoutes = [
  {
    path: '/',
    component: () => import('@/views/home/Layout.vue'),
    children: [
      // meta.title 由路由守卫拼成「<标题> · Xalor」；首页不设（只显示站名）
      { path: '', name: 'home-index', component: () => import('@/views/home/Home.vue') },
      { path: 'notes', name: 'home-notes', component: () => import('@/views/home/Notes.vue'), meta: { title: '手记' } },
      { path: 'notes/:id', name: 'home-note-detail', component: () => import('@/views/home/NoteDetail.vue'), meta: { title: '手记' } },
    ],
  },
];

/** 404 兜底：同样必须挂在后台路由之后（与博客入口同因） */
export const homeNotFoundRoute = {
  path: '/:pathMatch(.*)*',
  component: () => import('@/views/home/Layout.vue'),
  children: [
    { path: '', name: 'home-not-found', component: () => import('@/views/home/NotFound.vue') },
  ],
};
