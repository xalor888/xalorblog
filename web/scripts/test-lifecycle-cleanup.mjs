/**
 * 生命周期清理门禁：**全局注册的东西必须在卸载时注销**。
 *
 * 这类 bug 不报错、不影响首屏，只在"反复挂载"之后显形：
 * 路由钩子叠加 N 份、定时器越种越多、事件监听泄漏。
 * dev 下 HMR 最容易复现，所以长期被当成"开发环境的怪现象"。
 *
 * 检查两类：
 *   1. 组件里 `router.beforeEach / afterEach / onError / addRoute` 的返回值必须被接住并注销；
 *   2. `setTimeout / setInterval` 的句柄必须能被 clear（不能只 clear 一个从未赋值的变量）。
 *
 * 用源码文本判定：Vue 组件的注册/注销是声明式事实，正则足够稳，
 * 而真正驱动需要挂载整套路由 —— 收益不成正比。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (p) => readFileSync(resolve(SRC, p), 'utf8');

console.log('\n【路由钩子必须成对注册/注销】');
{
  const rp = read('components/ui/RouteProgress.vue');
  ok('beforeEach 的返回值被接住（offBefore）', /const offBefore = router\.beforeEach\(/.test(rp));
  ok('afterEach 的返回值被接住（offAfter）', /const offAfter = router\.afterEach\(/.test(rp));
  ok('onError 的返回值被接住（offError）', /const offError = router\.onError\(/.test(rp));
  ok('onUnmounted 里逐个调用注销函数',
    /onUnmounted\([\s\S]{0,400}offBefore\(\);[\s\S]{0,200}offAfter\(\);[\s\S]{0,200}offError\(\);/.test(rp));
  ok('注销在清定时器之前（否则注销前的最后一个回调会再种一个定时器）',
    rp.indexOf('offError();') < rp.lastIndexOf('clearTimeout(doneTimer);'));
}

console.log('\n【定时器句柄必须真的存在】');
{
  const rp = read('components/ui/RouteProgress.vue');
  // 找出所有 clearTimeout(x) 里的 x，x 必须是被赋值过的
  const cleared = [...rp.matchAll(/clearTimeout\((\w+)\)/g)].map((m) => m[1]);
  const unique = [...new Set(cleared)];
  // 「有来源」的判据必须是**真赋值**：`let timer = null` 只是声明 + 初始化为 null，
  // 之后若没有 `timer = setTimeout(...)`，clearTimeout 依然是空操作。
  const dead = unique.filter((v) => {
    const assigned = new RegExp(`\\b${v}\\s*=\\s*(setTimeout|setInterval|requestAnimationFrame)`, 'm');
    return !assigned.test(rp);
  });
  ok(`clearTimeout 的目标都有赋值来源（检查 ${unique.length} 个）`,
    dead.length === 0, dead.length ? `死变量: ${dead.join(', ')}` : '');
  ok('不再保留从未赋值的 let timer',
    !/let timer = null;\s*\n(?![\s\S]{0,80}timer = )/.test(rp));
}

console.log('\n【一次性延时也要能取消（连点 / 卸载）】');
{
  const nd = read('views/home/NoteDetail.vue');
  ok('「已复制」定时器句柄被保存', /let copyTimer = null;/.test(nd));
  ok('新点击覆盖旧定时器（否则连点两次时提示会提前消失）',
    /clearTimeout\(copyTimer\);\s*\n\s*copyTimer = setTimeout\(/.test(nd));
  ok('卸载时清掉定时器（避免往已卸载组件的 ref 写值）',
    /onUnmounted\(\(\) => clearTimeout\(copyTimer\)\)/.test(nd));
  ok('onUnmounted 已从 vue 引入', /onUnmounted/.test(nd.slice(0, nd.indexOf('export default') > 0 ? nd.indexOf('export default') : 4000)));

  const layout = read('views/site/Layout.vue');
  ok('空闲预取带 timeout（不带的话繁忙页面永远等不到空闲，预取静默失效）',
    /requestIdleCallback\(prefetch, \{ timeout: 3000 \}\)/.test(layout));
  ok('预取句柄可取消并在卸载时调用', /cancelPrefetch/.test(layout) && /onUnmounted\(\(\) => cancelPrefetch\(\)\)/.test(layout));
  ok('不支持 requestIdleCallback 时有 setTimeout 回退且同样可取消',
    /setTimeout\(prefetch, 2000\)/.test(layout) && /clearTimeout\(handle\)/.test(layout));
}

console.log('\n【图标名写错要看得见】');
{
  const xi = read('components/ui/XIcon.vue');
  ok('未注册的图标名在 DEV 下告警', /import\.meta\.env\.DEV[\s\S]{0,200}console\.warn/.test(xi));
  ok('告警里带上图标名（否则不知道哪个组件写错了）',
    /未注册的图标名[^\n]*\$\{props\.name\}/.test(xi));
  ok('告警做了去重（computed 重算不该刷屏）', /warnedMissing/.test(xi));
  ok('仍有 Activity 兜底（生产环境不能崩）', /return Activity;/.test(xi));
}

console.log('\n【死 CSS：本轮删掉的选择器不许回来】');
{
  const ae = read('views/admin/ArticleEdit.vue');
  const ap = read('views/admin/AiPanel.vue');
  const sl = read('views/site/Layout.vue');
  ok('ArticleEdit 不再有 .ed-kbd 规则', !/\.ed-kbd\s*[,{]/.test(ae));
  ok('ArticleEdit 仍保留 .ed-autosave（它还在用）', /\.ed-autosave\s*\{/.test(ae));
  ok('AiPanel 不再有 .ai-empty-tip', !/\.ai-empty-tip\s*\{/.test(ap));
  ok('site Layout 不再有 .brand-mark 字母方块规则', !/\.brand-mark\s*\{/.test(sl));
  ok('site Layout 仍保留 .brand-mark-img（logo 在用）', /\.brand-mark-img\s*\{/.test(sl));
  ok('site Layout 不再有 .footer-powered em 死规则', !/\.footer-powered em\s*\{/.test(sl));
}

console.log('\n【门禁自检：规则本身能报错】');
{
  // 用一段人造源码验证「漏注销」会被抓出来 —— 否则规则写错也永远是绿的
  const fakeMissingOff = 'const offBefore = router.beforeEach(fn);\nonUnmounted(() => { clearTimeout(t); });';
  const fakeOk = 'const offBefore = router.beforeEach(fn);\nonUnmounted(() => { offBefore(); });';
  const detects = (src) => /const offBefore = router\.beforeEach\(/.test(src)
    && !/onUnmounted\([\s\S]{0,400}offBefore\(\);/.test(src);
  ok('漏注销的人造样本会被判为不合格', detects(fakeMissingOff) === true);
  ok('正确注销的人造样本被判为合格', detects(fakeOk) === false);

  const fakeDeadTimer = 'let timer = null;\nclearTimeout(timer);';
  const hasAssign = /\btimer\s*=\s*(setTimeout|setInterval|requestAnimationFrame)/m;
  ok('从未赋值的 timer 会被判为死变量', hasAssign.test(fakeDeadTimer) === false,
    'let timer = null 只是声明，不是赋值来源');
  ok('有赋值的 timer 不会误判', hasAssign.test('let timer = null;\ntimer = setTimeout(fn, 1);') === true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
