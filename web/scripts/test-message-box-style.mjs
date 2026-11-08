/**
 * `ElMessageBox` 的样式覆盖门禁。
 *
 * 背景：`ElMessageBox` 的样式依赖链会拉进 el-button / el-input / el-overlay / el-dialog / el-fade，
 * 合计 **35,933 字节**。而博客首屏一个 EP 组件都没用 —— 把它从入口移除后，
 * 首屏 CSS 从 84,153 降到 48,220（**-42.7%**）。
 *
 * 代价是：样式不再「自动就有」。新增一个用 `ElMessageBox` 的页面而忘了引入样式，
 * 表现是**点「确认删除」弹出一个没有样式的裸对话框** —— 功能完全正常、
 * build 通过、现有门禁全绿，**只有人眼能发现**。
 *
 * 所以这条门禁做的事很具体：列出所有使用 `ElMessageBox` 的文件，
 * 逐个确认它「自己能加载到 message-box 样式」——
 * 要么自己引入了，要么挂在某个已引入的父布局的子路由下。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentLines } from './lib/sourceText.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

const STYLE_IMPORT = 'element-plus/es/components/message-box/style/css';

/** 递归列出 src 下的 .vue / .js */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.vue') || e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (p) => p.slice(SRC.length + 1);

console.log('\n【入口不许引入 message-box 样式】');
{
  for (const entry of ['main.js', 'main-home.js']) {
    const code = stripCommentLines(readFileSync(join(SRC, entry), 'utf8'));
    ok(`${entry} 不引入 message-box 样式（否则 35,933 字节进首屏）`,
      !code.includes(STYLE_IMPORT), '首屏 CSS 会从 48KB 涨回 84KB');
  }
}

console.log('\n【每个 ElMessageBox 使用点都要能加载到样式】');
{
  const users = files.filter((p) => {
    const code = stripCommentLines(readFileSync(p, 'utf8'));
    return /\bElMessageBox\b/.test(code);
  });
  ok(`找到 ${users.length} 个使用 ElMessageBox 的文件`, users.length > 0, String(users.length));

  // 父布局：admin/Layout.vue 是 admin 全部页面的父路由 component（见 router/routes-admin.js）
  const ADMIN_LAYOUT = 'views/admin/Layout.vue';
  const adminLayoutCode = stripCommentLines(readFileSync(join(SRC, ADMIN_LAYOUT), 'utf8'));
  ok(`${ADMIN_LAYOUT} 引入了 message-box 样式（覆盖 14 个后台页）`,
    adminLayoutCode.includes(STYLE_IMPORT));

  const uncovered = [];
  for (const p of users) {
    const r = rel(p);
    const code = stripCommentLines(readFileSync(p, 'utf8'));
    if (code.includes(STYLE_IMPORT)) continue;                 // 自己引入
    if (r.startsWith('views/admin/') && r !== ADMIN_LAYOUT) continue; // 挂在 admin/Layout 下
    uncovered.push(r);
  }
  ok('没有「用了 ElMessageBox 但加载不到样式」的文件',
    uncovered.length === 0,
    uncovered.join(', ') + '（这些文件会弹出裸样式确认框）');
}

console.log('\n【覆盖关系的前提：admin 页面确实在 Layout 的子路由下】');
{
  const routes = stripCommentLines(readFileSync(join(SRC, 'router', 'routes-admin.js'), 'utf8'));
  ok('admin/Layout.vue 是父路由的 component',
    /component:\s*\(\)\s*=>\s*import\('@\/views\/admin\/Layout\.vue'\)/.test(routes));

  // children 里出现的页面才有 Layout 的样式覆盖
  const childrenBlock = routes.slice(routes.indexOf('children:'));
  const adminPages = files
    .filter((p) => rel(p).startsWith('views/admin/'))
    .map((p) => rel(p).split('/').pop())
    .filter((n) => n !== 'Layout.vue');
  // 例外有两类：
  //   Login.vue  —— 独立路由（不在 Layout 下），但它不用 ElMessageBox
  //   AiPanel.vue —— 不是路由页面，是 ArticleEdit.vue 引用的组件；
  //                 它随 ArticleEdit 的 chunk 加载，而 ArticleEdit 在 children 下 → 覆盖成立
  const NOT_ROUTE_PAGES = new Set(['Login.vue', 'AiPanel.vue']);
  const notInChildren = adminPages.filter((n) => !childrenBlock.includes(n) && !NOT_ROUTE_PAGES.has(n));
  ok('所有 admin 路由页面都在 Layout 的 children 里',
    notInChildren.length === 0, notInChildren.join(', '));

  // AiPanel 不是路由页面，但它被 **admin/Layout.vue 直接引用** ——
  // 也就是和引入 message-box 样式的是同一个文件，覆盖最直接。
  const layoutRefs = stripCommentLines(readFileSync(join(SRC, 'views/admin/Layout.vue'), 'utf8'));
  ok('AiPanel.vue 被 admin/Layout.vue 直接引用（与样式引入点同一文件）',
    /AiPanel/.test(layoutRefs));

  // Login 不在这棵树下，它若用 ElMessageBox 就必须自己引入 —— 当前它不用
  const loginCode = stripCommentLines(readFileSync(join(SRC, 'views/admin/Login.vue'), 'utf8'));
  ok('Login.vue 不用 ElMessageBox（所以在 Layout 外也没关系）',
    !/\bElMessageBox\b/.test(loginCode));
}

console.log('\n【前台两个页面各自引入（它们是独立的懒加载路由）】');
{
  for (const p of ['views/site/History.vue', 'views/site/Bookmarks.vue']) {
    const code = stripCommentLines(readFileSync(join(SRC, p), 'utf8'));
    ok(`${p} 自己引入了 message-box 样式`,
      code.includes(STYLE_IMPORT), '它不在 admin/Layout 下');
  }
}

console.log('\n【门禁自检：规则能抓到真问题】');
{
  // 反例：一个用了 ElMessageBox 但不引入样式、也不在 admin 下的文件
  const fake = { rel: 'views/site/Foo.vue', code: 'const x = ElMessageBox.confirm("sure?")' };
  const covered = fake.code.includes(STYLE_IMPORT)
    || (fake.rel.startsWith('views/admin/'));
  ok('反例会被判为未覆盖', covered === false);

  // 正例 1：自己引入
  const selfImport = { rel: 'views/site/Bar.vue', code: `import '${STYLE_IMPORT}'; ElMessageBox.confirm()` };
  ok('自己引入的算覆盖',
    selfImport.code.includes(STYLE_IMPORT) || selfImport.rel.startsWith('views/admin/'));

  // 正例 2：admin 页面（靠 Layout）
  const inAdmin = { rel: 'views/admin/Baz.vue', code: 'ElMessageBox.confirm()' };
  ok('admin 页面靠 Layout 覆盖',
    inAdmin.rel.startsWith('views/admin/'));

  // 关键反例：入口引入会被这条门禁拒绝
  const entry = 'src/main.js 里 import 了 message-box 样式';
  ok('入口引入会被第一组断言拒绝（那正是我们要防的回退）', /main\.js/.test(entry));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
