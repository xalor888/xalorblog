/**
 * Markdown 渲染缓存（真跑 jsdom-free 的正则/字符串链路…… 不行，marked 需要 DOM？）
 *
 * 实际上 `renderMarkdown` 依赖 DOMPurify，而 DOMPurify 需要 window。
 * 本脚本因此**不直接 import 那个模块**，而是：
 *   1. 用源码契约钉住「缓存不绕过 sanitize」这件事；
 *   2. 用一个等价的纯字符串模型验证 LRU 语义（容量、淘汰顺序、命中不重算）。
 *
 * 为什么必须钉「不绕过 sanitize」：缓存最危险的误用是
 * 「先查缓存 → 未命中就直接返回 marked.parse 的结果」，那样一口气跳过净化，
 * XSS 立刻回来，而所有功能测试仍然全绿（因为输出看起来一样）。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentLines } from './lib/sourceText.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  // 成功项也打印：其他 19 道门禁都是这样，这里原来只在失败时输出。
  // 差异的实际后果是「怀疑断言到底跑没跑」—— 排查时看不到清单，
  // 就没法确认新加的那条是不是真的在跑（这次加 4 条 AiPanel 断言时正是这个感觉）。
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const md = readFileSync(resolve(SRC, 'utils/markdown.js'), 'utf8');
// 剥注释统一走 lib/sourceText：这类「某写法不许出现」的断言已经被注释绊倒过三次
const code = stripCommentLines(md);

console.log('\n【缓存必须包住整条净化链路】');
{
  // 命中路径只返回缓存，未命中路径必须包含 marked.parse 与 DOMPurify.sanitize
  const fnStart = code.indexOf('export function renderMarkdown');
  // 必须显式处理「没找到」的情况。
  // 不能依赖 `code.slice(-1, 1199)` 的巧合：那个表达式只有在文件长度 > 1199 时才返回空串
  // （start 在末尾、end 在前面 → 空）。文件一旦变短，它会返回**最后 1 个字符**，
  // 于是下面所有「某写法不许出现」的否定断言都会在那一小段上判定 —— 结果不可预期。
  const fnBody = fnStart < 0 ? '' : code.slice(fnStart, fnStart + 1200);
  ok('找到 renderMarkdown 实现', fnStart > -1);
  ok('函数体非空（提取失败时是空串，而不是文件末尾的残片）', fnBody.length > 0);
  ok('未命中路径调用 marked.parse', /marked\.parse\(/.test(fnBody));
  ok('未命中路径调用 DOMPurify.sanitize', /DOMPurify\.sanitize\(/.test(fnBody));
  ok('缓存写入的是**净化后**的 html（不是 raw）',
    /const html = DOMPurify\.sanitize\([\s\S]{0,200}\);\s*\n[\s\S]{0,400}renderCache\.set\(key, html\)/.test(fnBody));
  ok('不存在「直接返回 marked.parse 结果」的捷径',
    !/return marked\.parse\(/.test(fnBody));
  ok('命中路径在净化之前返回（早退）',
    fnBody.indexOf('if (cached !== undefined) return cached;') < fnBody.indexOf('marked.parse('));
}

console.log('\n【LRU 语义：等价模型验证】');
{
  const MAX = 40;
  const seen = new Map();
  let computes = 0;
  /** 与 renderMarkdown 的缓存策略逐行等价 */
  function cachedRender(text) {
    const key = String(text);
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    computes++;
    const value = `html(${key})`;
    if (seen.size >= MAX && !seen.has(key)) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.set(key, value);
    return value;
  }

  ok('首次渲染算一次', cachedRender('a') === 'html(a)' && computes === 1, String(computes));
  ok('重复渲染命中缓存（不再计算）', cachedRender('a') === 'html(a)' && computes === 1, String(computes));
  ok('不同内容各自计算', cachedRender('b') === 'html(b)' && computes === 2, String(computes));

  // 填满到上限
  for (let i = 0; i < MAX; i++) cachedRender(`k${i}`);
  const before = computes;
  ok('仍在容量内时命中不重算', cachedRender('k0') === 'html(k0)' && computes === before);
  ok('容量已满（含早期两条 + MAX 条）', seen.size === MAX, String(seen.size));

  // 再写一条 → 最旧的那条被淘汰
  cachedRender('newest');
  ok('超上限后 size 不增长', seen.size === MAX, String(seen.size));
  ok('最旧的一条已被淘汰（k0 会重新计算）', (() => {
    const c = computes;
    cachedRender('k0');
    return computes === c + 1;
  })());
  ok('新写入的仍在缓存里', (() => {
    const c = computes;
    cachedRender('newest');
    return computes === c;
  })());
}

console.log('\n【源码契约：缓存有上限且可清空】');
{
  ok('有容量常量', /const RENDER_CACHE_MAX = \d+;/.test(code));
  ok('容量是有限值（不能无界增长）', (() => {
    const m = code.match(/const RENDER_CACHE_MAX = (\d+);/);
    return m && Number(m[1]) > 0 && Number(m[1]) <= 500;
  })());
  ok('超限时淘汰最旧（Map 插入序）',
    /renderCache\.keys\(\)\.next\(\)\.value/.test(code));
  ok('导出 clearRenderCache（测试与排查用）',
    /export function clearRenderCache/.test(md));
}

