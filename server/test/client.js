/**
 * 反爬测试客户端：模拟浏览器完整流程
 * 指纹 → PoW 求解 → 票据 → 签名请求 → 内容解密
 * 用于安全回归测试与反爬机制验证
 */
const http = require('http');

const BASE = process.env.TEST_BASE || 'http://localhost:3000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
let fp = process.env.TEST_FP || 'a'.repeat(64); // 默认稳定指纹

function sha256hex(s) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hmac(key, data) {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function req(method, path, { body, headers = {}, ticket, silent = false, ua } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const h = {
      'User-Agent': ua || UA,
      'X-Fp': fp,
      ...headers,
    };
    if (data) h['Content-Type'] = 'application/json';
    if (ticket) {
      const ts = Date.now();
      const nonce = Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 6);
      const bodyHash = sha256hex(data || '{}');
      // 签名路径 = 挂载点相对路径（服务端 req.path 相对 api 挂载点，去掉前缀）
      const sigPath = path.replace(/^\/api(?=\/)/, '');
      const sig = hmac(ticket, `${method.toUpperCase()}|${sigPath}|${ts}|${bodyHash}|${ticket.split('.')[1]}|${nonce}`);
      h['X-Pass'] = ticket;
      h['X-Timestamp'] = String(ts);
      h['X-Nonce'] = nonce;
      h['X-Sig'] = sig;
    }
    const r = http.request(u, { method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        if (!silent && res.statusCode >= 400) {
          console.log(`  ↳ ${method} ${path} → ${res.statusCode} ${json ? JSON.stringify(json).slice(0, 160) : buf.slice(0, 160)}`);
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf });
      });
    });
    r.on('error', reject);
    r.setTimeout(10000, () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

/** 判断 hex digest 是否满足前导零 bits 位（与服务端/前端 bit 语义一致） */
function digestHasLeadingZeros(hexDigest, bits) {
  const bytes = Buffer.from(hexDigest, 'hex');
  if (bytes.length < 32) return false;
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (bytes[i] !== 0) return false;
  const remain = bits % 8;
  if (remain > 0 && (bytes[full] >> (8 - remain)) !== 0) return false;
  return true;
}

/** 获取并求解 PoW 挑战，换取票据（并发安全：显式传指纹，不依赖全局变量） */
async function getTicket(forceFp, customUa) {
  const useFp = forceFp || fp;
  const pz = await req('GET', '/api/anti/puzzle', { headers: { 'X-Fp': useFp }, ua: customUa });
  if (pz.status !== 200 || !pz.body || !pz.body.data) {
    throw new Error('挑战签发失败: ' + JSON.stringify(pz.body));
  }
  const { id, prefix, difficulty } = pz.body.data;
  // 求解：SHA-256(prefix:solution) 前导零 bit 数 = difficulty
  let solution = '';
  for (let i = 0; i < 50000000; i++) {
    const s = String(i);
    if (digestHasLeadingZeros(sha256hex(prefix + ':' + s), difficulty)) { solution = s; break; }
  }
  if (!solution) throw new Error('PoW 求解失败');
  const t = await req('POST', '/api/anti/ticket', {
    body: { id, solution },
    headers: { 'X-Fp': useFp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' },
    ua: customUa,
  });
  if (t.status !== 200 || !t.body || !t.body.data || !t.body.data.token) {
    throw new Error('票据签发失败: ' + JSON.stringify(t.body));
  }
  return t.body.data.token;
}

/** 获取表单签名令牌（绑定指纹/UA/目标路径） */
async function getFormToken(ticket, forPath = '/comments', options = {}) {
  const r = await req('GET', '/api/anti/seed?for=' + encodeURIComponent(forPath), {
    ticket,
    headers: { 'X-Fp': options.fp || fp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/', ...(options.headers || {}) },
  });
  if (r.status !== 200 || !r.body || !r.body.data) {
    throw new Error('表单令牌签发失败: ' + JSON.stringify(r.body));
  }
  return r.body.data;
}

/** 带票据的 GET（读接口） */
async function get(path, opts = {}) {
  return req('GET', path, { ticket: opts.ticket || opts, ...(opts.ticket ? {} : opts), silent: opts.silent });
}

/** 带签名票据的写请求 */
async function post(path, body, ticket, extraHeaders = {}) {
  return req('POST', path, { body, ticket, headers: extraHeaders });
}

/** multipart/form-data 上传（模拟浏览器表单上传图片） */
function uploadFile(path, fileBuffer, filename, mime, ticket, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----XalorTest' + Math.random().toString(36).slice(2);
    const u = new URL(BASE + path);
    const data = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const h = {
      'User-Agent': UA,
      'X-Fp': fp,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...extraHeaders,
    };
    if (ticket) {
      // 签名：multipart 请求的 bodyHash 按空对象计算（与前端 FormData 行为一致）
      const ts = Date.now();
      const nonce = Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 6);
      const sigPath = path.replace(/^\/api(?=\/)/, '');
      const sig = hmac(ticket, `POST|${sigPath}|${ts}|${sha256hex('{}')}|${ticket.split('.')[1]}|${nonce}`);
      h['X-Pass'] = ticket;
      h['X-Timestamp'] = String(ts);
      h['X-Nonce'] = nonce;
      h['X-Sig'] = sig;
    }
    const r = http.request(u, { method: 'POST', headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    r.write(data);
    r.end();
  });
}

/** 完整表单提交流程：票据 + 表单令牌 + 2 秒最小间隔（opts.fp 可指定自定义指纹） */
async function formPost(path, body, ticket, opts = {}) {
  const forPath = (opts.forPath || path).replace(/^\/api/, '');
  const useFp = opts.fp || fp;
  const seed = await getFormToken(ticket, forPath, { ...opts, fp: useFp });
  // 模拟人类填写间隔（≥2s）
  await new Promise((r) => setTimeout(r, opts.minInterval || 2100));
  const hpField = seed.hp_field;
  const formBody = { ...body, form_token: seed.token };
  let hpBody = formBody;
  const hpHeaders = { 'X-Fp': useFp, Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/', ...(opts.headers || {}) };
  if (opts.fillHoneypot) {
    // 蜜罐字段：真实用户看不到该字段不填；机器人填了 → 服务端靠 X-Hp-Field 头识别
    hpBody = { ...formBody, [hpField]: 'http://spam.example.com' };
    hpHeaders['X-Hp-Field'] = hpField;
  }
  return req('POST', path, {
    body: hpBody,
    ticket,
    headers: hpHeaders,
  });
}

/** 伪装爬虫 UA */
async function asBotUA(path, ua = 'python-requests/2.31', method = 'GET') {
  return req(method, path, { headers: { 'User-Agent': ua } });
}

module.exports = { req, getTicket, getFormToken, formPost, uploadFile, get, post, asBotUA, sha256hex, digestHasLeadingZeros, hmac, UA };
