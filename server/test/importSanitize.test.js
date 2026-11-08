/**
 * 备份导入清洗回归（无 DB / 无服务）
 *
 * 缺陷：POST /articles/admin/import 的 content 只校验长度就原样入库，而创建
 * （POST /articles）与更新（PUT /articles/:id）都走 cleanMarkdown(content, 100000)。
 * 于是「从备份恢复」成为唯一绕过点：把导出的 JSON 改一改再传回来，<script> /
 * <iframe> 就顺着恢复路径写回正文列（存储型 XSS，前台渲染即执行）。
 *
 * 为什么这里用「源码文本断言」而不是真的发一次导入请求：
 *   导入路由挂在 admin 秘钥路径 + JWT + 指纹 + 会话三重认证之后，跑通一次需要
 *   真实 MySQL（文章/分类/标签四张表 + 事务）与整套登录态 —— 纯函数测试覆盖不到
 *   这个分支，而集成测试要把整个后台栈搬进单测。这里取中间路线：净化函数本身用
 *   真实调用验证行为（cleanMarkdown 是纯函数，可断言），路由分支用源码契约锁住
 *   「导入也调了同一个函数、同一个上限」。这是防未来回退的钉子，不是行为模拟。
 *
 * 用法：node test/importSanitize.test.js
 */
const { stripCommentLines } = require('./helpers/sourceText');
const fs = require('fs');
const path = require('path');
const { cleanMarkdown } = require('../src/utils/sanitize');

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

// 两份：结构断言用剥注释版，检查「注释里必须有理由」的断言用原文
const adminRaw = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
const adminSrc = stripCommentLines(adminRaw);

/**
 * 取某个路由声明到下一个顶层 router. 声明之间的源码窗口（与 cacheInvalidation 同一手法）。
 *
 * 显式接受 `src`：同一个窗口要取两份 —— 结构断言用剥注释版（`adminSrc`），
 * 而「注释里必须写清理由」那类断言要用原文（`adminRaw`），剥了就没得查了。
 */
function routeWindow(sig, src = adminSrc) {
  const at = src.indexOf(sig);
  if (at === -1) return null;
  let end = src.length;
  for (const r of ['router.post(', 'router.put(', 'router.delete(', 'router.get(']) {
    const i = src.indexOf(`\n${r}`, at + sig.length);
    if (i !== -1 && i < end) end = i;
  }
  return src.slice(at, end);
}

/** 窗口内所有 cleanMarkdown(...) 调用的上限参数 */
function cleanMarkdownLimits(win) {
  return [...win.matchAll(/cleanMarkdown\(([^)]*)\)/g)].map((m) => {
    const args = m[1].split(',');
    return (args[1] || '').trim();
  });
}

console.log('=== cleanMarkdown：备份里的可执行标签必须被剔除 ===');
assert('内联 <script> 整段消失',
  !/alert|script/i.test(cleanMarkdown('正常段落\n<script>alert(1)</script>', 100000)),
  '脚本进正文列 = 存储型 XSS');
assert('<iframe> 不再出现（外链框架可承载钓鱼页）',
  !/iframe|evil\.example/i.test(cleanMarkdown('<iframe src="//evil.example/x"></iframe>正文', 100000)));
