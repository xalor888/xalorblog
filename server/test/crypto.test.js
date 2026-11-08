/**
 * 内容加密（AES-256-GCM）的离线测试。
 *
 * 背景：`crypto.js` 是文章正文与手记正文共用的唯一加密实现。
 * 之前只有 `notesCrypto.test.js` 覆盖了「按条密钥隔离」这一个侧面，
 * 而加密模块真正要守的东西是另外几样：
 *
 *   1. **往返保真**：解出来的必须逐字节等于原文（含 emoji、空串、超长）
 *   2. **认证完整性**：GCM 的 authTag 必须真的被验证 ——
 *      改动密文里任何一个字节都要解不开，而不是解出垃圾数据
 *   3. **IV 必须随机**：同键同明文两次加密必须得到不同密文。
 *      否则「两篇文章正文相同」这个事实会泄露给能抓包的人。
 *      这一条**功能上完全正常**，只有专门断言才看得出来
 *   4. **失败必须是 null**：而不是空串 —— 否则调用方分不清
 *      「解不开」与「原文就是空的」
 *
 * 第 3 条是最近才补上的：原测试用 `encA !== encB` 来证明「密文不同」，
 * 但那条用的是**不同**的篇密钥 —— 所以即使 IV 固定不变，它也照样通过。
 * 变异测试（`scripts/mutation-crypto.js` 的 C08）就是拿这个做靶子。
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { encryptPayload, decryptPayload, deriveKey, keyMaterial } = require('../src/utils/crypto');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name} — ${e.message}`);
    failures.push(name);
  }
}

const TICKET = '1700000000000.abcdef123456.sig';
const OTHER_TICKET = '1700000000000.999999999999.sig';
const KEY = 'welcome';
const IV_LEN = 12;
const TAG_LEN = 16;

console.log('\n【A. 往返保真】');
{
  ok('ASCII 往返', () => {
    const p = 'hello world';
    assert.strictEqual(decryptPayload(encryptPayload(p, TICKET, KEY), TICKET, KEY), p);
  });
  ok('中文往返', () => {
    const p = '今天把个人主页跑起来了，后续想加相册。';
    assert.strictEqual(decryptPayload(encryptPayload(p, TICKET, KEY), TICKET, KEY), p);
  });
  ok('emoji 往返（含代理对）', () => {
    const p = '😀🎉👨‍👩‍👧‍👦 混排 abc';
    assert.strictEqual(decryptPayload(encryptPayload(p, TICKET, KEY), TICKET, KEY), p);
  });
  ok('空串往返', () => {
    const enc = encryptPayload('', TICKET, KEY);
    assert.strictEqual(decryptPayload(enc, TICKET, KEY), '');
  });
  ok('超长正文往返（20 万字）', () => {
    const p = '字'.repeat(200_000);
    assert.strictEqual(decryptPayload(encryptPayload(p, TICKET, KEY), TICKET, KEY), p);
  });
  ok('含换行与制表符', () => {
    const p = 'line1\nline2\r\n\tindented';
    assert.strictEqual(decryptPayload(encryptPayload(p, TICKET, KEY), TICKET, KEY), p);
  });
  ok('数字输入被 String() 强制转换', () => {
    const enc = encryptPayload(12345, TICKET, KEY);
    assert.strictEqual(decryptPayload(enc, TICKET, KEY), '12345');
  });
}

console.log('\n【B. 密文结构：iv | tag | ciphertext】');
{
  const plain = 'structure check';
  const buf = Buffer.from(encryptPayload(plain, TICKET, KEY), 'base64');
  ok(`总长 = ${IV_LEN} + ${TAG_LEN} + 明文字节数`, () => {
    assert.strictEqual(buf.length, IV_LEN + TAG_LEN + Buffer.byteLength(plain, 'utf8'));
  });
  ok('前 12 字节是 IV（两次加密不同）', () => {
    const a = Buffer.from(encryptPayload(plain, TICKET, KEY), 'base64').subarray(0, IV_LEN);
    const b = Buffer.from(encryptPayload(plain, TICKET, KEY), 'base64').subarray(0, IV_LEN);
    assert.notStrictEqual(a.toString('hex'), b.toString('hex'));
  });
}

console.log('\n【C. IV 必须随机 —— 同键同明文两次加密必须不同】');
{
  // ⚠ 这组是变异测试 C08 的靶子。
  // 用**同一把钥匙**（TICKET + KEY）连encrypt 三次：若 IV 固定，三次密文会完全相同。
  const plain = '相同的内容';
  const encs = [0, 1, 2].map(() => encryptPayload(plain, TICKET, KEY));

  ok('同一把钥匙三次加密得到三个不同密文', () => {
    assert.strictEqual(new Set(encs).size, 3, '出现了重复密文 —— IV 可能被固定');
  });
  ok('三个密文的 IV 段互不相同', () => {
    const ivs = encs.map((e) => Buffer.from(e, 'base64').subarray(0, IV_LEN).toString('hex'));
    assert.strictEqual(new Set(ivs).size, 3);
  });
  ok('三个密文的密文段也不同（IV 参与 GCM 流）', () => {
    const bodies = encs.map((e) => Buffer.from(e, 'base64').subarray(IV_LEN + TAG_LEN).toString('hex'));
    assert.strictEqual(new Set(bodies).size, 3);
  });
  ok('IV 段不能是固定全零', () => {
    for (const e of encs) {
      const iv = Buffer.from(e, 'base64').subarray(0, IV_LEN);
      assert.notStrictEqual(iv.toString('hex'), '0'.repeat(IV_LEN * 2), 'IV 全零 = 未随机');
    }
  });
  ok('IV 的前 4 字节不恒定', () => {
    const heads = encs.map((e) => Buffer.from(e, 'base64').subarray(0, 4).toString('hex'));
    assert.strictEqual(new Set(heads).size, 3, '前 4 字节重复 —— 随机性可能被削弱');
  });
  // ⚠ 变异 C09（只随机前 4 字节、其余补零）第一版没被抓到 ——
  // 因为上面那条只看前 4 字节，而 C09 恰好保留了前 4 字节的随机性。
  // 必须**逐段**检查整个 IV：12 字节全部应随每次加密变化。
  // ⚠ 这条断言第一版写成「三次采样的每个字节位都互不相同」，那是**概率性 flake**：
  //   某字节位三次全不同 ≈ 256×255×254/256³ ≈ 0.988，即有重复 ≈ 1.2%；
  //   12 个字节位至少一处重复 ≈ 1 − 0.988¹² ≈ **13.5%** —— 每跑七次就随机红一次。
  //   第 92 轮实测中它真的红了（`IV 的 12 字节全部随机` 失败），当时差点被当成
  //   「IV 实现坏了」。
  //
  //   正确判据是「**该字节位不是恒定不变**」（取值集合 size ≥ 2），而不是「三次互不相同」：
  //     · 正常实现：某位三次全相同 ≈ (1/256)² ≈ 1.5e-5，12 位 ≈ 0.018%（可接受）
  //     · C09 变异（IV = 随机4字节 + 全零8字节）：后 8 位恒为 0 → size=1 → **仍能抓到**
  //   这样检测力不变，误报率降三个数量级。
  ok('IV 的 12 字节都不恒定（不是只有前几字节随机）', () => {
    const ivs = encs.map((e) => Buffer.from(e, 'base64').subarray(0, IV_LEN));
    for (let i = 0; i < IV_LEN; i++) {
      const col = ivs.map((iv) => iv[i]);
      assert.ok(new Set(col).size >= 2,
        `IV 第 ${i} 字节在三次加密中恒定不变（值 ${col[0]}）— 该字节未随机（变异 C09 的形态）`);
    }
  });
  ok('IV 尾部 8 字节不是全零（C09 会把它们补零）', () => {
    for (const e of encs) {
      const tail = Buffer.from(e, 'base64').subarray(4, IV_LEN);
      assert.notStrictEqual(tail.toString('hex'), '0'.repeat(16), 'IV 尾部全零');
    }
  });
}

console.log('\n【D. GCM 认证完整性：篡改必须被发现】');
{
  const plain = 'tamper detection test';
  const enc = encryptPayload(plain, TICKET, KEY);

  const flip = (byteIndex) => {
    const buf = Buffer.from(enc, 'base64');
    buf[byteIndex] ^= 0x01;
    return buf.toString('base64');
  };

  ok('改密文段任意一字节 → 解不开', () => {
    const buf = Buffer.from(enc, 'base64');
    assert.strictEqual(decryptPayload(flip(buf.length - 1), TICKET, KEY), null);
  });
  ok('改 authTag → 解不开', () => {
    assert.strictEqual(decryptPayload(flip(IV_LEN), TICKET, KEY), null);
  });
  ok('改 IV → 解不开', () => {
    assert.strictEqual(decryptPayload(flip(0), TICKET, KEY), null);
  });
  ok('**明文段整体替换**也解不开（不是「解出垃圾数据」）', () => {
    const buf = Buffer.from(enc, 'base64');
    const evil = Buffer.from('evil payload', 'utf8');
    const forged = Buffer.concat([buf.subarray(0, IV_LEN + TAG_LEN), evil]);
    const out = decryptPayload(forged.toString('base64'), TICKET, KEY);
    assert.strictEqual(out, null, `竟然解出了内容：${JSON.stringify(out)}`);
  });
}

console.log('\n【E. 密钥隔离：票 与 篇密钥都必须参与】');
{
  const plain = 'isolation';
  const enc = encryptPayload(plain, TICKET, KEY);

  ok('换票 → 解不开', () => {
    assert.strictEqual(decryptPayload(enc, OTHER_TICKET, KEY), null);
  });
  ok('换篇密钥 → 解不开', () => {
    assert.strictEqual(decryptPayload(enc, TICKET, 'other-slug'), null);
  });
  ok('去掉篇密钥 → 解不开', () => {
    assert.strictEqual(decryptPayload(enc, TICKET), null);
  });
  ok('空票 → 解不开（票是密钥材料的一部分）', () => {
    assert.strictEqual(decryptPayload(enc, '', KEY), null);
  });
  ok('空篇密钥与无篇密钥等价（都不该解开带 key 的密文）', () => {
    assert.strictEqual(decryptPayload(enc, TICKET, ''), null);
  });

  // 分隔符不能省：ticket='a', key='bc' 与 ticket='ab', key='c' 必须派生出不同密钥
  ok('篇密钥的分隔符有效（避免 ticket+key 拼接歧义）', () => {
    assert.notStrictEqual(keyMaterial('a', 'bc'), keyMaterial('ab', 'c'));
    assert.notStrictEqual(
      deriveKey('a', 'bc').toString('hex'),
      deriveKey('ab', 'c').toString('hex')
    );
  });
}

console.log('\n【E2. 密钥材料必须绑定配置里的 encSalt】');
{
  // ⚠ 变异 C12（把 config.security.encSalt 换成固定字符串）第一版没被抓到 ——
  // 因为加解密都用同一个 deriveKey，自洽性完好，往返测试照样通过。
  // **只有独立算一遍**才看得出密钥是不是从配置来的。
  const config = require('../src/config');
  const nodeCrypto = require('crypto');

  ok('deriveKey 等于 HMAC-SHA256(config.security.encSalt, ticket|key)', () => {
    const want = nodeCrypto
      .createHmac('sha256', config.security.encSalt)
      .update(`${TICKET}|${KEY}`)
      .digest('hex');
    assert.strictEqual(deriveKey(TICKET, KEY).toString('hex'), want);
  });
  ok('encSalt 参与派生（换 salt 必换密钥）', () => {
    const other = nodeCrypto
      .createHmac('sha256', 'definitely-not-the-salt')
      .update(`${TICKET}|${KEY}`)
      .digest('hex');
    assert.notStrictEqual(deriveKey(TICKET, KEY).toString('hex'), other,
      '密钥不随 encSalt 变化 —— 说明没用配置里的 salt');
  });
  ok('encSalt 非空且足够长', () => {
    assert.ok(typeof config.security.encSalt === 'string' && config.security.encSalt.length >= 16,
      `encSalt 长度 ${String(config.security.encSalt).length}`);
  });
}

console.log('\n【F. 失败必须是 null，不是空串】');
{
  const plain = 'x';
  const enc = encryptPayload(plain, TICKET, KEY);

  ok('换票返回 null（不是 ""）', () => {
    const r = decryptPayload(enc, OTHER_TICKET, KEY);
    assert.strictEqual(r, null);
    assert.notStrictEqual(r, '');
  });
  ok('空 payload 返回 null', () => {
    assert.strictEqual(decryptPayload('', TICKET, KEY), null);
  });
  ok('非 base64 返回 null', () => {
    assert.strictEqual(decryptPayload('!!!not-base64!!!', TICKET, KEY), null);
  });
  ok('长度不足 iv+tag 返回 null', () => {
    assert.strictEqual(decryptPayload(Buffer.alloc(20).toString('base64'), TICKET, KEY), null);
  });
  ok('null / undefined payload 返回 null 而不是抛', () => {
    assert.strictEqual(decryptPayload(null, TICKET, KEY), null);
    assert.strictEqual(decryptPayload(undefined, TICKET, KEY), null);
  });
}

console.log('\n【G. 空白 strip —— 空原文与「解不开」必须可区分】');
{
  const emptyEnc = encryptPayload('', TICKET, KEY);
  ok('空原文解出空串（不是 null）', () => {
    const r = decryptPayload(emptyEnc, TICKET, KEY);
    assert.strictEqual(r, '');
    assert.notStrictEqual(r, null);
  });
}

console.log('\n【H. 自检：判据真的能区分】');
{
  ok('自检：不同明文 → 不同密文', () => {
    assert.notStrictEqual(encryptPayload('a', TICKET, KEY), encryptPayload('b', TICKET, KEY));
  });
  ok('自检：deriveKey 是 32 字节（AES-256 要求）', () => {
    assert.strictEqual(deriveKey(TICKET, KEY).length, 32);
  });
  ok('自检：keyMaterial 的 4 种组合各不相同', () => {
    const set = new Set([
      keyMaterial('t', 'k'), keyMaterial('t', ''), keyMaterial('', 'k'), keyMaterial('', ''),
    ]);
    assert.strictEqual(set.size, 4);
  });
  ok('自检：篡改检测不是靠「长度变了」—— 等长替换也会被拒', () => {
    const enc = encryptPayload('abcdef', TICKET, KEY);
    const buf = Buffer.from(enc, 'base64');
    // 等长替换密文段最后一个字节
    buf[buf.length - 1] ^= 0xff;
    assert.strictEqual(decryptPayload(buf.toString('base64'), TICKET, KEY), null);
  });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
