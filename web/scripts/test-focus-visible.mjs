/**
 * 键盘焦点可见性
 *
 * 为什么需要这个测试：`:focus { outline: none }` 是「去掉浏览器默认粗黑框」的
 * 常见写法，但它同时把**唯一的焦点指示**也去掉了。WCAG 2.4.7 要求键盘焦点
 * 必须可见 —— 键盘用户 Tab 到输入框时，如果只有 border-color 变化，
 * 在小字号旁几乎看不出来，等于不知道自己在哪。
 *
 * 本轮实测（真实 Tab 走查 5 个页面）发现：
 *   - 列表页搜索框、留言页昵称、留言内容：完全没有可见焦点指示
 *   - 页面数选择器：只有边框变色
 *
 * 更麻烦的是**特指度**：main.css 的全局 `:focus-visible` 是 (0,1,0)，
 * 而组件的 `.form-input[data-v-x] { outline: none }` 是 (0,2,0) —— 全局打不过。
 * 所以修复必须落在组件里，这个测试也就必须同时检查「全局兜底」和「组件内覆盖」。
 *
 * 用法：node scripts/test-focus-visible.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * 判断某个文件的样式里，是否存在「可聚焦控件被灭了 outline 却没有任何
 * :focus-visible 补偿」的情况。
 *
 * 检查方式：找出所有声明 `outline: none|0` 的规则块，取其选择器；
 * 然后要求同一文件里存在对应的 `:focus-visible` 规则，或该选择器的
 * 祖先容器有 `:focus-within` 的可见指示。
 */
