#!/usr/bin/env node
/**
 * 安全测试运行器：重置封禁 → 重启服务 → 跑测试
 * 用法: node test/run.js [单个套件名]
 *   TEST_NO_RESTART=1 跳过服务重启（复用已在运行的服务，仅清库）
 *   TEST_SKIP_WAIT=1   跳过启动等待
 *
 * 退出码契约（CI 判红绿的唯一依据）：
 *   0 = 全部套件通过，且清库 / 启动 / 就绪探针都正常
 *   1 = 任意套件失败、清库失败、端口被占用、服务未就绪
 * 失败一律写 process.exitCode，不用 process.exit(1) 硬切 —— 留给 finally 收尾清理。
 */
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const serverDir = path.join(__dirname, '..');
const LOG_PATH = path.join(serverDir, 'test-run.log');

// 与 src/config.js 共用同一套 DB_* / PORT：测试清库必须清「服务真正连的那个库」。
// 旧实现把库名写死 xalor_blog、账号写死 root 无密码，配置一改就变成
// 「清库成功但清的是另一个库」，而这层错配正好被吞掉的 catch 盖住。
try {
  require('dotenv').config({ path: path.join(serverDir, '.env') });
} catch (e) {
  // 没有 dotenv/.env 时走下面的默认值；不影响清库，只是少了 .env 里的覆盖
}
const DB_NAME = process.env.DB_NAME || 'xalor_blog';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

/**
 * 安全护栏：**这 16 个套件会写库**（见下面 RESET_SQL —— DELETE ip_bans / 清本机评论 /
 * UPDATE users.totp_*，journey 套件还会建文章、发留言）。它们历史上挂在 `test:all` 上，
 * 而那条命令默认指向生产库 —— 一次误跑就清掉真实数据。
 *
 * 所以库名必须显式表明「这是一次性库」：以 `_scratch` 结尾才允许跑。
 * 真要跑在别的库上，必须自己写 TEST_ALLOW_NON_SCRATCH=1，把风险显式接过来。
 */
const SCRATCH_REQUIRED = !/_scratch(?:\d+)?$/i.test(DB_NAME);
if (SCRATCH_REQUIRED && String(process.env.TEST_ALLOW_NON_SCRATCH || '') !== '1') {
  console.error('[test:integration] 拒绝执行：DB_NAME = ' + DB_NAME + ' 看起来不是一次性库。');
  console.error('  这些套件会 DELETE/UPDATE 真实数据（ip_bans / users.totp_* / comments / links）。');
  console.error('  正确用法：DB_NAME=xalor_blog_scratch npm run test:all');
  console.error('  非要用别的库：TEST_ALLOW_NON_SCRATCH=1（请先备份）。');
  process.exit(1);
}

const SERVER_WAIT_MS = 20000;   // 等服务就绪的上限
const PORT_RELEASE_MS = 10000;  // 杀掉自己起的子进程后等端口释放的上限

// mysql 客户端：优先 MYSQL_BIN 环境变量，其次 PATH 探测（macOS/Linux/Windows 通用）
function resolveMysql() {
  if (process.env.MYSQL_BIN) return process.env.MYSQL_BIN;
  try {
    const which = process.platform === 'win32' ? 'where mysql' : 'command -v mysql';
    return execSync(which, { timeout: 5000 }).toString().trim().split(/\r?\n/)[0];
  } catch (e) {
    return 'mysql';
  }
}
const MYSQL = resolveMysql();

// 套件间的环境隔离 SQL：
// - ip_bans：持久化封禁跨重启存在
// - users.totp_*：2FA 套件异常中断会残留 totp_enabled，导致后续登录全要验证码
// - comments/messages：清掉本机测试留言，避免重复内容检测与列表断言相互污染
// - links：journey 套件每次申请同一个 https://example.com，links.js 的
//   「防重复申请」会拦下上一次遗留的 pending 记录（400），必须一并清掉
const RESET_SQL = [
  'DELETE FROM ip_bans',
  'UPDATE users SET totp_secret = NULL, totp_enabled = false',
  "DELETE FROM comments WHERE ip IN ('::1', '127.0.0.1', '::ffff:127.0.0.1')",
  "DELETE FROM messages WHERE ip IN ('::1', '127.0.0.1', '::ffff:127.0.0.1')",
  "DELETE FROM links WHERE url = 'https://example.com'",
  // 手记：notes 套件会自建自删，这里兜底清掉异常中断留下的测试数据
  "DELETE FROM notes WHERE content LIKE '%[NOTETEST]%'",
].join('; ');

/** 环境级失败：不跑（或不再跑）套件，直接以退出码 1 结束，避免在坏环境里得出误导性结论 */
class EnvError extends Error {}

