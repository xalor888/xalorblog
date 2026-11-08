/**
 * useMedia 行为回归（node:vm + 假 matchMedia，无浏览器）。
 *
 * 背景：管理后台的**统一断点**。`Layout` 与各管理视图共用同一个监听，
 * 避免每个组件各建一份 matchMedia。
 *
 * ⚠ 这是「同一份信息写两遍」的又一例：断点值既在
 * `composables/useMedia.js` 的 `BREAKPOINT_ADMIN` 里，也在各 admin 视图的
 * `@media (max-width: 820px)` 里。两边不一致的后果是**行为分裂**：
 *   - JS 认为某宽度是窄屏 → 裁表格列、操作列解固定、表单纵排
 *   - CSS 认为不是 → 那些窄屏样式不生效
 * 用户看到的是「界面一半像窄屏一半像宽屏」，而没有任何报错。
 *
 * 所以这里除了测模块行为，最重要的一条是：
 *   **`BREAKPOINT_ADMIN` 必须与所有 admin 视图的 CSS 媒体查询一致。**
 *
 * 用法：node scripts/test-use-media.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, '..');
const SRC = join(WEB, 'src', 'composables', 'useMedia.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/** 造一个可触发的假 matchMedia */
function makeMatchMedia(initialMatches) {
  const listeners = [];
  const mq = {
    matches: initialMatches,
    media: '',
    addEventListener(type, cb) { if (type === 'change') listeners.push(cb); },
    removeEventListener() {},
    /** 模拟视口变化 */
    set(matches) { this.matches = matches; for (const l of listeners) l({ matches }); },
  };
  return mq;
}

