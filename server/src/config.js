require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';

const DB_PASSWORD = process.env.DB_PASSWORD || '';
if (!DB_PASSWORD) {
  throw new Error('必须配置 DB_PASSWORD（请使用强随机密码）');
}
if (DB_PASSWORD === 'xalor2026' || DB_PASSWORD === 'CHANGE_ME_STRONG_PASSWORD') {
  throw new Error('禁止使用占位/默认 DB_PASSWORD');
}
if (DB_PASSWORD.length < 16) {
  throw new Error('DB_PASSWORD 长度必须不少于 16 字符');
}

// 生产环境必须显式提供密钥；开发环境可自动生成（重启失效，不影响体验）
// 记忆化：同一进程内多次调用必须返回同一值 —— jwt.secret 与 adminPath 派生
// 都依赖它，若各自随机生成会得到两个不同密钥（进程内虽一致，属潜在隐患）
let secretCache = null;
function resolveSecret() {
  if (secretCache) return secretCache;
  if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error('生产环境必须配置 JWT_SECRET（至少 32 字符强随机串）');
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
    secretCache = process.env.JWT_SECRET;
    return secretCache;
  }
  if (isProd) {
    console.warn('[config] ⚠ 生产环境未配置 JWT_SECRET，已生成随机密钥（服务重启后所有会话失效）。请设置强随机密钥！');
  }
  secretCache = crypto.randomBytes(48).toString('hex');
  return secretCache;
}

module.exports = {
  isProd,
  port: Number(process.env.PORT || 3000),
  // 反向代理信任级数：仅当服务部署在 Nginx 等代理后设置为 1（或代理级数），
  // 默认 0 —— 不信任任何 X-Forwarded-For，防止无代理部署时伪造 IP 绕过限流/封禁
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  // 动态 API 前缀：不暴露真实接口路径（生产建议通过环境变量改为随机字符串）
  apiPrefix: (process.env.API_PREFIX || '/api').replace(/\/+$/, ''),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'xalor',
    password: DB_PASSWORD,
    database: process.env.DB_NAME || 'xalor_blog',
  },
  jwt: {
    secret: resolveSecret(),
    expiresIn: process.env.JWT_EXPIRES_IN || '2h',
  },
  uploadDir: path.join(__dirname, '..', 'uploads'),
  // 允许的 Host（防 Host 头注入/缓存投毒）
  allowedHosts: (process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1,::1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // CORS 允许的来源：默认本地开发端口；生产部署可用 CORS_ORIGINS 显式指定
  // （逗号分隔；与 ALLOWED_HOSTS 独立，两者各司其职：Host 校验防投毒，CORS 放行浏览器跨域）
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173,http://localhost:4173,http://127.0.0.1:4173,http://[::1]:4173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // 管理后台秘钥路径：默认由 JWT_SECRET 派生（每个实例不同），也可用 ADMIN_PATH 环境变量显式指定
  // 前端通过 /api/anti/admin-path 获取
  adminPath: (function () {
    const derived = crypto.createHmac('sha256', resolveSecret()).update('admin-secret-path').digest('hex').slice(0, 12);
    const custom = String(process.env.ADMIN_PATH || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
    return custom || derived;
  })(),
  // 安全中心参数
  security: {
    // 通行证票据有效期（毫秒）
    ticketTtl: 10 * 60 * 1000,
    // 票据滑动续期窗口
    renewWindow: 8 * 60 * 1000,
    // PoW 难度（前导零 bit 数，16 ≈ 平均 6.5 万次哈希；与前端求解器 bit 语义一致）
    powDifficulty: 16,
    // 挑战有效期（毫秒）
    puzzleTtl: 60 * 1000,
    // 签名时间戳窗口（毫秒）
    sigWindow: 5 * 60 * 1000,
    // 内容加密盐
    encSalt: process.env.ENC_SALT || 'xalor-content-v1',
  },
  // AI 评论审核（可选）：本地规则引擎默认开启；
  // 配置 AI_API_KEY / AI_BASE_URL / AI_MODEL 后启用 LLM 深度二判（兼容 OpenAI Chat Completions）
  ai: {
    enabled: process.env.AI_MODERATION !== 'false',
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    // 本地规则评分阈值：≥ rejectScore 直接拒绝；≥ pendingScore 强制待审
    rejectScore: Number(process.env.AI_REJECT_SCORE || 60),
    pendingScore: Number(process.env.AI_PENDING_SCORE || 30),
  },
};
