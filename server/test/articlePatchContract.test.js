/**
 * 「清空」语义契约回归（PUT /articles/:id 的 published_at / slug / status）
 *
 * 缺陷：前端清空发布时间、清空 slug 后，请求里这两个字段变成 `undefined`，
 * 被 JSON 序列化直接丢掉；后端又写成「有值才改」（`if (slug)`、
 * `typeof published_at === 'string' && published_at`）——于是「清空」变成了
 * 「什么都不做」：HTTP 200、写库"成功"、值原地不动。用户看到的是
 * 「我明明清空了，保存后它又变回来了」。
 *
 * 本文件的测试策略分两层：
 *
 * 1) **行为级（主）**：`resolveArticlePatch` 是本次从路由里抽出来的纯函数，
 *    直接真实调用，钉住每条语义（null/''/缺省/合法/非法类型/去重/status 交互）。
 *
 * 2) **源码断言（辅）**：路由本身（取行 → 调纯函数 → 事务落库 → 回传结果值）
 *    驱动一次需要真实 MySQL（articles / article_tags / tags / categories）
 *    与 JWT + 指纹 + 服务端会话三重认证 —— 19 个离线套件都不连库、不起服务，
 *    集成测试要把整个后台栈搬进单测。所以路由那一层用源码契约锁住：
 *    「路由必须调用这个纯函数」「必须回传 slug/published_at」「旧的
 *    `if (slug)` / `published_at && ...` 写法不许回来」。这是防回退的钉子，
 *    不是行为模拟 —— 行为已经由第 1 层真实覆盖。
 *
 * 用法：node test/articlePatchContract.test.js
 */
const { stripCommentLines } = require('./helpers/sourceText');
const fs = require('fs');
const path = require('path');
const adminRouter = require('../src/routes/admin');

const { resolveArticlePatch } = adminRouter;

let passed = 0;
let failed = 0;
const failures = [];
function assert(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` | ${extra}` : ''));
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// 静默收集日志：既验证「非法值确实记了 debug 日志」，又不让测试输出被日志淹没
function makeLogger() {
  const lines = [];
  const log = (msg) => lines.push(String(msg));
  return { log, lines };
}

// 一篇「已发布、有历史 slug、有发布时间」的既有文章
const ROW = {
  id: 7,
  title: 'Hello World',
  slug: 'hello-world',
  status: 'published',
  published_at: '2024-05-01 08:30:00',
};
const NOW = '2026-11-01 20:00:00';

/** 调用纯函数的小包装：默认给日志收集器与固定 now，避免用例里重复样板 */
function resolve(body, current = ROW, opts = {}) {
  const logger = makeLogger();
  const out = resolveArticlePatch(body, current, {
    existingSlugs: [],
    now: NOW,
    log: logger.log,
    ...opts,
  });
  return { ...out, logs: logger.lines };
}

console.log('=== 契约 A：published_at 传 null / 空串 → 置 NULL（这是本次修的 bug 之一）===');
{
  const a = resolve({ published_at: null });
  assert('published_at: null → patch.published_at === null', a.patch.published_at === null,
    '旧实现直接跳过，旧时间纹丝不动');
  assert('published_at: null → changed.published_at 标记为 cleared', a.changed.published_at === 'cleared');
  assert('published_at: null 不产生 error', a.error === null);

  const b = resolve({ published_at: '' });
  assert("published_at: '' → patch.published_at === null", b.patch.published_at === null);

  const c = resolve({ published_at: '   ' });
  assert('published_at: 纯空白 → 也按清空处理（前端清空后可能留空格）',
    c.patch.published_at === null);

  const d = resolve({ published_at: '2026-01-02 03:04:05' });
  assert('published_at: 合法日期字符串 → 原样写入', d.patch.published_at === '2026-01-02 03:04:05');
  assert('published_at: 合法日期 → changed 标记 set', d.changed.published_at === 'set');
}

