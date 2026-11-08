/**
 * 模态弹层的键盘焦点管理：**唯一实现**。
 *
 * 为什么要有它：搜索弹窗、图片灯箱、快捷键帮助、问 AI 面板原本各自抄了一份
 * 「记录打开前的焦点 / Tab 首尾循环 / 恢复焦点」，四份的实现细节互不相同，
 * 于是四种缺陷：
 *   1. ShortcutHelp 把 `@keydown.tab` 绑在**面板自身**，焦点在面板外时事件
 *      根本进不来 —— `aria-modal="true"` 宣称的约束实际不成立；
 *   2. AskAi 完全没有陷阱（Tab 直接走到背后页面）；
 *   3. 可聚焦元素选择器在两份里少了 `select`、在另一份里又是手写标签清单，
 *      漏一个就开一个洞；
 *   4. 每份都要自己记 body 不算有效返回点、自己判元素是否还在 DOM。
 *
 * 回调语义：
 *   useFocusTrap(panelRef, isOpen, {
 *     onClose,          // Esc → 调用它（是不是真的关由调用方决定）
 *     initialFocus,     // 选择器 / (panel) => Element / 省略 = 面板内第一个可聚焦元素
 *     returnFocusTo,    // Element / (opener) => Element / 省略 = 打开前的 activeElement
 *     preventScroll,    // 还焦时是否 preventScroll
 *   })
 *
 * 为什么注册在 document 级、而不是面板自身的 keydown：
 *   Tab 与 Esc 的目标**经常不在面板里** —— 打开瞬间焦点可能还在 body 上；
 *   用户在面板外点了一下（遮罩、滚动区）焦点就落到 body 或别的元素；
 *   浏览器把焦点移出面板也正是 Tab 陷阱要拦的那一步。
 *   事件只有在 document（冒泡终点之前的公共祖先）上才一定收得到，
 *   面板级监听等于「只在用户已经在面板内时才起作用」——
 *   而这恰恰是唯一不需要拦住的情况。
 */
import { nextTick, onUnmounted, watch } from 'vue';

/**
 * 「可聚焦元素」的统一定义。
 *
 * 不列举标签名：`<kbd tabindex="0">`、`<div role="button" tabindex="0">`
 * 这类都会漏。任何 tabindex 不为 -1 的元素都算，`a[href]` 单独列出是因为
 * 链接可以没有 tabindex 就天然可聚焦。
 */
export const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 面板内当前真正可聚焦的元素，按 DOM 顺序。
 *
 * `offsetParent === null` 一般意味着被 display:none 藏起来了：
 * 把它算进首尾循环，Tab 会落在一个看不见的控件上（焦点「消失」）。
 * 唯一的例外是当前已聚焦的元素 —— 面板刚打开、样式还没算完时它可能是 null。
 */
