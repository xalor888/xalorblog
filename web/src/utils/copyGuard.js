/**
 * 复制守卫：按站点设置决定是否拦截「选中文字 / 复制 / 右键菜单 / 图片拖拽」。
 *
 * 两个开关（都允许才放行）：
 *   - `settings.allow_copy`  全站开关（后台「设置」页）
 *   - 文章自身的 `allow_copy` 单篇开关（后台文章编辑页），仅在文章页生效
 * 非文章页只看全站开关。两者默认都为 true —— 即**默认允许复制**。
 *
 * 为什么放在应用层而不是 anti-debug.js：
 *   1. anti-debug 是静态脚本、先于应用执行，读不到后台设置；
 *   2. 默认是「允许复制」，拦截只在站长明确关掉时才挂载，
 *      不该写死在每个访客都会加载的静态脚本里。
 */

/** 被拦截的事件：选中起点 / 右键菜单 / 图片拖拽 */
const BLOCKED_EVENTS = ['selectstart', 'contextmenu', 'dragstart'];

let globalAllowed = true;
/** 当前文章是否允许复制（非文章页无意义，恒 true） */
let articleAllowed = true;
/** 是否正处于文章页 */
let articleScope = false;
let installed = false;

/** 输入区始终放行；dragstart 只针对图片 */
function onBlock(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.type === 'dragstart' && (!t || t.tagName !== 'IMG')) return;
  e.preventDefault();
}

/** 当前页面是否允许复制 */
function isCopyAllowed() {
  return globalAllowed && (!articleScope || articleAllowed);
}

function apply() {
  const shouldBlock = !isCopyAllowed();
  if (shouldBlock && !installed) {
    BLOCKED_EVENTS.forEach((type) => document.addEventListener(type, onBlock, true));
    installed = true;
  } else if (!shouldBlock && installed) {
    BLOCKED_EVENTS.forEach((type) => document.removeEventListener(type, onBlock, true));
    installed = false;
  }
}

/** 全站开关（设置就绪或变更时调用） */
export function setGlobalCopyAllowed(value) {
  globalAllowed = value !== false;
  apply();
}

/** 进入文章页：声明该篇是否允许复制 */
export function setArticleCopyAllowed(value) {
  articleScope = true;
  articleAllowed = value !== false;
  apply();
}

/** 离开文章页：复位文章作用域（回到只受全站开关控制） */
export function clearArticleCopyScope() {
  articleScope = false;
  articleAllowed = true;
  apply();
}
