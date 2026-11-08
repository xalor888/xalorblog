/**
 * 网络地址的「内网可达性」判定（纯函数，无 DNS、无网络）。
 *
 * 只处理 **IP 字面量**：`https://192.168.1.10/v1` 这种。
 * 域名形式（`https://internal.corp.local`）**不解析**——那需要 DNS 查询，
 * 既会在热路径上加延迟，又会引入「DNS 临时故障要不要 fail-closed」的连锁问题。
 * 域名指向内网的风险靠网络层隔离（部署时源站只对公网开放出站白名单），不在应用层兜。
 *
 * 为什么需要它：AI base URL 来自后台设置表。允许它指向内网 IP，就等于
 * 「改一次设置 → 在服务器上开一条能打内网的请求通道」，而这条链路的响应
 * **会被写进文章预览**，攻击者能直接读到内网服务内容（典型 SSRF 到云元数据）。
 * 之前只校验了协议是 https —— 协议对不代表目标公网可达。
 *
 * 覆盖的段（含几条常被拿来绕过的）：
 *   IPv4  0/8、10/8、100.64/10（CGNAT）、127/8、169.254/16（链路本地/云元数据）、
 *         172.16/12、192.0.0/24、192.168/16、198.18/15（基准测试段）、
 *         以及 224/4 组播与 240/4 保留
 *   IPv6  ::、::1、fe80::/10（链路本地）、fc00::/7（唯一本地）、
 *         以及 ::ffff:a.b.c.d（IPv4 映射）—— 这条是经典绕过写法，必须解出内嵌的 IPv4 再判一次
 */

/** 把 `[::1]` 这类带方括号的 hostname 剥成裸地址 */
function stripBrackets(host) {
  const h = String(host || '').trim();
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1);
  return h;
}

/** 点分十进制 → 四个 0-255 的数；非法返回 null */
function parseIPv4(str) {
  const parts = String(str || '').split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/** IPv4 是否落在私有/保留段 */
function isPrivateIPv4(str) {
  const ip = parseIPv4(str);
  if (!ip) return false;
  const [a, b] = ip;
  if (a === 0) return true;                          // 0/8 「本网络」
  if (a === 10) return true;                         // 10/8 私有
  if (a === 127) return true;                        // 127/8 回环
  if (a === 169 && b === 254) return true;           // 169.254/16 链路本地（云元数据在这）
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 私有
  if (a === 192 && b === 168) return true;           // 192.168/16 私有
  if (a === 192 && b === 0) return true;             // 192.0.0/24 协议分配
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true;                         // 224/4 组播 + 240/4 保留
  return false;
}

/** IPv6 是否落在私有/保留段（含 IPv4 映射的递归判定） */
function isPrivateIPv6(str) {
  const h = stripBrackets(str).toLowerCase();
  if (!h.includes(':')) return false;
  if (h === '::' || h === '::1') return true;        // 未指定 / 回环

  // IPv4 映射：::ffff:192.168.1.1 或 ::ffff:c0a8:0101。
  // 这是最常见的绕过写法 —— 只看字面量里有没有「:」会漏掉。
  const mapped = h.match(/^(?:0*:)*:?ffff:([0-9a-f:.]+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (tail.includes('.')) return isPrivateIPv4(tail);
    // 纯十六进制形式：c0a8:0101 → 192.168.1.1
    //
    // ⚠ 不能简单 `tail.replace(/:/g, '')` 再要求 8 位 —— `new URL()` 会**省略前导零**：
    //   `new URL('https://[::ffff:192.168.1.1]/v1').hostname` → `[::ffff:c0a8:101]`
    //   （注意是 `101` 不是 `0101`，去掉冒号只有 7 位）
    // 之前就这么写，导致**线上路径（走 URL 解析）漏判**，而直接传字面量反而能判对 ——
    // 这种"测试用字面量、线上走解析"的差异最容易漏。
    // 正确做法是按组补齐到 4 位再拼。
    const groups = tail.split(':');
    const hex = groups.map((g) => g.padStart(4, '0')).join('');
    if (hex.length === 8) {
      const octets = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)]
        .map((x) => parseInt(x, 16));
      return isPrivateIPv4(octets.join('.'));
    }
    return false;
  }

  const firstGroup = h.split(':')[0];
  const head = parseInt(firstGroup || '0', 16);
  if (!Number.isFinite(head)) return false;
  if ((head & 0xffc0) === 0xfe80) return true;       // fe80::/10 链路本地
  if ((head & 0xfe00) === 0xfc00) return true;       // fc00::/7 唯一本地
  if ((head & 0xff00) === 0xff00) return true;       // ff00::/8 组播
  return false;
}

/**
 * hostname 是否指向内网/保留地址。
 * @param {string} host 已去掉端口的 hostname（可带 IPv6 方括号）
 * @returns {boolean}
 */
/**
 * 把主机名先过一遍 WHATWG URL 规范化，再判私网。
 *
 * 为什么必须这一步：URL 解析器会把「数值型 IPv4」各种写法**归一化成点分十进制** ——
 *   `2130706433` → `127.0.0.1`（十进制整数）
 *   `127.1`      → `127.0.0.1`（缺段补零）
 *   `0x7f.0.0.1` → `127.0.0.1`（十六进制段）
 *   `0177.0.0.1` → `127.0.0.1`（八进制段）
 * 而 isPrivateIPv4 只认四段十进制字面量，于是这些写法**全部被判成公网**
 * —— 一个 SSRF 闸门就此被绕过（实测：isPrivateHost('2130706433') === false）。
 * 规范化之后再判，四种写法都落回 127.0.0.1。
 *
 * 解析失败（如未加方括号的裸 IPv6）时退回原串，交给后面的 IPv6 分支处理。
 */
function canonicalHost(host) {
  const raw = stripBrackets(host);
  if (!raw) return '';
  try {
    return stripBrackets(new URL('http://' + raw).hostname);
  } catch (e) {
    return raw;
  }
}

function isPrivateHost(host) {
  const h = canonicalHost(host);
  if (!h) return false;
  if (h.includes(':')) return isPrivateIPv6(h);
  return isPrivateIPv4(h);
}

/**
 * 从 URL 里提取 hostname 并判定。URL 非法时返回 false（交给调用方的协议校验处理）。
 * @param {string} url
 * @returns {boolean}
 */
function isPrivateUrl(url) {
  try {
    return isPrivateHost(new URL(String(url || '')).hostname);
  } catch (e) {
    return false;
  }
}

module.exports = { isPrivateHost, isPrivateUrl, isPrivateIPv4, isPrivateIPv6, stripBrackets };
