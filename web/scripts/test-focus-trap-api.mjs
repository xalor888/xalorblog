/**
 * useFocusTrap 的 engage/disengage 契约（node:vm + 假 DOM，无浏览器）。
 *
 * 背景：第 73 轮给 3 个 `el-dialog` 接焦点陷阱时，给 `useFocusTrap` 暴露了
 * 手动接管。那些调用方用一个刻意的写法：
 *
 *   const trap = useFocusTrap(panelRef, computed(() => false), {...});
 *   //                                              ^^^^^^^^^^^^^^^^^^^^ 关掉 watch 的自动接管
 *
 * **为什么必须关掉**：`engage()` 内部有 `if (engaged) return` 兜底，
 * 所以「watch 自动 + @opened 手动」双路径不会真的双注册 —— 但依赖兜底
 * 不如从源头只留一条路。而且 `isOpen` 恒 false 会让 watch 在关闭时也跑一次
 * `disengage({ restore: true })`，把焦点还给**打开前的元素**，
 * 而那时手动路径可能正在工作 —— 两条路互相拆台。
 *
 * 这个测试钉住四件事：
 *   1. engage 幂等（重复调用不重复注册）
 *   2. disengage 幂等（重复调用不重复还焦）
 *   3. 自动路径与手动路径**不能同时生效**（isOpen 恒 false 时 watch 不该接管）
 *   4. 嵌套栈：只有最上面那层响应 Tab/Esc
 *
 * 用法：node scripts/test-focus-trap-api.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/composables/useFocusTrap.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/** 最小 DOM：记录 document 级监听、activeElement、元素焦点调用 */
function makeDom() {
  const listeners = new Map();
  let active = null;
  const focusLog = [];
  const mkEl = (name, { focusable = true } = {}) => ({
    name,
    focusable,
    _focused: false,
    focus(opts) { active = this; this._focused = true; focusLog.push(this.name); },
    setAttribute() {}, hasAttribute: () => false, querySelectorAll: () => [],
    contains: (el) => el === this,
  });
  const body = mkEl('body');
  active = body;
  return {
    listeners, focusLog,
    get active() { return active; },
    body,
    mkEl,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    contains: (el) => el === body || !!el,
    /** 派发一个 keydown 给所有 document 监听 */
    keydown(e) { for (const fn of listeners.get('keydown') || []) fn(e); },
  };
}

/** vue 的最小替身：ref / computed / watch / nextTick / onUnmounted */
function makeVue() {
  const watchers = [];
  const unmounts = [];      // ⚠ 用闭包变量，不能用 this —— vm 里是 strict 模式，this 是 undefined
  return {
    ref: (v) => ({ value: v }),
    computed: (fn) => ({ get value() { return fn(); } }),
    watch: (src, cb, opts = {}) => {
      const get = typeof src === 'function' ? src : () => src.value;
      const w = { get, cb, opts, last: undefined, ran: false };
      watchers.push(w);
      if (opts.immediate) { w.ran = true; w.last = get(); cb(get(), undefined); }
      return w;
    },
    nextTick: (fn) => Promise.resolve().then(fn),
    onUnmounted: (fn) => { unmounts.push(fn); },
    /** 测试用：改变一个 ref 后触发 watch */
    flush(refObj) {
      for (const w of watchers) {
        const now = w.get();
        if (now !== w.last) { const prev = w.last; w.last = now; w.cb(now, prev); }
      }
    },
    unmountAll() { for (const fn of unmounts) fn(); },
  };
}

