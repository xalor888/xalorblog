/**
 * wordStats 的行为回归
 *
 * 这套数字在页面上是给读者看的（「N 分钟」），在后端是聚合值（总时长）。
 * 出错的方式都很隐蔽：
 *   - 逐篇取整再相加 → 100 篇空文章报 100 分钟
 *   - 0 篇时 0/0 → avg_words 变 NaN，渲染成「NaN 字」
 *   - 代码块没剥 → 贴一段 200 行配置就把「3 分钟」变成「20 分钟」
 *   - 中英比值分别取整 → 短英文文章恒为 1 分钟
 *
 * 用法：node scripts/test-word-stats.mjs
 */
import {
  CN_WPM,
  EN_WPM,
  stripMarkdown,
  countWords,
  readingMinutes,
  aggregateReading,
} from '../src/utils/wordStats.js';

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} — 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }
}

const cjk = (n) => '中'.repeat(n);
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

console.log('\n【剥 Markdown：代码块/图片不计入字数】');
eq('代码块被整块剔除', stripMarkdown('```js\n' + 'var x=1;\n'.repeat(50) + '```\n正文').trim(), '正文');
eq('行内代码保留内容', stripMarkdown('用 `npm test` 跑'), '用 npm test 跑');
eq('图片不计（含 alt）', stripMarkdown('![示意图](/a.png)后文'), '后文');
// 注意：剥离后 CJK 与锚文本之间不加空格是对的——中文本来就不分词间空格，
// 硬塞一个空格会让字数统计把标点也算进去，且与后端 plainText 行为不一致。
eq('链接保留锚文本、丢掉 URL', stripMarkdown('[站点](https://example.com)很好'), '站点很好');
// see / the / docs / now = 4 词；URL 本身不计数
eq('英文链接替换后仍按词计数', countWords('see [the docs](https://x.dev) now'), { cn: 0, en: 4, total: 4 });
eq('标记符号被清掉', countWords('## 标题\n\n**粗** _斜_'), countWords('标题 粗 斜'));

console.log('\n【字数：中文按字、英文按词】');
eq('纯中文 10 字', countWords(cjk(10)), { cn: 10, en: 0, total: 10 });
eq('纯英文 3 词', countWords('hello world again'), { cn: 0, en: 3, total: 3 });
eq('中英混排相加', countWords(cjk(5) + ' hello world'), { cn: 5, en: 2, total: 7 });
eq('数字串算一个词', countWords('v2 3 42'), { cn: 0, en: 3, total: 3 });
eq('空内容为 0', countWords(''), { cn: 0, en: 0, total: 0 });
eq('null 不炸', countWords(null), { cn: 0, en: 0, total: 0 });
eq('代码块默认不计（阅读时长语义）', countWords('```\n' + cjk(200) + '\n```\n' + cjk(5)).total, 5);
eq('raw 模式按原文计（编辑器语义）', countWords('```' + cjk(10) + '```', { raw: true }).total >= 10, true);

console.log('\n【阅读时长：总量一次性取整】');
eq('恰好一个速度单位 → 1 分钟', readingMinutes(cjk(CN_WPM)), 1);
eq('超一点点 → 2 分钟（向上取整）', readingMinutes(cjk(CN_WPM + 1)), 2);
eq('空内容 → 0（供聚合用）', readingMinutes(''), 0);
eq('空内容 + minOne → 1（供展示用）', readingMinutes('', { minOne: true }), 1);
eq('英文按 EN_WPM 算', readingMinutes(words(EN_WPM)), 1);
// 关键回归：不能是 ceil(cn/CN) + ceil(en/EN) 这种各自取整
eq('中英混排只取整一次', readingMinutes(cjk(10) + ' ' + words(10)), 1);

console.log('\n【聚合：同口径、无 NaN、不逐篇取整】');
eq('空数组 → avg 是 0 不是 NaN', aggregateReading([]), {
  total_articles: 0,
  total_words: 0,
  avg_words: 0,
  longest: null,
  total_reading_minutes: 0,
});
eq('非数组输入不炸', aggregateReading(null).total_articles, 0);

// 核心回归：100 篇 10 字文章。逐篇 ceil 会得 100 分钟，正确值是 3 分钟。
{
  const many = Array.from({ length: 100 }, (_, i) => ({
    title: `t${i}`,
    slug: `s${i}`,
    content: cjk(10),
  }));
  const agg = aggregateReading(many);
  eq('100 篇 10 字 → 1000 字', agg.total_words, 1000);
  eq('100 篇 10 字 → 3 分钟（不是 100）', agg.total_reading_minutes, Math.ceil(1000 / CN_WPM));
  eq('均值正确', agg.avg_words, 10);
  eq('全部等长时 longest 取第一篇', agg.longest.slug, 's0');
}

{
  const agg = aggregateReading([
    { title: '短', slug: 'a', content: cjk(5) },
    { title: '长', slug: 'b', content: cjk(500) },
    { title: '空', slug: 'c', content: '' },
  ]);
  eq('最长那篇被挑出来', agg.longest, { title: '长', slug: 'b', words: 500 });
  eq('篇数含空文章', agg.total_articles, 3);
  eq('均值按篇数算', agg.avg_words, Math.round(505 / 3));
}

{
  // 全空文章：longest 必须是 null（不能是 {words:0} 的空壳）
  const agg = aggregateReading([
    { title: 'a', slug: 'a', content: '' },
    { title: 'b', slug: 'b', content: '' },
  ]);
  eq('全空 → longest 为 null', agg.longest, null);
  eq('全空 → 总时长为 0', agg.total_reading_minutes, 0);
  eq('全空 → avg 为 0', agg.avg_words, 0);
}

{
  // 代码块不应污染聚合
  const agg = aggregateReading([
    { title: 'A', slug: 'a', content: cjk(10) + '\n```\n' + cjk(5000) + '\n```' },
  ]);
  eq('聚合也剔代码块', agg.total_words, 10);
}

console.log('\n【与后端约定一致】');
eq('CN_WPM 是 350（与 server 统计一致）', CN_WPM, 350);
eq('EN_WPM 是 250', EN_WPM, 250);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
