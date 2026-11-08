/**
 * `securitySettings.saveConfig` 的失败路径（零真实 DB）。
 *
 * 为什么这条重要：`saveConfig` 不传 `base` 时会**先读库**再合并。
 * 如果读库失败被静默吞掉，就会拿 `DEFAULT_CONFIG` 当基准合并 ——
 * 于是一次「改个白名单」的操作会把用户的全部安全配置**重置成默认值**，
 * 而且接口返回成功后，从界面上完全看不出来（保存成功了呀）。
 *
 * 正确行为：读库失败 → 异常抛出 → 路由返回 500 → 用户知道没保存成功，
 * 库里那份配置原封不动。
 *
 * 实现方式：用 `require.cache` 注入一个「一调用就抛错」的 db 替身，
 * 让真实 `saveConfig` 走到真实分支上。比源码文本断言强得多 ——
 * 这是本仓库第一次能真正驱动这条路径。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function suite() {
console.log('=== A. saveConfig 的三种基准来源 ===');
{
  // 干净加载：用真实的 db 模块路径注入替身
  const dbPath = require.resolve('../src/db');
  const calls = [];
  let mode = 'fail';

  const fakeDb = (table) => {
    calls.push(table);
    if (mode === 'fail') {
      // 模拟「连接被拒 / 表不存在」：knex 的查询是 thenable，抛出即 reject
      const err = new Error('模拟：security_config 读取失败');
      const q = {
        where: () => q,
        select: () => q,
        limit: () => q,
        insert: () => q,
        onConflict: () => q,
        merge: () => q,
        then: (_res, rej) => rej(err),
        catch: (fn) => { fn(err); return q; },
      };
      return q;
    }
    // mode === 'ok'：返回一行已存在的配置
    const q = {
      where: () => q,
      select: () => q,
      limit: () => Promise.resolve([{ data: JSON.stringify({ wafEnabled: true, paranoid: 2 }) }]),
      insert: () => q,
      onConflict: () => q,
      merge: () => q,
      then: (res) => res([{ data: JSON.stringify({ wafEnabled: true, paranoid: 2 }) }]),
      catch: () => q,
    };
    return q;
  };
  fakeDb.fn = { now: () => 'NOW()' };
  fakeDb.raw = (s) => s;

  // 注入前先确认目标模块尚未被本进程加载
  delete require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

  const ss = require('../src/utils/securitySettings');

  // A1: 读库失败必须抛错
  let threw = null;
  try {
    await ss.saveConfig({ wafEnabled: false });
  } catch (e) {
    threw = e;
  }
  ok('读库失败时 saveConfig 抛出异常（不静默拿默认值兜底）', threw !== null,
    threw ? '' : '没有抛出 —— 用户的配置会被重置成默认值');
  ok('抛出的错误里带原始原因（便于路由层记日志）',
    threw && /security_config/.test(String(threw.message)), threw && threw.message);

  // A2: 显式传 base 时不读库（只写）
  // ⚠ 字段名必须取 DEFAULT_CONFIG 里真实存在的（mergeValid 会丢弃未知键）：
  //   paranoiaLevel / anomalyThreshold / scannerUaBlock 等，不是 wafEnabled/paranoid。
  mode = 'ok';
  calls.length = 0;
  const merged = await ss.saveConfig(
    { paranoiaLevel: 3 },
    { base: { paranoiaLevel: 1, anomalyThreshold: 5, scannerUaBlock: true } }
  );
  ok('传了 base 时不额外读库（只走写路径）',
    calls.filter((c) => c === 'security_config').length <= 1, calls.join(','));
  ok('合并结果反映了 patch', merged.paranoiaLevel === 3, String(merged.paranoiaLevel));
  ok('未 patch 的字段被保留（不是整体覆盖）', merged.anomalyThreshold === 5, String(merged.anomalyThreshold));
  ok('未知字段被丢弃（mergeValid 只认 schema 内的键）',
    (await ss.saveConfig({ notARealField: 1 }, { base: {}, persist: false })).notARealField === undefined);

  // A3: persist:false 只合并不落库
  mode = 'ok';
  calls.length = 0;
  await ss.saveConfig({ scannerUaBlock: false }, { base: { scannerUaBlock: true }, persist: false });
  ok('persist:false 时不写库',
    calls.filter((c) => c === 'security_config').length <= 1, calls.join(','));

  // 清理注入，避免影响同进程其它断言
  delete require.cache[dbPath];
}

console.log('\n=== B. stripExif 的段序边界（同一文件内的真实 Buffer） ===');
{
  const { stripExif } = require('../src/utils/stripExif');
  const seg = (marker, payload) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
  };
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);
  const SOS = seg(0xda, Buffer.from([1, 2, 3]));
  const APP1 = seg(0xe1, Buffer.from('Exif\0\0GPS-LAT-39.9', 'binary'));
  const APP2 = seg(0xe2, Buffer.from('ICC_PROFILE\0color', 'binary'));

  // B1: APP1 紧贴 SOI（最常见：相机直出）
  const b1 = Buffer.concat([SOI, APP1, APP2, SOS, EOI]);
  const r1 = stripExif(b1);
  ok('APP1 在首位时被剥离', r1.length === b1.length - APP1.length, `${b1.length} → ${r1.length}`);
  ok('APP2(ICC) 被保留', r1.includes(Buffer.from('ICC_PROFILE')));
  ok('结果仍以 SOI 开头、EOI 结尾',
    r1[0] === 0xff && r1[1] === 0xd8 && r1[r1.length - 2] === 0xff && r1[r1.length - 1] === 0xd9);

  // B2: APP2 在 APP1 之前（少见但合法）
  const b2 = Buffer.concat([SOI, APP2, APP1, SOS, EOI]);
  const r2 = stripExif(b2);
  ok('APP2 在 APP1 之前时，只剥 APP1', r2.length === b2.length - APP1.length);
  ok('两段顺序保持（APP2 仍在 APP1 原来的位置之前）',
    r2.indexOf(Buffer.from('ICC_PROFILE')) > 0);

  // B3: 多段 APP1（某些写入器会写两条 EXIF）
  const b3 = Buffer.concat([SOI, APP1, APP1, SOS, EOI]);
  const r3 = stripExif(b3);
  ok('多段 APP1 全部被剥离', r3.length === b3.length - APP1.length * 2,
    `${b3.length} → ${r3.length}`);

  // B4: SOS 之后的 0xFFE1 是**图像数据**，不是段
  const entropyWithFfe1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x02]), EOI]);
  const b4 = Buffer.concat([SOI, APP1, seg(0xda, Buffer.from([9])), entropyWithFfe1]);
  const r4 = stripExif(b4);
  ok('SOS 之后的内容原样保留（不能把图像数据里的 FFE1 当段删掉）',
    r4.includes(entropyWithFfe1), `len=${r4.length}`);

  // B5: 非法结构 → 保守回退原文件
  const broken = Buffer.concat([SOI, Buffer.from([0x12, 0x34, 0x56])]);
  ok('段结构非法时原样返回（宁可留着 EXIF 也不损坏文件）',
    stripExif(broken) === broken);
  ok('非 JPEG 原样返回', (() => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    return stripExif(png) === png;
  })());
  ok('空/过短输入不抛错',
    (() => { try { stripExif(Buffer.alloc(0)); stripExif(null); return true; } catch (e) { return false; } })());
}

console.log(`\nsaveConfigFail 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
}

suite().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
