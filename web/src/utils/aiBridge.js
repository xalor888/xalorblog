/**
 * AI 面板 ↔ 当前页面 的桥
 *
 * 页面向 AI 提供三样东西：
 *   - context：当前正在编辑的内容（标题/正文/标签…），AI 据此理解上下文
 *   - selection：编辑器里实时选中的文本（润色选区用）
 *   - applier：执行 AI 下发的动作（改标题、写正文…），因为只有页面自己知道怎么改表单
 *
 * 另有一个撤销栈：applier 在改内容前把旧值压栈，面板上可一键撤销最近一次 AI 修改。
 * 用模块级 ref 而不是 pinia：这里只需要一个"当前页面"的单例，够用且零样板。
 */

import { ref, computed } from 'vue';

/** 当前页面提供给 AI 的上下文（无则为 null） */
export const aiContext = ref(null);
/** 编辑器当前选区 { text, start, end }（无则为 null） */
export const aiSelection = ref(null);
/** 当前页面注册的动作处理器 */
const applier = ref(null);
/** 撤销栈：[{ label, restore }]，栈顶是最近一次可撤销的 AI 修改 */
const undoStack = ref([]);

export function setAiContext(ctx) {
  aiContext.value = ctx || null;
}

/** 页面编辑器在选区变化时调用（select/keyup/mouseup 都要触发） */
export function setAiSelection(sel) {
  if (sel && typeof sel.text === 'string' && sel.text) {
    aiSelection.value = { text: sel.text.slice(0, 4000), start: sel.start, end: sel.end };
  } else {
    aiSelection.value = null;
  }
}

export function setAiApplier(fn) {
  applier.value = typeof fn === 'function' ? fn : null;
}

/**
 * applier 改内容前调用：压入一条撤销记录
 * @param {string} label 展示用标签，如「已替换正文」
 * @param {() => void} restore 恢复函数（闭包持有旧值）
 */
export function pushAiUndo(label, restore) {
  if (typeof restore !== 'function') return;
  undoStack.value.push({ label, restore });
  if (undoStack.value.length > 12) undoStack.value.shift();
}

/** 撤销最近一次 AI 修改，返回其标签；栈空返回 null */
export function undoAiLast() {
  const top = undoStack.value[undoStack.value.length - 1];
  if (!top) return null;
  try {
    top.restore();
  } catch (e) {
    /* 恢复失败（页面已切换等）就弹掉这条 */
  }
  undoStack.value.pop();
  return top.label;
}

/** 是否有可撤销的修改（面板据此显示撤销按钮） */
export const aiCanUndo = computed(() => undoStack.value.length > 0);

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

/** 页面卸载时清理，避免旧页面的处理器残留到新页面（撤销栈一并清：restore 已失效） */
export function resetAiBridge() {
  aiContext.value = null;
  aiSelection.value = null;
  applier.value = null;
  undoStack.value = [];
}
