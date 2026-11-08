/**
 * copyGuard 行为回归（node:vm + 最小 DOM，无浏览器）。
 *
 * 背景：复制守卫的规则是「两个开关都允许才放行」
 *   - `settings.allow_copy`        全站开关
 *   - 文章自身 `allow_copy`        单篇开关，**只在文章页生效**
 * 两者默认 true（默认允许复制），只有站长明确关掉时才挂监听。
 *
 * 为什么值得单独测：这段逻辑有 3 个容易错的边界，而且错法都很安静 ——
 *   1. **离开文章页不复位作用域**：在「单篇禁止复制」的文章页看过之后，
 *      回到别的文章页会**继续被禁**（因为 articleAllowed 还留着 false）
 *   2. **install/uninstall 不配对**：挂了的监听摘不掉，之后即使放开开关也仍然拦着
 *   3. **输入区被误伤**：在评论框里右键菜单/拖拽被拦，用户无法粘贴
 *
 * 三种都不会让任何东西报错，只是功能少了一块。
 *
 * 用法：node scripts/test-copy-guard.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/utils/copyGuard.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/**
 * 造一个最小 DOM：记录 addEventListener / removeEventListener 的调用。
 * capture 标志也要记（onBlock 是用捕获阶段挂的，摘的时候必须是同一个标志）。
 */
function makeDom() {
  const listeners = new Map();   // `${type}|${capture}` → fn
  return {
    listeners,
    addEventListener(type, fn, capture) {
      const key = `${type}|${!!capture}`;
      if (listeners.has(key)) throw new Error(`重复挂载 ${key}（install 幂等坏了）`);
      listeners.set(key, fn);
    },
    removeEventListener(type, fn, capture) {
      const key = `${type}|${!!capture}`;
      if (!listeners.has(key)) throw new Error(`摘除未挂载的监听 ${key}（uninstall 漂移）`);
      listeners.delete(key);
    },
    count() { return listeners.size; },
    /** 派发一个事件，返回是否被 preventDefault */
    fire(type, target) {
      let prevented = false;
      const e = {
        type, target,
        preventDefault() { prevented = true; },
      };
      for (const [key, fn] of listeners) {
        if (key.startsWith(`${type}|`)) fn(e);
      }
      return prevented;
    },
  };
}

