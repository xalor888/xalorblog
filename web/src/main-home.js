/**
 * 个人主页入口（xalor.cn）
 *
 * 与博客入口（src/main.js）共用：同一套设计系统、同一套 API 客户端与反爬通道、
 * 同一套后台路由。差异只在路由表与站点标题。
 *
 * 首屏策略：主页壳（名片/关于/友链预览/最近文章）走免票的 /api/home/summary，
 * 不等待 PoW；手记仍然要票据（gateRequired），在票据就绪后自然出现 —— 与博客一致。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { ElMessage } from 'element-plus';

import App from './App.vue';
import router from './router/home';
import { useThemeStore } from './stores/theme';
import { installReveal } from './directives/reveal';
import { ensurePass } from './utils/pass';
import { migrateLegacyKeys, migrateLegacyPrefix } from './utils/secureStorage';
import { getAuthToken, getCachedAuthUser } from './utils/authSession';

// 命令式组件（ElMessage / ElMessageBox）的主题样式必须显式引入（同博客入口，原因见 src/main.js）
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';

import './styles/main.css';
import './styles/markdown.css';

migrateLegacyKeys(['xalor_cemail', 'xalor_memail', 'xalor_fp_v2']);
migrateLegacyPrefix('xalor_draft_');
getAuthToken();
getCachedAuthUser();

window.addEventListener('offline', () => {
  ElMessage.warning('网络已断开，请检查连接');
});
window.addEventListener('online', () => {
  ElMessage.success('网络已恢复');
});

window.addEventListener('unhandledrejection', (e) => {
  const status = e?.reason?.response?.status;
  if (status === 401 || status === 403) return; // 拦截器已处理，不重复提示
  if (e?.reason?.code === 'ERR_CANCELED') return;
  console.error('[unhandledrejection]', e?.reason);
});

const app = createApp(App);

app.use(createPinia());
app.use(router);
installReveal(app);

app.config.errorHandler = (err) => {
  console.error('[vue error]', err);
};

const theme = useThemeStore();
theme.apply();

app.mount('#app');

// 预热反爬安全通道（PoW 换票据）：手记接口需要它，但不阻塞首屏渲染
ensurePass().catch(() => {});
