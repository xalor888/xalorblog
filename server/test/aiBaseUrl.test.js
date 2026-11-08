const { stripCommentLines } = require('./helpers/sourceText');
/**
 * AI base URL 的可用性判定（零网络、零 DB）。
 *
 * `isUsableBase` 是 AI 链路上唯一的地址闸门，它挡的是 **SSRF**：
 * base URL 来自后台设置表，如果允许指向内网，那么「改一次设置」就等于在服务器上
 * 开了一条能打内网的请求通道 —— 而这条链路的响应会被写进文章预览，攻击者能直接读到内容。
 *
 * 所以断言的**重点不在于放行了什么，而在于拒绝了什么**：
 *   - 生产：只允许 https（密钥与正文不走明文）
 *   - 开发：额外允许**本机** http，但 192.168/10./172.16-31/169.254 一律拒绝
 *
 * 顺带钉住一个曾经漏掉的形态：`[::1]`（IPv6 回环的 URL 写法）。
 * 本地网关监听在 `::1` 时连不上，错误信息只会是「AI 不可用」，排查方向完全不指向这里。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { isUsableBase } = require('../src/utils/aiClient');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const origEnv = process.env.NODE_ENV;
const asDev = (fn) => { process.env.NODE_ENV = 'development'; try { return fn(); } finally { process.env.NODE_ENV = origEnv; } };
const asProd = (fn) => { process.env.NODE_ENV = 'production'; try { return fn(); } finally { process.env.NODE_ENV = origEnv; } };

console.log('=== A. 生产：只允许 https ===');
{
  asProd(() => {
    check('https 放行', isUsableBase('https://api.openai.com/v1') === true);
    check('大写 HTTPS 放行', isUsableBase('HTTPS://API.OPENAI.COM/v1') === true);
    check('http 一律拒绝（密钥不能走明文）', isUsableBase('http://api.openai.com/v1') === false);
    check('本机 http 也拒绝（生产不该连本机网关）',
      isUsableBase('http://127.0.0.1:8080') === false);
    check('内网 http 拒绝', isUsableBase('http://192.168.1.10') === false);
    // 本轮把这条补上了：只校验「必须是 https」不够，`https://192.168.1.10/v1`
    // 协议完全合法但它指向内网 —— 这是 SSRF 的正面入口。
    check('https 指向内网必须拒绝（协议合法 ≠ 目标公网可达）',
      isUsableBase('https://192.168.1.10') === false, '放行即是 SSRF 通道');
    check('云元数据地址必须拒绝（SSRF 的经典目标）',
      isUsableBase('https://169.254.169.254/latest/meta-data/') === false);
  });
}

console.log('\n=== B. 开发：本机回环三种写法都认 ===');
{
  asDev(() => {
    check('127.0.0.1 放行', isUsableBase('http://127.0.0.1:8080/v1') === true);
    check('localhost 放行', isUsableBase('http://localhost:11434/v1') === true);
    check('[::1] 放行（IPv6 回环的 URL 写法 —— 曾经漏掉）',
      isUsableBase('http://[::1]:8080/v1') === true, '漏掉时错误只显示"AI 不可用"');
    check('不带端口放行', isUsableBase('http://127.0.0.1') === true);
    check('带路径放行', isUsableBase('http://localhost/v1/chat') === true);
    check('大小写不敏感', isUsableBase('HTTP://LOCALHOST:8080') === true);
  });
}

console.log('\n=== B2. 生产环境下本机回环也拒绝（新行为） ===');
{
  asProd(() => {
    check('生产 http://127.0.0.1 拒绝', isUsableBase('http://127.0.0.1:8080') === false);
    // 生产连本机网关不是正常场景；真需要就用主机名（ai-gw.local → 127.0.0.1），
    // 而不是 IP 字面量。这条断言的目的是让"放宽"成为一个显式决定。
    check('生产 https://127.0.0.1 也拒绝（避免 https 成为绕过私有 IP 判定的缺口）',
      isUsableBase('https://127.0.0.1:8080') === false);
    check('生产 https://[::1] 同样拒绝', isUsableBase('https://[::1]:8080') === false);
  });
}

console.log('\n=== C. 开发：内网地址必须拒绝（这是 SSRF 的正面防线） ===');
{
  asDev(() => {
    const mustReject = [
      'http://192.168.1.10:8080',      // 家用/办公网段
      'http://10.0.0.5',               // 私有 A 类
      'http://172.16.0.1',             // 私有 B 类
      'http://172.31.255.255',
      'http://169.254.169.254/latest', // 云厂商元数据服务（SSRF 的经典目标）
      'http://127.1.1.1',              // 不是 127.0.0.1 精确匹配
      'http://0.0.0.0',
      'http://[::]:8080',              // 未指定地址
      'http://localhost.evil.com',     // 前缀伪装
      'http://127.0.0.1.evil.com',     // 前缀伪装
      'http://example.com',            // 公网 http 也不放行
    ];
    for (const u of mustReject) {
      check(`拒绝 ${u}`, isUsableBase(u) === false, '放行即是 SSRF 通道');
    }
  });
}

console.log('\n=== D. 脏输入 ===');
{
  const junk = ['', null, undefined, '   ', 'ftp://a.com', '//a.com', 'a.com', 'javascript:alert(1)', 'file:///etc/passwd'];
  for (const u of junk) {
    check(`拒绝 ${JSON.stringify(u)}`, isUsableBase(u) === false);
  }
  check('前后空白被 trim（" https://a.com " 放行）',
    isUsableBase('  https://a.com  ') === true);
}

console.log('\n=== E. 源码契约：getAiConfig 会用到它 ===');
{
  const fs = require('fs');
  const path = require('path');
  const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'aiClient.js'), 'utf8'));
  check('getAiConfig 里对 baseUrl 做了 isUsableBase 校验', /isUsableBase\(/.test(src));
  check('存在 base URL 不可用时的降级/拒绝路径',
    /isUsableBase\([^)]*\)[\s\S]{0,400}(FALLBACK_BASE|ready\s*=\s*false|return)/.test(src));
  check('isUsableBase 已导出（可被测试驱动）', /isUsableBase\s*\}/.test(src));
}

console.log(`\naiBaseUrl 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
