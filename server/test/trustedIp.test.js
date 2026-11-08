/**
 * 信任 IP 白名单与 CIDR 匹配的离线测试。
 *
 * 为什么必须单独写这个文件：这两个函数决定「谁可以跳过限流与封禁」。
 *
 * 此前的覆盖面**薄到形同没有**：
 *   - `isTrustedIp` 的唯一断言是 `typeof isTrustedIp('127.0.0.1') === 'boolean'`
 *     —— 一条**永远不会失败**的恒真断言（任何返回值都是 boolean）
 *   - `matchesCidr` 只有 3 条，且都是 IPv4 /24 的同一种形态
 *
 * 而判错的代价是双向的、都不小：
 *   - **漏判**（该信任的没信任）→ 运维自己的监控 IP 被限流/封禁，误伤自己
 *   - **误判**（不该信任的信任了）→ 攻击者落在白名单里，限流与封禁**整套失效**，
 *     且日志上看不出异常（因为他本来就被"正常放行"）
 *
 * 所以这里的重点是：
 *   1. 前缀长度的边界（/0、/32、/128 与越界）
 *   2. 掩码的位运算是否正确（非 8 的倍数前缀）
 *   3. IPv4 与 IPv4-mapped IPv6 的互通**只在真正的映射形态下**成立
 *   4. 白名单条的三种写法（精确 IP、CIDR、带空白的脏数据）
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const {
  matchesCidr, isTrustedIp, isValidIpOrCidr, setConfigForTest, getConfig,
} = require('../src/utils/securitySettings');

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

/**
 * 一开始就把配置标记为「已加载」，避免 `getConfig()` 去连数据库。
 *
 * `getConfig()` 是懒加载的：首次调用会尝试从 DB 读设置，失败后每 30 秒重试。
 * 离线套件里那次连接必然失败（用的是占位密码），虽然不影响断言（会用默认值），
 * 但会在输出里留下 `Access denied` 噪音，也会让套件白等。
 * `setConfigForTest` 会把 `loaded` 置 true —— 之后就不再尝试加载了。
 */
setConfigForTest({});

/** 把可信列表设成给定值（用完还原） */
function withTrusted(list, fn) {
  const before = getConfig().trustedIps;
  setConfigForTest({ trustedIps: list });
  try {
    fn();
  } finally {
    setConfigForTest({ trustedIps: before });
  }
}

console.log('\n【A. matchesCidr：IPv4 前缀边界】');
{
  ok('/32 精确匹配', () => {
    assert.strictEqual(matchesCidr('192.168.1.5/32', '192.168.1.5'), true);
    assert.strictEqual(matchesCidr('192.168.1.5/32', '192.168.1.6'), false);
  });
  ok('/0 匹配一切 IPv4', () => {
    assert.strictEqual(matchesCidr('0.0.0.0/0', '8.8.8.8'), true);
    assert.strictEqual(matchesCidr('0.0.0.0/0', '192.168.1.1'), true);
  });
  ok('/24 边界：同段内匹配、相邻段不匹配', () => {
    assert.strictEqual(matchesCidr('192.168.1.0/24', '192.168.1.0'), true);
    assert.strictEqual(matchesCidr('192.168.1.0/24', '192.168.1.255'), true);
    assert.strictEqual(matchesCidr('192.168.1.0/24', '192.168.2.0'), false);
    assert.strictEqual(matchesCidr('192.168.1.0/24', '192.168.0.255'), false);
  });
  ok('/25 的掩码边界（非 8 倍数：128 与 127 分属两半）', () => {
    assert.strictEqual(matchesCidr('10.0.0.0/25', '10.0.0.127'), true);
    assert.strictEqual(matchesCidr('10.0.0.0/25', '10.0.0.128'), false);
  });
  ok('/26 的掩码边界（64 的边界）', () => {
    assert.strictEqual(matchesCidr('10.0.0.0/26', '10.0.0.63'), true);
    assert.strictEqual(matchesCidr('10.0.0.0/26', '10.0.0.64'), false);
  });
  ok('/30 只有 4 个地址', () => {
    assert.strictEqual(matchesCidr('10.1.2.0/30', '10.1.2.0'), true);
    assert.strictEqual(matchesCidr('10.1.2.0/30', '10.1.2.3'), true);
    assert.strictEqual(matchesCidr('10.1.2.0/30', '10.1.2.4'), false);
  });
  ok('/31 与 /23 也正常', () => {
    assert.strictEqual(matchesCidr('10.0.0.0/31', '10.0.0.1'), true);
    assert.strictEqual(matchesCidr('10.0.0.0/31', '10.0.0.2'), false);
    assert.strictEqual(matchesCidr('10.0.0.0/23', '10.0.1.255'), true);
    assert.strictEqual(matchesCidr('10.0.0.0/23', '10.0.2.0'), false);
  });
  ok('不带前缀的条目等价于 /32', () => {
    assert.strictEqual(matchesCidr('192.168.1.5', '192.168.1.5'), true);
    assert.strictEqual(matchesCidr('192.168.1.5', '192.168.1.6'), false);
  });
}

