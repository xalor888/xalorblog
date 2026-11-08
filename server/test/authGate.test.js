/**
 * 鉴权闸门的每一条拒绝分支（零真实 DB）。
 *
 * `authRequired` 是全站唯一的入口校验：JWT + 设备指纹 + 服务端会话三重。
 * 它有 10 个拒绝出口，任何一条**写反**都是安全事故 —— 而且写反之后功能看起来完全正常
 * （登录、发文章、改设置全都照常），只有攻击者知道门开着。
 *
 * 这个文件此前是零测试（`grep -rl middleware/auth test/` 为空）。
 *
 * 做法：用 `require.cache` 注入一个可编程的 db 替身，然后**真调 `authRequired`** ——
 * 不是源码文本断言，是真的走分支、看返回的状态码与文案。
 * 每个分支都断言「状态码 + 消息关键词」两个维度：只断状态码的话，
 * 把「会话已注销」写成「会话不存在」这种细化错误就查不出来。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

// 预期噪音：fail-closed 分支会 console.error（「会话查询异常，拒绝请求」等）。
// 那几行正是这些分支**该有的行为**，不是测试失败 —— exit code 不受影响。

const path = require('path');
const jwt = require('jsonwebtoken');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const FP = 'a'.repeat(64);            // 合法指纹形态（64 位 hex）
const FP2 = 'b'.repeat(64);
const USER = { id: 7, username: 'admin', nickname: '站长', role: 'admin' };

/** 可编程 db 替身：控制表是否存在、会话行、用户行、是否抛错 */
const dbState = {
  sessionsTable: true,
  sessionRow: null,
  userRow: null,
  hasTableThrows: false,
  sessionQueryThrows: false,
  userQueryThrows: false,
  calls: [],
};

function makeStubDb() {
  const query = (table) => {
    dbState.calls.push(table);
    const q = {
      where: () => q,
      select: () => q,
      first: () => {
        if (table === 'sessions') {
          if (dbState.sessionQueryThrows) return Promise.reject(new Error('模拟会话查询失败'));
          return Promise.resolve(dbState.sessionRow);
        }
        if (table === 'users') {
          if (dbState.userQueryThrows) return Promise.reject(new Error('模拟用户查询失败'));
          return Promise.resolve(dbState.userRow);
        }
        return Promise.resolve(null);
      },
    };
    return q;
  };
  query.schema = {
    hasTable: () => {
      if (dbState.hasTableThrows) return Promise.reject(new Error('模拟 hasTable 失败'));
      return Promise.resolve(dbState.sessionsTable);
    },
  };
  return query;
}

// 注入 stub 后再 require auth（它顶层就 require('../db')）
const dbPath = require.resolve('../src/db');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeStubDb() };
delete require.cache[require.resolve('../src/middleware/auth')];

const config = require('../src/config');
const { authRequired, signToken } = require('../src/middleware/auth');

/** 造一个合法 token（claims 与 signToken 一致） */
function makeToken(overrides = {}) {
  const payload = {
    sub: String(USER.id),
    jti: 'jti-test',
    iss: 'xalor-blog',
    aud: 'xalor-web',
    fp: FP,
    username: USER.username,
    role: USER.role,
    nickname: USER.nickname,
    ...overrides,
  };
  return jwt.sign(payload, config.jwt.secret, { expiresIn: '2h' });
}

/** 构造 req/res/next */
function makeCtx({ token, fp = FP, noHeader = false } = {}) {
  const out = { status: null, body: null, nextCalled: false };
  const headers = {};
  if (!noHeader) headers.authorization = `Bearer ${token}`;
  if (fp !== null) headers['x-fp'] = fp;
  const req = { headers, ip: '127.0.0.1' };
  const res = {
    status(code) { out.status = code; return res; },
    json(payload) { out.body = payload; return res; },
  };
  const next = () => { out.nextCalled = true; };
  return { req, res, out, next };
}

