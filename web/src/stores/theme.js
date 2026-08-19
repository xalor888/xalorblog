import { defineStore } from 'pinia';
import { ref, computed, watchEffect } from 'vue';

// 可选主题强调色（低饱和、有质感的编辑感色板）
export const THEME_COLORS = [
  { name: '珊瑚', value: '#e4573d' },
  { name: '琥珀', value: '#c9900f' },
  { name: '黛绿', value: '#217a5e' },
  { name: '黛蓝', value: '#2f6fb3' },
  { name: '绛红', value: '#c24b5e' },
  { name: '堇紫', value: '#6d5bb8' },
  { name: '青碧', value: '#0f8f8f' },
  { name: '紫藤', value: '#8b5fb0' },
];

export const useThemeStore = defineStore('theme', () => {
  // 主题模式三态：auto（跟随系统）/ light / dark；默认 auto
  const safeGet = (key) => {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  };
  const mode = ref(safeGet('xalor_theme') || 'auto');
  const systemDark = ref(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const isDark = computed(
    () => mode.value === 'dark' || (mode.value === 'auto' && systemDark.value)
  );
  // 强调色：严格校验十六进制格式，非法存储值（旧版遗留/手动篡改）
  // 直接回退默认色，防 NaN 注入 CSS 变量导致整站颜色失效
  const DEFAULT_ACCENT = '#e4573d';
  const storedAccent = safeGet('xalor_accent');
  const accent = ref(/^#[0-9a-f]{6}$/i.test(storedAccent) ? storedAccent : DEFAULT_ACCENT);

  function apply() {
    const root = document.documentElement;
    root.dataset.theme = isDark.value ? 'dark' : 'light';
    root.style.setProperty('--accent', accent.value);
    // 主题色自动生成浅/深变体
    root.style.setProperty('--accent-soft', mix(accent.value, isDark.value ? '#ffffff' : '#ffffff', isDark.value ? 0.06 : 0.9));
    root.style.setProperty('--accent-deep', shade(accent.value, 0.28));
    // 同步 Element Plus 主色
    root.style.setProperty('--el-color-primary', accent.value);
    root.style.setProperty('--el-color-primary-dark-2', shade(accent.value, 0.25));
    root.style.setProperty('--el-color-primary-light-3', mix(accent.value, '#ffffff', 0.55));
    root.style.setProperty('--el-color-primary-light-5', mix(accent.value, '#ffffff', 0.7));
    root.style.setProperty('--el-color-primary-light-7', mix(accent.value, '#ffffff', 0.85));
    root.style.setProperty('--el-color-primary-light-8', mix(accent.value, '#ffffff', 0.9));
    root.style.setProperty('--el-color-primary-light-9', mix(accent.value, '#ffffff', isDark.value ? 0.82 : 0.95));
    // 移动端浏览器地址栏配色跟随主题
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', isDark.value ? '#171512' : accent.value);
  }

  /** 主题/强调色切换时短暂启用全局过渡，实现柔和渐变（首屏不触发） */
  let transitionTimer = null;
  function flashTransition() {
    const root = document.documentElement;
    root.classList.add('theme-transition');
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 450);
  }

  /** 循环切换：auto → light → dark → auto */
  function toggleTheme() {
    const next = mode.value === 'auto' ? 'light' : mode.value === 'light' ? 'dark' : 'auto';
    setMode(next);
  }

  /** 显式设置主题模式 */
  function setMode(m) {
    mode.value = m;
    try { localStorage.setItem('xalor_theme', m); } catch (e) { /* 隐私模式忽略 */ }
    flashTransition();
    apply();
  }

  function setAccent(color) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return; // 非法值忽略
    accent.value = color;
    try { localStorage.setItem('xalor_accent', color); } catch (e) { /* 隐私模式忽略 */ }
    flashTransition();
    apply();
  }

  watchEffect(apply);

  // 系统主题变化实时跟随（auto 模式；手动模式不响应系统变化）
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', (e) => {
    systemDark.value = e.matches;
    flashTransition();
    apply();
  });

  return { isDark, mode, accent, apply, toggleTheme, setMode, setAccent };
});

// 色彩工具
function parseHex(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function shade(hex, amount) {
  const { r, g, b } = parseHex(hex);
  const mix = (c) => Math.round(c * (1 - amount));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** 与白色/目标色混合出浅色 */
function mix(hex, target, amount) {
  const { r, g, b } = parseHex(hex);
  const t = parseHex(target);
  const m = (c, tc) => Math.round(c + (tc - c) * amount);
  return `rgb(${m(r, t.r)}, ${m(g, t.g)}, ${m(b, t.b)})`;
}