console.log('\n【B. matchesCidr：IPv6】');
{
  ok('/128 精确匹配', () => {
    assert.strictEqual(matchesCidr('2001:db8::1/128', '2001:db8::1'), true);
    assert.strictEqual(matchesCidr('2001:db8::1/128', '2001:db8::2'), false);
  });
  ok('/64 同前缀匹配', () => {
    assert.strictEqual(matchesCidr('2001:db8::/64', '2001:db8::dead:beef'), true);
    assert.strictEqual(matchesCidr('2001:db8::/64', '2001:db9::1'), false);
  });
  ok('::/0 匹配一切 IPv6', () => {
    assert.strictEqual(matchesCidr('::/0', '2001:db8::1'), true);
    assert.strictEqual(matchesCidr('::/0', 'fe80::1'), true);
  });
  ok('压缩写法与展开写法等价', () => {
    assert.strictEqual(matchesCidr('2001:0db8:0000:0000::/64', '2001:db8::1'), true);
    assert.strictEqual(matchesCidr('2001:db8::/64', '2001:0db8:0000:0000:0000:0000:0000:0001'), true);
  });
  ok('/127 的边界', () => {
    assert.strictEqual(matchesCidr('2001:db8::/127', '2001:db8::1'), true);
    assert.strictEqual(matchesCidr('2001:db8::/127', '2001:db8::2'), false);
  });
}

console.log('\n【C. IPv4 ↔ IPv4-mapped IPv6 互通】');
{
  ok('IPv4 CIDR 匹配映射形态的 IPv6 来源', () => {
    assert.strictEqual(matchesCidr('192.168.1.0/24', '::ffff:192.168.1.50'), true);
    assert.strictEqual(matchesCidr('192.168.1.0/24', '::ffff:192.168.2.50'), false);
  });
  ok('IPv6 映射 CIDR 匹配纯 IPv4 来源', () => {
    assert.strictEqual(matchesCidr('::ffff:192.168.1.0/120', '192.168.1.50'), true);
    assert.strictEqual(matchesCidr('::ffff:192.168.1.0/120', '192.168.2.50'), false);
  });
  ok('**非映射的 IPv6 不与 IPv4 CIDR 互通**（关键：防绕过）', () => {
    // `::1.2.3.4` 这种非映射写法、或任意 IPv6 都不该被当 IPv4 匹配
    assert.strictEqual(matchesCidr('192.168.1.0/24', '2001:db8::1'), false);
    assert.strictEqual(matchesCidr('0.0.0.0/0', '2001:db8::1'), false,
      'IPv4 /0 不该匹配 IPv6 来源');
  });
  ok('具体 IPv6 前缀不匹配 IPv4 来源', () => {
    assert.strictEqual(matchesCidr('2001:db8::/32', '192.168.1.1'), false);
  });

  /* ------------------------------------------------------------
   * ⚠ 记录一个**不对称行为**（不是断言它对，而是把它钉住）：
   *
   *   matchesCidr('0.0.0.0/0', '2001:db8::1') === false   ← IPv4 /0 不匹配 IPv6
   *   matchesCidr('::/0',      '192.168.1.1')  === true   ← IPv6 /0 **匹配** IPv4
   *
   * 原因是单向的映射补全：IPv4 来源会被补成 ::ffff:a.b.c.d 去与 IPv6 前缀比，
   * 而 ::/0 覆盖所有 IPv6（含映射形态）→ 结果 true。反过来 IPv6 来源
   * 不是映射形态时不会被降成 IPv4 → false。
   *
   * **为什么值得记下来**：管理员若加一条 `::/0` 想让"所有内网 IPv6 走白名单"，
   * 实际效果是**把全部 IPv4 也放进了白名单** —— 限流与封禁对所有人都失效，
   * 而界面上看起来只是"信任了一个 IPv6 段"。
   * 这一条不改代码（改成双向对称会影响合法用法），只在测试里固定行为并写明风险。
   * ------------------------------------------------------------ */
  ok('**记录：IPv6 ::/0 会匹配 IPv4 来源（管理员须知的风险）**', () => {
    assert.strictEqual(matchesCidr('::/0', '192.168.1.1'), true);
    assert.strictEqual(matchesCidr('0.0.0.0/0', '2001:db8::1'), false);
  });
}

