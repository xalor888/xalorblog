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
  // AI 内容审核：独立于上面两个「人工审核」开关的第二层。
  // 打开时本地规则引擎会自动拦广告/辱骂（≥60 分直接拒绝、≥30 分强制待审），
  // 关掉后评论/留言完全听从 comment_moderation / message_moderation 的安排。
  // 默认值直接跟环境变量（与 config.ai.enabled 同一判据），后台设置可覆盖。
  ai_moderation: process.env.AI_MODERATION !== 'false',
  // LLM 深度二判：仅对本地判为中风险的评论调用大模型复核。
  // 需要同时配置 AI_API_KEY / AI_BASE_URL / AI_MODEL 才会真正生效（有 API 成本）。
  ai_llm_moderation: true,
  // AI 模型配置（可选）：留空则回落到服务器 .env 的 AI_BASE_URL / AI_MODEL / AI_API_KEY，
  // 填了就以后台为准（与 WAF 那套「env 作默认值、表配置覆盖」一致）。
  // ai_api_key 是敏感字段：公开接口不下发、设置导出会剔除，后台只显示「是否已配置」。
  ai_base_url: '',
  ai_model: '',
  ai_api_key: '',
  // AI 生成参数：留空用内置默认（temperature 0.7 / max_tokens 4096）。
  // 与主流 Agent 产品一致的可调项：温度越低越稳、越高越发散；max_tokens 封顶单次输出。
  ai_temperature: '',
  ai_max_tokens: '',
  // 自定义写作助手人设：留空用内置提示词；填了则替换「角色与文风」层，
  // 工具说明与文章上下文始终保留（那是功能正确性的底线，自定义不动它）。
  ai_system_prompt: '',
  // AI 上下文控制：留空用默认（正文 6000 字 / 历史 24 条 / 超长自动压缩成纪要）。
  ai_ctx_chars: '',
  ai_ctx_turns: '',
  // 对话超过保留条数时，把最早的对话先让模型压成一段纪要再续聊（默认开，可多烧一小次调用）
  ai_ctx_compress: true,
  // 全站是否允许复制正文/选中文字。默认允许（单篇可用 articles.allow_copy 覆盖）
  allow_copy: true,
  // RSS 默认仅摘要。全文会绕过文章详情的传输加密，须站长显式打开。
  rss_full_content: false,
  // 自定义版权声明（文章页版权卡片；留空则使用默认 CC BY-NC 4.0 声明）
  copyright_text: '',
  // ICP 备案号（页脚展示；留空不显示）
  icp: '',
};

/** 允许保存的键白名单（防止任意键注入） */
const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const BOOL_KEYS = new Set([
  'comment_moderation',
  'message_moderation',
  'rss_full_content',
  'allow_copy',
  'ai_moderation',
  'ai_llm_moderation',
  'ai_ctx_compress',
]);

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
    // AI 接口地址：必须是 https（内容与密钥不能走明文，也不允许指向内网成为 SSRF 链）
    if (key === 'ai_base_url' && raw) {
      if (!/^https:\/\/[^\s]+$/i.test(raw)) continue;
    }
    // AI 密钥：后台不回显明文，所以「空值」表示"不修改"而不是"清空"。
    // 要清除请提交单独的删除标记。
    if (key === 'ai_api_key') {
      if (!raw || /^\*+$/.test(raw)) continue;
      if (raw === '__CLEAR__') {
        await db('settings').where('key', 'ai_api_key').del();
        continue;
      }
      if (raw.length < 8 || raw.length > 300) continue;
    }
    // AI 生成参数：数值范围钳制（温度 0-2，输出上限 256-8192）
    if (key === 'ai_temperature' && raw) {
      const t = Number(raw);
      if (!Number.isFinite(t) || t < 0 || t > 2) continue;
    }
    if (key === 'ai_max_tokens' && raw) {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 256 || n > 8192) continue;
    }
    if (key === 'ai_system_prompt' && raw.length > 3000) continue;
    // AI 上下文参数：正文 1000-20000 字、历史 6-48 条（越界忽略）
    if (key === 'ai_ctx_chars' && raw) {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1000 || n > 20000) continue;
    }
    if (key === 'ai_ctx_turns' && raw) {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 6 || n > 48) continue;
    }
    let safeValue;
    if (BOOL_KEYS.has(key)) {
      safeValue = value === true || value === 'true' || value === 1 || value === '1';
    } else if (typeof value === 'string') {
      const maxLen = key === 'about_content' ? 50000 : 5000;
      safeValue = value.slice(0, maxLen);
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
