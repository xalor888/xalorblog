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
    // 深色强调色：与 CSS 约定对齐（[data-theme='dark'] --accent = --accent-deep）。
    // 内联变量优先级高于样式表，必须在 JS 侧直接给出深色取值，否则深色永远用浅色主色。
    //
    // ⚠ 深色下的方向是「提亮」而不是「调暗」：
    //   样式表里 [data-theme='dark'] 的约定是 --accent: var(--accent-deep)，
    //   而 --accent-deep-dark 比浅色主色更亮（#e4573d → #ff8a6e）。
    //   旧实现在这里调了 shade(..., 0.28)（把 #e4573d 压成 #a43f2c），
    //   内联变量又盖过样式表，于是深色下所有主色文字与 bg(#12110f) 的对比度
    //   只有 2.99:1 —— 远低于 WCAG AA 的 4.5:1（实测：eyebrow / 公告标签 /
    //   归档年份计数 / 阅读更多 等一批小字全部不达标）。
    //   提亮到 mix(白, 0.28) 后实测 6.1:1，且视觉上仍是同一个强调色。
    const base = isDark.value ? mix(accent.value, '#ffffff', 0.28) : accent.value;
    root.style.setProperty('--accent', base);
    // 主题色自动生成浅/深变体
    // --accent-soft 是「主色的淡底」，用于 chip / 标签底色。
    // 浅色主题：向白色混 90% → 极淡的珊瑚底（正对）。
    // 深色主题：**不能继续混白色** —— 混 6% 得到的几乎是原色 (实测 rgb(230,97,73))，
    // 于是「主色文字 + 淡底」变成了「亮字压亮底」，对比度只有 1.33:1。
    // 深色下应该向**页面底色**混，得到一块比背景略亮的暗珊瑚底。
    root.style.setProperty(
      '--accent-soft',
      isDark.value
        ? mix(accent.value, '#12110f', 0.82)
        : mix(accent.value, '#ffffff', 0.9)
    );
    // --accent-deep 在语义上是「比主色更强的强调」，深色下同样要更亮而不是更暗
    root.style.setProperty(
      '--accent-deep',
      isDark.value ? mix(accent.value, '#ffffff', 0.4) : shade(accent.value, 0.28)
    );
    // 实心填充色（主色作底 + 白字）：**不随深色提亮**。
    // --accent 在深色下变亮是为了当文字时对深底够对比度；同一抹亮色配白字
    // 只有 2.55:1（实测「发布留言」/ skip-link / .btn-primary）。
    // 底色与前景对亮度的需求相反，所以这里保持原色的饱和度。
    // 压深 18%：白字对原色 (#e4573d) 只有 3.67:1，达不到 AA 的 4.5:1。
    // 压深后约 4.6:1，观感仍是同一个珊瑚（按钮本来就该比文字重一点）。
    root.style.setProperty('--accent-fill', shade(accent.value, 0.18));
    // 同步 Element Plus 主色（深色下主色提亮、light-N 朝深底压暗，镜像样式表深色色板的配方）
    const brightBase = isDark.value ? mix(accent.value, '#ffffff', 0.1) : accent.value;
    root.style.setProperty('--el-color-primary', brightBase);
    root.style.setProperty('--el-color-primary-dark-2', isDark.value
      ? mix(accent.value, '#ffffff', 0.12)
      : shade(accent.value, 0.25));
    root.style.setProperty('--el-color-primary-light-3', isDark.value ? mix(brightBase, '#12110f', 0.3) : mix(accent.value, '#ffffff', 0.55));
    root.style.setProperty('--el-color-primary-light-5', isDark.value ? mix(brightBase, '#12110f', 0.55) : mix(accent.value, '#ffffff', 0.7));
    root.style.setProperty('--el-color-primary-light-7', isDark.value ? mix(brightBase, '#12110f', 0.8) : mix(accent.value, '#ffffff', 0.85));
    root.style.setProperty('--el-color-primary-light-8', isDark.value ? mix(brightBase, '#12110f', 0.88) : mix(accent.value, '#ffffff', 0.9));
    root.style.setProperty('--el-color-primary-light-9', isDark.value ? mix(brightBase, '#12110f', 0.9) : mix(accent.value, '#ffffff', 0.95));
    // 移动端浏览器地址栏配色跟随主题（深色值与 --bg-dark 一致）
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', isDark.value ? '#12110f' : accent.value);
  }

  /** 主题/强调色切换时短暂启用全局过渡，实现柔和渐变（首屏不触发）。
      仅作 View Transitions 不可用时的降级路径。 */
  let transitionTimer = null;
  function flashTransition() {
    const root = document.documentElement;
    root.classList.add('theme-transition');
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 450);
  }

  const prefersReducedMotion = () =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  /** 切换过渡：优先 View Transitions 整页快照交叉淡化——渐变背景、玻璃材质、
      粒子画布作为一个整体淡入淡出，避免逐元素过渡引发的重绘风暴与
      backdrop-filter 重采样马赛克。降级/减少动态时直接套类过渡或直切。 */
  function withTransition(mutate) {
    if (prefersReducedMotion()) {
      mutate();
      return;
    }
    if (typeof document.startViewTransition === 'function') {
      document.startViewTransition(() => mutate());
      return;
    }
    flashTransition();
    mutate();
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
    withTransition(apply);
  }

  function setAccent(color) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return; // 非法值忽略
    accent.value = color;
    try { localStorage.setItem('xalor_accent', color); } catch (e) { /* 隐私模式忽略 */ }
    withTransition(apply);
  }

  watchEffect(apply);

  // 系统主题变化实时跟随（auto 模式；手动模式不响应系统变化）
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', (e) => {
    systemDark.value = e.matches;
    withTransition(apply);
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
