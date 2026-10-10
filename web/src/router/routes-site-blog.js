/** 博客前台路由（blog.xalor.cn） */
export const blogSiteRoutes = [
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
    ],
  },
];

/**
 * 404 兜底：**必须挂在后台路由之后**。
 * 放在前台 children 里会变成 /:pathMatch(.*)*，与 /:adminKey/... 抢匹配，
 * 后台刷新/直达会落到前台空壳。
 */
export const blogNotFoundRoute = {
  path: '/:pathMatch(.*)*',
  component: () => import('@/views/site/Layout.vue'),
  children: [
    { path: '', name: 'not-found', component: () => import('@/views/site/NotFound.vue') },
  ],
};