console.log('\n=== 契约 B：published_at 字段不出现 → 保持原值（老语义不能破坏）===');
{
  const a = resolve({ title: '只改标题' });
  assert('缺键 → patch 里没有 published_at 这个 key',
    !Object.prototype.hasOwnProperty.call(a.patch, 'published_at'),
    '有 key 且值为 undefined 也会被 knex 当成「要写 undefined」');
  assert('缺键 → changed.published_at 为空', a.changed.published_at === undefined);

  const b = resolve({ published_at: undefined });
  assert('显式 undefined 等同于缺键（JSON 里本来也传不过来）',
    !Object.prototype.hasOwnProperty.call(b.patch, 'published_at'));
}

console.log('\n=== 契约 C：非法 published_at —— 非字符串忽略、非法日期串显式 400 ===');
{
  const logger = makeLogger();
  let threw = false;
  let out;
  try {
    out = resolveArticlePatch({ published_at: 20260101 }, ROW, { now: NOW, log: logger.log });
  } catch (e) {
    threw = true;
  }
  assert('数字类型不抛错（旧实现靠 typeof 挡住，不能变成 500）', threw === false);
  assert('数字类型被忽略：patch 里没有 published_at',
    out && !Object.prototype.hasOwnProperty.call(out.patch, 'published_at'));
  assert('数字类型被忽略时记了 debug 日志（否则永远查不出「为什么我的值没存上」）',
    logger.lines.some((l) => /published_at/.test(l) && /类型/.test(l)),
    `实际日志 ${JSON.stringify(logger.lines)}`);

  const objLogger = makeLogger();
  const objOut = resolveArticlePatch({ published_at: { y: 2026 } }, ROW, { now: NOW, log: objLogger.log });
  assert('对象类型同样只忽略、不抛错',
    objOut.error === null && !Object.prototype.hasOwnProperty.call(objOut.patch, 'published_at'));

  const badLogger = makeLogger();
  const bad = resolveArticlePatch({ published_at: '2024-13-45 99:99:99' }, ROW, { now: NOW, log: badLogger.log });
  assert('非法日期字符串 → 返回「发布时间不是有效日期」而不是静默忽略',
    bad.error === '发布时间不是有效日期',
    '这条校验前端依赖它给用户纠错，改成静默会让日期"神秘消失"');
  assert('非法日期字符串 → patch 里不写入任何 published_at',
    !Object.prototype.hasOwnProperty.call(bad.patch, 'published_at'));
  assert('非法日期字符串 → 记了 debug 日志', badLogger.lines.length > 0);
}

console.log("\n=== 契约 D：slug 传 '' / null / 纯空白 → 按标题重新生成（本次修的 bug 之二）===");
{
  const a = resolve({ slug: '' });
  assert("slug: '' → 用当前标题重新生成（hello-world）", a.patch.slug === 'hello-world',
    `实际 ${a.patch.slug}`);
  assert("slug: '' → changed.slug 回传新值", a.changed.slug === 'hello-world');
  assert("slug: '' 不产生 error", a.error === null);

  const b = resolve({ slug: null });
  assert('slug: null 视同清空（同样重生成）', b.patch.slug === 'hello-world');

  const c = resolve({ slug: '   ' });
  assert('slug: 纯空白视同清空（同样重生成）', c.patch.slug === 'hello-world');

  const d = resolve({ slug: '' }, { ...ROW, title: '重构之后：新的标题' });
  assert('重生成取的是**当前标题**（中文保留、符号剔除）', d.patch.slug === '重构之后新的标题',
    `实际 ${d.patch.slug}`);

  const e = resolve({ slug: '', title: 'Brand New Title' });
  assert('同一次请求里标题也被改了 → 用新标题重生成',
    e.patch.slug === 'brand-new-title', `实际 ${e.patch.slug}`);
}

