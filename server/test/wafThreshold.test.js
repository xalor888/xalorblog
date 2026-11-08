/**
 * WAF 异常分阈值 —— 记录现状 + 设置改动绊线。
 *
 * 判定逻辑（`middleware/waf.js`）：
 *   命中规则 → score = SEVERITY_SCORE[rule.sev]（critical 5 / error 4 / warning 3 / notice 2）
 *   全部命中求和 → `score >= threshold` 才 403，否则只记 waf-mon 事件
 *   例外：键名注入（`__proto__` / `constructor` / `prototype`）一票拦截，不看分数
 *
 * 于是默认阈值 5 之下有一条**结构性缝隙**：
 *   - 单个 `error` 规则 = 4 分 < 5 → **放行**
 *   - 单个 `warning` 默认 = 3 分 < 5 → **放行**
 *   - 只有 `critical`（5 分）单条就够
 *
 * 这不是 bug，是「异常计分」模型的设计取舍：单条中等特征可能是误报，
 * 多特征叠加才拦截。代价是**单发的中等特征载荷全部漏过**。
 * `「WAF 阈值待决策」项` 记的就是这件事（12 条单发高危 payload 实测 3–4 分）。
 *
 * ⚠ 本文件**不修改阈值与规则权重**。改它会改变生产拦截率，属于需人工决策项。
 *   这里做两件事（与 `moderationWeights.test.js` 同一套办法）：
 *     1. 把现状用可执行断言记下来（不是散文）
 *     2. 设绊线：谁改了阈值 / 严重度分档 / 关键规则的 sev，断言会红并说明下一步
 *
 * 判据局限（重要，别当成精确值）：
 *   本文件用规则正则对**单个原始值**求分，两点与真实 waf.js 不同：
 *     1. 不做归一化变体（全角/插空格/大小写）→ 会**少算**命中
 *     2. 不区分扫描面（NET_ONLY 规则在 body 不该生效）→ 会**多算**命中
 *   两个方向相反，所以下面的单项分数是**近似值**，只能用来说明量级。
 *
 *   真正精确、且本文件主要依赖的是 A/B 组的**算术事实**：
 *     `SEVERITY_SCORE.error (4) < anomalyThreshold (5)`
 *   这一条与扫描面、归一化都无关 —— 它就是「单条 error 级规则永远不够拦」的根源。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const { SEVERITY_SCORE, RULE_GROUPS, RULE_INDEX } = require('../src/middleware/waf-rules.js');
const { DEFAULT_CONFIG, NUMERIC_RANGES } = require('../src/utils/securitySettings.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); failures.push(name); }
}

/**
 * 默认阈值与允许区间 —— **直接取导出常量**，不正则解析源码。
 * （第一版用 `readFileSync` + 正则，先撞上「导出名猜错（DEFAULTS vs DEFAULT_CONFIG）》，
 *  而正则解析源码本身也脆：改名、换行、加注释都可能让它失配。）
 */
const THRESHOLD = DEFAULT_CONFIG.anomalyThreshold;
const RANGE = NUMERIC_RANGES.anomalyThreshold;

/** pl=1 的全部规则（默认偏执级别 1） */
function allRules() {
  const out = [];
  for (const [group, rules] of Object.entries(RULE_GROUPS)) {
    for (const r of rules) out.push({ ...r, group });
  }
  return out;
}

/**
 * 单个原始值能命中哪些规则、合计多少分。
 * 保守下界：不加归一化变体、不区分扫描面。
 */
function scoreOf(payload) {
  const text = String(payload);
  let score = 0;
  const ids = [];
  for (const r of allRules()) {
    if (r.pl !== 1) continue;
    if (r.re.test(text)) { score += SEVERITY_SCORE[r.sev] ?? 4; ids.push(r.id); }
  }
  return { score, ids };
}


