import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { ElMessage } from 'element-plus';

import App from './App.vue';
import router from './router';
import { useThemeStore } from './stores/theme';
import { installReveal } from './directives/reveal';
import { ensurePass } from './utils/pass';
import { migrateLegacyKeys, migrateLegacyPrefix } from './utils/secureStorage';
import { getAuthToken, getCachedAuthUser } from './utils/authSession';

import './styles/main.css';
import './styles/markdown.css';

// 一次性迁移旧版持久敏感数据：当前标签页继续可用，同时立即移除 localStorage 副本。
migrateLegacyKeys(['xalor_cemail', 'xalor_memail', 'xalor_fp_v2']);
migrateLegacyPrefix('xalor_draft_');
getAuthToken();
getCachedAuthUser();

// 网络状态提示：断网/恢复即时反馈（离线时请求会失败，此提示帮助理解原因）
window.addEventListener('offline', () => {
  ElMessage.warning('网络已断开，请检查连接');
});
window.addEventListener('online', () => {
  ElMessage.success('网络已恢复');
});

// 全局未捕获异常兜底：避免静默白屏，至少给出提示
window.addEventListener('unhandledrejection', (e) => {
  const status = e?.reason?.response?.status;
  if (status === 401 || status === 403) return; // 拦截器已处理，不重复提示
  if (e?.reason?.code === 'ERR_CANCELED') return; // 主动取消（如请求超时重试）
  console.error('[unhandledrejection]', e?.reason);
});

// 先挂载应用：首屏立即渲染骨架，不被 PoW 求解阻塞（低端设备/高信誉 IP 难度下
// 白屏可达数秒）；首个接口请求在 axios 拦截器内自然等待票据完成
const app = createApp(App);

app.use(createPinia());
app.use(router);
installReveal(app);

// 应用级错误兜底（Vue 渲染/生命周期错误）
app.config.errorHandler = (err) => {
  console.error('[vue error]', err);
};

// 初始化主题（在挂载前应用，避免闪烁）
const theme = useThemeStore();
theme.apply();

app.mount('#app');

// 后台预热反爬安全通道（PoW 换票据）——不阻塞渲染，仅提前开始计算
ensurePass().catch(() => {});
