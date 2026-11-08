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
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CN_WPM,
  EN_WPM,
  stripMarkdown,
  countWords,
  readingMinutes,
  aggregateReading,
} from '../src/utils/wordStats.js';

const here = dirname(fileURLToPath(import.meta.url));

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

/* ---------- 详情页与统计页必须报同一个分钟数 ----------
 *
 * 实测过的缺陷：aggregateReading 原来写 `Math.ceil(totalWords / CN_WPM)`，
 * 把英文词也按中文 350 字/分钟折算，而 readingMinutes 用的是 cn/350 + en/250。
 * 同一篇文章因此在两个地方报不同数字：
 *   700 词纯英文   → 详情页 3 分钟，站点统计 2 分钟
 *   2000 词纯英文 → 详情页 8 分钟，站点统计 6 分钟
 * 这不是「精度差异」，是**口径不一致** —— 读者会觉得整站在乱报。
 */
{
  const en = (n) => 'word '.repeat(n);
  const diverging = [
    ['纯英文 700 词', en(700)],
    ['纯英文 2000 词', en(2000)],
    ['中英各半（350 中 + 350 英）', cjk(350) + ' ' + en(350)],
    ['纯中文 700 字', cjk(700)],
  ];
  const bad = [];
  for (const [label, body] of diverging) {
    const detail = readingMinutes(body, { minOne: true });
    const agg = aggregateReading([{ title: 't', slug: 's', content: body }]).total_reading_minutes;
    if (detail !== agg) bad.push(`${label}: 详情 ${detail} vs 统计 ${agg}`);
  }
  eq('详情页与统计页对同一篇文章报同一个分钟数', bad, []);
}

console.log('\n【与后端约定一致】');
eq('CN_WPM 是 350（与 server 统计一致）', CN_WPM, 350);
eq('EN_WPM 是 250', EN_WPM, 250);

/* ---------- 真·跨仓一致性：直接驱动 server 的 countWords ----------
 *
 * ⚠ 上面那两条 eq 只证明了「本地常量等于字面量 350」，**证明不了前后端同口径**，
 * 而 server/src/routes/stats.js 的注释明确写着
 * 「前后端必须用同一组区段，scripts/test-word-stats.mjs 有一致性断言锁住」——
 * 那个锁其实从来不存在（本文件以前根本没 import 服务端任何东西）。
 * 于是一边改 CJK 区段、一边忘改另一边的风险完全没被覆盖，
 * 而它造成的正是「同一篇文章详情页说 8 分钟、统计里说 7 分钟」。
 *
 * 这里真的把服务端的纯函数 require 进来逐例比对：区段、按词计数的规则、
 * Markdown 剥离顺序、350 字/分钟，任何一边漂移都会失败。
 *
 * 服务端模块需要 DB_PASSWORD 才能被 require（config.js 在顶层校验）。
 * 本仓已有 server/.env，dotenv 会自动读到；若在无 .env 的环境（如 CI）跑，
 * 这一段会**明确跳过并打印原因**，而不是假装通过。
 */
let crossOk = 0;
let crossFail = 0;
function cross(name) {
  const okFlag = arguments.length > 1 ? arguments[arguments.length - 1] : true;
  if (okFlag) {
    crossOk += 1;
    console.log(`  ✓ ${name}`);
  } else {
    crossFail += 1;
    console.log(`  ✗ ${name}`);
  }
}

