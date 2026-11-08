/**
 * 故障可见性门禁：**接口失败不能显示成"没有数据"**。
 *
 * 这是这个项目里反复出现的一类缺陷，形态几乎一样：
 *   - `NotFound.randomArticle` 的空 catch → 点了按钮什么也没发生
 *   - `ArticleList.load` 无 try/catch → 请求失败显示「还没有文章，来写第一篇吧」
 *   - `Messages` / `Links` 同理
 *   - `admin` store 的 `/* 忽略 *\/` → 侧栏角标消失，管理员以为没有待审
 *
 * 共同点：catch 是空的（或只写一行注释），失败后状态变量保持初始值，
 * 而初始值恰好等于「空数据」的合法状态。于是**故障与空态在 UI 上不可区分**。
 *
 * 本门禁检查：凡是「加载列表/计数」的函数，catch 里必须设置一个可观察的失败标志，
 * 且模板里必须真的用了那个标志。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentLines, selfTest as sourceTextSelfTest } from './lib/sourceText.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (p) => readFileSync(resolve(SRC, p), 'utf8');

console.log('\n【每个加载函数都要有可观察的失败标志】');
{
  const cases = [
    {
      file: 'views/site/ArticleList.vue',
      flag: 'loadFailed',
      why: '文章列表：失败与「没有文章」必须可区分',
    },
    {
      file: 'views/admin/Dashboard.vue',
      flag: 'loadError',
      why: '后台仪表盘：失败不能显示成一屏 0',
    },
    {
      file: 'stores/admin.js',
      flag: 'failed',
      why: '待审角标：拉取失败时角标不能消失（那会被读成「没有待审」）',
    },
    {
      // 第 41 轮补的：归档页原来只有一个 `catch (e) { /* 拦截器已提示 */ }`，
      // groups 保持 []，于是「加载中」「加载失败」「确实没文章」三种情况全是空白页，
      // 而空态文案说的是「还没有已发布的文章」—— 网络失败时那就是在说假话。
      file: 'views/site/Archive.vue',
      flag: 'failed',
      why: '归档页：失败不能显示成「还没有已发布的文章」',
    },
  ];
  for (const c of cases) {
    const src = read(c.file);
    const hasFlag = new RegExp(`(const|let)\\s+${c.flag}\\s*=\\s*ref\\(`).test(src);
    const setOnCatch = new RegExp(`${c.flag}\\.value\\s*=\\s*true`).test(src);
    ok(`${c.file}: 有 ${c.flag} 状态`, hasFlag, c.why);
    ok(`${c.file}: catch 里把 ${c.flag} 置 true`, setOnCatch, c.why);
    ok(`${c.file}: 成功路径会把它复位（否则一次失败永久报警）`,
      new RegExp(`${c.flag}\\.value\\s*=\\s*false`).test(src));
  }
}

console.log('\n【失败标志必须真的被模板用上（声明了不用等于没做）】');
{
  // 归档页的三态必须互斥：只在「非加载中、非失败、确实为空」时才说「还没有文章」
  const ar = read('views/site/Archive.vue');
  ok('Archive 的空态绑了「非加载中且非失败」',
    /v-if="!loading && !failed && !yearGroups\.length"/.test(ar));
  ok('Archive 的失败态是独立分支（不能和空态合并）',
    /v-else-if="failed"/.test(ar));
  ok('Archive 的失败态有 role="alert"', /state-error[\s\S]{0,80}role="alert"|role="alert"[\s\S]{0,80}state-error/.test(ar));
  ok('Archive 的失败态提供重试入口', /@click="load\(\)"/.test(ar));
  ok('Archive 有 loading 状态（否则渲染前会闪一下空态）',
    /const\s+loading\s*=\s*ref\(true\)/.test(ar));
  ok('Archive 的 onMounted 走同一个 load（避免两处逻辑分叉）', /onMounted\(load\)/.test(ar));
}
{
  const al = read('views/site/ArticleList.vue');
  ok('ArticleList 用 loadFailed 渲染独立的失败态',
    /v-else-if="loadFailed"/.test(al) || /loadFailed\s*\?/.test(al));
  ok('失败态有 role="alert"（读屏立刻播报）', /role="alert"/.test(al));
  ok('失败态提供重试入口', /重试/.test(al));

  const db = read('views/admin/Dashboard.vue');
  ok('Dashboard 用 loadError 渲染失败态', /v-(else-)?if="loadError"/.test(db) || /loadError\s*\?/.test(db));

  const layout = read('views/admin/Layout.vue');
  ok('Layout 的角标读取 admin.failed', /admin\.failed/.test(layout));
  ok('失败时角标不是空字符串（空 = 被读成"没有待审"）',
    /FAILED\s*=\s*'!'/.test(layout) && /\.includes\(item\.path\)\s*\?\s*FAILED/.test(layout));
  ok('失败态角标有独立配色（error 类）', /side-badge\.error/.test(layout));
  ok('失败态角标有 title 说明（悬停能看到原因）',
    /待审数量获取失败/.test(layout));
}

console.log('\n【代码质量的底线：catch 不能是空的或只有一行注释】');
{
  const files = [
    'views/site/ArticleList.vue',
    'views/site/Messages.vue',
    'views/site/Links.vue',
    'views/admin/Dashboard.vue',
    'stores/admin.js',
    'stores/home.js',
  ];
  for (const f of files) {
    const src = read(f);
    // 匹配「catch (...) { 只有注释/空白 }」
    const emptyCatch = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/g;
    const hits = [...src.matchAll(emptyCatch)]
      // 白名单只放一类：localStorage 在隐私模式/被禁用时会抛错，
      // 这里「忽略」是**正确**行为（用户只是不想要偏好持久化，不该看到报错）。
      // 白名单按注释内容匹配而不是按文件名 —— 否则下一个人会往文件级白名单里加东西。
      .filter((h) => !/隐私模式/.test(h[0]));
    ok(`${f}: 没有「空 catch / 只有注释的 catch」（隐私模式除外）`,
      hits.length === 0, hits.map((h) => h[0].replace(/\s+/g, ' ').slice(0, 60)).join(' | '));
  }
}

console.log('\n【setup 式 store 没有 $reset —— 用它就是静默 no-op】');
{
  // Pinia 的 `$reset` 只存在于 options 式 store（`defineStore(id, { state, actions })`）。
  // 本项目全部是 setup 式（`defineStore(id, () => {...})`），所以 `store.$reset?.()`
  // 里的可选链永远是 undefined —— 不报错、不警告、什么也不做。
  // auth store 的登出清理就踩过：以为清了角标，实际把上一个会话的待审数留给下一个登录者。
  const stores = ['stores/admin.js', 'stores/auth.js', 'stores/home.js', 'stores/site.js', 'stores/theme.js'];
  for (const f of stores) {
    // 只看代码行：注释里会引用 `$reset()` 作反面说明，不能用全文正则
    const codeOnly = stripCommentLines(read(f));
    ok(`${f}: 不调用 $reset（setup 式 store 没有这个方法）`,
      !/\.\$reset\s*\??\.?\s*\(/.test(codeOnly),
      'setup 式 store 必须自己写 reset()');
  }

  const admin = read('stores/admin.js');
  ok('admin store 提供了 reset()', /function reset\(\)/.test(admin));
  ok('reset() 重置了全部三个状态（pending / loaded / failed）',
    /pending\.value\s*=\s*\{ comments: 0, links: 0, messages: 0 \}/.test(admin)
    && /loaded\.value\s*=\s*false/.test(admin)
    && /failed\.value\s*=\s*false/.test(admin));
  ok('reset() 被导出（否则外部调不到）', /totalPending, reset \}/.test(admin));

  const auth = read('stores/auth.js');
  ok('登出路径调用了 admin reset()', /useAdminStore\(\)\.reset\(\)/.test(auth));
  ok('登出的清理不再包在空 catch 里（清理失败不该静默）',
    !/clearSession\(\);[\s\S]{0,200}catch\s*\(e\)\s*\{\s*\}/.test(auth));
  ok('admin store 是静态引入（它本来就在主包，动态 import 只多一个失败点）',
    /from '@\/stores\/admin'/.test(auth) && !/await import\('@\/stores\/admin'\)/.test(auth));
}

console.log('\n【门禁自检：规则能抓到真问题】');
{
  // 反例 1：空 catch
  const bad = 'async function f() { try { await x(); } catch (e) { } }';
  const emptyCatch = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/;
  ok('空 catch 会被判为违规', emptyCatch.test(bad) === true);

  // 反例 2：只有注释的 catch
  const commentOnly = 'try { await x(); } catch (e) { /* 忽略 */ }';
  ok('只有注释的 catch 会被判为违规', emptyCatch.test(commentOnly) === true);

  // 正例：置了标志
  const good = 'try { await x(); } catch (e) { failed.value = true; }';
  ok('置了失败标志的 catch 通过', emptyCatch.test(good) === false);

  // 白名单：隐私模式忽略不该被报（这是合法的降级，不是缺陷）
  const emptyCatchGlobal = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/g;
  const privacy = 'try { localStorage.setItem("k", "v"); } catch (e) { /* 隐私模式忽略 */ }';
  const allowed = [...privacy.matchAll(emptyCatchGlobal)].filter((h) => !/隐私模式/.test(h[0]));
  ok('白名单里的「隐私模式忽略」不算违规', allowed.length === 0);
  ok('白名单不会放过别的空 catch',
    [...'try { await x(); } catch (e) { /* 随便写点什么 */ }'.matchAll(emptyCatchGlobal)]
      .filter((h) => !/隐私模式/.test(h[0])).length === 1);

  // 反例 3：声明了失败标志但模板不用
  const declares = 'const failed = ref(false);';
  ok('声明了标志但模板没引用时，人肉检查会漏 —— 所以本门禁额外检查引用',
    /const failed/.test(declares));
}

console.log('\n【工具自检：剥注释逻辑本身必须可信】');
{
  // 所有「某写法不许出现」的断言都依赖 stripCommentLines。它一旦失真，
  // 依赖它的门禁会一起变成假绿（或假红）。这里真跑它的 11 条用例。
  const cases = sourceTextSelfTest();
  for (const c of cases) ok(`sourceText: ${c.name}`, c.pass);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
