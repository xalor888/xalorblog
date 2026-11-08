const db = require('../db');
const { safeUrl, safeCover } = require('./sanitize');
const { isPrivateUrl } = require('./netGuard');

const DEFAULT_SETTINGS = {
  site_name: 'Xalor的小站',
  site_desc: '记录生活、分享思考的个人博客',
  announcement: '欢迎来到 Xalor 的小站！',
  footer: '© 2026 Xalor的小站 · 用 ❤ 与 Vue 构建',
  about_content: '# 关于我\n\n这里是关于页内容，可以在后台修改。',
  // 默认头像/LOGO：站点图标（未在后台手动上传头像时，About 页、OG 分享图回退均使用此图）
  avatar: '/logo.png',
  // 站点专用分享图（1200×630 宽幅）：社交卡片优先用它，其次才回退 avatar。
  //
  // ⚠ 这个键必须是 DEFAULT_SETTINGS 的成员，否则整条链路是死的：
  // saveSettings 只接受 ALLOWED_KEYS（= Object.keys(DEFAULT_SETTINGS)）里的键，
  // 不在其中就 `continue` **静默丢弃**。而 share.js / feed.js / pageMeta.js /
  // ArticleDetail.vue 四处都在读它 —— 后台那个输入框填了永远存不进去，
  // 分享卡片永远回落到正方形的头像（被裁成 1.91:1 会很难看）。
  // 这正是「界面有、文档有、消费方有，唯独存储白名单里没有」的典型死字段。
  og_image: '',
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
  // 网页搜索（Tavily）：AI 助手的 search_web 工具数据源。
  // websearch_api_key 是敏感字段：公开接口不下发、设置导出剔除，后台只显示「是否已配置」。
  websearch_enabled: false,
  websearch_provider: 'tavily',
  websearch_api_key: '',
  // 全站是否允许复制正文/选中文字。默认允许（单篇可用 articles.allow_copy 覆盖）
  allow_copy: true,
  // RSS 默认仅摘要。全文会绕过文章详情的传输加密，须站长显式打开。
  rss_full_content: false,
  // 自定义版权声明（文章页版权卡片；留空则使用默认 CC BY-NC 4.0 声明）
  copyright_text: '',
  // ICP 备案号（页脚展示；留空不显示）
  icp: '',

  // ---------- 个人主页（xalor.cn） ----------
  // 主页站点完整 URL（如 https://xalor.cn）：主页版 RSS/Sitemap/分享链接优先使用，
  // 与博客的 site_url 分开维护，因为两者是不同的域名。
  home_site_url: '',
  // Hero 文案
  home_hero_greeting: "Hi, I'm",
  home_hero_role: '',
  home_hero_quote: '',
  // 在线状态：online | busy | away | offline
  home_status: 'online',
  // 站点起始日期（YYYY-MM-DD），用于计算「运行 N 天」；留空回落到 2024-01-01
  home_since_date: '',
  // 额外社交链接（JSON 数组：[{"label":"Bilibili","url":"https://..."}]）。
  // GitHub / 微博 / 邮箱沿用博客已有的 social_github / social_weibo / social_email。
  home_social_extra: '[]',
  // 主页「关于」卡片摘要（纯文本；留空则自动截取 about_content 前 200 字）
  home_about_excerpt: '',
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
  'websearch_enabled',
]);

/**
 * 结构化（数组/对象）值的键。
 *
 * 为什么需要单独一组：`saveSettings` 的通用分支只接受 `typeof value === 'string'`，
 * 结构化数据必须先序列化成字符串；而 `getAllSettings` 的通用分支又会对
 * 「解析出来不是字符串」的值做 `String(v)` —— 数组会被拼成 "[object Object]"。
 *
 * 原来的 `home_social_extra` 分支清洗完数组后赋值给 `value` 却没 `continue`，
 * 于是落到通用分支被 **JSON.stringify 了第二次**，落库是双编码：
 *   '[{"label":"GitHub","url":"..."}]'  ← 外面还裹一层引号
 * 读回来 `JSON.parse` 一次得到的是**字符串**而不是数组，只能靠消费方再 parse 一次兜住。
 * 功能上是通的，但语义混乱：任何人直接写 `settings.home_social_extra.map(...)` 都会崩。
 */