/** 在 vm 里加载模块（每个用例一个新沙箱，因为它是模块级单例） */
function load({ hasWindow = true, mq = null } = {}) {
  // import 要剥掉（vm 里不是 module），用注入的 ref 代替 vue 的
  const src = readFileSync(SRC, 'utf8')
    .replace(/import \{ ref \} from 'vue';/, '')
    .replace(/export /g, '');
  const sandbox = {
    window: hasWindow ? { matchMedia: mq ? () => mq : undefined } : undefined,
    ref: (v) => ({ value: v }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;({ BREAKPOINT_ADMIN, useIsMobile })`, sandbox);
  return {
    ...vm.runInContext('({ BREAKPOINT_ADMIN, useIsMobile })', sandbox),
    sandbox,
  };
}

/** 收集全站 CSS 里用到的 max-width 断点（A 组与 F 组都要用） */
function collectBreakpoints() {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(vue|css)$/.test(e.name)) files.push(p);
    }
  };
  walk(join(WEB, 'src'));
  const map = new Map();   // px → [files]
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/max-width:\s*(\d+)px/g)) {
      const px = Number(m[1]);
      if (!map.has(px)) map.set(px, []);
      map.get(px).push(f.replace(WEB + '/', ''));
    }
  }
  return map;
}
const breakpoints = collectBreakpoints();

console.log('\n【A. 断点常量与 CSS 媒体查询一致（这次的重点）】');
{
  const { BREAKPOINT_ADMIN } = load({ hasWindow: false });
  ok('导出了 BREAKPOINT_ADMIN', BREAKPOINT_ADMIN === 820, String(BREAKPOINT_ADMIN));

  ok('820px 这个断点在 CSS 里真的存在', breakpoints.has(820),
    [...breakpoints.keys()].sort((a, b) => a - b).join(', '));

  // admin 相关文件必须用同一个断点
  const adminFiles = breakpoints.get(820) || [];
  const adminScoped = adminFiles.filter((f) => /admin|main\.css/.test(f));
  ok(`至少 4 处 admin 样式用 820px（当前 ${adminScoped.length} 处）`,
    adminScoped.length >= 4, adminScoped.join(', '));

  // main.css 的注释必须说明它与 useMedia 一致（这是给人看的锚点）
  const mainCss = readFileSync(join(WEB, 'src', 'styles', 'main.css'), 'utf8');
  ok('main.css 的窄屏工具区注明「断点与 composables/useMedia.js 一致」',
    /管理后台窄屏工具[\s\S]{0,80}useMedia\.js/.test(mainCss));

  // 用了 useIsMobile 的 admin 视图，必须有一条配套的 @media 820。
  //
  // ⚠ 第一版我把判据写成「admin 视图里不许有 700–900 的其它断点」——
  // 结果抓到 8 处（720/700/780/860），全是**局部布局断点**（表单内部两列、
  // 设置页分组），与 `useIsMobile` 的全局窄屏判断无关。
  // 那条断言把两件不同的事混为一谈，是假红。
  const adminDir = join(WEB, 'src', 'views', 'admin');
  const users = [];
  const walkAdmin = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkAdmin(p);
      else if (e.name.endsWith('.vue')) {
        const src = readFileSync(p, 'utf8');
        if (/useIsMobile/.test(src)) users.push({ name: e.name, src });
      }
    }
  };
  walkAdmin(adminDir);
  ok(`admin 里有视图使用 useIsMobile（当前 ${users.length} 个）`, users.length >= 2,
    users.map((u) => u.name).join(', '));
  // 不要求「每个视图都有自己的 @media 820」—— 实测 7 个管理视图没有，
  // 因为表格类的窄屏样式由 main.css 的「管理后台窄屏工具」区块统一提供。
  // 第一版那么写是假红。
  //
  // 真正该钉的是：**用了 useIsMobile 的视图必须真的消费这个状态**，
  // 而不是 import 了却不用（那说明窄屏分支漏了，或断点改了没跟着改）。
  const notConsumed = users.filter((u) => {
    // import 那行之外，至少要再出现一次 isMobile / useIsMobile
    const body = u.src.replace(/import\s*\{[^}]*useIsMobile[^}]*\}\s*from\s*'@\/composables\/useMedia';?/g, '');
    return !/isMobile/.test(body);
  }).map((u) => u.name);
  ok('用了 useIsMobile 的视图都真的消费了这个状态（不是 import 了不用）',
    notConsumed.length === 0, `只 import 没用：${notConsumed.join(', ')}`);
}

console.log('\n【B. 初始值来自 matchMedia】');
{
  const mq = makeMatchMedia(true);
  const { useIsMobile } = load({ mq });
  ok('窄屏 → isMobile 为 true', useIsMobile().value === true);

  const mq2 = makeMatchMedia(false);
  const { useIsMobile: u2 } = load({ mq: mq2 });
  ok('宽屏 → isMobile 为 false', u2().value === false);
}

console.log('\n【C. 视口变化时更新】');
{
  const mq = makeMatchMedia(false);
  const { useIsMobile } = load({ mq });
  ok('初始是宽屏', useIsMobile().value === false);
  mq.set(true);
  ok('变窄后 isMobile 变 true', useIsMobile().value === true);
  mq.set(false);
  ok('变宽后 isMobile 变 false', useIsMobile().value === false);
}

console.log('\n【D. 单例语义：两次调用拿到同一个 ref】');
{
  const mq = makeMatchMedia(false);
  const { useIsMobile } = load({ mq });
  const a = useIsMobile();
  const b = useIsMobile();
  ok('两次调用是同一个对象（不是两个副本）', a === b);
  mq.set(true);
  ok('改一处两处都变（证明是同一个响应式状态）', a.value === true && b.value === true);
}

console.log('\n【E. 不支持 matchMedia 时降级为宽屏】');
{
  const { useIsMobile } = load({ hasWindow: false });
  ok('无 window → 不抛', typeof useIsMobile().value === 'boolean');
  ok('无 window → 视为宽屏（后台在无 JS 环境下不该默认窄屏）', useIsMobile().value === false);

  const { useIsMobile: u2 } = load({ hasWindow: true, mq: null });   // window 在但没 matchMedia
  ok('有 window 但无 matchMedia → 也不抛', u2().value === false);
}

console.log('\n【F. 自检：判据真的能区分】');
{
  // 破坏样本：断点常量改成 768（而 CSS 还是 820）
  const broken = readFileSync(SRC, 'utf8')
    .replace("import { ref } from 'vue';", '')
    .replace(/export /g, '')
    // 必须替换赋值语句而不是裸 '820' —— 源码里第一个 820 在**注释**里
    // （`/** 管理后台统一断点：≤820px … */`），裸替换只改注释、常量没动，
    // 于是自检永远不成立。
    .replace('BREAKPOINT_ADMIN = 820', 'BREAKPOINT_ADMIN = 768');
  const sb = { window: undefined, ref: (v) => ({ value: v }), console };
  vm.createContext(sb);
  vm.runInContext(`${broken}\n;({ BREAKPOINT_ADMIN })`, sb);
  const bad = vm.runInContext('({ BREAKPOINT_ADMIN })', sb);
  const cssHas = (px) => [...breakpoints.keys()].includes(px);
  ok('自检准备：常量确实被改成 768', bad.BREAKPOINT_ADMIN === 768, String(bad.BREAKPOINT_ADMIN));
  ok('自检：改成 768 后 CSS 里没有这个断点（会被 A 组抓到）',
    bad.BREAKPOINT_ADMIN !== 820 && !cssHas(bad.BREAKPOINT_ADMIN),
    `常量 ${bad.BREAKPOINT_ADMIN} / CSS 有 ${cssHas(bad.BREAKPOINT_ADMIN)}`);
  ok('自检：真实值 820 在 CSS 里存在', load({ hasWindow: false }).BREAKPOINT_ADMIN === 820 && cssHas(820));

  // 破坏样本二：不复用单例（每次调用新建 ref）
  const OLD_BODY = 'function useIsMobile() {\n  return isMobile;\n}';
  const broken2 = readFileSync(SRC, 'utf8')
    .replace("import { ref } from 'vue';", '')
    .replace(/export /g, '')
    .replace(OLD_BODY, 'function useIsMobile() {\n  return ref(mq ? mq.matches : false);\n}');
  ok('自检准备：确实改成了每次新建', broken2.includes('return ref(mq ? mq.matches : false)'));
  const mq = makeMatchMedia(false);
  const sb2 = { window: { matchMedia: () => mq }, ref: (v) => ({ value: v }), console };
  vm.createContext(sb2);
  vm.runInContext(`${broken2}\n;({ useIsMobile })`, sb2);
  const bad2 = vm.runInContext('({ useIsMobile })', sb2);
  ok('自检：不复用单例时两次调用是不同对象（会被 D 组抓到）',
    bad2.useIsMobile() !== bad2.useIsMobile());
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