assert('<style> 不再出现（可做整页覆盖式伪装）',
  !/style|body\{/i.test(cleanMarkdown('<style>body{display:none}</style>正文', 100000)));
assert('<object>/<embed>/<applet> 一并剔除',
  !/object|embed|applet/i.test(cleanMarkdown('<object data="x"></object><embed src="y"><applet code="z">', 100000)));
assert('javascript: 协议的链接被去毒（href 被丢弃，文字保留）',
  (() => {
    const out = cleanMarkdown('<a href="javascript:alert(1)">点我</a>', 100000);
    return !/javascript:/i.test(out) && /点我/.test(out);
  })(),
  '链接文字该留，协议不该留');
assert('正常 Markdown 与安全 HTML 原样保留（不能为了安全把正文吃掉）',
  (() => {
    const src = '# 标题\n\n**粗体**\n\n- 列表项\n\n<div class="note">提示</div>\n\n![图](/uploads/a.png)';
    const out = cleanMarkdown(src, 100000);
    return out.includes('# 标题') && out.includes('**粗体**') && out.includes('- 列表项')
      && out.includes('class="note"') && out.includes('/uploads/a.png')
      && out.includes('提示');
  })());
assert('上限仍然生效（导入不能借清洗顺手放大正文长度）',
  cleanMarkdown('a'.repeat(200000), 100000).length === 100000);

console.log('\n=== 导入分支：content 必须过 cleanMarkdown ===');
const importWin = routeWindow("router.post('/articles/admin/import', async");
// 同一窗口的原文版本：给「注释里必须写清理由」的断言用
const importWinRaw = routeWindow("router.post('/articles/admin/import', async", adminRaw);
assert('能找到导入路由', importWin !== null);
if (importWin) {
  assert('导入分支存在 cleanMarkdown( 调用', importWin.includes('cleanMarkdown('),
    '备份是外部输入，不清洗就是唯一的绕过点');
  assert('清洗结果赋值给 content（而不是清洗完又用了原值）',
    /(?:const|let|var)\s+content\s*=\s*cleanMarkdown\(|\bcontent\s*=\s*cleanMarkdown\(/.test(importWin));
  // 入库字段只能用清洗后的 content：rawContent（原始串）不得直接进 insert 对象
  assert('入库时用的是清洗后的 content，没有回退到原始串',
    !/content:\s*(?:rawContent|it\.content)/.test(importWin)
    && /\bcontent,\s*\n/.test(importWin),
    'insert({ ..., content }) 若写成 rawContent 等于清洗白做');
  // 清洗后为空（整篇都是 <script>）必须跳过，不能写空正文行
  assert('清洗结果为空时跳过该条（与创建路由「正文不能为空」同语义）',
    /if\s*\(!content\)\s*\{\s*skipped\s*\+=\s*1;\s*continue;\s*\}/.test(importWin));
  assert('导入的 summary 仍走 cleanLine(..., 300)（本次不改它的既有处理）',
    /summary:\s*cleanLine\(it\.summary,\s*300\)/.test(importWin));
  assert('导入的 cover 仍走 safeCover（封面 URL 校验不被漏掉）',
    /cover:\s*safeCover\(it\.cover\)/.test(importWin));
  assert('注释写清了「备份是外部输入 / 与创建更新同等清洗」的理由',
    /备份是外部输入/.test(importWinRaw) && /绕过点/.test(importWinRaw),
    '没有原因的注释下次重构就会被删掉');
}

console.log('\n=== 三条写入路径必须一致（创建 / 更新 / 导入）===');
const createWin = routeWindow("router.post('/articles', async");
const updateWin = routeWindow("router.put('/articles/:id', async");
assert('创建路由窗口可定位', createWin !== null);
assert('更新路由窗口可定位', updateWin !== null);

for (const [name, win] of [['创建', createWin], ['更新', updateWin], ['导入', importWin]]) {
  if (!win) { assert(`${name}：窗口缺失`, false); continue; }
  const limits = cleanMarkdownLimits(win);
  assert(`${name}：调用了 cleanMarkdown(`, limits.length > 0);
  assert(`${name}：上限是 100000`, limits.length > 0 && limits[0] === '100000',
    `实际 ${JSON.stringify(limits)}`);
}
assert('三处的 cleanMarkdown 上限完全一致（有差异 = 又开了一条更宽松的路径）',
  [createWin, updateWin, importWin].every((w) => w && cleanMarkdownLimits(w)[0] === '100000'));
assert('三条路径都从同一个模块引入同一个函数（没有哪条自己实现一套过滤）',
  /const\s*\{[^}]*\bcleanMarkdown\b[^}]*\}\s*=\s*require\('\.\.\/utils\/sanitize'\)/.test(adminSrc));

console.log(`\nimportSanitize 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