console.log('\n=== 契约 E：slug 去重仍然生效（复用现有 slugify 的去重逻辑）===');
{
  const a = resolve({ slug: '' }, ROW, { existingSlugs: ['hello-world', 'other'] });
  assert('重生成撞上别人的 slug → 追加 -1',
    a.patch.slug === 'hello-world-1', `实际 ${a.patch.slug}`);

  const b = resolve({ slug: 'Hello World!!' }, ROW, { existingSlugs: ['hello-world'] });
  assert('手填 slug 仍走 slugify 归一化 + 去重（老语义不变）',
    b.patch.slug === 'hello-world-1', `实际 ${b.patch.slug}`);

  // 路由传进来的 existingSlugs 已排除本文自身：自己的 slug 不该触发 -1
  const c = resolve({ slug: 'hello-world' }, ROW, { existingSlugs: ['other'] });
  assert('传自己的 slug 不会被去重成 -1（路由用 whereNot(id) 排除自身）',
    c.patch.slug === 'hello-world');
}

console.log('\n=== 契约 F：slug 字段不出现 → 保持原值；非法类型 → 忽略 ===');
{
  const a = resolve({ title: 'x' });
  assert('缺键 → patch 里没有 slug', !Object.prototype.hasOwnProperty.call(a.patch, 'slug'));

  const logger = makeLogger();
  const b = resolveArticlePatch({ slug: 12345 }, ROW, { now: NOW, log: logger.log });
  assert('数字 slug 被忽略而不是写进库', !Object.prototype.hasOwnProperty.call(b.patch, 'slug'));
  assert('数字 slug 记了 debug 日志',
    logger.lines.some((l) => /slug/.test(l) && /类型/.test(l)));
  assert('数字 slug 不产生 error（旧实现是静默跳过，不能变成 400）', b.error === null);
}

console.log('\n=== 契约 G：status 交互（首次发布补时间、显式清空要覆盖它）===');
{
  const draft = { id: 8, title: 'Draft', slug: 'draft', status: 'draft', published_at: null };

  const a = resolve({ status: 'published' }, draft);
  assert('草稿首次发布且无发布时间 → 补当前时间',
    a.patch.published_at === NOW && a.patch.status === 'published');

  const b = resolve({ status: 'published', published_at: null }, draft);
  assert('显式清空要压掉「首次发布补当前时间」的结果（顺序不能反）',
    b.patch.published_at === null, `实际 ${b.patch.published_at}`);

  const c = resolve({ status: 'published', published_at: '2020-02-02 02:02:02' }, draft);
  assert('显式指定日期优先于自动补的当前时间',
    c.patch.published_at === '2020-02-02 02:02:02');

  const d = resolve({ status: 'published' }, ROW);
  assert('已发布文章重复保存 status=published → 不写 status、也不动发布时间',
    !Object.prototype.hasOwnProperty.call(d.patch, 'status')
    && !Object.prototype.hasOwnProperty.call(d.patch, 'published_at'));

  const e = resolve({ status: 'archived' });
  assert('非法状态 → error（既有 400 语义保留）', e.error === '非法状态');
}

console.log('\n=== 契约 H：空请求体不产生任何 patch（不能误清空）===');
{
  const a = resolve({});
  assert('空 body → patch 无 slug / 无 published_at / 无 status',
    Object.keys(a.patch).length === 0, `实际 ${JSON.stringify(a.patch)}`);
  assert('空 body → changed 为空、error 为 null',
    Object.keys(a.changed).length === 0 && a.error === null);

  const b = resolveArticlePatch(null, ROW, { now: NOW, log: () => {} });
  assert('body 为 null 也不抛错（畸形请求不能打成 500）', b.error === null && Object.keys(b.patch).length === 0);
}

console.log('\n=== 路由接线：源码契约（这一层要真实 DB + 三重认证，故用文本断言）===');
// 两份：结构断言用剥注释版（`adminSrc`），检查「注释里必须有说明」的断言用原文（`adminRaw`）
const adminRaw = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
const adminSrc = stripCommentLines(adminRaw);

