#!/usr/bin/env node
/**
 * 旧数据清理：**审计日志与过期会话/封禁**。
 *
 * 为什么需要：`audit_logs` 是「每次登录、每次后台写操作、每次安全事件」都记一条的表。
 * 本站跑了两周已经 26,220 行，而**没有任何保留策略** —— 它的增长只取决于运行时长。
 * 后果不是崩溃，而是缓慢的：后台安全中心的分页查询越来越慢、备份文件越来越大、
 * 全量导出越来越久。这类表没人会主动清理，所以要有一条能定期跑的命令。
 *
 * 清理三类：
 *   1. `audit_logs` 超过 N 天（默认 90）
 *   2. `sessions` 已过期或已撤销（登录时会顺手清一部分，但漏掉的会沉淀）
 *   3. `ip_bans` 已经过期的封禁记录
 *
 * 安全默认值：
 *   - **默认 dry-run**，只打印将要删除的条数；要真删必须显式 `--apply`
 *   - 真删时要求库名以 `_scratch` 结尾，或显式 `ALLOW_NON_SCRATCH=1`
 *     （与 `test:all` 的护栏同一个思路：这条命令删的是真实数据）
 *
 * 用法：
 *   node scripts/prune-old-data.js                  # 看一眼
 *   node scripts/prune-old-data.js --days 180       # 换保留天数
 *   ALLOW_NON_SCRATCH=1 node scripts/prune-old-data.js --apply
 */

'use strict';

require('dotenv').config();
const path = require('path');

const DAYS_ARG = (() => {
  const i = process.argv.indexOf('--days');
  const n = i > -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) && n >= 7 ? Math.floor(n) : 90;
})();
const APPLY = process.argv.includes('--apply');

const cfg = require(path.join(__dirname, '..', 'src', 'config'));
const DB_NAME = String(cfg.db.database || '');
const SCRATCH = /_scratch(?:[0-9]+)?$/i.test(DB_NAME);
const ALLOW = String(process.env.ALLOW_NON_SCRATCH || '') === '1';

if (APPLY && !SCRATCH && !ALLOW) {
  console.error(`[prune] 拒绝执行：DB_NAME = ${DB_NAME} 不是一次性库，而 --apply 会真删数据。`);
  console.error('  确认要清生产库：ALLOW_NON_SCRATCH=1 node scripts/prune-old-data.js --apply');
  console.error('  （建议先跑一次不带 --apply 的 dry-run，看清条数）');
  process.exit(1);
}

const db = require(path.join(__dirname, '..', 'src', 'db'));

async function main() {
  const cutoff = new Date(Date.now() - DAYS_ARG * 24 * 60 * 60 * 1000);

  const auditOld = await db('audit_logs').where('created_at', '<', cutoff).count('* as c').first();
  const sessionsStale = await db('sessions')
    .where((q) => q.where('revoked', true).orWhere('expires_at', '<', db.fn.now()))
    .count('* as c').first();
  const bansExpired = await db('ip_bans').where('banned_until', '<', db.fn.now()).count('* as c').first();

  const n = (row) => Number((row && row.c) || 0);

  console.log(`[prune] 库=${DB_NAME} 模式=${APPLY ? 'APPLY（真删）' : 'DRY-RUN（只看）'} 保留=${DAYS_ARG} 天`);
  console.log(`  audit_logs 早于 ${cutoff.toISOString().slice(0, 10)}：${n(auditOld)} 行`);
  console.log(`  sessions 已撤销/已过期：${n(sessionsStale)} 行`);
  console.log(`  ip_bans 已过期：${n(bansExpired)} 行`);

  if (!APPLY) {
    console.log('  （dry-run：什么都没删。加 --apply 才执行）');
    await db.destroy();
    return;
  }

  const deletedAudit = await db('audit_logs').where('created_at', '<', cutoff).del();
  const deletedSessions = await db('sessions')
    .where((q) => q.where('revoked', true).orWhere('expires_at', '<', db.fn.now()))
    .del();
  const deletedBans = await db('ip_bans').where('banned_until', '<', db.fn.now()).del();

  console.log(`  已删除：audit_logs ${deletedAudit}、sessions ${deletedSessions}、ip_bans ${deletedBans}`);
  await db.destroy();
}

main().catch(async (e) => {
  console.error('[prune] 失败：', e && e.message);
  try { await db.destroy(); } catch (_) { /* ignore */ }
  process.exit(1);
});