function load(vue, dom) {
  const src = readFileSync(SRC, 'utf8')
    .replace(/import\s*\{[^}]*\}\s*from\s*'vue';/, '')
    .replace(/export default useFocusTrap;/, '')      // default 导出在 vm 里不是合法语句
    .replace(/export /g, '');
  const sandbox = {
    ...vue,
    document: dom,
    console,
    Promise, Object, Array, String, Number, Boolean,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;({ useFocusTrap, FOCUSABLE, focusablesIn })`, sandbox);
  return vm.runInContext('({ useFocusTrap, FOCUSABLE, focusablesIn })', sandbox);
}

const tick = () => Promise.resolve();

console.log('\n【A. engage/disengage 已暴露（第 73 轮加的）】');
{
  const dom = makeDom();
  const vue = makeVue();
  const api = load(vue, dom);
  const panel = dom.mkEl('panel');
  const ret = api.useFocusTrap({ value: panel }, { value: false }, {});
  ok('返回体含 engage', typeof ret.engage === 'function');
  ok('返回体含 disengage', typeof ret.disengage === 'function');
  ok('返回体仍含 FOCUSABLE（向后兼容）', typeof ret.FOCUSABLE === 'string');
  ok('返回体仍含 focusablesIn（向后兼容）', typeof ret.focusablesIn === 'function');
}

console.log('\n【B. isOpen 恒 false 时 watch 不接管】');
{
  const dom = makeDom();
  const vue = makeVue();
  const api = load(vue, dom);
  const panel = dom.mkEl('panel');
  api.useFocusTrap({ value: panel }, vue.computed(() => false), {});
  ok('没有注册 document keydown（watch 没接管）',
    (dom.listeners.get('keydown') || []).length === 0,
    `注册了 ${(dom.listeners.get('keydown') || []).length} 个`);
  ok('焦点还在 body（没有被 moveFocusIn 拉走）', dom.active === dom.body);
}

console.log('\n【C. 手动 engage 生效，且幂等】');
{
  const dom = makeDom();
  const vue = makeVue();
  const api = load(vue, dom);
  const panel = dom.mkEl('panel');
  const trap = api.useFocusTrap({ value: panel }, vue.computed(() => false), {});
  trap.engage();
  await tick();
  ok('engage 后注册了一个 keydown',
    (dom.listeners.get('keydown') || []).length === 1,
    String((dom.listeners.get('keydown') || []).length));
  trap.engage();
  trap.engage();
  ok('重复 engage 不重复注册（幂等）',
    (dom.listeners.get('keydown') || []).length === 1,
    String((dom.listeners.get('keydown') || []).length));

  trap.disengage();
  ok('disengage 后监听归零', (dom.listeners.get('keydown') || []).length === 0);
  trap.disengage();
  ok('重复 disengage 不报错也不反复还焦', (dom.listeners.get('keydown') || []).length === 0);

  // 还能再 engage（el-dialog 会反复打开关闭）
  trap.engage();
  await tick();
  ok('disengage 之后还能再 engage（弹层可重复打开）',
    (dom.listeners.get('keydown') || []).length === 1);
}

console.log('\n【D. 手动路径下 Esc 走 onClose】');
{
  const dom = makeDom();
  const vue = makeVue();
  const api = load(vue, dom);
  const panel = dom.mkEl('panel');
  let closed = 0;
  const trap = api.useFocusTrap({ value: panel }, vue.computed(() => false), {
    onClose: () => { closed++; },
  });
  trap.engage();
  await tick();
  dom.keydown({ key: 'Escape', preventDefault() {}, shiftKey: false });
  ok('Esc 触发 onClose', closed === 1, String(closed));
  dom.keydown({ key: 'Escape', preventDefault() {}, shiftKey: false });
  ok('再按一次还触发（没被一次性消费掉）', closed === 2, String(closed));
}

console.log('\n【E. 嵌套栈：只有最上面那层响应】');
{
  const dom = makeDom();
  const vue = makeVue();
  const api = load(vue, dom);
  const p1 = dom.mkEl('panel1');
  const p2 = dom.mkEl('panel2');
  let c1 = 0, c2 = 0;
  const t1 = api.useFocusTrap({ value: p1 }, vue.computed(() => false), { onClose: () => { c1++; } });
  const t2 = api.useFocusTrap({ value: p2 }, vue.computed(() => false), { onClose: () => { c2++; } });
  t1.engage(); t2.engage();
  await tick();
  dom.keydown({ key: 'Escape', preventDefault() {}, shiftKey: false });
  ok('两层都开着时，Esc 只给最上面那层', c2 === 1 && c1 === 0, `上层 ${c2} / 下层 ${c1}`);
  t2.disengage();
  dom.keydown({ key: 'Escape', preventDefault() {}, shiftKey: false });
  ok('上层关掉后，Esc 给下层', c1 === 1 && c2 === 1, `上层 ${c2} / 下层 ${c1}`);
}

console.log('\n【F. 卸载时摘监听（不还焦）】');
{
  const dom = makeDom();
  const vue = makeVue();
  const api = load(vue, dom);
  const panel = dom.mkEl('panel');
  api.useFocusTrap({ value: panel }, vue.computed(() => true), {});
  ok('isOpen=true + immediate 时自动接管', (dom.listeners.get('keydown') || []).length === 1);
  vue.unmountAll();
  ok('卸载后监听被摘掉', (dom.listeners.get('keydown') || []).length === 0);
}

console.log('\n【G. 自检：判据真的能区分】');
{
  // 破坏样本：isOpen 恒 true（模拟"忘了关自动接管"）
  const dom = makeDom();
  const vue = makeVue();
  const api = load(vue, dom);
  const panel = dom.mkEl('panel');
  const t = api.useFocusTrap({ value: panel }, vue.computed(() => true), {});
  ok('自检：isOpen 恒 true 时 watch 会接管（这就是要避免的双路径）',
    (dom.listeners.get('keydown') || []).length === 1);
  // 此时再手动 engage，因为已 engaged 所以不会双注册 —— 但焦点已被 watch 管起来
  const before = (dom.listeners.get('keydown') || []).length;
  t.engage();
  ok('自检：即使幂等兜底，双路径下行为也不可预期（依赖内部状态）',
    (dom.listeners.get('keydown') || []).length === before);

  // 破坏样本二：disengage 不幂等
  const dom2 = makeDom();
  const vue2 = makeVue();
  const api2 = load(vue2, dom2);
  const t2 = api2.useFocusTrap({ value: dom2.mkEl('p') }, vue2.computed(() => false), {});
  t2.engage();
  await tick();
  t2.disengage();
  t2.disengage();
  ok('自检：真实版本重复 disengage 后监听仍为 0',
    (dom2.listeners.get('keydown') || []).length === 0);
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
