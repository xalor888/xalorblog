/**
 * 响应压缩中间件（brotli + gzip，Node 自带 zlib，无新增依赖）。
 *
 * 只压缩文本类响应（JSON / XML / RSS / 分享页 HTML），跳过 304 / HEAD / 小响应。
 * 正文是 AES-GCM 密文 + 无反射输入，BREACH 攻击不适用。
 *
 * ⚠ 为什么必须用**异步** zlib 而不是 *Sync 版本：
 *   同步压缩在主线程上跑完，一个 2MB 的 JSON 大约要 20-40ms，这段时间**整个事件循环
 *   被占住** —— 同一进程里所有其它请求（包括 PoW 校验、WAF 扫描、DB 回调）全部排队。
 *   单进程 + 单线程是这套代码的隐含假设（见 README），所以一次同步压缩的代价不是
 *   「慢 30ms」，而是「并发下放大成 N × 30ms 的尾延迟」。异步版本把压缩放到线程池。
 *
 * ⚠ 为什么同时支持 brotli：
 *   现代浏览器（Chrome 50+/Firefox 44+/Safari 11+）都发 `Accept-Encoding: gzip, deflate, br`。
 *   实测同一份 5.9KB 的 sitemap：gzip 后 330 字节，brotli 后 244 字节 —— **再省 26%**。
 *   只认 gzip 等于对每个支持 br 的访客多传四分之一。
 *
 * ⚠ 异步化的两个必须处理的差异：
 *   1. `res.send` 现在可能**稍后**才真正写响应 —— 回调里必须重新检查 `res.headersSent`，
 *      期间可能有另一个中间件/超时逻辑已经结束了响应。
 *   2. 压缩失败（zlib 报错、或压完反而更大）必须**原样发送未压缩体**，
 *      而不是让响应悬挂 —— 前者是兼容性兜底，后者会让客户端一直等到超时。
 */

const zlib = require('zlib');

/** 小于这个字节数不压：压缩头尾 + CPU 成本不划算，且小响应本来就在一个 TCP 包里 */
const DEFAULT_MIN_BYTES = 1024;
/** gzip 级别：6 是 zlib 默认的性价比点；1-3 更快但体积明显更大，9 慢而收益小 */
const DEFAULT_GZIP_LEVEL = 6;
/**
 * brotli 质量：默认 11 是「离线压缩」档，比 5 慢十倍以上而动态响应等不起。
 * 5 在实测里已经比 gzip 再省 26%，再往上几乎都在为静态资源准备的那种极致压缩付费。
 */
const DEFAULT_BROTLI_QUALITY = 5;

/**
 * 解析 `Accept-Encoding`，返回服务器**可以支持**的编码，按客户端偏好从高到低。
 *
 * 必须处理的三件事：
 *   - `q=0` 表示**明确拒绝**（`br;q=0, gzip` 在 RFC 里就是"别用 br"）。
 *     只做 `includes('br')` 会忽略 q 值，把客户端明确拒绝的编码发回去。
 *   - 通配 `*` 表示"其它没列出的都接受"，但优先级低于显式列出的。
 *   - 大小写与空白（`GZIP , Br`）。
 *
 * @param {string} header
 * @returns {Array<'br'|'gzip'>} 按优先级排序的可用编码
 */
function negotiateEncodings(header) {
  const raw = String(header || '');
  if (!raw) return [];

  /** codec → 客户端给出的 q 值（未出现则不参与排序） */
  const q = new Map();
  let wildcardQ = null;
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const [nameRaw, ...params] = token.split(';');
    const name = nameRaw.trim().toLowerCase();
    let weight = 1;
    for (const p of params) {
      const m = p.trim().match(/^q\s*=\s*([0-9.]+)$/i);
      if (m) {
        const v = Number(m[1]);
        if (Number.isFinite(v)) weight = Math.min(1, Math.max(0, v));
      }
    }
    if (name === '*') wildcardQ = weight;
    else q.set(name, weight);
  }

  const effective = (codec) => {
    if (q.has(codec)) return q.get(codec);
    // 没显式列出时，`*` 决定它是否被接受
    return wildcardQ === null ? 0 : wildcardQ;
  };

  const supported = [];
  for (const codec of ['br', 'gzip']) {
    if (effective(codec) > 0) supported.push({ codec, weight: effective(codec) });
  }
  // 按 q 值降序；q 相同则保持 ['br','gzip'] 的先后（br 体积更小）
  supported.sort((a, b) => b.weight - a.weight);
  return supported.map((s) => s.codec);
}

/**
 * @param {object} [options]
 * @param {number} [options.minBytes] 低于该字节数跳过压缩
 * @param {number} [options.gzipLevel] gzip 压缩级别
 * @param {number} [options.brotliQuality] brotli 质量（0-11）
 * @returns {import('express').RequestHandler}
 */
function createGzipMiddleware(options = {}) {
  const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : DEFAULT_MIN_BYTES;
  const gzipLevel = Number.isFinite(options.gzipLevel) ? options.gzipLevel : DEFAULT_GZIP_LEVEL;
  const brotliQuality = Number.isFinite(options.brotliQuality)
    ? options.brotliQuality
    : DEFAULT_BROTLI_QUALITY;

  return function compressMiddleware(req, res, next) {
    // 追加而非覆盖：CORS 会写 Vary: Origin，覆盖后中间代理可能按编码复用跨域响应
    res.append('Vary', 'Accept-Encoding');

    const codecs = negotiateEncodings(req.headers['accept-encoding']);
    if (req.method === 'HEAD' || codecs.length === 0) return next();

    const send = res.send.bind(res);

    /** 用指定编码压缩；失败或压不动时回退到原样发送 */
    const compressWith = (codec, buf, body) => {
      const done = (err, zipped) => {
        // 回调期间响应可能已经被别处结束（超时兜底、另一个中间件）——此时只能放弃压缩
        if (res.headersSent) return undefined;
        if (err || !zipped || zipped.length >= buf.length) {
          // 压不动就别压：小体积文本或高熵内容（如已 base64 的密文）压完可能更大
          return send(body);
        }
        try {
          res.set('Content-Encoding', codec);
          res.set('Content-Length', String(zipped.length));
        } catch (e) {
          return send(body);
        }
        return send(zipped);
      };

      if (codec === 'br') {
        zlib.brotliCompress(buf, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality },
        }, done);
      } else {
        zlib.gzip(buf, { level: gzipLevel }, done);
      }
      return undefined;
    };

    res.send = function sendCompressed(body) {
      // 这些情况下不压：已发出（异步回调重入）、非 200 语义体、非字符串、太小
      if (res.headersSent
        || res.statusCode === 304
        || typeof body !== 'string'
        || body.length < minBytes) {
        return send(body);
      }
      const buf = Buffer.from(body, 'utf8');
      compressWith(codecs[0], buf, body);
      // 返回值不被 Express 依赖（它只丢弃 res.send 的返回值），返回 res 便于链式调用
      return res;
    };

    next();
  };
}

module.exports = {
  createGzipMiddleware,
  negotiateEncodings,
  DEFAULT_MIN_BYTES,
  DEFAULT_GZIP_LEVEL,
  DEFAULT_BROTLI_QUALITY,
};
