/**
 * 对齐浏览器 WebCrypto 的 AES-GCM 拆包：
 * 服务端密文 = iv(12) | tag(16) | ciphertext
 * decrypt 输入必须是 ciphertext||tag，不能把 iv 再拼进去。
 */
const { webcrypto } = require('crypto');
const { encryptPayload } = require('../src/utils/crypto');
const config = require('../src/config');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function keyMaterial(ticket, articleKey) {
  const extra = articleKey == null || articleKey === '' ? '' : `|${articleKey}`;
  return String(ticket || '') + extra;
}

async function decryptBrowserStyle(payload, ticket, articleKey, withIvPrefix) {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const hmacKey = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.security.encSalt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await webcrypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(keyMaterial(ticket, articleKey)));
  const key = await webcrypto.subtle.importKey('raw', sig, { name: 'AES-GCM' }, false, ['decrypt']);
  const input = withIvPrefix
    ? Buffer.concat([iv, data, tag])
    : Buffer.concat([data, tag]);
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, input);
  return new TextDecoder().decode(plain);
}

async function run() {
  const ticket = `${Date.now()}.deadbeefcafebabe.sig`;
  const plain = '# hello\n正文';
  const enc = encryptPayload(plain, ticket, 'welcome');

  const ok = await decryptBrowserStyle(enc, ticket, 'welcome', false);
  assert('ciphertext||tag 可解', ok === plain);

  let bad = 'threw';
  try {
    bad = await decryptBrowserStyle(enc, ticket, 'welcome', true);
  } catch (e) {
    bad = 'threw';
  }
  assert('iv||ciphertext||tag 必须失败', bad === 'threw');

  console.log(`\nbrowserCrypto 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