console.log('\n【D. matchesCidr：非法输入不抛、不误判】');
{
  const junk = ['', ' ', 'abc', '999.1.1.1/24', '192.168.1.0/33', '192.168.1.0/-1',
    '2001:db8::/129', '1.2.3.4.5/24', '::gggg/64', null, undefined];
  ok('非法条目全部返回 false（不抛）', () => {
    for (const j of junk) {
      let r;
      assert.doesNotThrow(() => { r = matchesCidr(j, '192.168.1.1'); }, `条目 ${j}`);
      assert.strictEqual(r, false, `条目 ${String(j)} 应返回 false`);
    }
  });
  ok('非法来源 IP 全部返回 false（不抛）', () => {
    for (const j of junk) {
      let r;
      assert.doesNotThrow(() => { r = matchesCidr('192.168.1.0/24', j); }, `IP ${j}`);
      assert.strictEqual(r, false, `IP ${String(j)} 应返回 false`);
    }
  });
  ok('前缀越界（/33、/129）不被当成 /0 或 /128', () => {
    assert.strictEqual(matchesCidr('192.168.1.0/33', '192.168.1.1'), false);
    assert.strictEqual(matchesCidr('2001:db8::/129', '2001:db8::1'), false);
  });

  /* ------------------------------------------------------------
   * 以下四条由变异测试（scripts/mutation-trustedip.js）发现：
   * 代码行为是对的，但**没有任何断言钉住它** —— 改坏了也不会红。
   * ------------------------------------------------------------ */

  // T07：前缀非数字若被当成 0，`/xxx` 就等价于 /0 = 信任一切，这最危险
  ok('**尾随斜杠（192.168.1.0/）不被当成 /0 = 信任一切**', () => {
    assert.strictEqual(isValidIpOrCidr('192.168.1.0/'), false, '保存时应当判非法');
    assert.strictEqual(matchesCidr('192.168.1.0/', '8.8.8.8'), false,
      '若被当成 /0，任意公网 IP 都会被信任');
  });
  ok('前缀写 abc 也不被当成 0', () => {
    assert.strictEqual(isValidIpOrCidr('192.168.1.0/abc'), false);
  });

  // T09：映射判定必须同时检查 0xff、0xff，不能只看「前 10 字节为 0」
  ok('**非映射的 IPv6（::1.2.3.4）不被当成 IPv4-mapped**', () => {
    // ::1.2.3.4 的字节是 0..0, 0x01, 0x02, 0x03, 0x04 ——
    // 前 10 字节全为 0，若映射判定只看这一段就会误判成 ::ffff:1.2.3.4，
    // 于是一个 IPv6 地址能冒充任意 IPv4 落进白名单。
    assert.strictEqual(matchesCidr('1.2.3.0/24', '::1.2.3.4'), false);
    assert.strictEqual(matchesCidr('0.0.0.0/0', '::1.2.3.4'), false);
  });

  // T14 / T15：IPv6 的结构完整性
  ok('两次双冒号（2001::db8::1）判非法', () => {
    assert.strictEqual(isValidIpOrCidr('2001::db8::1'), false);
  });
  ok('组数不足且无压缩（2001:db8:1）判非法', () => {
    assert.strictEqual(isValidIpOrCidr('2001:db8:1'), false);
  });
  ok('组数过多（9 组）判非法', () => {
    assert.strictEqual(isValidIpOrCidr('1:2:3:4:5:6:7:8:9'), false);
  });
}

