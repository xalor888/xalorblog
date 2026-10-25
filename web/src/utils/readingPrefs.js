/**
 * 阅读偏好（字号 / 行距 / 版心宽度 / 字体风格 / 沉浸模式）
 *
 * 抽成纯模块的原因：这些值全部来自 localStorage，而 localStorage 里可能是
 * 旧版本写下的、被手动改过的、或者干脆是 `NaN` 的值。直接 `Number(...)` 用，
 * 坏值会一路灌进行内样式 —— `font-size: NaNpx` 是一条非法声明，浏览器丢弃后
 * 回落到默认值，看起来就是「用户调的字号没生效」，极难排查。
 *
 * 所以统一在这里做：解析 → 夹到合法区间 → 非法即回落默认值。
 * storage 通过参数注入，测试不需要造 window。
 */

export const FONT_SIZE = { min: 14, max: 20, def: 16 };
export const LINE_HEIGHT = { min: 1.5, max: 2.4, def: 1.9, step: 0.15 };
export const READ_WIDTH = { min: 620, max: 980, def: 760, step: 60 };

export const STORAGE_KEYS = {
  fontSize: 'xalor_font_size',
  lineHeight: 'xalor_line_height',
  readWidth: 'xalor_read_width',
  fontStyle: 'xalor_font_style',
  focusMode: 'xalor_focus_mode',
};

/** 读一个字符串；隐私模式/被禁用时 storage 会抛，不能让它炸掉整个组件 */
function readRaw(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch (e) {
    return null;
  }
}

function writeRaw(storage, key, value) {
  try {
    storage?.setItem(key, String(value));
  } catch (e) {
    /* 隐私模式忽略：本次会话内仍然生效，只是不记忆 */
  }
}

/**
 * 解析数字并夹到 [min, max]。
 * 注意 `Number('')` 是 0、`Number(null)` 也是 0 —— 两者都会被下面的
 * `Number.isFinite` 放过去，所以必须先排除空串/null 再谈数值。
 */
function clampNumber(raw, spec) {
  if (raw === null || raw === undefined || raw === '') return spec.def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

export function loadFontSize(storage) {
  return clampNumber(readRaw(storage, STORAGE_KEYS.fontSize), FONT_SIZE);
}

export function loadLineHeight(storage) {
  // 行距是小数，不能让浮点误差（1.9000000000000001）漏进样式，统一按 2 位取整
  const v = clampNumber(readRaw(storage, STORAGE_KEYS.lineHeight), LINE_HEIGHT);
  return Math.round(v * 100) / 100;
}

export function loadReadWidth(storage) {
  return clampNumber(readRaw(storage, STORAGE_KEYS.readWidth), READ_WIDTH);
}

/** 字体风格只有两种合法值，其余（含旧版写错的 'Serif'）一律回落 sans */
export function loadFontStyle(storage) {
  return readRaw(storage, STORAGE_KEYS.fontStyle) === 'serif' ? 'serif' : 'sans';
}

/** 沉浸模式是开关，只认 '1' */
export function loadFocusMode(storage) {
  return readRaw(storage, STORAGE_KEYS.focusMode) === '1';
}

/** 步进：dir = +1 / -1。到边界后返回原值（调用方据此判断要不要提示「已到最大」） */
export function stepFontSize(current, dir) {
  const base = clampNumber(current, FONT_SIZE);
  return Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, base + Math.sign(dir || 1)));
}

export function stepLineHeight(current, dir) {
  const base = clampNumber(current, LINE_HEIGHT);
  const next = base + LINE_HEIGHT.step * Math.sign(dir || 1);
  return Math.round(Math.min(LINE_HEIGHT.max, Math.max(LINE_HEIGHT.min, next)) * 100) / 100;
}

export function stepReadWidth(current, dir) {
  const base = clampNumber(current, READ_WIDTH);
  return Math.min(READ_WIDTH.max, Math.max(READ_WIDTH.min, base + READ_WIDTH.step * Math.sign(dir || 1)));
}

export const saveFontSize = (storage, v) => writeRaw(storage, STORAGE_KEYS.fontSize, clampNumber(v, FONT_SIZE));
export const saveLineHeight = (storage, v) => writeRaw(storage, STORAGE_KEYS.lineHeight, clampNumber(v, LINE_HEIGHT));
export const saveReadWidth = (storage, v) => writeRaw(storage, STORAGE_KEYS.readWidth, clampNumber(v, READ_WIDTH));
export const saveFontStyle = (storage, v) => writeRaw(storage, STORAGE_KEYS.fontStyle, v === 'serif' ? 'serif' : 'sans');
export const saveFocusMode = (storage, v) => writeRaw(storage, STORAGE_KEYS.focusMode, v ? '1' : '0');

/** 一行文字大约多少字：CJK 按字号算宽，用来给「版心」一个可读的反馈文案 */
export function charsPerLine(width, fontSize) {
  const size = clampNumber(fontSize, FONT_SIZE);
  return Math.round(clampNumber(width, READ_WIDTH) / size);
}