const JSON_VALUE_KEYS = new Set(['home_social_extra']);

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
      } else if (JSON_VALUE_KEYS.has(r.key)) {
        // 结构化的键原样保留数组；非法形态（字符串/数字）统一降级为空数组，
        // 消费方就不用各自再写一遍 try/catch
        v = Array.isArray(v) ? v : [];
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

/** 批量保存设置（upsert）：仅接受白名单内的键，字符串做长度限制。
 *  全部键在单事务里并行写入 —— 逐条 await 会有 N 次网络往返（25 键 ≈ 秒级），
 *  这里一次性提交，保存耗时从「键数 × RTT」降到一次事务。 */
async function saveSettings(entries) {
  const writes = []; // 待执行的 upsert
  const clears = []; // 待执行的删除（密钥 __CLEAR__）
  /**
   * 被校验拒绝的键。
   *
   * 这个函数的每个 `continue` 都是**静默丢弃** —— 不报错、不提示，调用方
   * 只看到「保存成功」。对某些字段这是合理的（密钥留空 = 不修改），
   * 但对用户主动填写的字段（`site_url` 带了 query、`ai_base_url` 指向内网 IP），
   * 「提示已保存但值没变」会让用户以为配置生效了，然后去排查别的地方。
   *
   * 所以把拒绝原因收集起来交给调用方，由它决定怎么提示。
   */
  const rejected = [];

  /** 记一笔「这个键被拒了」并附上原因，交给调用方提示 */
  const reject = (key, reason) => rejected.push({ key, reason });

  for (let [key, value] of Object.entries(entries)) {
    if (!ALLOWED_KEYS.has(key)) continue; // 忽略未知键
    // null 视为「清空」而不是「忽略」：el-date-picker 等控件清空后提交的是 null，
    // 若按「忽略」处理，后台会提示「设置已保存」而值纹丝不动（静默失效）。
    // 布尔键不受影响 —— 下面 BOOL_KEYS 分支本来就把 null 判为 false。
    // 密钥类键仍保持「空值=不修改」的约定（见各自的 continue 分支）。
    if (value === null) value = '';
    const raw = String(value ?? '');
    // URL 字段协议校验（纵深）：防止 javascript:/data: 等注入型值进入
    // 展示链路（<a href> / <img src> / OG 分享图 / RSS 链接）
    if (key === 'site_url' && value) {
      const parsed = safeUrl(raw, 500);
      if (!parsed) { reject(key, 'URL 需要是 http(s) 绝对地址'); continue; }
      const u = new URL(parsed);
      if (u.search || u.hash) { reject(key, '站点 URL 不能带查询参数或锚点'); continue; }
    }
    // 主页站点 URL：与 site_url 同一套约束（协议白名单 + 拒带 query/hash）
    if (key === 'home_site_url' && value) {
      const parsed = safeUrl(raw, 500);
      if (!parsed) { reject(key, 'URL 需要是 http(s) 绝对地址'); continue; }
      const u = new URL(parsed);
      if (u.search || u.hash) { reject(key, '站点 URL 不能带查询参数或锚点'); continue; }
    }
    // 主页在线状态：枚举钳制，非法值丢弃（保持原值）
    if (key === 'home_status' && !['online', 'busy', 'away', 'offline'].includes(String(raw).trim())) {
      reject(key, '在线状态只能是 online / busy / away / offline');
      continue;
    }
    // 起始日期：严格 YYYY-MM-DD，否则丢弃（前端用 new Date() 解析，脏值会产生 NaN 天数）
    if (key === 'home_since_date' && raw) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) { reject(key, '日期格式必须是 YYYY-MM-DD'); continue; }
    }
    // 额外社交链接：必须是 JSON 数组，逐项校验 label 与 http(s) URL，最多 8 条。
    // 校验后重新序列化，避免把非法项原样带进公开接口。
    if (key === 'home_social_extra') {
      let list;
      try {
        list = JSON.parse(raw || '[]');
      } catch (e) {
        continue;
      }
      if (list === null || list === undefined) list = [];
      if (!Array.isArray(list) || list.length > 8) continue;
      const cleaned = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const label = String(item.label ?? '').trim().slice(0, 30);
        const u = safeUrl(String(item.url ?? ''), 300);
        if (!label || !u) continue;
        cleaned.push({ label, url: u });
      }
      // 直接入队并跳出：**不能再落到通用分支**，否则会被 JSON.stringify 第二次，
      // 落库变成双编码（外面裹一层引号），读回来 parse 一次得到字符串而不是数组。
      writes.push({ key, value: JSON.stringify(cleaned) });
      continue;
    }
    // avatar 与封面同一白名单：/logo.png、/uploads/<随机文件名> 或 http(s)
    if (key === 'avatar' && value) {
      if (!safeCover(raw)) { reject(key, '头像只接受站内路径（/logo.png、/uploads/<文件名>）或 http(s) 地址'); continue; }
    }
    // 分享图：后台提示写明「必须是绝对 URL 或站内绝对路径」，示例就是 /og-image.png。
    // 所以不能直接复用 safeCover —— 那个函数只认 `/logo.png` 与 `/uploads/<随机名>`
    // 两种字面形态（它服务的是「上传产物」），把 /og-image.png 这种**站内真实存在**
    // 的构建产物路径判为非法，会让这个字段「能存但不认自己文档里举的例子」。
    // 判据：站内绝对路径（`/` 开头，无协议、无 ..、无空白）或经 safeUrl 的绝对 http(s)。
    if (key === 'og_image' && value) {
      const isSitePath = /^\/(?!\/)[^\s\\]*$/.test(raw) && !raw.includes('..');
      if (!isSitePath && !safeUrl(raw, 500)) { reject(key, '分享图只接受站内绝对路径或 http(s) 地址'); continue; }
    }
    if ((key === 'social_github' || key === 'social_weibo') && value && !/^https?:\/\/[^\s]+$/i.test(raw)) {
      reject(key, '社交链接需要是 http(s) 绝对地址');
      continue;
    }
    // 联系邮箱用于 security.txt / mailto 链接，拒绝空格/换行/角括号等异常值
    if (key === 'social_email' && value && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw)) {
      reject(key, '邮箱格式不正确');
      continue;
    }
    // AI 接口地址：必须是 https，且**不能是私有/保留 IP 字面量**。
    // 保存时就挡住（而不是只在运行时判 ready）：后台填完点保存如果能成功，
    // 用户会认为配置没问题，然后在调用时看到「AI 不可用」，两处说法不一致。
    // 需要生产环境对接自建网关时，用主机名（如 ai-gw.local 指向 127.0.0.1）而不是 IP 字面量。
    if (key === 'ai_base_url' && raw) {
      if (!/^https:\/\/[^\s]+$/i.test(raw)) { reject(key, 'AI 接口地址必须是 https'); continue; }
      if (isPrivateUrl(raw)) {
        reject(key, 'AI 接口地址不能指向内网/保留地址（需要连本地网关请用主机名而不是 IP）');
        continue;
      }
    }
    // AI 密钥：后台不回显明文，所以「空值」表示"不修改"而不是"清空"。
    // 要清除请提交单独的删除标记。
    if (key === 'ai_api_key') {
      if (!raw || /^\*+$/.test(raw)) continue;
      if (raw === '__CLEAR__') {
        clears.push(key);
        continue;
      }
      if (raw.length < 8 || raw.length > 300) continue;
    }
    // AI 生成参数：数值范围钳制（温度 0-2，输出上限 256-8192）
    if (key === 'ai_temperature' && raw) {
      const t = Number(raw);
      if (!Number.isFinite(t) || t < 0 || t > 2) { reject(key, 'temperature 需要在 0–2 之间'); continue; }
    }
    if (key === 'ai_max_tokens' && raw) {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 256 || n > 8192) { reject(key, 'max tokens 需要在 256–8192 之间'); continue; }
    }
    if (key === 'ai_system_prompt' && raw.length > 3000) { reject(key, '人设最多 3000 字'); continue; }
    // 网页搜索密钥：与 ai_api_key 同一套「空值=不修改、__CLEAR__=删除」的约定
    if (key === 'websearch_api_key') {
      if (!raw || /^\*+$/.test(raw)) continue;
      if (raw === '__CLEAR__') {
        clears.push(key);
        continue;
      }
      if (raw.length < 8 || raw.length > 300) continue;
    }
    if (key === 'websearch_provider' && !['tavily'].includes(String(raw).trim())) {
      reject(key, '搜索服务商目前只支持 tavily');
      continue;
    }
    // AI 上下文参数：正文 1000-100000 字、历史 6-200 轮。
    // 上限对齐现代长上下文模型（百万 token 级）：10 万中文字 ≈ 5-10 万 token，占比个位数。
    if (key === 'ai_ctx_chars' && raw) {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1000 || n > 100000) { reject(key, '上下文字数需要在 1000–100000 之间'); continue; }
    }
    if (key === 'ai_ctx_turns' && raw) {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 6 || n > 200) { reject(key, '上下文轮数需要在 6–200 之间'); continue; }
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
    writes.push({ key, value: json });
  }
  // 单事务并行执行全部写入/删除，一次提交
  if (writes.length || clears.length) {
    await db.transaction(async (trx) => {
      if (clears.length) await trx('settings').whereIn('key', clears).del();
      if (writes.length) {
        await trx('settings')
          .insert(writes.map((w) => ({ key: w.key, value: w.value, updated_at: trx.fn.now() })))
          .onConflict('key')
          .merge(['value', 'updated_at']);
      }
    });
  }
  settingsCache = null; // 失效缓存
  return { settings: await getAllSettings(), rejected };
}

/** 手动失效设置缓存（测试用；运维在需要立刻看到后台改动时也可调） */
function clearSettingsCache() {
  settingsCache = null;
  cacheAt = 0;
}

module.exports = { DEFAULT_SETTINGS, ALLOWED_KEYS, getAllSettings, saveSettings, clearSettingsCache };
