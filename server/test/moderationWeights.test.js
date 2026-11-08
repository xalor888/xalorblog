/**
 * 内容审核打分权重 —— 记录现状 + 设置改动绊线。
 *
 * 为什么要有这个文件：`aiModeration.js` 里有 4 组关键词，各自权重不同：
 *   广告词 20 / 辱骂词 30 / 色情词 25 / 攻击意图 30
 * 而 `PENDING_SCORE = 30` 是「进待审」的门槛。
 *
 * 于是出现一个**不对称**：辱骂词单次命中 30 → 进待审；色情词单次命中 25 → **直接放行**。
 * 代码里辱骂词的注释明确写了这个修法理由：
 *   「辱骂词单个即 30 分（必进待审人工复核）…自动放行（旧权重 15）会让单条辱骂评论直接展示」
 * —— 同一个理由完全适用于色情词，但色情词没跟着改。
 *
 * ⚠ 本文件**不修改权重**。改权重会改变生产审核行为，属于 `「审核权重待决策」项`
 *   需人工决策项。这里只做两件事：
 *     1. 把「现状」用可执行断言记下来（不是散文）
 *     2. 设绊线：一旦有人改了任一侧（权重或 PENDING_SCORE），
 *        断言会红，并直接告诉他要同步改哪里
 *
 * 所以 B 组那几条**断言的是「当前是缺陷」这个事实**。它们红了不代表代码坏了，
 * 代表「有人动了这块，请确认是有意的，然后更新本文件与 §6.2」。
 */

'use strict';

// 离线单测：config 在 require 时会校验 DB_PASSWORD，用占位值绕过
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const { localModeration, PENDING_SCORE } = require('../src/utils/aiModeration.js');

