const app = require('./app');
const config = require('./config');
const db = require('./db');
const { loadPersistedBans } = require('./middleware/ipGuard');
const { localDateStr } = require('./utils/datetime');

// 仅直接运行时启动服务（npm start / npm run dev）；
// 被其他模块 require 时（如测试/工具脚本）不监听端口
if (require.main !== module) {
  module.exports = app;
} else {
  main().catch((e) => {
    console.error('[startup] 服务启动失败:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

async function main() {
  // 先恢复有效封禁，再监听端口：避免启动瞬间被封禁 IP 乘窗口请求
  await loadPersistedBans();

// 定时清理（每 6 小时一次，unref 不阻止进程退出）：
// 过期会话 / 已撤销超 24h 的会话 / 过期封禁 / 90 天前审计日志 / 2 年前访问明细
setInterval(async () => {
  try {
    const dayAgo = new Date(Date.now() - 24 * 3600e3);
    const auditCutoff = new Date(Date.now() - 90 * 86400e3);
    // 日期边界用本地日期（day 列按本地时区存储；toISOString 是 UTC 日期，
    // +8 服务器下阈值漂移 8 小时 —— 方向保守但仍保持一致性）
    const visitsCutoff = localDateStr(new Date(Date.now() - 730 * 86400e3));
    const [sessExp, sessRev, banDel, auditDel, visitDel, uvDel] = await Promise.all([
      db('sessions').where('expires_at', '<', db.fn.now()).del(),
      db('sessions').where('revoked', true).where('created_at', '<', dayAgo).del(),
      db('ip_bans').where('banned_until', '<', db.fn.now()).del(),
      db('audit_logs').where('created_at', '<', auditCutoff).del(),
      db('visits').where('day', '<', visitsCutoff).del(),
      db('visit_uv').where('day', '<', visitsCutoff).del(),
    ]);
    const total = sessExp + sessRev + banDel + auditDel + visitDel + uvDel;
    if (total) {
      console.log(`[cleanup] 清理过期会话 ${sessExp}、已撤销会话 ${sessRev}、过期封禁 ${banDel}、旧审计 ${auditDel}、旧访问明细 ${visitDel + uvDel}`);
    }
  } catch (e) { /* 数据库不可用时静默跳过 */ }
}, 6 * 3600 * 1000).unref();

const server = app.listen(config.port, () => {
  console.log(`\n  🚀 Xalor的小站 API 已启动: http://localhost:${config.port}`);
  console.log(`  📚 API 前缀: ${config.apiPrefix}（生产建议改为随机字符串）`);
  console.log(`  🗝️ 管理后台路径: /#/${config.adminPath}（秘钥路径，非固定 /admin）`);
  console.log(`  🛡️ 反爬闸门: ${config.isProd ? 'ON (生产)' : 'ON'} · PoW 难度: ${config.security.powDifficulty}\n`);
});

// 慢速攻击 / 空闲连接防护
server.requestTimeout = 20 * 1000;
server.headersTimeout = 15 * 1000;
server.keepAliveTimeout = 5 * 1000;
server.maxHeadersCount = 60;

// 优雅退出：停止接收新连接 → 关闭空闲连接 → 等待在途请求（带超时兜底）→ 释放 DB → 退出
function shutdown(signal) {
  console.log(`\n[shutdown] 收到 ${signal}，正在优雅退出…`);
  server.close(() => {
    db.destroy().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  server.closeIdleConnections?.(); // 关闭 keep-alive 空闲连接，加速 close 完成
  // 兜底：15 秒未完成强制退出（防 DB 无响应卡死进程）
  setTimeout(() => {
    console.error('[shutdown] 超时，强制退出');
    process.exit(1);
  }, 15000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 进程兜底：单点异常仅记录，不让整个 API 进程退出
// （生产建议接入集中日志/监控系统追踪这些事件）
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});
} // main() 结束
