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

console.log('\n【目录跳转要把焦点送到目标标题】');
{
  // 实测：点目录后滚动生效但焦点掉到 body ——
  // 键盘/读屏用户不知道「现在到了哪一节」，下次 Tab 从页面顶部重来。
  const md = read('../src/utils/markdown.js');
  ok(
    '标题带 tabindex="-1"（可脚本聚焦、不进 Tab 序列）',
    /id="heading-\$\{index - 1\}" tabindex="-1"/.test(md),
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
    md.includes('function demoteH1') && md.includes("'<h2$1>$2</h2>'"),
    '文章页已有自己的 h1，正文再来一个会让读屏看到两个主标题'
  );
  ok(
    'demoteH1 在 sanitize 之前/之内生效',
    /DOMPurify\.sanitize\(demoteH1\(raw\)\)/.test(md)
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
