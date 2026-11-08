/**
 * 可交互元素的语义门禁：**能用鼠标点的，必须能用键盘到、读屏能念**。
 *
 * 为什么单独成文件而不塞进 test-focus-visible（那已经有 887 条）：
 *   focus-visible 管的是「焦点环长什么样」，这里管的是「哪些东西该是可聚焦的」——
 *   两者会各自演化，混在一起后改一处要读一千行。
 *
 * 检查口径（只看**真实的交互**，不是所有带 class 的元素）：
 *   1. 模板里带 `@click` / `@dblclick` / `@keydown.enter` 的非原生交互元素
 *      （div / span / li / img / p / section / article）
 *   2. 必须同时满足下列之一才算合规：
 *      - 是原生可交互标签：button / a[href] / input / select / textarea / label[for]
 *      - 或显式带 `role="button"` + `tabindex="0"` + 键盘事件（role 声明了就要兑现）
 *   3. `aria-hidden="true"` 的纯装饰元素不算交互（它本来就该被读屏忽略）
 *
 * 例外白名单：有些点击是「点遮罩关闭」这类辅助行为，元素本身有更明确的关闭出口。
 * 白名单必须写明**为什么**能放过，不能只写文件名 —— 否则下一个人只会往里加。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 原生可交互标签（自带键盘与读屏语义） */
const NATIVE = /^(button|a|input|select|textarea|summary|label|option|router-link)$/i;

/**
 * 组件库里自带语义的标签前缀。
 * Element Plus 的 `<el-button>` 最终渲染成原生 `<button>`（含 focus/keydown），
 * 对它要求"补 role+tabindex"是错的 —— 它本来就有。
 */
const COMPONENT_SAFE = /^el-|^x-icon$/i;

/**
 * 只检查**真正的可激活交互**：`@click`（且不是 `.self`）。
 *
 * 刻意排除的几类，各有理由：
 *   - `@click.self`：遮罩层「点空白关闭」。这是通用约定，且每个弹层都有 Esc
 *     （useFocusTrap 统一处理）或显式关闭按钮，键盘用户不缺出口。
 *     把遮罩做成 button 反而会给读屏多塞一个无名控件。
 *   - `@wheel` / `@mousedown` / `@mouseenter` 等：鼠标专有手势（缩放、拖拽、悬停）。
 *     它们**不该**被键盘化（键盘用户走 +/− 与方向键，另有实现），
 *     强行加 tabindex 只会制造噪音。
 *   - `@dblclick` / `@contextmenu`：双击 / 右键，同样有显式按钮入口。
 */
const CLICK_ATTR = /@click(?!\.self)[.\w]*\s*=/;

function readTemplates() {
  const files = globSync('**/*.vue', { cwd: SRC });
  return files.map((f) => ({ file: f, src: readFileSync(resolve(SRC, f), 'utf8') }));
}

/**
 * 粗粒度但足够稳：把 <template> 段落按 `>` 切出起始标签，
 * 对每个起始标签判断「是否非原生 + 有交互事件 + 无补偿属性」。
 * 注释先剥离，避免把注释里的示例当成真代码。
 */
