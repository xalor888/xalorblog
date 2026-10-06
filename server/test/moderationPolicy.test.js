/**
 * 留言审核策略单测（纯函数部分，无 DB 依赖）
 * 覆盖：变体归一化（全角/插空格/同形字符/零宽断词）、
 *       引流联系方式变体命中、裸域名任意 TLD、正常内容零误伤
 * 运行：node test/moderationPolicy.test.js（npm test 链的一环）
 */
const { localModeration, normalizeForSpam, PENDING_SCORE, REJECT_SCORE } = require('../src/utils/aiModeration');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) passed += 1;
  else failed += 1;
  const mark = cond ? '✓' : '✗';
  console.log(`  ${mark} ${name}${!cond && extra ? ' | ' + extra : ''}`);
  if (!cond) failures.push(name);
}

/** 断言内容至少进入待审（score ≥ PENDING_SCORE） */
function assertFlagged(name, content, nickname = '') {
  const { score, reasons } = localModeration(content, nickname);
  assert(name, score >= PENDING_SCORE, `score=${score} reasons=${reasons.join('、')}`);
}

/** 断言指定检测点命中（不要求达到待审线——单项低权重命中即视为检测到） */
function assertHits(name, content, reason, nickname = '') {
  const { score, reasons } = localModeration(content, nickname);
  assert(name, reasons.some((r) => r.includes(reason)), `score=${score} reasons=${reasons.join('、')}`);
}

/** 断言正常内容不被标记（score < PENDING_SCORE） */
function assertClean(name, content, nickname = '') {
  const { score, reasons } = localModeration(content, nickname);
  assert(name, score < PENDING_SCORE, `score=${score} reasons=${reasons.join('、')}`);
}

console.log('\n=== 归一化函数 ===');
assert('全角折叠', normalizeForSpam('ｖｘ１２３') === 'vx123');
assert('去零宽字符', normalizeForSpam('加\u200B微信') === '加微信');
assert('v 同形字符折叠', normalizeForSpam('ⅴ∨ν') === 'vvv');
assert('空白全去（拆字逃逸失效）', normalizeForSpam('加 微 信\n号 abc') === '加微信号abc');
assert('大小写折叠', normalizeForSpam('VX QQ') === 'vxqq');

console.log('\n=== 变体垃圾必须被标记（旧版全部漏过） ===');
assertFlagged('插空格：加 微信号 x1234567', '加 微信号 x1234567');
assertFlagged('全角：私我ｖｘ abc123', '私我ｖｘ abc123');
assertFlagged('动词变体：搜索薇信 abc12345', '搜索薇信 abc12345');
assertFlagged('同形字符：加∨信 abc12345', '加∨信 abc12345');
assertFlagged('零宽断词：加\u200B微信 abc12345', '加\u200B微信 abc12345');
assertFlagged('号码形态：微信号：abc_12345', '微信号：abc_12345');
assertHits('@手柄引流：关注 @spam_deal_01', '关注 @spam_deal_01', '联系方式引流');
assertHits('非白名单 TLD 裸域名被计分（旧版 0 分）', '好东西在 example.shop', '裸域名');

console.log('\n=== 高危话术仍判拒绝级 ===');
const hardSpam = localModeration('刷单兼职日结，加微信号 abc123456 领红包', '促销小妹');
assert('多特征叠加达拒绝分', hardSpam.score >= REJECT_SCORE, `score=${hardSpam.score}`);

console.log('\n=== 正常内容零误伤 ===');
assertClean('技术讨论', '在 Vue 3 里用 watchEffect 处理副作用，注意 cleanup 时机');
assertClean('引用出处带域名', '这篇讲得很清楚，参考 vuejs.org 的文档');
assertClean('普通问候', '博主好，文章写得很棒，期待更新！');
assertClean('含小数与数字', '版本号 3.14 那段示例我跑了下，输出和文中一致');
assertClean('英文技术评论', 'the debounce example works well, thanks for the write-up');
assertClean('昵称正常', '这篇文章解决了我的问题，收藏了', '路人甲');

console.log('\n=== 回归：旧版已覆盖的逃逸仍被拦截 ===');
assertFlagged('裸 whiteword 域名', '详情见 www.spam-site.com 免费领取');
assertFlagged('手机号', '有意向请联系 13800138000');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
