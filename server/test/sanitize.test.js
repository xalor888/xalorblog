const {
  safeUrl, safeCover, safeEmail, cleanText, cleanLine,
  escapeLike, safeUploadRel,
} = require('../src/utils/sanitize');

// 计数器与 assert 必须先于任何断言调用就位：否则 passed/failed 处于 TDZ，
// 首个 assert 就会抛 ReferenceError，整个套件（以及 npm test 链）直接崩掉
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

assert('safeEmail 允许普通邮箱', safeEmail('user@example.com') === 'user@example.com');
assert('safeEmail 允许带点或减号', safeEmail('first.last-tag@sub.example.co.uk') === 'first.last-tag@sub.example.co.uk');
assert('safeEmail 拒绝换行注入', safeEmail('user@example.com\r\nBcc: evil@example.com') === '');
assert('safeEmail 拒绝空字符串', safeEmail('') === '');
assert('safeEmail 拒绝非字符串', safeEmail(null) === '');

const allowed = [
  'https://example.com/path',
  'http://example.com',
  'https://example.com.',
];

const denied = [
  'http://localhost',
  'http://localhost.',
  'http://localhost..',
  'http://foo.localhost',
  'http://foo.localdomain',
  'http://foo.internal',
  'http://foo.lan',
  'http://foo.home',
  'http://127.0.0.1',
  'http://10.0.0.1',
  'http://192.168.1.1',
  'http://172.16.0.1',
  'http://169.254.1.1',
  'http://2130706433',
  'http://0x7f000001',
  'http://0177.0.0.1',
  'http://127.1',
  'http://user:pass@example.com',
  'javascript:alert(1)',
  'data:text/html,hello',
  'http://localtest.me',
  'http://x.lvh.me',
  'http://127.0.0.1.nip.io',
];

for (const u of allowed) assert(`allow ${u}`, !!safeUrl(u));
for (const u of denied) assert(`deny ${u}`, !safeUrl(u));

// IP 字面量一律拒绝（策略锁死）：任何 IPv4/IPv6 字面量都返回 ''，
// 不区分公网/内网 —— 段级放行既漏得掉新保留段，又会给 SSRF/追踪留入口。
// 注意 http://8.8.8.8/x 是**公网**地址，也必须为 ''：这是有意的取舍。
for (const u of [
  'http://1.2.3.4/',
  'http://10.0.0.1/',
  'http://8.8.8.8/x',
  'http://0x7f000001/',
  'http://2130706433/',
  'http://[::1]/',
  'http://localhost/',
  'http://foo.lvh.me/',
]) {
  assert(`deny IP/localhost 字面量 ${u}`, safeUrl(u) === '');
}
// ⚠ 变异测试（scripts/mutation-sanitize.js）发现：上面的 denied 列表**漏了 `.local`**。
// M07 把 privateSuffixes 里的 '.local' 删掉后，整套测试仍然全绿 ——
// 说明 mDNS 本地域名这条防线从来没被验证过。
assert('safeUrl 拒绝 .local（mDNS 本地域名）', safeUrl('http://foo.local') === '');
assert('safeUrl 拒绝 .local 带端口', safeUrl('http://printer.local:631/') === '');
assert('safeUrl 保留带查询串的 https 链接', safeUrl('https://example.com/a?b=1') === 'https://example.com/a?b=1');
assert('safeUrl 保留 IDN 域名原值', safeUrl('https://例子.中国/') === 'https://例子.中国/');

assert('cover 允许默认 logo', safeCover('/logo.png') === '/logo.png');
assert('cover 允许上传文件名', safeCover('/uploads/123-abcdef.png') === '/uploads/123-abcdef.png');
assert('cover 拒绝任意站内路径', safeCover('/etc/passwd') === '');
assert('cover 拒绝路径穿越', safeCover('/uploads/../logo.png') === '');
assert('cover 拒绝属性注入', safeCover('/logo.png" onerror="alert(1)') === '');
assert('cover 允许 https 外链', !!safeCover('https://example.com/a.png'));
assert('cover 拒绝 javascript', safeCover('javascript:alert(1)') === '');

/* ============================================================
   cleanText / cleanLine —— 变异测试发现这两者**从未被测试**。
   M01 把 `allowedTags: []` 改成 `false`（允许所有 HTML 标签 = 存储型 XSS），
   M04 删掉换行折叠，整套测试都还是绿的。补上。
   ============================================================ */
