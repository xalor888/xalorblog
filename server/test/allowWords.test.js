/**
 * 词库豁免（allowWords）的边界契约
 *
 * 为什么单独一个文件：`allowWords` 是「硬拒层的唯一出口」，它绕过一次，
 * antiSpam 的全部敏感词就等于没有配。而它的三种实现我都见过一遍：
 *
 *   1. 初版：完全忽略 matchedWord —— 只要文本含任一豁免词就 return true。
 *      配了 allowWords=['回收'] 之后，「垃圾回收，加微信领取」里的「加微信」
 *      也不再命中。一条带引流话术的垃圾评论直接过审。
 *   2. 二版：改成 `文本含匹配词 && 文本含任一豁免词`。仍然只要求两者
 *      **各自出现**，于是「垃圾回收，加微信领取」照样放行 —— 两个独立事实
 *      被当成了「共存关系」，没有任何位置约束。
 *   3. 三版（当前）：豁免词必须与被命中的词**重叠或直接相邻**，才豁免该词。
 *      对上豁免机制的本意：管理员配豁免词是为了给「垃圾回收」「暴力破解」
 *      这类复合术语放行，不是给整段文本开白名单。
 *
 * 三次实现里有两次是「看起来对、实测整段放行」。所以这组断言的核心不是
 * 「正确的能过」，而是「错误的不能混过去」—— 每一条用例都对应一次真实的
 * 误放行。
 *
 * 依赖：**无**。配置通过 setConfigForTest() 直接注入内存，不走 saveConfig
 * （那个会落库）。这与其它套件「不需要 DB / 不需要起服务」的约定一致 ——
 * 一条要在 CI 里跑的安全契约，不该因为 MySQL 没起来就静默跳过。
 *
 * 用法：node test/allowWords.test.js
 */
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];
function assert(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` | ${extra}` : ''));
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function main() {
  // config.js 在模块加载时校验 DB_PASSWORD（即使本套件不连库也会被它拦住），
  // 所以先补一个合法占位值。它不参与任何连接。
  if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'test-only-placeholder-16';
  const securitySettings = require('../src/utils/securitySettings');
  const antiSpam = require('../src/utils/antiSpam');
  const db = null;

  try {
    console.log('\n【豁免词只豁免"相邻"的那一个词，不豁免整段】');
    // 敏感词库：[垃圾, 加微信, 博彩]；豁免词：[回收]
    // 「回收」的正常用法是跟在「垃圾」后面构成「垃圾回收」这个技术术语。
    securitySettings.setConfigForTest({
      customSensitiveWords: ['垃圾', '加微信', '博彩'],
      allowWords: ['回收'],
    });

    const cases = [
      // [文本, 期望命中的词（排序后比较）, 说明]
      ['Java 的垃圾回收机制', [], '「垃圾」+「回收」相邻 → 良性用法，整体放行'],
      ['垃圾回收，加微信领取', ['加微信'], '「加微信」与「回收」隔着逗号 → 不该被豁免'],
      ['垃圾回收，博彩网站推荐', ['博彩'], '同上，「博彩」不该被豁免'],
      ['垃圾处理技术讨论', ['垃圾'], '没有「回收」→ 正常命中'],
      ['加微信领取优惠', ['加微信'], '无豁免词 → 正常命中'],
      ['回收站里全是垃圾', ['垃圾'], '「回收」在前但与「垃圾」不相邻 → 不豁免'],
    ];

    for (const [text, expected, why] of cases) {
      const hits = Array.from(new Set(antiSpam.checkSensitive(text))).sort();
      const want = expected.slice().sort();
      const equal = hits.length === want.length && hits.every((v, i) => v === want[i]);
      assert(`${JSON.stringify(text)} → ${JSON.stringify(want)}`, equal, `${why}（实际 ${JSON.stringify(hits)}）`);
    }

    console.log('\n【isAllowedText 的位置语义】');
    // 直接对函数打点：确认判定依据是「区间相邻」而不是「字符串包含」
    assert(
      '命中词与豁免词直接相邻 → 豁免',
      securitySettings.isAllowedText('垃圾回收机制', '垃圾') === true
    );
    assert(
      '命中词与豁免词隔一个标点 → 不豁免',
      securitySettings.isAllowedText('垃圾，回收', '垃圾') === false
    );
    assert(
      '豁免词出现在命中词之前但不相邻 → 不豁免',
      securitySettings.isAllowedText('回收站全是垃圾', '垃圾') === false
    );
    assert(
      '文本无该命中词 → 不豁免（避免空匹配被当成豁免）',
      securitySettings.isAllowedText('随便一句话', '加微信') === false
    );
    assert(
      '未传 matchedWord → 退化为「是否含豁免词」（保持既有调用点语义）',
      securitySettings.isAllowedText('垃圾回收机制') === true
    );

    console.log('\n【豁免词为空时不产生任何豁免】');
    securitySettings.setConfigForTest({ customSensitiveWords: ['加微信'], allowWords: [] });
    assert(
      'allowWords 为空 → 敏感词正常命中',
      antiSpam.checkSensitive('加微信领取').length > 0
    );

    console.log('\n【相邻判定不因重复出现而误判】');
    securitySettings.setConfigForTest({ customSensitiveWords: ['垃圾'], allowWords: ['回收'] });
    assert(
      '豁免词出现两次、只有一处相邻 → 相邻的那次豁免',
      securitySettings.isAllowedText('垃圾回收 与 回收站', '垃圾') === true
    );
    assert(
      '豁免词只出现在远处 → 不豁免',
      securitySettings.isAllowedText('垃圾 到处都是 回收桶', '垃圾') === false
    );
  } finally {
    if (db) await db.destroy().catch(() => {});
  }

  console.log(`\nallowWords 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('套件异常：', e && e.message ? e.message : e);
  process.exit(1);
});
