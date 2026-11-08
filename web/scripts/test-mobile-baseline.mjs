/**
 * 移动端基线守卫（无需浏览器、无需设备）
 *
 * 这些规则全都是「在桌面模拟器里看不出来、真机上必然出问题」的那一类，
 * 所以只能用静态断言把它们钉死，避免以后重构时被顺手删掉：
 *
 *  1. viewport 必须带 viewport-fit=cover —— 否则 env(safe-area-inset-*) 全是 0，
 *     刘海屏 / Home 指示条区域的内容永远避不开。
 *  2. 绝不能出现 user-scalable=no / maximum-scale=1 —— 那是拿禁缩放掩盖
 *     「输入框字号 < 16px 导致 iOS 自动放大」的真问题，属于无障碍缺陷。
 *  3. -webkit-tap-highlight-color: transparent —— 否则每次点击闪一层灰蓝方块，
 *     这是「网页感」最响的信号。
 *  4. touch-action: manipulation —— 消掉双击缩放等待带来的点击延迟。
 *  5. 触摸设备输入框字号 ≥ 16px —— iOS 焦点进入 <16px 输入框会强制缩放且不退焦还原。
 *  6. 首屏头图用 svh 而不是 vh —— 100vh 是「地址栏收起后」的高度，首屏底部会被顶出去。
 *  7. 右下角浮层栈避让 Home 指示条（env(safe-area-inset-bottom)）。
 *  8. 内层滚动容器 overscroll-behavior: contain —— 滚到底不再把整页一起拖走。
 *
 * 用法：node scripts/test-mobile-baseline.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { stripCommentLines } from './lib/sourceText.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const read = (p) => readFileSync(resolve(web, p), 'utf8');

let pass = 0;
let fail = 0;

function ok(name, condition, hint) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${hint ? ` — ${hint}` : ''}`);
  }
}

/** 剥掉 HTML 注释：注释里的示例文本不能让断言误判 */
const stripHtmlComments = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '');

const indexHtml = read('index.html');
const homeHtml = read('home.html');
// 剥注释：注释里提到 `touch-action: manipulation` 之类的属性名会让正向断言假绿
const mainCss = stripCommentLines(read('src/styles/main.css'));
const siteHome = read('src/views/site/Home.vue');

/* ---------- 1. viewport ---------- */
for (const [name, html] of [
  ['index.html', indexHtml],
  ['home.html', homeHtml],
]) {
  const m = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/i);
  ok(`${name} 有 viewport meta`, !!m);
  if (!m) continue;
  const content = m[1];
  ok(
    `${name} viewport 带 viewport-fit=cover（否则 safe-area 全为 0）`,
    /viewport-fit\s*=\s*cover/i.test(content),
    `当前：${content}`
  );
  ok(
    `${name} viewport 用 interactive-widget=resizes-content（安卓软键盘压布局而非盖住）`,
    /interactive-widget\s*=\s*resizes-content/i.test(content),
    `当前：${content}`
  );
}

/* ---------- 2. 禁缩放检查（全仓） ---------- */
//
// 三处修正（都是原先的漏洞）：
//   a. 必须先剥 HTML 注释 —— 注释里写「不要用 user-scalable=no」这种说明时，
//      整份文本扫过去会被**误判为违规**（假红）。本项目两个入口的注释里恰好提到这两个词，
//      当时只是因为没写 `=` 才侥幸没踩。
//   b. `user-scalable=0` 也要拦 —— 多数浏览器（尤其 Android）把它等同于 `no`。
//   c. `maximum-scale=1` 的边界：原来要求后面紧跟 `["\s,;]`，裸写（无引号无空格）会漏。
//      改成用 `(?![\d.])` 负向断言，任何「1 之后不是数字或点」的形式都算限死。
const FORBIDDEN_ZOOM = [
  { label: 'user-scalable=no/0', re: /user-scalable\s*=\s*(?:no|0\b)/i },
  // 要同时拦 `1` / `1.0` / `1.00`，但不能误拦 `1.5`（允许放大）或 `10`。
  // 写成 `1(?:\.0+)?(?![\d.])`：
  //   `1`     → 匹配（后面没有数字/点）
  //   `1.0`   → 匹配（\.0+ 吃掉 .0，后面没有数字/点）
  //   `1.5`   → 不匹配（\.0+ 匹配不上 .5，而 `1` 后面紧跟 `.` → 负向断言失败）
  //   `10`    → 不匹配（`1` 后面是数字）
  { label: 'maximum-scale=1', re: /maximum-scale\s*=\s*1(?:\.0+)?(?![\d.])/i },
];
for (const [name, html] of [
  ['index.html', indexHtml],
  ['home.html', homeHtml],
]) {
  const visible = stripHtmlComments(html);
  for (const { label, re } of FORBIDDEN_ZOOM) {
    ok(
      `${name} 未禁用用户缩放（无 ${label}）`,
      !re.test(visible),
      '注释里提到这两个词是允许的（已剥注释）；真实属性会在这里被抓到'
    );
  }
}

