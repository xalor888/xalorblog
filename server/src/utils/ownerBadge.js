/**
 * 博主识别：根据管理员昵称标记"博主"发言
 * 供评论/留言等公开内容接口复用（60s 缓存）
 */

const db = require('../db');

let adminCache = null;
let adminCacheAt = 0;

async function getAdminNicknames() {
  if (adminCache && Date.now() - adminCacheAt < 60 * 1000) return adminCache;
  const rows = await db('users').where('role', 'admin').select('nickname');
  adminCache = new Set((rows || []).map((r) => String(r.nickname || '').trim().toLowerCase()).filter(Boolean));
  adminCacheAt = Date.now();
  return adminCache;
}

/** 判断某个昵称是否为博主 */
async function isOwnerNickname(nickname) {
  const admins = await getAdminNicknames();
  return admins.has(String(nickname || '').trim().toLowerCase());
}

module.exports = { getAdminNicknames, isOwnerNickname };
