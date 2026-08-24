import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { fileURLToPath, URL } from 'node:url';

// 动态 API 前缀：与后端 API_PREFIX 保持一致（生产建议改为随机字符串）
// 注意：必须用 loadEnv 读取 .env 文件（process.env 拿不到 .env 的变量），
// 否则前端配置的 VITE_API_PREFIX 不会生效
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const API_PREFIX = env.VITE_API_PREFIX || '/api';
  // 开发服务器默认仅监听回环地址。确需局域网调试时显式设置
  // VITE_DEV_HOST=0.0.0.0，并配合主机防火墙与 VITE_DEV_ALLOWED_HOSTS。
  const DEV_HOST = env.VITE_DEV_HOST || '127.0.0.1';
  const DEV_ALLOWED_HOSTS = String(env.VITE_DEV_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  // 构建期默认盐；运行时闸门挑战会下发服务端 ENC_SALT 覆盖
  const ENC_SALT = env.VITE_ENC_SALT || 'xalor-content-v1';

  return {
    plugins: [
      vue(),
      // Element Plus 按需引入：ElMessage/ElMessageBox 等 API 与 el-* 组件自动导入
      AutoImport({
        resolvers: [ElementPlusResolver()],
        dts: false,
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        dts: false,
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      'import.meta.env.VITE_API_PREFIX': JSON.stringify(API_PREFIX),
      'import.meta.env.VITE_ENC_SALT': JSON.stringify(ENC_SALT),
    },
    server: {
      port: 5173,
      host: DEV_HOST,
      ...(DEV_ALLOWED_HOSTS.length ? { allowedHosts: DEV_ALLOWED_HOSTS } : {}),
      proxy: {
        [API_PREFIX]: {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
        '/uploads': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
    build: {
      target: 'es2020',
      // terser 混淆：生产代码压缩 + 剥离注释与 console（构建期剥离比运行时 anti-debug
      // 钩子更彻底——即使反调试被绕过，控制台也无任何输出可利用）
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: true,
          passes: 2,
        },
        format: {
          comments: false,
        },
      },
      cssMinify: true,
      sourcemap: false,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['vue', 'vue-router', 'pinia'],
            markdown: ['marked', 'highlight.js', 'dompurify'],
          },
        },
      },
    },
  };
});
