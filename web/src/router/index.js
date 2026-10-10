/**
 * 博客入口路由（web/index.html → src/main.js）
 * 组合：博客前台版块 + 共享后台 + 404 兜底
 */
import { createAppRouter } from './factory';
import { adminRoutes } from './routes-admin';
import { blogSiteRoutes, blogNotFoundRoute } from './routes-site-blog';

const routes = [
  // ============ 前台 ============
  ...blogSiteRoutes,
  // ============ 后台（秘钥路径：/:adminKey 动态段，守卫校验） ============
  ...adminRoutes,
  // 404 必须放在最后
  blogNotFoundRoute,
];

export default createAppRouter({
  routes,
  siteName: 'Xalor的小站',
  notFoundName: 'not-found',
});