assert('cleanText 剥离 script 标签', cleanText('<script>alert(1)</script>hi') === 'hi');
assert('cleanText 剥离 img onerror', cleanText('<img src=x onerror=alert(1)>text') === 'text');
assert('cleanText 剥离 div 标签只留文本', cleanText('<div>内容</div>') === '内容');
assert('cleanText 保留纯文本', cleanText('正常内容 abc') === '正常内容 abc');
assert('cleanText 非字符串返回空串', cleanText(null) === '' && cleanText(42) === '');
assert('cleanText 按 maxLen 截断',
  cleanText('x'.repeat(50), 10) === 'x'.repeat(10));

assert('cleanLine 把换行折成空格', cleanLine('a\nb') === 'a b');
assert('cleanLine 折多行', cleanLine('a\r\nb\rc') === 'a b c');
assert('cleanLine 也剥标签', cleanLine('<b>x</b>') === 'x');

/* ============================================================
   sliceSafe 的代理对处理 —— M02/M03 都是存活变异。
   孤立代理会在入库时被换成 U+FFFD 且永远无法还原，
   属于「JSON 能序列化、Node 能持有、但字符已经坏了」的静默损坏。
   ============================================================ */
{
  const emoji = '😀';            // D83D DE00，两个码元
  const cut = cleanText(emoji.repeat(3), 3);   // 3 个码元 = 1 个 emoji + 半个
  assert('cleanText 不在代理对中间截断（不留孤立高位代理）',
    !/[\uD800-\uDBFF]$/.test(cut));
  assert('cleanText 截断后仍是有效字符',
    Buffer.from(cut, 'utf8').toString('utf8') === cut);
  // 边界：正好卡在 maxLen 上不该被多截
  assert('cleanText 恰好等于 maxLen 时不截断',
    cleanText('abcd', 4) === 'abcd');
  assert('cleanText 超出 1 个码元时截断',
    cleanText('abcde', 4) === 'abcd');
}

/* ============================================================
   escapeLike —— M10 存活：不转义反斜杠会导致 LIKE 转义序列被构造。
   搜索框输入 `\%` 时，若反斜杠本身不被转义，就变成「转义后的 %」= 字面 %
   而非通配符，语义反转。
   ============================================================ */
assert('escapeLike 转义百分号', escapeLike('a%b') === 'a\\%b');
assert('escapeLike 转义下划线', escapeLike('a_b') === 'a\\_b');
assert('escapeLike 转义反斜杠本身', escapeLike('a\\b') === 'a\\\\b');
assert('escapeLike 三者的组合',
  escapeLike('50%_off\\') === '50\\%\\_off\\\\');
assert('escapeLike 普通文本不变', escapeLike('normal') === 'normal');

/* ============================================================
   safeUploadRel —— M11/M12 存活（M12 其实被正则兜住了，见下）。
   M11 允许三层目录时测试没红，说明没有多段的用例。
   ============================================================ */
assert('safeUploadRel 允许单段', safeUploadRel('a.png') === 'a.png');
assert('safeUploadRel 允许两段（AI 转存图）', safeUploadRel('ai/x.png') === 'ai/x.png');
assert('safeUploadRel **拒绝三段**', safeUploadRel('a/b/c.png') === '');
assert('safeUploadRel 拒绝 ..（路径穿越）', safeUploadRel('..') === '');
assert('safeUploadRel 拒绝 a/../b', safeUploadRel('a/../b') === '');
assert('safeUploadRel 拒绝 .', safeUploadRel('.') === '');
assert('safeUploadRel 剥前导斜杠', safeUploadRel('/a.png') === 'a.png');
assert('safeUploadRel 拒绝空串', safeUploadRel('') === '');
assert('safeUploadRel 拒绝非字符串', safeUploadRel(null) === '');
// 注意：M12（删掉显式 `seg === '..'` 检查）存活是**可接受的** ——
// 段正则 `^[A-Za-z0-9_-]...` 的首字符类不含 `.`，`..` 本来就过不去。
// 显式检查是冗余的第二道防线，删掉它不改变行为。变异测试把它记为「存活」
// 是对的（行为确实没变），但这不等于有测试盲区 —— 这条要在报告里说清楚。

const { cleanMarkdown } = require('../src/utils/sanitize');
assert('cleanMarkdown 保留 Markdown 代码块', cleanMarkdown('```js\nconst x = 1;\n```').includes('const x = 1;'));
assert('cleanMarkdown 保留基础 HTML 如 <div>', cleanMarkdown('<div>test</div>').includes('<div>test</div>'));
assert('cleanMarkdown 剔除 script 标签', !cleanMarkdown('<script>alert(1)</script>').includes('script'));
assert('cleanMarkdown 剔除 iframe 标签', !cleanMarkdown('<iframe src="evil.com"></iframe>').includes('iframe'));

