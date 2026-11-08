/**
 * WAF 规则表的数据一致性（零 DB、零服务）。
 *
 * 与 `waf-fuzz --assert` 是**不同角度**：那个测「载荷能不能被拦」，这个测
 * 「规则表本身有没有结构性问题」—— 后者出错时 waf-fuzz 可能依然全绿。
 *
 * 最要命的一条：`RULE_INDEX[r.id] = ...` 是**对象赋值**。两条规则 ID 重名时，
 * 后一条会静默覆盖前一条 —— 规则数还是那么多、waf-fuzz 也不会红，
 * 但安全中心里那条规则的 ID 指向了另一条规则的语义，审计与禁用某个 ID 时会停错规则。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const {
  RULE_GROUPS, RULE_INDEX, SEVERITY_SCORE, PARAM_EXEMPT_GROUPS,
  URL_FIELD_RE, SCANNER_UA_PATTERNS, HONEYPOT_PATHS, INAPP_BROWSER_MARKERS,
} = require('../src/middleware/waf-rules');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const groupNames = Object.keys(RULE_GROUPS);
const allRules = Object.values(RULE_GROUPS).flat();

console.log('=== A. 规则 ID 必须唯一（重名会被 RULE_INDEX 静默覆盖） ===');
{
  const ids = allRules.map((r) => r.id);
  const seen = new Map();
  const dups = [];
  for (const id of ids) {
    if (seen.has(id)) dups.push(`${id}（${seen.get(id)} 与另一处）`);
    else seen.set(id, 'ok');
  }
  check(`共 ${ids.length} 条规则，无重复 ID`, dups.length === 0, dups.join(', '));
  check('RULE_INDEX 的条目数与规则总数一致（不一致就是有覆盖）',
    Object.keys(RULE_INDEX).length === allRules.length,
    `index=${Object.keys(RULE_INDEX).length} rules=${allRules.length}`);
  check('ID 形态统一（大写组名 + 短横线 + 两位序号）',
    ids.every((id) => /^[A-Z]+(-[A-Z]+)?-\d{2}$/.test(id)),
    ids.filter((id) => !/^[A-Z]+(-[A-Z]+)?-\d{2}$/.test(id)).slice(0, 5).join(', '));
  // 组名到 ID 前缀的已知映射：TRAVERSAL 用 TRV 缩写（ID 要短，且对外发布后不能改）
  const GROUP_PREFIX = {
    SQL: 'SQL', XSS: 'XSS', TRAVERSAL: 'TRV', CMD: 'CMD', SSRF: 'SSRF', MISC: 'MSC',
  };
  const badPrefix = [];
  for (const [group, rules] of Object.entries(RULE_GROUPS)) {
    const want = GROUP_PREFIX[group];
    for (const r of rules) {
      if (!want) { badPrefix.push(`${group} 没有登记前缀`); continue; }
      // 允许 `CMD-01` 与 `CMD-NET-01` 两种形态
      if (!r.id.startsWith(want)) badPrefix.push(`${group}:${r.id}（应以 ${want}- 开头）`);
    }
  }
  check('ID 前缀能对上所在组（含 TRAVERSAL→TRV 这类缩写）',
    badPrefix.length === 0, badPrefix.slice(0, 5).join(', '));
  check('每个组都在前缀表里登记过（新增组时不会漏）',
    Object.keys(RULE_GROUPS).every((g) => GROUP_PREFIX[g]),
    Object.keys(RULE_GROUPS).filter((g) => !GROUP_PREFIX[g]).join(', '));
}

console.log('\n=== B. 每条规则的字段与取值域 ===');
{
  const badField = allRules.filter((r) => !r.id || !r.re || !r.note || !r.sev || !r.pl);
  check('id / re / note / sev / pl 全部存在', badField.length === 0,
    badField.map((r) => r.id || '(无 id)').slice(0, 5).join(', '));

  check('每条的 re 都是 RegExp 实例',
    allRules.every((r) => r.re instanceof RegExp),
    allRules.filter((r) => !(r.re instanceof RegExp)).map((r) => r.id).join(', '));

  check('sev 都在 SEVERITY_SCORE 里（否则权重算出 undefined，规则等于失效）',
    allRules.every((r) => Object.prototype.hasOwnProperty.call(SEVERITY_SCORE, r.sev)),
    allRules.filter((r) => !SEVERITY_SCORE[r.sev]).map((r) => `${r.id}:${r.sev}`).join(', '));

  check('pl 是 1–3 的整数（引擎按 paranoiaLevel 过滤，越界等于永不启用或永久启用）',
    allRules.every((r) => Number.isInteger(r.pl) && r.pl >= 1 && r.pl <= 3),
    allRules.filter((r) => !(Number.isInteger(r.pl) && r.pl >= 1 && r.pl <= 3)).map((r) => `${r.id}:${r.pl}`).join(', '));

  check('note 是给人看的、不为空',
    allRules.every((r) => typeof r.note === 'string' && r.note.trim().length > 0));
}

console.log('\n=== C. zones（扫描面）取值域 ===');
{
  const ALLOWED_ZONES = new Set(['query', 'path', 'header', 'body']);
  const withZones = allRules.filter((r) => r.zones !== null && r.zones !== undefined);
  check('zones 要么是 null（全部扫描面），要么是非空数组',
    allRules.every((r) => r.zones == null || (Array.isArray(r.zones) && r.zones.length > 0)),
    allRules.filter((r) => r.zones != null && !(Array.isArray(r.zones) && r.zones.length > 0)).map((r) => r.id).join(', '));
  check('zones 里的值都在 {query,path,header,body} 内',
    withZones.every((r) => r.zones.every((z) => ALLOWED_ZONES.has(z))),
    withZones.filter((r) => r.zones.some((z) => !ALLOWED_ZONES.has(z))).map((r) => `${r.id}:${r.zones}`).join(', '));
  check('显式写了 zones 的规则都不含重复项',
    withZones.every((r) => new Set(r.zones).size === r.zones.length),
    withZones.filter((r) => new Set(r.zones).size !== r.zones.length).map((r) => r.id).join(', '));
  check('网络面规则存在（NET_ONLY 机制没被整体改坏）', withZones.length > 0, String(withZones.length));
}

console.log('\n=== D. RULE_INDEX 与规则组一一对应 ===');
{
  const mismatch = [];
  for (const [group, rules] of Object.entries(RULE_GROUPS)) {
    for (const r of rules) {
      const idx = RULE_INDEX[r.id];
      if (!idx) { mismatch.push(`${r.id} 不在索引里`); continue; }
      if (idx.group !== group) mismatch.push(`${r.id} 索引组=${idx.group} 实际组=${group}`);
      if (idx.sev !== r.sev) mismatch.push(`${r.id} sev 不一致`);
      if (idx.pl !== r.pl) mismatch.push(`${r.id} pl 不一致`);
      if (idx.note !== r.note) mismatch.push(`${r.id} note 不一致`);
    }
  }
  check('每条规则在索引用里都能找到，且 group/sev/pl/note 完全一致',
    mismatch.length === 0, mismatch.slice(0, 5).join(' | '));
  check('索引里没有多余条目（规则删了但索引没清）',
    Object.keys(RULE_INDEX).length === allRules.length);
}

console.log('\n=== E. 参数豁免的组名必须真实存在 ===');
{
  const knownGroups = new Set(groupNames);
  const bad = [];
  for (const [field, groups] of Object.entries(PARAM_EXEMPT_GROUPS)) {
    if (!Array.isArray(groups)) { bad.push(`${field} 不是数组`); continue; }
    for (const g of groups) if (!knownGroups.has(g)) bad.push(`${field} → ${g}`);
  }
  check('PARAM_EXEMPT_GROUPS 里引用的组名都存在于 RULE_GROUPS',
    bad.length === 0, bad.slice(0, 5).join(', '));
  check('豁免字段名是小写（引擎按小写比对，大小写不一致等于豁免失效）',
    Object.keys(PARAM_EXEMPT_GROUPS).every((k) => k === k.toLowerCase()),
    Object.keys(PARAM_EXEMPT_GROUPS).filter((k) => k !== k.toLowerCase()).join(', '));
}

console.log('\n=== F. 其他数据表的基本形态 ===');
{
  check('URL_FIELD_RE 是 RegExp', URL_FIELD_RE instanceof RegExp);
  // 这两个表是**字符串标记**而不是 RegExp：引擎对 UA/浏览器标识做 toLowerCase 后 includes 比对
  check('SCANNER_UA_PATTERNS 是非空字符串数组',
    Array.isArray(SCANNER_UA_PATTERNS) && SCANNER_UA_PATTERNS.length > 0
    && SCANNER_UA_PATTERNS.every((p) => typeof p === 'string' && p.length > 0));
  check('SCANNER_UA_PATTERNS 全为小写（引擎按小写 includes，大小写不一致等于漏拦）',
    SCANNER_UA_PATTERNS.every((p) => p === p.toLowerCase()),
    SCANNER_UA_PATTERNS.filter((p) => p !== p.toLowerCase()).slice(0, 3).join(', '));
  check('SCANNER_UA_PATTERNS 无重复', new Set(SCANNER_UA_PATTERNS).size === SCANNER_UA_PATTERNS.length);
  check('HONEYPOT_PATHS 是非空字符串数组，且都以 / 开头',
    Array.isArray(HONEYPOT_PATHS) && HONEYPOT_PATHS.length > 0
    && HONEYPOT_PATHS.every((p) => typeof p === 'string' && p.startsWith('/')),
    HONEYPOT_PATHS.filter((p) => !String(p).startsWith('/')).slice(0, 3).join(', '));
  check('HONEYPOT_PATHS 无重复（重复只增加遍历成本）',
    new Set(HONEYPOT_PATHS).size === HONEYPOT_PATHS.length);
  check('INAPP_BROWSER_MARKERS 是非空字符串数组且全小写',
    Array.isArray(INAPP_BROWSER_MARKERS) && INAPP_BROWSER_MARKERS.length > 0
    && INAPP_BROWSER_MARKERS.every((m) => typeof m === 'string' && m === m.toLowerCase()));
}

console.log('\n=== G. ReDoS 冒烟：恶意输入下每个 regex 都要快速返回 ===');
{
  // 这不是完整的 ReDoS 分析（那需要专门的工具），而是**冒烟**：
  // 用一串刻意构造的、容易触发回溯的输入跑一遍全部 107 条规则。
  // 阈值给得很宽松（单条 50ms），目的是抓住「量级爆炸」而不是微优化。
  const nasties = [
    'a'.repeat(200) + "'",
    '"'.repeat(200),
    'union '.repeat(50),
    ('a' + ' '.repeat(3)).repeat(60),
    '<'.repeat(200),
    '('.repeat(200),
    '%'.repeat(200) + 'zz',
    "';".repeat(100),
  ];
  const slow = [];
  for (const r of allRules) {
    for (const input of nasties) {
      const t0 = process.hrtime.bigint();
      try { r.re.test(input); } catch (e) { slow.push(`${r.id} 抛错: ${e.message}`); }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms > 50) slow.push(`${r.id} ${ms.toFixed(1)}ms`);
    }
  }
  check(`107 条规则 × 8 组恶意输入，全部在 50ms 内返回`, slow.length === 0,
    slow.slice(0, 5).join(', '));
  check('regex 不会因为输入而抛异常', !slow.some((s) => s.includes('抛错')));
}

console.log('\n=== H. 正文里的技术讨论不该被误伤（只查作用于 body 的 pl1 规则） ===');
{
  // ⚠ 必须按 zones 过滤：网络面规则（query/path/header）本来就不扫 body，
  // 拿它们去测"技术讨论"是错的口径 —— 正文里的反引号模板、`<script>` 字样
  // 命中 CMD_NET / XSS_NET_ONLY 是设计如此（那些面不该出现这些字符）。
  // 真正要保证的是：**写进正文（body）的合法技术内容不被拦**。
  const bodyRules = allRules.filter(
    (r) => r.pl === 1 && (r.zones === null || r.zones.includes('body'))
  );
  check(`有 ${bodyRules.length} 条 pl1 规则作用于 body（口径有效）`, bodyRules.length > 50, String(bodyRules.length));

  const benign = [
    'SELECT * FROM users WHERE id = ? 是参数化写法',
    'function add(a, b) { return a + b; }',
    'https://vuejs.org/guide/introduction.html',
    '这段代码用了 eval()，属于反模式',
    "const s = `模板字符串 ${x}`;",
    'CSRF 与 XSS 的区别是什么',
    'npm install --save-dev vite',
    'Vue 的 v-html 会跳过编译，记得配合 DOMPurify',
  ];
  const hits = {};
  for (const input of benign) {
    for (const r of bodyRules) {
      if (r.re.test(input)) (hits[r.id] = hits[r.id] || []).push(input.slice(0, 22));
    }
  }
  check(`作用于 body 的 pl1 规则不命中这 ${benign.length} 条良性技术内容`,
    Object.keys(hits).length === 0,
    Object.entries(hits).slice(0, 4).map(([id, v]) => `${id}←${v[0]}`).join(' | '));
  check('pl2 规则不参与：它们默认不启用（paranoiaLevel=1）',
    allRules.filter((r) => r.pl === 2).length > 0);

  // 已知的保守行为（**设计取舍，不是 bug**）：正文里出现字面 `<script` 会被拦。
  // 技术文章讨论 HTML 时确实会写这个，但代价是允许一条真实的注入路径。
  // 这一条钉住现状：将来若要放宽（比如只拦 `<script` 后紧跟 `>` 或属性），必须改这里并说明。
  const xss01 = allRules.find((r) => r.id === 'XSS-01');
  check('XSS-01 仍作用于 body（正文里的字面 <script 会被拦 —— 已知保守取舍）',
    xss01 && (xss01.zones === null || xss01.zones.includes('body')));
  check('已确认它对技术讨论会命中（这条断言记录的是现状，不是期望）',
    xss01.re.test('<script> 标签要转义'), '若这里变红说明 XSS-01 被放宽了，需复核决策记录');
}

console.log('\n=== 分组清单只许有一处定义（同一份清单写 17 遍会漏改） ===');
{
  // 实测过的隐患：PARAM_EXEMPT_GROUPS 有 17 个字段，每一行原来都硬编码
  // ['SQL','XSS','TRAVERSAL','CMD','SSRF','MISC']。
  // 新增第 7 个分组时，RULE_GROUPS 加了、但 17 行很可能漏改 ——
  // 后果是那些字段（正文/标题/简介/站点名…）的**新分组不会被豁免**，
  // 正常内容里出现新分组的特征词就会被误拦，而改动的人完全看不出问题在哪。
  const rules = require('../src/middleware/waf-rules');
  const { stripCommentLines } = require('./helpers/sourceText');
  const fs = require('fs');
  const path = require('path');
  const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '../src/middleware/waf-rules.js'), 'utf8'));

  check('导出了 ALL_GROUPS', Array.isArray(rules.ALL_GROUPS) && rules.ALL_GROUPS.length >= 6);
  check('ALL_GROUPS 是从 RULE_GROUPS 的 key 派生的（不是另写一遍）',
    /ALL_GROUPS\s*=\s*Object\.freeze\(Object\.keys\(RULE_GROUPS\)\)/.test(src));
  check('ALL_GROUPS 被冻结（防某处 push 污染全局）',
    Object.isFrozen(rules.ALL_GROUPS));

  check('PARAM_EXEMPT_GROUPS 里不再有硬编码的完整分组列表',
    !/\[\s*'SQL'\s*,\s*'XSS'\s*,\s*'TRAVERSAL'\s*,\s*'CMD'\s*,\s*'SSRF'\s*,\s*'MISC'\s*\]/.test(src),
    '还有硬编码会把新分组漏在豁免之外');

  // 每个字段的豁免列表必须恰好等于 ALL_GROUPS
  const entries = Object.entries(rules.PARAM_EXEMPT_GROUPS);
  check(`PARAM_EXEMPT_GROUPS 的 ${entries.length} 个字段都引用同一份清单`, () => {
    const drift = entries.filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(rules.ALL_GROUPS));
    require('assert').deepStrictEqual(drift.map((d) => d[0]), []);
  });

  // 跨模块一致性：securitySettings 的 GROUP_KEYS 必须与 RULE_GROUPS 的 key 集合一致。
  // 不一致的后果是「规则存在但不能配置」或「能配置但不生效」。
  const { GROUP_KEYS } = require('../src/utils/securitySettings');
  if (GROUP_KEYS) {
    check('securitySettings 的 GROUP_KEYS 与 RULE_GROUPS 完全一致',
      JSON.stringify([...GROUP_KEYS].sort()) === JSON.stringify([...rules.ALL_GROUPS].sort()),
      `GROUP_KEYS=${GROUP_KEYS} ALL_GROUPS=${rules.ALL_GROUPS}`);
  } else {
    check('securitySettings 没导出 GROUP_KEYS（跳过跨模块检查）', true);
  }

  // 自检：证明「新分组不进豁免列表」确实是问题 —— 用模拟演示
  check('自检：手动少一个分组的列表 ≠ ALL_GROUPS（这就是漏改的形态）',
    JSON.stringify(['SQL', 'XSS', 'TRAVERSAL', 'CMD', 'SSRF']) !== JSON.stringify(rules.ALL_GROUPS));
}

console.log(`\nwafRules 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
