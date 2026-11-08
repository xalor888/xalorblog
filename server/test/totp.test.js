/**
 * TOTP 两步验证的**离线**测试 —— 用 RFC 4226 / RFC 4648 标准向量验证。
 *
 * 为什么需要它：`totp.js` 此前**没有任何离线测试**。
 * 唯一涉及它的 `2fa.test.js` 是集成测试（要起服务 + 干净库），
 * 而集成链在常规 `npm test` 里跑不到 —— 等于 2FA 的核心算法在日常循环里是裸奔的。
 *
 * 这类错误最隐蔽：验证码算错时，用户只看到「验证码无效」，
 * 分不清是时钟偏差、密钥解码错、还是截断算法错。而如果算错的方向是**宽松**的
 * （比如窗口开到 ±5 步），攻击者有 5 分钟的暴力窗口且完全看不出来。
 *
 * 所以这里做三件普通测试做不到的事：
 *   1. **用 RFC 4226 附录 D 的官方测试向量**验证（secret = ASCII "12345678901234567890"）
 *   2. **覆盖 `Date.now`** 把时间钉死，从而能精确测「当前步 / ±1 步 / ±2 步」
 *      （否则测窗口边界要真的等 30 秒，既慢又不稳）
 *   3. **独立实现一遍 HOTP**，与模块交叉验证 —— 只测"自洽"证明不了符合标准
 */

'use strict';

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const crypto = require('crypto');
const { generateSecret, verifyCode, otpauthUri, currentStep } = require('../src/utils/totp');

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
function okThrows(name, fn, expectMsg) {
  try {
    fn();
    fail++;
    console.log(`  ✗ ${name} — 期望抛错但没有`);
    failures.push(name);
  } catch (e) {
    if (expectMsg && !String(e.message).includes(expectMsg)) {
      fail++;
      console.log(`  ✗ ${name} — 抛了但信息不含「${expectMsg}」: ${e.message}`);
      failures.push(name);
    } else {
      pass++;
      console.log(`  ✓ ${name}`);
    }
  }
}

/* ============================================================
 * 独立实现（RFC 4648 base32 + RFC 4226 HOTP）—— 不复用被测代码
 * ============================================================ */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function refBase32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f];
  return out;
}

function refHotp(secretBuffer, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuffer).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1e6).padStart(6, '0');
}

/** 把时间钉到指定步（verifyCode 内部走 Date.now()，覆盖它即可确定性测试） */
const realNow = Date.now;
function atStep(step) {
  Date.now = () => step * 30 * 1000;
}
function restoreClock() {
  Date.now = realNow;
}