/* ---------- 3~5 & 8. main.css 基线 ---------- */
ok(
  'main.css 关掉点击高亮（-webkit-tap-highlight-color: transparent）',
  /-webkit-tap-highlight-color:\s*transparent/i.test(mainCss)
);
ok(
  'main.css 给控件声明 touch-action: manipulation',
  /touch-action:\s*manipulation/i.test(mainCss)
);
ok(
  'main.css 在触摸设备上把输入框字号提到 ≥16px（iOS 不再强制放大）',
  /@media\s*\(pointer:\s*coarse\)[\s\S]{0,900}?font-size:\s*16px/i.test(mainCss),
  '需要一段 @media (pointer: coarse) 覆盖 input/textarea/select'
);
// 组件的 scoped 选择器形如 .form-input[data-v-xxxx]，特指度高于全局 .form-input，
// 不加 !important 这条兜底实测不生效（表单仍是 14.4px），iOS 照旧放大。
// 断言钉住它，避免以后有人「清理 !important」时把这条静默删掉。
ok(
  '触摸设备输入框字号用 !important 压过 scoped 样式（否则实测不生效）',
  /@media\s*\(pointer:\s*coarse\)[\s\S]{0,1200}?font-size:\s*16px\s*!important/i.test(mainCss),
  'scoped .form-input[data-v-*] 特指度 (0,2,0) 会赢过全局 .form-input (0,1,0)'
);
ok(
  'main.css 定义 safe-area token（--sat/--sab）',
  /--sat:\s*env\(safe-area-inset-top/i.test(mainCss) && /--sab:\s*env\(safe-area-inset-bottom/i.test(mainCss)
);
ok(
  'main.css 给控件声明 user-select: none（长按不选中按钮文字）',
  /user-select:\s*none/i.test(mainCss)
);

/* ---------- 6. 首屏头图用 svh ---------- */
ok(
  '头图高度用 100svh（100vh 会把首屏底部顶出可视区）',
  /--hero-h:\s*100svh/i.test(siteHome),
  'views/site/Home.vue 的 --hero-h 应为 100svh（并保留 100vh 兜底）'
);
ok(
  '头图保留 100vh 兜底（老浏览器无 svh 单位）',
  /--hero-h:\s*100vh/.test(siteHome)
);

/* ---------- 7. 浮层栈避让 Home 指示条 ---------- */
ok(
  '浮层栈右下角避让安全区（--sab / safe-area-inset）',
  /\.float-dock\s*\{[\s\S]{0,700}?(var\(--sab\)|safe-area-inset)/i.test(mainCss),
  '.float-dock 的 right/bottom 需要 calc(... + var(--sab))'
);

/* ---------- 8. 内层滚动容器 ---------- */
const scrollContainers = ['src/views/site/Layout.vue', 'src/views/site/ArticleDetail.vue'];
for (const f of scrollContainers) {
  if (!existsSync(resolve(web, f))) continue;
  const src = read(f);
  ok(
    `${f} 的内层滚动容器用 overscroll-behavior: contain`,
    /overscroll-behavior:\s*contain/i.test(src),
    '滚到底时不该把整页一起拖走'
  );
}

// ---------- 9. 首屏视差：必须按帧收敛，且尊重 reduced-motion ----------
// 实测（浏览器）：未节流时 30 个 scroll 事件触发 33 次 transform 写入；
// 高刷屏上 scroll 派发比渲染帧还密，等于每次滚动都在重算样式。
{
  const js = siteHome.slice(siteHome.indexOf('<script setup>'), siteHome.indexOf('</script>'));
  ok(
    '头图视差用 requestAnimationFrame 收敛（每帧最多一次）',
    /requestAnimationFrame\(applyHeroParallax\)/.test(js),
    '原来每个 scroll 事件都直接写 style.transform'
  );
  ok(
    '视差有节流闸（连续 scroll 只排一次 rAF）',
    /if\s*\(heroTicking\)\s*return/.test(js)
  );
  ok(
    '节流位在函数入口复位（任何 return 路径都不会把它卡死）',
    /function applyHeroParallax\(\)\s*\{[\s\S]{0,300}?heroTicking\s*=\s*false/ .test(js),
    '漏掉复位会让视差滚过一屏后永久冻住'
  );
  ok(
    'reduced-motion 下关掉视差',
    /prefers-reduced-motion: reduce[\s\S]{0,200}?matches/.test(js) && /heroMotionAllowed/.test(js)
  );
  ok(
    '卸载时取消挂起的 rAF（防卸载后仍写 DOM）',
    /cancelAnimationFrame\(heroRafId\)/.test(js)
  );
  ok(
    '视差用 translate3d 走合成层（不是改 top/left 触发重排）',
    /translate3d\(0,/.test(js)
  );
}

// ---------- 10. 触摸目标：44×44 是下限，且热区不能被祖先裁掉 ----------
// 实测（390×844 视口逐页扫描）：公告关闭按钮只有 22×22，热榜切换 28×20，
// 表情按钮 30×30 —— 真机上几乎点不中。
{
  const layout = read('src/views/site/Layout.vue');
  const siteHomeCss = siteHome;
  const commentSection = read('src/components/site/CommentSection.vue');
  const messages = read('src/views/site/Messages.vue');

  ok(
    '公告关闭按钮的可点盒子是 44×44（视觉圆点仍 22px）',
    /\.ticker-close \{[\s\S]{0,1200}?width:\s*44px[\s\S]{0,200}?height:\s*44px/.test(layout),
    '原来 22×22，低于 iOS HIG / WCAG 2.5.5 的下限'
  );
  ok(
    '公告关闭按钮的视觉圆点用伪元素单独画（不把 44px 的空盒子画成实心）',
    /\.ticker-close::before\s*\{[\s\S]{0,300}?width:\s*22px/.test(layout)
  );
  // 这条是本次的真实事故：ticker 的 overflow:hidden 把 44px 热区上下各裁 4px，
  // 且 22px 的间距让热区上沿钻进导航条（z 更高）下面，上半部分永远点不到。
  ok(
    '公告条不裁剪子元素（否则热区被 overflow:hidden 切掉）',
    /\.ticker \{[\s\S]{0,1200}?overflow:\s*visible/.test(layout),
    'overflow:hidden 会把关闭按钮的 44px 热区裁掉'
  );
  ok(
    '公告条与导航之间留出热区越界的余量（33px，不是 22px）',
    /top:\s*calc\(var\(--nav-h\)\s*\+\s*33px/.test(layout),
    '22px 会让 44px 热区的上沿钻进导航条下方'
  );
  ok(
    '容器不再裁剪后，公告文字自己负责省略号',
    /\.ticker-text \{[\s\S]{0,400}?text-overflow:\s*ellipsis/.test(layout)
  );
  ok(
    '热榜切换按钮加高到可点（vertical padding 8px）',
    /\.hot-tabs button \{[\s\S]{0,300}?padding:\s*8px/.test(siteHomeCss)
  );
  ok(
    '标签云链接有最小高度 32px',
    /\.tag-cloud a \{[\s\S]{0,400}?min-height:\s*32px/.test(siteHomeCss)
  );
  ok(
    '评论表情按钮 ≥36px',
    /\.emoji-toggle \{[\s\S]{0,300}?width:\s*36px/.test(commentSection)
  );
  ok(
    '留言页表情按钮 ≥36px',
    /\.emoji-toggle \{[\s\S]{0,300}?width:\s*36px/.test(messages)
  );
}

// ---------- 11. 个人主页（xalor.cn）也有独立的 Layout，必须同样达标 ----------
// 实测（390×844）：.block-more（「全部 / 更多 / 详情」）只有 42×23，
// .brand（回首页入口）28px —— 都是拇指点不中的尺寸。
{
  const homeHome = read('src/views/home/Home.vue');
  const homeLayout = read('src/views/home/Layout.vue');

  ok(
    '个人主页「更多」链接可点区域 ≥40px',
    /\.block-more \{[\s\S]{0,500}?min-height:\s*4[0-9]px/.test(homeHome),
    '原来 42×23，最常点的「全部 / 详情」经常落空'
  );
  ok(
    '个人主页品牌链接（回首页）≥44px',
    /\.brand \{[\s\S]{0,400}?min-height:\s*44px/.test(homeLayout)
  );
  // 两个入口共用 main.css 的基线，这里确认 home.html 也带着 viewport 兜底
  ok(
    'home.html 与 index.html 共用同一套 viewport（安全区）',
    /viewport-fit\s*=\s*cover/i.test(homeHtml)
  );
}

// ============================================================
// 滑动 / 位移动画的容器必须裁剪
// ============================================================
// 这一类问题的共同形状：元素用 transform 滑到容器外做动效，
// 但容器没写 overflow —— 桌面端宽度足够时看不出来，窄屏上直接露在屏幕外。
// 路由进度条就是这样：375px 视口下 .rp-bar 右边缘在 421px，溢出 46px。
// 静态断言无法证明布局，但能保证「修复不会被后来的重构顺手删掉」。
console.log('\n【位移动画的容器必须裁剪】');
{
  const rp = read('src/components/ui/RouteProgress.vue');
  const wrap = (rp.match(/\.route-progress \{[\s\S]*?\n\}/) || [''])[0];
  ok('路由进度条容器 overflow: hidden', /overflow:\s*hidden/.test(wrap), wrap.slice(0, 50));
  ok(
    '滑动动画本身保留（裁剪不等于禁用动效）',
    /@keyframes rpSlide/.test(rp) && /animation:\s*rpSlide/.test(rp),
    '遇到溢出最省事的错误修法是把动效删掉'
  );
}

// ============================================================
// 移动菜单：开合状态与焦点
// ============================================================
// 实测这套实现是完整的（aria-expanded 随状态切换、焦点进面板、ESC 关闭并归还焦点），
// 这里钉住它 —— 因为「焦点管理」是最容易在重构中被削掉的部分，
// 而削掉之后视力正常的用户完全无感，键盘用户直接卡住。
console.log('\n【移动菜单的开合语义不能被削掉】');
{
  const layout = read('src/views/site/Layout.vue');
  ok('汉堡按钮 aria-expanded 绑定状态', /:aria-expanded="mobileOpen/.test(layout));
  ok(
    '菜单标签随开合切换（打开菜单 / 关闭菜单）',
    /mobileOpen \? '关闭菜单' : '打开菜单'/.test(layout)
  );
  ok('打开时焦点移进面板', /nextTick\([\s\S]{0,200}?\.focus\(\)/.test(layout) || /focus\(\)/.test(layout));
  ok('ESC 能关闭菜单', /Escape/.test(layout));
}

// ─────────────────────────────────────────────────────────────────────────────
// 自检：禁缩放的正则**真的能抓到**、且**不会被注释绊倒**
//
// 这段检查修过两次，两次都是被自检抓出来的：
//   假红 —— 注释里写「不要用 user-scalable=no」会被整份文本扫到。
//          本项目两个入口的注释里恰好提到这两个词，只是因为没写 `=` 才侥幸没踩。
//   漏报 —— `user-scalable=0` 与 `no` 同效（尤其 Android），原正则只拦 `no`。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n【自检：禁缩放判定的假红与漏报】');
{
  const forbidden = (html) => {
    const visible = stripHtmlComments(html);
    return FORBIDDEN_ZOOM.some(({ re }) => re.test(visible));
  };

  // a. 剥注释：这是修掉的假红
  ok('自检：注释里的 user-scalable=no 不算违规',
    forbidden('<!-- 不要写 user-scalable=no --><meta name="viewport" content="width=device-width">') === false);
  ok('自检：注释里的 maximum-scale=1 不算违规',
    forbidden('<!-- maximum-scale=1 是缺陷掩盖缺陷 --><meta name="viewport" content="width=device-width">') === false);
  ok('自检：多行注释同样被剥掉',
    forbidden('<!--\n  说明：\n  不要用 user-scalable=no\n--><meta content="width=device-width">') === false);

  // b. 真实属性必须被抓（含原本漏掉的 user-scalable=0）
  ok('自检：user-scalable=no 被抓', forbidden('content="user-scalable=no"') === true);
  ok('自检：user-scalable=0 被抓（原正则漏了这种）', forbidden('content="user-scalable=0"') === true);
  ok('自检：大小写不敏感（user-scalable=NO）', forbidden('content="USER-SCALABLE=NO"') === true);
  ok('自检：maximum-scale=1 被抓', forbidden('content="maximum-scale=1"') === true);
  ok('自检：maximum-scale=1.0 被抓', forbidden('content="maximum-scale=1.0"') === true);
  ok('自检：maximum-scale=1 无引号尾随也能抓（原正则要求后跟分隔符）',
    forbidden('content=maximum-scale=1>') === true);

  // c. 合法写法不能被误判
  ok('自检：正常 viewport 通过', forbidden('content="width=device-width, initial-scale=1.0"') === false);
  ok('自检：maximum-scale=1.5 通过（允许放大）', forbidden('content="maximum-scale=1.5"') === false);
  ok('自检：maximum-scale=2 通过', forbidden('content="maximum-scale=2"') === false);
  ok('自检：user-scalable=yes 通过', forbidden('content="user-scalable=yes"') === false);
  ok('自检：initial-scale=1 不算限死缩放（它是初始值，不是上限）',
    forbidden('content="initial-scale=1"') === false);

  // d. 空输入的陷阱：否定断言在空串上永远通过，所以真实文件必须非空
  ok('自检：空串上任何禁用写法都「通过」（所以要另有断言保证文件非空）',
    forbidden('') === false);
  ok('真实 index.html 非空', indexHtml.length > 100, String(indexHtml.length));
  ok('真实 home.html 非空', homeHtml.length > 100, String(homeHtml.length));

  // e. viewport 提取
  const vp = (html) => {
    const m = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/i);
    return m ? m[1] : null;
  };
  ok('自检：能提取 viewport content',
    vp('<meta name="viewport" content="width=device-width">') === 'width=device-width');
  ok('自检：没有 viewport 时返回 null（不是空串）',
    vp('<meta charset="utf-8">') === null);
  ok('自检：属性顺序颠倒时不匹配（已知限制，所以真实文件用的是标准顺序）',
    vp('<meta content="width=device-width" name="viewport">') === null);

  // f. 真实文件的 viewport 确实带这两项（否则上面的断言全是空转）
  const realVp = vp(stripHtmlComments(indexHtml));
  ok('真实 index.html 的 viewport 能提取到', !!realVp, String(realVp));
  ok('真实 viewport 含 viewport-fit=cover', /viewport-fit\s*=\s*cover/i.test(realVp || ''));
  ok('真实 viewport 含 interactive-widget=resizes-content',
    /interactive-widget\s*=\s*resizes-content/i.test(realVp || ''));
}

console.log('\n【超长文本不能撑破布局（用户可控的标题/名称）】');
{
  // 实测过的问题：`.detail-title` 用 clamp(1.85rem, 4vw, 2.6rem) 放大字号，
  // 但没有任何断行保护 —— 一个超长英文单词或长 URL 会横向撑破容器，
  // 在窄屏上直接把整页撑出横向滚动条（比"文字换行难看"严重得多：
  // 横向滚动条会让固定定位的头部错位）。
  //
  // 判据：用户可控 + 可能超长的**标题类**容器必须有 overflow-wrap / word-break。
  // 不检查正文（markdown.css 已统一处理），也不检查已经有的（NoteCard / CommentItem / AskAi）。
  const titleContainers = [
    ['src/views/site/ArticleDetail.vue', '.detail-title', '文章标题（作者可控）'],
    ['src/views/site/Links.vue', '.link-name', '友链名称（访客申请时填写）'],
    ['src/views/site/Archive.vue', '.tl-title', '归档条目标题'],
  ];
  for (const [file, sel, why] of titleContainers) {
    const src = read(file);
    // 取该选择器的规则体（到下一个 } 或 400 字符内）
    const re = new RegExp(sel.replace('.', '\\.') + '\\s*\\{([\\s\\S]{0,400}?)\\}');
    const m = src.match(re);
    ok(`${sel} 存在`, !!m, `${file} 里找不到该规则`);
    if (!m) continue;
    ok(`${sel} 有断行保护（${why}）`,
      /overflow-wrap\s*:\s*(anywhere|break-word)|word-break\s*:\s*break-word/.test(m[1]),
      '超长英文单词或长 URL 会撑破容器 → 窄屏出现横向滚动条');
  }

  // 反向：不许用 `word-break: break-all` —— 它会把中文也逐字断开，比溢出更难看
  const allVue = ['src/views/site/ArticleDetail.vue', 'src/views/site/Links.vue', 'src/views/site/Archive.vue']
    .map((f) => read(f)).join('\n');
  ok('没有用 word-break: break-all（会把中文逐字断开）',
    !/word-break\s*:\s*break-all/.test(allVue));

  // 自检：判据真的能区分
  ok('自检：overflow-wrap: anywhere 被判为有保护',
    /overflow-wrap\s*:\s*(anywhere|break-word)|word-break\s*:\s*break-word/.test('  overflow-wrap: anywhere;'));
  ok('自检：完全没有断行规则的规则体被判为无保护',
    !/overflow-wrap\s*:\s*(anywhere|break-word)|word-break\s*:\s*break-word/.test('  font-size: 2rem;\n  margin: 0;'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1)
