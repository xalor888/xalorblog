/**
 * AI 面板 ↔ 当前页面 的桥
 *
 * 页面向 AI 提供两样东西：
 *   - context：当前正在编辑的内容（标题/正文/标签…），AI 据此理解上下文
 *   - applier：执行 AI 下发的动作（改标题、写正文…），因为只有页面自己知道怎么改表单
 *
 * 用模块级 ref 而不是 pinia：这里只需要一个"当前页面"的单例，够用且零样板。
 */

import { ref } from 'vue';

/** 当前页面提供给 AI 的上下文（无则为 null） */
export const aiContext = ref(null);
/** 当前页面注册的动作处理器 */
const applier = ref(null);

export function setAiContext(ctx) {
  aiContext.value = ctx || null;
}

export function setAiApplier(fn) {
  applier.value = typeof fn === 'function' ? fn : null;
}

/**
 * 执行 AI 下发的动作
 * @returns {string|null} 人类可读的执行结果；未注册处理器时返回 null（页面不支持该动作）
 */
export function applyAiAction(name, args) {
  if (!applier.value) return null;
  try {
    return applier.value(name, args) || null;
  } catch (e) {
    return null;
  }
}

/** 页面卸载时清理，避免旧页面的处理器残留到新页面 */
export function resetAiBridge() {
  aiContext.value = null;
  applier.value = null;
}
