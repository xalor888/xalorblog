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
/** 撤销栈：[{ id, label, restore }]，栈顶是最近一次可撤销的 AI 修改 */
const undoStack = ref([]);
let snapshotSeq = 0;

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
 * @returns {number} 快照 id（面板用它把「应用标签」和「可撤销项」对上，防止撤销错位）
 */
export function pushAiUndo(label, restore) {
  if (typeof restore !== 'function') return 0;
  const id = ++snapshotSeq;
  undoStack.value.push({ id, label, restore });
  if (undoStack.value.length > 12) undoStack.value.shift();
  return id;
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

/** 栈顶快照 id（面板据此判断哪个标签是可撤销的） */
export function aiUndoTopId() {
  return undoStack.value.length ? undoStack.value[undoStack.value.length - 1].id : 0;
}

/** 是否有可撤销的修改（面板据此显示撤销按钮） */
export const aiCanUndo = computed(() => undoStack.value.length > 0);

/**
 * 执行 AI 下发的动作
 * @returns {Promise<{label: string, snapshotId: number}|null>}
 *   执行成功返回标签与关联快照（snapshotId=0 表示该动作不可撤销，如保存草稿）；
 *   未注册处理器或执行失败时返回 null。applier 可以是 async。
 */
export function applyAiAction(name, args) {
  if (!applier.value) return Promise.resolve(null);
  const before = aiUndoTopId();
  const wrap = (label) => {
    if (!label) return null;
    const after = aiUndoTopId();
    return { label, snapshotId: after !== before ? after : 0 };
  };
  try {
    const ret = applier.value(name, args);
    return ret instanceof Promise ? ret.then(wrap, () => null) : Promise.resolve(wrap(ret));
  } catch (e) {
    return Promise.resolve(null);
  }
}

/** 页面卸载时清理，避免旧页面的处理器残留到新页面（撤销栈一并清：restore 已失效） */
export function resetAiBridge() {
  aiContext.value = null;
  aiSelection.value = null;
  applier.value = null;
  undoStack.value = [];
}