let spawnedPid = null;      // 只追踪本脚本自己 spawn 的服务进程
let childFailure = '';      // 子进程的 error / 提前退出原因，用于就绪超时的报错
const failedSuites = [];    // [{ suite, reason }]
const ranSuites = [];
let envFailure = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================== 清库 ==================== */

/**
 * 清库。失败不再静默：打印原因并抛 EnvError（外层置 process.exitCode = 1）。
 * 口令走 MYSQL_PWD 而不是命令行，避免 ps/日志里出现明文。
 */
function resetDb(label) {
  const cmd = `"${MYSQL}" -h "${DB_HOST}" -u "${DB_USER}" "${DB_NAME}" -e "${RESET_SQL}"`;
  const env = { ...process.env };
  if (DB_PASSWORD) env.MYSQL_PWD = DB_PASSWORD;
  console.log(`[run] ${label}清库：$ ${cmd}`);
  try {
    execSync(cmd, { cwd: serverDir, env, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = String((e.stderr && e.stderr.toString()) || '').trim().split('\n').slice(0, 3).join(' | ');
    // 不要复用 e.message：execSync 会把整条命令（含长 SQL）塞进首行，淹掉真正的错误
    const status = typeof e.status === 'number' ? `mysql 退出码 ${e.status}` : String(e.message).split('\n')[0];
    throw new EnvError(
      `清库失败（库 ${DB_NAME} / 账号 ${DB_USER} @ ${DB_HOST}，${status}）` +
      (stderr ? `：${stderr}` : '') +
      ' —— 检查 server/.env 的 DB_* 与 mysql 客户端（MYSQL_BIN）'
    );
  }
}

/* ==================== 服务进程（只动自己 spawn 的那个） ==================== */

/** 杀掉本脚本上一轮 spawn 的进程。按端口扫杀会连开发者自己的 npm run dev 一起打死，已移除 */
function killSpawned() {
  if (!spawnedPid) return;
  const pid = spawnedPid;
  spawnedPid = null;
  try { process.kill(pid, 'SIGKILL'); } catch (e) { /* 已退出 */ }
  console.log(`[run] 已停止本脚本启动的服务进程 (pid ${pid})`);
}

/** 端口是否有人在听 */
function probePort(timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (listening) => { socket.destroy(); resolve(listening); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 等端口释放（只在本脚本刚杀掉自己的子进程时需要几十毫秒） */
async function waitPortFree(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (await probePort()) {
    if (Date.now() > deadline) {
      throw new EnvError(
        `端口 ${PORT} 在 ${deadlineMs}ms 内未释放。本脚本只会杀自己 spawn 的进程，` +
        '请先手动停掉占用该端口的进程（例如 npm run dev / 残留的 node src/server.js）再跑测试'
      );
    }
    await sleep(200);
  }
}

/**
 * 启动服务：先确认端口干净（被占用就报错让人类决定，不替你杀进程），
 * 再 spawn 并把日志句柄交给子进程。
 */
async function startServer() {
  const hadChild = Boolean(spawnedPid);
  killSpawned();
  childFailure = '';
  // 只有刚刚杀掉自己的孩子时才需要等端口释放（几十毫秒）；
  // 否则直接探测：端口被别人占着就报错，而不是先干等 10 秒
  if (hadChild) await waitPortFree(PORT_RELEASE_MS);
  if (await probePort()) {
    throw new EnvError(
      `端口 ${PORT} 已被占用：请先停掉占用进程（例如开发者自己的 npm run dev）再跑测试 —— ` +
      '本脚本不再按端口扫杀进程，避免误杀你的开发服务'
    );
  }

  const out = fs.openSync(LOG_PATH, 'a');
  let child;
  try {
    child = spawn('node', ['src/server.js'], {
      cwd: serverDir,
      detached: true,
      // 不要把口令写死在测试脚本里：config.js 会拒绝 <16 字符的 DB_PASSWORD，
      // 旧的 'xalorblog123' 兜底会让服务启动即崩（表现为连不上 3000 的超时）。
      // 这里只透传外部环境变量，未设置时由 src/config.js 的 dotenv 读 server/.env。
      env: { ...process.env },
      stdio: ['ignore', out, out],
    });
    // 先挂监听再放句柄：否则子进程启动失败时的 'error' 会变成未捕获异常
    child.once('error', (e) => { childFailure = `spawn 失败：${e.message}`; });
    child.once('exit', (code, signal) => {
      if (spawnedPid === child.pid) {
        childFailure = `服务进程已退出（code=${code} signal=${signal}），详见 ${LOG_PATH}`;
      }
    });
  } finally {
    // spawn 返回之后父进程不再需要这个写句柄：子进程已继承（stdio 里的 out），
    // 关掉父进程这一份不影响它继续写日志。不关则每次重启泄漏一个 fd
    // （一轮 16+ 次重启就是 16+ 个，实测关掉前 14 个 fd / 关掉后 13 个）。
    fs.closeSync(out);
  }

  if (!child.pid) throw new EnvError(`node src/server.js 启动失败：${childFailure || 'spawn 未返回 pid'}`);
  child.unref();
  spawnedPid = child.pid;
  console.log(`[run] 已启动服务 (pid ${spawnedPid})，日志：${LOG_PATH}`);
  return spawnedPid;
}

/**
 * 等服务就绪：只认 2xx/3xx。
 * 旧实现只要求「拿到响应」就算就绪，于是数据库未迁移/配置缺失时
 * /api/health 照样回 5xx 也打印「服务就绪」，后续套件在坏环境里给出误导性结论。
 * /api/health/ready 会做 SELECT 1，DB 不可用时返回 503。
 */
function waitServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + SERVER_WAIT_MS;
    const attempt = () => {
      if (Date.now() > deadline) {
        return reject(new EnvError(
          `服务在 ${SERVER_WAIT_MS}ms 内未就绪${childFailure ? `（${childFailure}）` : ''}；` +
          `日志：${LOG_PATH}`
        ));
      }
      const req = http.get(
        { host: '127.0.0.1', port: PORT, path: '/api/health/ready', timeout: 3000, headers: { 'User-Agent': 'xalor-test-runner/1.0' } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
              console.log(`[run] 服务就绪（/api/health/ready ${res.statusCode}）`);
              return resolve();
            }
            const snippet = (body || '').replace(/\s+/g, ' ').slice(0, 200);
            return reject(new EnvError(
              `/api/health/ready 返回 ${res.statusCode}（期望 200，2xx/3xx 才算就绪）：${snippet}`
            ));
          });
        }
      );
      req.on('error', () => setTimeout(attempt, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(attempt, 500); });
    };
    attempt();
  });
}