{
  let serverMod = null;
  let skipReason = '';
  let plainText = null;
  try {
    // web/ 与 server/ 是同级目录
    const serverRoot = resolve(here, '../../server');
    /**
     * server/src/config.js 在**顶层**校验 DB_PASSWORD（缺失直接 throw），
     * 而它里面的 `require('dotenv').config()` 读的是 `process.cwd()/.env` ——
     * 从 web/ 目录跑时 cwd 是 web/，找不到 server/.env，整条 require 链就炸了。
     *
     * 这里手动读 server/.env 填进 process.env（只补缺失的键，不覆盖调用方
     * 已经显式注入的值 —— CI 里用环境变量传密码时应当以环境变量为准）。
     * 不引入 dotenv 依赖：几行解析足够，且 web/ 不该为了一个测试脚本加依赖。
     */
    const envPath = resolve(serverRoot, '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue; // 注释 / 空行
        const key = m[1];
        let val = m[2].trim();
        // 去掉包裹引号（.env 里常见的写法）
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
    }
    const req = createRequire(resolve(serverRoot, 'package.json'));
    serverMod = req('./src/routes/stats.js');
    plainText = req('./src/utils/markdownText.js').plainText;
  } catch (e) {
    skipReason = e.message;
  }

  if (!serverMod) {
    console.log(`  ⚠ 跳过跨仓一致性检查（无法加载 server/src/routes/stats.js：${skipReason}）`);
    console.log('    这不算通过 —— 请在 server/.env 存在（或已注入 DB_PASSWORD）的环境重跑。');
  } else {
    const serverCount = serverMod.countWords;
    const SERVER_WPM = serverMod.WORDS_PER_MINUTE;

    cross(`服务端 WORDS_PER_MINUTE === 前端 CN_WPM（${SERVER_WPM}）`, SERVER_WPM === CN_WPM);

    /**
     * 逐例比对「服务端 countWords ↔ 前端 countWords().total」。
     * 每个用例都专门覆盖一个容易分叉的点：
     *  - CJK 三个区段（基本 / 扩展 A / 兼容汉字）
     *  - `Vue3使用` 这种中英粘连（服务端会先把 CJK 抹成空格再数拉丁词串）
     *  - 代码块 / 行内代码 / 图片 / 链接的剥离顺序
     */
    const parityCases = [
      ['纯中文', '中文十个字测试一下啊'],
      ['中英粘连', 'Vue3使用指南'],
      ['纯英文', 'hello world again'],
      ['CJK 扩展 A 区 + 兼容汉字', '扩展A区：㐀㐁㐂 兼容汉字：豈更'],
      ['中英混排 + 数字', 'mixed 中文 and English 混排 123'],
      ['图片整段剔除', '![图](/a.png)后文'],
      ['链接只留锚文本', '[站点](https://example.com)很好'],
      ['删除线标记清零', '~~删除线~~文字'],
      ['标题/粗斜体标记', '## 标题\n\n**粗** _斜_'],
      ['代码块不计', '```js\nvar x=1;\n```\n正文'],
      ['行内代码保留文字', '代码 `inline code` 后面'],
      ['空串', ''],
    ];
    for (const [label, input] of parityCases) {
      const s = serverCount(input);
      const w = countWords(input).total;
      cross(`${label}：服务端 ${s} === 前端 ${w}`, s === w);
    }

    // 剥离结果本身也要逐字相同 —— 否则「恰好总数一样」会掩盖语义分叉
    for (const [label, input] of parityCases) {
      if (input === '') continue;
      const a = plainText(input);
      const b = stripMarkdown(input);
      cross(`${label}：剥离后的纯文本逐字相同`, a === b);
    }

    // 聚合口径：100 篇 10 字，服务端 buildReadingStats 与前端 aggregateReading 同值
    const rows = Array.from({ length: 100 }, (_, i) => ({
      title: `t${i}`, slug: `s${i}`, content: '中'.repeat(10), status: 'published',
    }));
    const serverAgg = serverMod.buildReadingStats(rows);
    const webAgg = aggregateReading(rows);
    cross('100 篇 10 字：总字数一致', serverAgg.total_words === webAgg.total_words);
    cross(
      '100 篇 10 字：总阅读时长一致（都按总量一次取整）',
      serverAgg.total_reading_minutes === webAgg.total_reading_minutes
    );
    cross('空数组：服务端不产生 NaN', serverMod.buildReadingStats([]).avg_words === 0);

    /**
     * 纯英文：前后端必须用**同一个公式**（cn/350 + en/250）。
     *
     * 历史：服务端曾是 `Math.ceil(totalWords / 350)` —— 把英文词也按中文速度折算，
     * 于是 700 词纯英文在服务端报 2 分钟、前端报 3 分钟；2000 词报 6 vs 8。
     * 详情页的「N 分钟」走前端公式，侧栏「全站累计阅读时长」走服务端端点，
     * 两个数字在同一站点并存，读者能同时看到 —— 口径不一致比数字偏差更伤信任。
     *
     * 现在服务端已改为与前端同一公式。这两条断言负责**双向防回退**：
     *   - 服务端若退回单一除数 → 第一条失败（值与单除数推算相同）；
     *   - 前端若改回单一除数 → 第二条失败（两边不再相等）。
     * 断言不依赖任何一侧的常量表，只比较「服务端结果 / 前端结果 / 单除数推算」三者的关系。
     */
    const serverDivisorOnly = (body) => {
      const w = serverCount(body);
      return w === 0 ? 0 : Math.ceil(w / SERVER_WPM);
    };
    for (const [label, body] of [
      ['700 词纯英文', 'word '.repeat(700)],
      ['2000 词纯英文', 'word '.repeat(2000)],
    ]) {
      const sRows = [{ title: 't', slug: 's', content: body, status: 'published' }];
      const sServer = serverMod.buildReadingStats(sRows).total_reading_minutes;
      const sWeb = aggregateReading(sRows).total_reading_minutes;
      cross(
        `${label}：服务端已按 cn/350+en/250 折算（${sServer} !== 单除数推算 ${serverDivisorOnly(body)}）`,
        sServer !== serverDivisorOnly(body)
      );
      cross(
        `${label}：前后端同一公式（服务端 ${sServer} === 前端 ${sWeb}）`,
        sServer === sWeb
      );
    }
    // 口径已于 2026-11-01 统一：服务端 buildReadingStats 与前端 aggregateReading
    // 都按 cn/350 + en/250 折算。上面两条断言负责双向防回退，这里不再输出"已知差异"提示
    // —— 那条提示在修完之后就成了误导（过期注释比没有注释更坏）。
  }
  if (crossFail) {
    fail += crossFail;
  }
  if (crossOk) {
    pass += crossOk;
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
