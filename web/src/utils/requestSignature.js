/**
 * 请求签名：全站**唯一**实现（X-Sig）。
 *
 * 签名串： HMAC-SHA256(key = 票据本身, `METHOD|path|ts|bodyHash|jti|nonce`)
 * bodyHash： SHA-256(`JSON.stringify(body)`)，空 body 记作 `{}`
 *
 * 为什么要有这个文件：`api/index.js` 与 `utils/signedFetch.js` 原先各抄了
 * 一份逐行相同的 HMAC 实现，随后开始分叉（signedFetch 侧没有超时、不解析业务码、
 * 不处理 401/403/429、没有票据刷新后重试，未登录时还会发出 `"Bearer "`）。
 * 口径一旦不一致，`server/src/middleware/gate.js` 的 verifySig() 会让整站 403 ——
 * 所以这里必须与服务端逐字对应，改之前先读那一段：
 *
 *   服务端 bodyHash = sha256hex(JSON.stringify(req.body || {}))
 *   服务端 path     = decodeURIComponent(req.path)   // 挂载点相对路径
 *   服务端 msg      = [METHOD, path, ts, bodyHash, ticket.jti, nonce].join('|')
 *
 * ⚠ `path` 这一项的两种口径不能混：
 *   - axios 侧 `config.url` 是相对 baseURL 的路径（**不含** /api 前缀）
 *     → `stripApiPrefix: false`
 *   - fetch 侧传的是完整 URL（**含** /api 前缀）
 *     → `stripApiPrefix: true`
 *   服务端比对的是挂载点相对路径；前缀没剥掉会永远对不上（实测全线 403）。
 *
 * ⚠ bodyHash 里字符串按**原样**参与哈希，不再包一层 JSON.stringify：
 *   传进来的字符串本来就该是已经序列化好的正文（与 fetch 的 body 同义）。
 *   对象/数组走 JSON.stringify，与 `undefined`/`null` 统一记作 `{}`。
 */

// 接口前缀与后端一致（生产可改为随机字符串，前端同环境变量注入）。
// 写成 `import.meta.env && …` 是为了让本文件能直接在纯 node 下 import
// 做签名一致性自检（node 里没有 import.meta.env）；Vite 构建期照常内联。
const API_PREFIX = (import.meta.env && import.meta.env.VITE_API_PREFIX) || '/api';

/** 16 字节随机 hex（nonce 防重放，服务端按 SIG_WINDOW 记账） */
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key, msg) {
  // ⚠ 票据为空时必须**主动抛一个说得清的错**，不能让它流到 importKey。
  //
  // 实测：`crypto.subtle.importKey('raw', new Uint8Array(0), {HMAC...})` 抛
  // `DataError: Zero-length key is not supported`。而服务端用的是 Node 的
  // `createHmac('sha256', '')` —— **空 key 是允许的**，于是两侧行为不一致。
  //
  // 触发路径真实存在：`getTicket()` 在 PoW 完成前返回 ''，而页面加载后
  // 立刻就有请求发出（如表单令牌预热）。此前这条路上用户看到的是
  // 拦截器兜底的「网络错误」，完全看不出根因是"还没拿到票据"。
  //
  // 不改成"用占位 key 算出一个签名"：那会和服务端口径不符，照样 403，
  // 而且错得更隐蔽。宁可早失败、错得明白。
  if (!key) {
    throw new Error('尚未取得访问票据（PoW 未完成），无法签名请求');
  }
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 参与签名的 path：先去掉 query，再（可选）剥掉接口前缀。
 * 剥完为空时回退 '/'（服务端 req.path 对根路径就是 '/'）。
 */
function sigPath(url, stripApiPrefix) {
  const path = String(url || '').split('?')[0];
  if (!stripApiPrefix) return path;
  const prefix = API_PREFIX.replace(/\/+$/, '');
  if (!prefix || !path.startsWith(prefix)) return path;
  const rest = path.slice(prefix.length);
  // ⚠ 剥完之后必须以 '/' 开头（或本身为空）才算真的剥掉了前缀。
  //
  // 旧实现只看 `startsWith(prefix)`，而那是**字符串**前缀匹配 ——
  // `/apifoo/articles` 也"以 /api 开头"，于是被剥成 `/foo/articles`。
  // 服务端 req.path 是 `/apifoo/articles`（Express 只挂在 /api 下），
  // 两侧对不上 → 那个请求永远 403，而错误信息只会说「请求签名无效」。
  //
  // 实测：`sigPath('/apifoo/articles', true)` 旧实现给 `/foo/articles`，
  // 新给 `/apifoo/articles`（原样返回，因为不是一个完整的前缀段）。
  if (rest === '') return '/';
  return rest.startsWith('/') ? rest : path;
}

/** body 的哈希口径：undefined/null → '{}'，字符串原样，其余 JSON.stringify */
function bodyHashInput(data) {
  if (data === undefined || data === null) return '{}';
  return typeof data === 'string' ? data : JSON.stringify(data);
}

/**
 * 生成一次请求签名。
 *
 * @param {object}  opts
 * @param {string}  opts.ticket          票据（JWT 字符串），同时充当 HMAC key
 * @param {string}  opts.method          HTTP 方法（大小写不敏感）
 * @param {string}  opts.url             请求 URL 或相对路径（query 会被忽略）
 * @param {*}       opts.data            请求体：undefined/null/字符串/对象
 * @param {boolean} [opts.stripApiPrefix] url 带 VITE_API_PREFIX 前缀时置 true
 * @returns {Promise<{ts: string, sig: string, nonce: string, jti: string}>}
 */
export async function buildRequestSignature({ ticket, method, url, data, stripApiPrefix = false }) {
  // 票据是 `header.payload.signature`，服务端把 payload 段（jti）也纳入签名
  const jti = ticket ? ticket.split('.')[1] || '' : '';
  const ts = String(Date.now());
  const nonce = randomHex(16);
  const bodyHash = await sha256Hex(bodyHashInput(data));
  const path = sigPath(url, stripApiPrefix);
  const msg = [String(method || 'GET').toUpperCase(), path, ts, bodyHash, jti, nonce].join('|');
  const sig = await hmacHex(ticket, msg);
  return { ts, sig, nonce, jti };
}
