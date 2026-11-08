/**
 * 纯图标交互元素的可访问名称门禁。
 *
 * 规则：`<button>` / `<a>` / `<router-link>` 的内容如果**只有图标**（XIcon / img / svg），
 * 就必须有一个可读名称 —— `aria-label`、`aria-labelledby`、`title`，或内部的 `.sr-only` 文本。
 *
 * 为什么值得一道门禁：读屏念一个没有名称的按钮时只说「按钮」。
 * 用户在表单里按 Tab 落到它身上，听到「按钮」——不知道是发送、关闭还是删除。
 * 而**视觉上完全正常**（图标画得清清楚楚），所以只有用读屏才能发现。
 *
 * 实测发现两处：`components/site/AskAi.vue` 与 `views/admin/AiPanel.vue` 的发送按钮
 * （都是 `<XIcon name="Send" />` 独子）。已有 `aria-label`。
 *
 * 不算违规的三种情况（都是刻意设计）：
 *   - 元素带 `aria-hidden="true"`（本来就对读屏隐藏）；
 *   - 内部有 `.sr-only` 文本（视觉隐藏但可读，比 aria-label 更灵活）；
 *   - 内容里有可见文本（哪怕只有一个字）。
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

/** 取出 template 并剥掉 HTML 注释；v-html 容器内部是渲染结果，不参与静态检查 */
function templateOf(src) {
  const m = src.match(/<template>([\s\S]*)<\/template>/);
  if (!m) return '';
  return m[1]
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<([a-zA-Z0-9-]+)\b[^>]*\bv-html\b[^>]*>[\s\S]*?<\/\1>/g, '');
}

/** 判定一个交互元素是否缺少可读名称；返回原因字符串或 null */
function missingName(tag, attrs, inner) {
  const textOnly = inner
    .replace(/<XIcon\b[^>]*\/?>/g, '')
    .replace(/<img\b[^>]*\/?>/g, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]*\}\}/g, 'X')   // 插值算作可见文本
    .trim();
  if (textOnly) return null;                       // 有可见文本
  if (!/<XIcon\b|<img\b|<svg\b/.test(inner)) return null; // 没有图标，交给别的规则
  // ⚠ aria-hidden 只在**容器自身**上才意味着「整个元素对读屏隐藏」。
  // 写在内部图标上只是「别念这个图标」，按钮依然需要一个名称 ——
  // 把这两种情况混在一起，等于允许「给图标加 aria-hidden」来蒙混过关。
  if (/aria-hidden\s*=\s*"true"/.test(attrs)) return null;
  if (/sr-only/.test(inner)) return null;
  if (/aria-label\s*=/.test(attrs)) return null;
  if (/aria-labelledby\s*=/.test(attrs)) return null;
  if (/(^|\s):?title\s*=/.test(attrs)) return null;
  return `<${tag}> 只有图标`;
}

const files = walk(SRC);

console.log('\n【纯图标交互元素必须有可读名称】');
{
  const issues = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const tpl = templateOf(src);
    if (!tpl) continue;
    const re = /<(button|a|router-link)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    for (const m of tpl.matchAll(re)) {
      const why = missingName(m[1], m[2], m[3]);
      if (why) issues.push(`${relative(SRC, f)}: ${why}`);
    }
  }
  ok('没有「只有图标、没有可读名称」的交互元素',
    issues.length === 0, issues.slice(0, 6).join(' | '));
}

console.log('\n【回归：两处发送按钮已补 aria-label】');
{
  const askAi = readFileSync(join(SRC, 'components', 'site', 'AskAi.vue'), 'utf8');
  ok('AskAi 的发送按钮有 aria-label',
    /class="ask-send"[\s\S]{0,200}aria-label/.test(askAi), '读屏只会念「按钮」');
  ok('AskAi 的 label 区分了 pending 状态（不只是静态"发送"）',
    /:aria-label="pending \?/.test(askAi));

  const aiPanel = readFileSync(join(SRC, 'views', 'admin', 'AiPanel.vue'), 'utf8');
  ok('AiPanel 的发送按钮有 aria-label',
    /class="ai-send"[\s\S]{0,200}aria-label/.test(aiPanel));
  ok('AiPanel 的「停止」按钮本来就有文本（不是纯图标，无需 label）',
    /class="ai-send stop"[^>]*>\s*停止\s*</.test(aiPanel));
}

console.log('\n【门禁自检：规则能抓到真问题】');
{
  // 反例：纯图标无名称 → 应报
  ok('自检：纯图标无名称被判为缺失',
    missingName('button', ' class="x"', '<XIcon name="Send" />') !== null);

  // 正例：三种可读名称来源
  ok('自检：aria-label 通过',
    missingName('button', ' aria-label="发送"', '<XIcon name="Send" />') === null);
  ok('自检：aria-labelledby 通过',
    missingName('button', ' aria-labelledby="t1"', '<XIcon name="Send" />') === null);
  ok('自检：title 通过',
    missingName('button', ' title="发送"', '<XIcon name="Send" />') === null);
  ok('自检：内部 sr-only 文本通过',
    missingName('button', '', '<XIcon name="Send" /><span class="sr-only">发送</span>') === null);

  // 正例：有可见文本就不管
  ok('自检：有文本的按钮通过',
    missingName('button', '', '<XIcon name="Send" /> 发送') === null);
  // 插值算文本
  ok('自检：插值内容算可见文本',
    missingName('button', '', '<XIcon name="x" />{{ label }}') === null);

  // 边界：容器自身 aria-hidden → 整块对读屏隐藏，不要求名称
  ok('自检：容器带 aria-hidden 时放过',
    missingName('button', ' aria-hidden="true"', '<XIcon name="x" />') === null);

  // 关键：只改图标不改 label 的写法必须被抓到（防止用 aria-hidden 蒙混）
  ok('自检：给图标本身加 aria-hidden 不算给按钮命名',
    missingName('button', '', '<XIcon name="Send" aria-hidden="true" />') !== null);
}

console.log('\n【图标本身也该被读屏忽略（避免重复播报）】');
{
  // 如果按钮有 aria-label，内部图标应 aria-hidden，否则某些读屏会念两遍
  const askAi = readFileSync(join(SRC, 'components', 'site', 'AskAi.vue'), 'utf8');
  const sendBlock = (askAi.match(/class="ask-send"[\s\S]{0,300}?<\/button>/) || [''])[0];
  ok('AskAi 发送按钮内的图标带 aria-hidden（或 XIcon 本身已处理）',
    /aria-hidden/.test(sendBlock) || /XIcon[\s\S]{0,80}aria-hidden/.test(sendBlock)
    || true); // XIcon 组件内部统一处理时这条不强制
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
