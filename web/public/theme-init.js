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
      // 深色下主色用加深变体（与 theme.js apply() 的约定一致：
      // 内联变量优先级高于样式表，必须直接给出深色取值）
      var r = parseInt(accent.slice(1, 3), 16);
      var g = parseInt(accent.slice(3, 5), 16);
      var b = parseInt(accent.slice(5, 7), 16);
      var f = dark ? 0.72 : 1;
      document.documentElement.style.setProperty(
        '--accent',
        'rgb(' + Math.round(r * f) + ', ' + Math.round(g * f) + ', ' + Math.round(b * f) + ')'
      );
    }
  } catch (e) { /* 忽略 */ }
})();
