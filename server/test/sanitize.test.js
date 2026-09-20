const { safeUrl, safeCover, safeEmail } = require('../src/utils/sanitize');

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

assert('cover 允许默认 logo', safeCover('/logo.png') === '/logo.png');
assert('cover 允许上传文件名', safeCover('/uploads/123-abcdef.png') === '/uploads/123-abcdef.png');
assert('cover 拒绝任意站内路径', safeCover('/etc/passwd') === '');
assert('cover 拒绝路径穿越', safeCover('/uploads/../logo.png') === '');
assert('cover 拒绝属性注入', safeCover('/logo.png" onerror="alert(1)') === '');
assert('cover 允许 https 外链', !!safeCover('https://example.com/a.png'));
assert('cover 拒绝 javascript', safeCover('javascript:alert(1)') === '');

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