function scanTemplate(file, src) {
  const tplMatch = src.match(/<template>([\s\S]*)<\/template>/);
  if (!tplMatch) return [];
  const tpl = tplMatch[1]
    .replace(/<!--[\s\S]*?-->/g, '')       // HTML 注释
    .replace(/\{\{[\s\S]*?\}\}/g, '');     // 插值里的表达式

  const findings = [];
  // 起始标签：<tag ... >（非贪婪到第一个 '>'，属性值里没有裸 '>'）
  const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(tpl)) !== null) {
    const tag = m[1];
    const attrs = m[2] || '';
    if (NATIVE.test(tag)) continue;
    if (COMPONENT_SAFE.test(tag)) continue;
    if (!CLICK_ATTR.test(attrs)) continue;
    if (/aria-hidden\s*=\s*["']true["']/.test(attrs)) continue;
    // v-html 容器上的 click 是**事件委托**（点正文里的代码复制按钮、点图片放大），
    // 容器本身不是控件，给它加 tabindex 会让读屏把整篇文章念成一个"按钮"。
    if (/\bv-html\b/.test(attrs)) continue;
    // 遮罩层：点空白关闭。与 @click.self 同义，只是写成了显式 handler。
    // 每个弹层都有 Esc（useFocusTrap）或显式关闭按钮，键盘用户不缺出口。
    if (/class="[^"]*\b(mask|scrim|overlay)\b/.test(attrs)) continue;

    const hasRoleButton = /role\s*=\s*["'](button|link|menuitem|switch)["']/.test(attrs);
    const hasTabindex = /tabindex\s*=\s*["']?0["']?/.test(attrs);
    const hasKey = /@(keydown|keyup|keypress)/.test(attrs);

    if (hasRoleButton && hasTabindex && hasKey) continue;
    findings.push({ tag, snippet: `<${tag}${attrs}>`.replace(/\s+/g, ' ').slice(0, 140) });
  }
  return findings;
}

/**
 * 例外白名单：key = `<文件相对路径>`，value = 理由。
 * 只允许「点遮罩/背景关闭弹层且另有明确关闭按钮」这一种情形。
 */
const ALLOWLIST = new Map([
  // 遮罩层：点空白处关闭是通用约定，且弹层内都有 Esc 或关闭按钮（useFocusTrap + 显式叉号）
]);

function isAllowed(file) {
  return ALLOWLIST.has(file);
}

console.log('\n【非原生可交互元素必须有键盘与读屏语义】');
{
  const templates = readTemplates();
  ok('扫描到 Vue 模板文件（防止 glob 失效导致"零文件=零问题"）', templates.length > 30, `${templates.length} 个`);

  const all = [];
  for (const { file, src } of templates) {
    if (isAllowed(file)) continue;
    for (const f of scanTemplate(file, src)) all.push({ file, ...f });
  }

  if (all.length === 0) {
    ok('所有带 @click 的非原生元素都已改成原生标签或补齐 role+tabindex+键盘事件', true);
  } else {
    for (const f of all) {
      ok(`${f.file}: <${f.tag}> 需要键盘可达`,
        false, `${f.snippet}（改成 button，或补 role="button" tabindex="0" + @keydown.enter/space）`);
    }
  }
}

console.log('\n【逐个复核这次修过的三处（防回退）】');
{
  const ci = readFileSync(resolve(SRC, 'components/site/CommentItem.vue'), 'utf8');
  ok('CommentItem 头像已改成 button（不是 div + @click）',
    /<button[\s\S]{0,200}class="avatar"/.test(ci));
  ok('CommentItem 头像有 aria-label 说明它会做什么',
    /class="avatar"[\s\S]{0,300}aria-label="`回复 \$\{comment\.nickname\} 的评论`"/.test(ci)
    || /aria-label="[^"]*回复[^"]*"/.test(ci));
  ok('CommentItem 首字母对读屏隐藏（避免念孤字）',
    /<span aria-hidden="true">\{\{ initial \}\}<\/span>/.test(ci));
  ok('CommentItem 时间戳已改成 button',
    /<button[\s\S]{0,240}class="time"/.test(ci));
  ok('CommentItem 时间戳 button 有 aria-label',
    /class="time"[\s\S]{0,240}aria-label="复制这条评论的链接"/.test(ci));
  ok('button 化的时间戳清掉了 UA 默认样式（appearance/background/border/padding）',
    /\.time \{[\s\S]{0,400}appearance: none;[\s\S]{0,200}background: none;[\s\S]{0,200}border: 0;[\s\S]{0,200}padding: 0;/.test(ci));
  ok('button 化的头像清掉了 UA 默认样式',
    /\.avatar \{[\s\S]{0,300}appearance: none;[\s\S]{0,300}padding: 0;/.test(ci));
}

console.log('\n【加载态：视觉隐藏 + 语音播报，两者分开】');
{
  const sk = readFileSync(resolve(SRC, 'components/ui/SkeletonList.vue'), 'utf8');
  ok('骨架屏有 sr-only 的 role="status"（加载中要能被听见）',
    /class="sr-only"[^>]*role="status"/.test(sk) || /role="status"[^>]*class="sr-only"/.test(sk));
  ok('播报文案具体（不是空白 live region）', /内容加载中/.test(sk));
  ok('灰色骨架块本身对读屏隐藏（它们没有语义）', /aria-hidden="true"/.test(sk));
  ok('外层不再挂 aria-hidden（否则会把内部播报一起藏掉）',
    !/<div class="skeleton-list" aria-hidden/.test(sk));

  // 调用方不能再用 aria-hidden 覆盖组件根元素
  for (const f of ['views/site/ArticleList.vue', 'views/site/Messages.vue', 'views/site/Links.vue', 'views/site/Home.vue']) {
    const src = readFileSync(resolve(SRC, f), 'utf8');
    const tags = src.match(/<SkeletonList[^>]*>/g) || [];
    ok(`${f}: 不给 SkeletonList 传 aria-hidden（会连带隐藏播报）`,
      tags.every((t) => !/aria-hidden/.test(t)), tags.join(' | '));
  }
}

console.log('\n【筛选组：一串按钮要说清"在筛什么"】');
{
  const al = readFileSync(resolve(SRC, 'views/site/ArticleList.vue'), 'utf8');
  ok('分类 chip 组有 role="group"', /role="group" aria-labelledby="filter-category-label"/.test(al));
  ok('标签 chip 组有 role="group"', /role="group" aria-labelledby="filter-tag-label"/.test(al));
  ok('被引用的 label 元素确实带对应 id',
    /id="filter-category-label"/.test(al) && /id="filter-tag-label"/.test(al));
  ok('aria-labelledby 指向的 id 必须在同一文件里存在（否则读屏念不出组名）',
    (al.match(/aria-labelledby="([^"]+)"/g) || []).every((m) => {
      const id = m.match(/"([^"]+)"/)[1];
      return al.includes(`id="${id}"`);
    }));
}

console.log('\n【表单：label 要绑到 input，且要是真的 form】');
{
  const lk = readFileSync(resolve(SRC, 'views/site/Links.vue'), 'utf8');
  ok('用的是 <form> 而不是 div（回车提交 + 原生校验）', /<form[\s>]/.test(lk));
  ok('form 上有 @submit.prevent（提交行为走同一个 handler）', /@submit\.prevent="submit"/.test(lk));

  const labels = lk.match(/<label class="field-label"([^>]*)>/g) || [];
  ok('找到多个表单项', labels.length >= 5, `${labels.length} 个`);
  ok('每个 label 都有 for', labels.every((l) => /for="[^"]+"/.test(l)), labels.join(' | '));

  // 必须排除 v-for="l in links" —— 它长得像 for=，会把循环变量当成 label 目标
  const fors = (lk.match(/(?<!v-)for="([^"]+)"/g) || []).map((m) => m.match(/"([^"]+)"/)[1]);
  ok('每个 for 都能在同文件里找到对应 id',
    fors.every((id) => lk.includes(`id="${id}"`)), fors.filter((id) => !lk.includes(`id="${id}"`)).join(', '));
  ok('标了 * 的字段加了 required（让浏览器先拦一次）',
    /id="link-name"[^>]*required/.test(lk) && /id="link-url"[^>]*required/.test(lk));
  ok('提交按钮是 type="submit"（回车与点击走同一条路径）',
    /<button type="submit" class="apply-btn"/.test(lk));
  ok('提交按钮不再额外绑 @click（否则会双触发）',
    !/class="apply-btn"[^>]*@click/.test(lk));
}

console.log('\n【表情按钮：读屏文案 + 触摸目标】');
{
  const ep = readFileSync(resolve(SRC, 'components/ui/EmojiPicker.vue'), 'utf8');
  ok('表情按钮有 aria-label（不只靠 title）', /:aria-label="'插入表情 ' \+ e"/.test(ep));
  ok('title 仍保留（鼠标用户需要悬停提示）', /:title="e"/.test(ep));
  const m = ep.match(/\.emoji-btn \{[\s\S]{0,900}?width:\s*(\d+)px[\s\S]{0,80}?height:\s*(\d+)px/);
  ok('表情按钮尺寸已提到 32px（30px + 4px 间距的中心距只有 34px，易误触）',
    !!m && Number(m[1]) >= 32 && Number(m[2]) >= 32, m ? `${m[1]}×${m[2]}` : '未匹配');
  ok('没有盲目做到 36px（8 列会撑破窄屏面板）', !!m && Number(m[1]) < 36, m ? m[1] : '');
}

console.log('\n【门禁自检：扫描器本身不能失灵】');
{
  // 反例：应当被抓出来
  const bad = `<template><div><span @click="x">hi</span></div></template>`;
  ok('扫描器能抓出 div/span + @click', scanTemplate('x.vue', bad).length === 1,
    JSON.stringify(scanTemplate('x.vue', bad)));

  // 正例：改成 button 后不该报
  const good = `<template><div><button @click="x">hi</button></div></template>`;
  ok('原生 button 不报', scanTemplate('x.vue', good).length === 0);

  // 正例：补齐 role+tabindex+键盘
  const fixed = `<template><div><span role="button" tabindex="0" @click="x" @keydown.enter="x">hi</span></div></template>`;
  ok('role+tabindex+键盘齐全时不报', scanTemplate('x.vue', fixed).length === 0);

  // 反例：只加 tabindex 不够（role 声明了行为就要兑现键盘）
  const partial = `<template><div><span tabindex="0" @click="x">hi</span></div></template>`;
  ok('只加 tabindex 不兑现键盘 → 仍然报', scanTemplate('x.vue', partial).length === 1);

  // 装饰元素放过
  const deco = `<template><div><i aria-hidden="true" @click="x"></i></div></template>`;
  ok('aria-hidden="true" 的装饰元素放过', scanTemplate('x.vue', deco).length === 0);

  // 注释里的示例不算
  const commented = `<template><!-- <span @click="x">demo</span> --><div></div></template>`;
  ok('注释里的示例不算违规', scanTemplate('x.vue', commented).length === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