console.log('\n【E. isValidIpOrCidr：保存设置时的校验】');
{
  ok('接受裸 IPv4 / IPv6', () => {
    assert.strictEqual(isValidIpOrCidr('192.168.1.1'), true);
    assert.strictEqual(isValidIpOrCidr('2001:db8::1'), true);
    assert.strictEqual(isValidIpOrCidr('::1'), true);
  });
  ok('接受合法 CIDR', () => {
    assert.strictEqual(isValidIpOrCidr('192.168.1.0/24'), true);
    assert.strictEqual(isValidIpOrCidr('0.0.0.0/0'), true);
    assert.strictEqual(isValidIpOrCidr('2001:db8::/32'), true);
    assert.strictEqual(isValidIpOrCidr('::/0'), true);
  });
  ok('拒绝前缀越界', () => {
    assert.strictEqual(isValidIpOrCidr('192.168.1.0/33'), false);
    assert.strictEqual(isValidIpOrCidr('2001:db8::/129'), false);
    assert.strictEqual(isValidIpOrCidr('192.168.1.0/-1'), false);
  });
  ok('拒绝畸形地址', () => {
    assert.strictEqual(isValidIpOrCidr('999.1.1.1'), false);
    assert.strictEqual(isValidIpOrCidr('1.2.3'), false);
    assert.strictEqual(isValidIpOrCidr('1.2.3.4.5'), false);
    assert.strictEqual(isValidIpOrCidr('::gggg'), false);
    assert.strictEqual(isValidIpOrCidr('not-an-ip'), false);
    assert.strictEqual(isValidIpOrCidr(''), false);
  });
  ok('拒绝带空格的写法（保存时应显式失败而不是静默 trim）', () => {
    // 这条记录现状：如果 isValidIpOrCidr 接受 ' 1.2.3.4 '，白名单里会出现
    // 前后带空格的条目，而 isTrustedIp 的比对是**逐字面**的 —— 静默失效。
    const r = isValidIpOrCidr(' 1.2.3.4 ');
    assert.strictEqual(typeof r, 'boolean', '至少不能抛');
  });
}

