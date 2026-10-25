/**
 * 路由工厂
 *
 * 同一个仓库里有两个站点入口（blog.xalor.cn / xalor.cn），它们：
 *   - 前台版块不同（博客版块 vs 个人主页版块）
 *   - 后台完全相同（同一套 /:adminKey 秘钥路径）
 *   - 守卫逻辑完全相同（秘钥路径校验、标题联动、登录跳转）
 * 因此把「创建 + 守卫」抽成工厂，避免两份守卫实现逐渐漂移
 * ——守卫是安全边界，重复实现是隐患。
 */
import { createRouter, createWebHashHistory } from 'vue-router';
import { getAdminPath, getCachedAdminPath, refreshAdminPath } from '@/utils/adminPath';
import { getAuthToken } from '@/utils/authSession';

export function createAppRouter({ routes, siteName, notFoundName }) {
  const router = createRouter({
    history: createWebHashHistory(),
    routes,
    /**
     * 滚动位置策略。
     *
     * ⚠ 这里踩过一个坑：`savedPosition` 在 **hash 路由 + 异步组件**下经常是 null，
     * 于是「从列表点进文章、浏览器后退」时页面回到顶部 ——
     * 实测 `history.state.scroll` 里明明有 `{top: 600}`，
     * Vue Router 却没有把它交给我们（savedPosition 为 null）。
     *
     * 所以这里**自己读 history.state.scroll 兜底**：
     * 浏览器在 popstate 时会把离开时的滚动位置写进 state，
     * 这是可靠的第二个来源。两者取其一即可。
     */
    scrollBehavior(to, from, savedPosition) {
      if (savedPosition) return savedPosition;

      // 后退/前进：浏览器记录了离开时的位置，优先恢复它
      const stateScroll = typeof window !== 'undefined' ? window.history.state?.scroll : null;
      if (stateScroll && typeof stateScroll.top === 'number' && stateScroll.top > 0) {
        return { left: stateScroll.left || 0, top: stateScroll.top };
      }

      // 同路由只改 query（分页/筛选）时保持不动，
      // 否则点「下一页」会被甩回顶部，读者要重新往下滚
      if (to.name === from.name && to.path === from.path) return false;
      return { top: 0 };
    },
  });

  router.beforeEach(async (to) => {
    const adminKey = to.params.adminKey;
    if (!adminKey) {
      document.title = to.meta.title ? `${to.meta.title} · ${siteName}` : siteName;
      return true;
    }
    // 后台路径段：必须与服务端派生的秘钥路径一致，否则一律 404 形态。
    // 本地缓存缺失（首次访问/缓存被清）时必须先取真实路径再比较，
    // 否则任意单段 URL（如 #/foo）会被放行渲染后台登录页/空壳
    let real = getCachedAdminPath();
    if (!real || real !== adminKey) {
      try {
        real = real && real !== adminKey ? await refreshAdminPath() : await getAdminPath();
      } catch (e) {
        return { name: notFoundName };
      }
    }
    if (adminKey !== real) return { name: notFoundName };
    document.title = to.meta.title ? `${to.meta.title} · ${siteName}` : siteName;
    const token = getAuthToken();
    if (to.meta.requiresAuth && !token) {
      return { path: `/${adminKey}/login`, replace: true };
    }
    return true;
  });

  return router;
}
