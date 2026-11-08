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
    /**
     * --accent-text（「主色作为**文字**」专用）：必须在这里**每次都写**。
     *
     * ⚠ 原来这个变量只由 public/theme-init.js 在首屏写一次内联值，apply() 从不碰它。
     * 于是「页面以浅色加载 → 用户点主题按钮切到深色」时，内联的浅色公式
     * `shade(accent, 0.18)` 会**一直留着**：珊瑚 3.65:1、黛绿 2.67:1、堇紫 2.59:1
     * —— 八个主题色里七个跌破 WCAG AA 4.5:1，而全部 114 处 `color: var(--accent-text)`
     * 的小字（阅读全文 / 置顶 / 公告标签 / 章节计数）都吃这一份。
     * 反向（深色加载 → 切浅色）更糟：`mix(accent, #fff, 0.4)` 对浅底只有 1.65–2.27:1。
     * 内联变量优先级高于样式表，所以样式表里那两条正确的 dark/light 定义根本救不了。
     *
     * 浅色压深 0.28（不是 0.18）：0.18 对默认珊瑚刚好 4.71 过线，但**琥珀只有 3.68**
     * —— 与 --accent-fill 当年踩的是同一个坑（按默认色调参，色板里最亮的那个不达标）。
     * 0.28 时八色对页底与对 accent-soft 淡底双双 ≥4.5。
     */
    root.style.setProperty(
      '--accent-text',
      isDark.value ? mix(accent.value, '#ffffff', 0.4) : shade(accent.value, 0.28)
    );
    // 实心填充色（主色作底 + 白字）：**不随深色提亮**。
    // --accent 在深色下变亮是为了当文字时对深底够对比度；同一抹亮色配白字
    // 只有 2.55:1（实测「发布留言」/ skip-link / .btn-primary）。
    // 底色与前景对亮度的需求相反，所以这里保持原色的饱和度。
    // 压深比例要按**全部七个主题色**里最难的那个来定，不能只看默认的珊瑚。
    // 原为 0.18：珊瑚 5.17:1 达标，但**琥珀只有 4.04:1**（实测 dark + #c9900f 的 skip-link），
    // 差 0.46 没过 AA。0.24 时七色分别为
    // 珊瑚 5.84 / 琥珀 4.62 / 黛绿 7.78 / 黛蓝 7.78 / 绛红 7.20 / 堇紫 8.08 / 青碧 6.14，
    // 全部 ≥4.5，而观感上仍是同一个色（只是重了一点点，按钮本来就该比文字重）。
    // theme-init.js 与 main.css 的字面量必须同为 0.24 —— 否则首屏那一帧是 0.18，
    // 挂载后跳成 0.24，典型「刷新闪一下」；深色首屏用的 --accent-dark (#f06a4e)
    // 配白字更是只有 3.05:1。
    root.style.setProperty('--accent-fill', shade(accent.value, 0.24));
    // 同步 Element Plus 主色（深色下主色提亮、light-N 朝深底压暗，镜像样式表深色色板的配方）
    // ⚠ brightBase 是 mix() 返回的 'rgb(r, g, b)' 字符串，下面还要拿它继续 mix ——
    //   所以颜色工具必须吃得下 rgb() 输入（旧 parseHex 只认 #rrggbb，会算出 rgb(NaN, NaN, NaN)，
    //   浏览器整条丢弃 → 深色下 EP 的 light-3/5/7/8/9 全部退回默认蓝）。
    const brightBase = isDark.value ? mix(accent.value, '#ffffff', 0.1) : accent.value;
    root.style.setProperty('--el-color-primary', brightBase);
    // dark-2 语义上应当比 primary **更暗**（EP 用它做 hover/active 加深）。
    // 旧值 mix(accent, white, 0.12) 反而更亮，与 primary(0.10) 只差 2% —— 视觉上等于同色。
    root.style.setProperty('--el-color-primary-dark-2', isDark.value
      ? mix(brightBase, '#12110f', 0.25)
      : shade(accent.value, 0.25));
    // light-N 阶梯：越往下越接近底色。旧系数（浅 .55/.70/.85/.90/.95、深 .30/.55/.80/.88/.90）
    // 让 light-9 与页底对比度只有 1.00:1（浅）与 1.12:1（深）—— 选中/悬停填充几乎看不出来。
    // 新系数把整条阶梯压进「可辨」区间，且保持单调（light-9 最淡）：实测对比度见
    // scripts/test-derived-tokens.mjs 的【D】组（浅 1.24:1 / 深 1.38:1）。
    root.style.setProperty('--el-color-primary-light-3', isDark.value ? mix(brightBase, '#12110f', 0.30) : mix(accent.value, '#ffffff', 0.40));
    root.style.setProperty('--el-color-primary-light-5', isDark.value ? mix(brightBase, '#12110f', 0.50) : mix(accent.value, '#ffffff', 0.55));
    root.style.setProperty('--el-color-primary-light-7', isDark.value ? mix(brightBase, '#12110f', 0.66) : mix(accent.value, '#ffffff', 0.66));
    root.style.setProperty('--el-color-primary-light-8', isDark.value ? mix(brightBase, '#12110f', 0.72) : mix(accent.value, '#ffffff', 0.72));
    root.style.setProperty('--el-color-primary-light-9', isDark.value ? mix(brightBase, '#12110f', 0.78) : mix(accent.value, '#ffffff', 0.78));
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

/**
 * 颜色解析：同时接受 `#rrggbb` 与 `mix()/shade()` 自己产出的 `rgb(r, g, b)`。
 *
 * 为什么必须两种都认：深色 EP 色阶是**链式**的 —— 先把主色 mix 成 `--el-color-primary`
 * （字符串），再拿这个字符串继续 mix 出 light-3/5/7/8/9。旧 parseHex 只会按
 * `h.slice(0,2)` 取十六进制：喂进去 `'rgb(231, 104, 80)'` 时 r 通道是 `parseInt('rg')` = NaN，
 * g/b 还会从 `'b('`、`'23'` 里被 parseInt 侥幸读出 11/35 这种垃圾值（实测旧 dark light-3
 * 输出 `rgb(NaN, 13, 29)`）—— 只要有一个通道是 NaN，整条声明就算非法被浏览器丢弃，
 * 于是深色主题下 EP 的 light-3/5/7/8/9 静默变回默认蓝（不报错、控制台无痕迹，
 * 只能靠肉眼在深色下看按钮）。
 *
 * 无法识别的输入退回黑色：宁可颜色不准，也绝不把 NaN 写进 CSS（声明会被静默丢弃）。
 */
function parseColor(input) {
  const s = String(input).trim();
  if (s.charAt(0) === '#') {
    const h = s.slice(1);
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:[,/]\s*[\d.]+\s*)?\)$/i);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

/** 历史名：解析入口现在同时认 hex 与 rgb()，老调用点保持可读 */
const parseHex = parseColor;

function shade(color, amount) {
  const { r, g, b } = parseColor(color);
  const mix = (c) => Math.round(c * (1 - amount));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** 与白色/目标色混合出浅色（target 可以是 hex，也可以是本方产出的 rgb() 字符串） */
function mix(color, target, amount) {
  const { r, g, b } = parseColor(color);
  const t = parseColor(target);
  const m = (c, tc) => Math.round(c + (tc - c) * amount);
  return `rgb(${m(r, t.r)}, ${m(g, t.g)}, ${m(b, t.b)})`;
}
