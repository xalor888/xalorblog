#!/usr/bin/env node
/**
 * 手动环境重置：清封禁/TOTP/测试评论 → 重启服务 → 等待就绪
 * 用法: node test/reset-env.js
 * 用途：run.js 之外手动调试前的环境准备
 */
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const serverDir = path.join(__dirname, '..');
const MYSQL = 'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysql.exe';

try {
  execSync(`"${MYSQL}" -u root xalor_blog -e "DELETE FROM ip_bans; UPDATE users SET totp_secret = NULL, totp_enabled = false; DELETE FROM comments WHERE ip = '::1';"`, { timeout: 15000 });
  console.log('[reset] 已清空封禁/TOTP/测试评论');
} catch (e) {
  console.error('[reset] 清理失败:', e.message.split('\n')[0]);
}

try {
  const pid = execSync('netstat -ano | findstr :3000 | findstr LISTENING', { timeout: 5000 })
    .toString().trim().split(/\s+/).pop();
  if (pid && /^\d+$/.test(pid)) {
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
    console.log('[reset] 已停止旧服务 pid=' + pid);
  }
} catch (e) { /* 无旧进程 */ }

const out = fs.openSync(path.join(serverDir, 'server-run.log'), 'a');
const child = spawn('node', ['src/server.js'], { cwd: serverDir, detached: true, stdio: ['ignore', out, out] });
child.unref();
console.log('[reset] 服务已重启 pid=' + child.pid);

// 等待就绪
const http = require('http');
const deadline = Date.now() + 15000;
const wait = () => {
  if (Date.now() > deadline) { console.error('[reset] 服务启动超时'); process.exit(1); }
  const r = http.get('http://localhost:3000/api/health', (res) => {
    res.resume();
    console.log('[reset] 服务就绪 ✓');
  });
  r.on('error', () => setTimeout(wait, 500));
  r.setTimeout(3000, () => { r.destroy(); setTimeout(wait, 500); });
};
wait();
