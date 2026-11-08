/**
 * 反垃圾硬拒层的离线测试。
 *
 * 这是内容安全的**第一道也是最硬的一道**：命中即拒，不过 AI 审核、不进人工队列。
 * 所以它的错误分两种，都很糟：
 *   - **漏判**：垃圾评论直接上线（后面还有 AI 评分能兜一部分，但硬拒词都是
 *     「广告/违法/欺诈特征明确」的，漏掉说明词表或匹配逻辑坏了）
 *   - **误判**：真实访客的正常讨论被直接拒绝，且**没有任何人工复核机会**
 *     （硬拒绕过了审核队列）—— 用户只会看到「内容包含不当关键词」
 *
 * 两个历史坑都已写在源码注释里，这里逐条回归：
 *   1. **拉丁词必须词边界匹配** —— `vx` 不能命中 `vxworks`（正常技术讨论）
 *   2. **自定义词必须转义正则元字符** —— 管理员配 `c++` 时 `new RegExp` 会抛错，
 *      异常沿 antiSpam 上抛 → 评论/留言接口整体 500（不是拒绝，是全站挂）
 *
 * 另外 `countLinks` 有一个易漏的形态：**裸 www 域名**（无协议）。
 * 不计入的话，2 个 www 链接能逃过硬拒层，而审核层裸域只算 10 分/个不够 pending，
 * 于是形成一条与 http 链接行为不一致的垃圾通道。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { checkSensitive, countLinks, antiSpam, SENSITIVE_WORDS } = require('../src/utils/antiSpam');
const { setConfigForTest } = require('../src/utils/securitySettings');

setConfigForTest({});   // 标记已加载，避免异步连库

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name} — ${e.message}`);
    failures.push(name);
  }
}
function withCustomWords(patch, fn) {
  const { getConfig } = require('../src/utils/securitySettings');
  const beforeWords = getConfig().customSensitiveWords;
  const beforeAllow = getConfig().allowWords;
  setConfigForTest({ customSensitiveWords: [], allowWords: [], ...patch });
  try { fn(); } finally {
    setConfigForTest({ customSensitiveWords: beforeWords, allowWords: beforeAllow });
  }
}

console.log('\n【A. 词表本身】');
{
  ok('词表非空且都是字符串', () => {
    assert.ok(SENSITIVE_WORDS.length > 0);
    for (const w of SENSITIVE_WORDS) assert.strictEqual(typeof w, 'string');
  });
  ok('词表里没有空串或纯空白（会跳过，等于无效条目）', () => {
    for (const w of SENSITIVE_WORDS) {
      assert.ok(String(w).trim().length > 0, `条目 ${JSON.stringify(w)} 是空的`);
    }
  });
  ok('词表不含歧义词（兼职/刷单/返利 等应交给 AI 层）', () => {
    // 源码注释明确写了「歧义词不在此硬拒」。若有人往硬拒词表里加，
    // 真实访客会被**无复核地**拒绝，这里拦一道。
    const ambiguous = ['兼职', '刷单', '返利', '代购', '信用卡', '中奖'];
    const leaked = ambiguous.filter((w) => SENSITIVE_WORDS.includes(w));
    assert.deepStrictEqual(leaked, [], `歧义词混进硬拒表：${leaked.join(', ')}`);
  });
}

console.log('\n【B. checkSensitive：中文词直接子串匹配】');
{
  ok('命中「加微信」', () => assert.deepStrictEqual(checkSensitive('加微信领取'), ['加微信']));
  ok('前后有正常内容也命中', () => assert.deepStrictEqual(checkSensitive('这篇文章不错，加微信聊聊'), ['加微信']));
  ok('正常文本不命中', () => assert.deepStrictEqual(checkSensitive('请教一个关于 React hooks 的问题'), []));
  ok('空串 / 非字符串返回空数组', () => {
    assert.deepStrictEqual(checkSensitive(''), []);
    assert.deepStrictEqual(checkSensitive(null), []);
    assert.deepStrictEqual(checkSensitive(undefined), []);
    assert.deepStrictEqual(checkSensitive(123), []);
  });
  ok('大小写不敏感（中文无大小写，验证不抛）', () => {
    assert.deepStrictEqual(checkSensitive('博彩'), ['博彩']);
  });
  ok('多个词同时命中时全部返回', () => {
    const hits = checkSensitive('加微信 博彩');
    assert.ok(hits.includes('加微信') && hits.includes('博彩'), hits.join(','));
  });
}

console.log('\n【C. 拉丁词必须词边界匹配（防误伤技术讨论）】');
{
  ok('**vxworks 不命中 vx**（经典误伤）', () => {
    assert.deepStrictEqual(checkSensitive('The vxworks kernel is used here'), []);
  });
  ok('独立出现的 vx 命中', () => {
    assert.ok(checkSensitive('加我 vx 详聊').length > 0);
  });
  ok('vx 前后带标点也命中', () => {
    assert.ok(checkSensitive('联系方式：vx!').length > 0);
    assert.ok(checkSensitive('(vx)').length > 0);
  });
  ok('**wechat 不命中 wechatfoo**（后缀粘连）', () => {
    assert.deepStrictEqual(checkSensitive('wechatfoobar'), []);
  });
  ok('**xwechat 不命中 wechat**（前缀粘连）', () => {
    assert.deepStrictEqual(checkSensitive('xwechat'), []);
  });
  ok('数字也算词边界内的字符（vx1 不命中 vx）', () => {
    assert.deepStrictEqual(checkSensitive('vx1'), []);
  });
  ok('大小写混合也按词边界判', () => {
    assert.deepStrictEqual(checkSensitive('VXWorks'), []);
    assert.ok(checkSensitive('VX 详聊').length > 0);
  });
}

console.log('\n【D. 自定义词的转义（防 new RegExp 抛错 → 接口 500）】');
{
  ok('**自定义词含 + 号不抛错**（如 c++）', () => {
    withCustomWords({ customSensitiveWords: ['c++'] }, () => {
      assert.doesNotThrow(() => checkSensitive('我学 c++ 的'));
    });
  });
  ok('自定义词 c++ 能正常命中', () => {
    withCustomWords({ customSensitiveWords: ['c++'] }, () => {
      // c++ 不是纯拉丁词（含 +），但 LATIN_WORD_RE 允许 +，所以走正则路径
      assert.ok(checkSensitive('我学 c++ 的').length > 0);
    });
  });
  ok('自定义词含正则元字符不抛（.*  () [] $ ^）', () => {
    withCustomWords({ customSensitiveWords: ['.*', 'a(b', '[x]', 'p$q', 'm^n'] }, () => {
      for (const t of ['abc', 'a(b', '[x]', 'p$q', 'm^n', 'normal']) {
        assert.doesNotThrow(() => checkSensitive(t), `文本 ${t}`);
      }
    });
  });
  ok('自定义中文词按子串匹配', () => {
    withCustomWords({ customSensitiveWords: ['代写作业'] }, () => {
      assert.ok(checkSensitive('需要代写作业吗').length > 0);
    });
  });
  ok('自定义词表里的空串被跳过（不误命中一切）', () => {
    withCustomWords({ customSensitiveWords: [''] }, () => {
      assert.deepStrictEqual(checkSensitive('完全正常的文本'), []);
    });
  });
}

console.log('\n【E. countLinks：三种链接形态】');
{
  ok('http 链接计数', () => {
    assert.strictEqual(countLinks('看 http://a.com 这篇'), 1);
  });
  ok('https 链接计数', () => {
    assert.strictEqual(countLinks('https://a.com'), 1);
  });
  ok('**裸 www 域名也计数**（无协议，经典绕过）', () => {
    assert.strictEqual(countLinks('看看 www.spam.com'), 1);
  });
  ok('多个链接累加', () => {
    assert.strictEqual(countLinks('a https://a.com b http://b.com c www.c.com'), 3);
  });
  ok('纯文本不计数', () => {
    assert.strictEqual(countLinks('这篇写得很好'), 0);
  });
  ok('非字符串返回 0', () => {
    assert.strictEqual(countLinks(null), 0);
    assert.strictEqual(countLinks(undefined), 0);
    assert.strictEqual(countLinks(42), 0);
  });
  ok('**单独的 www. 不带二级域不计数**（避免误判）', () => {
    assert.strictEqual(countLinks('www. 后面没东西'), 0);
  });
  ok('大小写 www 都计数', () => {
    assert.strictEqual(countLinks('WWW.SPAM.COM'), 1);
  });
  ok('邮箱里的 @ 不被当链接', () => {
    assert.strictEqual(countLinks('mail me at a@b.com'), 0);
  });
}

console.log('\n【F. antiSpam：阈值边界】');
{
  ok('0 条链接通过', () => assert.strictEqual(antiSpam('正常内容').ok, true));
  ok('**恰好 3 条通过**（默认 maxLinks=3，边界是「超过才拒」）', () => {
    const r = antiSpam('a https://a.com b https://b.com c https://c.com');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  });
  ok('**4 条拒绝**', () => {
    const r = antiSpam('a https://a.com b https://b.com c https://c.com d https://d.com');
    assert.strictEqual(r.ok, false);
    assert.ok(/链接过多/.test(r.reason), r.reason);
  });
  ok('自定义 maxLinks 生效', () => {
    assert.strictEqual(antiSpam('https://a.com https://b.com', 2).ok, true);
    assert.strictEqual(antiSpam('https://a.com https://b.com https://c.com', 2).ok, false);
  });
  ok('maxLinks=0 时任意链接都拒', () => {
    assert.strictEqual(antiSpam('https://a.com', 0).ok, false);
    assert.strictEqual(antiSpam('正常文本', 0).ok, true);
  });
  ok('敏感词优先于链接数判断（有敏感词时 reason 说关键词）', () => {
    const r = antiSpam('加微信 https://a.com https://b.com https://c.com https://d.com');
    assert.strictEqual(r.ok, false);
    assert.ok(/关键词/.test(r.reason), r.reason);
  });
  ok('拒绝时 reason 里带上命中的词', () => {
    const r = antiSpam('加微信领取');
    assert.ok(r.reason.includes('加微信'), r.reason);
  });
  ok('通过时 ok 为 true 且无 reason 判断依赖', () => {
    const r = antiSpam('正常讨论');
    assert.strictEqual(r.ok, true);
  });
  ok('空文本通过', () => {
    assert.strictEqual(antiSpam('').ok, true);
  });
}

console.log('\n【G. 豁免词：只豁免被命中的那个词】');
{
  // 这条对应 securitySettings 里记录的那次事故：
  // 原实现只要文本含任一豁免词就放行**全部**敏感词，
  // 于是「讲垃圾回收的文章，加微信领取」里的「加微信」也被跳过。
  ok('**豁免词不能连带放行其它敏感词**', () => {
    withCustomWords({ allowWords: ['回收'] }, () => {
      const hits = checkSensitive('讲垃圾回收的文章，加微信领取');
      assert.ok(hits.includes('加微信'), `豁免词把「加微信」也放过了：${hits.join(',') || '(无命中)'}`);
    });
  });
  ok('豁免词确实豁免它相邻的那个词', () => {
    withCustomWords({ allowWords: ['回收'] }, () => {
      // 「垃圾」不在硬拒表里，这里验证不误命中即可
      assert.deepStrictEqual(checkSensitive('垃圾回收是常见话题'), []);
    });
  });

  // ⚠ 变异 A18（完全不做豁免判定）第一版没被抓到 ——
  // 因为上面两条断言的都是「豁免不该放行别的词」，而**没有一条断言豁免真的会放行**。
  // 像程序里写了 `if (x) ...` 却从没测过 x 为真的分支。
  ok('**豁免词真的会放行它相邻的敏感词**（正面用例）', () => {
    withCustomWords({ allowWords: [] }, () => {
      assert.ok(checkSensitive('加微信').length > 0, '无豁免时应当命中');
    });
    withCustomWords({ allowWords: ['加微'] }, () => {
      assert.deepStrictEqual(checkSensitive('加微信'), [],
        '「加微」与「加微信」重叠，应当豁免');
    });
  });
  ok('豁免只对被命中的那个词生效（换一个词仍命中）', () => {
    withCustomWords({ allowWords: ['加微'] }, () => {
      assert.deepStrictEqual(checkSensitive('加微信'), []);
      assert.ok(checkSensitive('博彩').length > 0, '「博彩」没有豁免词，仍须命中');
    });
  });
}

console.log('\n【H. 自检：判据真的能区分】');
{
  ok('自检：词边界判据对 vx / vxworks 给出不同结果', () => {
    assert.notDeepStrictEqual(checkSensitive('vx'), checkSensitive('vxworks'));
    assert.ok(checkSensitive('vx').length > 0);
    assert.deepStrictEqual(checkSensitive('vxworks'), []);
  });
  ok('自检：countLinks 对 www 与裸文本给出不同结果', () => {
    assert.notStrictEqual(countLinks('www.a.com'), countLinks('a.com'));
  });
  ok('自检：antiSpam 的边界确实是 3/4 而不是别的数', () => {
    const three = 'a https://a.com b https://b.com c https://c.com';
    assert.strictEqual(countLinks(three), 3);
    assert.strictEqual(antiSpam(three).ok, true);
    assert.strictEqual(antiSpam(`${three} d https://d.com`).ok, false);
  });
  ok('自检：不传 customWords 时词表就是内置表', () => {
    withCustomWords({ customSensitiveWords: [] }, () => {
      assert.deepStrictEqual(checkSensitive('完全不相关的文本'), []);
    });
  });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
