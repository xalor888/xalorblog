const { safeUrl } = require('../src/utils/sanitize');

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

console.log(`sanitize 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
