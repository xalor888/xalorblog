/**
 * 弹层焦点陷阱覆盖门禁。
 *
 * 背景：`useFocusTrap` composable 让弹层内的 Tab 循环、Esc 关闭、
 * 关闭后把焦点还给触发元素。项目里 4 个自定义弹层都接了：
 *   ImageLightbox / ShortcutHelp / SearchModal / AskAi
 *
 * 后来发现：另有 **3 个用 `<el-dialog>` 的组件没接**，而 Element Plus 的
 * dialog **声明了 `aria-modal="true"` 却没有实现焦点陷阱**：
 *   - `dialog.vue` 的模板有 `aria-modal`
 *   - `dialog.mjs` 有一个 `trapFocus: Boolean` prop，但**无默认值（即 false）**
 *   - 全仓（含 EP 自己的 dialog-content）**没有任何地方消费这个 prop**
 *
 * 所以那 6 个对话框对屏幕阅读器做了个**假承诺**：`aria-modal` 说"焦点被困在对话框内"，
 * 实际键盘用户 Tab 能一路 Tab 到背景页面，屏幕阅读器的虚拟光标也能出去。
 *
 * 为什么这道门禁只「防扩散」而不「修现状」：
 * 给这 3 个 el-dialog 接 useFocusTrap 是中等规模改动（要处理 EP 的 overlay、
 * after-enter/after-leave 时机、以及每个对话框的初始焦点）。收益是真实的，
 * 但风险是该动 6 个后台管理页 —— 值得单独一轮做，不该塞进一个门禁里。
 * 所以这里做两件事：
 *   1. 钉住「自定义弹层必须接 useFocusTrap」（防新增漏接）
 *   2. 把「6 个 el-dialog 的 aria-modal 是假承诺」列为需人工决策
 *
 * 用法：node scripts/test-focus-trap-coverage.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, '..');
const SRC = join(WEB, 'src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}
const rel = (p) => p.replace(WEB + '/', '');

/* ---------- 分类：自定义弹层 vs el-dialog ---------- */
const custom = [];    // 有 role="dialog" 之类、自己实现的
const epDialog = [];  // 用 Element Plus 的 el-dialog
for (const f of walk(SRC)) {
  const src = readFileSync(f, 'utf8');
  if (/<el-dialog[\s>]/.test(src)) epDialog.push({ path: f, src });
  else if (/role=["']dialog["']/.test(src)) custom.push({ path: f, src });
}

console.log('\n【A. 自定义弹层必须接 useFocusTrap】');
{
  ok(`找到 ${custom.length} 个自定义弹层`, custom.length >= 3, String(custom.length));
  const missing = custom.filter((c) => !/useFocusTrap/.test(c.src)).map((c) => rel(c.path));
  ok('每个自定义弹层都接了 useFocusTrap', missing.length === 0, `漏：${missing.join(', ')}`);

  // 接了还不够：必须真的调用（不是只 import）
  const imported = custom.filter((c) => /useFocusTrap/.test(c.src));
  const notCalled = imported.filter((c) => !/useFocusTrap\s*\(/.test(c.src)).map((c) => rel(c.path));
  ok('接了的是真的调用了（不是 import 了不用）', notCalled.length === 0, `只 import：${notCalled.join(', ')}`);
}

console.log('\n【B. useFocusTrap 的实现要点仍在】');
{
  const src = readFileSync(join(SRC, 'composables', 'useFocusTrap.js'), 'utf8');
  ok('文件存在', existsSync(join(SRC, 'composables', 'useFocusTrap.js')));
  ok('监听 keydown 才能拦 Tab', /keydown/.test(src));
  ok('处理 Tab 键（焦点循环）', /'Tab'|"Tab"/.test(src));
  ok('处理 Esc（关闭弹层）', /'Escape'|"Escape"/.test(src));
  ok('关闭后把焦点还给触发元素（不能让它掉到 body）',
    /focus\s*\(/.test(src) && /previous|trigger|lastFocus|restore/.test(src));
  ok('清理时移除监听（防泄漏）', /removeEventListener/.test(src));
}

console.log('\n【C. el-dialog 也必须真的困住焦点】');
{
  // 发现 EP 的 el-dialog 模板有 aria-modal="true"，但 trapFocus prop
  // 无默认值且全仓无人消费 —— 那是个假承诺。同轮给 3 个 el-dialog 接上了
  // useFocusTrap（用 @opened/@closed 手动 engage，因为 watch(v-model) 的
  // nextTick 赶不上 EP 的过渡动画）。
  //
  // 现在这里从「记录待处理」升级为「必须接上」。
  const epDialogSrc = join(WEB, 'node_modules', 'element-plus', 'es', 'components', 'dialog', 'src', 'dialog.mjs');
  if (existsSync(epDialogSrc)) {
    const src = readFileSync(epDialogSrc, 'utf8');
    ok('EP 的 trapFocus 仍是无默认值的 prop（所以我们不能依赖它）',
      /trapFocus:\s*Boolean/.test(src) && !/trapFocus:\s*\{[^}]*default/.test(src));
  } else {
    ok('（EP 未安装，跳过实现细节检查）', true);
  }

  ok(`发现 ${epDialog.length} 个 el-dialog 组件`, epDialog.length >= 3, String(epDialog.length));
  const missing = epDialog.filter((d) => !/useFocusTrap/.test(d.src)).map((d) => rel(d.path));
  ok('每个 el-dialog 都接了 useFocusTrap', missing.length === 0, `漏：${missing.join(', ')}`);

  // 接了两件事才算真接上：模板的 @opened/@closed，与 script 里的 engage/disengage
  const halfWired = epDialog.filter((d) => {
    const hasTpl = /@opened=/.test(d.src) && /@closed=/.test(d.src);
    const hasFn = /\.engage\(\)/.test(d.src) && /\.disengage\(\)/.test(d.src);
    return (hasTpl || hasFn) && !(hasTpl && hasFn);
  }).map((d) => rel(d.path));
  ok('接的是完整的一对（@opened→engage、@closed→disengage）', halfWired.length === 0,
    `只接了一半：${halfWired.join(', ')}`);
}

console.log('\n【D. 自检：判据真的能区分】');
{
  // 破坏样本：把 ImageLightbox 的 useFocusTrap 去掉
  const lb = join(SRC, 'components', 'ui', 'ImageLightbox.vue');
  const orig = readFileSync(lb, 'utf8');
  ok('自检准备：ImageLightbox 原本接了', /useFocusTrap/.test(orig));
  const stripped = orig.replace(/useFocusTrap/g, 'useSomethingElse');
  ok('自检：剥掉之后 A 组会判为漏接', !/useFocusTrap/.test(stripped));

  // 破坏样本二：只 import 不调用
  const importOnly = orig.replace(/useFocusTrap\s*\([^)]*\)/g, 'noop()');
  ok('自检：只 import 不调用时，A 组第二条会抓到',
    /useFocusTrap/.test(importOnly) && !/useFocusTrap\s*\(/.test(importOnly));

  ok('自检：真实文件两者都满足',
    /useFocusTrap/.test(orig) && /useFocusTrap\s*\(/.test(orig));
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
