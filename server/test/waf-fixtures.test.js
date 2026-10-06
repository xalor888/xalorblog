/**
 * WAF 语料回归套件（fixture-based，CRS tests/regression 方法论的本地版）
 *
 * 两类语料：
 *   - fixtures/attack.json：每条规则至少一个必命中样本（跑器强制覆盖率：
 *     RULE_INDEX 里的每个规则 ID 都必须有攻击样本，规则与语料同步演进）
 *   - fixtures/benign.json：真实用户内容必须放行（含历史误杀案回归），
 *     verdict 语义——clean=零命中 / monitor=低分命中不拦截（评分制下的监控态）
 *
 * pl2 规则的样本由跑器临时把 paranoiaLevel 提到 2 执行（setConfigForTest），
 * 结束后恢复 1——与生产默认一致。
 * 运行：node test/waf-fixtures.test.js（npm test 链的一环）
 */
const { scanAll, scanRequestBody, RULE_INDEX } = require('../src/middleware/waf');
const { setConfigForTest } = require('../src/utils/securitySettings');

const attack = require('./waf/fixtures/attack.json');
const benign = require('./waf/fixtures/benign.json');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(name + (extra ? ` | ${extra}` : ''));
  }
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && extra ? ` | ${extra}` : ''}`);
}

const THRESHOLD = Number(require('../src/utils/securitySettings').getConfig().anomalyThreshold) || 5;

/** 单条语料执行：返回 { hits, score }
 *  body 模式两种形态：body 对象直扫 / key+value 验证参数豁免（scanRequestBody） */
function runCase(c) {
  if (c.body) return scanRequestBody(c.body);
  if (c.key !== undefined) return scanRequestBody({ [c.key]: c.value });
  const opts = c.keyword ? { skipGroups: ['SSRF'] } : {};
  return scanAll(String(c.value ?? ''), c.scope || 'query', opts);
}

console.log('\n=== 1. 攻击语料：每条样本必须命中指定规则 ===');
const seenRuleIds = new Set();
for (const c of attack.cases) {
  if (c.pl2) setConfigForTest({ paranoiaLevel: 2 });
  try {
    const { hits } = runCase(c);
    seenRuleIds.add(c.id);
    const hitIds = hits.map((h) => h.id);
    assert(`拦截 ${c.id}${c.name ? `（${c.name}）` : ''}`, hitIds.includes(c.id), `命中=[${hitIds.join(',')}]`);
  } finally {
    if (c.pl2) setConfigForTest({ paranoiaLevel: 1 });
  }
}

console.log('\n=== 2. 覆盖率门禁：RULE_INDEX 每条规则都有攻击语料 ===');
const indexedIds = Object.keys(RULE_INDEX);
for (const id of indexedIds) {
  assert(`语料覆盖 ${id}`, seenRuleIds.has(id), 'attack.json 缺少该规则的样本');
}
assert('语料引用的规则 ID 全部合法', [...seenRuleIds].every((id) => RULE_INDEX[id] || id === 'MSC-CRLF'),
  [...seenRuleIds].filter((id) => !RULE_INDEX[id] && id !== 'MSC-CRLF').join(','));

console.log('\n=== 3. 良性语料：按 verdict 放行（clean=零命中 / monitor=低分不拦） ===');
for (const c of benign.cases) {
  const { hits, score } = runCase(c);
  const hitIds = [...new Set(hits.map((h) => h.id))].join(',');
  if (c.verdict === 'clean') {
    assert(`放行 ${c.name}`, hits.length === 0, `score=${score} 命中=[${hitIds}]`);
  } else if (c.verdict === 'monitor') {
    assert(`监控不拦 ${c.name}`, score > 0 && score < THRESHOLD, `score=${score} 命中=[${hitIds}]`);
  } else {
    assert(`放行 ${c.name}`, false, `未知 verdict: ${c.verdict}`);
  }
}

console.log('\n=== 4. 评分语义抽查：critical 一票过阈、低分累计成势 ===');
{
  const one = scanAll("1' OR '1'='1", 'query');
  const sum = one.hits.reduce((s, h) => s + h.score, 0);
  assert('单条 SQLi 同义态累计过阈', sum >= THRESHOLD, `score=${sum}`);
  const mon = scanAll('admin\'--', 'query');
  const monSum = mon.hits.reduce((s, h) => s + h.score, 0);
  assert('单条低置信命中低于阈值', monSum > 0 && monSum < THRESHOLD, `score=${monSum}`);
  const none = scanAll('完全是正常的一句话', 'query');
  assert('正常内容零命中', none.hits.length === 0 && none.score === 0);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