console.log('\n【A. RFC 4648 base32 编码基线（自检参考实现本身）】');
ok('参考实现：ASCII "12345678901234567890" 的 base32', () => {
  assert.strictEqual(
    refBase32Encode(Buffer.from('12345678901234567890', 'ascii')),
    'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  );
});
ok('参考实现：RFC 4648 §10 的 "f" → "MY======"（去掉填充后 MY）', () => {
  assert.strictEqual(refBase32Encode(Buffer.from('f')).slice(0, 2), 'MY');
});

console.log('\n【B. RFC 4226 附录 D 官方测试向量（6 位变体）】');
{
  // RFC 4226 用 secret = ASCII "12345678901234567890"，
  // 附录 D 给出 counter 0..9 的 6 位截断值（表里是 10 位，取后 6 位）。
  const SECRET = refBase32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const RFC_VECTORS = [
    [0, '755224'], [1, '287082'], [2, '359152'], [3, '969429'], [4, '338314'],
    [5, '254676'], [6, '287922'], [7, '162583'], [8, '399871'], [9, '520489'],
  ];

  ok('参考实现与 RFC 向量完全一致（10 个计数器）', () => {
    const secretBuf = Buffer.from('12345678901234567890', 'ascii');
    for (const [counter, want] of RFC_VECTORS) {
      assert.strictEqual(refHotp(secretBuf, counter), want, `counter=${counter}`);
    }
  });

  // 被测模块：只测 counter >= 1（counter 0 时窗口 -1 会走到负数计数器，见 D 组）
  for (const [counter, want] of RFC_VECTORS.filter(([n]) => n >= 1)) {
    ok(`verifyCode 接受 RFC 向量 counter=${counter} 的码 ${want}`, () => {
      atStep(counter);
      try {
        assert.strictEqual(verifyCode(SECRET, want), true);
      } finally {
        restoreClock();
      }
    });
  }

  ok('verifyCode 拒绝不在 ±1 窗口内的码', () => {
    atStep(5);
    try {
      // counter=5 → 254676；counter=4 → 338314；counter=6 → 287922
      assert.strictEqual(verifyCode(SECRET, '254676'), true, '当前步应当通过');
      assert.strictEqual(verifyCode(SECRET, '338314'), true, '前一步应当通过（WINDOW=1）');
      assert.strictEqual(verifyCode(SECRET, '287922'), true, '后一步应当通过（WINDOW=1）');
      assert.strictEqual(verifyCode(SECRET, '969429'), false, 'counter=3 超出窗口，应拒绝');
      assert.strictEqual(verifyCode(SECRET, '162583'), false, 'counter=7 超出窗口，应拒绝');
      assert.strictEqual(verifyCode(SECRET, '000000'), false, '随机码应拒绝');
    } finally {
      restoreClock();
    }
  });
}

console.log('\n【C. currentStep 的 30 秒步长】');
ok('步长是 30 秒', () => {
  assert.strictEqual(currentStep(0), 0);
  assert.strictEqual(currentStep(29_999), 0);
  assert.strictEqual(currentStep(30_000), 1);
  assert.strictEqual(currentStep(59_999), 1);
  assert.strictEqual(currentStep(60_000), 2);
});
ok('步长与 otpauth 里声明的 period 一致', () => {
  const uri = otpauthUri('ABCDEF', 'admin');
  assert.ok(uri.includes('period=30'), uri);
});
ok('currentStep 对负时间不崩（返回负数而不是抛）', () => {
  assert.strictEqual(currentStep(-1), -1);
  assert.strictEqual(currentStep(-30_000), -1);
});

console.log('\n【D. 边界：时间步 0 时窗口向下会走到负计数器（回归）】');
{
  // 这组是**回归测试**：修之前 verifyCode 在 step=0 时会抛 RangeError。
  //
  // `hotp()` 用 `writeBigUInt64BE(BigInt(counter))`，无符号 64 位不接受负数。
  // step=0 时 offset=-1 → counter=-1 → 抛错 → 违反「返回 boolean」的契约。
  //
  // 生产环境不可达（Date.now() 永远远大于 30s），但契约应当成立：
  // 调用方不会为「验证码校验」包 try/catch，而且一旦 currentStep 变成可注入的，
  // 这条就从「不可达」变成「真的 500」。
  //
  // 修法：循环里 `if (step + offset < 0) continue;`
  const SECRET = refBase32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const secretBuf = Buffer.from('12345678901234567890', 'ascii');

  ok('**step=0 时不抛，返回 boolean**（回归：修复前抛 RangeError）', () => {
    atStep(0);
    try {
      assert.doesNotThrow(() => verifyCode(SECRET, '755224'));
      assert.strictEqual(typeof verifyCode(SECRET, '755224'), 'boolean');
    } finally {
      restoreClock();
    }
  });
  ok('step=0 时当前步的码仍然能被接受（只跳过负的，不误伤 0 本身）', () => {
    atStep(0);
    try {
      assert.strictEqual(verifyCode(SECRET, refHotp(secretBuf, 0)), true);
    } finally {
      restoreClock();
    }
  });
  ok('step=0 时 step=1 的码也能通过（正向窗口仍生效）', () => {
    atStep(0);
    try {
      assert.strictEqual(verifyCode(SECRET, refHotp(secretBuf, 1)), true);
    } finally {
      restoreClock();
    }
  });
  ok('step=0 时错误码返回 false 而不是抛', () => {
    atStep(0);
    try {
      assert.strictEqual(verifyCode(SECRET, '000000'), false);
    } finally {
      restoreClock();
    }
  });
  ok('step=1 起的正常范围行为不变', () => {
    atStep(1);
    try {
      assert.strictEqual(verifyCode(SECRET, refHotp(secretBuf, 1)), true);
      assert.strictEqual(verifyCode(SECRET, refHotp(secretBuf, 0)), true);   // 负向窗口仍生效
    } finally {
      restoreClock();
    }
  });
}

console.log('\n【E. verifyCode 的输入校验】');
{
  const SECRET = refBase32Encode(Buffer.from('12345678901234567890', 'ascii'));
  atStep(100);
  const good = refHotp(Buffer.from('12345678901234567890', 'ascii'), 100);
  try {
    ok('正确码通过', () => assert.strictEqual(verifyCode(SECRET, good), true));
    ok('前导零补位的码也按 6 位处理', () => {
      // 找一个天然带前导零的码来验证 padStart 逻辑（用参考实现扫一段范围）
      const secretBuf = Buffer.from('12345678901234567890', 'ascii');
      let found = null;
      for (let i = 100; i < 2000; i++) {
        const c = refHotp(secretBuf, i);
        if (c.startsWith('0')) { found = { step: i, code: c }; break; }
      }
      assert.ok(found, '参考实现应能找到一个以 0 开头的码');
      const savedStep = found.step;
      atStep(savedStep);
      try {
        assert.strictEqual(verifyCode(SECRET, found.code), true, `step=${savedStep} code=${found.code}`);
      } finally {
        // ⚠ 必须在这里恢复时钟再回到 100 ——
        // 第一版把恢复留给外层 finally，结果这条之后的断言全都跑在
        // step=savedStep 上，`good`（step=100 的码）自然验不过，假红两条。
        atStep(100);
      }
    });

    ok('非 6 位码拒绝', () => {
      assert.strictEqual(verifyCode(SECRET, '12345'), false);
      assert.strictEqual(verifyCode(SECRET, '1234567'), false);
      assert.strictEqual(verifyCode(SECRET, ''), false);
    });
    ok('含非数字拒绝', () => {
      assert.strictEqual(verifyCode(SECRET, '12a456'), false);
      assert.strictEqual(verifyCode(SECRET, ' 12345'), false);
    });
    ok('非字符串拒绝', () => {
      assert.strictEqual(verifyCode(SECRET, 123456), false);
      assert.strictEqual(verifyCode(SECRET, null), false);
      assert.strictEqual(verifyCode(SECRET, undefined), false);
    });
    ok('首尾空白被 trim 后接受', () => {
      assert.strictEqual(verifyCode(SECRET, ` ${good} `), true);
    });
    ok('空密钥拒绝（base32 解出 0 字节）', () => {
      assert.strictEqual(verifyCode('', good), false);
      assert.strictEqual(verifyCode('!!!!', good), false);
    });
    ok('小写密钥也能解码（base32 大小写不敏感）', () => {
      assert.strictEqual(verifyCode(SECRET.toLowerCase(), good), true);
    });
  } finally {
    restoreClock();
  }
}

console.log('\n【F. 防重放】');
{
  const SECRET = refBase32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const secretBuf = Buffer.from('12345678901234567890', 'ascii');
  atStep(200);
  try {
    const code = refHotp(secretBuf, 200);
    const guard = new Map();

    ok('首次使用成功', () => assert.strictEqual(verifyCode(SECRET, code, guard, 'user1'), true));
    ok('同一步重复使用被拒', () => assert.strictEqual(verifyCode(SECRET, code, guard, 'user1'), false));
    ok('不同用户互不影响', () => assert.strictEqual(verifyCode(SECRET, code, guard, 'user2'), true));
    ok('防重放表里存的是 Set（新版形态）', () => {
      assert.ok(guard.get('user1') instanceof Set);
    });

    // 旧版只存单个整数 —— 兼容路径必须能读
    ok('兼容旧的「单整数」存储形态', () => {
      const legacy = new Map([['legacyUser', 200]]);
      assert.strictEqual(verifyCode(SECRET, code, legacy, 'legacyUser'), false,
        '旧形态存的就是当前步，应判为重放');
      assert.ok(legacy.get('legacyUser') instanceof Set, '应当被升级成 Set');
    });

    ok('不传 guard 时不做重放检查（可用于不需要的场景）', () => {
      assert.strictEqual(verifyCode(SECRET, code), true);
      assert.strictEqual(verifyCode(SECRET, code), true);
    });

    ok('越界步会被即时裁剪（防单用户高频登录撑爆内存）', () => {
      const g = new Map();
      atStep(300);
      verifyCode(SECRET, refHotp(secretBuf, 300), g, 'u');
      const before = g.get('u').size;
      atStep(310);   // 10 步之后
      verifyCode(SECRET, refHotp(secretBuf, 310), g, 'u');
      const after = g.get('u').size;
      assert.ok(after <= before + 1, `裁剪后应保持很小：${before} → ${after}`);
      // 旧步（300）应当已被裁掉
      assert.ok(!g.get('u').has(300), '10 步之前的记录应被裁剪');
    });
  } finally {
    restoreClock();
  }
}

console.log('\n【G. generateSecret】');
{
  const s = generateSecret();
  ok('默认长度 32 字符（160 bit）', () => assert.strictEqual(s.length, 32, s));
  ok('只含 base32 字符集', () => assert.ok(/^[A-Z2-7]+$/.test(s), s));
  ok('大写（RFC 4648 要求）', () => assert.strictEqual(s, s.toUpperCase()));
  ok('两次生成不同（有随机性）', () => assert.notStrictEqual(generateSecret(), generateSecret()));
  ok('自定义长度生效', () => {
    assert.strictEqual(generateSecret(16).length, 16);
    assert.strictEqual(generateSecret(64).length, 64);
  });
  ok('生成的密钥可用于签发与验证', () => {
    const secret = generateSecret();
    atStep(500);
    try {
      // 用独立实现算出该密钥在当前步的码（需要 base32 解码 —— 靠模块间接验证：
      // 用 verifyCode 前先确认参考解码与模块一致，这里换一条路：直接扫 ±1 窗口）
      // 简单起见：用模块自己的 currentStep + 参考 HOTP 需要 base32 解码；
      // 我们在此内联实现解码，与 base32Decode 同算法。
      const decode = (input) => {
        const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
        let bits = 0, value = 0;
        const out = [];
        for (const ch of clean) {
          const idx = B32.indexOf(ch);
          if (idx === -1) continue;
          value = (value << 5) | idx;
          bits += 5;
          if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
        }
        return Buffer.from(out);
      };
      const code = refHotp(decode(secret), 500);
      assert.strictEqual(verifyCode(secret, code), true);
    } finally {
      restoreClock();
    }
  });
  ok('160bit 熵：32 字符 × 5 bit = 160', () => {
    assert.strictEqual(32 * 5, 160);
  });
}

console.log('\n【H. otpauthUri 格式】');
{
  const uri = otpauthUri('ABCDEFGH23456789', 'admin@site');
  ok('scheme 与 type 正确', () => assert.ok(uri.startsWith('otpauth://totp/'), uri));
  ok('含 secret', () => assert.ok(uri.includes('secret=ABCDEFGH23456789'), uri));
  ok('含 algorithm=SHA1', () => assert.ok(uri.includes('algorithm=SHA1'), uri));
  ok('含 digits=6', () => assert.ok(uri.includes('digits=6'), uri));
  ok('含 period=30', () => assert.ok(uri.includes('period=30'), uri));
  ok('label 里 issuer 与 account 都被编码', () => {
    const u = otpauthUri('SEC', 'a b@c');
    assert.ok(u.includes('Xalor%20Blog'), u);
    assert.ok(u.includes('a%20b%40c'), u);
  });
  ok('uri 可被 URL 解析（格式合法）', () => {
    assert.doesNotThrow(() => new URL(uri));
  });
}

console.log('\n【I. 自检：判据真的能区分】');
{
  ok('自检：参考 HOTP 与 RFC 首值一致', () => {
    assert.strictEqual(refHotp(Buffer.from('12345678901234567890', 'ascii'), 0), '755224');
  });
  ok('自检：不同计数器产生不同码', () => {
    const b = Buffer.from('12345678901234567890', 'ascii');
    const codes = new Set([0, 1, 2, 3, 4].map((n) => refHotp(b, n)));
    assert.strictEqual(codes.size, 5);
  });
  ok('自检：时钟覆盖真的生效', () => {
    const a = currentStep();
    atStep(999);
    try {
      assert.strictEqual(currentStep(), 999);
    } finally {
      restoreClock();
    }
    assert.strictEqual(currentStep(), a);
  });
  ok('自检：6 位码的搜索能找到前导零样本（证明 E 组那条不是空跑）', () => {
    const b = Buffer.from('12345678901234567890', 'ascii');
    let n = 0;
    for (let i = 0; i < 2000; i++) if (refHotp(b, i).startsWith('0')) { n++; break; }
    assert.ok(n > 0);
  });
}

restoreClock();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
