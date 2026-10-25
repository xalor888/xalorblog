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

// ---------------------------------------------------------------------------
// 命令式组件（ElMessage / ElMessageBox）的主题样式必须显式引入。
//
// 它们不写在任何模板里，而是以 API 形式在脚本中调用；而本项目源码一律用
// `import { ElMessage, ElMessageBox } from 'element-plus'` 显式引入，标识符
// 已存在 → unplugin-auto-import 不会介入 → 按需样式（style/css）也不会被注入。
// 缺失的正是 element-plus/theme-chalk 的这几个基座文件：
//   el-overlay.css     → .el-overlay{position:fixed;inset:0;z-index:2000}（遮罩定位）
//   el-message.css     → .el-message{position:fixed;display:flex;background-color:…}
//   el-message-box.css → MessageBox 的 flex 容器与图标绝对定位
// 一旦缺失，遮罩退化为文档流元素：弹窗被追加到 <body> 末尾、堆在页面最底部，
// 既没有层级也点不动；Toast 则丢背景色与 flex，文字互相叠在一起。
//
// 必须放在 ./styles/main.css 之前，保证下面的主题覆盖能生效。
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';

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

/**
 * 全局兜底：把「出错了」这件事告诉用户，而不是只写进控制台。
 *
 * 注释原本写着「避免静默白屏，至少给出提示」——但两个处理器都只做了
 * `console.error`。实测：派发一个未捕获错误，页面毫无变化、没有任何提示，
 * 用户会以为自己刚才的操作成功了。**注释描述的行为和代码不一致**，
 * 而这类不一致比没写注释更危险（下一个维护者会以为已经兜住了）。
 *
 * 现在真的给提示，并且做了必要的抑制：
 * - 401/403 由 axios 拦截器统一处理（会跳登录），这里不重复弹；
 * - ERR_CANCELED 是主动取消（超时重试、切路由），不是错误；
 * - 同一时刻大量错误（例如某个组件在循环里抛）只提示一次，避免刷屏。
 *
 * 用 ElMessage 而不是自绘 toast：它自带 role="alert"，读屏能听到
 * （这一点本项目此前已经实测确认过）。
 */
let lastErrorToastAt = 0;
const ERROR_TOAST_INTERVAL = 4000; // 4 秒内最多一条，防连环错误刷屏

function notifyUnexpected(reason) {
  const status = reason?.response?.status;
  if (status === 401 || status === 403) return; // 拦截器已处理
  if (reason?.code === 'ERR_CANCELED') return; // 主动取消，不算错误
  const now = Date.now();
  if (now - lastErrorToastAt < ERROR_TOAST_INTERVAL) return;
  lastErrorToastAt = now;
  ElMessage.error('页面遇到了一点问题，请刷新重试');
}

// 全局未捕获异常兜底
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e?.reason);
  notifyUnexpected(e?.reason);
});

// 同步抛出的未捕获错误（事件处理器、第三方脚本等）
window.addEventListener('error', (e) => {
  // 资源加载失败（img/script）也会触发 error 但不带 e.error，不提示
  if (!e?.error) return;
  console.error('[uncaught error]', e.error);
  notifyUnexpected(e.error);
});

// 先挂载应用：首屏立即渲染骨架，不被 PoW 求解阻塞（低端设备/高信誉 IP 难度下
// 白屏可达数秒）；首个接口请求在 axios 拦截器内自然等待票据完成
const app = createApp(App);

app.use(createPinia());
app.use(router);
installReveal(app);

// 应用级错误兜底（Vue 渲染/生命周期错误）。
// Vue 会捕获组件内异常，所以它们不会走到上面的 window 'error' 事件 ——
// 这里必须单独提示，否则组件渲染失败对用户是完全静默的。
app.config.errorHandler = (err) => {
  console.error('[vue error]', err);
  notifyUnexpected(err);
};

// 初始化主题（在挂载前应用，避免闪烁）
const theme = useThemeStore();
theme.apply();

app.mount('#app');

// 后台预热反爬安全通道（PoW 换票据）——不阻塞渲染，仅提前开始计算
ensurePass().catch(() => {});
