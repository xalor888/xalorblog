const db = require('../db');
const { safeUrl, safeCover } = require('./sanitize');

const DEFAULT_SETTINGS = {
  site_name: 'Xalor的小站',
  site_desc: '记录生活、分享思考的个人博客',
  announcement: '欢迎来到 Xalor 的小站！',
  footer: '© 2026 Xalor的小站 · 用 ❤ 与 Vue 构建',
  about_content: '# 关于我\n\n这里是关于页内容，可以在后台修改。',
  // 默认头像/LOGO：站点图标（未在后台手动上传头像时，About 页、OG 分享图回退均使用此图）
  avatar: '/logo.png',
  // 站点完整 URL（如 https://blog.example.com）：RSS/Sitemap/分享页链接优先使用，
  // 避免 Nginx 终止 TLS 时 req.protocol 推导出 http 链接
  site_url: '',
  social_github: 'https://github.com/xalor888',
  social_weibo: '',
  social_email: 'xalor888@gmail.com',
  // 内容审核开关：开启后新评论/留言进入待审，需后台手动通过
  comment_moderation: false,
  message_moderation: false,
  // RSS 默认仅摘要。全文会绕过文章详情的传输加密，须站长显式打开。
  rss_full_content: false,
  // 自定义版权声明（文章页版权卡片；留空则使用默认 CC BY-NC 4.0 声明）
  copyright_text: '',
  // ICP 备案号（页脚展示；留空不显示）
  icp: '',
};

/** 允许保存的键白名单（防止任意键注入） */
const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const BOOL_KEYS = new Set(['comment_moderation', 'message_moderation', 'rss_full_content']);

// 设置缓存：读多写少，保存时失效
let settingsCache = null;
let cacheAt = 0;
const CACHE_TTL = 60 * 1000; // 60 秒

/** 读取全部设置（带 60s 缓存） */
async function getAllSettings() {
  const now = Date.now();
  if (settingsCache && now - cacheAt < CACHE_TTL) {
    return settingsCache;
  }
  const rows = await db('settings').select('key', 'value');
  const map = {};
  for (const r of rows) {
    try {
      let v = JSON.parse(r.value);
      if (BOOL_KEYS.has(r.key)) {
        v = v === true || v === 'true' || v === 1 || v === '1';
      } else if (typeof v !== 'string') {
        v = String(v ?? '').slice(0, 5000);
      }
      map[r.key] = v;
    } catch (e) {
      map[r.key] = BOOL_KEYS.has(r.key) ? false : String(r.value ?? '').slice(0, 5000);
    }
  }
  settingsCache = { ...DEFAULT_SETTINGS, ...map };
  cacheAt = now;
  return settingsCache;
}

/** 批量保存设置（upsert）：仅接受白名单内的键，字符串做长度限制 */
async function saveSettings(entries) {
  for (const [key, value] of Object.entries(entries)) {
    if (!ALLOWED_KEYS.has(key)) continue; // 忽略未知键
    const raw = String(value ?? '');
    // URL 字段协议校验（纵深）：防止 javascript:/data: 等注入型值进入
    // 展示链路（<a href> / <img src> / OG 分享图 / RSS 链接）
    if (key === 'site_url' && value) {
      const parsed = safeUrl(raw, 500);
      if (!parsed) continue;
      const u = new URL(parsed);
      if (u.search || u.hash) continue;
    }
    // avatar 与封面同一白名单：/logo.png、/uploads/<随机文件名> 或 http(s)
    if (key === 'avatar' && value) {
      if (!safeCover(raw)) continue;
    }
    if ((key === 'social_github' || key === 'social_weibo') && value && !/^https?:\/\/[^\s]+$/i.test(raw)) continue;
    // 联系邮箱用于 security.txt / mailto 链接，拒绝空格/换行/角括号等异常值
    if (key === 'social_email' && value && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw)) continue;
    let safeValue;
    if (BOOL_KEYS.has(key)) {
      safeValue = value === true || value === 'true' || value === 1 || value === '1';
    } else if (typeof value === 'string') {
      safeValue = value.slice(0, 5000);
    } else {
      continue;
    }
    const json = JSON.stringify(safeValue);
    await db('settings')
      .insert({ key, value: json })
      .onConflict('key')
      .merge({ value: json, updated_at: db.fn.now() });
  }
  settingsCache = null; // 失效缓存
  return getAllSettings();
}

module.exports = { DEFAULT_SETTINGS, ALLOWED_KEYS, getAllSettings, saveSettings };
