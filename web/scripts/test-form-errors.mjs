/**
 * 表单字段级错误的关联门禁。
 *
 * 规则：一个组件如果维护了 `fieldErrors`（字段级错误状态），那么：
 *   1. 出错的那个 input/textarea 必须绑 `aria-invalid`（读屏靠它播报「无效」）；
 *   2. 必须有 `aria-describedby` 指向错误元素的 id；
 *   3. 错误元素必须有 `role="alert"`（提交后立刻播报，不需要用户去翻）。
 *
 * 为什么值得一道门禁：只飘一条全局 toast 的表单，**视觉用户能看出哪一栏空着，
 * 读屏用户不能** —— toast 不移动焦点、不在字段上留痕迹，提交后听到的是
 * 「请输入用户名，按钮」，完全不知道该改哪个框。
 *
 * 实测发现 `views/admin/Login.vue` 就是这样（三个空值检查全是 `ElMessage.warning`）。
 * `Messages.vue` / `CommentSection.vue` 早已是正确做法，只是没被断言保护。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const read = (p) => readFileSync(p, 'utf8');
const hasFieldErrors = (src) => /fieldErrors\s*=\s*ref\(/.test(src) || /fieldErrors\.value/.test(src);

console.log('\n【维护 fieldErrors 的组件必须把三类属性都绑上】');
{
  const users = files.filter((p) => hasFieldErrors(read(p)));
  ok(`找到 ${users.length} 个维护 fieldErrors 的组件`, users.length > 0, String(users.length));

  for (const p of users) {
    const src = read(p);
    const rel = relative(SRC, p);
    ok(`${rel}: 有 aria-invalid`, /:aria-invalid=/.test(src));
    ok(`${rel}: 有 aria-describedby`, /:aria-describedby=/.test(src));
    ok(`${rel}: 错误元素有 role="alert"`, /class="field-error"[^>]*role="alert"|role="alert"[^>]*class="field-error"/.test(src));
  }
}

console.log('\n【id 与 aria-describedby 必须真的对得上】');
{
  for (const p of files.filter((x) => hasFieldErrors(read(x)))) {
    const src = read(p);
    const rel = relative(SRC, p);
    // 收集 aria-describedby 表达式里出现的字符串字面量（错误元素 id）与 id="..." 的定义
    const refIds = new Set([...src.matchAll(/:aria-describedby="[^"]*?'([\w-]+)'/g)].map((m) => m[1]));
    const defIds = new Set([...src.matchAll(/id="([\w-]+)"[^>]*class="field-error"/g)].map((m) => m[1])
      .concat([...src.matchAll(/class="field-error"[^>]*id="([\w-]+)"/g)].map((m) => m[1])));
    const missing = [...refIds].filter((id) => !defIds.has(id));
    ok(`${rel}: aria-describedby 指向的 id 都有对应元素`,
      missing.length === 0, missing.join(', '));
    ok(`${rel}: 至少关联了一个字段`, refIds.size > 0, String(refIds.size));
  }
}

console.log('\n【Login.vue 回归：不再只用全局 toast】');
{
  const login = read(join(SRC, 'views', 'admin', 'Login.vue'));
  ok('Login 维护了 fieldErrors', hasFieldErrors(login));
  ok('Login 的三个字段都绑了 aria-invalid',
    (login.match(/:aria-invalid=/g) || []).length === 3,
    String((login.match(/:aria-invalid=/g) || []).length));
  ok('Login 有三个错误元素', (login.match(/class="field-error"/g) || []).length === 3);
  ok('Login 提交时聚焦第一个出错字段',
    /firstBad\.focus/.test(login) || /\.focus\?\.\(\)/.test(login));
  ok('Login 不再用 ElMessage.warning 做空值校验（那是不移动焦点的 toast）',
    !/ElMessage\.warning\('请输入用户名'\)/.test(login));
}

console.log('\n【视觉一致：aria-invalid 必须自带红框样式】');
{
  const css = readFileSync(join(SRC, 'styles', 'main.css'), 'utf8');
  ok('main.css 有基于 aria-invalid 属性选择器的样式',
    /input\[aria-invalid='true'\]/.test(css),
    '只认 .is-invalid 会让新表单「语义标了无效、视觉没红框」');
  ok('textarea / select 也覆盖', /textarea\[aria-invalid='true'\]/.test(css) && /select\[aria-invalid='true'\]/.test(css));
  ok('深色主题同样覆盖', /\[data-theme='dark'\] input\[aria-invalid='true'\]/.test(css));
  ok('仍然保留原有的 .is-invalid 写法（不破坏既有组件）',
    /\.form-input\.is-invalid/.test(css));
}

console.log('\n【门禁自检：规则能抓到真问题】');
{
  // 反例：有 fieldErrors 但没 bind 任何 aria
  const bad = 'const fieldErrors = ref({}); function f(){ fieldErrors.value.x = 1; }';
  ok('自检：有 fieldErrors 但无 aria-invalid 会被识别', hasFieldErrors(bad) && !/:aria-invalid=/.test(bad));

  // 正例
  const good = `const fieldErrors = ref({});
    <input :aria-invalid="fieldErrors.a ? 'true' : undefined" :aria-describedby="fieldErrors.a ? 'e-a' : undefined" />
    <p id="e-a" class="field-error" role="alert">x</p>`;
  ok('自检：完整绑定通过',
    hasFieldErrors(good) && /:aria-invalid=/.test(good) && /:aria-describedby=/.test(good));

  // 反例：id 对不上
  const mismatch = `<input :aria-describedby="fieldErrors.a ? 'e-wrong' : undefined" /><p id="e-a" class="field-error" role="alert"></p>`;
  const refIds = new Set([...mismatch.matchAll(/:aria-describedby="[^"]*?'([\w-]+)'/g)].map((m) => m[1]));
  const defIds = new Set([...mismatch.matchAll(/id="([\w-]+)"[^>]*class="field-error"/g)].map((m) => m[1]));
  ok('自检：id 对不上会被抓出来', [...refIds].some((id) => !defIds.has(id)));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
