/**
 * 管理员操作审计中间件
 * 自动记录已认证用户的写操作（谁 / 何时 / 对什么做了什么），入库 audit_logs
 * 轻量设计：非侵入，仅记录方法、路径与关键字段摘要
 */

const db = require('../db');

const SENSITIVE_FIELDS = new Set(['password', 'oldPassword', 'newPassword', 'form_token']);

/** 从 body 提取可读摘要（标题/名称/状态等）；敏感字段显式排除（纵深防御） */
function summarize(body = {}) {
  if (typeof body !== 'object' || Array.isArray(body)) return '';
  const parts = [];
  for (const key of ['title', 'name', 'status', 'nickname', 'username', 'content']) {
    if (SENSITIVE_FIELDS.has(key)) continue; // 白名单外无敏感键，此处为未来扩展的防御
    const v = body[key];
    if (typeof v === 'string' && v.trim()) {
      parts.push(`${key}=${v.trim().slice(0, 40)}`);
    }
  }
  return parts.join(', ').slice(0, 160);
}

/** 审计中间件：响应完成后检查（此时认证已执行，req.user 已就绪） */
function audit(req, res, next) {
  const isWrite = ['POST', 'PUT', 'DELETE'].includes(req.method);
  if (!isWrite) return next();

  res.on('finish', () => {
    // 仅记录认证成功（req.user 由 authRequired 在路由中设置）且响应成功的写操作
    if (res.statusCode >= 400 || !req.user) return;
    const path = req.baseUrl + req.path;
    const body = req.body || {};
    const summary = summarize(body);
    db('audit_logs')
      .insert({
        user_id: Number(req.user.sub || 0),
        username: String(req.user.username || '').slice(0, 50),
        action: `${req.method} ${path}`.slice(0, 120),
        detail: summary,
        ip: String(req.ip || '').slice(0, 64),
        fp: String(req.headers['x-fp'] || '').slice(0, 128),
      })
      .catch(() => {});
  });
  next();
}

module.exports = { audit };
