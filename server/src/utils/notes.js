/**
 * 手记（notes）共用工具
 * 供公开路由（routes/notes.js）、主页摘要（routes/home.js）、
 * 主页版 SEO（routes/feed.js）与后台（routes/admin.js）复用，
 * 避免「列表字段白名单」在多处各写一份导致漂移。
 */

const { plainText } = require('./markdownText');
const { safeCover } = require('./sanitize');

/** 单条手记最多图片数（与前端九宫格一致） */
const MAX_NOTE_IMAGES = 9;
/** 列表摘要长度 */
const EXCERPT_LEN = 200;

/** 图片列（JSON 字符串）→ 数组；脏值一律降级为空数组 */
function parseImages(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string' && u) : [];
  } catch (e) {
    return [];
  }
}

/**
 * 清洗图片列表：逐项走 safeCover（站内 /uploads 白名单或 http(s) 外链），
 * 上限 MAX_NOTE_IMAGES 张。返回可直接入库的 JSON 字符串。
 */
function serializeImages(input) {
  const list = Array.isArray(input) ? input : [];
  const cleaned = [];
  for (const item of list) {
    if (cleaned.length >= MAX_NOTE_IMAGES) break;
    const safe = safeCover(String(item ?? ''));
    if (safe) cleaned.push(safe);
  }
  return JSON.stringify(cleaned);
}

/** 从正文生成纯文本摘要 */
function buildExcerpt(content, len = EXCERPT_LEN) {
  return plainText(content).slice(0, len);
}

/**
 * 列表安全字段：**绝不含 content**。
 * 手记正文只在详情接口以 AES-GCM 密文下发。
 */
function noteSummary(row) {
  const images = parseImages(row.images);
  return {
    id: row.id,
    excerpt: row.excerpt || buildExcerpt(row.content),
    cover: images[0] || '',
    image_count: images.length,
    mood: row.mood || '',
    location: row.location || '',
    likes: Number(row.likes || 0),
    is_pinned: !!row.is_pinned,
    status: row.status,
    published_at: row.published_at || row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  MAX_NOTE_IMAGES,
  EXCERPT_LEN,
  parseImages,
  serializeImages,
  buildExcerpt,
  noteSummary,
};