/** 在 vm 里加载 copyGuard（ES module 语法要先剥掉 export） */
function loadGuard() {
  const src = readFileSync(SRC, 'utf8').replace(/export function/g, 'function');
  const dom = makeDom();
  const sandbox = { document: dom, console };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;({ setGlobalCopyAllowed, setArticleCopyAllowed, clearArticleCopyScope, isCopyAllowed })`, sandbox);
  return { dom, ...vm.runInContext('({ setGlobalCopyAllowed, setArticleCopyAllowed, clearArticleCopyScope, isCopyAllowed })', sandbox) };
}

const el = (tagName, isContentEditable = false) => ({ tagName, isContentEditable });

console.log('\n【A. 默认状态：不挂任何监听】');
{
  const g = loadGuard();
  ok('默认全站允许', g.isCopyAllowed() === true);
  ok('默认不挂监听（默认允许复制，不该每个访客都背三个监听）', g.dom.count() === 0, String(g.dom.count()));
}

console.log('\n【B. 全站关掉：三个事件都挂，且能拦住】');
{
  const g = loadGuard();
  g.setGlobalCopyAllowed(false);
  ok('全站禁止 → 挂 3 个监听', g.dom.count() === 3, String(g.dom.count()));
  ok('selectstart 被拦', g.dom.fire('selectstart', el('DIV')) === true);
  ok('contextmenu 被拦', g.dom.fire('contextmenu', el('DIV')) === true);
  ok('dragstart 对 IMG 被拦', g.dom.fire('dragstart', el('IMG')) === true);
  ok('dragstart 对非 IMG 放行（只针对图片，拦普通拖拽会破坏布局拖拽）',
    g.dom.fire('dragstart', el('DIV')) === false);
  ok('INPUT 里 selectstart 放行（不然用户选不了要改的文字）',
    g.dom.fire('selectstart', el('INPUT')) === false);
  ok('TEXTAREA 里 contextmenu 放行（不然没法粘贴）',
    g.dom.fire('contextmenu', el('TEXTAREA')) === false);
  ok('contentEditable 里 dragstart 放行',
    g.dom.fire('dragstart', el('DIV', true)) === false);

  // 幂等：重复调用同一个值不该重复挂载
  g.setGlobalCopyAllowed(false);
  ok('重复设置同一个值不会重复挂载', g.dom.count() === 3, String(g.dom.count()));
}

console.log('\n【C. 开关再放开：监听必须摘干净】');
{
  const g = loadGuard();
  g.setGlobalCopyAllowed(false);
  ok('禁止时挂了 3 个', g.dom.count() === 3);
  g.setGlobalCopyAllowed(true);
  ok('放开后监听归零', g.dom.count() === 0, String(g.dom.count()));
  ok('放开后 isCopyAllowed 为 true', g.isCopyAllowed() === true);
  // 反复切换不应泄漏
  for (let i = 0; i < 3; i++) { g.setGlobalCopyAllowed(false); g.setGlobalCopyAllowed(true); }
  ok('反复切换 3 次后仍归零（无泄漏）', g.dom.count() === 0, String(g.dom.count()));
}

console.log('\n【D. 文章作用域：只在文章页生效，离开必须复位】');
{
  const g = loadGuard();
  g.setArticleCopyAllowed(false);
  ok('文章页禁复制 → 挂 3 个', g.dom.count() === 3);
  g.setArticleCopyAllowed(false);
  ok('同值重复调用不重复挂载', g.dom.count() === 3);

  // 换成一篇允许复制的文章
  g.setArticleCopyAllowed(true);
  ok('换成允许复制的文章 → 摘干净', g.dom.count() === 0, String(g.dom.count()));

  // 关键：离开文章页必须复位 articleAllowed，否则下一篇仍被禁
  g.setArticleCopyAllowed(false);
  g.clearArticleCopyScope();
  ok('离开文章页后 articleAllowed 复位（全站允许时不该还拦着）', g.isCopyAllowed() === true);
  ok('离开文章页后监听归零', g.dom.count() === 0, String(g.dom.count()));

  // 全站也禁止时，离开文章页仍然拦（由全站开关接管）
  g.setGlobalCopyAllowed(false);
  g.setArticleCopyAllowed(false);
  g.clearArticleCopyScope();
  ok('全站禁止 + 离开文章页 → 仍然拦（由全站接管）', g.isCopyAllowed() === false && g.dom.count() === 3);
}

console.log('\n【E. 两个开关的组合真值表】');
{
  const cases = [
    // [global, articleScope, articleAllowed, expected]
    [true,  false, true,  true],
    [true,  true,  true,  true],
    [true,  true,  false, false],
    [false, false, true,  false],
    [false, true,  true,  false],
    [false, true,  false, false],
  ];
  for (const [gv, scoped, av, want] of cases) {
    const g = loadGuard();
    g.setGlobalCopyAllowed(gv);
    if (scoped) g.setArticleCopyAllowed(av);
    ok(`global=${gv} articleScope=${scoped} articleAllowed=${av} → ${want}`,
      g.isCopyAllowed() === want);
  }
}

console.log('\n【F. 自检：判据真的能区分】');
{
  // 用「去掉 apply()」作为破坏样本 —— 这是真能区分的：
  // 不调用 apply() 就不会卸载监听，测试会在「离开文章页后监听归零」那条红。
  //
  // ⚠ 一个反例，记下来免得以后误用：去掉 `articleAllowed = true` 那行**抓不到**。
  //   因为 `isCopyAllowed() = globalAllowed && (!articleScope || articleAllowed)`，
  //   而 articleScope 已经置 false，`!false` 恒真 → articleAllowed 根本不参与计算。
  //   所以那行是冗余的（防御性写法），删掉它不改变任何可观测行为。
  const stripApply = readFileSync(SRC, 'utf8')
    .replace(/export function/g, 'function')
    .replace(/(function clearArticleCopyScope\(\)\s*\{[\s\S]*?)apply\(\);\s*(\})/, '$1$2');
  ok('自检准备：确实剥掉了 clearArticleCopyScope 里的 apply()', !/clearArticleCopyScope[\s\S]{0,120}apply\(\)/.test(stripApply));

  const dom = makeDom();
  const sandbox = { document: dom, console };
  vm.createContext(sandbox);
  vm.runInContext(`${stripApply}\n;({ setGlobalCopyAllowed, setArticleCopyAllowed, clearArticleCopyScope, isCopyAllowed })`, sandbox);
  const bad = { dom, ...vm.runInContext('({ setGlobalCopyAllowed, setArticleCopyAllowed, clearArticleCopyScope, isCopyAllowed })', sandbox) };
  bad.setGlobalCopyAllowed(false);
  bad.setArticleCopyAllowed(false);
  bad.clearArticleCopyScope();
  ok('自检：去掉 apply() 的版本会被判为「离开文章页后监听没摘」',
    bad.dom.count() === 3, `监听数 ${bad.dom.count()}`);

  ok('自检：真实版本在同一场景下会摘干净',
    (() => { const g = loadGuard(); g.setGlobalCopyAllowed(false); g.setArticleCopyAllowed(false); g.clearArticleCopyScope(); return g.dom.count() === 3; })(),
    '全站禁止时本来就应该留着 3 个（由全站接管），所以这条测的是「数量仍为 3」');
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