/** 重置到「一切正常」 */
function resetState() {
  dbState.sessionsTable = true;
  dbState.sessionRow = null;
  dbState.userRow = null;
  dbState.hasTableThrows = false;
  dbState.sessionQueryThrows = false;
  dbState.userQueryThrows = false;
  dbState.calls = [];
}

async function run() {
  console.log('=== A. 通过路径：三重校验全部满足才放行 ===');
  {
    resetState();
    dbState.sessionRow = { jti: 'jti-test', user_id: USER.id, fp: FP, revoked: false, expires_at: new Date(Date.now() + 3600e3) };
    dbState.userRow = USER;
    const c = makeCtx({ token: makeToken() });
    await authRequired(c.req, c.res, c.next);
    check('合法 token + 指纹 + 会话 → 调用 next()', c.out.nextCalled === true, JSON.stringify(c.out));
    check('没有写回任何错误响应', c.out.status === null && c.out.body === null);
    check('req.user 被填充（后续路由依赖它）', c.req.user && c.req.user.sub === String(USER.id));
    check('req.jti 被填充（登出/会话管理依赖它）', c.req.jti === 'jti-test');
    check('req.authed 标记为 true', c.req.authed === true);
    check('role 以**数据库**为准，而不是 JWT 里的旧值',
      c.req.user.role === USER.role);
  }

  console.log('\n=== B. 十个拒绝出口（状态码 + 文案双维度） ===');
  const deny = async (name, ctxOpts, mutate, wantStatus, wantMsg) => {
    resetState();
    mutate();
    const c = makeCtx(ctxOpts);
    await authRequired(c.req, c.res, c.next);
    const msg = (c.out.body && c.out.body.message) || '';
    check(name, c.out.status === wantStatus && msg.includes(wantMsg) && !c.out.nextCalled,
      `status=${c.out.status} msg=${msg}`);
    check(`${name} —— code 恒为 1`, c.out.body && c.out.body.code === 1);
  };

  await deny('① 没有 Authorization 头',
    { token: 'x', noHeader: true }, () => {}, 401, '未登录');

  await deny('② token 无法验证（签名/iss/aud 不对）',
    { token: 'not-a-jwt' }, () => {}, 401, '登录已过期');

  {
    resetState();
    const wrongSig = jwt.sign({ sub: '7', jti: 'j', iss: 'xalor-blog', aud: 'xalor-web', fp: FP }, 'wrong-secret');
    const c = makeCtx({ token: wrongSig });
    await authRequired(c.req, c.res, c.next);
    check('②b 签名错误 → 拒绝（不能只验结构）',
      c.out.status === 401 && !c.out.nextCalled, `status=${c.out.status}`);
  }

  await deny('③ 请求指纹缺失（攻击者去掉 X-Fp 头）',
    { token: makeToken(), fp: null }, () => {}, 401, '登录设备发生变化');

  await deny('④ 请求指纹与 token 里不一致',
    { token: makeToken(), fp: FP2 }, () => {}, 401, '登录设备发生变化');

  await deny('⑤ 会话表不存在 → 503（不许降级为纯 JWT）',
    { token: makeToken() }, () => { dbState.sessionsTable = false; }, 503, '会话服务不可用');

  await deny('⑥ 会话表检查抛错 → fail-closed',
    { token: makeToken() }, () => { dbState.hasTableThrows = true; }, 401, '会话校验失败');

  await deny('⑦ 会话行不存在（已删除/伪造 jti）',
    { token: makeToken() }, () => { dbState.sessionRow = null; }, 401, '会话不存在');

  await deny('⑧ 会话已注销',
    { token: makeToken() }, () => {
      dbState.sessionRow = { jti: 'jti-test', user_id: USER.id, fp: FP, revoked: true, expires_at: new Date(Date.now() + 3600e3) };
    }, 401, '会话已注销');

  await deny('⑨ 会话的 user_id 与 token 的 sub 不一致',
    { token: makeToken() }, () => {
      dbState.sessionRow = { jti: 'jti-test', user_id: 999, fp: FP, revoked: false, expires_at: new Date(Date.now() + 3600e3) };
    }, 401, '会话校验失败');

  await deny('⑩ 会话里的指纹与请求不一致（换了设备）',
    { token: makeToken() }, () => {
      dbState.sessionRow = { jti: 'jti-test', user_id: USER.id, fp: FP2, revoked: false, expires_at: new Date(Date.now() + 3600e3) };
    }, 401, '登录设备发生变化');

  await deny('⑪ 会话已过期（expires_at 在过去）',
    { token: makeToken() }, () => {
      dbState.sessionRow = { jti: 'jti-test', user_id: USER.id, fp: FP, revoked: false, expires_at: new Date(Date.now() - 1000) };
    }, 401, '会话已过期');

  await deny('⑫ 会话查询抛错 → fail-closed',
    { token: makeToken() }, () => { dbState.sessionQueryThrows = true; }, 401, '会话校验失败');

  await deny('⑬ 用户行不存在（注销了但 token 未过期）',
    { token: makeToken() }, () => {
      dbState.sessionRow = { jti: 'jti-test', user_id: USER.id, fp: FP, revoked: false, expires_at: new Date(Date.now() + 3600e3) };
      dbState.userRow = null;
    }, 401, '用户不存在');

  await deny('⑭ 用户查询抛错 → fail-closed',
    { token: makeToken() }, () => {
      dbState.sessionRow = { jti: 'jti-test', user_id: USER.id, fp: FP, revoked: false, expires_at: new Date(Date.now() + 3600e3) };
      dbState.userQueryThrows = true;
    }, 401, '会话校验失败');

  console.log('\n=== C. 降权立即生效（JWT 里的旧 role 不作数） ===');
  {
    resetState();
    dbState.sessionRow = { jti: 'jti-test', user_id: USER.id, fp: FP, revoked: false, expires_at: new Date(Date.now() + 3600e3) };
    dbState.userRow = { ...USER, role: 'reader' }; // 数据库里已降权
    const c = makeCtx({ token: makeToken({ role: 'admin' }) }); // token 里还是 admin
    await authRequired(c.req, c.res, c.next);
    check('放行但 req.user.role 用数据库的 reader（不是 JWT 里的 admin）',
      c.out.nextCalled && c.req.user.role === 'reader', `role=${c.req.user && c.req.user.role}`);
    check('nickname / username 同样以数据库为准',
      c.req.user.username === USER.username && c.req.user.nickname === USER.nickname);
  }

  console.log('\n=== D. signToken：指纹不合法必须在写库之前失败 ===');
  {
    resetState();
    let threw = null;
    try {
      await signToken(USER, { headers: {}, ip: '127.0.0.1' });
    } catch (e) { threw = e; }
    check('缺少 x-fp → 抛错而不是签出一个必然失效的 token', threw !== null);
    check('错误码是 FP_INVALID（调用方可据此返回 400 而不是 500）',
      threw && threw.code === 'FP_INVALID', threw && threw.code);
    check('失败发生在任何 DB 写入之前（没有触达 sessions 表）',
      !dbState.calls.includes('sessions'), dbState.calls.join(','));

    for (const bad of ['short', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      let t = null;
      try { await signToken(USER, { headers: { 'x-fp': bad }, ip: '' }); } catch (e) { t = e; }
      check(`非法指纹「${bad.slice(0, 8)}…」被拒（长度/字符集都要对）`,
        t && t.code === 'FP_INVALID');
    }
  }

  console.log('\n=== E. signToken：会话表不可用必须抛错（不降级） ===');
  {
    resetState();
    dbState.sessionsTable = false;
    let threw = null;
    try { await signToken(USER, { headers: { 'x-fp': FP }, ip: '127.0.0.1' }); } catch (e) { threw = e; }
    check('会话表不存在 → 抛 SESSION_STORE_UNAVAILABLE', threw && threw.code === 'SESSION_STORE_UNAVAILABLE',
      threw && threw.code);
  }

  console.log(`\nauthGate 套件结果: ${passCount} 通过, ${failCount} 失败`);
  if (failCount) process.exit(1);
}

run().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
