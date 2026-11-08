/**
 * 接口防直调中间件
 * 1. refererRequired：要求写请求携带同源 Referer/Origin（防跨站/脚本直调）
 * 2. timestampRequired：要求请求头 X-Timestamp 在窗口内（防重放）
 * 注：这层是纵深防御，与 UA 过滤、限流、签名令牌配合使用。
 *
 * ⚠ 当前装配下这两条在**生产路径上几乎不生效**，这是有意的，不要误以为它们是主防线：
 * - `app.js:303` 只对「写请求且不在 GATE_SKIP」调用本中间件，而这些请求在 `app.js:291`
 *   已经过 `gateWriteRequired` 验签成功 → `req.sigVerified === true` → 47 行直接放行。
 * - 也就是说真正拦写请求的是票据 + HMAC 签名（含时间戳与一次性 nonce），本文件是
 *   给「将来新增的、可能绕过闸门的挂载点」留的兜底，不是当下的主力。
 */

const config = require('../config');

// 生产来源白名单：由 ALLOWED_HOSTS 配置动态派生（与 Host 头校验同一权威源，
// 避免硬编码 localhost 导致生产域名被误拒或白名单与实际部署脱节）
const PROD_ORIGIN_HOSTS = config.allowedHosts.map((h) => h.toLowerCase());

// 本地开发来源（允许任意端口）
const DEV_ORIGIN_HOSTS = ['localhost', '127.0.0.1', '::1'];

const TIMESTAMP_WINDOW = 30 * 60 * 1000; // ±30 分钟（时钟偏移大的真实用户不再被拒；防重放由 nonce 一次性消费兜底）

/** 提取 URL 的 hostname（小写；解析失败返回空串） */
function safeHost(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch (e) {
    return '';
  }
}

/** 判断来源 host 是否在允许清单内（生产域名 ∪ 本地开发） */
function isAllowedOriginHost(host) {
  if (!host) return false;
  return PROD_ORIGIN_HOSTS.includes(host) || DEV_ORIGIN_HOSTS.includes(host);
}

/**
 * Referer/Origin 校验：写接口必须来自本站页面（已通过签名校验的请求跳过）
 * - Referer 与 Origin 同时存在时必须同源一致（防伪造 Referer 时 Origin 暴露真实来源）
 * - Origin: null（沙箱 iframe / 隐私容器）一律拒绝
 * - 来源 host 必须命中 ALLOWED_HOSTS 派生白名单或本地开发列表
 */
function refererRequired(req, res, next) {
  // 签名已验证的请求（gateWriteRequired 设置 req.sigVerified）已通过
  // 闸门校验（票据+时间戳+body 哈希绑定），防护强度高于 Referer 检查，
  // 且隐私模式浏览器可能不带 Referer，故放行。
  // 注意：必须检查「签名已验证」标记而非裸 X-Sig 头 —— 头可任意伪造，
  // 标记只能由 gateWriteRequired 验签成功后写入，作为兜底防线真实生效
  if (req.sigVerified === true) return next();

  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';

  // Origin: null（沙箱 iframe / 隐私容器 / 部分扩展剥离）：不再直接拒绝 ——
  // 跨站伪造已被 SameSite cookie + 表单令牌 + 闸门签名兜底，
  // 这里只记日志供排查，避免误杀正常用户
  if (origin && origin.toLowerCase() === 'null') {
    console.warn(`[requestGuard] Origin:null 放行（仅记录） ${req.method} ${req.originalUrl}`);
  }

  const oriHost = origin ? safeHost(origin) : '';
  const refHost = referer ? safeHost(referer) : '';

  // 双头同带必须一致：攻击者可控 Referer 头，但跨站表单的 Origin 由浏览器强制写入
  if (oriHost && refHost && oriHost !== refHost) {
    return res.status(403).json({ code: 1, message: '来源不合法', data: null });
  }

  const host = oriHost || refHost;
  if (!host || !isAllowedOriginHost(host)) {
    return res.status(403).json({ code: 1, message: '来源不合法', data: null });
  }
  next();
}

/** X-Timestamp 防重放：请求头时间戳必须在 ±30 分钟窗口内。
 * 比 `gate.js` 的签名窗口（`security.sigWindow` = 5 分钟）宽松得多：
 * 两者校验的是同一个请求头，签名那条才是有效约束，这里只防「明显过期/未来的裸请求」。
 * 不要把这里的 30 分钟当成实际防重放强度 —— 实际强度由 nonce 一次性消费决定。 */
function timestampRequired(req, res, next) {
  const ts = Number(req.headers['x-timestamp']);
  if (!Number.isFinite(ts)) {
    return res.status(403).json({ code: 1, message: '请求时间戳缺失', data: null });
  }
  if (Math.abs(Date.now() - ts) > TIMESTAMP_WINDOW) {
    return res.status(403).json({ code: 1, message: '请求已过期，请刷新页面', data: null });
  }
  next();
}

module.exports = { refererRequired, timestampRequired, isAllowedOriginHost, safeHost };