export function focusablesIn(panel) {
  if (!panel || typeof panel.querySelectorAll !== 'function') return [];
  return [...panel.querySelectorAll(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * 同时开着的模态栈（搜索弹窗上还能再压一层帮助面板）。
 * 只有最上面那层响应 Tab / Esc —— 否则底下那层会把焦点抢回自己身上。
 */
const openTraps = [];

/** 元素是否还在文档里。focus() 一个游离节点不会报错，但焦点会静默丢失。 */
function inDocument(el) {
  if (!el) return false;
  if (el === document.body) return true;
  if (typeof document.contains !== 'function') return true;
  return document.contains(el);
}

function focusEl(el, opts) {
  if (!el || typeof el.focus !== 'function') return false;
  if (!inDocument(el)) return false;
  try {
    opts ? el.focus(opts) : el.focus();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * @param {import('vue').Ref<HTMLElement|null>} panelRef 面板根元素
 * @param {import('vue').Ref<boolean>|(() => boolean)} isOpen 是否打开
 * @param {{onClose?: () => void, initialFocus?: string|((panel: HTMLElement) => Element|null), returnFocusTo?: Element|((opener: Element|null) => Element|null), preventScroll?: boolean}} [options]
 */
export function useFocusTrap(panelRef, isOpen, options = {}) {
  const { onClose, initialFocus = null, returnFocusTo = null, preventScroll = false } = options;

  /** 打开前的焦点。body 不算有效返回点（记下来等于「恢复到 body」= 没恢复）。 */
  let opener = null;
  /** 是否已接管键盘。防重复注册，也防「关闭没开过」时误还原焦点。 */
  let engaged = false;

  /** 模板 ref 可能是元素，也可能是组件实例（`$el`）。 */
  function panelEl() {
    const p = panelRef ? panelRef.value : null;
    return (p && p.$el) || p || null;
  }

  /** 面板打开时焦点该落在哪：显式指定 → 第一个可聚焦元素 → 面板本身。 */
  function resolveInitial(panel) {
    let el = null;
    if (typeof initialFocus === 'function') {
      el = initialFocus(panel);
    } else if (typeof initialFocus === 'string' && panel && typeof panel.querySelector === 'function') {
      el = panel.querySelector(initialFocus);
    }
    if (!el || typeof el.focus !== 'function') {
      const list = focusablesIn(panel);
      el = list[0] || null;
    }
    // 面板里一个可聚焦元素都没有：把面板本身变成焦点落点。
    // 不这么做的话焦点会留在背景页上 —— aria-modal 就成了空话。
    if (!el && panel && typeof panel.setAttribute === 'function') {
      if (typeof panel.hasAttribute === 'function' && !panel.hasAttribute('tabindex')) {
        panel.setAttribute('tabindex', '-1');
      }
      if (typeof panel.focus === 'function') el = panel;
    }
    return el;
  }

  function moveFocusIn() {
    const panel = panelEl();
    if (!panel) return false;
    return focusEl(resolveInitial(panel));
  }

  /** 关闭后该把焦点还给谁：显式指定优先，否则回到打开前的元素。 */
  function resolveReturn() {
    let target = opener;
    if (returnFocusTo) {
      const explicit = typeof returnFocusTo === 'function' ? returnFocusTo(opener) : returnFocusTo;
      if (explicit) target = explicit;
    }
    return target;
  }

  function restoreFocus() {
    const opts = preventScroll ? { preventScroll: true } : undefined;
    if (focusEl(resolveReturn(), opts)) return;
    // 打开它的元素已经不在 DOM 里（导航、条件渲染、被换掉的图片）：
    // 退回 body。焦点留在被移除的节点上，读屏会停在一个不存在的位置。
    focusEl(document.body);
  }

  function onKeydown(e) {
    if (openTraps[openTraps.length - 1] !== trap) return;

    if (e.key === 'Escape') {
      if (typeof onClose === 'function') onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const panel = panelEl();
    if (!panel) return;
    const list = focusablesIn(panel);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;

    // 焦点不在面板内（落到 body、或用户点了一下面板外）：无条件拉回，
    // 不区分方向。只判断「是否正好在首/尾」是不够的 —— 焦点在别处时
    // 两个分支都不成立，Tab 会顺畅地穿到背景页的 skip-link / nav 上。
    if (!active || !panel.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
      return;
    }
    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const trap = { onKeydown };

  function engage() {
    if (engaged) return;
    engaged = true;
    const active = document.activeElement;
    opener = active && active !== document.body ? active : null;
    openTraps.push(trap);
    document.addEventListener('keydown', onKeydown);
    // 面板可能刚被 v-if 挂上（还在 teleport / transition 里），
    // 等这一帧渲染完再移焦点 —— 顺序反了会 focus 到一个还不存在的节点。
    nextTick(() => {
      if (engaged) moveFocusIn();
    });
  }

  function disengage({ restore = true } = {}) {
    if (!engaged) return;
    engaged = false;
    const i = openTraps.indexOf(trap);
    if (i !== -1) openTraps.splice(i, 1);
    document.removeEventListener('keydown', onKeydown);
    if (restore) restoreFocus();
    opener = null;
  }

  // flush: 'post' —— 等 DOM 更新完再动焦点；immediate —— 组件挂载时
  // 已经是打开态（服务端直出 / 深层链接）也能接管。
  watch(
    isOpen,
    (open) => {
      if (open) engage();
      else disengage();
    },
    { flush: 'post', immediate: true }
  );

  // 兜底：组件被直接卸载（路由切走、父级 v-if）时把监听摘掉。
  // 不还焦 —— 卸载通常意味着触发元素也跟着没了，硬还只会把焦点丢给 body。
  onUnmounted(() => disengage({ restore: false }));

  /**
   * 手动接管 / 释放。
   *
   * 为什么需要：`watch(isOpen)` 用的是 `flush: 'post'`，对 `v-if` 弹层够用，
   * 但 Element Plus 的 `<el-dialog>` 有过渡动画 —— `v-model` 变 true 时元素
   * 还在 teleport / transition 里，`nextTick` 后仍可能没上屏。
   * 那种弹层应该用 EP 的 `@opened` 事件（内容真正可见后）调 `engage()`。
   *
   * 对已有调用方无影响（它们继续用 watch 自动接管）。
   */
  return { FOCUSABLE, focusablesIn, engage, disengage };
}

export default useFocusTrap;
