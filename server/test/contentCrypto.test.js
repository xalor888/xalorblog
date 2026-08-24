/**
 * 按篇内容密钥：同一张票解开 A 不能解开 B
 */
const { encryptPayload, decryptPayload } = require('../src/utils/crypto');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

const ticket = `${Date.now()}.deadbeefcafebabe.sig`;
const plain = '# hello\n正文';
const encA = encryptPayload(plain, ticket, 'welcome');
const encB = encryptPayload(plain, ticket, 'other');

assert('同票同 slug 可解', decryptPayload(encA, ticket, 'welcome') === plain);
assert('同票换 slug 不可解', decryptPayload(encA, ticket, 'other') === null);
assert('无 slug 不可解按篇密文', decryptPayload(encA, ticket) === null);
assert('另一篇密文与本篇不同', encA !== encB);
assert('换票不可解', decryptPayload(encA, '0.other.sig', 'welcome') === null);

const legacy = encryptPayload(plain, ticket);
assert('无 slug 的旧密文仍可用票解开', decryptPayload(legacy, ticket) === plain);

console.log(`\ncontentCrypto 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