console.log('\n【A. 阈值与严重度分档】');
ok(`默认 anomalyThreshold 是 5`, () => {
  assert.strictEqual(THRESHOLD, 5,
    `默认阈值变成了 ${THRESHOLD}。这是生产拦截率的总开关 —— 确认是有意的之后，` +
    '同步更新本文件 B 组的期望值与 「WAF 阈值待决策」项');
});

ok('阈值允许区间是 [3, 20]', () => {
  assert.deepStrictEqual(RANGE, [3, 20],
    `区间变成了 [${RANGE.join(', ')}]。下界 3 意味着「单个 warning 刚好够拦」，` +
    '调低会让误报率明显上升；请同步 §6.1');
});

ok('严重度分档是 critical5 / error4 / warning3 / notice2', () => {
  assert.deepStrictEqual(SEVERITY_SCORE, { critical: 5, error: 4, warning: 3, notice: 2 },
    `分档变了：${JSON.stringify(SEVERITY_SCORE)}。这会整体平移拦截率，请同步 §6.1`);
});

ok('下界 3 恰好等于 warning 分（这是设计上的一致点）', () => {
  assert.strictEqual(RANGE[0], SEVERITY_SCORE.warning,
    `阈值下界 ${RANGE[0]} 与 warning 分 ${SEVERITY_SCORE.warning} 不等 —— ` +
    '两者相等意味着「把阈值调到最低时，单个 warning 刚好够拦」，是个有意的对齐');
});

console.log('\n【B. 现状：单发中等特征载荷低于阈值（已知缝隙，等人工决策）】');
ok('单个 error 规则 = 4 分 < 阈值 5 → 放行', () => {
  assert.strictEqual(SEVERITY_SCORE.error, 4);
  assert.ok(SEVERITY_SCORE.error < THRESHOLD,
    `error 分 ${SEVERITY_SCORE.error} 已 ≥ 阈值 ${THRESHOLD} —— 缝隙已关闭，请更新本文件 B 组与 §6.1`);
});

ok('单个 warning 规则默认 = 3 分 < 阈值 5 → 放行', () => {
  assert.ok(SEVERITY_SCORE.warning < THRESHOLD,
    `warning 分已 ≥ 阈值 —— 缝隙已关闭，请更新 §6.1`);
});

ok('单个 critical 规则 = 5 分 ≥ 阈值 → 拦截（证明阈值本身工作正常）', () => {
  assert.ok(SEVERITY_SCORE.critical >= THRESHOLD);
});

// 这 12 条是前几轮 waf-fuzz 里记为 below-threshold 的真实样本
const KNOWN_SLIPS = [
  ["admin'--", 'SQL 注释截断'],
  ['javascript:alert(1)', '伪协议（网络面，warning 1 分）'],
  ['file:///etc/passwd', 'file 伪协议读文件'],
  ['../../etc/passwd', '目录上跳（应命中 critical）'],
  ['<script>alert(1)</script>', '反射型 XSS'],
  ['1 union select 1,2,3', 'UNION 注入'],
  ['or 1=1', '布尔注入'],
  ['sleep(5)', '盲注延时'],
  ['${IFS}id', 'IFS 绕过'],
  ['|whoami', '管道接命令'],
  ['http://127.0.0.1:6379/', 'SSRF 环回'],
  ['%00', '空字节'],
];

ok('高危样本清单仍能命中规则（词库没退化）', () => {
  const silent = KNOWN_SLIPS.filter(([p]) => scoreOf(p).score === 0).map(([p]) => p);
  assert.deepStrictEqual(silent, [],
    `这些载荷一条规则都没命中：${silent.join(' | ')} —— 词库可能退化了`);
});

