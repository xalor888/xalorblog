/**
 * Xalor 反调试脚本 v3（腾讯视频级）
 * - DevTools 检测：元素宽高差 / debugger 断点耗时 / console 劫持探测
 * - 检测到后：无限 debugger + 全屏遮蔽层
 * - 键盘拦截：F12 / Ctrl+Shift+I/J/C / Ctrl+U / Ctrl+P / Ctrl+S
 * - 右键菜单禁用（输入区保留）
 * - 文本选择与图片拖拽禁用（输入区保留）
 * - console 全面静默：仅显示一条定制提示
 * - 开发模式可通过 localStorage['xalor_dev_mode']='1' 关闭
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  try {
    if (localStorage.getItem('xalor_dev_mode') === '1') return;
  } catch (e) { /* 忽略 */ }

  var warned = false;
  var devtoolsOpen = false;

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

  /* ---------- 检测 2：窗口尺寸差 ---------- */
  function detectByWindow() {
    var widthDiff = (window.outerWidth - window.innerWidth) || 0;
    var heightDiff = (window.outerHeight - window.innerHeight) || 0;
    return widthDiff > 160 || heightDiff > 160;
  }

  /* ---------- 检测 3：debugger 断点耗时 ---------- */
  function detectByDebugger() {
    var t0 = Date.now();
    /* eslint-disable no-debugger */
    debugger;
    /* eslint-enable no-debugger */
    return Date.now() - t0 > 100;
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
    if (found) {
      triggerAntiDebug();
    } else if (devtoolsOpen) {
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

  /* ---------- 右键菜单禁用（保留输入区） ---------- */
  document.addEventListener('contextmenu', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
  }, true);

  /* ---------- 文本选择禁用（保留输入区） ---------- */
  document.addEventListener('selectstart', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
  }, true);

  /* ---------- 图片拖拽禁用 ---------- */
  document.addEventListener('dragstart', function (e) {
    if (e.target && e.target.tagName === 'IMG') {
      e.preventDefault();
      return false;
    }
  }, true);

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
