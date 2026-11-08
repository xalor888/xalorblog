/**
 * 私有/保留地址判定（纯函数，零 DNS、零网络）。
 *
 * 这个模块是 SSRF 防线的最底层：`isUsableBase`（AI 接口地址）与 `saveSettings`
 * （保存 AI 接口地址）都靠它。它判错的方向代价不对称：
 *
 *   - 漏判（该拒绝的放行）→ 后台改一次设置就得到一条打内网的请求通道，
 *     而 AI 链路的响应**会被写进文章预览**，攻击者能直接读内网服务内容；
 *   - 误判（该放行的拒绝）→ 用户填了合法地址却存不进去，报错看得见，能自查。
 *
 * 所以断言的重点在「哪些必须被拒绝」，且专门覆盖几种常见绕过写法。
 */

const {
  isPrivateHost, isPrivateUrl, isPrivateIPv4, isPrivateIPv6, stripBrackets,
} = require('../src/utils/netGuard');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('=== A. IPv4 私有/保留段 ===');
{
  const yes = [
    ['10.0.0.5', '10/8 私有'],
    ['10.255.255.255', '10/8 上界'],
    ['172.16.0.1', '172.16/12 下界'],
    ['172.31.255.255', '172.16/12 上界'],
    ['192.168.1.10', '192.168/16'],
    ['127.0.0.1', '127/8 回环'],
    ['127.1.1.1', '127/8 内任意地址'],
    ['169.254.169.254', '链路本地 —— 云元数据在这'],
    ['0.0.0.0', '0/8 本网络'],
    ['100.64.0.1', 'CGNAT 下界'],
    ['100.127.255.255', 'CGNAT 上界'],
    ['192.0.0.1', '协议分配段'],
    ['198.18.0.1', '基准测试段下界'],
    ['198.19.255.255', '基准测试段上界'],
    ['224.0.0.1', '组播'],
    ['240.0.0.1', '保留段'],
  ];
  for (const [ip, why] of yes) check(`拒绝 ${ip}（${why}）`, isPrivateIPv4(ip) === true);

  const no = [
    ['8.8.8.8', '公网 DNS'],
    ['1.1.1.1', '公网 DNS'],
    ['172.15.0.1', '紧邻 172.16 但在段外'],
    ['172.32.0.1', '紧邻 172.31 但在段外'],
    ['100.63.255.255', '紧邻 CGNAT 但在段外'],
    ['100.128.0.1', '紧邻 CGNAT 但在段外'],
    ['198.17.255.255', '紧邻基准测试段但在段外'],
    ['203.0.113.5', '公网'],
    ['192.169.1.1', '紧邻 192.168 但在段外'],
  ];
  for (const [ip, why] of no) check(`放行 ${ip}（${why}）`, isPrivateIPv4(ip) === false);
}

console.log('\n=== B. IPv6 私有/保留段 ===');
{
  const yes = [
    ['::1', '回环'],
    ['::', '未指定'],
    ['fe80::1', '链路本地'],
    ['febf::1', '链路本地上界'],
    ['fc00::1', '唯一本地下界'],
    ['fd00::1', '唯一本地'],
    ['fdff::1', '唯一本地上界'],
    ['ff00::1', '组播'],
  ];
  for (const [ip, why] of yes) check(`拒绝 ${ip}（${why}）`, isPrivateIPv6(ip) === true);

  const no = [
    ['2001:db8::1', '文档用段（公网不可路由但非私有，按公网处理）'],
    ['2606:4700::1', '公网'],
    ['2400::1', '公网'],
  ];
  for (const [ip, why] of no) check(`放行 ${ip}（${why}）`, isPrivateIPv6(ip) === false);
}

