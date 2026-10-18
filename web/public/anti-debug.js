/**
 * Xalor 反调试脚本 v4（移动端误报修复）
 *
 * v3 的问题：把「窗口外框与视口的高度差」和「debugger 语句耗时」当作 DevTools 证据。
 * 这两条在手机浏览器上天然成立 —— Edge Android / Edge iOS 的地址栏、状态栏与
 * 可收缩工具栏会让 outerHeight - innerHeight 轻松超过 160px，移动端 JIT 冷启动
 * 也可能让 debugger 计时超过 100ms。结果是正常手机用户被全屏遮蔽层判成
 * 「打开了开发者工具」，整站不可用。
 *
 * v4 的判据：
 *  - 移动端（UA 或 UA-CH 声明 mobile）**不做**窗口尺寸差与 debugger 计时判断，
 *    只保留元素尺寸探针（DevTools 停靠时才会让 1px 变化失真）；
 *  - 桌面端保留三条判据，但窗口差阈值提到 320px，并要求**连续 2 个检测周期**
 *    都命中才触发（单次抖动不再误伤）；
 *  - 关闭开发者工具后自动恢复；`localStorage['xalor_dev_mode']='1'` 仍可整体关闭。
 *
 * 复制 / 文本选中 / 右键菜单仍不在此脚本处理（见 web/src/utils/copyGuard.js）。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  try {
    if (localStorage.getItem('xalor_dev_mode') === '1') return;
  } catch (e) { /* 忽略 */ }

  var warned = false;
  var devtoolsOpen = false;
  var strikes = 0;

  /** 连续多少个周期命中才判定为 DevTools（单次抖动不算） */
  var STRIKES_REQUIRED = 2;
  /** 桌面端窗口外框与视口的差值上限：DevTools 停靠通常 >350px，浏览器自身 UI 一般 <200px */
  var WIN_DIFF_LIMIT = 320;
  /** 桌面端 debugger 计时上限（毫秒）；移动端不参与判定 */
  var DEBUGGER_LIMIT = 150;

  /**
   * 移动端判定：UA-CH → UA 文本 → iPadOS 桌面外壳判定。
   *
   * 三种情况都要覆盖：
   *  1. UA-CH 明确 mobile（Chromium 系）；
   *  2. UA 文本含 Android/iPhone/iPad/Mobile，以及 `EdgA/`（Edge Android）、
   *     `EdgiOS/`（Edge iOS）这类**不含** Mobile 字样的壳；
   *  3. **iPadOS 13+ 的「请求桌面网站」**：UA 变成 `Macintosh; Intel Mac OS X …`，不含 iPad/Mobile，
   *     而 Safari 又不支持 UA-CH，于是上面两条都落空、被当成桌面端。用业界通用判据
   *     `platform === 'MacIntel' && maxTouchPoints > 1` 补上（真 Mac 的 maxTouchPoints 是 0）。
   *     这条只在**移动端多出放行**，不影响桌面判据：触屏 Mac 不存在，Mac 也不会报 MacIntel + 多点触控。
   */
  var IS_MOBILE = (function () {
    try {
      if (navigator.userAgentData && navigator.userAgentData.mobile === true) return true;
      var ua = navigator.userAgent || '';
      if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone|EdgA\/|EdgiOS\//i.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true;
      return false;
    } catch (e) {
      return false;
    }
  })();

  /* ---------- 检测 1：元素宽高差（DevTools 停靠） ---------- */
  var probe = document.createElement('div');
  probe.id = '__x_probe__';
  probe.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:120px;height:90px;pointer-events:none;';
  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(probe);
  });

  function detectByElement() {
    if (!probe.parentNode) return false;
    var w = probe.offsetWidth;
    var h = probe.offsetHeight;
    probe.style.width = '121px';
    probe.style.height = '91px';
    var w2 = probe.offsetWidth;
    var h2 = probe.offsetHeight;
    probe.style.width = '120px';
    probe.style.height = '90px';
    // DevTools 打开时元素测量会异常
    return w2 - w !== 1 || h2 - h !== 1;
  }

  /* ---------- 检测 2：窗口尺寸差（仅桌面端） ---------- */
  function detectByWindow() {
    // 移动端浏览器地址栏/工具栏会让 outer 与 inner 天然相差很大，不能作为调试证据
    if (IS_MOBILE) return false;
    var widthDiff = (window.outerWidth - window.innerWidth) || 0;
    var heightDiff = (window.outerHeight - window.innerHeight) || 0;
    return widthDiff > WIN_DIFF_LIMIT || heightDiff > WIN_DIFF_LIMIT;
  }

  /* ---------- 检测 3：debugger 断点耗时（仅桌面端） ---------- */
  function detectByDebugger() {
    // 移动端没有可停靠的 DevTools，计时噪声只会制造误报
    if (IS_MOBILE) return false;
    var t0 = Date.now();
    /* eslint-disable no-debugger */
    debugger;
    /* eslint-enable no-debugger */
    return Date.now() - t0 > DEBUGGER_LIMIT;
  }

  /* ---------- 反制：无限 debugger + 遮蔽层 ---------- */
  function triggerAntiDebug() {
    if (warned) return;
    warned = true;
    devtoolsOpen = true;

    try {
      console.log('%c⚠ 检测到调试行为，请关闭开发者工具', 'color:#e4573d;font-size:15px;font-weight:bold;');
    } catch (e) { /* 忽略 */ }

    // 无限 debugger：DevTools 保持打开即持续卡死
    function infiniteDebug() {
      /* eslint-disable no-debugger */
      debugger;
      /* eslint-enable no-debugger */
      setTimeout(infiniteDebug, 0);
    }
    infiniteDebug();

    // 全屏遮蔽层：DevTools 关闭后自动恢复
    if (!document.getElementById('__x_shield__')) {
      var shield = document.createElement('div');
      shield.id = '__x_shield__';
      shield.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#faf9f6;color:#1d1b16;display:flex;align-items:center;justify-content:center;font-family:sans-serif;text-align:center;';
      shield.innerHTML = '<div style="padding:24px"><h1 style="font-size:22px;margin-bottom:12px">请关闭开发者工具</h1><p style="color:#55503f;font-size:14px">本站启用了安全防护，检测到调试行为。<br>关闭开发者工具后页面将自动恢复。</p></div>';
      document.body.appendChild(shield);
    }
  }

  function releaseShield() {
    if (warned && !devtoolsOpen) {
      warned = false;
      var shield = document.getElementById('__x_shield__');
      if (shield && shield.parentNode) shield.parentNode.removeChild(shield);
    }
  }

  /* ---------- 定时检测循环 ---------- */
  setInterval(function () {
    // 后台标签页跳过检测（节能：不可见时无调试行为可检测）
    if (document.hidden) return;
    var found = detectByWindow() || detectByElement() || detectByDebugger();
    if (found) strikes++;
    else strikes = 0;

    if (!devtoolsOpen && strikes >= STRIKES_REQUIRED) {
      triggerAntiDebug();
    } else if (devtoolsOpen && strikes === 0) {
      devtoolsOpen = false;
      releaseShield();
    }
  }, 1200);

  /* ---------- 键盘拦截 ---------- */
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toUpperCase();
    var ctrlShift = e.ctrlKey && e.shiftKey;
    var ctrl = e.ctrlKey || e.metaKey;
    // 输入区（编辑器/表单）：Ctrl+S 放行给应用（文章编辑器的保存快捷键）
    var tag = (e.target && e.target.tagName) || '';
    var inField = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
    // Ctrl+P 不拦截：打印是正常功能（站点提供打印样式）
    if (
      e.key === 'F12' ||
      (ctrlShift && (k === 'I' || k === 'J' || k === 'C' || k === 'K')) ||
      (ctrl && k === 'U') ||
      (ctrl && k === 'S' && !inField)
    ) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    return true;
  }, true);

  /* ---------- 复制/选中/右键：不再无条件拦截 ----------
     复制默认是允许的。是否需要拦截由站点设置决定：
       settings.allow_copy（全站） × 文章自身 allow_copy（单篇）
     前端在 web/src/utils/copyGuard.js 按这两个开关动态挂载/卸载监听，
     本脚本只负责与「调试行为」相关的防护。 */

  /* ---------- console 全面静默 ---------- */
  var warnedOnce = false;
  ['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(function (method) {
    var original = console[method];
    console[method] = function () {
      if (!warnedOnce) {
        warnedOnce = true;
        try {
          original.call(console, '%cXalor的小站 · 已启用安全防护，本站不提供调试入口', 'color:#e4573d;font-size:13px;font-weight:bold;');
        } catch (e) { /* 忽略 */ }
      }
    };
  });

  /* ---------- eval 拦截（防控制台内联执行） ---------- */
  try {
    window.eval = function () {
      console.warn('本页已禁止动态执行');
      return undefined;
    };
  } catch (e) { /* 忽略 */ }
})();
