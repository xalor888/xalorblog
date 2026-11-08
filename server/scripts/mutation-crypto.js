#!/usr/bin/env node
/**
 * crypto.js（AES-256-GCM 内容加密）的变异测试。
 *
 * 为什么选它：这是「内容加密」的唯一实现，被文章正文与手记正文共用。
 * 加密模块的错误有两个特点：
 *   1. **算错了仍然能跑** —— 加密/解密都是自洽的，只有跨实现比对才看得出
 *   2. **安全属性的缺失看不出来** —— 比如 IV 复用会让「相同明文 → 相同密文」，
 *      功能上一切正常，但泄露了「两篇文章正文一样」这个信息
 *
 * 所以变异清单分两类：
 *   - 「破坏自洽性」（改长度、改拼接顺序）→ 往返测试应当抓到
 *   - 「破坏安全属性但保持自洽」（固定 IV、丢掉 authTag 校验）→ **只有专门断言才抓得到**
 *
 * 第二类是这次的真正目标。第一类只是顺带确认。
 *
 * 用法：
 *   node scripts/mutation-crypto.js
 *   node scripts/mutation-crypto.js --strict
 */

'use strict';

const { join } = require('path');
const { runMutations } = require('./lib/mutation-runner');

const ROOT = join(__dirname, '..');
const TARGET = join(ROOT, 'src', 'utils', 'crypto.js');
const TEST = join(ROOT, 'test', 'crypto.test.js');

const MUTATIONS = [
  // ---------- 类一：破坏自洽性（往返测试应当抓到） ----------
  {
    id: 'C01',
    desc: 'IV 长度改成 16（与 GCM 标准不符，往返必失败）',
    from: 'const IV_LEN = 12;',
    to: 'const IV_LEN = 16;',
  },
  {
    id: 'C02',
    desc: 'authTag 长度改成 15（切片错位）',
    from: 'const TAG_LEN = 16;',
    to: 'const TAG_LEN = 15;',
  },
  {
    id: 'C03',
    desc: '拼接顺序改成 iv|ciphertext|tag（解密端读错位置）',
    from: '  return Buffer.concat([iv, tag, enc]).toString(\'base64\');',
    to: '  return Buffer.concat([iv, enc, tag]).toString(\'base64\');',
  },
  {
    id: 'C04',
    desc: '解密端不读 authTag（GCM 会拒绝，往返失败）',
    from: '    decipher.setAuthTag(tag);',
    to: '    // 注入：不设置 authTag',
  },
  {
    id: 'C05',
    desc: '解密端的切片顺序错位',
    from: `    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);`,
    to: `    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN + TAG_LEN, IV_LEN + TAG_LEN * 2);
    const data = buf.subarray(IV_LEN + TAG_LEN * 2);`,
  },
  {
    id: 'C06',
    desc: '解密失败时返回空串而不是 null（调用方无法区分「解不开」与「空内容」）',
    from: `  } catch (e) {
    return null;
  }`,
    to: `  } catch (e) {
    return '';
  }`,
  },
  {
    id: 'C07',
    desc: '长度下限放宽到只看 IV（短包会被当合法继续解）',
    from: '    if (buf.length < IV_LEN + TAG_LEN) return null;',
    to: '    if (buf.length < IV_LEN) return null;',
    // **等价变异**：放宽后短包确实会走到 subarray，但 tag 长度不足时
    // Node 的 GCM 会抛「Invalid authentication tag length」，
    // 被外层 try/catch 兜住 → 仍然返回 null。**可观察结果完全相同。**
    // 这条守卫是「早返回」的性能优化，不是安全边界。
    equivalent: true,
  },

  // ---------- 类二：破坏安全属性但保持自洽（**只有专门断言能抓**） ----------
  {
    id: 'C08',
    desc: '**IV 固定成全零**（同键同明文 → 相同密文，泄露「内容相同」）',
    from: '  const iv = crypto.randomBytes(IV_LEN);',
    to: '  const iv = Buffer.alloc(IV_LEN);   // 注入：固定 IV',
  },
  {
    id: 'C09',
    desc: '**IV 只用 4 字节随机、其余补零**（随机性大幅下降）',
    from: '  const iv = crypto.randomBytes(IV_LEN);',
    to: '  const iv = Buffer.concat([crypto.randomBytes(4), Buffer.alloc(IV_LEN - 4)]);',
  },
  {
    id: 'C10',
    desc: '**密钥派生丢掉 articleKey**（同一张票可解同一作者的所有文章）',
    from: "  const extra = articleKey == null || articleKey === '' ? '' : `|${articleKey}`;",
    to: "  const extra = '';   // 注入：忽略篇密钥",
  },
  {
    id: 'C11',
    desc: '**密钥派生丢掉 passTicket**（票不再是密钥材料 → 任何人可解）',
    from: '  return ticket + extra;',
    to: '  return extra;   // 注入：忽略票据',
  },
  {
    id: 'C12',
    desc: '密钥派生改用固定 salts（加密/解密自洽，但脱离配置的 encSalt）',
    from: '  return crypto.createHmac(\'sha256\', config.security.encSalt).update(keyMaterial(passTicket, articleKey)).digest();',
    to: '  return crypto.createHmac(\'sha256\', \'fixed-salt\').update(keyMaterial(passTicket, articleKey)).digest();',
  },
  {
    id: 'C13',
    desc: '篇密钥分隔符从 | 改成无分隔（articleKey 拼进 ticket 造成歧义）',
    from: "  const extra = articleKey == null || articleKey === '' ? '' : `|${articleKey}`;",
    to: "  const extra = articleKey == null || articleKey === '' ? '' : `${articleKey}`;",
  },
  {
    id: 'C14',
    desc: '加密不再 String() 强制转换（非字符串输入行为改变）',
    from: '  const enc = Buffer.concat([cipher.update(String(plaintext), \'utf8\'), cipher.final()]);',
    to: '  const enc = Buffer.concat([cipher.update(plaintext, \'utf8\'), cipher.final()]);',
  },
  {
    id: 'C15',
    desc: '算法换成 aes-256-cbc（**失去认证**，密文可被篡改而不被发现）',
    from: "const ALGO = 'aes-256-gcm';",
    to: "const ALGO = 'aes-256-cbc';",
  },
];

const result = runMutations({
  title: 'crypto.js（AES-256-GCM 内容加密）',
  target: TARGET,
  test: TEST,
  mutations: MUTATIONS,
  root: ROOT,
});

if (result.baselineFailed) {
  console.error('\n⚠ 基线失败 —— 可能 test/crypto.test.js 还不存在。');
  process.exit(1);
}
if (result.survived > 0 && process.argv.includes('--strict')) {
  console.log('\n--strict 模式：存活变异视为失败');
  process.exit(1);
}
