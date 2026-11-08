#!/usr/bin/env node
/**
 * securitySettings.js 的 CIDR / 信任 IP 部分的变异测试。
 *
 * 为什么选它：`isTrustedIp` 决定「谁可以跳过限流与封禁」。
 * 此前它的唯一断言是 `typeof isTrustedIp('127.0.0.1') === 'boolean'` ——
 * **一条永远不会失败的恒真断言**（任何返回值都是 boolean）。
 * `matchesCidr` 也只有 3 条 IPv4 /24 用例。
 *
 * 判错两个方向代价都不小：
 *   - 漏判 → 运维自己的监控 IP 被限流，误伤自己
 *   - 误判 → 攻击者落在白名单里，限流与封禁**整套失效**，日志上看不出异常
 *
 * 用法：
 *   node scripts/mutation-trustedip.js
 *   node scripts/mutation-trustedip.js --strict
 */

'use strict';

const { join } = require('path');
const { runMutations } = require('./lib/mutation-runner');

const ROOT = join(__dirname, '..');
const TARGET = join(ROOT, 'src', 'utils', 'securitySettings.js');
const TEST = join(ROOT, 'test', 'trustedIp.test.js');

const MUTATIONS = [
  // ---------- matchesCidr：掩码与比较 ----------
  {
    id: 'T01',
    desc: '掩码位数算错（8 - take → 8 - take + 1，前缀比实际宽一位）',
    from: '    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;',
    to: '    const mask = take === 8 ? 0xff : (0xff << (9 - take)) & 0xff;',
  },
  {
    id: 'T02',
    desc: '比较符反转（!== → ===，命中反而返回 false）',
    from: '    if ((target[i] & mask) !== (parsed.bytes[i] & mask)) return false;',
    to: '    if ((target[i] & mask) === (parsed.bytes[i] & mask)) return false;',
  },
  {
    id: 'T03',
    desc: '前缀耗尽后不跳出（remaining <= 0 → break 被删）',
    from: '    if (remaining <= 0) break;',
    to: '    // 注入：不提前跳出',
        // **等价变异**：remaining 归零后 take=min(8,0)=0，mask=0，比较恒等 → 循环空转。结果相同。
    equivalent: true,
  },
  {
    id: 'T04',
    desc: 'remaining 扣减量算错（take → 8）',
    from: '    remaining -= take;',
    to: '    remaining -= 8;',
        // **等价变异**：掩码只可能在**最后一个被比较的字节**上取部分位（IPv4 是第 4 字节、
        // IPv6 的第 5 字节），之后立即 break，扣减 8 还是 take 都不影响已比过的位。
    equivalent: true,
  },
  {
    id: 'T05',
    desc: '前缀越界检查放宽（prefixLen > maxBits → > 128）',
    from: '    if (prefixLen < 0 || prefixLen > maxBits) return null;',
    to: '    if (prefixLen < 0 || prefixLen > 128) return null;',
  },
  {
    id: 'T06',
    desc: '前缀允许负数',
    from: '    if (prefixLen < 0 || prefixLen > maxBits) return null;',
    to: '    if (prefixLen > maxBits) return null;',
        // **等价变异**：`/^\d{1,3}$/` 已经拒绝负号，去掉 `< 0` 检查是死代码。
    equivalent: true,
  },
  {
    id: 'T07',
    desc: '前缀非数字被当成 0（/abc → /0 = 信任一切）',
    from: '    if (!/^\\d{1,3}$/.test(prefixRaw)) return null;',
    to: '    if (!/^\\d*$/.test(prefixRaw)) return null;',
  },

  // ---------- IPv4 / IPv6 互通 ----------
  {
    id: 'T08',
    desc: '**IPv4 来源不做映射校验**（任意 IPv6 都被当 IPv4 比 → 绕过）',
    from: '      const isMapped = target.slice(0, 10).every((b) => b === 0) && target[10] === 0xff && target[11] === 0xff;',
    to: '      const isMapped = true;   // 注入：不做映射校验',
  },
  {
    id: 'T09',
    desc: '映射判定只看前 10 字节（漏掉 0xffff 标记）',
    from: '      const isMapped = target.slice(0, 10).every((b) => b === 0) && target[10] === 0xff && target[11] === 0xff;',
    to: '      const isMapped = target.slice(0, 10).every((b) => b === 0);',
  },
  {
    id: 'T10',
    desc: 'IPv4→IPv6 映射补全时用错前缀字节',
    from: '      target = Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), target]);',
    to: '      target = Buffer.concat([Buffer.alloc(12), target]);',
  },
  {
    id: 'T11',
    desc: '不做长度一致性检查（不同长度的地址直接比）',
    from: '  if (target.length !== parsed.bytes.length) return false;',
    to: '  // 注入：不检查长度',
        // **等价变异**：互通归一化之后两边的长度必然一致，这条是防御性断言（不可达）。
    equivalent: true,
  },

  // ---------- ip4ToBytes / ip6ToBytes ----------
  {
    id: 'T12',
    desc: 'IPv4 段上界放宽（255 → 256）',
    from: '  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {',
    to: '  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 256)) {',
        // **等价变异**：ip4ToBytes 的调用方都先过了 net.isIP / net.isIPv4 ——
        // '192.168.1.256' 到不了这里。属于纵深防御，删掉它不可观察。
    equivalent: true,
  },
  {
    id: 'T13',
    desc: 'IPv4 组数检查放宽（!== 4 → < 4）',
    from: '  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {',
    to: '  if (parts.length > 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {',
        // **等价变异**：同上，组数检查是纵深防御（net.isIP 已经拦下）。
    equivalent: true,
  },
  {
    id: 'T14',
    desc: 'IPv6 压缩写法允许出现两次 ::',
    from: '  if (dc.length > 2) throw new Error(\'bad ipv6\');',
    to: '  if (dc.length > 3) throw new Error(\'bad ipv6\');',
        // **等价变异**（实测确认）：去掉这条后 `2001::db8::1` 仍被拒 ——
        // dc.length 变成 3，下面的 `dc.length === 2 ? missing < 0 : missing !== 0`
        // 会走「无压缩写法」分支，要求 missing 必须为 0，而实际是 6 → 仍然 throw。
        // 这条是「早失败」，不是唯一防线。
    equivalent: true,
  },
  {
    id: 'T15',
    desc: 'IPv6 组数不校验（缺组不补零）',
    from: '  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) throw new Error(\'bad ipv6\');',
    to: '  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) throw new Error(\'bad ipv6\');',
        // **等价变异**：前面的 missing 检查已经保证 groups 恰好 8 组，
        // 这条 groups.length 校验是冗余的（正则那条仍生效，保留）。
    equivalent: true,
  },

  // ---------- isTrustedIp ----------
  {
    id: 'T16',
    desc: '**some 改成 every**（白名单必须全部条目都命中才算信任）',
    from: '  return list.some((entry) => entry === raw || entry === norm || matchesCidr(entry, norm));',
    to: '  return list.every((entry) => entry === raw || entry === norm || matchesCidr(entry, norm));',
  },
  {
    id: 'T17',
    desc: '**不做 CIDR 匹配**（只剩精确 IP 相等，CIDR 条目全部失效）',
    from: '  return list.some((entry) => entry === raw || entry === norm || matchesCidr(entry, norm));',
    to: '  return list.some((entry) => entry === raw || entry === norm);',
  },
  {
    id: 'T18',
    desc: '**不做 IPv4-mapped 归一**（::ffff:1.2.3.4 形式的来源漏判）',
    from: "  const norm = raw.toLowerCase().startsWith('::ffff:') ? raw.slice(7) : raw;",
    to: '  const norm = raw;',
        // **等价变异**：norm 只是一条快速路径 —— matchesCidr 内部对 IPv4-mapped 也做互通，
        // 所以去掉 norm 后结果不变（仅多一次解析）。
    equivalent: true,
  },
  {
    id: 'T19',
    desc: '空列表时返回 true（默认信任一切 —— 最危险的形态）',
    from: '  if (!list.length || !ip) return false;',
    to: '  if (!list.length || !ip) return true;',
  },
  {
    id: 'T20',
    desc: '来源 IP 不 trim（代理头带空格时漏判）',
    from: '  const raw = String(ip).trim();',
    to: '  const raw = String(ip);',
  },
  {
    id: 'T21',
    desc: 'mapped 归一后不回落到 matchesCidr（归一结果不参与 CIDR 判定）',
    from: '  return list.some((entry) => entry === raw || entry === norm || matchesCidr(entry, norm));',
    to: '  return list.some((entry) => entry === raw || matchesCidr(entry, raw));',
        // **等价变异**：把 raw 交给 matchesCidr 也能命中（它自己会处理映射形态），
        // 差别只在 norm 少做一次归一。
    equivalent: true,
  },

  // ---------- isValidIpOrCidr ----------
  {
    id: 'T22',
    desc: 'isValidIpOrCidr 恒返回 true（保存校验形同不存在）',
    from: '    return parseIpWithPrefix(token) !== null;',
    to: '    return true;   // 注入：不校验',
  },
];

const result = runMutations({
  title: 'securitySettings.js（CIDR / 信任 IP）',
  target: TARGET,
  test: TEST,
  mutations: MUTATIONS,
  root: ROOT,
});

if (result.baselineFailed) process.exit(1);
if (result.survived > 0 && process.argv.includes('--strict')) {
  console.log('\n--strict 模式：存活变异视为失败');
  process.exit(1);
}
