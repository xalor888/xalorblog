// 主题初始化：防暗色模式刷新闪烁（CSS 加载前设置 data-theme；auto 模式跟随系统）
// 独立外部文件（非内联）：使 CSP 可收紧为 script-src 'self'（无 unsafe-inline）——
// 内容层 XSS 即使逃逸也无法注入内联脚本读取 localStorage 令牌外传
(function () {
  try {
    var saved = localStorage.getItem('xalor_theme');
    var dark = saved === 'dark'
      || (saved !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.dataset.theme = 'dark';

    // ---- 色彩工具：与 src/stores/theme.js 的 mix()/shade() 同一套数学（纯 ES5 数组版）----
    // 深色色阶是**链式**的：先把主色混白 10% 得到主色，再拿它朝深底压暗出 light-N，
    // 所以这里必须支持「拿本方产出的通道数组继续混合」。
    var PAGE = [18, 17, 15]; // #12110f（深色 --bg-dark）
    var WHITE = [255, 255, 255];
    var mixTo = function (c, t, amount) { return Math.round(c + (t - c) * amount); };
    var mixArr = function (p, q, amount) {
      return [mixTo(p[0], q[0], amount), mixTo(p[1], q[1], amount), mixTo(p[2], q[2], amount)];
    };
    var shadeArr = function (p, amount) {
      return [shade(p[0], amount), shade(p[1], amount), shade(p[2], amount)];
    };
    var rgbStr = function (p) { return 'rgb(' + p[0] + ', ' + p[1] + ', ' + p[2] + ')'; };
    var mixWhite = function (c, amount) { return Math.round(c + (255 - c) * amount); };
    var shade = function (c, amount) { return Math.round(c * (1 - amount)); };

    // ---- 强调色：**先取到值**，再决定要不要写 ----
    // ⚠ 这里必须先把默认色落地。绝大多数首访者 localStorage 里根本没有 xalor_accent，
    // 旧实现把整个写变量段落都关在「存过合法 accent」这个 if 里，于是这些用户的首帧
    // 只能吃 main.css 的字面量：EP 的色阶与挂载后 theme.js 算出来的不是一套 →
    // 按钮/链接/表头先是一种颜色，Vue 一启动就跳成另一种（「刷新闪一下」）。
    var DEFAULT_ACCENT = '#e4573d';
    var storedAccent = localStorage.getItem('xalor_accent');
    var hasAccent = !!(storedAccent && /^#[0-9a-f]{6}$/i.test(storedAccent));
    var accent = hasAccent ? storedAccent : DEFAULT_ACCENT;
    var r = parseInt(accent.slice(1, 3), 16);
    var g = parseInt(accent.slice(3, 5), 16);
    var b = parseInt(accent.slice(5, 7), 16);

    {
      // 这一段**无条件**写（不再区分用户有没有自定义过强调色）。
      //
      // 曾经只在 hasAccent 时写，理由是「没存过值时交给样式表字面量」。但样式表与
      // apply() 并不总是同值：深色下 main.css 写的是 `--accent: var(--accent-deep)`
      // （混白 40%），而 apply() 写的是混白 28% —— 于是没自定义过颜色的深色用户
      // 首帧看到 40% 那档，Vue 一启动跳成 28%，与 EP 色阶是同一类残余跳变。
      // 现在两边无条件写且必须逐值相同；main.css 只作「JS 未执行」时的兜底。
      //
      // 内联变量优先级高于样式表，首屏这一帧完全由这里决定；两边算得不一样
      // 就是「刷新闪一下」。历史 bug：这里曾用 ×0.72 调暗而 apply() 混白提亮，
      // 深色首屏 #a43f2c、挂载后 #ec8673，且前者对深底只有 2.99:1。
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
      // --accent-text：浅色用压深 28% 的文字色；深色跟随提亮后的 accent-deep
      // 为什么是 0.28 而不是 0.18：0.18 对默认珊瑚刚好 4.71:1 过线，但琥珀只有
      // 3.68:1（色板里最亮的那个永远是最难的），与 --accent-fill 当年同一类错。
      var t = dark
        ? [mixWhite(r, 0.4), mixWhite(g, 0.4), mixWhite(b, 0.4)]
        : [shade(r, 0.28), shade(g, 0.28), shade(b, 0.28)];
      document.documentElement.style.setProperty('--accent-text', 'rgb(' + t[0] + ', ' + t[1] + ', ' + t[2] + ')');
      // --accent-fill：实心底 + 白字，始终压深 24%（不随主题提亮）。
      // 24% 是遍历八个主题色、取「最亮的琥珀」也能让白字 ≥4.5:1 的最小压深；
      // theme.js 与 main.css 的字面量都是 0.24，三处必须同步。
      document.documentElement.style.setProperty(
        '--accent-fill',
        'rgb(' + shade(r, 0.24) + ', ' + shade(g, 0.24) + ', ' + shade(b, 0.24) + ')'
      );
      // --accent-soft：浅色向白混 90%，深色向页面底色混 82%
      var soft = dark
        ? [Math.round(r * 0.18 + 18 * 0.82), Math.round(g * 0.18 + 17 * 0.82), Math.round(b * 0.18 + 15 * 0.82)]
        : [mixWhite(r, 0.9), mixWhite(g, 0.9), mixWhite(b, 0.9)];
      document.documentElement.style.setProperty('--accent-soft', 'rgb(' + soft[0] + ', ' + soft[1] + ', ' + soft[2] + ')');
    }

    // ---- Element Plus 主色族：**无条件**写七个变量（不依赖 localStorage）----
    // 为什么要无条件：这七个值是 EP 按钮/链接/表头/plain 填充的实际颜色来源。
    // 没自定义过强调色的用户占绝大多数，他们首帧原本吃 main.css 的字面量，
    // 而 main.css 那套系数与 theme.js 完全不是一套 → 挂载即跳色。
    // 现在首帧与挂载后都走这一份公式，两边同源（main.css 的字面量只作为
    // 「JS 未执行」的兜底，且同样由 theme.js 的公式算得，见 main.css 注释）。
    var baseRGB = [r, g, b];
    var elPrimary = dark ? mixArr(baseRGB, WHITE, 0.1) : baseRGB;
    // 系数与 stories/theme.js 完全同一套（2026-11-08 调整：旧阶梯 light-9 与页底
    // 只有 1.00:1（浅）/1.12:1（深），选中行与表头看不出被选中）。
    var elDark2 = dark ? mixArr(elPrimary, PAGE, 0.25) : shadeArr(baseRGB, 0.25);
    var elLight3 = dark ? mixArr(elPrimary, PAGE, 0.30) : mixArr(baseRGB, WHITE, 0.40);
    var elLight5 = dark ? mixArr(elPrimary, PAGE, 0.50) : mixArr(baseRGB, WHITE, 0.55);
    var elLight7 = dark ? mixArr(elPrimary, PAGE, 0.66) : mixArr(baseRGB, WHITE, 0.66);
    var elLight8 = dark ? mixArr(elPrimary, PAGE, 0.72) : mixArr(baseRGB, WHITE, 0.72);
    var elLight9 = dark ? mixArr(elPrimary, PAGE, 0.78) : mixArr(baseRGB, WHITE, 0.78);
    document.documentElement.style.setProperty('--el-color-primary', rgbStr(elPrimary));
    document.documentElement.style.setProperty('--el-color-primary-dark-2', rgbStr(elDark2));
    document.documentElement.style.setProperty('--el-color-primary-light-3', rgbStr(elLight3));
    document.documentElement.style.setProperty('--el-color-primary-light-5', rgbStr(elLight5));
    document.documentElement.style.setProperty('--el-color-primary-light-7', rgbStr(elLight7));
    document.documentElement.style.setProperty('--el-color-primary-light-8', rgbStr(elLight8));
    document.documentElement.style.setProperty('--el-color-primary-light-9', rgbStr(elLight9));
  } catch (e) { /* 忽略 */ }
})();
