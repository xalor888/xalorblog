const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const articlesRouter = require('./routes/articles');
const categoriesRouter = require('./routes/categories');
const tagsRouter = require('./routes/tags');
const commentsRouter = require('./routes/comments');
const linksRouter = require('./routes/links');
const messagesRouter = require('./routes/messages');
const statsRouter = require('./routes/stats');
const settingsRouter = require('./routes/settings');
const feedRouter = require('./routes/feed');
const shareRouter = require('./routes/share');
const antiRouter = require('./routes/anti');
const adminRouter = require('./routes/admin');
const { antiBot, readLimiter } = require('./middleware/antiBot');
const { waf, recordMiss } = require('./middleware/waf');
const { formTokenRequired } = require('./middleware/formToken');
const { refererRequired, timestampRequired } = require('./middleware/requestGuard');
const { gateRequired, gateWriteRequired, isSearchBot, verifyCrawlerIp } = require('./middleware/gate');
const { ipGuard, report } = require('./middleware/ipGuard');
const { audit } = require('./middleware/audit');
const { fetchMetaGuard } = require('./middleware/fetchMeta');
const { robotsTxt } = require('./routes/feed');

const app = express();

// 请求追踪 ID：优先透传合法的外部 X-Request-Id（限长限字符），否则生成 UUID；
// 响应头携带，错误日志携带，排查单请求全链路
app.use((req, res, next) => {
  const incoming = String(req.headers['x-request-id'] || '');
  req.requestId = /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
});

// 信任明确的反向代理地址/CIDR，使 req.ip 获取真实客户端 IP。
// 默认只信任 loopback，禁止使用跳数，防止直连者伪造 X-Forwarded-For。
app.set('trust proxy', config.trustProxy);

// ---------- 响应压缩（gzip，Node 自带 zlib 实现，无新增依赖） ----------
// 仅压缩文本类响应（JSON/XML/RSS/分享页 HTML），跳过 304/HEAD 与小响应；
// 正文为 AES-GCM 加密 + 无反射输入，BREACH 攻击不适用
const zlib = require('zlib');
app.use((req, res, next) => {
  // 追加而非覆盖：CORS 会写 Vary: Origin，覆盖后中间代理可能按编码复用跨域响应
  res.append('Vary', 'Accept-Encoding');
  if (req.method === 'HEAD' || !/gzip/.test(req.headers['accept-encoding'] || '')) return next();
  const send = res.send.bind(res);
  res.send = (body) => {
    if (res.headersSent || res.statusCode === 304 || typeof body !== 'string' || body.length < 1024) {
      return send(body);
    }
    try {
      const buf = Buffer.from(body, 'utf8');
      const zipped = zlib.gzipSync(buf);
      if (zipped.length >= buf.length) return send(body);
      res.set('Content-Encoding', 'gzip');
      res.set('Content-Length', String(zipped.length));
      return send(zipped);
    } catch (e) {
      return send(body);
    }
  };
  next();
});

// ---------- 基础安全 ----------
app.disable('x-powered-by');
app.disable('etag'); // 关闭 ETag，避免响应体大小指纹泄露
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' }, // 严格禁止被嵌入 iframe
    // helmet v8 的 hsts 总是设置头（无 setIf 支持），HSTS 由下方自定义中间件
    // 仅在 HTTPS（含代理透传）时发送，http 开发环境不发送
    hsts: false,
  })
);

// HSTS：仅 HTTPS 连接生效（浏览器只接受 https 响应中的 HSTS；http 下发送无效且语义错误）
app.use((req, res, next) => {
  const isHttps = req.secure || /^https$/i.test(String(req.headers['x-forwarded-proto'] || ''));
  if (isHttps) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

// 附加安全头：浏览器能力策略 + 引用策略 + 跨源隔离 + 跨域文档策略
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), sync-xhr=(self)');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 跨窗口隔离：切断 window.opener 链，防跨窗口 DOM/侧信道信息窃取
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  // 跨域文档策略：禁止 Flash/PDF/Office 插件跨域读取文档内容
  res.set('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

// HTTP 方法白名单（其余一律 405）
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
app.use((req, res, next) => {
  if (!ALLOWED_METHODS.includes(req.method)) {
    res.set('Allow', ALLOWED_METHODS.join(', '));
    return res.status(405).json({ code: 1, message: '方法不允许' });
  }
  next();
});

// Host 头校验：防 Host 头注入 / 缓存投毒
app.use((req, res, next) => {
  const host = req.headers.host || '';
  let hostname = String(host).toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end > 0 ? hostname.slice(1, end) : hostname;
  } else {
    hostname = hostname.split(':')[0];
  }
  hostname = hostname.replace(/\.+$/, '');
  if (!config.allowedHosts.includes(hostname)) {
    report(req.ip, 'waf', 'HOST 头不合法');
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  next();
});

// 请求体超时保护（防慢速攻击拖死连接）
// Node 25 的 socket timeout 事件/requestTimeout 对「body 半发送」场景不可靠（实测不触发），
// 这里用纯定时器兜底：任何请求超过 30 秒未完成（含半发送 body 的慢速攻击）即销毁连接。
// 正常请求（含 5MB 上传）远快于此；res 完成后定时器即清理，无泄漏。
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.writableEnded) {
      try {
        res.status(408).json({ code: 1, message: '请求超时' });
      } catch (e) { /* 连接可能已不可写 */ }
      req.socket.destroy();
    }
  }, 30 * 1000);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  res.setTimeout(30 * 1000);
  next();
});

