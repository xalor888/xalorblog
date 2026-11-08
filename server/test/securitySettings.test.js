/**
 * securitySettings 纯逻辑测试（**不连数据库**）
 *
 * 覆盖两处「安静地错」的缺陷：
 *  1. saveConfig 以 getConfig()（可能是加载失败后留下的默认值）为合并基线，
 *     把库内权威配置整体写成默认值 —— 这里用 { base } 显式给基线，
 *     再断言「只有本次提交的字段变化」。
 *  2. 数值钳制与列表过滤失效会让非法值直接落库/生效。
 *
 * 依赖：**无**（不 require db 之外的运行时资源；saveConfig 全部走 persist:false，
 * 因此没有任何一次 IO，也不会因环境无 MySQL 而变红）。
 */

const fs = require('fs');
const path = require('path');

const {
  saveConfig,
  setConfigForTest,
  getConfig,
  isAllowedText,
} = require('../src/utils/securitySettings');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond) {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(name);
  }
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
}

/** 空 base 等价于「库内还没有配置行，一切都是默认值」 */
const NO_PERSISTED = {};

(async () => {
  /* ---- 1. 局部保存只改提交的字段，其余保持库内值 ---- */
  // 模拟库里真实存着的配置（站长上次保存的白名单/敏感词/阈值/规则组）
  const persisted = {
    trustedIps: ['9.9.9.9'],
    customSensitiveWords: ['坏词'],
    banScore: 42,
    groups: { SQL: false },
    paranoiaLevel: 2,
  };
  const saved = await saveConfig({ paranoiaLevel: 3 }, { base: persisted, persist: false });
  assert('局部保存后 trustedIps 保留', JSON.stringify(saved.trustedIps) === JSON.stringify(['9.9.9.9']));
  assert('局部保存后 customSensitiveWords 保留', JSON.stringify(saved.customSensitiveWords) === JSON.stringify(['坏词']));
  assert('局部保存后 banScore 保留', saved.banScore === 42);
  assert('局部保存后 groups.SQL 保留', saved.groups.SQL === false);
  assert('未提交的规则组回落到默认（true）', saved.groups.XSS === true);
  assert('只有 paranoiaLevel 变化', saved.paranoiaLevel === 3);
  assert('返回的就是缓存（同步读路径可见）', getConfig().paranoiaLevel === 3 && getConfig().banScore === 42);

  const patchedGroups = await saveConfig({ groups: { MISC: false } }, { base: persisted, persist: false });
  assert('groups 局部提交不影响其他组', patchedGroups.groups.SQL === false && patchedGroups.groups.MISC === false && patchedGroups.groups.CMD === true);
  assert('groups 局部提交不动数值字段', patchedGroups.banScore === 42 && patchedGroups.paranoiaLevel === 2);

  /* ---- 2. 数值钳制 ---- */
  const clamped = await saveConfig(
    { paranoiaLevel: 9, banScore: 0, weights: { honeypot: 999 } },
    { base: NO_PERSISTED, persist: false },
  );
  assert('paranoiaLevel 9 被钳到 3', clamped.paranoiaLevel === 3);
  assert('banScore 0 被钳到 5', clamped.banScore === 5);
  assert('weights.honeypot 999 被钳到 20', clamped.weights.honeypot === 20);
  assert('未提交的权重保持默认', clamped.weights.waf === 3 && clamped.weights.rate === 2);

  /* ---- 3. 非法值不污染配置 ---- */
  const filtered = await saveConfig(
    { trustedIps: ['not-an-ip', '11.11.11.11'], allowWords: ['回收', '', '   '] },
    { base: NO_PERSISTED, persist: false },
  );
  assert('非法 IP 项被丢弃，只留合法项', JSON.stringify(filtered.trustedIps) === JSON.stringify(['11.11.11.11']));
  assert('空/纯空白豁免词被过滤', JSON.stringify(filtered.allowWords) === JSON.stringify(['回收']));

  const badCidr = await saveConfig({ trustedIps: ['10.0.0.0/33', '10.0.0.0/8'] }, { base: NO_PERSISTED, persist: false });
  assert('越界 CIDR 被丢弃，合法 CIDR 保留', JSON.stringify(badCidr.trustedIps) === JSON.stringify(['10.0.0.0/8']));

  // 非数值输入（NaN 路径）必须被忽略而不是写成 NaN；注意 null 会被 Number(null)=0
  // 再钳到区间下界，那是既有强制转换行为，不在本次收敛范围内，故只锁 NaN 分支
  const badNums = await saveConfig({ scanThreshold: 'abc', anomalyThreshold: {} }, { base: NO_PERSISTED, persist: false });
  assert('非数值输入不覆盖默认阈值', badNums.scanThreshold === 12 && badNums.anomalyThreshold === 5);

  /* ---- 4. 豁免词「严格相邻」语义仍然成立 ---- */
  setConfigForTest({ customSensitiveWords: ['垃圾', '加微信'], allowWords: ['回收'] });
  assert(
    '「Java 的垃圾回收机制」命中「垃圾」可被豁免',
    isAllowedText('Java 的垃圾回收机制', '垃圾') === true,
  );
  assert(
    '「垃圾回收，加微信领取」命中「加微信」不被豁免',
    isAllowedText('垃圾回收，加微信领取', '加微信') === false,
  );
  assert(
    '「垃圾回收，加微信领取」命中「垃圾」仍被豁免（相邻关系按命中词各自判定）',
    isAllowedText('垃圾回收，加微信领取', '垃圾') === true,
  );
  assert('无豁免上下文时正常命中', isAllowedText('垃圾处理技术讨论', '垃圾') === false);

  console.log(`securitySettings 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('securitySettings 套件异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});

console.log('\n=== 规则 ID 白名单不能被原型链键绕过（与 share-page 同一个坑） ===');
{
  // 实测过的缺陷：校验写的是 `!RULE_INDEX[id]`，而 RULE_INDEX 是普通对象字面量 ——
  // `RULE_INDEX['constructor']` / `['toString']` / `['__proto__']` 都返回 Object.prototype
  // 上的函数（真值），于是这些名字能通过「未知规则 ID」校验并被写进 disabledRules。
  // 影响不算致命（WAF 判断禁用用的是字符串 includes，规则不会被真禁用），
  // 但配置里会留垃圾条目、后台显示「已禁用规则：constructor」、`.group` 是 undefined。
  const { RULE_INDEX } = require('../src/middleware/waf');
  const isKnownRule = (id) => Object.prototype.hasOwnProperty.call(RULE_INDEX, String(id));

  assert('真实规则 ID 仍被接受', isKnownRule('TRV-01'));
  assert('真实规则 ID 有 group（说明白名单项结构完整）',
    typeof RULE_INDEX['TRV-01'].group === 'string');

  for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert(`原型链键 ${id} 不被当成规则`, !isKnownRule(id));
  }

  // 反面自检：证明裸索引确实会让它们通过 —— 否则上面那些断言没有意义
  assert('自检：裸索引 RULE_INDEX["constructor"] 是真值（这就是原缺陷）',
    !!RULE_INDEX['constructor'] && RULE_INDEX['constructor'].group === undefined);

  // 源码层：admin.js 的校验必须带守卫
  const { stripCommentLines } = require('./helpers/sourceText');
  const adminSrc = stripCommentLines(fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8'));
  assert('admin.js 的规则校验用了 hasOwnProperty 守卫',
    /hasOwnProperty\.call\(RULE_INDEX,\s*String\(id\)\)/.test(adminSrc),
    '直接 !RULE_INDEX[id] 会让原型链键通过');
  assert('没有退回裸索引校验', !/filter\(\(id\)\s*=>\s*!RULE_INDEX\[id\]\)/.test(adminSrc));

  // securitySettings 里的 disabledRules 用的是正则白名单 —— 比 hasOwnProperty 更严，
  // 两者都能挡住原型链键，但正则还能挡住大小写/格式不对的伪造 ID。
  const ssSrc = stripCommentLines(fs.readFileSync(path.join(__dirname, '../src/utils/securitySettings.js'), 'utf8'));
  // 实际写的是 `/^[A-Z]+-\d{1,3}$/` —— 比 hasOwnProperty 更严：还能挡住格式不对的伪造 ID
  assert('securitySettings 侧对 disabledRules 另有一层格式白名单',
    /\^\[A-Z\]\+-/.test(ssSrc), '应有 /^[A-Z]+-\\d{1,3}$/ 这样的形态校验');
}