/* ==================== 环境准备 / 套件执行 ==================== */

async function prepareEnvironment(label) {
  resetDb(label);
  if (!process.env.TEST_NO_RESTART) await startServer();
  if (!process.env.TEST_SKIP_WAIT) await waitServer();
}

function describeSuiteFailure(e, timeoutMs) {
  if (e && e.signal) return `超过 ${timeoutMs}ms 被终止（${e.signal}）`;
  if (e && typeof e.status === 'number') return `退出码 ${e.status}`;
  return String((e && e.message) || e).split('\n')[0];
}

/**
 * 检测「磁盘上有、但两条链都没登记」的测试文件。
 *
 * 背景：本目录有两种测试——
 *   - 离线套件：`npm test` 逐个跑（40 个，零外部依赖）
 *   - 集成套件：本文件的 `suites` 列表（需要 MySQL + 已启动服务，由 `npm run test:all` 跑）
 *
 * `suites` 是**硬编码**的（顺序有意义：admin 冒烟要干净 IP，security 会触发封禁必须垫底；
 * 且 security/2fa 需要更长的超时）。硬编码本身没问题，问题是它**不会自我校验**：
 * 新写一个集成测试忘了加进来，它就永远不会被执行，而且没有任何提示 ——
 * 这正是「静默失败」的另一个形态，只不过发生在测试基础设施上。
 *
 * 所以这里反向扫一遍：凡是不在 `suites` 里、又不在 `npm test` 链里的 `*.test.js`，
 * 都算孤儿并报警。不直接 fail（那会让 `test:all` 因为一个待补的文件整体红），
 * 但把退出码置 1 —— 让 CI/人一眼看到。
 */
function warnOrphanSuites(registered) {
  let fs;
  let path;
  try {
    fs = require('fs');
    path = require('path');
  } catch (e) {
    return;
  }
  const offline = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
    for (const m of String(pkg.scripts.test || '').matchAll(/node test\/([\w.-]+\.test\.js)/g)) {
      offline.add(m[1]);
    }
  } catch (e) {
    // 读不到 package.json 就不做判断，避免把工具问题变成假警报
    return;
  }
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(path.join(serverDir, 'test'))
      .filter((f) => f.endsWith('.test.js'));
  } catch (e) {
    return;
  }
  const registeredSet = new Set(registered);
  const orphans = onDisk.filter((f) => !registeredSet.has(f) && !offline.has(f));
  if (orphans.length) {
    console.error('\n[run] ⚠ 以下测试文件既不在离线链（npm test）也不在本文件的 suites 列表里，永远不会被执行：');
    for (const f of orphans) console.error(`         test/${f}`);
    console.error('[run]   把它们加进 test/run.js 的 suites，或加进 package.json 的 test 链。');
    process.exitCode = 1;
  }
}

