#!/usr/bin/env node
/**
 * netGuard.js 的变异测试 —— SSRF 防线的有效性验证。
 *
 * 为什么这个模块最该做变异测试：它是**唯一**拦住「AI base URL 指向内网」的代码。
 * 少判一段，就等于给服务器开了一条能打内网的请求通道（SSRF），
 * 而这条通道的响应会被写进文章预览 —— 攻击者直接读到云元数据。
 *
 * 每条变异都是「删掉一个段」或「把边界改错」，对应一个真实的绕过手法。
 *
 * 判据来源：`netGuard.js` 的注释里记录了一次**真实线上漏判**（M17）——
 * `tail.replace(/:/g,'')` 要求 8 位，但 `new URL()` 会省略前导零
 * （`::ffff:192.168.1.1` → `::ffff:c0a8:101`，7 位）。于是「测试用字面量能判对、
 * 线上走 URL 解析漏判」。这条必须能被测试抓到，否则同样的坑会再踩一次。
 *
 * 用法：
 *   node scripts/mutation-netguard.js
 *   node scripts/mutation-netguard.js --strict   # 有存活变异时 exit 1
 */

'use strict';

const { join } = require('path');
const { runMutations } = require('./lib/mutation-runner');

const ROOT = join(__dirname, '..');
const TARGET = join(ROOT, 'src', 'utils', 'netGuard.js');
const TEST = join(ROOT, 'test', 'netGuard.test.js');

