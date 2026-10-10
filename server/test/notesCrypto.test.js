/**
 * 手记正文按条密钥：同一张票解开 note:1 不能解开 note:2
 * 手记复用文章的 encryptPayload，只是把「篇密钥」换成 note:<id>，
 * 因此这里必须单独回归：命名空间写错（例如直接用 id）会与文章 slug 撞车。
 */
const { encryptPayload, decryptPayload } = require('../src/utils/crypto');
const { noteContentKey } = require('../src/routes/notes');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

const ticket = `${Date.now()}.deadbeefcafebabe.sig`;
const plain = '今天把个人主页跑起来了\n\n后续想加相册。';
const keyA = noteContentKey(1);
const keyB = noteContentKey(2);

assert('内容密钥带 note: 命名空间', keyA === 'note:1' && keyB === 'note:2');

const encA = encryptPayload(plain, ticket, keyA);
const encB = encryptPayload(plain, ticket, keyB);

assert('同票同手记可解', decryptPayload(encA, ticket, keyA) === plain);
assert('同票换手记不可解', decryptPayload(encA, ticket, keyB) === null);
assert('无篇密钥不可解按条密文', decryptPayload(encA, ticket) === null);
assert('另一条手记密文不同', encA !== encB);
assert('换票不可解', decryptPayload(encA, '0.other.sig', keyA) === null);

// 命名空间隔离：手记密钥不能解文章密文，反之亦然
const asArticle = encryptPayload(plain, ticket, 'welcome');
assert('手记密钥解不开文章密文', decryptPayload(asArticle, ticket, keyA) === null);
assert('文章密钥解不开手记密文', decryptPayload(encA, ticket, 'welcome') === null);

// 明文不得出现在密文里
assert('密文不含明文片段', !Buffer.from(encA, 'base64').toString('utf8').includes('个人主页'));

console.log(`\nnotesCrypto 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