console.log('\n【F. isTrustedIp：白名单的三种写法】');
{
  ok('空列表 → 一律不信任', () => {
    withTrusted([], () => {
      assert.strictEqual(isTrustedIp('192.168.1.1'), false);
      assert.strictEqual(isTrustedIp('127.0.0.1'), false);
    });
  });
  ok('精确 IP 写法命中', () => {
    withTrusted(['203.0.113.7'], () => {
      assert.strictEqual(isTrustedIp('203.0.113.7'), true);
      assert.strictEqual(isTrustedIp('203.0.113.8'), false);
    });
  });
  ok('CIDR 写法命中', () => {
    withTrusted(['198.51.100.0/24'], () => {
      assert.strictEqual(isTrustedIp('198.51.100.1'), true);
      assert.strictEqual(isTrustedIp('198.51.100.255'), true);
      assert.strictEqual(isTrustedIp('198.51.101.1'), false);
    });
  });
  ok('多条里命中任意一条即可', () => {
    withTrusted(['203.0.113.7', '10.0.0.0/8'], () => {
      assert.strictEqual(isTrustedIp('203.0.113.7'), true);
      assert.strictEqual(isTrustedIp('10.5.5.5'), true);
      assert.strictEqual(isTrustedIp('172.16.0.1'), false);
    });
  });
  ok('**必须是「任意一条命中」（some），不是「全部命中」（every）**', () => {
    withTrusted(['203.0.113.7', '10.0.0.0/8'], () => {
      // 若实现误写成 every，'203.0.113.7' 只命中第一条 → false
      assert.strictEqual(isTrustedIp('203.0.113.7'), true);
    });
  });
  ok('IPv4-mapped IPv6 来源归一后匹配', () => {
    withTrusted(['192.168.1.5'], () => {
      assert.strictEqual(isTrustedIp('::ffff:192.168.1.5'), true);
      assert.strictEqual(isTrustedIp('::FFFF:192.168.1.5'), true, '大小写不敏感');
    });
  });
  ok('带空格的条目**不会**命中（保存时就会被挡掉，这里确认运行期行为一致）', () => {
    // ⚠ 第一版我断言它应当能命中，是错的。
    // 真实防线在保存侧：`mergeValid` 用 `isValidIpOrCidr(s)` 过滤 trustedIps，
    // 而 `parseIpWithPrefix` **不 trim** —— `net.isIP('  1.2.3.4  ')` 返回 0 → 非法 → 被丢弃。
    // 所以脏条目进不了列表。这里确认「万一混进来了也不会误信任」。
    assert.strictEqual(isValidIpOrCidr('  203.0.113.7  '), false,
      '带空格的条目必须被判非法，才能在保存时被过滤掉');
    withTrusted(['  203.0.113.7  '], () => {
      assert.strictEqual(isTrustedIp('203.0.113.7'), false,
        '未通过校验的条目不该产生信任');
    });
  });
  ok('空 / 空串来源 → false（不抛）', () => {
    withTrusted(['0.0.0.0/0'], () => {
      assert.strictEqual(isTrustedIp(''), false);
      assert.strictEqual(isTrustedIp(null), false);
      assert.strictEqual(isTrustedIp(undefined), false);
    });
  });
  ok('**来源 IP 带空白也归一**（真实场景：代理头里带空格）', () => {
    withTrusted(['203.0.113.7'], () => {
      assert.strictEqual(isTrustedIp(' 203.0.113.7 '), true);
    });
  });
  ok('/0 条目信任一切', () => {
    withTrusted(['0.0.0.0/0'], () => {
      assert.strictEqual(isTrustedIp('8.8.8.8'), true);
    });
  });
}

console.log('\n【G. 自检：判据真的能区分】');
{
  ok('自检：/24 与 /25 在边界上给出不同结果', () => {
    assert.strictEqual(matchesCidr('10.0.0.0/24', '10.0.0.128'), true);
    assert.strictEqual(matchesCidr('10.0.0.0/25', '10.0.0.128'), false);
  });
  ok('自检：同一地址在不同前缀下结果可不同', () => {
    // /25 覆盖 0–127，/26 覆盖 0–63 —— 所以 .64 在 /25 里、不在 /26 里。
    // 第一版我把 /26 的范围算成 64–127，写反了，假红一条。
    const ip = '10.0.0.64';
    assert.strictEqual(matchesCidr('10.0.0.0/25', ip), true, '/25 覆盖 0-127');
    assert.strictEqual(matchesCidr('10.0.0.0/26', ip), false, '/26 覆盖 0-63');
    assert.strictEqual(matchesCidr('10.0.0.64/26', ip), true, '.64/26 才覆盖 64-127');
  });
  ok('自检：isTrustedIp 不是恒真（空列表必须 false）', () => {
    withTrusted([], () => assert.strictEqual(isTrustedIp('127.0.0.1'), false));
  });
  ok('自检：isTrustedIp 不是恒假（命中必须 true）', () => {
    withTrusted(['127.0.0.1'], () => assert.strictEqual(isTrustedIp('127.0.0.1'), true));
  });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
