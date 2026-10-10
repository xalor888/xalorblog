/**
 * 个人主页入口路由（web/home.html → src/main-home.js）
 * 组合：主页前台版块 + 共享后台 + 404 兜底
 * 后台路由是同一份定义（懒加载），因此两个域名都能进同一个后台。
 */
import { createAppRouter } from './factory';
import { adminRoutes } from './routes-admin';
import { homeSiteRoutes, homeNotFoundRoute } from './routes-site-home';

const routes = [
  ...homeSiteRoutes,
  ...adminRoutes,
  homeNotFoundRoute,
];

export default createAppRouter({
  routes,
  siteName: 'Xalor',
  notFoundName: 'home-not-found',
});
