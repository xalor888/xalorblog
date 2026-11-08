/**
 * 点赞防刷单元测试（无服务依赖：直接驱动 canLike）
 *
 * 背景：点赞防刷键只含 IP + 文章 id —— X-Fp 只是格式校验的字符串，脚本可任意
 * 轮换（换 fp 即获新键，旧实现 `ip:fp:articleId` 键被 fp 轮换完全绕过）。
 * HTTP 集成断言（security.test.js 10c）覆盖成功/429 形态；本套件直测键语义：
 * 同 IP 同文章窗口内第二次被拒、不同文章/不同 IP 互不影响、窗口过期后恢复。
 *
 * 关于「换指纹仍受限」：canLike 只有 (ip, articleId) 两个形参，指纹根本不参与键。
 * 旧断言写成「换指纹仍受限」却仍只传 (ip, articleId)，等于把同一句话说了两遍、
 * 恒真且什么都没证明。这里改为直接锁契约本身（形参个数）+ 真实行为。
 *
 * 窗口过期用「注入时钟」验证：canLike 的过期判断读 Date.now()，本套件是纯同步
 * 单元测试，没有 await/定时器，因此临时替换 Date.now 后立刻在 finally 里还原，
 * 不会污染同进程里其他任何计时（也比等 10 秒真实窗口快得多）。
 */
const { canLike, LIKE_WINDOW } = require('../src/routes/articles');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function suite() {
  console.log('=== 点赞防刷键语义（canLike 单元） ===');

  // 契约：键只有 (ip, articleId) 两个维度，X-Fp 不参与 —— 指纹是客户端可任意轮换的字符串
  assert(
    'canLike 只接受 (ip, articleId) 两个参数（指纹不参与防刷键，换 fp 无从绕过）',
    canLike.length === 2,
    `canLike.length=${canLike.length}`
  );

  const ip = '203.0.113.7';
  const aid = 42;

  // 首次点赞放行
  assert('首次点赞放行', canLike(ip, aid) === true);

  // 窗口内同 IP 同文章再赞 → 受限（键不含 fp，客户端换什么都没用）
  assert('同 IP 同文章窗口内第二次被拒', canLike(ip, aid) === false);
  assert('同 IP 同文章窗口内连续调用仍被拒（未被重复写入延长）', canLike(ip, aid) === false);

  // 不同文章独立窗口
  assert('不同文章独立窗口（可赞）', canLike(ip, aid + 1) === true);

  // 不同 IP 不受同 IP 键影响（家庭 NAT 多设备场景）
  assert('不同 IP 互不影响', canLike('198.51.100.9', aid) === true);

  // ---- 窗口过期后恢复：注入时钟，推进到窗口边界前后各测一次 ----
  console.log('--- 窗口过期（注入 Date.now，仅本段） ---');
  assert(
    '前置：LIKE_WINDOW 是正数（过期断言的算术前提）',
    Number.isFinite(LIKE_WINDOW) && LIKE_WINDOW > 0,
    `LIKE_WINDOW=${LIKE_WINDOW}`
  );

  const realNow = Date.now;
  const t0 = 1700000000000; // 固定基点：不依赖真实时间，结果可复现
  const expIp = '203.0.113.11';
  const expAid = 7;
  try {
    Date.now = () => t0;
    assert('窗口起点可赞', canLike(expIp, expAid) === true);

    Date.now = () => t0 + LIKE_WINDOW - 1;
    assert('窗口内最后一毫秒仍被拒', canLike(expIp, expAid) === false);

    Date.now = () => t0 + LIKE_WINDOW + 1;
    assert('窗口过期后恢复（可再次点赞）', canLike(expIp, expAid) === true);
    assert('恢复后立即再赞又被拒（新窗口已开始）', canLike(expIp, expAid) === false);
  } finally {
    Date.now = realNow; // 绝不污染同进程后续任何计时
  }
  assert('时钟已还原（Date.now 是原生实现）', Date.now === realNow);

  console.log(`\nlikeGuard 套件结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error(failures.join('\n')); process.exit(1); }
}

suite().catch((e) => { console.error('套件异常:', e); process.exit(1); });