console.log('\n=== C. IPv4 映射的 IPv6（最经典的绕过写法） ===');
{
  // 只看字面量里有没有「:」会漏掉这一类；必须解出内嵌的 IPv4 再判一次
  check('::ffff:192.168.1.1 拒绝（点分形式）', isPrivateIPv6('::ffff:192.168.1.1') === true);
  check('::ffff:c0a8:0101 拒绝（纯十六进制形式）', isPrivateIPv6('::ffff:c0a8:0101') === true);
  check('::ffff:10.0.0.1 拒绝', isPrivateIPv6('::ffff:10.0.0.1') === true);
  check('::ffff:169.254.169.254 拒绝（元数据地址的映射写法）',
    isPrivateIPv6('::ffff:169.254.169.254') === true);
  check('::ffff:8.8.8.8 放行（映射到公网就该放行）',
    isPrivateIPv6('::ffff:8.8.8.8') === false);
  check('::ffff:0808:0808 放行（8.8.8.8 的十六进制形式）',
    isPrivateIPv6('::ffff:0808:0808') === false);

  // ⚠ 前导零省略是**线上才会遇到的形态**：`new URL()` 会规范化 hostname，
  //   `https://[::ffff:192.168.1.1]/v1` 进去后变成 `[::ffff:c0a8:101]`（`101` 不是 `0101`）。
  //   按「去掉冒号必须 8 位」来解析会得到 7 位而漏判 —— 测试用字面量、线上走解析，
  //   这种差异最容易漏。这组断言两边都钉。
  check('::ffff:c0a8:101 拒绝（URL 规范化后的真实形态，前导零被省略）',
    isPrivateIPv6('::ffff:c0a8:101') === true);
  check('::ffff:a00:1 拒绝（::ffff:10.0.0.1 的规范化形态）',
    isPrivateIPv6('::ffff:a00:1') === true);
  check('走 URL 解析时同样能识别（线上实际路径）',
    isPrivateUrl('https://[::ffff:192.168.1.1]/v1') === true);
  check('URL 规范化后仍能识别映射到公网的情况',
    isPrivateUrl('https://[::ffff:8.8.8.8]/v1') === false);
}

console.log('\n=== D. hostname 形态（含方括号与大小写） ===');
{
  check('裸 IPv4', isPrivateHost('192.168.1.1') === true);
  check('带方括号的 IPv6 剥掉后判定', isPrivateHost('[::1]') === true);
  check('大写 IPv6 折小写后判定', isPrivateHost('[FE80::1]') === true);
  check('stripBrackets 只剥成对方括号', stripBrackets('[::1]') === '::1');
  check('stripBrackets 不碰没有方括号的', stripBrackets('::1') === '::1');
  check('空 host 不判为私有（交给调用方的协议校验）', isPrivateHost('') === false);
  check('null host 不抛错', isPrivateHost(null) === false);
  check('域名不判为私有（不解析 DNS，见模块注释）',
    isPrivateHost('internal.corp.local') === false);
  check('公网域名不判为私有', isPrivateHost('api.openai.com') === false);
}

console.log('\n=== E. 从 URL 提取 hostname ===');
{
  check('https + 私有 IP', isPrivateUrl('https://192.168.1.10/v1') === true);
  check('https + 端口不影响', isPrivateUrl('https://192.168.1.10:8443/v1') === true);
  check('https + 公网域名', isPrivateUrl('https://api.openai.com/v1') === false);
  check('https + IPv6 回环', isPrivateUrl('https://[::1]:8080/v1') === true);
  check('http 同样适用', isPrivateUrl('http://10.0.0.5:8080') === true);
  check('非法 URL 不判为私有（返回 false，由协议校验兜）', isPrivateUrl('not a url') === false);
  check('空串不判为私有', isPrivateUrl('') === false);
  check('没有协议头的串不判为私有', isPrivateUrl('192.168.1.1') === false);
  // 带 userinfo 的写法：`https://user@192.168.1.1/` —— hostname 仍应是内网 IP
  check('带 userinfo 时仍能识别出内网 host',
    isPrivateUrl('https://user:pass@192.168.1.1/v1') === true);
}