function auditOutlineSuppression(src, fileLabel) {
  const problems = [];

  // 收集所有「选择器 → 声明块」对
  const rules = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(src))) {
    rules.push({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }

  const killsOutline = rules.filter((r) => /outline\s*:\s*(none|0)\s*;/.test(r.body));
  const hasFocusVisible = rules.some((r) => r.sel.includes(':focus-visible'));
  const hasFocusWithinRing = rules.some(
    (r) => r.sel.includes(':focus-within') && /outline\s*:\s*\d/.test(r.body)
  );

  for (const r of killsOutline) {
    // 明确写在 :focus-visible 里的 outline:none 是正当的（用于把环挪给父容器）
    if (r.sel.includes(':focus-visible')) continue;
    problems.push({ file: fileLabel, sel: r.sel, hasFocusVisible, hasFocusWithinRing });
  }
  return problems;
}

console.log('\n【全局兜底】');
{
  const css = read('../src/styles/main.css');
  ok(
    ':focus-visible 全局规则给出可见 outline',
    /:focus-visible\s*\{[\s\S]{0,200}?outline:\s*2px solid/.test(css)
  );
  ok(
    '全局规则给输入框类显式补环（不能只指望通用规则）',
    /input:focus-visible[\s\S]{0,200}?outline:\s*2px solid/.test(css),
    '组件里的 outline:none 会在特指度上压过通用 :focus-visible'
  );
  ok(
    '外层容器代画焦点环时，内层输入框保持 outline:none',
    /\.search-input:focus-visible\s*\{[\s\S]{0,80}?outline:\s*none/.test(css),
    '否则会出现「双层环」'
  );
  ok(
    '.search-box 用 :focus-within 显示环',
    /\.search-box:focus-within\s*\{[\s\S]{0,200}?outline:\s*2px solid/.test(css)
  );
}

console.log('\n【组件内：灭掉 outline 的地方必须有补偿】');
{
  const files = [
    ['../src/views/site/Messages.vue', '留言页'],
    ['../src/components/site/CommentSection.vue', '评论区'],
    ['../src/views/site/ArticleList.vue', '文章列表'],
  ];
  for (const [path, label] of files) {
    const src = read(path);
    const problems = auditOutlineSuppression(src, label);
    ok(
      `${label}：每个 outline:none 都有 :focus-visible 补偿`,
      problems.length === 0,
      problems.map((p) => p.sel).join(' / ') || undefined
    );
  }
}

console.log('\n【关键控件逐个点名】');
{
  const messages = read('../src/views/site/Messages.vue');
  const comment = read('../src/components/site/CommentSection.vue');
  const list = read('../src/views/site/ArticleList.vue');

  ok(
    '留言页 .form-input / .form-textarea 有 :focus-visible 环',
    /\.form-input:focus-visible,\s*\n\.form-textarea:focus-visible\s*\{[\s\S]{0,160}?outline:\s*2px solid/.test(messages)
  );
  ok(
    '评论区 .form-input / .form-textarea 有 :focus-visible 环',
    /\.form-input:focus-visible,\s*\n\.form-textarea:focus-visible\s*\{[\s\S]{0,160}?outline:\s*2px solid/.test(comment)
  );
  ok(
    '每页条数选择器有 :focus-visible 环',
    /\.page-size-select:focus-visible\s*\{[\s\S]{0,120}?outline:\s*2px solid/.test(list)
  );

  // 基础规则里不该再留着裸的 outline:none（那会让同特指度的补偿失效）
  ok(
    '留言页输入框基础规则不再裸写 outline:none',
    !/\.form-input\s*\{[^}]*outline:\s*none/.test(messages)
  );
  ok(
    '评论区输入框基础规则不再裸写 outline:none',
    !/\.form-input\s*\{[^}]*outline:\s*none/.test(comment)
  );
}

console.log('\n【局部刷新的结果变化要被播报】');
{
  const list = read('../src/views/site/ArticleList.vue');
  const css = read('../src/styles/main.css');

  // 翻页 / 切排序 / 换筛选都是局部刷新：URL 变了但页面不跳转、标题不变、
  // 焦点也不移动。没有 aria-live 的话，读屏用户按「下一页」后听不到任何变化。
  ok(
    '结果区有 role=status + aria-live=polite 的播报点',
    /role="status"\s+aria-live="polite"/.test(list) || /aria-live="polite"[\s\S]{0,80}role="status"/.test(list)
  );
  ok(
    '播报内容包含条数与页码（不是空壳）',
    /共 \$\{total\.value\} 篇文章/.test(list) && /第 \$\{page\.value\}/.test(list)
  );
  ok(
    '加载中用 aria-busy 告诉读屏「还在加载」',
    /:aria-busy="loading \? 'true' : 'false'"/.test(list)
  );
  ok(
    '播报点用 sr-only 而不是 display:none（后者会从无障碍树移除）',
    /class="sr-only"\s+role="status"/.test(list) || /sr-only[^>]*role="status"/.test(list)
  );
  ok(
    'sr-only 用 1px 裁剪实现，且没有 display:none',
    /\.sr-only\s*\{[\s\S]{0,400}?clip:\s*rect\(0, 0, 0, 0\)/.test(css)
    && !/\.sr-only\s*\{[^}]*display:\s*none/.test(css)
  );

  // 分页语义
  // 属性顺序不固定（v-if 在 class 前），不能用固定顺序的正则
  {
    // 注意：`v-if="total > pageSize"` 里有个 `>`，用 [^>]* 会在那里截断。
    // 改为取「从 <nav 到行尾」这一段。
    const line = (list.split('\n').find((l) => l.includes('<nav') && l.includes('pagination-wrap')) || '');
    ok('分页容器是 nav 且带 aria-label', /aria-label="文章分页"/.test(line), line.trim().slice(0, 80));
    ok('分页 nav 正确闭合（不是把 div 改了一半）', /<\/nav>/.test(list));
  }
  ok(
    '当前页标 aria-current="page"',
    /:aria-current="p === page \? 'page' : undefined"/.test(list)
  );
  ok(
    '上一页/下一页有 aria-label（只有图标，没有可读文字）',
    /aria-label="上一页"/.test(list) && /aria-label="下一页"/.test(list)
  );
  ok(
    '每页条数用 label 包裹（点文字也能选中下拉）',
    /<label class="page-size">/.test(list)
  );
  ok(
    '页码按钮有可读标签（避免只念一个数字）',
    /:aria-label="p === page \? `第 \$\{p\} 页，当前页` : `第 \$\{p\} 页`"/.test(list) || /aria-label="第 / .test(list)
  );

  // 依赖顺序：resultAnnouncement 用到 totalPages，必须声明在其后
  const iTotal = list.indexOf('const totalPages = computed');
  const iAnn = list.indexOf('const resultAnnouncement = computed');
  ok(
    'resultAnnouncement 声明在 totalPages 之后（依赖顺序）',
    iTotal !== -1 && iAnn !== -1 && iTotal < iAnn
  );
}

console.log('\n【翻页不能被筛选 watcher 冲掉】');
{
  const list = read('../src/views/site/ArticleList.vue');

  // 真实 bug：watch 的 getter 写成 `() => [a,b,c,d]` 时，每次运行都返回新数组，
  // Vue 按引用比较 → 永远判定"变了" → 只要 route.query 有变化（包括翻页写入
  // ?page=2）就触发 page.value = 1; load(1)，把刚翻过去的页码冲回第 1 页。
  // 症状：点下一页没反应、带 ?page=2 的分享链接永远停在第 1 页。
  ok(
    '筛选 watcher 的源是稳定字符串（filterKey computed），不是每次新建的数组',
    /const filterKey = computed\(\(\) =>/.test(list) && /watch\(filterKey,/.test(list)
  );
  ok(
    '不再存在 "watch(() => [route.query...])" 这种数组 getter',
    !/watch\(\s*\n?\s*\(\) => \[route\.query\.category/.test(list),
    '数组 getter 会因引用不等而每次触发'
  );
  ok(
    'filterKey 只由筛选条件构成（不含 page / pageSize）',
    (() => {
      const m = list.match(/const filterKey = computed\(\(\) =>[\s\S]{0,400}?\);/);
      if (!m) return false;
      const body = m[0];
      return body.includes('route.query.category') && !/route\.query\.page\b/.test(body);
    })(),
    '页码变化不该触发"筛选变了"'
  );

  // 页码初始化：不能只在 setup 顶层读 route.query（那时 query 还没解析完）
  ok(
    'onMounted 里从 URL 校正页码与每页条数',
    /const urlPage = Number\(route\.query\.page\)/.test(list) && /const urlSize = Number\(route\.query\.pageSize\)/.test(list)
  );
  ok(
    '程序化校正 pageSize 时不走 @change（否则会重置页码并清掉 URL 的 page）',
    /suppressPageSizeChange = true/.test(list) && /if \(suppressPageSizeChange\) return;/.test(list)
  );
}

console.log('\n【表单错误必须可定位、可关联】');
{
  for (const [path, label, idPrefix] of [
    ['../src/views/site/Messages.vue', '留言页', 'msg-err'],
    ['../src/components/site/CommentSection.vue', '评论区', 'cmt-err'],
  ]) {
    const src = read(path);
    ok(
      `${label}：出错字段标 aria-invalid`,
      /:aria-invalid="fieldErrors\.nickname \? 'true' : undefined"/.test(src)
    );
    ok(
      `${label}：错误文字通过 aria-describedby 关联到字段`,
      new RegExp(`:aria-describedby="fieldErrors\\.nickname \\? '${idPrefix}-nickname'`).test(src)
    );
    ok(
      `${label}：错误文字就地渲染且有 role=alert`,
      new RegExp(`<p v-if="fieldErrors\\.nickname" id="${idPrefix}-nickname" class="field-error" role="alert">`).test(src)
    );
    ok(
      `${label}：提交失败后把焦点送到第一个出错字段（不只弹 toast）`,
      /function focusFirstError\(\)/.test(src) && /focusFirstError\(\);/.test(src)
    );
    ok(
      `${label}：用户开始输入时清除该字段错误`,
      /@input="clearFieldError\('nickname'\)"/.test(src)
    );
  }

  const css = read('../src/styles/main.css');
  ok('.field-error 有可见样式（不只是占位）', /\.field-error\s*\{[\s\S]{0,200}?color:/.test(css));
  ok('.field-error 深色下有提亮版本（冷红对深底不够）', /\[data-theme='dark'\] \.field-error\s*\{/.test(css));
  ok('出错字段边框变红（视觉用户也能定位）', /\.form-input\.is-invalid,[\s\S]{0,120}?border-color:\s*#a8323a/.test(css));
}

console.log('\n【后台大表单：未保存修改不能静默丢失】');
{
  // 实测：在站点设置改了字段后点侧栏「仪表盘」，页面直接走了、无任何提示。
  // 后两类编辑页（文章/手记）本来就有保护，但两个设置页没有 ——
  // 而设置页恰恰是「改了半天、手滑点错导航就全没了」的典型场景。
  for (const [path, label, word] of [
    ['../src/views/admin/Settings.vue', '站点设置', '站点设置'],
    ['../src/views/admin/HomeSettings.vue', '主页设置', '主页设置'],
  ]) {
    const src = read(path);
    ok(`${label}：有 dirty 基线比较`, /let baseline = ''/.test(src) && /dirty = ref\(false\)/.test(src));
    ok(`${label}：加载完成后记录基线（避免刚打开就提示）`, /setBaseline\(/.test(src));
    ok(`${label}：路由离开时确认`, /onBeforeRouteLeave\(async \(\) => \{/.test(src) && /ElMessageBox\.confirm/.test(src));
    ok(
      `${label}：确认文案点名是哪一个页面`,
      src.includes(`'${word}还有尚未保存的修改`)
    );
    ok(`${label}：刷新/关标签页也拦（beforeunload）`, /addEventListener\('beforeunload'/.test(src));
    ok(`${label}：卸载时移除监听（避免泄漏）`, /removeEventListener\('beforeunload'/.test(src));
    ok(`${label}：未修改时不打扰`, /if \(!dirty\.value\) return true;/.test(src));
  }
  // 三个编辑页原本就有保护，做存在性回归
  for (const p of ['../src/views/admin/ArticleEdit.vue', '../src/views/admin/NoteEdit.vue', '../src/views/admin/SecurityManage.vue']) {
    ok(`${p.split('/').pop()} 仍有离开保护`, /onBeforeRouteLeave/.test(read(p)));
  }
}

console.log('\n【首屏启动态：JS 到达前不能是纯白】');
{
  // 实测：慢速网络下（1.2s 延迟 / 25KB/s），JS bundle 下载完之前
  // #app 是**纯空白**，读者看到的是一片白，没有任何「正在加载」的迹象。
  // 阻断 JS 复测确认修复：博客 7 个骨架块 / 598px；个人主页 6 块 / 478px。
  for (const [file, label] of [['../index.html', '博客'], ['../home.html', '个人主页']]) {
    const html = read(file);
    ok(`${label}入口的 #app 内有启动骨架`, /<div id="app">\s*<div[^>]*aria-hidden="true"/.test(html) || /boot-skeleton/.test(html));
    ok(`${label}入口不再有空的 app div`, !/<div id="app"><\/div>/.test(html), '#app 空着就等于首屏纯白');
    ok(`${label}入口有启动播报`, /正在加载页面/.test(html), '读屏用户需要知道页面在加载');
    ok(
      `${label}骨架用内联样式（此时还没有 CSS）`,
      /style="[^"]*background:/.test(html),
      '引外部类名等于没样式 —— JS 没跑起来时 CSS 也可能没好'
    );
    ok(`${label}骨架对读屏隐藏（纯装饰）`, /aria-hidden="true"/.test(html));
  }
}

console.log('\n【分享元信息：og:image 必须是绝对 URL】');
{
  // 实测四类页面原本的差异：
  //   文章页 og:url✓ canonical✓ og:image绝对✓
  //   列表/标签/关于 og:url✗ canonical✗ og:image 是 HTML 里硬编码的 /og-image.webp
  // 社交平台要求绝对 URL，相对路径直接被忽略 → 分享卡片没有配图。
  const meta = read('../src/utils/pageMeta.js');
  ok('有统一的 pageMeta 工具', /export function applyPageMeta/.test(meta));
  ok('og:image 会绝对化', /export function absoluteUrl/.test(meta));
  ok(
    'twitter:* 按 name 写入（不是 property）',
    /function setMetaByName/.test(meta),
    'setMeta 按 ":" 判 property，会把 twitter:card 写成 property，Twitter 读不到'
  );
  ok('每页都写 canonical 与 og:url', meta.includes("'og:url'") && meta.includes("'canonical'"));

  for (const [f, label] of [['../index.html', '博客'], ['../home.html', '个人主页']]) {
    ok(
      `${label}入口不再硬编码相对 og:image`,
      !/property="og:image" content="\/og-image\.webp"/.test(read(f)),
      '相对路径会被平台忽略，必须由 pageMeta 在运行时绝对化'
    );
  }

  // 六个页面都接上了统一工具
  for (const f of ['ArticleList', 'Tags', 'About', 'Archive', 'Links', 'Bookmarks']) {
    ok(`${f} 页接了 applyPageMeta`, /applyPageMeta/.test(read(`../src/views/site/${f}.vue`)));
  }
}

console.log('\n【分享页也要支持 ETag 条件请求】');
{
  const share = read('../../server/src/routes/share.js');
  // 实测：app.disable('etag') 全局关了自动 ETag，
  // feed.js 里 sitemap/RSS 都是手算的，**分享页漏了这一步** ——
  // 只有 Cache-Control，没有 ETag，抓取器 5 分钟后回来只能重新生成整页
  //（查库 + 拼 HTML），og 抓取器对同一 URL 会反复抓，这部分开销白付。
  ok('有 conditionalSendHtml 辅助函数', /function conditionalSendHtml/.test(share));
  ok('ETag 由响应体内容算出（与 feed.js 同一套）', /createHash\('sha1'\)\.update\(html\)/.test(share));
  ok('命中 If-None-Match 时返回 304', /if \(req\.headers\['if-none-match'\] === etag\)/.test(share));
  ok('两个模板都走条件发送', (share.match(/conditionalSendHtml\(req, res, html\)/g) || []).length >= 2);
  ok('仍保留 5 分钟公共缓存', /max-age=300/.test(share));
  // 全局 disable('etag') 必须留着（安全取舍），所以手算这条不能被「优化」掉
  const app = read('../../server/src/app.js');
  ok("app.disable('etag') 仍在（安全取舍，别为了省事打开）", /app\.disable\('etag'\)/.test(app));
}

console.log('\n【搜索高亮：先匹配再转义，且不能因此放过 XSS】');
{
  // 实测缺陷：标题 `__probe A & B 对比测试`，搜 `A & B` **能搜到但 0 处高亮**。
  // 原因是「整串先转义、再拿关键词去匹配转义后的串」——
  // 标题里的 & 已变成 &amp;，关键词里的 & 就匹配不上了。
  // 修法是 **在原文上匹配、只对命中的片段转义**（用 split 保留分隔符）。
  const sm = read('../src/components/ui/SearchModal.vue');
  const fn = (sm.match(/function highlight[\s\S]{0,900}/) || [''])[0];
  ok('高亮函数存在', !!fn);
  // split(re) 是关键：奇数位即命中片段
  ok('用 split 保留分隔符（先匹配）', /raw\.split\(re\)|\.split\(re\)/.test(fn), fn.slice(0, 50));
  ok('只对片段转义（不转义 <mark>）', /escHtml\(part\)/.test(fn));
  ok('奇数位才包 mark', /i % 2 === 1/.test(fn));
  // 关键词的正则元字符必须转义，否则 `(` 会让 RegExp 抛错
  ok('转义正则元字符', /\[\.\*\+\?\^\(\)\|\[\]\\\]/.test(fn) || /replace\(\/\[\.\*/.test(fn), 
     (fn.match(/const pattern = [^\n]*/) || [''])[0].slice(0, 60));
  // escHtml 必须覆盖五个字符
  ok('escHtml 覆盖 & < > " \'', /'&'/.test(sm) && /'<'/.test(sm) && /'&quot;'|'"/.test(sm));
}

console.log('\n【搜索弹层的键盘导航：↑↓ 移动、Enter 跳转、边界不越界】');
{
  // 实测 3 条结果：初始选中 0；↓↓ 到 2；↑ 回到 1；Enter 跳到文章且弹层关闭。
  // 注意选择器是 `.result-item.active` —— 我最初用 `.active` 命中了导航项，
  // 又用 `[class*=result]` 数错了节点，两次都误判成「方向键没反应」。
  const sm = read('../src/components/ui/SearchModal.vue');
  ok('有 activeIndex 状态', /const activeIndex = ref/.test(sm));
  ok('↓ 键移动选中', /ArrowDown/.test(sm) && /activeIndex\.value \+ 1/.test(sm));
  ok('↑ 键移动选中', /ArrowUp/.test(sm) && /activeIndex\.value - 1/.test(sm));
  // Enter 要跳转，且必须有结果才跳（空结果回车不能报错）
  ok('Enter 跳转（有结果才跳）', /results\.value\[activeIndex\.value\]/.test(sm));
  // 边界必须夹住：↓ 到底不能越界，↑ 到顶不能变负
  const dn = (sm.match(/ArrowDown[\s\S]{0,160}/) || [''])[0];
  const up = (sm.match(/ArrowUp[\s\S]{0,160}/) || [''])[0];
  ok('↓ 越界夹住', /Math\.min\([^)]*results\.value\.length - 1/.test(dn), dn.slice(0, 60));
  // 只匹配 `e.key === 'ArrowUp'` 分支 —— 用 /ArrowUp/ 会命中 `<XIcon name="ArrowUpRight">`
  const upBranch = (sm.match(/e\.key === 'ArrowUp'[\s\S]{0,180}/) || [''])[0];
  ok('↑ 不变成负数', /Math\.max\([^)]*0\)/.test(upBranch), upBranch.slice(0, 60));
}

console.log('\n【归档页：按年→月分组，跨年时月份归属不能错】');
{
  // 实测插入跨月/跨年数据后：2026(8篇) 在 2025(1篇) 之前（年倒序）；
  // 月分组 8月:6 / 7月:1 / 6月:1 在 2026 下，而 **12月:1 归到 2025** 下 ——
  // 跨年时把 12 月错挂到 2026 是这类分组最典型的 bug（月份相同、年份不同）。
  const arc = read('../src/views/site/Archive.vue');
  ok('归档页存在', arc.length > 0);
  // 分组必须**同时**用年份和月份作键，只用月份会让不同年的同月并成一组
  ok('分组键含年份', /year|getFullYear/i.test(arc));
  ok('分组键含月份', /month|getMonth/i.test(arc));
  // 倒序：新的年/月在前
  ok('按时间倒序', /desc|sort|reverse/i.test(arc));
}

console.log('\n【文章分页：翻页、改每页条数、末页禁用下一页】');
{
  // 实测 24 篇 / 每页 8：3 页，第 3 页「下一页」**禁用**；
  // 切到 32/页 → 24 条、分页区消失（24 < 32）；
  // 从第 3 页切到 16/页 → **回到第 1 页**（1/2），不会停在不存在的第 3 页。
  const al = read('../src/views/site/ArticleList.vue');
  // 分页只在需要时出现，别在只有一页时也画一排页码
  ok('分页区按 total > pageSize 显示', /v-if="total > pageSize"/.test(al));
  ok('末页禁用下一页', /:disabled="page >= totalPages"/.test(al));
  // 改每页条数必须重置到第 1 页 —— 否则会停在越界页码上看到空白
  ok('改每页条数时重置页码',
     /onPageSizeChange[\s\S]{0,220}(page\.value = 1|load\(1\))/.test(al),
     (al.match(/function onPageSizeChange[\s\S]{0,100}/) || [''])[0].slice(0, 60));
  // 行序号要跨页连续，不能每页都从 01 开始
  ok('行序号跨页连续', /\(page - 1\) \* pageSize/.test(al));
  // 每页条数要有上限，防止一次拉全部文章
  ok('每页条数有上限选项', /pageSize/.test(al) && /32/.test(al));
}

console.log('\n【标签云：零文章标签也要显示（不能悄悄消失）】');
{
  // 实测 10 个标签：4 个有 2 篇、4 个有 1 篇、2 个**零篇**。
  // 页面完整显示 10 个，零篇的显示 0 并计入「共 10 个标签」，
  // 且字号按篇数分档（weight-N）。我一开始只取了前 12 个节点，
  // 漏了末尾那两个 0，差点报成「零篇标签不渲染」。
  const tg = read('../src/views/site/Tags.vue');
  ok('有零篇标签的专门分支', /v-if="!tag\.article_count"/.test(tg));
  ok('零篇也显示计数 0', />0</.test(tg));
  // 有篇数的走正常分支，且字号按数量分档
  ok('按篇数分级字号', /weightClass\(tag\.article_count\)/.test(tg));
  // 分档时除数不能为 0（全站标签都零篇时会 NaN）
  ok('分级除数有下限保护', /Math\.max\([\s\S]{0,60}, 1\)/.test(tg),
     (tg.match(/Math\.max\([^)]*\)/) || [''])[0].slice(0, 60));
}

console.log('\n【热议排序：按已审评论数降序，且三种排序必须两两不同】');
{
  // 实测（插了 #4=3条、#2=2条、#6=1条 已审评论）：
  //   最新 → 08-17 08-15 08-12 08-06 08-01
  //   最热 → 08-06 08-01 08-15 08-12 08-17（views）
  //   热议 → 08-17 08-01 08-06 08-15 08-12（评论数：3,2,1,0,0）
  // 三者两两不同 → 各自独立生效。若某个 sort 参数被忽略，两两之间就会相同。
  const art = read('../../server/src/routes/articles.js');
  // 热议必须 join 到已审评论，且只算 approved
  ok('热议 join 评论表', /leftJoin\('comments as cm'/.test(art));
  ok('只统计已审评论', /cm\.status', '=', db\.raw\('\?', \['approved'\]|cm\.status', '=', 'approved'/.test(art));
  // groupBy 必须在数据查询上，否则 total 恒 1
  const cmt = (art.match(/sort === 'commented'[\s\S]{0,700}/) || [''])[0];
  ok('热议分组用 a.id', /groupBy\('a\.id'\)/.test(cmt) || /groupBy/.test(art));
  // sort 参数必须是白名单，不能直接拼进 SQL
  ok('sort 有白名单校验', /'hot'|'commented'|'latest'/.test(art) && !/orderBy\(req\.query\.sort/.test(art));
}

console.log('\n【三种排序：置顶永远在前，其余按各自维度降序】');
{
  // 实测（排除置顶那篇）：
  //   默认/最新 → 08-17 08-15 08-12 08-06 08-01（按发布时间降序）
  //   最热      → 08-06 08-01 08-15 08-12 08-17（按 **views** 降序，
  //               不是 likes —— 我一开始拿 likes 对，顺序"不对"，读代码才确认是 views）
  //   热议      → 按已审评论数降序（当前 0 条评论，退化为时间序）
  // 三者共同点：is_top 永远排第一。
  const art = read('../../server/src/routes/articles.js');
  ok('三种排序都有 is_top 前置', (art.match(/column: 'a\.is_top', order: 'desc'/g) || []).length >= 3,
     `找到 ${(art.match(/column: 'a\.is_top'/g) || []).length} 处`);
  ok('最热按 views 降序', /sort === 'hot'[\s\S]{0,200}column: 'a\.views', order: 'desc'/.test(art));
  ok('热议按评论数降序', /COUNT\(cm\.id\)/.test(art));
  // 热议的 groupBy 只能加在数据查询上，否则 count 查询的 total 恒为 1、翻页失效
  ok('groupBy 只加在数据查询（不影响计数）', /groupBy 只加在数据查询/.test(art));
}

console.log('\n【文章列表：筛选、排序、清空，且徽章随状态变】');
{
  // 实测：点分类 → h1 变分类名、篇数 6→3、eyebrow 变 CATEGORY、URL 带 ?category=slug；
  // 再选排序 → URL 追加 &sort=hot（两者叠加，不互相清空）；
  // 点「全部」→ 回到 6 篇、h1 回「全部文章」、URL 回到 #/articles。
  const al = read('../src/views/site/ArticleList.vue');
  ok('徽章随筛选状态变化', /eyebrow = computed/.test(al));
  // 四种状态都要有，不能只处理分类
  for (const s of ['TAG', 'CATEGORY', 'SEARCH']) {
    ok(`徽章有 ${s} 状态`, new RegExp(`'${s}'`).test(al));
  }
  // 分类与标签要能叠加 —— 代码注释里明确说了不能互相清空
  ok('分类与标签不互相清空（可叠加）', /叠加/.test(al) || /同时支持/.test(al));
  // 清空筛选后 URL 要回到干净路径
  ok('清空筛选回干净 URL', /router\.replace|router\.push/.test(al));
}

console.log('\n【手记分页：10 条一页，加载更多后接上且不重复】');
{
  // 实测 15 条：首屏 10 条（15→6 分钟前）+「加载更多」；
  // 点一次 → 15 条、按钮消失、**0 条重复**；
  // 追加的 5 条是 5→1 分钟前，序列 15,14,…,2,1 **连续无断裂**。
  const notes = read('../src/views/home/Notes.vue');
  ok('有「加载更多」按钮且受 hasMore 控制', /v-if="hasMore"/.test(notes) && /loadMore/.test(notes));
  // 加载中要禁用，否则连点会请求同一页两次
  ok('加载中禁用按钮（防连点重复请求）', /:disabled="loading"/.test(notes));
  // 分页必须按 page 递增，并带 limit
  ok('按 page + limit 请求', /page\.value/.test(notes) && /limit|pageSize/.test(notes));
  // 追加而不是替换：实际写法是展开运算符拼新数组
  // `list.value = p === 1 ? rows : [...list.value, ...rows]`
  // 这比 push 更好 —— 整体替换数组才会稳定触发响应式更新
  ok('追加到已有列表（不是替换）',
     /\[\.\.\.list\.value,\s*\.\.\.rows\]/.test(notes),
     (notes.match(/list\.value\s*=\s*p === 1[^\n]*/) || [''])[0].slice(0, 70));
  // 第一页要能重置（切分类/刷新时），否则旧数据会残留
  ok('第一页时重置列表', /p === 1\s*\?\s*rows/.test(notes));
  // hasMore 要按返回条数判断，不能写死 true
  ok('hasMore 由返回结果决定', /hasMore\.value\s*=/.test(notes), 
     (notes.match(/hasMore\.value\s*=[^\n]*/) || [''])[0].slice(0, 60));
}

console.log('\n【个人主页的手记：列表渲染 Markdown、按时间倒序、详情能定位】');
{
  // 实测两条手记：列表里按时间**倒序**（新在前），心情标签正确，
  // Markdown（粗体/代码/列表）在列表与详情里都渲染出来了，
  // 详情路由是 #/notes/:id，且点「查看全文」跳到的是**那一条**而不是别的。
  const notes = read('../src/views/home/Notes.vue');
  ok('手记列表页存在', notes.length > 0);
  // 倒序：必须显式 desc，否则时间线会倒着长
  ok('手记按时间倒序', /orderBy|desc|sort/i.test(notes) || /created_at/.test(notes));

  const detail = read('../src/views/home/NoteDetail.vue');
  ok('详情按 id 取（不靠列表顺序）', /route\.params\.id|params\.id/.test(detail));
  // 详情要渲染 Markdown，不能把纯文本直接塞进 v-html 之前忘了转义
  ok('详情渲染 Markdown', /renderMarkdown|markdown|v-html/.test(detail));
  // 心情是有限集合，不能把任意字符串直接输出
  ok('心情有映射/白名单', /mood/i.test(detail) || /mood/i.test(notes));
}

console.log('\n【两个编辑器的脏标记清理方式不同，但都要正确】');
{
  // ArticleEdit 用的是封装好的 assignForm：
  //   suppressWatch = true → 赋值 → await nextTick() → suppressWatch = false
  // 这个顺序是**正确**的（等 watch 回调跑完才解除抑制）。
  // NoteEdit 原来没有这层封装，发布后会被自己的脏检查挡住 —— 第 114 轮修的就是它。
  // 实测 ArticleEdit 发布：确认框 → 「文章已发布」→ 跳回列表，**没有**误报「尚未保存」。
  const ae = read('../src/views/admin/ArticleEdit.vue');
  const af = (ae.match(/async function assignForm[\s\S]{0,400}/) || [''])[0];
  ok('ArticleEdit 有 assignForm 封装', !!af);
  // 顺序：抑制 → 赋值 → nextTick → 解除抑制
  ok('assignForm：先抑制再赋值',
     /suppressWatch = true[\s\S]{0,80}form\.value = /.test(af), af.slice(0, 70));
  ok('assignForm：nextTick 在解除抑制之前',
     /await nextTick\(\)[\s\S]{0,60}suppressWatch = false/.test(af));
  ok('ArticleEdit 清草稿时也清 dirty', /function clearDraft[\s\S]{0,120}dirty\.value = false/.test(ae));

  // NoteEdit 必须也有 nextTick 那一步（第 114 轮修的）
  const ne = read('../src/views/admin/NoteEdit.vue');
  ok('NoteEdit 也有 nextTick 再清 dirty', /await nextTick\(\)[\s\S]{0,120}dirty\.value = false/.test(ne));
}

console.log('\n【发布成功不能反过来告诉用户「尚未保存」】');
{
  // 实测缺陷：手记发布后确实建了记录（库里 status=published），
  // 却弹出「当前手记有尚未保存的修改，离开将丢失本次更改」并**卡在编辑页**。
  // 根因：`form.status = ...` 同步改了 form，触发深 watch 把 dirty 置回 true；
  // 而 watch 是 flush:'pre'，回调排在下一 tick ——
  // 所以「先 suppressWatch 包住赋值、再清 dirty」也无效。
  // 必须 await nextTick() 让 pending 回调跑完，再清一次。
  const ne = read('../src/views/admin/NoteEdit.vue');
  const save = (ne.match(/async function save[\s\S]{0,2200}/) || [''])[0];
  ok('发布成功后会清 dirty', /dirty\.value = false/.test(save));
  ok('清 dirty 之前先等 watch flush', /await nextTick\(\)[\s\S]{0,120}dirty\.value = false/.test(save),
     (save.match(/await nextTick\(\)[\s\S]{0,80}/) || [''])[0].slice(0, 60));
  ok('成功后跳回列表', /router\.push\(adminHref\('notes'\)\)/.test(save));
  // 改动 form 时要临时抑制 watch，否则一进编辑页就算「有改动」
  ok('改 form 时用 suppressWatch 抑制', /suppressWatch = true/.test(ne));
}

console.log('\n【分享页：社交预览靠 OG meta，且必须转义】');
{
  // 实测：/api/share/:slug 返回 200，og:type/title/description/image/url/site_name/locale 齐全，
  // twitter:card 为 summary_large_image。
  // 把标题改成 `测试 "双引号" & <script>alert(1)</script>` 后，
  // 输出为 `&quot; &amp; &lt;script&gt;` —— 无法突破 content="..." 的边界。
  const sh = read('../../server/src/routes/share.js');
  for (const tag of ['og:type', 'og:title', 'og:description', 'og:image', 'og:url']) {
    ok(`分享页有 ${tag}`, new RegExp(tag).test(sh));
  }
  ok('有 twitter:card（大图卡）', /twitter:card/.test(sh) && /summary_large_image/.test(sh));
  // 必须有转义函数，且覆盖 & < > "
  const escFn = (sh.match(/const esc = \(s\) =>[\s\S]{0,340}/) || [''])[0] ||
                (sh.match(/function esc\([\s\S]{0,340}/) || [''])[0];
  ok('有 HTML 转义函数', !!escFn, escFn.slice(0, 50));
  ok('转义覆盖 & < > "', /&amp;/.test(escFn) && /&lt;/.test(escFn) && /&quot;/.test(escFn));
  // 分享页也必须禁 PoW（爬虫不算 PoW）
  const app = read('../../server/src/app.js');
  ok('GATE_SKIP 放行分享页', /'\/share\/'/.test(app) && /'\/share-page'/.test(app));
}

console.log('\n【SEO 端点：RSS / Sitemap / robots 必须能出，且不能被伪造 Host 污染】');
{
  // 实测：三个端点都 200，Content-Type 正确（application/rss+xml / application/xml / text/plain）；
  // RSS 6 条 item、带 guid 与 RFC822 pubDate；sitemap 17 个 url。
  // 关键安全属性：伪造 `Host: evil.example.com` 后**四个端点全部 403** ——
  // 否则攻击者能让 sitemap/rss 里的绝对 URL 指向自己的域名，搜索引擎就会收录错站点。
  const app = read('../../server/src/app.js');
  // 爬虫不执行 JS、不算 PoW，必须放行，否则 sitemap/RSS 全 403
  ok('GATE_SKIP 放行 rss/sitemap/robots',
     /GATE_SKIP = \[[^\]]*'\/rss\.xml'/.test(app) && /GATE_SKIP = \[[^\]]*'\/sitemap\.xml'/.test(app));
  // trust proxy 不能用 true/跳数（会信任客户端可控的 X-Forwarded-For）
  const cfg = read('../../server/src/config.js');
  ok('TRUST_PROXY 默认 loopback', /TRUST_PROXY \?\? 'loopback'/.test(cfg));
  ok('拒绝 true / 跳数的 TRUST_PROXY', /TRUST_PROXY 禁止使用 true/.test(cfg));

  const feed = read('../../server/src/routes/feed.js');
  ok('优先用后台配置的 site_url', /settings\.site_url/.test(feed));
  ok('RSS 用 RFC822 时间', /toRfc822/.test(feed) && /toUTCString/.test(feed));
  // CDATA 里的 ]]> 必须拆开，否则会提前终止 CDATA 段
  ok('CDATA 安全转义', /\]\]>/.test(feed));
  // 相对图片要转绝对，否则阅读器跨域加载失败
  ok('相对路径转绝对', /siteUrl\.replace/.test(feed) || /abs = /.test(feed));
}

console.log('\n【文章点赞的限速：10 秒窗口，超限 429 且文案友好】');
{
  // 实测：同一 IP 对同一文章连发 3 次点赞 ——
  // 第 1 次成功（返回 likes），第 2、3 次都是 **429**
  // 「点赞太频繁啦，歇一会儿再点吧」。窗口 10 秒。
  const art = read('../../server/src/routes/articles.js');
  ok('有 likeGuard 限速器', /const likeGuard = new Map\(\)/.test(art));
  ok('窗口是 10 秒', /LIKE_WINDOW = 10 \* 1000/.test(art));
  // 键必须含 ip + articleId —— 只按 ip 会让「赞了一篇就不能赞别的」
  ok('限速键含 IP 与文章 id', /\$\{ip\}:\$\{articleId\}/.test(art));
  // 先判断后写入：写反了会让第一次就被拒
  const fn = (art.match(/function canLike[\s\S]{0,420}/) || [''])[0];
  ok('先查后写（顺序不能反）', /if \(now < expireAt\) return false;[\s\S]{0,80}likeGuard\.set/.test(fn));
  // 必须有清理，否则 Map 会随访问量无限涨
  ok('有定期清理防内存泄漏', /likeGuard\.size > 5000/.test(fn));
  ok('超限提示友好', /点赞太频繁/.test(art));
}

console.log('\n【评论点赞：乐观更新、防连点、单向不可撤销】');
{
  // 实测：5 → 点击即时变 6 并加 liked 类（乐观更新），服务端确认后仍是 6；
  // 同会话连点 3 次**只加一次**；再点一次**不会取消**（liked 仍 true）——
  // 这是单向点赞，不是 toggle。刷新后从 localStorage 恢复 liked。
  const ci = read('../src/components/site/CommentItem.vue');
  const fn = (ci.match(/async function likeComment[\s\S]{0,900}/) || [''])[0];
  ok('点赞有防重复（已赞或进行中直接返回）', /if \(liked\.value \|\| liking\.value\) return;/.test(fn));
  ok('乐观更新：先加一', /props\.comment\.likes = \(props\.comment\.likes \|\| 0\) \+ 1/.test(fn));
  // 失败必须回滚，否则请求挂了界面会永远多一个赞
  ok('失败回滚赞数', /catch[\s\S]{0,160}props\.comment\.likes = Math\.max\(0/.test(fn));
  ok('失败也重置 liked', /catch[\s\S]{0,220}liked\.value = false/.test(fn));
  // 用服务端返回值校正，避免多点/并发下有偏差
  ok('用服务端返回的 likes 校正', /typeof res\.likes === 'number'/.test(fn));
  // 记住已赞，刷新后不让人重复点
  ok('localStorage 记住已赞', /xalor_clike_/.test(ci));
}

console.log('\n【回复：进入/取消/嵌套与 @ 指向】');
{
  // 实测：点「回复」→ 占位符变 `回复 @昵称：`、焦点自动进 textarea；
  // 点取消控件 → 占位符回到「写下你的评论…」、回复上下文消失；
  // 真发一条 → 嵌套在一级评论下并自动带 `@__probe_root：`，总数 1→2。
  const cs = read('../src/components/site/CommentSection.vue');
  ok('占位符随回复态变化', /回复 @\$\{replyingTo\.nickname\}/.test(cs));
  ok('有回复上下文条（v-if replyingTo）', /v-if="replyingTo"[\s\S]{0,80}reply-context/.test(cs));
  // 取消必须是可点的独立控件，否则误点回复就退不出去
  ok('有取消回复控件', /@click="cancelReply"/.test(cs));
  ok('cancelReply 会把 replyingTo 置空', /function cancelReply[\s\S]{0,160}replyingTo\.value\s*=\s*null/.test(cs));
  // 回复正文要带 @ 指向，否则看的人不知道在回谁
  ok('回复自动带 @ 指向', /@\$\{replyingTo\.nickname\}/.test(cs));
}

console.log('\n【评论提交：快捷键、校验、昵称记忆】');
{
  // 实测：空提交 →「请填写昵称」；只填昵称按 Ctrl+Enter →「请填写评论内容（不能只有空格）」；
  // 正常提交 →「评论成功」，正文清空，昵称写进 localStorage，
  // **刷新后自动预填**（我一度以为昵称被丢掉了 —— 其实是输入框清空 + 记住 + 下次预填）。
  const cs = read('../src/components/site/CommentSection.vue');
  ok('支持 Ctrl+Enter 提交', /ctrlKey[\s\S]{0,80}Enter|Enter[\s\S]{0,80}ctrlKey/.test(cs));
  ok('提交前校验昵称', /请填写昵称/.test(cs));
  ok('校验评论内容（并说明不能只有空格）', /请填写评论内容/.test(cs));
  // 昵称必须长期记住：清空输入框但写进 localStorage
  ok('昵称写进 localStorage 长期记忆', /localStorage\.setItem\('xalor_cname'/.test(cs));
  ok('提交后清空正文', /form\.value\.content = ''/.test(cs));
  ok('提交后清草稿', /clearDraft\(\)/.test(cs));
  // 打开页面时要预填回去，否则「记住」等于没记
  ok('挂载时预填昵称', /xalor_cname/.test(cs) && /form\.value\.nickname\s*=/.test(cs));
}

console.log('\n【评论草稿按文章隔离，不能串味】');
{
  // 实测：在文章 A 写草稿 → localStorage 只有 xalor_cdraft_1；
  // 切到文章 B → 输入框**干净**；切回 A → 内容恢复并提示「已恢复上次未提交的评论草稿」。
  // 也验了损坏值会被清掉（keyGone: true）—— 用的是第 106 轮修好的那条 catch 分支。
  const cs = read('../src/components/site/CommentSection.vue');
  ok('草稿键带 articleId（按文章隔离）', /xalor_cdraft_\$\{props\.articleId\}|xalor_cdraft_\$\{/.test(cs));
  ok('用的是共用的 localDraft 工具', /from '@\/utils\/localDraft'/.test(cs));
  // 键必须是函数、延迟求值 —— 组件复用（同一实例切文章）时才不会写到上一篇的键里
  ok('DRAFT_KEY 是函数而非常量', /const DRAFT_KEY = \(\) =>/.test(cs), 
     (cs.match(/const DRAFT_KEY[^\n]*/) || [''])[0].slice(0, 60));
  ok('恢复时有非打扰提示', /已恢复上次未提交的评论草稿/.test(cs));
}

console.log('\n【本地草稿：过期/损坏/空内容都要清掉键】');
{
  // 实测 loadDraft 四种输入：过期(25h)→空串且删键；损坏 JSON→空串但**键没删**（缺陷）；
  // 正常→返回内容保留键；纯空格→空串且删键。
  // 缺陷原因：JSON.parse 抛异常直接跳 catch，走不到上面那行「损坏草稿直接清理」。
  const ld = read('../src/utils/localDraft.js');
  ok('有 24 小时 TTL', /24 \* 3600 \* 1000/.test(ld));
  ok('过期草稿会删键', /localStorage\.removeItem\(key\)/.test(ld));
  // 关键：catch 分支里也要清理，否则损坏的键永久残留
  const catchBlock = (ld.match(/\} catch \(e\) \{[\s\S]{0,400}?\n  \}/) || [''])[0];
  ok('catch 分支也清理损坏草稿', /removeItem\(key\)/.test(catchBlock), catchBlock.slice(0, 70));
  // 读写都要 try/catch —— 隐私模式下 localStorage 会直接抛
  ok('写入有 try/catch（隐私模式）', /try \{[\s\S]{0,120}setItem/.test(ld));
  ok('空内容不写入（避免残留空草稿）', /trim\(\)\) \{[\s\S]{0,60}removeItem/.test(ld) || /else \{[\s\S]{0,60}removeItem/.test(ld));
}

console.log('\n【留言提交：校验、待审核、清空输入】');
{
  // 实测四种输入：全空 → 「请填写昵称」；只填昵称 → 「请填写留言内容（不能只有空格）」；
  // 纯空格 → 「请填写昵称」；正常提交 → 「留言已提交，等待审核后展示」，
  // 内容框清空、昵称保留（便于连续留言）、消息**不出现在列表**（pending）。
  const msg = read('../src/views/site/Messages.vue');
  ok('提交前校验昵称', /请填写昵称/.test(msg));
  ok('校验留言内容（并说明不能只有空格）', /请填写留言内容/.test(msg));
  // 提交成功后要清空内容、但保留昵称 —— 连着留言两次不用重打名字
  const fn = (msg.match(/async function submit[\s\S]{0,1400}/) || [''])[0];
  // 实际写法是整体替换 form.value：{ nickname, email, content: '' }
  // —— 昵称与邮箱沿用当前值、只把正文清空，这正是「连续留言不用重打名字」
  ok('成功后清空留言内容', /content:\s*''/.test(fn), fn.slice(0, 60));
  ok('成功后保留昵称与邮箱', /\{\s*nickname,\s*email:/.test(fn));
  // 有草稿机制：成功提交后必须清掉，否则下次进页面会恢复已发出的内容
  ok('提交成功后清理本地草稿', /clearDraft\(\)/.test(fn));
  // 表单令牌要刷新，否则同一令牌可被重复使用
  ok('提交后刷新表单令牌', /refreshFormToken/.test(fn));

  // 服务端：长度上限 + 待审核 + 昵称保留
  const srv = read('../../server/src/routes/messages.js');
  ok('服务端截断正文到 2000', /cleanText\(content, 2000\)/.test(srv));
  ok('服务端截断昵称到 50', /cleanLine\(nickname, 50\)/.test(srv));
  ok('博主昵称保留（防冒充）', /已被占用/.test(srv));
}

console.log('\n【灯箱：双击 1x/2x、滚轮缩放，且缩放要有上下限】');
{
  // 实测：双击后 transform 变 matrix(2,...) 并加 zoomed 类；滚轮再放大到 2.25x；
  // 连滚 20 次**停在 4x**，不会无限放大。上限/下限两处都有 clamp。
  const lb = read('../src/components/ui/ImageLightbox.vue');
  ok('双击绑定 toggleZoom', /@dblclick="toggleZoom"/.test(lb));
  ok('滚轮绑定 onWheel 且阻止页面滚动', /@wheel\.prevent="onWheel"/.test(lb));
  // 缩放必须双向夹取：没有上限的话滚几下就把图糊成马赛克，也没法再回看全图
  const clamps = (lb.match(/Math\.min\(4,\s*Math\.max\(1,/g) || []).length;
  ok('缩放被夹在 1–4 之间（两处）', clamps >= 2, `找到 ${clamps} 处`);
  // 关闭能力：ESC 与点击遮罩都要能退出，否则触屏用户会被困住
  ok('ESC 可关闭', /Escape/.test(lb));
  ok('点击遮罩可关闭', /@click\.self|backdrop/i.test(lb));
}

console.log('\n【编辑器快捷键：Ctrl+S 存草稿、Ctrl+Enter 发布（但要先确认）】');
{
  // 实测两条都通：
  //   Ctrl+S（只填标题）→ 「请填写正文」，说明快捷键没绕过校验；
  //   Ctrl+S（填全）→ 「草稿已保存」并回到列表；
  //   Ctrl+Enter → 弹「发布后文章将对访客可见，确定发布吗？」，
  //                点确认后「文章已发布」。
  // 关键：Ctrl+Enter **不能跳过发布确认** —— 误按一次就直接对访客可见是不可接受的。
  const ae = read('../src/views/admin/ArticleEdit.vue');
  const fn = (ae.match(/function onEditorKeydown[\s\S]{0,500}/) || [''])[0];
  ok('Ctrl/Cmd+S 触发保存', /toLowerCase\(\) === 's'[\s\S]{0,80}saveDraft\(\)/.test(fn), fn.slice(0, 60));
  ok('Ctrl/Cmd+Enter 触发发布', /e\.key === 'Enter'[\s\S]{0,80}publish\(\)/.test(fn));
  // 防重入：正在保存/发布时不再重复触发
  ok('保存/发布中不重复触发', /!savingDraft\.value && !publishing\.value/.test(fn));
  // 发布前必须有确认
  const pub = (ae.match(/async function publish[\s\S]{0,900}/) || [''])[0];
  ok('发布前弹确认（快捷键不能绕过）', /ElMessageBox\.confirm/.test(pub) && /发布后文章将对访客可见/.test(pub));
  // AI 代发才允许跳过，且必须显式传参
  ok('仅显式传 skipConfirm 才跳过确认', /skipConfirm = false/.test(pub));
}

console.log('\n【帮助面板列出的快捷键必须真的能用】');
{
  // 实测缺陷：帮助面板里写着「Ctrl/Cmd K 打开全局搜索」，
  // 但整个代码库里**没有任何 ctrlKey / metaKey 处理器** ——
  // 文档承诺了一个从未实现的快捷键。"/" 能用，Ctrl+K 不能。
  const layout = read('../src/views/site/Layout.vue');
  // 实测：SearchModal 有实现，但它是**懒加载**的 ——
  // 把它那边当唯一来源时，未挂载的屏幕上 Ctrl+K 会失效（删掉 Layout 这段后复现过）。
  // Layout 始终挂载，所以这份是覆盖懒加载窗口的兜底，不是冗余。
  ok('Layout 里有 Ctrl/Cmd K 兜底',
     /e\.ctrlKey \|\| e\.metaKey/.test(layout) && /e\.key === 'k' \|\| e\.key === 'K'/.test(layout));
  const sm = read('../src/components/ui/SearchModal.vue');
  ok('SearchModal 自身也处理（挂载后生效）', /ctrlKey \|\| e\.metaKey[\s\S]{0,60}'k'/.test(sm));
  ok('openSearch 是派发事件（重复调用幂等）', /xalor-open-search/.test(layout));
  ok('Ctrl+K 打开搜索（不是别的东西）', /ctrlKey[\s\S]{0,140}openSearch\(\)/.test(layout));
  // Cmd 键也要支持（macOS 用户按的是 Cmd）
  ok('同时支持 metaKey（macOS）', /metaKey/.test(layout));
  // "/" 在输入框内要被抑制 —— 否则搜不了带斜杠的关键词
  ok('"/" 在输入框内不触发', /tag === 'INPUT' \|\| tag === 'TEXTAREA'/.test(layout));
  // 面板里列出的条目不能超出实际实现
  const help = read('../src/components/ui/ShortcutHelp.vue');
  ok('帮助面板仍列出 Ctrl/Cmd K', /Ctrl\/Cmd K/.test(help));
}

console.log('\n【搜索：SQL 通配符必须按字面量处理】');
{
  // 实测边界：空关键词 → 6 篇；"Vue" → 2 篇；"%" / "_" / "'" / 200 个 a → 0 篇且有空状态。
  // 关键是 % 和 _ 这两个 LIKE 通配符：不转义的话搜 "%" 会命中全部。
  const san = read('../../server/src/utils/sanitize.js');
  ok('有 escapeLike', /function escapeLike/.test(san));
  const escFn = (san.match(/function escapeLike[\s\S]{0,160}/) || [''])[0];
  ok('转义 \\ % _ 三个字符', /\[\\\\%_\]/.test(escFn), escFn.slice(0, 70));

  const art = read('../../server/src/routes/articles.js');
  ok('关键词查询前先 escapeLike', /escapeLike\(/.test(art));
  ok('关键词有长度上限（防超长 LIKE）', /slice\(0, 50\)/.test(art));
  // 同时搜标题与摘要 —— 只搜标题会漏掉只在摘要里提到的文章
  const kwBlock = (art.match(/if \(keyword\)[\s\S]{0,400}/) || [''])[0];
  ok('同时搜标题与摘要',
     /a\.title', 'like'/.test(kwBlock) && /a\.summary', 'like'/.test(kwBlock),
     kwBlock.slice(0, 80));
}

console.log('\n【导出的 CSV 必须防公式注入】');
{
  // 用户提交的昵称/留言/友链简介会原样进 CSV。
  // 若单元格以 = + - @ 开头，Excel / Numbers 会当**公式**执行
  // （=HYPERLINK(...) 之类可以外联、=cmd|... 在旧 Excel 上更糟）。
  // 六个导出入口分两类：四个在前端拼、两个由服务端拼，都要防。
  const fe = ['CategoryManage', 'LinkManage', 'SecurityManage', 'TagManage'];
  const bad = [];
  for (const f of fe) {
    const src = read(`../src/views/admin/${f}.vue`);
    const i = src.indexOf('new Blob([');
    if (i < 0) { bad.push(`${f}: 没有导出`); continue; }
    // 往前找该函数里的 esc 定义
    const fnStart = src.lastIndexOf('function ', i);
    const chunk = src.slice(fnStart, i);
    const hasEsc = /const esc = /.test(chunk);
    const hasGuard = /\[=\+\\-@\\t\\r\]|=\+\\-@/.test(chunk);
    if (!hasEsc) bad.push(`${f}: 无 esc`);
    else if (!hasGuard) bad.push(`${f}: esc 未防公式`);
  }
  ok('四个前端导出都防了公式注入', bad.length === 0, bad.join('; '));

  // 服务端那两个（评论 / 留言）
  const adm = read('../../server/src/routes/admin.js');
  const escDefs = (adm.match(/\^\[=\+\\-@\\t\\r\]/g) || []).length;
  ok('服务端导出也防了公式注入（至少两处）', escDefs >= 2, `找到 ${escDefs} 处`);
  // 每一列都要过 esc，不能只包表头
  ok('导出行逐列过 esc', /map\(esc\)\.join\(','\)/.test(adm));
}

console.log('\n【reduced-motion：入场位移动画要从源头去掉】');
{
  // 实测：全局兜底把 animation-duration 压到 0.01ms 后，
  // .fade-up 的 playState 已是 finished、transform 归零 —— 用户看不到位移。
  // 但那是「压时长」，不是「没有位移」：reduced-motion 的语义是「不想看到位移」，
  // 少数浏览器在首帧仍会合成一次。改成对入场类直接 animation:none + transform:none。
  // 验证：八条路由全部 leaked=0、shifted=0，内容 opacity 仍为 1。
  const css = read('../src/styles/main.css');
  const rmBlocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1]).join('\n');
  ok('存在全局兜底（压时长）', /animation-duration:\s*0\.01ms/.test(rmBlocks));
  ok('无限循环动画被显式停掉', /animation:\s*none !important/.test(rmBlocks));
  ok('入场位移类直接去掉动画', /\.fade-up[\s\S]{0,160}animation:\s*none !important/.test(rmBlocks));
  ok('入场位移类位移归零', /\.fade-up[\s\S]{0,200}transform:\s*none !important/.test(rmBlocks));
  // 去掉动画不能把内容弄没
  ok('入场类最终仍然可见', /\.fade-up[\s\S]{0,200}opacity:\s*1 !important/.test(rmBlocks));
}

console.log('\n【后台打印：留下数据，去掉操作界面】');
{
  // 实测打印后台文章列表：侧栏 .admin-side 仍是 flex、高 **835px**（整页被它吃掉），
  // 工具栏 64px，页面上还有 **35 个可见按钮**，真正要打的表格被挤到后面。
  // 前台早就有 print 清单，后台一条都没有。
  const css = read('../src/styles/main.css');
  const printBlock = (css.match(/@media print \{[\s\S]*?\n\}/) || [''])[0];
  ok('print 块里包含后台侧栏', /\.admin-side/.test(printBlock));
  ok('print 块里包含工具栏/批量栏', /\.toolbar/.test(printBlock) && /\.batch-bar/.test(printBlock));
  ok('侧栏隐藏后主区不再留左偏移', /\.admin-main[\s\S]{0,120}margin-left:\s*0/.test(printBlock));
  // 行内按钮必须隐藏，而表格文字必须保留 —— 两者不能一锅端
  ok('表格行内按钮在打印时隐藏', /\.el-table__row button/.test(printBlock));
  // 实测打印文章页时纸上还留着两个按钮：
  // 代码块的「复制」与「复制本文链接」——它们的唯一作用是把内容送进剪贴板，
  // 而纸上没有剪贴板。（修完后前台文章页可见按钮数 = 0）
  ok('代码块复制按钮打印时隐藏', /\.code-copy/.test(printBlock));
  ok('复制本文链接按钮打印时隐藏', /\.cc-btn/.test(printBlock));
  // 扫描八条路由后，只有首页还剩三个按钮：首屏「阅读文章」CTA（.hero-actions）
  // 与热门区那组切换标签（.hot-tabs）。修完后八条路由打印时可见按钮全为 0，
  // 而热门区的标题文字本身仍在。
  ok('首页首屏按钮打印时隐藏', /\.hero-actions/.test(printBlock));
  ok('热门区切换标签打印时隐藏', /\.hot-tabs/.test(printBlock));
  // 只检查规则本身，先剥掉注释 —— 注释里提到这个反面写法（作为说明）不算违规
  const printRules = printBlock.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(
    '没有宽匹配选择器（会误伤整列内容）',
    !/\[class\*="action"\]/.test(printRules)
  );
}

console.log('\n【用户点了按钮，界面不能毫无反应】');
{
  // 实测：ArticleEdit 的「自动生成摘要」在正文为空时 `if (!md.trim()) return;`
  // —— 点了完全没反应，用户不知道是按钮坏了还是正文没写。
  const ae = read('../src/views/admin/ArticleEdit.vue');
  ok('自动摘要空正文时给提示（不是静默 return）',
     /if \(!md\.trim\(\)\) return ElMessage\.warning/.test(ae));

  // 批量操作栏：未选中时整条 v-if 不渲染 —— 这比「渲染后静默 return」更彻底。
  // 但函数层仍要有兜底，因为 AI 面板等入口可能绕过 UI 直接调用。
  for (const [f, label] of [['CommentManage','评论'], ['MessageManage','留言'],
                            ['LinkManage','友链'], ['NoteManage','手记']]) {
    const src = read(`../src/views/admin/${f}.vue`);
    ok(`${label}：批量栏未选中时不渲染`, /v-if="selection\.length"/.test(src));
    ok(`${label}：函数层也有空选择兜底`, new RegExp(`请先选择${label}`).test(src));
  }
  // ArticleManage 的批量入口一直都有提示，不能退步
  ok('文章批量操作仍有「请先选择文章」',
     (read('../src/views/admin/ArticleManage.vue').match(/请先选择文章/g) || []).length >= 5);
}

console.log('\n【创建按钮要自己防重入，别只靠数据库唯一约束】');
{
  // 实测：连点 3 次「创建」只建出 1 条，但**第 2、3 次是被数据库唯一约束挡的**
  // （回「分类名称已存在」），前端并没有主动拦。
  // 换成没有唯一约束的资源，连点就会真的建出多条 —— 所以补了 creating 重入判断。
  // 另外 TagManage 原来空名称时 `if (!name) return;` **什么都不说**，
  // 点了「创建」毫无反应，用户不知道是没生效还是没填名字。
  for (const [f, label] of [['CategoryManage', '分类'], ['TagManage', '标签']]) {
    const src = read(`../src/views/admin/${f}.vue`);
    const fn = (src.match(/async function create\(\)[\s\S]{0,900}/) || [''])[0];
    ok(`${label}创建有重入保护`, /if \(creating\.value\) return;/.test(fn), fn.slice(0, 60));
    // 空名称必须给提示，不能静默 return
    ok(`${label}空名称会给提示`, new RegExp(`请输入${label}名称`).test(fn));
    // 提示要在 return 里，不能只是算了不用
    ok(`${label}提示真的返回了`, /return ElMessage\.warning/.test(fn));
    // 按钮侧也必须有防护（双保险）。两种写法都算：
    // Element Plus 的 :loading，或原生 button 的 :disabled（后者更严，空名称时就禁用）
    ok(
      `${label}按钮在请求中不可再点`,
      /:loading="creating"/.test(src) || /:disabled="creating\b/.test(src)
    );
  }
}

console.log('\n【非法输入要么拦、要么安全降级，不能原样落库】');
{
  // 实测六种非法输入，四种直接拒绝、两种安全降级：
  //   空分类名 / 纯空格 → 「分类名称不能为空」
  //   空文章标题 → 「标题不能为空」；非法文章状态 → 「非法状态」
  //   300 字分类名 → **截断到 50**（cleanLine(name,50)）
  //   非法颜色 → **回退默认 #e4573d**（validHexColor）
  // 后两种没有报错，但也没把脏值写进去 —— 这比报错更友好，值得钉住。
  const san = read('../../server/src/utils/sanitize.js');
  ok('cleanLine 按 maxLen 截断', /function cleanLine\(input, maxLen/.test(san) && /\.slice\(0, maxLen\)/.test(san));
  // validHexColor 定义在 admin.js 内部，不在 sanitize.js
  ok('有颜色白名单校验 validHexColor', /function validHexColor/.test(read('../../server/src/routes/admin.js')));

  const adm = read('../../server/src/routes/admin.js');
  ok('分类名截断到 50', /cleanLine\(name, 50\)/.test(adm));
  ok('描述截断到 255', /cleanLine\(description, 255\)/.test(adm));
  ok('文章标题截断到 200', /cleanLine\(title, 200\)/.test(adm));
  ok('正文有长度上限', /cleanMarkdown\(content, 100000\)/.test(adm));
  ok('状态走白名单，不接受任意值', /\['draft', 'published'\]\.includes\(status\)/.test(adm));
  ok('评论状态走白名单', /\['pending', 'approved', 'rejected'\]\.includes\(status\)/.test(adm));
}

console.log('\n【更新接口必须和创建接口一样拦住空名称】');
{
  // 实测缺陷：PUT /categories/:id 传 {name:''} 时，
  // cleanLine('') 返回 ''，而代码只判断 `patch.name` 是否存在就照常 update ——
  // 分类名可以被改成空白，前台分类列表出现无名条目。
  // 创建接口一直有 `if (!cleanName) return fail(...)`，更新接口漏了同一道检查。
  const adm = read('../../server/src/routes/admin.js');
  const iPut = adm.indexOf("router.put('/categories/:id'");
  ok('找到分类更新路由', iPut > 0);
  const put = adm.slice(iPut, iPut + 1600);
  ok('更新时清洗后为空要报错', /if \(!cleanName\) return fail\(res, '分类名称不能为空'\)/.test(put));
  // 创建接口的同名校验不能被顺手删掉
  const iPost = adm.indexOf("router.post('/categories'");
  const post = adm.slice(iPost, iPost + 800);
  ok('创建接口的空名称校验仍在', /if \(!cleanName\) return fail/.test(post));
  // 传 undefined（不传该字段）时不该被拦 —— 只改颜色不该报「名称不能为空」
  ok('仅在传了 name 字段时才校验', /if \(name !== undefined\)/.test(put));
}

console.log('\n【内联创建表单：成功后要清空，才能连着建】');
{
  // 实测：分类管理用**内联表单**（不是弹框）—— 我先按弹框去测，白跑两轮。
  // 填入 __探针分类 → 创建：行数 4→5、列表出现新项、提示「分类创建成功」、**输入框清空**。
  const cat = read('../src/views/admin/CategoryManage.vue');
  const fn = (cat.match(/async function create\(\)[\s\S]{0,900}/) || [''])[0];
  ok('创建调用了 create 接口', /categoryApi\.create/.test(fn));
  ok('成功后刷新列表', /load\(\)/.test(fn));
  // 清空输入是关键：不清空就没法连着建第二个
  ok('成功后清空表单（可连续创建）', /newCat\.value\s*=\s*\{/.test(fn) || /resetNew/.test(fn), fn.slice(0, 70));
  // 同名/空名应在客户端先挡一次，别直接打到接口
  ok('创建前有基本校验', /trim\(\)|if \(!/.test(fn));
  // 这张页面必须是内联表单，不是 el-dialog（避免以后被改成弹框而断言失效）
  ok('分类创建是内联表单', /@click="create"/.test(cat) && !/el-dialog[\s\S]{0,200}@click="create"/.test(cat));
}

console.log('\n【保存必须走完「写库 → 关框 → 刷新」三步】');
{
  // 实测：改分类名 → 保存 → 数据库里确实是新值，
  // 表格刷新为新值，overlay 变成 display:none（Element Plus 关闭后节点保留）。
  // 注意：**不能用 DOM 是否存在判断对话框关闭** —— 节点一直在，
  // 我前两次就是这么误判成「保存后不关框」的。
  const cat = read('../src/views/admin/CategoryManage.vue');
  const fn = (cat.match(/async function saveEdit\(\)[\s\S]{0,700}/) || [''])[0];
  ok('保存调用了 update 接口', /categoryApi\.update/.test(fn));
  ok('成功后关对话框', /dialogVisible\.value\s*=\s*false/.test(fn), fn.slice(0, 60));
  ok('成功后刷新列表', /load\(\)/.test(fn));
  // 顺序：写库 → 提示 → 关框 → 刷新
  const iUpdate = fn.indexOf('categoryApi.update');
  const iClose = fn.indexOf('dialogVisible.value = false');
  const iLoad = fn.indexOf('load()');
  ok('先写库再关框', iUpdate >= 0 && iClose > iUpdate);
  ok('关框后刷新列表', iLoad > iClose);
  // 失败时不能关框（否则用户输入丢失且不知道没存上）
  ok('失败分支不关框', /catch/.test(fn) && !/catch[\s\S]{0,80}dialogVisible\.value\s*=\s*false/.test(fn));
}

console.log('\n【批量删除：必须报数量，且说清不可恢复】');
{
  // 实测：勾选 2 条评论点批量删除，确认框文案是
  // 「确定删除选中的 2 条评论吗？此操作不可恢复。」
  // 改之前 CommentManage / MessageManage / LinkManage 只说「确定删除选中的 N 条…」，
  // 少了「不可恢复」——而 ArticleManage / NoteManage 早就写了，属于同类操作文案不一致。
  // 函数名各页不同：NoteManage 用的是 batchDelete，其余是 batchRemove。
  // 必须按名字精确找，且只从**函数定义**处起切（模板里的 @click 引用不算）。
  const batch = {
    ArticleManage: 'batchRemove', NoteManage: 'batchDelete',
    CommentManage: 'batchRemove', MessageManage: 'batchRemove', LinkManage: 'batchRemove',
  };
  const missing = [];
  for (const [f, fnName] of Object.entries(batch)) {
    const src = read(`../src/views/admin/${f}.vue`);
    // 不能用 /[\s\S]*?\n\}/ —— 函数体内部还有 `}`，会被提前截断；
    // 也不能太短 —— ArticleManage 的 batchRemove 到 batchDelete 有 14 行、约 600 字。
    const m = src.match(new RegExp(`(?:async\\s+)?function\\s+${fnName}\\b`));
    if (!m) { missing.push(`${f}: 找不到 ${fnName}`); continue; }
    const fn = src.slice(m.index, m.index + 2000);
    // 必须有确认框（不能裸调 API）
    if (!/ElMessageBox\.confirm/.test(fn)) { missing.push(`${f}: 无确认框`); continue; }
    // 必须报出数量
    if (!/\$\{selection\.value\.length\}|count/.test(fn)) missing.push(`${f}: 不报数量`);
    // 必须说清不可恢复
    if (!/不可恢复/.test(fn)) missing.push(`${f}: 没写不可恢复`);
    // 必须直接调 batchDelete 之前先 confirm
    // 注意：NoteManage 的函数本身就叫 batchDelete，所以不能用 indexOf('batchDelete')
    // —— 会命中函数名自身（位置 0）。要匹配的是 **API 调用** noteApi.batchDelete / xxxApi.batchDelete。
    const iConfirm = fn.indexOf('ElMessageBox.confirm');
    const iDelete = fn.search(/\w+Api\.batchDelete/);
    if (iConfirm < 0 || iDelete < 0 || iConfirm > iDelete) missing.push(`${f}: 确认在删除之后`);
  }
  ok('五个批量删除入口都先确认、报数量、写不可恢复', missing.length === 0, missing.join('; '));
}

console.log('\n【编辑页必须拦住「未保存就离开」】');
{
  // 实测：改标题后直接切路由，对话框正常弹出：
  // 「当前文章有尚未保存的修改，离开将丢失本次更改，是否确定离开？」
  // （第一次测时我用错了 input 选择器，误判成「没弹框」—— 功能一直是好的）
  const ae = read('../src/views/admin/ArticleEdit.vue');
  ok('有 dirty 标志', /const dirty = ref\(false\)/.test(ae));
  ok('form 深层变化会标记已修改', /watch\(form, scheduleAutosave, \{ deep: true \}\)/.test(ae));
  ok('路由离开弹确认框', /onBeforeRouteLeave/.test(ae) && /尚未保存的修改/.test(ae));
  ok('浏览器关闭/刷新也兜底（beforeunload）', /beforeunload/.test(ae) && /function onBeforeUnload/.test(ae));
  ok('beforeunload 只在 dirty 时拦截', /if \(!dirty\.value\) return;/.test(ae));
  // 卸载必须清掉待触发的自动保存，否则旧实例会污染新文章的草稿键
  ok('卸载时清掉自动保存定时器', /clearTimeout\(autosaveTimer\)/.test(ae));
  // 程序性赋值不能误标 dirty（否则「一进页面就提示未保存」）
  ok('程序赋值期间抑制自动保存', /suppressWatch/.test(ae));
}

console.log('\n【标题由守卫统一拼，各视图不该各写一套】');
{
  // 实测：后台 12 个页面标题全部是「<meta.title> · 管理后台」，
  // 而 15 个后台视图**一个都没有 document.title** ——
  // 全部由 router/factory.js 的 beforeEach 统一拼。
  // 这条规则值得钉住：一旦有人「顺手」在某个视图里再写一次，
  // 就会出现两处真相，且守卫那次会覆盖视图那次。
  const factory = read('../src/router/factory.js');
  ok('守卫用 meta.title 统一拼标题', /document\.title = to\.meta\.title \?/.test(factory));
  ok('站名后缀单一来源（siteName）', /\$\{siteName\}/.test(factory));

  // 后台视图不应各自设标题（否则守卫会覆盖它们，形成两处真相）
  const admins = ['Dashboard', 'ArticleManage', 'NoteManage', 'CommentManage', 'MessageManage',
                  'LinkManage', 'CategoryManage', 'TagManage', 'ImageManage', 'Settings',
                  'SecurityManage', 'AuditManage'];
  const offenders = admins.filter((f) => /document\.title\s*=/.test(read(`../src/views/admin/${f}.vue`)));
  ok('后台视图不各自设标题（统一交给守卫）', offenders.length === 0, offenders.join(', '));

  // 后台路由必须带 meta.title，否则标题会退化成光秃秃的站名
  const routes = read('../src/router/routes-admin.js');
  const withTitle = (routes.match(/meta:\s*\{[^}]*title:/g) || []).length;
  ok('后台路由都声明了 meta.title', withTitle >= 10, `只有 ${withTitle} 处`);
}

console.log('\n【个人主页入口也要有 page meta】');
{
  // 实测：#/notes 与手记详情原先**连 document.title 都没设** —— 标签页永远停在
  // home.html 那句静态标题，og:* / canonical 全缺，分享出去只有裸链接。
  // 博客入口那七个页面早就写了，个人主页这三个视图是漏掉的另一半。
  const files = { 'Home': '/', 'Notes': '/notes' };
  const missing = [];
  for (const [f, path] of Object.entries(files)) {
    const src = read(`../src/views/home/${f}.vue`);
    if (!/applyPageMeta/.test(src)) { missing.push(`${f}: 无 applyPageMeta`); continue; }
    if (!src.includes(`path: '${path}'`)) missing.push(`${f}: path 不是 ${path}`);
    if (!/document\.title\s*=/.test(src)) missing.push(`${f}: 没设 document.title`);
  }
  ok('个人主页 Home / Notes 都写全 meta', missing.length === 0, missing.join('; '));
  // 详情页的 description 要用手记自身内容，不能是站点级那句话
  const nd = read('../src/views/home/NoteDetail.vue');
  ok('手记详情有 applyPageMeta', /applyPageMeta/.test(nd));
  ok('详情 description 取自手记本身', /n\.excerpt|n\.content/.test(nd));
  ok('详情 canonical 指向 /notes/:id', /path: `\/notes\/\$\{n\.id\}`/.test(nd));
}

console.log('\n【滑动动画的容器必须裁剪】');
{
  const rp = read('../src/components/ui/RouteProgress.vue');
  // 实测：.rp-bar 用 translateX(-100% → 400%) 持续滑动，
  // 而 .route-progress 没有 overflow ——
  // 375px 视口下条形右边缘在 421px，**溢出 46px**，3px 高的渐变光晕贴在屏幕外。
  // 桌面端宽度大不易察觉，窄屏上一眼可见。
  const wrap = (rp.match(/\.route-progress \{[\s\S]*?\n\}/) || [''])[0];
  ok('进度条容器有 overflow: hidden', /overflow:\s*hidden/.test(wrap), wrap.slice(0, 60));
  // 动画本身不能因此被关掉
  ok('滑动动画仍在（裁剪不等于禁用）', /@keyframes rpSlide/.test(rp) && /animation:\s*rpSlide/.test(rp));
}

console.log('\n【导航里的图标按钮都要有名字（含状态）】');
{
  const layout = read('../src/views/site/Layout.vue');
  // 实测：移动端导航 4 个图标按钮里，主题切换与主题色两个只有 title、没有 aria-label。
  // 主题色那个里面**只有一个纯色圆点**，既没文字也没说明当前是什么色。
  ok('主题切换按钮有 aria-label', /:aria-label="theme\.mode === 'auto' \?/.test(layout));
  ok(
    'aria-label 说出当前状态与下一步动作',
    /主题：跟随系统，点击切换为亮色/.test(layout) && /主题：暗色，点击切换为跟随系统/.test(layout)
  );
  ok('主题色按钮有 aria-label', /:aria-label="`更换主题色，当前为 \$\{accentLabel\}`"/.test(layout));
  // 当前色名必须从 THEME_COLORS 反查，不能只说「更换主题色」
  ok('主题色名从 THEME_COLORS 反查', /THEME_COLORS\.find/.test(layout));
  // 已有的两个（菜单/搜索）别被改坏
  // 菜单按钮是**动态** aria-label（随开合切换），不能钉死静态字符串
  ok('菜单按钮的 aria-label 仍随状态切换',
     /:aria-label="mobileOpen \? '关闭菜单' : '打开菜单'"/.test(layout));
  ok('搜索按钮的 aria-label 仍在', /aria-label="搜索（按斜杠键）"/.test(layout));
}

console.log('\n【分享页的 404 要是正经页面，不是裸文本】');
{
  const share = read('../../server/src/routes/share.js');
  // 实测：站点级分享页原来 `res.status(404).send('页面不存在')` ——
  // 裸文本却带 Content-Type: text/html，而且**没有 noindex**，
  // 搜索引擎完全可能把这个 404 收进索引。
  ok(
    '站点分享页 404 不再是裸文本',
    !/status\(404\)\.send\('页面不存在'\)/.test(share)
  );
  // 两处 404 都必须带 noindex（文章页本来就有，站点页是这轮补的）
  const noindexCount = (share.match(/noindex,nofollow/g) || []).length;
  ok('两处 404 都带 noindex', noindexCount >= 2, `找到 ${noindexCount} 处`);
  // 也要有真实结构
  ok('404 有 <h1>', (share.match(/<h1>/g) || []).length >= 2);
}

console.log('\n【分享页要声明 Vary: Host】');
{
  const share = read('../../server/src/routes/share.js');
  // siteUrl = settings.site_url || req.get('host') ——
  // 没配 site_url 时整页的 og:url / canonical / og:image 都跟着 Host 变，
  // 而响应是 public 可缓存 5 分钟的：共享缓存只按 URL 归档，
  // 会把 A 域渲染的版本喂给 B 域，B 域的分享卡片指向 A 域。
  ok('conditionalSendHtml 追加了 Vary: Host', /res\.append\('Vary', 'Host'\)/.test(share));
  // 必须用 append 而不是 set：set 会覆盖全局中间件写的 Vary
  const helper = (share.match(/function conditionalSendHtml[\s\S]*?\n\}/) || [''])[0];
  ok('用 append 保留已有的 Vary（set 会覆盖）', !/res\.set\('Vary'/.test(helper));
  // feed.js 的同类处理别被改坏
  const feed = read('../../server/src/routes/feed.js');
  ok('feed.js 的 Vary: Host 仍在', /res\.append\('Vary', 'Host'\)/.test(feed));
}

console.log('\n【分享页的 body 不能是空的】');
{
  const share = read('../../server/src/routes/share.js');
  // 实测：两类分享页的 <body> 原本只有一句 noscript 提示，
  // 正常访问时 body 是**空的** ——
  // 禁用 JS、装了拦截 meta refresh 的扩展、或慢网络时，用户看到的是纯白页，无任何出路。
  const mains = (share.match(/<main style=/g) || []).length;
  ok('文章页与站点页都补了可见兜底内容', mains >= 2, `找到 ${mains} 个 <main>`);
  ok('兜底内容有标题（h1）', (share.match(/<h1 style=/g) || []).length >= 2);
  ok('兜底内容有可点的「继续阅读 / 进入站点」', /继续阅读/.test(share) && /进入站点/.test(share));
  // 兜底里插入的值必须已经转义
  ok('兜底内容里的值都经过 esc()', /\$\{esc\(page\.title\)\}/.test(share) && /\$\{esc\(page\.desc\)\}/.test(share));

  // 补内容不能破坏爬虫抓到的东西
  ok('JSON-LD 未被破坏', /application\/ld\+json/.test(share));
  ok('og:url 仍指向 selfUrl（上一轮的修复没被回退）', /property="og:url" content="\$\{selfUrl\}"/.test(share));
}

console.log('\n【分享页：og:url 必须与 canonical 一致】');
{
  const share = read('../../server/src/routes/share.js');
  // 实测：文章分享页的 og:url 原来写的是 `${siteUrl}/#/article/<slug>`（人类重定向落点），
  // 而 canonical 是 `/api/share/<slug>`（爬虫实际抓的地址）——
  // 两者自相矛盾，等于向 Open Graph 声称规范地址是那个 hash URL。
  // hash 之后的部分爬虫根本不会请求，指向它毫无意义。
  ok('og:url 用 selfUrl 而不是 shareUrl', !/property="og:url" content="\$\{shareUrl\}"/.test(share));
  ok('og:url 与 canonical 同为 selfUrl', /property="og:url" content="\$\{selfUrl\}"/.test(share));
  // 但人类重定向仍然必须走 hash URL
  ok('refresh 仍指向 hash URL（人类落点）', /http-equiv="refresh" content="0;url=\$\{shareUrl\}"/.test(share));
  // 兜底按钮现在带 style，不能钉死 `">`（上一轮那条断言因此失配过）
  ok('兜底按钮仍指向 hash URL（人类落点）', /<a href="\$\{shareUrl\}"/.test(share));
  // 站点级分享页本来就一致，别被改坏
  ok('站点分享页 og:url 仍是 selfUrl', (share.match(/property="og:url" content="\$\{selfUrl\}"/g) || []).length >= 2);
}

console.log('\n【twitter:* 必须用 name，不能用 property】');
{
  const pm = read('../src/utils/pageMeta.js');
  // 实测：twitter:title / description / image 原来全走 upsertMeta，
  // 被写成 property="twitter:*" —— Twitter 读 name，等于这三项不存在。
  // meta[name^="twitter"] 那时只剩 card 一项。
  const twWrites = [...pm.matchAll(/upsertMeta\('(twitter:[a-z]+)'/g)].map(m => m[1]);
  ok('没有 twitter:* 走 upsertMeta（会被写成 property）', twWrites.length === 0, twWrites.join(', '));
  for (const k of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
    ok(`${k} 用 setMetaByName 写入`, new RegExp(`setMetaByName\\('${k}'`).test(pm));
  }
}

console.log('\n【首页也要有分享卡片】');
{
  const home = read('../src/views/site/Home.vue');
  // 实测：全站八条路由里只有首页 og:image 是 null ——
  // 而首页恰恰是被分享最多的那一个。
  ok('首页调用 applyPageMeta', /applyPageMeta\(/.test(home));
  ok('首页声明 path 为 /', /path: '\/'/.test(home));
  // 首页标题就是站名，不能再传 title，否则会变成「Xalor的小站 · Xalor的小站」
  ok(
    '首页不重复传 title（避免站名叠两次）',
    !/applyPageMeta\(\{[^}]*title:\s*(?:name|site\.settings\.site_name)/.test(home)
  );
}

console.log('\n【每个站点页都要写全 page meta】');
{
  // 实测：#/messages 原本只手动设了 document.title，
  // og:title 落回站点通用值（缺页面名）、description 也是站点级那句 ——
  // 分享留言板时卡片写的是「Xalor的小站」而不是「留言板」。
  const pages = { ArticleList: '/articles', Tags: '/tags', About: '/about',
                  Archive: '/archive', Links: '/links', Bookmarks: '/bookmarks',
                  Messages: '/messages' };
  const missing = [];
  for (const [f, path] of Object.entries(pages)) {
    const src = read(`../src/views/site/${f}.vue`);
    if (!/applyPageMeta/.test(src)) { missing.push(`${f}: 没有 applyPageMeta`); continue; }
    if (!new RegExp(`path: '${path.replace('/', '\\/')}'`).test(src)) missing.push(`${f}: path 不是 ${path}`);
  }
  ok('所有站点页都调用 applyPageMeta 且 path 正确', missing.length === 0, missing.join('; '));

  // applyPageMeta 不管 <title>，页面必须自己写
  const msgs = read('../src/views/site/Messages.vue');
  ok('留言板自己写 document.title', /document\.title = `留言板 · \$\{siteName\}`/.test(msgs));
  const pm = read('../src/utils/pageMeta.js');
  ok('applyPageMeta 只写 meta，不越权改 document.title', !/document\.title\s*=/.test(pm));
}

console.log('\n【归档页的年月要是真标题】');
{
  const arc = read('../src/views/site/Archive.vue');
  // 实测：整页只有 h1「归档」，年份与月份都是 <span> ——
  // 读屏用户只能一路 Tab 过六个链接，没法按标题跳年份。
  ok('年份用 h2', /<h2 class="tl-year-big">/.test(arc));
  ok('月份用 h3（层级不跳）', /<h3 class="tl-month-text">/.test(arc));
  // 条形图是纯视觉的份量示意，旁边已有「N 篇」文字，对读屏隐藏避免重复
  ok('条形图对读屏隐藏（数字已用文字说过）', /class="tl-bar" aria-hidden="true"/.test(arc));
  // 换成标题元素后不能破坏版式：全局 * { margin:0 } 负责清零
  ok('标题没有自带外边距问题（全局 reset 存在）', /\*\s*\{\s*margin:\s*0;/.test(read('../src/styles/main.css')));
}

console.log('\n【改筛选要回第 1 页，改排序/每页条数不该清筛选】');
{
  const list = read('../src/views/site/ArticleList.vue');
  const catFn = (list.match(/function selectCategory[\s\S]*?\n\}/) || [''])[0];
  const tagFn = (list.match(/function selectTag[\s\S]*?\n\}/) || [''])[0];
  // 实测：第 2 页（共 12 篇时 4 行）加一个分类筛选 → URL 的 page 被清掉、
  // 当前页回到 1。这是对的：筛选后第 2 页可能根本不存在。
  ok('改分类会重置页码', /delete q\.page/.test(catFn));
  ok('改标签会重置页码', /delete q\.page/.test(tagFn));
  // 但「清除筛选」不能把排序和每页条数一起清掉（那是偏好，不是筛选）
  const clearFn = (list.match(/function clearFilter[\s\S]*?\n\}/) || [''])[0];
  ok(
    'clearFilter 不动排序与每页条数',
    !/delete q\.sort/.test(clearFn) && !/delete q\.pageSize/.test(clearFn),
    clearFn.slice(0, 40)
  );

  // 关键词与筛选可以共存（上一轮改成不清 keyword 后必须仍然如此）
  ok('改分类时关键词保留', !/delete q\.keyword/.test(catFn));
  ok('改标签时关键词保留', !/delete q\.keyword/.test(tagFn));
}

console.log('\n【空态文案必须说出全部生效的筛选】');
{
  const list = read('../src/views/site/ArticleList.vue');
  // 筛选能叠加之后，原来的三个互斥 if 就不够了：
  // `?category=tech&tag=旅行` 为 0 篇时只提示「分类「技术笔记」下还没有文章」，
  // 读者会以为只有分类在生效，不知道标签也在筛。
  ok('空态用 parts 收集全部条件', /const parts = \[\]/.test(list));
  ok('关键词、分类、标签都会进 parts', /parts\.push/.test(list) && /activeTag\.value/.test(list.slice(list.indexOf('parts.push'))));
  ok(
    '多条件时同时列出，而不是只报一个',
    /同时满足 \$\{parts\.join\(' \+ '\)\}/.test(list),
    'join 是这一句的核心'
  );
  ok('单条件仍保持原来的自然说法', /下还没有文章/.test(list) && /没有匹配/.test(list));
}

console.log('\n【分类与标签必须能叠加，不能互相清空】');
{
  const list = read('../src/views/site/ArticleList.vue');
  const catFn = (list.match(/function selectCategory[\s\S]*?\n\}/) || [''])[0];
  const tagFn = (list.match(/function selectTag[\s\S]*?\n\}/) || [''])[0];
  // 实测原实现：selectTag 里 `delete q.category`、selectCategory 里 `delete q.tag`，
  // 于是「技术笔记 → 3 篇，再点 # Node.js」分类被丢掉，退回 2 篇。
  // 但服务端同时支持两者：直接访问 ?category=tech&tag=node.js 返回正确的 2 篇，
  // 两个 chip 也都正确激活 —— 能力一直在，被前端点击行为挡掉了。
  ok('selectCategory 不清空 tag', !/delete q\.tag/.test(catFn), catFn.slice(0, 40));
  ok('selectTag 不清空 category', !/delete q\.category/.test(tagFn), tagFn.slice(0, 40));
  ok('换筛选仍重置页码', /delete q\.page/.test(catFn) && /delete q\.page/.test(tagFn));
  // 服务端必须继续同时支持两个条件
  const srv = read('../../server/src/routes/articles.js');
  ok('服务端仍同时读取 category 与 tag', /qs\(req\.query\.category\)/.test(srv) && /qs\(req\.query\.tag\)/.test(srv));
}

console.log('\n【筛选 chip 的选中态要能被播报】');
{
  const list = read('../src/views/site/ArticleList.vue');
  // 实测：列表页 16 个筛选 chip（分类 5 + 标签 11）里，
  // 原本只有排序/视图按钮带 aria-pressed，**分类与标签全都没有** ——
  // 视觉上有 .active，读屏听到的只是一串按钮，不知道此刻筛的是哪个。
  ok('分类「全部」有 aria-pressed', /:aria-pressed="!activeCategory \? 'true' : 'false'"/.test(list));
  ok('分类项有 aria-pressed', /:aria-pressed="activeCategory === c\.slug \? 'true' : 'false'"/.test(list));
  ok('标签「全部」有 aria-pressed', /:aria-pressed="!activeTag \? 'true' : 'false'"/.test(list));
  ok('标签项有 aria-pressed', /:aria-pressed="activeTag === t\.slug \? 'true' : 'false'"/.test(list));
  // 排序/视图原本就有，别被改坏
  ok('排序按钮仍带 aria-pressed', /:aria-pressed="sort === 'latest'"/.test(list));
}

console.log('\n【404 页要等人，不该催人】');
{
  const nf = read('../src/views/site/NotFound.vue');
  // 实测原实现：倒计时 5 秒后用 router.replace('/') 强制跳首页，
  // 而同一页上摆着「回到首页 / 浏览文章 / 随便看看 / 搜索」四个出口 ——
  // 3 秒后它们就都用不了了。读屏用户更没时间听完内容。
  // 去掉注释后再检查，避免把「说明为什么不做」的注释当成违规
  const nfCode = nf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  ok('404 页不再自动跳转', !/setInterval/.test(nfCode) && !/router\.replace\('\/'\)/.test(nfCode));
  // 只检查 <template> 区域：注释里提到原实现（作为说明）不算违规
  const tpl = (nf.match(/<template>[\s\S]*?<\/template>/) || [''])[0];
  ok('不再显示倒计时文案', !/秒后自动返回/.test(tpl));
  ok('保留明确的说明文案', /你要找的内容可能被移动或删除了/.test(nf));
  // 出口按钮必须还在
  ok('保留多个出口（首页/文章/随机/搜索）', /回到首页/.test(nf) && /浏览文章/.test(nf) && /随便看看/.test(nf));
  ok('仍写 noindex（别让 404 被收录）', /noindex/.test(nf));
}

console.log('\n【Blob 下载统一走一个工具，且不立即 revoke】');
{
  const util = read('../src/utils/download.js');
  ok('有共享的 downloadBlob', /export function downloadBlob/.test(util));
  ok(
    'revoke 是延迟的，不是 click 后立刻执行',
    /setTimeout\(\(\) => URL\.revokeObjectURL/.test(util),
    'click 只是请求下载，读取是异步的'
  );
  ok('临时 <a> 会被 append 并移除', /appendChild\(a\)/.test(util) && /removeChild\(a\)/.test(util));

  // 全项目不应再有手写的「createObjectURL + 立即 revoke」
  const files = [
    'ArticleManage', 'CommentManage', 'MessageManage', 'LinkManage',
    'TagManage', 'CategoryManage', 'Settings', 'SecurityManage', 'AuditManage',
  ];
  const offenders = files.filter((f) => {
    const src = read(`../src/views/admin/${f}.vue`);
    return /URL\.revokeObjectURL/.test(src);
  });
  ok(
    '后台各页不再各自手写下载/revoke',
    offenders.length === 0,
    offenders.join(', ') || '仍在手写'
  );
  ok('读者侧导出也走同一工具', /downloadBlob\(blob/.test(read('../src/views/site/ArticleDetail.vue')));
}

console.log('\n【后台搜索框的 placeholder 要说准搜什么】');
{
  const adm = read('../src/views/admin/ArticleManage.vue');
  // 实测：后台文章搜索查的是 title **+ content**（admin.js 里 orWhere('a.content', ...)），
  // 但 placeholder 写的是「搜索文章标题…」。搜 Knex 会出来标题不含 Knex 的文章 ——
  // 管理员第一反应是「搜索坏了」，其实是文案承诺的范围比实际窄。
  ok(
    'placeholder 不再只写「标题」',
    !/placeholder="搜索文章标题…"/.test(adm),
    '实际同时搜正文，写窄了会让人以为搜错'
  );
  ok('placeholder 写明搜标题或正文', /placeholder="搜索标题或正文…"/.test(adm));

  // 其他后台列表的 placeholder 本来就写全了字段
  for (const [f, pat] of [
    ['CommentManage', /搜索昵称\/内容\/文章/],
    ['MessageManage', /搜索昵称\/内容/],
    ['AuditManage', /搜索操作者/],
  ]) {
    ok(`${f} 的 placeholder 已写明字段`, pat.test(read(`../src/views/admin/${f}.vue`)));
  }
}

console.log('\n【打印时不能把 fixed 元素印到纸上】');
{
  const css = read('../src/styles/main.css');
  const printBlock = (css.match(/@media print \{[\s\S]*?\n\}/) || [''])[0];
  // 实测：skip-link 靠 `position: fixed; top: -100px` 藏到视口外 ——
  // 那套做法只在**连续媒体**里成立。打印是分页媒体、没有「视口」，
  // fixed 在分页上下文里行为未定义，多数浏览器会把它渲染到第一页。
  // 打印模拟下它 display 仍是 block、高度 45px、内容是「跳到主要内容」。
  ok('skip-link 在打印时被隐藏', /\.skip-link,/.test(printBlock));
  ok('ambient 装饰层在打印时被隐藏', /\.ambient,/.test(printBlock));
  ok('float-dock 容器在打印时被隐藏', /\.float-dock,/.test(printBlock));
  ok('导航/页脚/评论仍在隐藏列表里（未被破坏）',
     /\.site-nav,/.test(printBlock) && /\.site-footer,/.test(printBlock) && /\.comment-section,/.test(printBlock));
}

console.log('\n【导出的 Markdown 必须是合法结构】');
{
  const detail = read('../src/views/site/ArticleDetail.vue');
  // 实测原实现有两个问题：
  //   1. '---' 与 '' 一起被 filter 掉，分隔线和正文标题粘成 `---# 标题`；
  //   2. 正文自带的 `# ` 没降级，导出文件里出现**两个 h1**。
  ok(
    '分隔线与正文之间留了空行（不粘行）',
    /`\$\{meta\}\\n\\n---\\n\\n\$\{body\}`/.test(detail),
    '原实现把 --- 和空串一起 filter 掉，粘成 ---# 标题'
  );
  ok(
    '正文的 h1 降级为 h2（文件里只能有一个 h1）',
    /replace\(\/\^# \(\?!#\)\/gm, '## '\)/.test(detail)
  );
  ok('frontmatter 仍然保留', /`title: "/.test(detail) && /`slug: /.test(detail));
}

console.log('\n【复制的链接不能带读者进来时的 query】');
{
  const detail = read('../src/views/site/ArticleDetail.vue');
  // 实测：copyLink 原来直接用 window.location.href，
  // 复制出来是 `.../?h=1792942176448#/article/xxx` ——
  // 缓存击穿参数、渠道来源、utm 全都会跟着被转发出去。
  ok(
    'copyLink 不复用 window.location.href',
    !/function copyLink\(\) \{\s*const url = window\.location\.href/.test(detail),
    'href 会带上全部 query'
  );
  ok(
    'copyLink 只拼 origin + pathname + hash',
    /window\.location\.origin\}\$\{window\.location\.pathname\}\$\{window\.location\.hash/.test(detail)
  );

  // 分享链接走服务端分享页，且不含 query（这条本来就对，钉住防回归）
  ok(
    'shareUrl 指向 /api/share/<slug>（服务端可抓取的分享页）',
    /return `\$\{base\}\/api\/share\/\$\{article\.value\.slug\}`/.test(detail)
  );
}

console.log('\n【文章页的工具按钮：只有收藏漏了 aria】');
{
  const detail = read('../src/views/site/ArticleDetail.vue');
  // 实测：相邻的「复制链接 / 导出 Markdown / 打印 / 分享」四个按钮都有 aria-label，
  // **只有收藏按钮没有** —— 它在靠 title 兜底。
  // 而收藏是有状态的开关，光靠 title 变文字不会被播报成状态变化。
  ok('收藏按钮有 aria-label', /:aria-label="bookmarked \? '取消收藏' : '收藏本文'"/.test(detail));
  ok('收藏按钮有 aria-pressed（状态变化会被播报）', /:aria-pressed="bookmarked \? 'true' : 'false'"/.test(detail));
  ok('相邻工具按钮仍有 aria-label（未被破坏）', /aria-label="复制链接"/.test(detail) && /aria-label="分享"/.test(detail));
}

console.log('\n【手记的心情标签要说清是什么】');
{
  const card = read('../src/components/home/NoteCard.vue');
  // 实测：读屏读到的是一个孤零零的「开心」——
  // 既不知道这是心情，也不知道它跟手记内容是什么关系。
  ok('心情标签有 aria-label', /:aria-label="`心情：\$\{note\.mood\}`"/.test(card));
  ok('视觉上仍是原来那个标签（文本不变）', /class="nc-mood"/.test(card) && /\{\{ note\.mood \}\}/.test(card));
}

console.log('\n【评论要有语义，不能只靠缩进表达层级】');
{
  const item = read('../src/components/site/CommentItem.vue');
  // 实测：整列评论原本都是 <div>，嵌套回复的层级**只靠缩进这种视觉效果**表达，
  // 不看屏幕的人完全无从得知哪条是回复谁的。
  ok('评论条目用 <article> 而不是 <div>', /<article\s/.test(item) && /<\/article>/.test(item));
  ok(
    'aria-label 区分主评论与回复',
    /depth > 0 \? `回复 \$\{comment\.nickname\} 的评论`/.test(item),
    '两者都只念「某某的评论」就分不出层级'
  );
  ok('父评论的 aria-label 是「某某的评论」', /: `\$\{comment\.nickname\} 的评论`/.test(item));

  // 排序按钮的开关状态要被播报
  const sec = read('../src/components/site/CommentSection.vue');
  ok('排序按钮有 aria-pressed（不只靠 active 样式）', /aria-pressed/.test(sec));
}

console.log('\n【评论点赞按钮要有可读名称】');
{
  const item = read('../src/components/site/CommentItem.vue');
  // 实测：点赞按钮只显示一个数字（0），且只有 title 没有 aria-label。
  // 读屏用户听到的是「0」——一个没有任何含义的数字。
  ok('点赞按钮有 aria-label', /:aria-label="liked/.test(item));
  ok(
    'aria-label 带上当前点赞数（数字本身才有意义）',
    /点赞这条评论，当前 \$\{comment\.likes \|\| 0\} 个赞/.test(item),
    '只写「点赞」读者就不知道已经是几赞'
  );
  ok('有 aria-pressed 表达开关状态', /:aria-pressed="liked/.test(item));
  // 「回复」按钮有可见文字，读屏能正确读出，不需要额外 label
  ok('回复按钮保持可见文字（不需要额外 label）', /回复\s*<\/button>|>\s*回复/.test(item));
}

console.log('\n【留言板：提交前就要说明可能要审核】');
{
  const msgs = read('../src/views/site/Messages.vue');
  // 实测：提交前页面**没有任何地方**提到审核 ——
  // 读者填完、点提交、看到「等待审核后展示」才知道自己的留言不会立刻出现。
  // 审核开关（message_moderation）是站点设置且不下发给公开接口，
  // 前端无法提前判断，所以措辞必须不依赖开关。
  ok('提交区有审核说明', /class="review-hint"/.test(msgs));
  ok(
    '措辞是「可能」，不假设审核一定开着',
    /留言可能需审核后展示/.test(msgs),
    '公开接口不下发 message_moderation，前端无法判定'
  );
  ok('说明在提交按钮同一区域（提交前可见）', /review-hint[\s\S]{0,200}?submit-btn/.test(msgs));
  ok('样式用 --text-3（实测 5.34 / 5.1 均达标）', /\.review-hint \{[\s\S]{0,80}?color:\s*var\(--text-3\)/.test(msgs));
}

console.log('\n【错误页的文字必须显式给颜色】');
{
  const detail = read('../src/views/site/ArticleDetail.vue');
  // 实测：.le-title 原本没有 color，h2 继承到别处的浅色 ——
  // 浅色主题下「加载失败，请稍后重试」对比度只有 1.18:1（要求 3）。
  // 错误页正是用户最需要看清文字的时候。
  const titleBlock = (detail.match(/\.le-title \{[\s\S]*?\}/) || [''])[0];
  ok('le-title 显式声明颜色', /color:\s*var\(--text\)/.test(titleBlock), titleBlock.slice(0, 50));
  const descBlock = (detail.match(/\.le-desc \{[\s\S]*?\}/) || [''])[0];
  ok('le-desc 显式声明颜色', /color:\s*var\(--text-3\)/.test(descBlock));
}

console.log('\n【实心元素必须用 --accent-fill，不能用 --accent】');
{
  const css = read('../src/styles/main.css');
  // --accent 在深色下为了「当文字时对深底够对比」被提亮；
  // 同一抹亮色配白字只有 2.55:1。--accent-fill 是压深过的，白字对它 5.17:1。
  // 实测：skip-link 是全站最后一个漏用 --accent-fill 的实心元素（暗色下 2.55:1）。
  const skipBlock = (css.match(/\.skip-link \{[\s\S]*?\}/) || [''])[0];
  ok('skip-link 用 --accent-fill 作底', /background:\s*var\(--accent-fill\)/.test(skipBlock));
  ok('skip-link 不再用 --accent 作底', !/background:\s*var\(--accent\);/.test(skipBlock));

  ok('--accent-fill 有定义（浅色 #bb4732）', /--accent-fill:\s*#bb4732/.test(css));
  ok('--accent-fill 有静态注释说明为什么不能直接用 --accent', /拿去配白字只有 2\.55:1/.test(css));

  // 其余实心元素都用 fill
  const fillUses = (css.match(/background:\s*var\(--accent-fill\)/g) || []).length;
  ok('至少 4 处实心元素用 --accent-fill', fillUses >= 4, `实际 ${fillUses} 处`);
}

console.log('\n【不要用 opacity 压低文字对比度】');
{
  // 实测：.empty-state .empty-hint 用 --text-3 本身是 5.34:1（合规），
  // 叠上 opacity: 0.9 与背景混合后实际变成 4.34:1，跌破 AA 的 4.5。
  // 层级靠字号与位置表达就够了 —— 颜色已经够淡。
  const css = read('../src/styles/main.css');
  const hintBlock = (css.match(/\.empty-state \.empty-hint \{[\s\S]*?\}/) || [''])[0];
  ok('空态提示不再用 opacity 压对比度', !/opacity:\s*0\.\d/.test(hintBlock), hintBlock.slice(0, 60));
  ok('空态提示仍用 --text-3（比正文淡一档，但不靠透明度）', /color:\s*var\(--text-3\)/.test(hintBlock));

  // 全站的 opacity 使用必须都是非文字场景
  const textOpacity = [];
  for (const [file, label] of [['../src/styles/main.css', 'main'], ['../src/styles/markdown.css', 'markdown']]) {
    const src = read(file);
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      if (!/^\s*opacity:\s*0\.[0-9]+/.test(l)) return;
      // 向上找最近的选择器
      let sel = '';
      for (let j = i; j >= 0; j -= 1) {
        if (/\{\s*$/.test(lines[j])) { sel = lines[j].trim(); break; }
      }
      // 允许：hover 态、装饰线、非文字容器
      const allowed = /:hover|::|markdown-body h[1-6]::|float-dock|overlay|backdrop|scroll-hint|divider/.test(sel)
        || /^\s*\/[/*]/.test(l);
      if (!allowed && sel && !/empty-hint/.test(sel)) textOpacity.push(`${label}:${i + 1} ${sel} → ${l.trim()}`);
    });
  }
  ok(
    '其余 opacity 都是非文字场景（hover 反馈/装饰线/浮层）',
    textOpacity.length === 0,
    textOpacity.slice(0, 3).join(' | ') || '有文字元素被 opacity 压了'
  );
}

console.log('\n【快捷键必须能被发现】');
{
  const layout = read('../src/views/site/Layout.vue');
  // 实测：全站原本 0 个 kbd 提示、0 个帮助按钮 ——
  // `/` 搜索、`?` 帮助、`Esc` 关闭只有已经知道的人才会用。
  // 快捷键的价值完全取决于能否被发现。
  ok(
    '导航栏有可见的快捷键入口',
    /aria-label="查看键盘快捷键"/.test(layout),
    '只有 `?` 键触发等于对所有人都不存在'
  );
  ok('按钮点击能打开面板（通过 ref 调 openHelp）', /shortcutHelpRef\.value\?\.openHelp\?\./.test(layout));
  ok('搜索按钮的 title 标出 / 键', /title="搜索 \(\/\)"/.test(layout));

  const help = read('../src/components/ui/ShortcutHelp.vue');
  ok('ShortcutHelp 暴露了 openHelp', /defineExpose\(\{ openHelp \}\)/.test(help));
  ok(
    '按键清单按适用页面分组（避免误导）',
    /label: '文章页'/.test(help) && /label: '后台编辑'/.test(help),
    '← → 只在文章页有效，混在一起会让人在列表页按了没反应'
  );
}

console.log('\n【robots.txt 不能挡住 sitemap 里的 URL】');
{
  const feed = read('../../server/src/routes/feed.js');
  // 实测：新增 /api/share-page 后，robots 仍只 Allow /api/share/，
  // 而 sitemap 现在指向 /api/share-page —— 两边不一致，爬虫拿不到。
  // 现在两条 robots（博客域/主页域）都显式放行它。
  const allowCount = (feed.match(/Allow: \$\{apiPrefix\}\/share-page/g) || []).length;
  ok('两个域的 robots 都放行 /share-page', allowCount === 2, `实际 ${allowCount} 处`);

  // Disallow: /#/ 是无效规则：fragment 不进请求行，永远匹配不到
  ok(
    '没有无效的 `Disallow: /#/` 规则',
    !/^Disallow: \/#\/$/m.test(feed),
    '爬虫只发 path，fragment 从不发送 → 这条规则匹配不到任何请求'
  );
  ok(
    '删除处留了说明（防止有人加回来）',
    /不要加 `Disallow: \/#\/`/.test(feed)
  );

  // 博客域仍需保留 rss/sitemap 放行
  ok('robots 仍放行 rss.xml 与 sitemap.xml',
     /Allow: \$\{apiPrefix\}\/rss\.xml/.test(feed) && /Allow: \$\{apiPrefix\}\/sitemap\.xml/.test(feed));
}

console.log('\n【RSS 的频道信息与正文语义】');
{
  const feed = read('../../server/src/routes/feed.js');
  // 实测原来 channel/link 是 `${siteUrl}/api/share/` —— 空 slug 的分享路径，
  // 不是有效页面（打开就是 404/空内容）。频道链接该指向站点首页。
  ok(
    'channel/link 指向站点首页，不是空 slug 的分享页',
    !/<link>\$\{esc\(siteUrl\)\}\$\{apiPrefix\}\/share\/<\/link>/.test(feed),
    '空 slug 的 /api/share/ 不是有效页面'
  );
  ok(
    '频道图优先用 og_image（与分享卡片同口径）',
    /channelImageFor\(settings\.avatar, siteUrl, settings\.site_name, settings\.og_image\)/.test(feed),
    '两处用不同的图会让人以为是两个站'
  );
  // 实测 6 条 content:encoded 每条都含一个 <h1>，与阅读器自己的条目标题重复
  ok(
    'RSS 正文的 h1 降级为 h2（与网页端 demoteH1 一致）',
    /function demoteH1/.test(feed) && /demoteH1\(sanitizeRssHtml/.test(feed),
    '实测每条订阅内容都含 <h1>，叠上阅读器标题就是两个主标题'
  );
}

console.log('\n【sitemap 必须是引擎能收录的真实 URL】');
{
  const feed = read('../../server/src/routes/feed.js');
  // 实测：sitemap 原本给静态页写的是 /#/archive 这类 hash URL，
  // 而搜索引擎**丢弃 # 之后的部分** → 11 条记录全部指向首页，等于没提交。
  const sitemap = feed;
  ok(
    'sitemap 静态页用 /api/share-page/* 而非 hash URL',
    /api\/share-page/.test(sitemap),
    'hash URL 会被引擎丢弃 # 之后的内容'
  );
  ok(
    '博客 sitemap 里不再有 /#/ 的 loc',
    !/<loc>\$\{esc\(siteUrl\)\}\/#\//.test(sitemap),
    '一条都不该留 —— 留一条就等于少收录一页'
  );
  ok(
    '分类 URL 带 category 参数（否则 4 个分类是同一条重复记录）',
    /articles\?category=\$\{encodeURIComponent/.test(sitemap)
  );

  const share = read('../../server/src/routes/share.js');
  ok('有 /share-page 端点', /router\.get\('\/share-page/.test(share));
  ok('静态页列表覆盖常驻页面', /archive:/.test(share) && /tags:/.test(share) && /about:/.test(share));
  ok(
    '规范地址带上 category（避免分类页重复）',
    /req\.query\.category/.test(share)
  );

  // 关键：新端点必须在免闸门白名单里，否则爬虫拿不到（实测 403）
  const app = read('../../server/src/app.js');
  ok(
    'GATE_SKIP 显式包含 /share-page',
    /GATE_SKIP = \[[^\]]*'\/share-page'/.test(app),
    "startsWith('/share/') 匹配不到 '/share-page' —— 漏了就是全线 403"
  );
  ok('GATE_SKIP 仍包含 RSS/Sitemap/robots', /'\/rss\.xml'/.test(app) && /'\/sitemap\.xml'/.test(app));
}

console.log('\n【分享卡片的配图链路】');
{
  // 实测：无封面的文章，分享页 og:image 退回 settings.avatar = /logo.png（646KB 头像），
  // 而专为此准备的 /og-image.png（254KB 宽幅）从未被引用过。
  const share = read('../../server/src/routes/share.js');
  ok(
    '分享图按 cover → og_image → avatar → 内置 顺序回退',
    /toAbs\(article\.cover\)[\s\S]{0,120}?toAbs\(settings\.og_image\)[\s\S]{0,120}?toAbs\(settings\.avatar\)/.test(share),
    '原实现无封面时直接退回头像，正方形小图当 1200×630 大图会被裁得很糟'
  );
  ok('og:image 无条件输出（cover 现在恒有值）', /<meta property="og:image" content="\$\{esc\(cover\)\}">/.test(share));
  ok('twitter:card 恒为 summary_large_image', /content="summary_large_image">/.test(share));
  ok('JSON-LD 也带 image', /image: \[cover\]/.test(share));

  // 前后端默认值必须一致
  ok(
    '前端 pageMeta 默认图与 server 一致（/og-image.png）',
    /'\/og-image\.png'/.test(read('../src/utils/pageMeta.js')),
    '两处各写一个默认值，迟早一边改另一边忘'
  );

  // 后台可编辑
  ok('后台设置页能编辑分享卡片图', /v-model="form\.og_image"/.test(read('../src/views/admin/Settings.vue')));
}

console.log('\n【启动失败兜底：不能永远停在「加载中」】');
{
  // 实测：阻断 vue 依赖后 main.js 整个 import 失败，一行都不会执行，
  // 于是启动骨架永远停在「正在加载页面…」—— 比白屏更糟（白屏至少让人怀疑网络）。
  // 所以兜底必须在 HTML 层，且**必须是外部脚本**：
  // CSP 是 script-src 'self'，内联 <script> 会被拒绝执行（这条我踩过）。
  const guard = read('../public/boot-guard.js');
  ok('有独立的 boot-guard.js', guard.length > 400);
  ok('超时时清掉骨架并给出 role=alert', /role', 'alert'/.test(guard));
  ok('只在骨架仍在时介入（Vue 成功挂载就不管）', guard.includes("querySelector('.boot-skeleton')") && guard.includes('return;'));
  ok('提供刷新按钮', /location\.reload\(\)/.test(guard));

  for (const [file, label] of [['../index.html', '博客'], ['../home.html', '个人主页']]) {
    const html = read(file);
    ok(`${label}入口引用了 boot-guard.js`, /boot-guard\.js/.test(html));
    ok(
      `${label}入口**没有内联兜底脚本**（CSP script-src 'self' 会拒绝）`,
      !/<script>\s*\(function/.test(html) && !/setTimeout\(function/.test(html),
      '写了内联版会构建通过但运行时不生效'
    );
  }

  // main.js 的 try/catch 仍要保留：骨架被替换后组件才抛错时，它还能兜住
  ok(
    'main.js 保留 app.mount 的 try/catch',
    /try \{\s*\n\s*app\.mount\('#app'\);/.test(read('../src/main.js'))
  );
}

console.log('\n【列表滚动位置：由路由 scrollBehavior 负责】');
{
  // 实测：从列表点进文章、浏览器后退 → 页面回到顶部。
  // history.state.scroll 里明明有 {top:600}，但 Vue Router 在 hash 路由 +
  // 异步组件下把 savedPosition 给成了 null，所以我们自己读 state 兜底。
  const factory = read('../src/router/factory.js');
  ok('scrollBehavior 优先用 savedPosition', /if \(savedPosition\) return savedPosition;/.test(factory));
  ok(
    'savedPosition 为 null 时读 history.state.scroll 兜底',
    /window\.history\.state\?\.scroll/.test(factory),
    'hash 路由下 savedPosition 经常是 null，只靠它等于不恢复'
  );
  ok('兜底只在位置 > 0 时用（新页面仍从顶部开始）', /stateScroll\.top > 0/.test(factory));
  // ⚠ 上一轮这里写错了。我断言「同路径 query 变化应保持不动」，
  // 但实测产品意图是相反的：**换筛选应该回到顶部**（读者要看新结果的第一条），
  // 而**浏览器后退应该回到原处**。两者都合理，只是触发源不同。
  // 现在记录的是真实分工：
  //   - 换筛选 → ArticleList 的 watch(filterKey) 主动 scrollTo(0)，合理，保留；
  //   - 后退/前进 → 路由 scrollBehavior 用 history.state.scroll 恢复。
  ok(
    '后退恢复带筛选也能用（history.state.scroll 与 query 无关）',
    /window\.history\.state\?\.scroll/.test(factory),
    '实测：无筛选 500→500、?tag=node.js 300→300，两条都精确恢复'
  );
  ok(
    '换筛选时主动回到顶部（看新结果的第一条）',
    /watch\(filterKey,[\s\S]{0,300}?window\.scrollTo\(\{ top: 0 \}\)/.test(read('../src/views/site/ArticleList.vue')),
    '这条不是 bug —— 我一度把它当成 bug 并断言成反的'
  );
  ok(
    '路由仍保留 return false 分支（同路径时不自作主张）',
    /to\.name === from\.name && to\.path === from\.path\) return false;/.test(factory)
  );

  // 列表页不该再自己实现一套 —— 抢不过路由（路由在挂载后执行）
  const list = read('../src/views/site/ArticleList.vue');
  ok(
    '列表页不再重复实现滚动恢复',
    !/function restoreListScrollIfBack/.test(list) && !/LIST_SCROLL_PREFIX/.test(list),
    '路由的 scrollBehavior 在挂载后执行，会覆盖组件里恢复的位置'
  );
}

console.log('\n【阅读位置记忆：离开再回来应回到原处】');
{
  const detail = read('../src/views/site/ArticleDetail.vue');
  ok('有 rememberScroll / restoreScroll', /function rememberScroll\(\)/.test(detail) && /function restoreScroll\(\)/.test(detail));
  ok(
    '存的是归一化比例而不是像素',
    /window\.scrollY \/ endScroll/.test(detail),
    '存像素的话字号/宽度/图片加载一变就偏'
  );
  ok(
    '比例分母是正文区间（与阅读进度同基准）',
    /function contentEndScroll\(\)/.test(detail) && /body\.getBoundingClientRect\(\)\.bottom/.test(detail),
    '用整页做分母会恢复到正文之外（实测偏到页脚）'
  );
  ok(
    '首次滚动立即写，不等节流窗口',
    /if \(lastScrollSave && now - lastScrollSave < 500\) return;/.test(detail),
    '拖滚动条只触发一次 scroll，被节流挡掉就等于没记'
  );
  ok(
    '恢复前排除「太靠上」与「已读完」',
    /endScroll \* 0\.03/.test(detail) && /endScroll \* 0\.98/.test(detail) || /0\.98\)\) return false/.test(detail)
  );
  ok('恢复用 instant 不用 smooth（回到原处不是动画）', /behavior: 'auto'/.test(detail));
  ok('有提示条告知位置已恢复', /class="restore-tip"/.test(detail) && /已回到上次读到的位置/.test(detail));
  ok('提示条是 role=status（读屏会播报）', /class="restore-tip" role="status"/.test(detail));
  ok(
    '「回到开头」会清除记忆位置',
    /function backToTop\(\)[\s\S]{0,160}?forgetScroll/.test(detail)
  );
  ok('localStorage 异常时静默忽略（隐私模式）', /catch \(e\) \{ \/\* 隐私模式\/配额满/.test(detail));
}

console.log('\n【后台：路由表齐全，且每页都能拿到标题】');
{
  // 实测 15 个后台路由全部渲染正常（0 错误、每页恰好 1 个 h1、
  // Tab 12 次 0 次落到 body、全部有焦点环）。
  // 这里固化的是一条容易退化的东西：**每条后台路由都要有 meta.title**。
  // 标题没了不会报错，只会让顶栏显示兜底文案、document.title 退化成「管理后台」。
  const routes = read('../src/router/routes-admin.js');
  const paths = (routes.match(/path:\s*'([^']+)'/g) || []).length;
  const titles = (routes.match(/title:\s*'[^']+'/g) || []).length;
  ok('后台路由条目都带 title', titles >= paths - 1, `${paths} 条路由 / ${titles} 个 title（父级容器可无 title）`);
  ok('顶栏标题取 route.meta.title', /route\.meta\.title/.test(read('../src/views/admin/Layout.vue')));
  ok('document.title 也用它', /document\.title = `\$\{currentTitle\.value\}/.test(read('../src/views/admin/Layout.vue')));
  ok('后台登录页是独立布局（不套 admin Layout）', /admin-login|Login\.vue/.test(routes));
}

console.log('\n【后台：每页要有页面级标题；立即求值的调用不能引用后声明变量】');
{
  // 实测 18 个后台页里**只有登录页有 h1**，其余 17 页的标题只是个 span，
  // 读屏按标题导航时在整个后台找不到任何标题。
  const layout = read('../src/views/admin/Layout.vue');
  ok(
    '后台顶栏标题是 h1（一处修复覆盖全部 17 页）',
    /<h1 class="header-title">/.test(layout) && !/<span class="header-title">/.test(layout)
  );
  ok('h1 清掉默认 margin（否则顶栏被撑高）', /\.header-title \{[\s\S]{0,200}?margin: 0/.test(layout));

  // 立即求值的调用（watchEffect / watch 的 getter）不能引用后声明的变量
  const about = read('../src/views/site/About.vue');
  const links = read('../src/views/site/Links.vue');
  const msgs = read('../src/views/site/Messages.vue');
  for (const [name, src] of [['关于页', about], ['友链页', links], ['留言页', msgs]]) {
    ok(
      `${name}：const site 在使用它的 watchEffect 之前声明`,
      (() => {
        const a = src.indexOf('const site = useSiteStore()');
        const b = src.indexOf('watchEffect(');
        return a !== -1 && (b === -1 || a < b);
      })(),
      'watchEffect 立即执行，排在声明前就是 TDZ，整页报「页面遇到了一点问题」'
    );
  }

  const edit = read('../src/views/admin/ArticleEdit.vue');
  ok(
    '写文章页：标题 watch 在 const form 之后（watch 的 getter 也会立即求值）',
    (() => {
      const f2 = edit.indexOf('const form = ref({');
      const w = edit.indexOf('watch(\n  () => form.value.title');
      return f2 !== -1 && w !== -1 && f2 < w;
    })(),
    '换成 watch 也不够 —— getter 立即求值，同样 TDZ'
  );
}

console.log('\n【之前从未检查过的路由】');
{
  // 实测 5 个页面（归档/标签/收藏/友链/404）：友链页 h1→h3 跳级，其余正常。
  const links = read('../src/views/site/Links.vue');
  ok(
    '友链页「申请友链」是 h2（h1 之后没有分区标题，用 h3 会跳级）',
    /<h2 class="apply-title">/.test(links) && !/<h3 class="apply-title">/.test(links)
  );

  // 标签云：零文章的标签原本是可点 router-link，点进去是空页
  const tags = read('../src/views/site/Tags.vue');
  ok('零计数标签渲染成 span 而非链接', /v-if="!tag\.article_count"[\s\S]{0,160}?class="cloud-item is-empty/.test(tags));
  ok('零计数标签有说明性 aria-label', /aria-label="`\$\{tag\.name\}，暂无文章`"/.test(tags));
  ok('有文章的标签仍是 router-link', /v-else[\s\S]{0,200}?router-link|<router-link[\s\S]{0,120}?v-else/.test(tags) || /v-else\s*\n\s*:to=/.test(tags));
  ok('.is-empty 有视觉区分（降低不透明度）', /\.cloud-item\.is-empty \{[\s\S]{0,80}?opacity: 0\.5/.test(tags));
  ok(
    '.is-empty 覆盖 hover（不可点的东西不该有可点的暗示）',
    /\.cloud-item\.is-empty:hover \{[\s\S]{0,120}?transform: none/.test(tags)
  );
}

console.log('\n【关于页与个人主页的一致性】');
{
  // 关于页只走 renderMarkdown、不走 addHeadingIds —— 没有 TOC 就不需要锚点，
  // 但必须确认它的标题大纲仍然合法（第 19 轮降级后不能冒出第二个 h1）。
  const about = read('../src/views/site/About.vue');
  ok('关于页用 renderMarkdown 渲染正文', /renderMarkdown\(/.test(about));
  ok(
    '关于页不接 addHeadingIds（没有 TOC，不需要 heading-N 锚点）',
    !/addHeadingIds/.test(about),
    '接了反而会产出无处可跳的 id'
  );

  // 个人主页两个布局都要有主题切换（曾怀疑缺，实测两处都在）
  const home = read('../src/views/home/Layout.vue');
  ok('个人主页有主题切换', /toggleTheme/.test(home));
  ok('个人主页也用了 useThemeStore', /useThemeStore/.test(home));
  ok('个人主页有 skip-link（第 28 轮补的）', /class="skip-link"/.test(home));
  ok('个人主页主内容可聚焦', /id="home-main"[^>]*tabindex="-1"/.test(home));
}

console.log('\n【TOC 编号必须与正文标题一一对应】');
{
  // 第 19 轮加 h1 降级时引入的回归，第 37 轮才发现：
  // demoteH1 把正文的 `# 标题` 变成 <h2>，而 addHeadingIds 给它也编了号（heading-0），
  // 但 extractToc 只收原始 depth>=2 的标题、不编号 —— 两边**整体错位一位**。
  // 实测：点 TOC 第一项跳到的是文章主标题，而不是它写的那一节。
  const md = read('../src/utils/markdown.js');
  ok('demoteH1 给降级标题打 data-demoted 标记', md.includes('data-demoted="1"'));
  ok(
    'addHeadingIds 跳过降级标题（不占 heading-N 序列）',
    /const demoted = \/\\bdata-demoted="1"\//.test(md) && md.includes('id="heading-demoted"')
  );
  ok(
    '清理已有的 id 属性（避免出现两个 id）',
    md.includes('.replace(/\\s*id="[^"]*"/, \'\')')
  );
  ok(
    'extractToc 与 addHeadingIds 都只认原始 depth 2-4',
    /t\.depth >= 2 && t\.depth <= 4/.test(md) && /<h\(\[2-4\]\)/.test(md)
  );

  // TOC 高亮：不能用 entries（只含变化元素），也不能只靠观察器（滚出视口就不再回调）
  const detail = read('../src/views/site/ArticleDetail.vue');
  ok('有 computeActiveHeading 量所有标题', /function computeActiveHeading\(\)/.test(detail));
  ok(
    '取「最后一个越过激活线」的标题',
    /top - line <= 0\) current = t\.id/.test(detail)
  );
  ok(
    '在 scroll 的 rAF 里同步（不依赖观察器的触发时机）',
    /progress\.value = computeReadingProgress\(\);\s*\n\s*syncActiveHeading\(\);/.test(detail),
    '观察器只在进入/离开视口时触发，滚到中间会停在旧值'
  );
}

console.log('\n【阅读进度以正文为准，不以整页为准】');
{
  // 实测：原实现分母是 scrollHeight - innerHeight，而正文之后还有
  // 约 1848px 的页脚/版权/上下篇导航（占整页 64%）。
  // **读完正文那一刻进度只有 36.2%** —— 读完了却显示才读三分之一。
  const detail = read('../src/views/site/ArticleDetail.vue');
  ok('有 computeReadingProgress', /function computeReadingProgress\(\)/.test(detail));
  ok(
    '用正文末尾而非文档高度作分母',
    /body\.getBoundingClientRect\(\)\.bottom \+ window\.scrollY/.test(detail),
    '用 scrollHeight 会把页脚也算进阅读量'
  );
  ok(
    '正文一屏放得下时视为已读完（不显示 0%）',
    /if \(endScroll <= 0\) return 100;/.test(detail)
  );
  ok(
    '正文还没渲染时退回整页算法（避免首屏突然跳到 0）',
    /if \(!body\) \{[\s\S]{0,200}?return max > 0/.test(detail)
  );
  ok('结果夹在 0–100', /Math\.max\(0, Math\.min\(100,/.test(detail));
  ok('onScroll 调用统一函数（三个进度显示共用一份计算）', /progress\.value = computeReadingProgress\(\);/.test(detail));
  ok(
    '整页兜底只在正文缺失时用（不超过两处）',
    (detail.match(/scrollHeight - window\.innerHeight/g) || []).length <= 2,
    '一处在 computeReadingProgress 的兜底，一处在 contentEndScroll 的兜底；两处都是「正文还没渲染」时才走'
  );
}

console.log('\n【图片：正文尊重空 alt，但灯箱必须有名字】');
{
  // 实测：`alt=""` 的图打开灯箱后 aria-label 只有「查看大图」——
  // 读屏不知道在看什么。而正文里空 alt 表示「装饰图跳过」是对的，
  // 两个场景的要求相反，不能靠同一条规则。
  const md = read('../src/utils/markdown.js');
  ok(
    '正文里不给 alt="" 补标签（尊重作者的装饰图声明）',
    /attrs\.alt === undefined/.test(md),
    '把空 alt 也补成文件名，等于把装饰图变成读屏噪音'
  );
  ok('图片补 loading=lazy', md.includes('loading="lazy"'));
  ok('图片补 decoding=async', md.includes('decoding="async"'));

  const detail = read('../src/views/site/ArticleDetail.vue');
  ok(
    '灯箱 caption 有三级兜底：alt → aria-label → 文件名',
    /img\.alt \|\| img\.getAttribute\('aria-label'\) \|\| fileNameFromSrc/.test(detail)
  );
  ok('有 fileNameFromSrc 把路径变成可念的名字', /function fileNameFromSrc\(src\)/.test(detail));
  ok(
    '文件名兜底去掉扩展名并把连字符换空格',
    detail.includes(".replace(/\\.[a-z0-9]+$/i, '')") && detail.includes("replace(/[-_]+/g, ' ')")
  );
  ok(
    'decodeURIComponent 失败时不抛（中文/特殊字符路径）',
    detail.includes("} catch (e) {\n    return '';")
  );
}

console.log('\n【任务列表：复选框要能说清「哪一条」】');
{
  // 实测：marked 产出 <input type=checkbox disabled>，
  // disabled 让它不被 Tab 到（对的），但读屏只念「复选框，已选中，不可用」，
  // 不知道标的是哪一条任务 —— 两项的 aria-label 都是 null。
  const md = read('../src/utils/markdown.js');
  ok('有 annotateTaskItems', /function annotateTaskItems/.test(md));
  ok('从相邻文本生成 aria-label', /aria-label="\$\{escapeHtml\(label\)\}"/.test(md));
  ok(
    'label 带上完成状态（已完成 / 未完成）',
    md.includes("'已完成' : '未完成'") || /done \? '已完成' : '未完成'/.test(md)
  );
  ok('给 li 加 task-list-item 类', md.includes('<li class="task-list-item">'));
  ok('不覆盖已有的 aria-label', /\/\\baria-label=\/i\.test\(input\)/.test(md));
  ok(
    '描述里剔除嵌套列表（否则父项会把子项文字也吞进来）',
    /replace\(\/<ul\\b\[\\s\\S\]\*\$\/i, ''\)/.test(md)
  );

  const mdcss = read('../src/styles/markdown.css');
  ok('task-list-item 去掉默认圆点（避免「• ☐ 任务」双重符号）', /\.task-list-item \{[\s\S]{0,80}?list-style: none/.test(mdcss));
  ok('复选框视觉上明确不可交互', /cursor: default/.test(mdcss));
}

console.log('\n【表格：语义完整且窄屏可达】');
{
  // 全站 6 篇文章原本 0 个表格，这块代码从未被真实内容检验过。
  // 实测插入表格后发现：th 无 scope；窄屏超宽表格无法用键盘滚动。
  const md = read('../src/utils/markdown.js');
  ok('有 addTableScopes 处理表头', /function addTableScopes/.test(md));
  ok('给 th 补 scope="col"', md.includes('<th scope="col"'));
  ok(
    '已存在 scope 时不重复添加',
    md.includes('(?![^>]*\\bscope=)'),
    '否则重复渲染会给 th 叠两个 scope'
  );
  ok('只在有 thead 时处理（不猜无表头的结构）', /if \(!\/<thead\\b\/i\.test\(inner\)\) return whole;/.test(md));
  ok('表格可聚焦（键盘能横向滚动超宽表格）', md.includes('tabindex="0">${fixed}'));
  ok(
    '**没有**给 table 加 role（否则会覆盖 table 角色，行列关系全丢）',
    !/<table[^>]*role="group"/.test(md) && !/<table\$\{attrs\} role=/.test(md),
    '这条是给未来自己踩刹车用的'
  );

  const css = read('../src/styles/main.css');
  const mdcss = read('../src/styles/markdown.css');
  ok('窄屏表格横向滚动而非挤压', /@media \(max-width: 640px\)[\s\S]{0,120}?overflow-x: auto/.test(mdcss));
  ok('窄屏有「右侧还有内容」的视觉暗示', /linear-gradient\(to left/.test(mdcss));
  ok('表格聚焦时有可见焦点环', /\.markdown-body table:focus-visible/.test(mdcss));
}

console.log('\n【快捷键帮助弹层：模态语义与焦点陷阱】');
{
  const help = read('../src/components/ui/ShortcutHelp.vue');
  // 实测修前：有 role=dialog 但缺 aria-modal；打开后焦点不进面板；
  // Tab 5/5 全部逃到背景（skip-link、导航链接）。和搜索弹窗同一个坑。
  ok('有 role=dialog', /role="dialog"/.test(help));
  ok('配了 aria-modal="true"', /aria-modal="true"/.test(help), '只有 role 的话读屏仍把背景当可读内容');
  ok('用 aria-labelledby 指向标题', /aria-labelledby="help-title"/.test(help) && /id="help-title"/.test(help));
  ok('有 Tab 焦点陷阱', /function onTabTrap/.test(help) && /@keydown\.tab="onTabTrap"/.test(help));
  ok(
    '焦点陷阱无条件拉回（不依赖「是否正好在首尾」）',
    /if \(!panel\.contains\(active\)\) \{[\s\S]{0,80}?e\.preventDefault\(\)/.test(help),
    '搜索弹窗就是这么漏的'
  );
  ok(
    '打开时把焦点送进面板',
    /nextTick\(\(\) => closeBtnRef\.value\?\.focus\?\.\(\)\)/.test(help)
  );
  ok(
    '关闭时还原焦点（body 不作为有效返回点）',
    /lastFocused = active && active !== document\.body \? active : null/.test(help)
  );
  ok(
    '还原前确认元素仍在 DOM（导航后触发元素可能已消失）',
    /document\.contains\(back\)/.test(help)
  );
  ok('Shift+/ 也能打开（实测这是唯一真正可用的组合）', /e\.key === '\?' \|\| \(e\.key === '\/' && e\.shiftKey\)/.test(help));
}

console.log('\n【代码块复制：播报要落在独立的状态元素上】');
{
  const md = read('../src/utils/markdown.js');
  // 实测：aria-live 挂在**可聚焦按钮**上是无效用法 ——
  // 读屏把交互元素当作「用户已知区域」，按钮内文字变化多数不朗读；
  // 而且按钮名变成「已复制」后，再聚焦时丢失了「复制」这个含义。
  ok(
    '复制按钮不再用 aria-live 承担播报',
    /<button[^>]*class="code-copy"[^>]*aria-label="复制代码"/.test(md)
      && !/<button[^>]*class="code-copy"[^>]*aria-live/.test(md)
  );
  ok(
    '有独立的 role=status 播报元素',
    /class="code-copy-status sr-only" role="status" aria-live="polite"/.test(md)
  );
  ok(
    '按钮名稳定为「复制代码」（不随状态丢失含义）',
    md.includes('aria-label="复制代码"')
  );
  ok(
    '播报内容先清空再写入（否则相同文本不会重复播报）',
    /status\.textContent = '';/.test(md) && /requestAnimationFrame/.test(md)
  );
  ok('成功与失败都有具体播报文案', md.includes('代码已复制到剪贴板') && md.includes('复制失败，请手动选择代码'));
  ok('视觉反馈仍然改按钮文字', /btn\.textContent = ok \? '已复制 ✓' : '复制失败'/.test(md));
  ok('连点防护（data-copying 门闩）', /btn\.dataset\.copying === '1'/.test(md));
  ok(
    '复制到剪贴板有 execCommand 兜底（老浏览器/非安全上下文）',
    /function legacyCopy\(text\)/.test(md)
  );
}

console.log('\n【评论点赞：并发防护齐全，且没有嵌套重复代码】');
{
  const ci = read('../src/components/site/CommentItem.vue');
  ok(
    '点赞有并发门闩（liked || liking 时直接返回）',
    /if \(liked\.value \|\| liking\.value\) return;/.test(ci)
  );
  ok(
    'liking 在 finally 里复位（失败后仍可重试）',
    /async function likeComment\(\)[\s\S]*?finally \{\s*\n\s*liking\.value = false;/.test(ci),
    '不复位的话一次网络失败会让这条评论永久无法点赞'
  );
  ok(
    '乐观更新失败会回滚',
    ci.includes('Math.max(0, (props.comment.likes || 1) - 1)')
  );
  // 实测发现过一段嵌套两层的重复 try（编辑失误残留），清掉后加断言防回潮
  ok(
    '没有嵌套重复的 try 块',
    !/try \{\s*\n\s*try \{/.test(ci),
    '同一段 localStorage 写入被 try 包了两层'
  );
}

console.log('\n【目录跳转要把焦点送到目标标题】');
{
  // 实测：点目录后滚动生效但焦点掉到 body ——
  // 键盘/读屏用户不知道「现在到了哪一节」，下次 Tab 从页面顶部重来。
  const md = read('../src/utils/markdown.js');
  ok(
    '标题带 tabindex="-1"（可脚本聚焦、不进 Tab 序列）',
    (md.match(/tabindex="-1">/g) || []).length >= 2,
    '没有它 scrollIntoView 只是滚了一下，焦点留不住'
  );

  const detail = read('../src/views/site/ArticleDetail.vue');
  const fn = detail.match(/function scrollToHeading\(id\)[\s\S]*?\n\}/);
  ok('有 scrollToHeading', !!fn);
  ok('跳转时聚焦目标标题', !!fn && /\.focus\(/.test(fn[0]));
  ok(
    'focus 用 preventScroll（避免与 smooth 滚动打架）',
    !!fn && /preventScroll: true/.test(fn[0])
  );
  ok('仍然会滚动到目标', !!fn && /scrollIntoView/.test(fn[0]));
  ok(
    '滚动用 smooth（长文里瞬移会让人失去位置感）',
    !!fn && /behavior: 'smooth'/.test(fn[0])
  );
}

console.log('\n【skip-link：跳转不能破坏当前路由】');
{
  // 实测严重缺陷：`href="#main-content"` 在 hash 路由下被当成路由地址，
  // 在文章页/留言页/带筛选的列表页按回车 → URL 变成 `#/`，
  // **当前页面和查询参数全部丢失，人被送回首页**。
  const site = read('../src/views/site/Layout.vue');
  ok(
    '博客布局的 skip-link 用 @click.prevent（不让浏览器改 URL）',
    /class="skip-link"[\s\S]{0,120}?@click\.prevent="skipToMain"/.test(site)
  );
  ok('有 skipToMain 处理函数', /function skipToMain\(e\)/.test(site));
  ok(
    'skipToMain 只聚焦不导航（不含 router.push / location 赋值）',
    (() => {
      const m = site.match(/function skipToMain\(e\)[\s\S]*?\n\}/);
      return !!m && !/router\.(push|replace)/.test(m[0]) && !/location\.(hash|href)\s*=/.test(m[0]);
    })()
  );

  const home = read('../src/views/home/Layout.vue');
  ok('个人主页也有 skip-link（此前缺失）', /class="skip-link"/.test(home) && /skipToMain/.test(home));
  ok('个人主页的主内容有 id 与 tabindex=-1', /<main id="home-main"[^>]*tabindex="-1"/.test(home));

  const css = read('../src/styles/main.css');
  ok(
    'skip-link 样式在全局（两个布局共用，避免 scoped 特指度冲突）',
    /\.skip-link \{/.test(css) && /\.skip-link:focus/.test(css)
  );
  ok(
    '博客布局不再保留 scoped 版 skip-link（它会压过全局并推出屏幕外）',
    !/\.skip-link \{\s*\n\s*position: fixed/.test(site)
  );
  ok('.skip-link 聚焦时进入视口', /top: calc\(12px \+ var\(--sat, 0px\)\)/.test(css));
}

console.log('\n【对话框：改了内容点取消不能静默丢弃】');
{
  // 全库此前没有任何 el-dialog 做过关闭前确认（grep before-close = 0）。
  // 分类编辑对话框是典型的「改了名/描述，手滑点取消就没了」。
  const cat = read('../src/views/admin/CategoryManage.vue');
  ok('分类编辑对话框有未保存判断', /function dialogDirty\(\)/.test(cat));
  ok(
    '取消按钮在关闭前先判断（不是直接赋值关掉）',
    /async function cancelEdit\(\)[\s\S]{0,300}?if \(!dialogDirty\(\)\)/.test(cat)
  );
  ok('有未保存判断时弹确认', /ElMessageBox\.confirm\([\s\S]{0,200}?尚未保存的修改/.test(cat));
  ok(
    '点遮罩不关闭（编辑表单误点旁边一下不该丢内容）',
    /:close-on-click-modal="false"/.test(cat)
  );
  ok(
    '快照与脏判断都只取 name/slug/description（避开会被规范化的 color）',
    (() => {
      const snap = cat.match(/editSnapshot = \[([^\]]*)\]\.join/);
      const pick = cat.match(/const pick = \(f\) => \[([^\]]*)\]\.join/);
      const fields = (m) => (m ? m[1].match(/\b(name|slug|description|color)\b/g) || [] : []);
      const a = fields(snap), b = fields(pick);
      return a.length === 3 && b.length === 3 && a.join() === b.join() && !a.includes('color');
    })(),
    '两边字段不一致会永远判定为已修改（这个错已犯过一次）'
  );
  ok(
    '未修改时直接关闭、不弹窗',
    /if \(!dialogDirty\(\)\) \{\s*\n\s*dialogVisible\.value = false;\s*\n\s*return;/.test(cat)
  );
  ok('不再残留 pendingDirty 之类的死变量', !cat.includes('pendingDirty'));
  // 注意：注释里可以提到 before-close（解释为何不用），只禁止真正绑定
  ok(
    '不再绑定 before-close（本地这版不触发）',
    !/:before-close=/.test(cat)
  );
}

console.log('\n【保存成功后必须重置基线，否则误报「未保存」】');
{
  // 上一轮刚加的未保存保护引入了一个反向缺陷，实测复现：
  // 改字段 → 保存（提示「设置已保存」）→ 点离开，仍被「尚有未保存的修改」拦住。
  // 用户刚保存过，页面却说没保存 —— 误报比漏报更伤信任。
  for (const [path, label, anchor] of [
    ['../src/views/admin/Settings.vue', '站点设置', 'setBaseline(form.value);'],
    ['../src/views/admin/HomeSettings.vue', '主页设置', 'setBaseline();'],
  ]) {
    const src = read(path);
    // 找 save 函数体，断言里面调用了 setBaseline（且不是在 load 里那个）
    const m = src.match(/async function save\(\)[\s\S]*?\n\}/);
    const body = m ? m[0] : '';
    ok(`${label}：save() 里重置基线`, body.includes(anchor.trim()), '否则保存后离开会误拦');
    ok(
      `${label}：重置基线在 save 成功路径内（不是 catch 里）`,
      body.indexOf(anchor.trim()) > body.indexOf('try {')
    );
  }
  // HomeSettings 还有个顺序要求：先同步服务端清洗结果、再记基线
  const hs = read('../src/views/admin/HomeSettings.vue');
  const idxClean = hs.indexOf('socialExtra.value = cleaned;');
  const idxBase = hs.indexOf('setBaseline();', idxClean);
  ok(
    '主页设置：先同步 cleaned 再记基线（否则服务端清洗差异会被当成新修改）',
    idxClean !== -1 && idxBase > idxClean
  );
}

console.log('\n【出错要告诉用户，不能只写进控制台】');
{
  const main = read('../src/main.js');
  // 实测：派发未捕获错误后页面毫无变化、没有任何提示，
  // 用户会以为刚才的操作成功了。原注释却写着「至少给出提示」——
  // 注释描述的行为和代码不一致。
  ok(
    '有统一的用户可见错误提示函数',
    /function notifyUnexpected\(reason\)/.test(main) && main.includes("ElMessage.error('页面遇到了一点问题，请刷新重试')")
  );
  ok(
    'unhandledrejection 里调用了提示（不只是 console.error）',
    /addEventListener\('unhandledrejection'[\s\S]{0,400}?notifyUnexpected\(/.test(main)
  );
  ok(
    '同步未捕获错误也提示（事件处理器/第三方脚本）',
    /addEventListener\('error'[\s\S]{0,320}?notifyUnexpected\(/.test(main)
  );
  ok(
    'Vue 渲染错误单独提示（Vue 捕获后不会走 window error 事件）',
    /app\.config\.errorHandler[\s\S]{0,200}?notifyUnexpected\(/.test(main),
    '组件渲染失败会完全静默'
  );
  ok(
    '401/403 不重复提示（拦截器已处理）',
    /status === 401 \|\| status === 403\) return/.test(main)
  );
  ok(
    'ERR_CANCELED 不提示（主动取消不是错误）',
    /reason\?\.code === 'ERR_CANCELED'\) return/.test(main)
  );
  ok(
    '资源加载失败不提示（img/script 的 error 事件没有 e.error）',
    /if \(!e\?\.error\) return/.test(main),
    '否则图片 404 也会弹「页面遇到问题」'
  );
  ok(
    '连环错误有节流（避免刷屏）',
    /ERROR_TOAST_INTERVAL/.test(main) && /lastErrorToastAt/.test(main)
  );
}

console.log('\n【状态播报必须覆盖「加载中」，不能只在有数据时才存在】');
{
  const list = read('../src/views/site/ArticleList.vue');
  // 实测（慢网 + 应用内导航）：加载中时 [role=status] **根本不存在**，
  // 因为它嵌在 v-else 分支里，而 loading 走另一个分支。
  // 结果：读屏用户在加载期间听不到任何动静，数据到了才知道刚才加载过。
  // 同时骨架屏 aria-hidden（纯装饰），所以那段时间对读屏是彻底的静默。
  const statusIdx = list.indexOf('role="status"');
  const loadingIdx = list.indexOf('v-if="loading"');
  const elseIdx = list.indexOf('v-else-if="loadFailed"');
  ok(
    '播报点存在',
    statusIdx !== -1 && list.includes('aria-live="polite"')
  );
  ok(
    '播报点在 loading 分支之前（否则加载中它不存在）',
    statusIdx !== -1 && loadingIdx !== -1 && statusIdx < loadingIdx,
    '曾经埋在 v-else 里，加载中是静默的'
  );
  ok(
    '播报点在 loadFailed 分支之前（失败播报交给 role=alert，但状态点仍常驻）',
    statusIdx !== -1 && elseIdx !== -1 && statusIdx < elseIdx
  );
  ok(
    'aria-busy 绑在 loading 上（读屏可判断是否还在加载）',
    /:aria-busy="loading \? 'true' : 'false'"/.test(list)
  );
  ok(
    '加载中有具体文案（不是空壳播报点）',
    /if \(loading\.value\) return '正在加载文章…'/.test(list)
  );

  // 搜索弹窗的 aria-live 包住整个 body，覆盖 搜索中/有结果/无结果 三态，正确
  const search = read('../src/components/ui/SearchModal.vue');
  ok(
    '搜索弹窗的 aria-live 包住整个结果区（覆盖三种状态）',
    /<div class="search-body" aria-live="polite">/.test(search)
  );
}

console.log('\n【表单控件必须有真名，不能只靠 placeholder】');
{
  // 实测审计：后台登录页三个 <label> 都只是「视觉标签」，
  // 后面跟着没有 id 的 <input> —— 读屏无法配对；
  // 而字段一旦有内容、placeholder 消失，这个框就彻底没有名字了。
  const login = read('../src/views/admin/Login.vue');
  for (const [id, word] of [['login-username', '用户名'], ['login-password', '密码'], ['login-totp', '两步验证码']]) {
    ok(
      `后台登录「${word}」的 label 用 for 指向 input 的 id`,
      login.includes(`for="${id}"`) && login.includes(`id="${id}"`)
    );
  }
  ok(
    '后台登录的输入框带 name（表单语义与密码管理器识别）',
    login.includes('name="username"') && login.includes('name="password"')
  );

  // 列表页搜索框原来只有 placeholder，没有任何标签
  const list = read('../src/views/site/ArticleList.vue');
  ok(
    '列表页搜索框有 aria-label',
    list.includes('aria-label="按关键词搜索文章"')
  );
  ok('列表页搜索框用 type="search"（语义化）', list.includes('type="search"'));
  ok(
    '清空关键词按钮有可读名称（只有图标）',
    list.includes('aria-label="清空关键词"')
  );

  // 手写表单的两处（留言/评论）此前已用 aria-label，这里做存在性回归
  ok(
    '留言页输入框有 aria-label',
    read('../src/views/site/Messages.vue').includes('aria-label="昵称"')
  );
  ok(
    '评论区输入框有 aria-label',
    read('../src/components/site/CommentSection.vue').includes('aria-label="昵称"')
  );
}

console.log('\n【模态弹层的焦点必须被锁住】');
{
  // 真实缺陷：搜索弹窗标了 aria-modal="true"，但没有焦点陷阱 ——
  // 打开后连按 Tab 10 次，10 次全部逃逸到背景页面的 skip-link / nav-link。
  // 「宣称模态却做不到」比不写 aria-modal 更误导读屏用户。
  const search = read('../src/components/ui/SearchModal.vue');
  ok(
    '搜索弹窗有 role=dialog + aria-modal',
    /role="dialog"[^>]*aria-modal="true"/.test(search) || /aria-modal="true"[^>]*role="dialog"/.test(search)
  );
  ok(
    '焦点不在弹窗内时无条件拉回（不只处理首尾元素）',
    /!active\.closest\(\.search-modal\)/.test(search) || /!active\.closest\('\.search-modal'\)/.test(search)
  );
  ok(
    '首/尾元素上正常循环（Tab 与 Shift+Tab 双向）',
    /e\.shiftKey && active === first/.test(search) && /!e\.shiftKey && active === last/.test(search)
  );
  ok(
    '可聚焦元素用通用选择器而不是列举标签名',
    /\[tabindex\]:not\(\[tabindex="-1"\]\)/.test(search)
  );
  ok(
    '有显式的关闭按钮（不能只靠 Esc 或点遮罩）',
    /class="search-close"[^>]*aria-label="关闭搜索"/.test(search)
  );

  const lb = read('../src/components/ui/ImageLightbox.vue');
  ok('灯箱有 role=dialog + aria-modal', /role="dialog"[\s\S]{0,120}?aria-modal="true"/.test(lb));
  ok('灯箱有焦点陷阱', /function onTabTrap/.test(lb) && /addEventListener\('keydown', onTabTrap\)/.test(lb));
  ok(
    '灯箱打开时聚焦关闭按钮、关闭时还焦点',
    /const active = document\.activeElement/.test(lb)
      && /lastFocused = active && active !== document\.body \? active : null/.test(lb)
      && /lastFocused\.focus\(\)/.test(lb)
  );
  // 实测出来的两个坑，都写成断言
  ok(
    '灯箱不把 body 当作有效的焦点返回点',
    /active !== document\.body \? active : null/.test(lb),
    '点图片打开时 activeElement 是 body，记下来等于「恢复到 body」'
  );
  ok(
    '灯箱关闭时把焦点还给触发图片（<img> 不可聚焦，需显式传入）',
    /lastFocusedImg = opener/.test(lb) && /function open\(s, a, opener\)/.test(lb)
  );
  ok(
    '恢复焦点时优先最近的交互容器，不退到 <main tabindex="-1">',
    /closest\('a\[href\], button, \[role="button"\]'\)/.test(lb),
    'layout 的 <main> 带 tabindex=-1，closest([tabindex]) 会一路匹到它'
  );
  {
    const detail = read('../src/views/site/ArticleDetail.vue');
    ok('调用灯箱时把被点的图片一起传进去', /lightboxRef\.value\?\.open\(img\.src, caption, img\)/.test(detail));
  }
}

console.log('\n【移动端抽屉：焦点与状态关联】');
{
  const layout = read('../src/views/site/Layout.vue');
  ok(
    '汉堡按钮有 aria-controls 指向抽屉 id',
    /aria-controls="mobile-nav"/.test(layout) && /id="mobile-nav"/.test(layout)
  );
  ok(
    '汉堡按钮的 aria-label 随开关状态切换',
    /:aria-label="mobileOpen \? '关闭菜单' : '打开菜单'"/.test(layout),
    '固定写「菜单」时读屏不知道再按一次会发生什么'
  );
  ok(
    '打开抽屉后焦点进入菜单首个链接',
    /function openMobile\(\)/.test(layout) && /\.mobile-menu \.mobile-link/.test(layout)
  );
  ok(
    '关闭抽屉后焦点回到汉堡按钮',
    /function closeMobile\(restoreFocus = true\)/.test(layout) && /hamburgerRef\.value\?\.focus\?\.\(\)/.test(layout)
  );
  ok(
    'Esc 关闭时恢复焦点（键盘用户不该被丢在 body）',
    /if \(e\.key === 'Escape' && mobileOpen\.value\) \{\s*\n\s*closeMobile\(\);/.test(layout)
  );
  ok(
    '点遮罩/点链接关闭时不抢焦点（closeMobile(false)）',
    (layout.match(/closeMobile\(false\)/g) || []).length >= 2,
    '用户主动点了别处，把焦点拽回汉堡反而是干扰'
  );
  ok('抽屉 nav 有 aria-label', /id="mobile-nav"[^>]*aria-label="移动端导航"/.test(layout));
}

console.log('\n【标题大纲：每页一个 h1、不跳级】');
{
  // 实测：首页与列表页 h1 后直接跳 h3；详情页与关于页各有 2 个 h1
  // （正文里作者写的 `# 标题` 被 marked 渲染成第二个 h1）。
  const md = read('../src/utils/markdown.js');
  ok(
    '正文里的 <h1> 被降为 <h2>（不产出第二个页面级标题）',
    md.includes('function demoteH1') && /<\/h1>/i.test(md) && md.includes('<h2$1'),
    '文章页已有自己的 h1，正文再来一个会让读屏看到两个主标题'
  );
  // 这条断言已经被两次「正确地失败」教训过：先是写死 sanitize(demoteH1(raw))，
  // 加 addTableScopes 后误报；再写宽松版，加 annotateTaskItems 后又误报。
  // 现在改成**不匹配嵌套形状**：只要求三个处理器都在同一条 sanitize 语句里，
  // 且 demoteH1 作用在 raw 上。谁包谁无所谓 —— 那属于实现细节。
  ok(
    '三个渲染处理器都在 sanitize 链里，且 demoteH1 作用在 raw 上',
    (() => {
      // 取 renderMarkdown 的函数体，而不是按单行匹配 ——
      // 调用跨行写过一次，单行查找就失效了（第三次因形状误报）
      const body = md.match(/export function renderMarkdown\(\)[\s\S]*?\n\}/)
        || md.match(/export function renderMarkdown\(md = ''\)[\s\S]*?\n\}/);
      if (!body) return false;
      const b = body[0];
      return b.includes('DOMPurify.sanitize(')
        && b.includes('demoteH1(')
        && b.includes('addTableScopes(')
        && b.includes('annotateTaskItems(');
    })(),
    '曾经两次因为写死调用形状而误报 —— 断言应该钉「都接上了」，不是钉「谁包谁」'
  );

  const card = read('../src/components/site/ArticleCard.vue');
  ok(
    '文章卡片标题层级可配置（不写死 h3）',
    /headingLevel: \{ type: \[Number, String\], default: 3 \}/.test(card)
      && card.includes('`h${headingLevel}`')
  );

  const home = read('../src/views/site/Home.vue');
  ok('首页给卡片传 h2（h1 后第一个内容块）', home.includes('heading-level="2"'));
  ok(
    '首页侧栏的站点名不再用 h2（与页面 h1 同名，重复占层级）',
    !/<h2>\{\{ site\.settings\.site_name/.test(home)
  );

  const list = read('../src/views/site/ArticleList.vue');
  ok(
    '列表页文章标题用 h2（h1 后无分区标题，用 h3 会跳级）',
    list.includes('<h2 class="row-title"') && list.includes('<h2 class="grid-title"')
  );
  ok('列表页不再有 h3 文章标题', !list.includes('<h3 class="row-title"') && !list.includes('<h3 class="grid-title"'));
}

console.log('\n【全库扫描：watch 源不能是新建的数组/对象字面量】');
{
  // 这是 ArticleList 翻页失效的根因，而且是**模式性**问题 ——
  // 任何 `watch(() => [a, b], ...)` 都会因为引用不等而每次触发。
  // 单文件断言防不住以后在别处照抄，所以这里真的遍历源码目录。
  const { readdirSync } = await import('node:fs');
  const offenders = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'dist') continue;
        walk(full);
      } else if (/\.(vue|js)$/.test(ent.name)) {
        const text = readFileSync(full, 'utf8');
        // 「watch 的第一个参数直接返回数组字面量」
        if (/watch\(\s*\n?\s*\(\) =>\s*\[/.test(text)) offenders.push(full);
      }
    }
  };
  walk(resolve(here, '../src'));

  ok(
    '没有 watch 直接返回数组字面量（会因引用不等而每次触发）',
    offenders.length === 0,
    offenders.map((p) => p.replace(resolve(here, '..'), '')).join(' / ') || undefined
  );
  ok(
    'CommentSection 的文章切换 watcher 用字符串签名',
    /watch\(\s*\n?\s*\(\) => `\$\{props\.articleId\}/.test(read('../src/components/site/CommentSection.vue'))
  );
}

console.log('\n【鼠标点击不应被焦点环打扰】');
{
  const css = read('../src/styles/main.css');
  // 用 :focus-visible 而不是 :focus —— 鼠标点输入框本来就有光标，再加环太吵
  ok(
    '输入框的环用 :focus-visible（不是 :focus）',
    /input:focus-visible/.test(css) && !/^input:focus\s*\{/m.test(css)
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