/** 取某个路由声明到下一个顶层 router. 声明之间的源码窗口（与 importSanitize 同一手法） */
function routeWindow(sig) {
  const at = adminSrc.indexOf(sig);
  if (at === -1) return null;
  let end = adminSrc.length;
  for (const r of ['router.post(', 'router.put(', 'router.delete(', 'router.get(']) {
    const i = adminSrc.indexOf(`\n${r}`, at + sig.length);
    if (i !== -1 && i < end) end = i;
  }
  return adminSrc.slice(at, end);
}

const putWin = routeWindow("router.put('/articles/:id', async");
assert('能找到 PUT /articles/:id 路由', putWin !== null);

if (putWin) {
  assert('路由调用了纯函数 resolveArticlePatch(body, row, ...)',
    /resolveArticlePatch\(\s*body\s*,\s*row\s*,/.test(putWin));
  assert('纯函数产出的 patch 被合并进落库对象',
    /Object\.assign\(patch,\s*resolved\)/.test(putWin));
  assert('纯函数返回 error 时走 400（不是 500、也不是静默通过）',
    /if\s*\(patchError\)\s*return\s+fail\(res,\s*patchError,\s*400\)/.test(putWin));
  assert('事务与缓存失效仍在路由里（不能被抽进纯函数）',
    /db\.transaction\(\)/.test(putWin) && /invalidateReadingCache\(\)/.test(putWin));

  // 防回退：旧的「有值才改」写法不许回来
  assert('旧的 `if (slug) {` 写法已消失（它正是清空不生效的根因）',
    !/if\s*\(\s*slug\s*\)\s*\{/.test(putWin));
  assert('旧的 `published_at && isValidDateTime` 组合已消失',
    !/published_at\s*!==\s*undefined\s*&&\s*typeof\s+published_at\s*===\s*'string'\s*&&\s*published_at/.test(putWin));

  // 回传结果值：前端要靠它同步表单
  assert('响应回传了 slug（清空后是后端生成的新值）',
    /slug:\s*changed\.slug\s*!==\s*undefined/.test(putWin));
  assert('响应回传了 published_at（清空后必须是 null）',
    /published_at:\s*changed\.published_at\s*\?/.test(putWin));
  assert('响应不再是 `ok(res, null, ...)`（那样前端拿不到新 slug / 新时间）',
    !/return\s+ok\(res,\s*null,\s*'文章更新成功'\)/.test(putWin));
}

assert('纯函数从 module.exports 导出（挂载形态不变：router 自身仍是导出对象）',
  typeof adminRouter === 'function' && typeof adminRouter.resolveArticlePatch === 'function');
assert('纯函数源码里有契约表注释（这次的口径必须留在代码里）',
  /published_at: null` 或 `''`/.test(adminRaw) && /按标题重新生成/.test(adminRaw));

// ---- POST /articles：新建也必须认 published_at（2026-11-01 补）----
// 原来新建文章时右侧填的「发布时间」会被静默丢弃（只在 PUT 生效），
// 同一个表单出现两种结果。契约与 PUT 对齐：合法的显式时间优先；
// null/'' 不覆盖默认（发布→当前时间，草稿→NULL），想清空走 PUT 的 null 契约。
assert('新建（POST）也读取 body.published_at（不再静默丢弃）',
  /rawPublishedAt/.test(adminSrc));
assert('POST 的 null/空串不覆盖「发布补当前时间」的默认值',
  /rawPublishedAt !== undefined && rawPublishedAt !== null && String\(rawPublishedAt\)\.trim\(\) !== ''/.test(adminSrc));
assert('POST 的非法日期显式 400（与 PUT 同一句文案）',
  /isValidDateTime\(rawPublishedAt\)\) return fail\(res, '发布时间不是有效日期'\)/.test(adminSrc));

console.log(`\narticlePatchContract 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
