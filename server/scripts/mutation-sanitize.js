#!/usr/bin/env node
/**
 * sanitize.js 的变异测试 —— 输入清洗防线的有效性验证。
 *
 * 为什么需要它：断言数量不等于防御力。第一轮跑下来 **15 个变异里 8 个存活** ——
 * 包括「cleanText 允许所有 HTML 标签」（存储型 XSS）和「privateSuffixes 漏掉 .local」
 * 这两条安全关键防线，而当时整套测试是全绿的。
 *
 * 根因：`sanitize.test.js` 只 import 了 4 个函数，而模块导出 8 个 ——
 * `cleanText` / `cleanLine` / `sliceSafe` / `escapeLike` / `safeUploadRel` 从未被直接调用。
 * 补齐后从 43 条断言涨到 106 条，变异存活归零。
 *
 * 每条变异都是「删掉一条防线」或「把边界改成错的」，不是随机改字符 ——
 * 随机改字符大多变成语法错误，测出来的是「测试能不能发现语法错误」，那没有意义。
 *
 * 用法：
 *   node scripts/mutation-sanitize.js
 *   node scripts/mutation-sanitize.js --strict   # 有存活变异时 exit 1
 */

'use strict';

const { join } = require('path');
const { runMutations } = require('./lib/mutation-runner');

const ROOT = join(__dirname, '..');
const TARGET = join(ROOT, 'src', 'utils', 'sanitize.js');
const TEST = join(ROOT, 'test', 'sanitize.test.js');

const MUTATIONS = [
  {
    id: 'M01',
    desc: 'cleanText 允许所有 HTML 标签（→ 存储型 XSS）',
    from: '    allowedTags: [],           // 不允许任何 HTML 标签',
    to: '    allowedTags: false,        // 注入：全部放行',
  },
  {
    id: 'M02',
    desc: 'sliceSafe 不处理被劈开的代理对（→ 入库即损坏的孤立代理）',
    from: "  if (/[\\uD800-\\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);",
    to: '  // 注入：不检查代理对',
  },
  {
    id: 'M03',
    desc: 'sliceSafe 边界差一（s.length <= maxLen → < maxLen）',
    from: '  if (s.length <= maxLen) return s;',
    to: '  if (s.length < maxLen) return s;',
    // **等价变异**：当 s.length === maxLen 时走 else 分支，
    // s.slice(0, maxLen) 仍是整个字符串，代理对检查也不会触发 → 结果相同。
    // 记在这里是为了说明「存活 ≠ 盲区」，而不是把它当成需要修的缺陷。
    equivalent: true,
  },
  {
    id: 'M04',
    desc: 'cleanLine 不把换行折成空格（→ 昵称里能塞多行）',
    from: "  return cleanText(input, maxLen).replace(/[\\r\\n]+/g, ' ').trim();",
    to: '  return cleanText(input, maxLen).trim();',
  },
  {
    id: 'M05',
    desc: 'safeUrl 允许 URL 内嵌凭据（→ 钓鱼样式 / 抓取被滥用）',
    from: '    if (url.username || url.password) return \'\';',
    to: '    // 注入：不拦凭据',
  },
  {
    id: 'M06',
    desc: 'safeUrl 允许 IPv6 字面量（→ 回环/链路本地直连）',
    from: "    if (host.includes(':')) return '';",
    to: '    // 注入：不拦 IPv6',
  },
  {
    id: 'M07',
    desc: 'safeUrl 主机名黑名单漏掉 .local（→ mDNS 本地域名）',
    from: "    const privateSuffixes = ['.local', '.localhost', '.localdomain', '.internal', '.lan', '.home'];",
    to: "    const privateSuffixes = ['.localhost', '.localdomain', '.internal', '.lan', '.home'];",
  },
  {
    id: 'M08',
    desc: 'safeUrl 允许 IPv4 字面量（→ SSRF / 跨站追踪）',
    from: "    if (/^[\\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return '';",
    to: '    // 注入：不拦 IP 字面量',
  },
  {
    id: 'M09',
    desc: 'safeUrl 不拦 localhost',
    from: "    if (!host || host === 'localhost' || privateSuffixes.some((s) => host.endsWith(s))) return '';",
    to: '    if (!host || privateSuffixes.some((s) => host.endsWith(s))) return \'\';',
  },
  {
    id: 'M10',
    desc: 'escapeLike 不转义反斜杠（→ LIKE 转义序列被构造）',
    from: '  return String(input).replace(/[\\\\%_]/g, (m) => `\\\\${m}`);',
    to: '  return String(input).replace(/[%_]/g, (m) => `\\\\${m}`);',
  },
  {
    id: 'M11',
    desc: 'safeUploadRel 允许三层目录（→ 引用/孤儿清理边界失守）',
    from: '  if (segs.length > 2) return \'\';',
    to: '  if (segs.length > 3) return \'\';',
  },
  {
    id: 'M12',
    desc: 'safeUploadRel 不拦 . 与 ..（→ 路径穿越）',
    from: "    if (seg === '.' || seg === '..') return '';",
    to: '    // 注入：不拦点段',
    // **等价变异**：下一行的段正则 `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$`
    // 首字符类不含 `.`，`..` 本来就过不去。显式检查是冗余的第二道防线。
    equivalent: true,
  },
  {
    id: 'M13',
    desc: 'safeCover 放行任意站内路径（→ <img src> 注入 javascript:）',
    from: "  if (v === '/logo.png') return v;",
    to: '  return v;   // 注入：任意路径直接放行',
  },
  {
    id: 'M14',
    desc: 'cleanMarkdown 丢掉 exclusiveFilter（→ <script> 原样入库）',
    from: '    exclusiveFilter: (frame) => MARKDOWN_BAD_TAGS.includes(frame.tag),',
    to: '    // 注入：不丢弃高危标签帧',
  },
  {
    id: 'M15',
    desc: 'cleanMarkdown 不允许任何标签（→ 正文里的正常 HTML 被剥光）',
    from: '    allowedTags: false, // 允许一般 HTML 标签（如 <div>, <span>, <table>, <img>, <details> 等）',
    to: '    allowedTags: [],    // 注入：过度清洗',
  },
];

const result = runMutations({
  title: 'sanitize.js（输入清洗）',
  target: TARGET,
  test: TEST,
  mutations: MUTATIONS,
  root: ROOT,
});

if (result.baselineFailed) process.exit(1);
if (result.survived > 0 && process.argv.includes('--strict')) {
  console.log('\n--strict 模式：存活变异视为失败');
  process.exit(1);
}