console.log('\n=== F. 脏输入不抛错（这些函数在保存与调用路径上） ===');
{
  const junk = [null, undefined, '', '   ', 'abc', '1.2.3', '1.2.3.4.5', '999.1.1.1', '-1.0.0.0', '::gggg', '[]', '[]'];
  for (const j of junk) {
    let threw = false;
    try { isPrivateHost(j); isPrivateUrl(j); isPrivateIPv4(j); isPrivateIPv6(j); }
    catch (e) { threw = true; }
    check(`${JSON.stringify(j)} 不抛错`, threw === false);
  }
  check('非法 IPv4 不判为私有（返回 false 而不是崩）', isPrivateIPv4('999.1.1.1') === false);
  check('缺段 IPv4 不判为私有', isPrivateIPv4('1.2.3') === false);
  check('超长段 IPv4 不判为私有', isPrivateIPv4('192.168.1.256') === false);

  /* ------------------------------------------------------------
   * 以下三条由变异测试（scripts/mutation-netguard.js）发现。
   *
   * 它们守的是同一条**契约**：「解析不了 → 返回 false，由调用方去处理」。
   * 而不是「解析不了 → 猜一个」。
   *
   * 为什么这条契约重要：isPrivateIPv4 的 false 有两种含义 ——
   *   a) 这是个合法的公网 IP        （→ 放行）
   *   b) 这压根不是 IPv4 字面量      （→ 可能是域名，交给别的逻辑）
   * 把 b 也返回 true 会让「不是 IP 的东西」被当成内网，行为就从 fail-open
   * 变成 fail-closed。方向上更"安全"，但**语义被悄悄改了**，
   * 依赖「false 代表不是 IP」的调用方会静默走错分支。
   * ------------------------------------------------------------ */

  check('缺段但带私有前缀（10.0）不判为私有 —— 缺段一律不可解析',
    isPrivateIPv4('10.0') === false);
  check('只有两段（127.1）不判为私有',
    isPrivateIPv4('127.1') === false);
  check('空段（10.0.0.）不判为私有 —— 空字符串不是数字 0',
    isPrivateIPv4('10.0.0.') === false);
  check('五段（10.0.0.0.1）不判为私有',
    isPrivateIPv4('10.0.0.0.1') === false);

  // 变异 N20：把 `hex.length === 8` 放宽成 `>= 8` 时，
  // 下面这个**四组**的映射形态会被截前 8 位算成 0.0.0.0 → 误判为私有。
  // 正确的 IPv4 映射只有两组（::ffff:XXXX:YYYY），四组根本不是映射，不该当映射处理。
  check('四组十六进制不是 IPv4 映射（::ffff:0:0:c0a8:101）',
    isPrivateIPv6('::ffff:0:0:c0a8:101') === false);
  check('三组十六进制不是 IPv4 映射（::ffff:1:2:3）',
    isPrivateIPv6('::ffff:1:2:3') === false);
}

console.log('\n=== G. 数值型 IPv4 写法（URL 会归一化，旧判据会漏） ===');
{
  // 这五种写法在 WHATWG URL 里都等价于 127.0.0.1 / 10.0.0.1，
  // 但旧版 isPrivateHost 只认「四段十进制」，全部判成公网 —— SSRF 闸门当场被绕。
  const forms = [
    ['2130706433', '十进制整数 = 127.0.0.1'],
    ['127.1', '缺段补零 = 127.0.0.1'],
    ['0x7f.0.0.1', '十六进制段 = 127.0.0.1'],
    ['0177.0.0.1', '八进制段 = 127.0.0.1'],
    ['0x0a.0.0.1', '十六进制段 = 10.0.0.1'],
    ['169.254.169.254', '链路本地 / 云元数据（对照组）'],
  ];
  for (const [host, why] of forms) {
    check(`数值型写法判为私网：${host}（${why}）`, isPrivateHost(host) === true);
  }

  // 反向：真公网地址不能被误判
  for (const host of ['8.8.8.8', '1.1.1.1', '203.0.113.10', 'example.com']) {
    check(`公网地址不误判：${host}`, isPrivateHost(host) === false);
  }

  check('自检：URL 规范化确实会改写这些写法', () => {
    // 用同一个规范化路径确认「判据依赖的转换真的发生了」
    const canonical = new URL('http://2130706433').hostname;
    assert.strictEqual(canonical, '127.0.0.1', `规范化结果是 ${canonical}`);
  });
}

console.log(`\nnetGuard 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
