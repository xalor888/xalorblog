// 主题初始化：防暗色模式刷新闪烁（CSS 加载前设置 data-theme；auto 模式跟随系统）
// 独立外部文件（非内联）：使 CSP 可收紧为 script-src 'self'（无 unsafe-inline）——
// 内容层 XSS 即使逃逸也无法注入内联脚本读取 localStorage 令牌外传
(function () {
  try {
    var saved = localStorage.getItem('xalor_theme');
    var dark = saved === 'dark'
      || (saved !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.dataset.theme = 'dark';
    var accent = localStorage.getItem('xalor_accent');
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
      // ⚠ 这里必须与 theme.js 的 apply() 给出**完全相同**的结果。
      // 内联变量优先级高于样式表，所以首屏这一帧由这里决定；
      // 一旦两边算得不一样，用户会先看到一种颜色、Vue 启动后再跳成另一种
      // （典型的「刷新时闪一下」）。
      //
      // 曾经的真实 bug：这里用 ×0.72 **调暗**，而 theme.js 用向白色混 28% **提亮**。
      // 深色用户首屏看到 #a43f2c（暗红），挂载后跳成 #ec8673（亮珊瑚），
      // 而且暗红那版对深底的对比度只有 2.99:1 —— 正是本轮修掉的缺陷在这里的残留。
      var r = parseInt(accent.slice(1, 3), 16);
      var g = parseInt(accent.slice(3, 5), 16);
      var b = parseInt(accent.slice(5, 7), 16);
      var mixWhite = function (c, amount) { return Math.round(c + (255 - c) * amount); };
      var shade = function (c, amount) { return Math.round(c * (1 - amount)); };
      // --accent：深色提亮 28%，浅色原样
      var a = dark
        ? [mixWhite(r, 0.28), mixWhite(g, 0.28), mixWhite(b, 0.28)]
        : [r, g, b];
      document.documentElement.style.setProperty('--accent', 'rgb(' + a[0] + ', ' + a[1] + ', ' + a[2] + ')');
      // --accent-deep：深色提亮 40%，浅色压深 28%（与 theme.js 一致）
      var d = dark
        ? [mixWhite(r, 0.4), mixWhite(g, 0.4), mixWhite(b, 0.4)]
        : [shade(r, 0.28), shade(g, 0.28), shade(b, 0.28)];
      document.documentElement.style.setProperty('--accent-deep', 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')');
      // --accent-text：浅色用压深 18% 的文字色；深色跟随提亮后的 accent-deep
      var t = dark
        ? [mixWhite(r, 0.4), mixWhite(g, 0.4), mixWhite(b, 0.4)]
        : [shade(r, 0.18), shade(g, 0.18), shade(b, 0.18)];
      document.documentElement.style.setProperty('--accent-text', 'rgb(' + t[0] + ', ' + t[1] + ', ' + t[2] + ')');
      // --accent-fill：实心底 + 白字，始终压深 18%（不随主题提亮）
      document.documentElement.style.setProperty(
        '--accent-fill',
        'rgb(' + shade(r, 0.18) + ', ' + shade(g, 0.18) + ', ' + shade(b, 0.18) + ')'
      );
      // --accent-soft：浅色向白混 90%，深色向页面底色混 82%
      var soft = dark
        ? [Math.round(r * 0.18 + 18 * 0.82), Math.round(g * 0.18 + 17 * 0.82), Math.round(b * 0.18 + 15 * 0.82)]
        : [mixWhite(r, 0.9), mixWhite(g, 0.9), mixWhite(b, 0.9)];
      document.documentElement.style.setProperty('--accent-soft', 'rgb(' + soft[0] + ', ' + soft[1] + ', ' + soft[2] + ')');
    }
  } catch (e) { /* 忽略 */ }
})();