async function runTests() {
  // 默认依次执行：admin 冒烟（干净 IP 必需）→ 2FA 端到端 → 安全回归（末尾触发封禁）
  // 传参可指定单个文件：node test/run.js security.test.js
  const suites = process.argv[2]
    ? [process.argv[2]]
    : ['admin.test.js', '2fa.test.js', 'session.test.js', 'lockout.test.js', 'journey.test.js', 'waf.test.js', 'falsePositive.test.js', 'requestGuard.test.js', 'likeGuard.test.js', 'sanitize.test.js', 'feed.test.js', 'scrapeGuard.test.js', 'contentCrypto.test.js', 'browserCrypto.test.js', 'notes.test.js', 'security.test.js'];

  if (!process.argv[2]) warnOrphanSuites(suites);

  for (let i = 0; i < suites.length; i++) {
    const s = suites[i];
    // 首个套件沿用 main() 已准备好的环境；其余套件前重置服务：
    // 隔离信誉积分/限流窗口/票据内存状态（2fa/lockout 会留下认证失败积分与持久化封禁）
    if (i > 0) {
      console.log('[run] 重置环境（清库 + 重启服务）…');
      await prepareEnvironment(`${s} 前`);
      // 等待服务初始化及配置加载完成
      await sleep(500);
    }

    console.log(`\n========== 运行 ${s} ==========`);
    const timeoutMs = s === 'security.test.js' || s === '2fa.test.js' ? 240000 : 60000;
    ranSuites.push(s);
    try {
      execSync(`node test/${s}`, { stdio: 'inherit', cwd: serverDir, timeout: timeoutMs });
      console.log(`[run] ✓ ${s} 通过`);
    } catch (e) {
      const reason = describeSuiteFailure(e, timeoutMs);
      failedSuites.push({ suite: s, reason });
      console.error(`[run] ✗ ${s} 失败（${reason}），退出码将由收尾统一置 1`);
    }
  }
}

/* ==================== 收尾与汇总 ==================== */

async function cleanupAfterRun() {
  // 收尾清理：security 套件（通常最后一个）会把 127.0.0.1 持久化封禁进 ip_bans，
  // 不清会导致测试结束后本地站整站 403，且封禁在 DB、重启服务也无法恢复。
  // 顺带清掉 2FA 残留与本机测试留言，把环境还原到可直接 npm run dev 的状态。
  //
  // 顺序很重要：先停掉本脚本起的服务，再清库 —— 反过来的话，服务里还没 flush 的
  // 信誉持久化队列会在清库之后把封禁重新写回 ip_bans。
  // 收尾不再"再起一个服务留在 3000 上"：那会让下一次 npm run test:all 一启动就
  // 报"端口被占用"，而且要留给开发者的本来就是干净的 3000（自己 npm run dev）。
  console.log('\n[run] 收尾：停止测试服务 + 清库（清掉末尾套件遗留的持久化封禁）…');
  try {
    const hadChild = Boolean(spawnedPid);
    killSpawned();
    // 只等自己那个进程让出端口；TEST_NO_RESTART 下端口是你的服务在用，不能等
    if (hadChild) await waitPortFree(PORT_RELEASE_MS);
    resetDb('收尾');
    console.log(hadChild ? `[run] 测试服务已停止，端口 ${PORT} 已交还（本地开发请 npm run dev）` : `[run] 未动你自启的服务（TEST_NO_RESTART）`);
  } catch (e) {
    // 收尾失败同样是「环境坏」，退出码必须为 1，但不能盖掉套件结果
    console.error(`[run] 收尾失败：${e.message}`);
    if (!(e instanceof EnvError)) throw e;
    envFailure = envFailure || `收尾失败：${e.message}`;
  }
}

function printSummary() {
  const failed = failedSuites.length;
  console.log('\n================ 测试汇总 ================');
  console.log(`套件 ${ranSuites.length} 个，通过 ${ranSuites.length - failed}，失败 ${failed}`);
  for (const f of failedSuites) console.log(`  ✗ ${f.suite} → ${f.reason}`);
  if (envFailure) console.log(`  ✗ 环境 → ${envFailure}`);
  console.log(`${failed} 个套件失败`);
  console.log(envFailure ? '结论：红（环境失败）' : failed ? '结论：红（套件失败）' : '结论：绿');
}

async function bootstrap() {
  try {
    await prepareEnvironment('启动前');
    await runTests();
  } catch (e) {
    envFailure = e instanceof EnvError ? e.message : `运行器异常：${(e && e.stack) || e}`;
    console.error(`[run] ${envFailure}`);
  } finally {
    try {
      await cleanupAfterRun();
    } catch (e) {
      console.error('[run] 收尾异常:', (e && e.stack) || e);
      envFailure = envFailure || `收尾异常：${(e && e.message) || e}`;
    }
  }

  printSummary();
  if (failedSuites.length > 0 || envFailure) process.exitCode = 1;
}

bootstrap().catch((e) => {
  console.error('[run] 运行器异常:', e);
  process.exitCode = 1;
});
