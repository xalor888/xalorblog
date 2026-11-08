/**
 * 复制文本：全站**唯一**实现（评论链接、AI 回答复制按钮都走这里）。
 *
 * 实现顺序与原先两份重复代码完全一致：
 *   1) `navigator.clipboard.writeText`（安全上下文 / HTTPS）
 *   2) `document.execCommand('copy')` 的 textarea 兜底
 *      （局域网 IP 直接打开时是非安全上下文，没有 clipboard API）
 *   3) iOS Safari 的 `setSelectionRange`（只 `select()` 会复制出空串）
 *
 * 失败返回 `false` 而**不抛错**：调用方各自决定提示文案
 * （评论区弹 toast，AI 面板只把按钮文字变回「复制」）。
 *
 * ⚠ 兜底路径必须读 `execCommand` 的**真实返回值**：
 *   它失败时往往只是返回 false、并不抛异常，
 *   原来写完兜底就无条件当成功 → 非安全上下文下「没复制成功」也提示「已复制」。
 *
 * 历史上还有第三份同构实现（`utils/markdown.js` 的 `copyToClipboard` + `legacyCopy`，
 * 供正文代码块的复制按钮用）。已合并到这里：`copyText` 现在是全站唯一入口，
 * 兜底路径采用原先代码块那份更完整的实现（保留焦点、用 1px 固定定位保证 select() 有效）。
 */

/** execCommand 兜底：返回它真实给出的成功与否（失败可能不抛异常） */
function execCommandCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // 不能用 display:none / visibility:hidden —— 那样 select() 会失效。
  // 固定定位 + 1px + opacity:0 是唯一同时满足「不可见」与「可选中」的组合。
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  const prevFocus = document.activeElement;
  let ok = false;
  try {
    ta.select();
    // iOS Safari 只认 range 选中，仅 select() 会复制出空串
    ta.setSelectionRange(0, ta.value.length);
    ok = document.execCommand('copy') === true;
  } catch (e) {
    ok = false;
  } finally {
    ta.remove();
    // 把焦点还给触发元素（按钮），否则键盘/读屏用户会掉回 body
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try {
        prevFocus.focus({ preventScroll: true });
      } catch (e) {
        /* 老浏览器不认 options 参数 */
      }
    }
  }
  return ok;
}

/**
 * 复制一段文本。
 * @param {string} text 要复制的文本
 * @returns {Promise<boolean>} 是否真的复制成功
 */
export async function copyText(text) {
  const value = String(text ?? '');
  let ok = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch (e) {
      ok = false; // 落到下面的兜底路径
    }
  }
  if (!ok) ok = execCommandCopy(value);
  return ok;
}
