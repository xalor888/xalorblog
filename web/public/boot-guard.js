/**
 * 启动超时兜底。
 *
 * 为什么需要、且为什么必须是**外部文件**：
 * 1. 如果 main.js 的 import 链断了（网络中断、CDN 挂了、浏览器不支持 ESM），
 *    **模块根本不会执行** —— 所以 main.js 里的 try/catch 一条都跑不到。
 *    实测阻断 vue 依赖后，启动骨架永远停在「正在加载页面…」，
 *    读者等不到任何结果。这比白屏更糟：白屏至少让人怀疑网络，
 *    永远「加载中」让人以为只是慢。
 * 2. 不能用内联 `<script>`：本项目的 CSP 是 `script-src 'self'`，
 *    内联脚本会被直接拒绝执行（这条我踩过一次 —— 写完内联版构建通过、
 *    运行时静默不生效）。
 *
 * 12 秒：足以覆盖慢网下的 bundle 下载，又不至于让人干等太久。
 */
(function () {
  var TIMEOUT_MS = 12000;
  setTimeout(function () {
    var host = document.getElementById('app');
    // Vue 一旦挂载成功，骨架就被替换掉了 —— 只在这种情况介入
    if (!host || !host.querySelector('.boot-skeleton')) return;

    host.innerHTML = '';
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'max-width:560px;margin:96px auto;padding:24px;text-align:center;'
      + 'font:15px/1.6 system-ui,-apple-system,sans-serif;color:#444;';

    var title = document.createElement('p');
    title.style.cssText = 'font-size:1.05rem;font-weight:600;margin:0 0 8px;';
    title.textContent = '页面加载时间过长';

    var desc = document.createElement('p');
    desc.style.cssText = 'margin:0 0 18px;opacity:.72;';
    desc.textContent = '可能是网络较慢或脚本被拦截。可以刷新重试。';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '刷新页面';
    btn.style.cssText =
      'padding:9px 20px;border-radius:9px;border:1px solid rgba(128,128,128,.36);'
      + 'background:transparent;font:inherit;cursor:pointer;';
    btn.onclick = function () { location.reload(); };

    box.appendChild(title);
    box.appendChild(desc);
    box.appendChild(btn);
    host.appendChild(box);
  }, TIMEOUT_MS);
})();