const MUTATIONS = [
  // ---------- IPv4 段判定：逐段删除 ----------
  {
    id: 'N01',
    desc: '不拦 127/8 回环（→ 可访问本机服务）',
    from: '  if (a === 127) return true;                        // 127/8 回环',
    to: '  // 注入：不拦回环',
  },
  {
    id: 'N02',
    desc: '不拦 169.254/16（→ **云元数据 169.254.169.254 可读**）',
    from: '  if (a === 169 && b === 254) return true;           // 169.254/16 链路本地（云元数据在这）',
    to: '  // 注入：不拦链路本地',
  },
  {
    id: 'N03',
    desc: '不拦 10/8 私有段',
    from: '  if (a === 10) return true;                         // 10/8 私有',
    to: '  // 注入：不拦 10/8',
  },
  {
    id: 'N04',
    desc: '不拦 192.168/16 私有段',
    from: '  if (a === 192 && b === 168) return true;           // 192.168/16 私有',
    to: '  // 注入：不拦 192.168/16',
  },
  {
    id: 'N05',
    desc: '不拦 172.16/12 私有段',
    from: '  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 私有',
    to: '  // 注入：不拦 172.16/12',
  },
  {
    id: 'N06',
    desc: '172.16/12 上界放宽到 /8（→ 172.32+ 被误判为内网，过度拦截）',
    from: '  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 私有',
    to: '  if (a === 172 && b >= 16) return true;              // 注入：丢掉上界',
  },
  {
    id: 'N07',
    desc: '不拦 100.64/10 CGNAT',
    from: '  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT',
    to: '  // 注入：不拦 CGNAT',
  },
  {
    id: 'N08',
    desc: '不拦 224/4 组播与 240/4 保留',
    from: '  if (a >= 224) return true;                         // 224/4 组播 + 240/4 保留',
    to: '  // 注入：不拦组播/保留',
  },
  {
    id: 'N09',
    desc: '不拦 0/8「本网络」',
    from: '  if (a === 0) return true;                          // 0/8 「本网络」',
    to: '  // 注入：不拦 0/8',
  },
  {
    id: 'N10',
    desc: '不拦 192.0.0/24 协议分配段',
    from: '  if (a === 192 && b === 0) return true;             // 192.0.0/24 协议分配',
    to: '  // 注入：不拦 192.0.0/24',
  },
  {
    id: 'N11',
    desc: '不拦 198.18/15 基准测试段',
    from: '  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试',
    to: '  // 注入：不拦基准测试段',
  },

  // ---------- 解析健壮性 ----------
  {
    id: 'N12',
    desc: 'parseIPv4 接受段数不足（→ "127.1" 之类的简写可能漏判）',
    from: '  if (parts.length !== 4) return null;',
    to: '  if (parts.length > 4) return null;',
  },
  {
    id: 'N13',
    desc: 'parseIPv4 上界放宽到 256（→ 非法值被当成合法地址）',
    from: '    if (n > 255) return null;',
    to: '    if (n > 256) return null;',
  },
  {
    id: 'N14',
    desc: 'parseIPv4 允许非数字段（→ "1.2.3.x" 被解析）',
    from: '    if (!/^\\d{1,3}$/.test(p)) return null;',
    to: '    if (!/^\\d*$/.test(p)) return null;',
  },

  // ---------- IPv6 ----------
  {
    id: 'N15',
    desc: '不拦 IPv6 回环 ::1 与未指定 ::',
    from: "  if (h === '::' || h === '::1') return true;        // 未指定 / 回环",
    to: '  // 注入：不拦 IPv6 回环',
  },
  {
    id: 'N16',
    desc: '不拦 fe80::/10 链路本地',
    from: '  if ((head & 0xffc0) === 0xfe80) return true;       // fe80::/10 链路本地',
    to: '  // 注入：不拦 fe80::/10',
  },
  {
    id: 'N17',
    desc: '不拦 fc00::/7 唯一本地',
    from: '  if ((head & 0xfe00) === 0xfc00) return true;       // fc00::/7 唯一本地',
    to: '  // 注入：不拦 fc00::/7',
  },
  {
    id: 'N18',
    desc: '不拦 ff00::/8 组播',
    from: '  if ((head & 0xff00) === 0xff00) return true;       // ff00::/8 组播',
    to: '  // 注入：不拦 ff00::/8',
  },

  // ---------- IPv4 映射（真实线上事故的回归点） ----------
  {
    id: 'N19',
    desc: '**IPv4 映射按尾段直接判，不再补齐到 4 位**（→ 重现「测试对、线上漏」的老 bug）',
    from: "    const hex = groups.map((g) => g.padStart(4, '0')).join('');",
    to: "    const hex = groups.map((g) => g.padStart(2, '0')).join('');",
  },
  {
    id: 'N20',
    desc: 'IPv4 映射的长度检查放宽（8 → >=8，→ 畸形输入被当合法）',
    from: '    if (hex.length === 8) {',
    to: '    if (hex.length >= 8) {',
  },
  {
    id: 'N21',
    desc: 'IPv4 映射的十进制尾巴不再递归判定（→ ::ffff:192.168.1.1 漏判）',
    from: "    if (tail.includes('.')) return isPrivateIPv4(tail);",
    to: '    if (tail.includes(\'.\')) return false;',
  },

  // ---------- 外层入口 ----------
  {
    id: 'N22',
    desc: 'stripBrackets 不剥方括号（→ 带 [ ] 的 IPv6 判不出来）',
    from: "  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1);",
    to: '  // 注入：不剥方括号',
  },
  {
    id: 'N23',
    desc: 'isPrivateHost 对含冒号的主机名走 IPv4 分支（→ IPv6 全部漏判）',
    from: "  if (h.includes(':')) return isPrivateIPv6(h);",
    to: '  // 注入：不区分 IPv6',
  },
  {
    id: 'N24',
    desc: 'isPrivateUrl 解析失败时返回 true（→ 过度拦截，非法 URL 全挡）',
    from: '  } catch (e) {\n    return false;\n  }',
    to: '  } catch (e) {\n    return true;\n  }',
  },
  {
    id: 'N25',
    // 等价变异：空 hostname 在 isPrivateUrl 的调用路径上不会出现（URL 解析保证非空），
    // 而直接调用 isPrivateHost('') 的语义就是「不是内网」，改成 true 会过度拦截 ——
    // 但**没有测试直接调 isPrivateHost('')**，所以行为变化不会被观察到。
    // 这条其实是真盲区（空串语义未测），但影响极小：调用方都先过了 URL 解析。
    desc: 'isPrivateHost 空串返回 true（→ 空 hostname 被当成内网）',
    from: '  if (!h) return false;',
    to: '  if (!h) return true;',
  },
];

const result = runMutations({
  title: 'netGuard.js（SSRF 防线）',
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