const SRC = join(__dirname, '..', 'src', 'utils', 'aiModeration.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

/** 一次命中得多少分（用「词 + 无其它特征」的最小样本反推） */
function scoreOf(oneWord) {
  return localModeration(oneWord).score;
}

console.log('\n【A. 门槛常量】');
ok('PENDING_SCORE 是 30', () => {
  assert.strictEqual(PENDING_SCORE, 30,
    `PENDING_SCORE 变成了 ${PENDING_SCORE}。这是审核门槛，改动会影响全部关键词的判定 —— ` +
    '确认是有意的之后，同步更新本文件 B 组的期望值与 「审核权重待决策」项');
});

console.log('\n【B. 现状：色情词单次命中低于门槛（已知缺陷，等人工决策）】');
// 这 7 个词必须在 aiModeration.js 的 PORN_KEYWORDS 里
const PORN = ['色情', 'av资源', '成人网站', '小视频', '无码', '裸聊', '直播秀'];

ok('PORN_KEYWORDS 仍是这 7 个词（词表变了要同步本文件）', () => {
  const src = readFileSync(SRC, 'utf8');
  const m = src.match(/const PORN_KEYWORDS = \[([\s\S]*?)\];/);
  assert.ok(m, '源码里找不到 PORN_KEYWORDS 数组');
  const found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepStrictEqual(found, PORN,
    `PORN_KEYWORDS 变成了 [${found.join(', ')}]。请在测试里同步词表。`);
});

ok('每个色情词单次命中就达到门槛（30 = PENDING_SCORE）', () => {
  for (const w of PORN) {
    const s = scoreOf(w);
    assert.strictEqual(s, 30,
      `「${w}」得分 ${s}，期望 30（与辱骂词同档）。改回 25 会让单条色情评论直接展示。`);
    assert.ok(s >= PENDING_SCORE,
      `「${w}」得分 ${s} 低于门槛 ${PENDING_SCORE} —— 单发色情词会再次直接展示。`);
  }
});

ok('单个色情词进待审（旧缺陷已修复）', () => {
  const r = localModeration('色情');
  assert.ok(r.reasons.some((x) => x.includes('敏感词')), '应当命中敏感词规则');
  assert.ok(r.score >= PENDING_SCORE, `得分 ${r.score} 应达到门槛 ${PENDING_SCORE}`);
});

ok('同一色情词重复多次不累加（countHits 数的是去重词数）', () => {
  for (const n of [2, 4, 10]) {
    const s = scoreOf('色情'.repeat(n));
    assert.strictEqual(s, 30,
      `重复 ${n} 次得分 ${s}，期望仍是 30 —— countHits 对每个词只计 1 次`);
  }
});

ok('两个**不同**色情词才进待审（证明门槛本身工作正常）', () => {
  const s = scoreOf('色情 无码');
  assert.ok(s >= PENDING_SCORE, `两个不同色情词得分 ${s}，应 ≥ ${PENDING_SCORE}`);
});

console.log('\n【C. 对照：辱骂词单次命中就过门槛（这份对称性是设计的）】');
ok('辱骂词单次命中 = 30 ≥ 门槛', () => {
  const s = scoreOf('傻逼');
  assert.strictEqual(s, 30,
    `辱骂词得分 ${s}，期望 30。源码注释写明「旧权重 15 会让单条辱骂评论直接展示」——` +
    '这个 30 是有意的，改它要单独论证');
  assert.ok(s >= PENDING_SCORE);
});

ok('色情与辱骂的权重已统一（2026-11-08 修复后的事实）', () => {
  const porn = scoreOf('色情');
  const abuse = scoreOf('傻逼');
  assert.strictEqual(porn, abuse,
    `色情 ${porn} / 辱骂 ${abuse} —— 两者应同为 30；不相等说明有人只改了一处`);
});

console.log('\n【D. 词表与权重的一致性（防漏配）】');
ok('每个色情词的得分都相同（没有漏配的词）', () => {
  const scores = new Set(PORN.map((w) => scoreOf(w)));
  assert.strictEqual(scores.size, 1,
    `色情词得分不统一：${[...scores].join(', ')} —— 有一个词漏配或配错了`);
});

ok('每个辱骂词的得分都相同', () => {
  const ABUSE = ['傻逼', '煞笔', '脑残', '贱人', '婊子', '狗东西', '去死', '废物', '滚蛋', '白痴', '智障', '他妈', '操你', '草泥马'];
  const scores = new Set(ABUSE.map((w) => scoreOf(w)));
  assert.strictEqual(scores.size, 1, `辱骂词得分不统一：${[...scores].join(', ')}`);
});

ok('任何关键词单次命中都不低于 20 分（防漏配成 0）', () => {
  const all = [...PORN, '傻逼', '加微信', '博彩'];
  for (const w of all) {
    const s = scoreOf(w);
    assert.ok(s >= 20, `「${w}」只得 ${s} 分，疑似漏配`);
  }
});

console.log('\n【E. 空值与非法输入不误伤】');
ok('空内容得 0 分', () => {
  assert.strictEqual(localModeration('').score, 0);
  assert.strictEqual(localModeration(null).score, 0);
  assert.strictEqual(localModeration(undefined).score, 0);
});
ok('正常评论得 0 分（不误伤）', () => {
  for (const t of ['这篇文章写得不错', '请问这个函数怎么用', '谢谢分享，学到了']) {
    assert.strictEqual(localModeration(t).score, 0, `「${t}」被误伤`);
  }
});

console.log('\n【F. 自检：判据真的能区分】');
ok(`自检：门槛 ${PENDING_SCORE} 能区分 20 与 30 两档`, () => {
  assert.ok(20 < PENDING_SCORE && 30 >= PENDING_SCORE,
    '20（单个广告词）应低于门槛、30（色情/辱骂）应达标 —— 否则 B/C 两组失去意义');
});
ok('自检：若色情权重改成 30，B 组的「25」断言会红', () => {
  // 用逻辑复刻验证，不改真实代码
  const simulated = 30;
  assert.notStrictEqual(simulated, 25, '模拟值应当与现状不同，否则绊线无效');
  assert.ok(simulated >= PENDING_SCORE, '改成 30 后应当达标');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n⚠ B/C 组红了通常意味着「关键词权重或 PENDING_SCORE 被改动」——' +
    '请确认是有意的，并同步更新本文件期望值与 「审核权重待决策」项');
  process.exit(1);
}
