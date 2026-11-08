#!/usr/bin/env node
/**
 * antiSpam.js（硬拒层）的变异测试。
 *
 * 这是内容安全第一道也是最硬的一道：**命中即拒，不过 AI 审核、不进人工队列**。
 * 所以两类错误都没有补救机会：
 *   - 漏判 → 垃圾评论直接上线
 *   - 误判 → 真实访客被无复核地拒绝，只看到「内容包含不当关键词」
 *
 * 源码注释里记录了两个历史坑，本清单各设一条靶子：
 *   1. 拉丁词必须词边界匹配（`vx` 不能命中 `vxworks`）
 *   2. 自定义词必须转义正则元字符（`c++` 未转义会让 `new RegExp` 抛错 →
 *      异常上抛 → 评论接口整体 500，不是拒绝而是全站挂）
 *
 * 用法：
 *   node scripts/mutation-antispam.js
 *   node scripts/mutation-antispam.js --strict
 */

'use strict';

const { join } = require('path');
const { runMutations } = require('./lib/mutation-runner');

const ROOT = join(__dirname, '..');
const TARGET = join(ROOT, 'src', 'utils', 'antiSpam.js');
const TEST = join(ROOT, 'test', 'antiSpam.test.js');

const MUTATIONS = [
  // ---------- 词边界（历史坑 1） ----------
  {
    id: 'A01',
    desc: '**拉丁词不做词边界匹配**（vx 命中 vxworks，误伤所有含 vx 的技术词）',
    from: '    const matched = LATIN_WORD_RE.test(word)\n      ? new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`, \'i\').test(lower)\n      : lower.includes(word);',
    to: '    const matched = lower.includes(word);   // 注入：一律子串匹配',
  },
  {
    id: 'A02',
    desc: '去掉前置词边界（(?<![a-z0-9]) → 无，xwechat 命中 wechat）',
    from: '      ? new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`, \'i\').test(lower)',
    to: '      ? new RegExp(`${escapeRegExp(word)}(?![a-z0-9])`, \'i\').test(lower)',
  },
  {
    id: 'A03',
    desc: '去掉后置词边界（(?![a-z0-9]) → 无，vxworks 命中 vx）',
    from: '      ? new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`, \'i\').test(lower)',
    to: '      ? new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}`, \'i\').test(lower)',
  },

  // ---------- 转义（历史坑 2） ----------
  {
    id: 'A04',
    desc: '**自定义词不转义正则元字符**（c++ 让 new RegExp 抛错 → 接口 500）',
    from: "  return s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
    to: '  return s;   // 注入：不转义',
  },

  // ---------- 大小写 ----------
  {
    id: 'A05',
    desc: '中文词不转小写（大小写混排时漏判 —— 中文无大小写，主要影响拉丁词）',
    from: '  const lower = text.toLowerCase();',
    to: '  const lower = text;',
        // **等价变异**：`word` 本身已单独 toLowerCase，且正则带 `i` 标志 ——
        // 拉丁词走正则（大小写不敏感），中文词走 includes（无大小写概念）。
        // 所以 `lower` 是否小写不影响任何判定结果。
    equivalent: true,
  },

  // ---------- 空词 / 非字符串 ----------
  {
    id: 'A06',
    desc: '空词条目不跳过（空串 includes 恒真 → **命中一切文本**）',
    from: '    if (!word) continue;',
    to: '    // 注入：不跳过空词',
        // **等价变异**（实测确认）：`securitySettings.getCustomWords()` 已经过滤掉空串，
        // 而 SENSITIVE_WORDS 里也没有空条目（测试 A 组有断言）。空词根本到不了这个循环。
    equivalent: true,
  },
  {
    id: 'A07',
    desc: '非字符串输入不早返回（null/数字会抛 TypeError）',
    from: "  if (typeof text !== 'string' || !text.length) return [];",
    to: '  if (!text) return [];   // 注入：不检查类型',
  },

  // ---------- countLinks ----------
  {
    id: 'A08',
    desc: '**裸 www 域名不计数**（经典绕过：2 个 www 链接逃过硬拒层）',
    from: '  const matches = text.match(/https?:\\/\\/[^\\s]+|www\\.[a-z0-9-]+(\\.[a-z0-9-]+)+[^\\s]*/gi);',
    to: '  const matches = text.match(/https?:\\/\\/[^\\s]+/gi);   // 注入：只认协议链接',
  },
  {
    id: 'A09',
    desc: 'www 分支不要求二级域（单独的 "www." 也被当链接）',
    from: '  const matches = text.match(/https?:\\/\\/[^\\s]+|www\\.[a-z0-9-]+(\\.[a-z0-9-]+)+[^\\s]*/gi);',
    to: '  const matches = text.match(/https?:\\/\\/[^\\s]+|www\\.[^\\s]*/gi);',
  },
  {
    id: 'A10',
    desc: 'countLinks 非字符串时抛错（不返回 0）',
    from: "  if (typeof text !== 'string') return 0;",
    to: '  // 注入：不检查类型',
  },
  {
    id: 'A11',
    desc: 'countLinks 恒返回 1（有链接就够，不分多少）',
    from: '  return matches ? matches.length : 0;',
    to: '  return matches ? 1 : 0;',
  },
  {
    id: 'A12',
    desc: 'www 匹配去掉 g 标志（只找第一个，多链接漏计）',
    from: '  const matches = text.match(/https?:\\/\\/[^\\s]+|www\\.[a-z0-9-]+(\\.[a-z0-9-]+)+[^\\s]*/gi);',
    to: '  const matches = text.match(/https?:\\/\\/[^\\s]+|www\\.[a-z0-9-]+(\\.[a-z0-9-]+)+[^\\s]*/i);',
  },

  // ---------- antiSpam 阈值 ----------
  {
    id: 'A13',
    desc: '**链接阈值边界差一**（links > max → links >= max，恰好 3 条也被拒）',
    from: '  if (links > maxLinks) {',
    to: '  if (links >= maxLinks) {',
  },
  {
    id: 'A14',
    desc: '默认 maxLinks 从 3 改成 4',
    from: 'function antiSpam(text, maxLinks = 3) {',
    to: 'function antiSpam(text, maxLinks = 4) {',
  },
  {
    id: 'A15',
    desc: '自定义 maxLinks 参数被忽略（恒用 3）',
    from: '  if (links > maxLinks) {',
    to: '  if (links > 3) {',
  },
  {
    id: 'A16',
    desc: '敏感词命中后仍继续判链接（reason 可能说成链接问题）',
    from: '  if (hits.length) {\n    return { ok: false, reason: `内容包含不当关键词：${hits[0]}` };\n  }',
    to: '  if (false && hits.length) {\n    return { ok: false, reason: `内容包含不当关键词：${hits[0]}` };\n  }',
  },
  {
    id: 'A17',
    desc: 'reason 不带命中的词（排查时看不出为什么被拒）',
    from: '    return { ok: false, reason: `内容包含不当关键词：${hits[0]}` };',
    to: '    return { ok: false, reason: \'内容包含不当关键词\' };',
  },

  // ---------- 豁免词 ----------
  {
    id: 'A18',
    desc: '**完全不做豁免判定**（管理员配的豁免词全部失效）',
    from: '    if (matched && !securitySettings.isAllowedText(text, word)) hits.push(w);',
    to: '    if (matched) hits.push(w);   // 注入：不判豁免',
  },
  {
    id: 'A19',
    desc: '**豁免判定恒为真**（一个豁免词放行全部敏感词 —— 那次事故的形态）',
    from: '    if (matched && !securitySettings.isAllowedText(text, word)) hits.push(w);',
    to: '    if (matched && !securitySettings.isAllowedText(text)) hits.push(w);',
  },
];

const result = runMutations({
  title: 'antiSpam.js（硬拒层）',
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