// CORS：仅允许白名单来源（默认本地开发端口；生产用 CORS_ORIGINS 配置）
const allowedOrigins = config.corsOrigins;
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('不允许的跨域来源'));
    },
    methods: ALLOWED_METHODS,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Pass', 'X-Fp', 'X-Sig', 'X-Timestamp', 'X-Nonce', 'X-Enc', 'X-Hp-Field'],
    maxAge: 86400,
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// 全局 API 限流：每 IP 每分钟 120 次
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    report(req.ip, 'rate', req.path);
    res.status(429).json({ code: 1, message: '请求过于频繁，请稍后再试' });
  },
});
app.use(config.apiPrefix, apiLimiter);

// API 响应禁止缓存：防止敏感数据落入浏览器/中间代理缓存
app.use(config.apiPrefix, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  // API 返回纯 JSON，无需加载任何外部资源：最严格的 CSP（含 frame-ancestors 防点击劫持）
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  // 资源隔离：禁止跨站读取 API 响应体（防 Spectre 侧信道/跨站数据抓取）
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

// 敏感接口单独限流：登录/评论/留言/友链申请/点赞
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '操作过于频繁，请稍后再试' },
});

// 上传文件静态资源限流（防高频刷带宽/防盗链拖库）
const uploadsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '读取过于频繁，请稍后再试' },
});

// 应用层 WAF（在限流与路由之前）
app.use(waf);

// IP 信誉闸门：被封禁 IP 直接拒绝
app.use(ipGuard);

const api = config.apiPrefix;

// Fetch Metadata 校验：跨站写请求一律拒绝（现代浏览器特征）
app.use(api, fetchMetaGuard);

/**
 * 反爬闸门：除白名单外的全部 /api 请求必须持有通行证票据
 * - GET：gateRequired（PoW 换取的票据）
 * - 写请求：gateWriteRequired（票据 + 时间戳 + 请求签名）
 * - 搜索引擎爬虫在只读接口上放行（利于收录）—— 但须通过反向 DNS 核验，
 *   自称 Googlebot 等却来自不相关 IP 的请求视为伪造，直接拒绝
 */
const GATE_SKIP = ['/anti', '/health', '/rss.xml', '/sitemap.xml', '/robots.txt', '/share/'];
app.use(api, async (req, res, next) => {
  try {
    if (GATE_SKIP.some((p) => req.path.startsWith(p))) return next();
    // CORS 预检（OPTIONS）无业务语义，直接放行，避免跨域直连时预检被闸门拒绝
    if (req.method === 'OPTIONS') return next();
    // 仅放行搜索引擎爬虫的 GET 只读请求（IP 反向 DNS 核验防伪造）
    if (req.method === 'GET' && isSearchBot(req.headers['user-agent'])) {
      const v = await verifyCrawlerIp(req.ip, req.headers['user-agent']);
      if (v.ok) return next();
      // 伪造爬虫：UA 声称是搜索爬虫但 IP 归属不匹配 → 计罚并拒绝
      report(req.ip, 'waf', `FAKE-CRAWLER ${req.path}`);
      return res.status(403).json({ code: 1, message: '访问被拒绝' });
    }
    const ua = String(req.headers['user-agent'] || '');
    if (!ua) {
      report(req.ip, 'waf', '空 UA');
      return res.status(403).json({ code: 1, message: '访问被拒绝' });
    }
    // HEAD 与 GET 同为只读语义，只需票据（CDN 探测/预检/监控探活均发 HEAD）
    if (req.method === 'GET' || req.method === 'HEAD') return gateRequired(req, res, next);
    return gateWriteRequired(req, res, next);
  } catch (e) {
    // 异步异常兜底：拒绝而非挂起（防中间件抛错导致请求悬挂）
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
});

// 管理员操作审计（记录已认证用户的写操作）
app.use(api, audit);

// 写请求统一防护：Referer 校验（防跨站直调）+ 时间戳防重放
// （/anti 为引导接口，隐私模式浏览器可能无 Referer，由限流+签名令牌兜底）
app.use(api, (req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && !GATE_SKIP.some((p) => req.path.startsWith(p))) {
    return refererRequired(req, res, () => timestampRequired(req, res, next));
  }
  next();
});