ok('记录：清单里哪些真的低于阈值（含近似值，仅供人工判断）', () => {
  const rows = KNOWN_SLIPS.map(([p, why]) => ({ p, why, score: scoreOf(p).score }));
  const slips = rows.filter((r) => r.score < THRESHOLD);
  const blocked = rows.filter((r) => r.score >= THRESHOLD);
  console.log(`    低于阈值（放行）${slips.length} 条：` +
    slips.map((r) => `${r.why}「${r.p}」=${r.score}`).join('；'));
  console.log(`    达到阈值（拦截）${blocked.length} 条：` +
    blocked.map((r) => `${r.why}「${r.p}」=${r.score}`).join('；'));

  // 旧记录写的是「12 条单发高危 payload 全部放行」，实测发现只有一部分真的漏 ——
  // 多数（目录上跳/XSS/IFS/空字节）反而达标被拦。
  // 这里断言「漏网的都是中等严重度」，把错误记录的纠偏固化成判据。
  for (const r of slips) {
    assert.ok(r.score < SEVERITY_SCORE.critical,
      `「${r.p}」漏网且分数 ${r.score} ≥ critical 分 —— 说明有 critical 规则没生效`);
  }
  assert.ok(slips.length > 0,
    '一条都不漏了 —— 说明权重/阈值已调整，请更新 §6.1 与本文件');
});

console.log('\n【C. 安全不变量（阈值调到任何允许值都成立）】');
ok('任何规则的分数都在 [2, 5] 内（没有 0 分或爆炸分）', () => {
  for (const r of allRules()) {
    const s = SEVERITY_SCORE[r.sev];
    assert.ok(Number.isFinite(s), `规则 ${r.id} 的 sev=${r.sev} 没有对应分数`);
    assert.ok(s >= 2 && s <= 5, `规则 ${r.id} 分数 ${s} 越界`);
  }
});

ok('把阈值调到允许的最低值 3 时，单个 warning 就够拦', () => {
  assert.ok(SEVERITY_SCORE.warning >= 3, 'warning 分应 ≥ 阈值下界');
});

ok('没有规则被误配成 notice 分（那等于永不参与拦截）', () => {
  const noticeOnly = allRules().filter((r) => r.sev === 'notice').map((r) => r.id);
  assert.deepStrictEqual(noticeOnly, [],
    `这些规则是 notice 分（2 分，任何允许阈值下都拦不住）：${noticeOnly.join(', ')}`);
});

ok('RULE_INDEX 覆盖全部规则（否则命中时 group 会算错）', () => {
  const missing = allRules().filter((r) => !RULE_INDEX[r.id]).map((r) => r.id);
  assert.deepStrictEqual(missing, [], `RULE_INDEX 缺：${missing.join(', ')}`);
});

console.log('\n【D. 键名注入是一票拦截（不看分数）】');
ok('waf.js 仍保留 keyInjected 的硬拦截分支', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'middleware', 'waf.js'), 'utf8');
  assert.ok(/keyInjected/.test(src), '找不到 keyInjected 判定 —— 原型污染一票拦截可能被删了');
  assert.ok(/MSC-KEY-INJECT/.test(src), '找不到 MSC-KEY-INJECT 上报 —— 硬拦截的留痕没了');
});

console.log('\n【E. 自检：判据真的能区分】');
ok(`自检：阈值 ${THRESHOLD} 能区分 4 与 5 两档`, () => {
  assert.ok(SEVERITY_SCORE.error < THRESHOLD && SEVERITY_SCORE.critical >= THRESHOLD,
    'error 应低于阈值、critical 应达标 —— 否则 B 组失去意义');
});
ok('自检：若阈值降到 4，B 组第一条会红', () => {
  const simulated = 4;
  assert.notStrictEqual(simulated, THRESHOLD, '模拟值应与现状不同，否则绊线无效');
  assert.ok(SEVERITY_SCORE.error >= simulated, '降到 4 后 error 会达标');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n⚠ A/B 组红了通常意味着「阈值、严重度分档、或某条规则的 sev 被改动」——' +
    '请确认是有意的，并同步更新本文件期望值与 「WAF 阈值待决策」项');
  process.exit(1);
}