const { isTrustedIp, getConfig } = require('../src/utils/securitySettings');
assert('isTrustedIp 运行正常', typeof isTrustedIp('127.0.0.1') === 'boolean');
assert('getConfig 包含封禁与安全规则', getConfig().banScore > 0);

const { safeSubject, sanitizeForSmtp } = require('../src/utils/notifyMail');
assert('safeSubject 剥除换行', !safeSubject('hello\r\nworld').includes('\r'));
assert('sanitizeForSmtp 剥除换行注入', !sanitizeForSmtp('line1\r\nline2').includes('\r'));

const { localModeration } = require('../src/utils/aiModeration');
assert('localModeration 正常文本低分', localModeration('博主写得很好，感谢分享！').score === 0);
assert('localModeration 广告词计分', localModeration('免费代刷网').score >= 20);

const { plainText } = require('../src/utils/markdownText');
assert('plainText 提取 Markdown 纯文本', plainText('# 标题\n\n```js\n代码\n```\n正文[链接](http://a.com)').includes('标题 正文链接'));

const { slugify } = require('../src/utils/slugify');
assert('slugify 英文转换小写带减号', slugify('Hello World') === 'hello-world');
assert('slugify 保留中文', slugify('我的文章 123') === '我的文章-123');
assert('slugify 避免重复', slugify('test', ['test']) === 'test-1');

const { getAdminNicknames } = require('../src/utils/ownerBadge');
assert('getAdminNicknames 返回 Set', getAdminNicknames().then((s) => s instanceof Set));

const { shouldCountView } = require('../src/routes/articles');
assert('shouldCountView 首次浏览计数', shouldCountView('1.1.1.1', 'fp1', 1) === true);
assert('shouldCountView 5分钟内同设备不重复计', shouldCountView('1.1.1.1', 'fp1', 1) === false);
assert('shouldCountView 不同文章独立计', shouldCountView('1.1.1.1', 'fp1', 2) === true);

const { matchesCidr } = require('../src/utils/securitySettings');
assert('matchesCidr IPv4 子网匹配', matchesCidr('192.168.1.0/24', '192.168.1.100') === true);
assert('matchesCidr IPv4 子网外不匹配', matchesCidr('192.168.1.0/24', '192.168.2.1') === false);
assert('matchesCidr IPv4-mapped IPv6 互通匹配', matchesCidr('192.168.1.0/24', '::ffff:192.168.1.50') === true);

const { issueToken, verifyToken } = require('../src/middleware/formToken');
const mockReq = { headers: { 'x-fp': 'test-fp', 'user-agent': 'test-ua' }, ip: '127.0.0.1' };
const formTok = issueToken(mockReq, '/comments');
assert('verifyToken 成功验证表单令牌', verifyToken(mockReq, formTok, '/comments').ok === true);
assert('verifyToken 跨路径验证失败', verifyToken(mockReq, formTok, '/messages').ok === false);
assert('verifyToken 伪造指纹验证失败', verifyToken({ ...mockReq, headers: { 'x-fp': 'fake' } }, formTok, '/comments').ok === false);

const { antiSpam, checkSensitive } = require('../src/utils/antiSpam');
assert('checkSensitive 发现违规敏感词', checkSensitive('加微信看片').length > 0);
assert('checkSensitive 正常文本通过', checkSensitive('请教一个关于 React hooks 的问题').length === 0);
assert('antiSpam 拦截超限链接', antiSpam('http://a.com http://b.com http://c.com http://d.com').ok === false);

const { stripExif } = require('../src/utils/stripExif');
// 段长度字段「含长度自身但不含标记」，因此 APP1 载荷 4 字节时长度应为 6。
// 之前写成 8 会让 APP1 段吃掉紧跟的 SOS 标记，解析器按设计保守回退原图，
// 断言必然失败——是夹具错，不是剥离逻辑错。
const fakeJpegWithExif = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, // APP1 EXIF (len=6 → 载荷 4 字节 "Exif")
  0xff, 0xda, 0x00, 0x02, // SOS (len=2 → 空载荷)
  0x12, 0x34, // Image data
  0xff, 0xd9, // EOI
]);
const stripped = stripExif(fakeJpegWithExif);
assert('stripExif 成功剥离 APP1 标记', !stripped.includes(Buffer.from([0xff, 0xe1])));
assert('stripExif 保留 SOI 与图像数据', stripped[0] === 0xff && stripped[1] === 0xd8);

console.log(`sanitize 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