// 静态资源：上传文件（安全 serve —— 禁用目录列表、强制 nosniff、SVG 防执行；前置限流防刷带宽）
app.use(
  '/uploads',
  uploadsLimiter,
  express.static(config.uploadDir, {
    dotfiles: 'deny',
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
      // 上传资源允许跨站读取：保证社交平台/分享卡片能抓取 OG 图片（API 已收紧为 same-origin）
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      // 文件名服务端随机生成且不可变 → 可长缓存（7 天 + immutable）
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      if (filePath.toLowerCase().endsWith('.svg')) {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  })
);

// robots.txt 根路径（搜索引擎标准位置）
app.get('/robots.txt', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  try {
    return res.send(await robotsTxt(req));
  } catch (e) {
    return res.send('User-agent: *\nDisallow: /\n');
  }
});

// security.txt（安全研究人员联系信息，行业标准位置）
app.get('/.well-known/security.txt', async (req, res) => {
  const { getAllSettings } = require('./utils/settings');
  let contact = '';
  try {
    const settings = await getAllSettings();
    contact = settings.social_email || '';
  } catch (e) { /* 忽略 */ }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  // Expires 动态计算：RFC 9116 要求不超过一年 —— 恒为「当前日期 + 1 年」，免手动更新
  const expires = new Date(Date.now() + 365 * 86400e3).toISOString();
  return res.send([
    '# Xalor的小站 安全策略',
    '# 本站启用 PoW 闸门、请求签名、应用层 WAF、IP 信誉与可选两步验证',
    '# 发现漏洞请联系站长（请勿进行破坏性测试）',
    contact ? `Contact: mailto:${contact}` : 'Contact: https://example.com/about',
    'Preferred-Languages: zh-CN, en',
    `Expires: ${expires}`,
    '',
  ].join('\n'));
});

app.use(`${api}/health`, healthRouter);
app.use(`${api}/anti`, antiRouter);
app.use(`${api}/auth`, strictLimiter, authRouter);
app.use(`${api}/articles`, antiBot, readLimiter, articlesRouter);
app.use(`${api}/categories`, antiBot, categoriesRouter);
app.use(`${api}/tags`, antiBot, tagsRouter);
app.use(`${api}/comments`, commentsRouter);
app.use(`${api}/links`, strictLimiter, linksRouter);
app.use(`${api}/messages`, strictLimiter, messagesRouter);
app.use(`${api}/stats`, antiBot, statsRouter);
app.use(`${api}/settings`, settingsRouter);
// 管理后台全部接口（文章/分类/标签/评论/友链/留言/统计/设置/上传/安全中心）：
// 统一挂载在由 JWT_SECRET 派生的秘钥路径下（非固定 /admin），
// 公共前缀下探测不到任何后台接口（与 404 同形，路由存在性不可枚举）
app.use(`${api}/${config.adminPath}`, adminRouter);

// RSS / Sitemap / 分享页（放行爬虫，便于收录与社交预览）
// 附限流：全文 RSS 与分享页是公开放行通道，无限流会被脚本刷取全站正文/带宽；
// 超限同样计入 IP 信誉（rate 权重 2）—— 脚本以 1 req/s 稳定拖取全站内容时
// 持续超限 → 积分累积 → 自动封禁（此前限流不积分，换 IP 可无限拖取）
const rssLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    report(req.ip, 'rate', 'RSS 高频读取');
    res.status(429).json({ code: 1, message: '读取过于频繁，请稍后再试' });
  },
});
const shareLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    report(req.ip, 'rate', '分享页高频读取');
    res.status(429).json({ code: 1, message: '读取过于频繁，请稍后再试' });
  },
});
app.use(`${api}`, rssLimiter, feedRouter);
app.use(`${api}`, shareLimiter, shareRouter);

// 404：与 403 返回同一形态，避免接口探测识别
app.use((req, res) => {
  res.set('Cache-Control', 'no-store');
  // 目录爆破检测：短时间大量访问不存在路径 → 计入信誉积分
  if (recordMiss(req.ip, req.path)) {
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  res.status(404).json({ code: 1, message: '访问被拒绝' });
});

// 错误处理：对外统一脱敏，不泄露内部细节
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.message === '不允许的跨域来源') {
    report(req.ip, 'waf', '非法跨域来源');
    return res.status(403).json({ code: 1, message: err.message });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ code: 1, message: '文件大小超过 5MB 限制' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.message === '仅支持图片文件') {
    return res.status(400).json({ code: 1, message: err.message || '上传文件不合法' });
  }
  if (err.type === 'entity.too.large') {
    report(req.ip, 'rate', '超大请求体');
    return res.status(413).json({ code: 1, message: '请求体过大' });
  }
  if (err.type === 'entity.parse.failed') {
    report(req.ip, 'waf', '非法 JSON');
    return res.status(400).json({ code: 1, message: '请求格式不合法' });
  }
  console.error(`[error] rid=${req.requestId || '-'}`, err.message);
  res.status(500).json({ code: 1, message: '服务器开小差了，请稍后再试' });
});

module.exports = app;