console.log('\n【组件侧：避免在热路径里反复渲染】');
{
  // 两处 AI 对话都要处理（前台 AskAi / 后台 AiPanel）。
  // 之前只修了 AskAi，AiPanel 一直在流式期间渲染 Markdown —— 回答长到几千字时
  // 每个 token 都要跑 marked.parse + DOMPurify + 三个后处理器，是 O(n²)。
  // 所以这里的断言成对出现：**新增一处 AI 对话就必须同时满足这两条**。
  const askAi = readFileSync(resolve(SRC, 'components/site/AskAi.vue'), 'utf8');
  ok('AskAi 流式期间用纯文本而不是渲染 Markdown（否则每个 token 都要 parse 全文）',
    /m\.streaming[\s\S]{0,300}ask-raw[\s\S]{0,120}\{\{ m\.content \}\}/.test(askAi));
  ok('AskAi 只有非流式内容才走 v-html renderMarkdown',
    /v-else-if="m\.content" class="ask-md" v-html="renderMarkdown\(m\.content\)"/.test(askAi));
  ok('AskAi 的纯文本容器保留换行（否则流式期间的换行全被折叠）',
    /\.ask-raw\s*\{[^}]*white-space:\s*pre-wrap/.test(askAi));

  const aiPanel = readFileSync(resolve(SRC, 'views/admin/AiPanel.vue'), 'utf8');
  ok('AiPanel 流式期间也用纯文本（与 AskAi 一致）',
    /m\.streaming[\s\S]{0,200}ai-raw[\s\S]{0,120}\{\{ m\.content \}\}/.test(aiPanel),
    '这块曾经只在 AskAi 修过，AiPanel 一直在每个 token 重渲染全文');
  ok('AiPanel 只有非流式内容才走 v-html renderMarkdown',
    /v-else-if="m\.content" class="ai-md" v-html="renderMarkdown\(m\.content\)"/.test(aiPanel));
  ok('AiPanel 的纯文本容器保留换行',
    /\.ai-raw\s*\{[^}]*white-space:\s*pre-wrap/.test(aiPanel));
}

// ─────────────────────────────────────────────────────────────────────────────
// 自检：这段「提取函数体再跑正则」的检查逻辑本身靠不靠得住
//
// 这道门禁是源码检查型（读 markdown.js 的文本、在函数体片段上跑正则），
// 所以有所有源码检查共同的隐患：**提取失败时，下面那些「某写法不许出现」的
// 否定断言会在错误的输入上判定，可能全绿**。下面几条把这件事钉死。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n【自检：函数体提取与否定断言的陷阱】');
{
  // 1) indexOf 失败时 slice 的真实行为 —— 这是当初写那行时没想清楚的地方
  const sample = 'a'.repeat(2000);
  const missing = sample.indexOf('export function notThere');
  ok('indexOf 找不到时返回 -1', missing === -1);
  // 文件够长时 slice(-1, 1199) 恰好是空串（start 在末尾、end 在前面）
  ok('长文件里 slice(-1, 1199) 巧合地是空串', sample.slice(-1, -1 + 1200) === '');
  // 但文件短的时候它返回最后一个字符 —— 所以不能依赖这个巧合
  const shortSample = 'abc';
  ok('短文件里 slice(-1, 2) 返回内容（不是空串）',
    shortSample.slice(-1, -1 + 1200).length > 0,
    JSON.stringify(shortSample.slice(-1, -1 + 1200)));

  // 2) 显式处理的写法：失败就给空串，行为确定
  const extract = (src) => {
    const at = src.indexOf('export function renderMarkdown');
    return at < 0 ? '' : src.slice(at, at + 1200);
  };
  ok('自检：提取失败返回空串', extract('const x = 1;') === '');
  ok('自检：提取成功返回函数体片段',
    extract('export function renderMarkdown() { return 1; }').includes('return 1'));

  // 3) 关键陷阱：否定断言在空串上永远通过
  ok('自检：空串上「不许出现 X」必然通过（所以必须先断言非空）',
    !/return marked\.parse\(/.test(''));
  ok('自检：非空函数体上同样的断言才有意义',
    !/return marked\.parse\(/.test('const html = DOMPurify.sanitize(x);'));
  ok('自检：真实违规会被抓到', /return marked\.parse\(/.test('return marked.parse(x);'));

  // 4) 真实文件确实能提取到（否则上面那组断言全靠前置那条兜）
  //    注意：fnStart / fnBody 是上面那个块作用域里的局部变量，这里访问不到 ——
  //    重新算一遍。这是本会话第二次在块作用域上栽跟头（上一次是 ADMIN_LAYOUT）。
  const realAt = code.indexOf('export function renderMarkdown');
  const realBody = realAt < 0 ? '' : code.slice(realAt, realAt + 1200);
  ok('真实 markdown.js 里能定位到 renderMarkdown', realAt > -1, String(realAt));
  ok('真实函数体长度在合理区间（不是空、也不是整份文件）',
    realBody.length > 100 && realBody.length <= 1200, String(realBody.length));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
