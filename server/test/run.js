#!/usr/bin/env node
/**
 * 安全测试运行器：重置封禁 → 重启服务 → 跑测试
 * 用法: node test/run.js
 *   TEST_NO_RESTART=1 跳过服务重启（仅清库）
 *   TEST_SKIP_WAIT=1   跳过启动等待
 */
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const serverDir = path.join(__dirname, '..');
const MYSQL = 'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysql.exe';

function run(cmd) {
  console.log(`$ ${cmd}`);
  try {
    return execSync(cmd, { cwd: serverDir, timeout: 15000 }).toString();
  } catch (e) {
    console.error('[run] 命令失败:', e.message.split('\n')[0]);
    return '';
  }
}

async function main() {
  // 1. 清空封禁表 + 重置 TOTP 状态（内存封禁随重启消失；DB 持久化封禁在此清除；
  //    2FA 测试异常中断会残留 totp_enabled，导致后续登录全部需要验证码）
  run(`"${MYSQL}" -u root xalor_blog -e "DELETE FROM ip_bans; UPDATE users SET totp_secret = NULL, totp_enabled = false; DELETE FROM comments WHERE ip IN ('::1', '127.0.0.1', '::ffff:127.0.0.1'); DELETE FROM messages WHERE ip IN ('::1', '127.0.0.1', '::ffff:127.0.0.1');"`);

  // 2. 重启服务（内存封禁权威）
  if (!process.env.TEST_NO_RESTART) {
    restartServer();
  }

  // 3. 等待服务就绪后依次运行套件
  if (!process.env.TEST_SKIP_WAIT) {
    await waitServer();
  }
  await runTests();
}

function restartServer() {
  try {
    const portPid = execSync('netstat -ano | findstr :3000 | findstr LISTENING', { timeout: 5000 })
      .toString().trim().split(/\s+/).pop();
    if (portPid && /^\d+$/.test(portPid)) {
      execSync(`taskkill /F /PID ${portPid}`, { stdio: 'ignore', timeout: 5000 });
    }
  } catch (e) { /* 无旧进程 */ }
  const out = fs.openSync(path.join(serverDir, 'test-run.log'), 'a');
  const child = spawn('node', ['src/server.js'], { cwd: serverDir, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  return child.pid;
}

function waitServer() {
  return new Promise((resolve) => {
    const http = require('http');
    const deadline = Date.now() + 15000;
    const wait = () => {
      if (Date.now() > deadline) { console.error('[run] 服务启动超时'); resolve(); return; }
      const r = http.get('http://127.0.0.1:3000/api/health', (res) => {
        res.resume();
        console.log('[run] 服务就绪');
        resolve();
      });
      r.on('error', () => setTimeout(wait, 500));
      r.setTimeout(3000, () => { r.destroy(); setTimeout(wait, 500); });
    };
    wait();
  });
}

async function runTests() {
  // 默认依次执行：admin 冒烟（干净 IP 必需）→ 2FA 端到端 → 安全回归（末尾触发封禁）
  // 传参可指定单个文件：node test/run.js security.test.js
  const suites = process.argv[2]
    ? [process.argv[2]]
    : ['admin.test.js', '2fa.test.js', 'session.test.js', 'lockout.test.js', 'journey.test.js', 'waf.test.js', 'requestGuard.test.js', 'likeGuard.test.js', 'sanitize.test.js', 'feed.test.js', 'scrapeGuard.test.js', 'contentCrypto.test.js', 'security.test.js'];
  for (const s of suites) {
    // 套件间重启服务：隔离信誉积分/限流窗口/票据内存状态
    // （2fa/lockout 套件会留下认证失败积分与持久化封禁，不隔离会污染后续套件）
    console.log(`[run] 重置环境（清库 + 重启服务）…`);
    run(`"${MYSQL}" -u root xalor_blog -e "DELETE FROM ip_bans; UPDATE users SET totp_secret = NULL, totp_enabled = false; DELETE FROM comments WHERE ip IN ('::1', '127.0.0.1', '::ffff:127.0.0.1'); DELETE FROM messages WHERE ip IN ('::1', '127.0.0.1', '::ffff:127.0.0.1');"`);
    restartServer();
    await waitServer();
    console.log(`\n========== 运行 ${s} ==========`);
    try {
      execSync(`node test/${s}`, { stdio: 'inherit', cwd: serverDir });
    } catch (e) {
      // 测试失败退出码 1：保留输出继续下一套件
    }
  }
}

main().catch((e) => { console.error('[run] 运行器异常:', e); process.exit(1); });
