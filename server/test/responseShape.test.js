/**
 * 统一响应形状（零 DB、零服务）。
 *
 * `ok / fail / notFound` 是**每个**路由的出口。它们的形状一旦漂移，前端拦截器
 * （`if (res.code === 0)`、`error.response.data.message`）就会集体失准 ——
 * 而失准的表现是"某个接口没提示"或"整个页面报错"，很难定位到是这里。
 *
 * 这组断言锁四件事：
 *   A. 成功/失败/404 三者的形状**完全同形**（三键齐全，`data` 键必须在）；
 *   B. `data` 缺键 vs 值为 null 的区别（`'data' in body` vs `body.data === null`）；
 *   C. 默认值与状态码；
 *   D. **全站路由不许绕过 helper 手写 res.json**（否则 A 的保证只对一半接口成立）。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const fs = require('fs');
const path = require('path');
const { stripCommentLines } = require('./helpers/sourceText');
const { ok, fail, notFound } = require('../src/utils/response');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 最小 res 替身：记录 status 与最终 json 体 */
function makeRes() {
  const out = { status: 200, body: null, statusCalls: [] };
  const res = {
    status(code) { out.status = code; out.statusCalls.push(code); return res; },
    json(payload) { out.body = payload; return res; },
  };
  return { res, out };
}
const keys = (o) => Object.keys(o).sort().join(',');

console.log('=== A. 三者形状完全同形 ===');
{
  const a = makeRes(); ok(a.res, { x: 1 });
  const b = makeRes(); fail(b.res, '出错了');
  const c = makeRes(); notFound(c.res);

  check('ok 的形状是 code/message/data', keys(a.out.body) === 'code,data,message', keys(a.out.body));
  check('fail 与 ok 完全同形（键集合一致）', keys(b.out.body) === keys(a.out.body),
    `${keys(b.out.body)} vs ${keys(a.out.body)}`);
  check('notFound 与 ok 完全同形', keys(c.out.body) === keys(a.out.body),
    `${keys(c.out.body)} vs ${keys(a.out.body)}`);
  check('404 的 data 键存在且为 null（不是缺键）',
    'data' in c.out.body && c.out.body.data === null);
}

console.log('\n=== B.「缺键」与「值为 null」必须区分清楚 ===');
{
  // 这条是 404 曾经的真实 bug：只给 {code, message}，前端解构 res.data.xxx 会崩。
  const c = makeRes(); notFound(c.res);
  check('用 in 能查到 data 键', 'data' in c.out.body);
  check('data 的值是 null 而不是 undefined', c.out.body.data === null);
  check('JSON 序列化后 data 仍存在（undefined 会整个键消失）',
    JSON.parse(JSON.stringify(c.out.body)).hasOwnProperty('data'),
    JSON.stringify(c.out.body));
}

console.log('\n=== C. 默认值、状态码、code 语义 ===');
{
  const a = makeRes(); ok(a.res);
  check('ok 默认 data 为 null', a.out.body.data === null);
  check('ok 默认 message 为 "ok"', a.out.body.message === 'ok');
  check('ok 的 code 是 0（前端只认 0 为成功）', a.out.body.code === 0);
  check('ok 不改状态码（默认 200）', a.out.status === 200 && a.out.statusCalls.length === 0);

  const b = makeRes(); fail(b.res);
  check('fail 默认 message', b.out.body.message === '请求失败');
  check('fail 默认状态码 400', b.out.status === 400);
  check('fail 的 code 是 1', b.out.body.code === 1);
  check('fail 默认 data 为 null', b.out.body.data === null);

  const c = makeRes(); notFound(c.res);
  check('notFound 状态码 404', c.out.status === 404);
  check('notFound 的 code 也是 1（前端不该把它当成功）', c.out.body.code === 1);
  check('notFound 默认 message', c.out.body.message === '资源不存在');
}

console.log('\n=== D. 参数顺序（fail 的 status 在 data 之前，容易传错） ===');
{
  const b = makeRes(); fail(b.res, '服务不可用', 503);
  check('第四个参数之前的 status 生效', b.out.status === 503, String(b.out.status));

  const b2 = makeRes(); fail(b2.res, '带数据', 422, { field: 'title' });
  check('data 作为第四个参数传入', b2.out.body.data && b2.out.body.data.field === 'title',
    JSON.stringify(b2.out.body.data));
  check('传入 data 时不会污染 message', b2.out.body.message === '带数据');

  const a = makeRes(); ok(a.res, { list: [] }, '自定义');
  check('ok 的 message 可覆盖', a.out.body.message === '自定义');
  check('ok 传空数组不会被当成"没传"（默认值只对 undefined 生效）',
    Array.isArray(a.out.body.data.list) && a.out.body.data.list.length === 0,
    JSON.stringify(a.out.body.data));

  const a2 = makeRes(); ok(a2.res, 0);
  check('ok 的 data 为 0 时不被默认值覆盖', a2.out.body.data === 0);
  const a3 = makeRes(); ok(a3.res, false);
  check('ok 的 data 为 false 时不被默认值覆盖', a3.out.body.data === false);
  const a4 = makeRes(); ok(a4.res, '');
  check('ok 的 data 为空串时不被默认值覆盖', a4.out.body.data === '');
}

console.log('\n=== E. 全站路由不许绕过 helper 手写 JSON 响应 ===');
{
  const ROUTES = path.join(__dirname, '..', 'src', 'routes');
  const files = fs.readdirSync(ROUTES).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      // 只看代码行：注释里可能提到写法示例
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (!/res\.json\(/.test(line)) return;
      // 排除「读取」而不是「发送」：`await res.json()` 是 fetch 客户端解析响应，
      // 出现在 admin.js 的备份恢复逻辑里，与服务端响应形状无关。
      if (/=\s*await\s+res\.json\(/.test(line)) return;
      // 允许：单纯转发 helper 的结果
      if (/\b(ok|fail|notFound)\s*\(/.test(line)) return;
      offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  check('没有路由手写 res.json 绕过 helper（形状由 response.js 单点决定）',
    offenders.length === 0, offenders.join(' | '));

  // 下载/导出类接口用 res.send(JSON.stringify(...)) 是合理的（不是 API 响应体）
  // 这类整文件断言一律剥注释：注释里复述写法会让断言假绿（本项目已发生过六次）。
  const adminSrc = stripCommentLines(fs.readFileSync(path.join(ROUTES, 'admin.js'), 'utf8'));
  check('文件下载/备份导出用 res.send(JSON.stringify)，不在上面的检查范围内',
    /res\.send\(JSON\.stringify\(/.test(adminSrc));

  // 反过来：每个 route 文件都真的用了 helper（防止新文件漏引）
  // 输出 XML / HTML 而不是 JSON 的路由不需要 JSON helper：
  //   feed.js  → sitemap.xml / rss.xml / robots.txt
  //   share.js → 给爬虫看的 HTML 落地页（meta + JSON-LD）
  const XML_HTML_ROUTES = new Set(['feed.js', 'share.js']);
  const noHelper = files.filter((f) => {
    if (XML_HTML_ROUTES.has(f)) return false;
    // 剥注释：否定断言「没引 helper」如果匹配到注释里的示例写法，会把真问题藏起来（假绿）
    const src = stripCommentLines(fs.readFileSync(path.join(ROUTES, f), 'utf8'));
    return /router\.(get|post|put|delete|patch)\(/.test(src)
      && !/require\('\.\.\/utils\/response'\)/.test(src);
  });
  check('所有有路由的文件都引了 utils/response', noHelper.length === 0, noHelper.join(', '));
}

console.log('\n=== F. 内容不被篡改（helper 只加壳，不改数据） ===');
{
  const payload = { id: 1, nested: { arr: [1, 2, 3] }, s: '中文' };
  const a = makeRes(); ok(a.res, payload);
  check('data 与传入对象相等（不是拷贝也不是字符串）',
    a.out.body.data === payload);
  check('嵌套结构原样', a.out.body.data.nested.arr.length === 3);
  check('中文不被转义成 \\u（http 层负责编码，helper 不该动）',
    a.out.body.data.s === '中文');
}


console.log('\n=== G. 5xx 必须留痕（104 处 catch 全靠这一处兜底） ===');
{
  // 项目里有 104 处 `catch (e) { return fail(res, 'XXX失败', 500) }` 没自己记日志。
  // 如果 fail() 也不记，线上出 5xx 时服务端日志里什么都没有 ——
  // 只知道用户收到了「获取文章失败」，不知道是 SQL 报错还是代码 bug。
  const origErr = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a.join(' '));

  const mkRes = (req) => ({
    req,
    status(c) { this._s = c; return this; },
    json(p) { this._p = p; return this; },
  });

  const r500 = mkRes({ method: 'GET', originalUrl: '/api/articles' });
  fail(r500, '获取文章失败', 500);
  check('500 记了一条 error 日志', captured.length === 1, String(captured.length));
  check('日志带状态码、方法、路径、文案',
    /\[api 500\]/.test(captured[0]) && /GET/.test(captured[0])
      && /\/api\/articles/.test(captured[0]) && /获取文章失败/.test(captured[0]),
    captured[0]);

  const before4xx = captured.length;
  fail(mkRes({ method: 'GET', originalUrl: '/api/x' }), '参数不合法', 400);
  check('400 不记日志（预期结果，记下来只会淹没真故障）', captured.length === before4xx);

  fail(mkRes({ method: 'POST', originalUrl: '/api/y' }), '非法请求', 403);
  check('403 不记日志', captured.length === before4xx);

  notFound(mkRes({ method: 'GET', originalUrl: '/api/z' }));
  check('404 不记日志', captured.length === before4xx);

  fail(mkRes({ method: 'GET', originalUrl: '/api/a' }), '上游超时', 502);
  check('502 也记（所有 5xx 一视同仁）', captured.length === before4xx + 1);
  fail(mkRes({ method: 'GET', originalUrl: '/api/b' }), '维护中', 503);
  check('503 也记', captured.length === before4xx + 2);

  console.error = origErr;

  // 响应体形状不能因为日志而变
  check('5xx 响应体仍是 {code:1,message,data:null}',
    JSON.stringify(r500._p) === '{"code":1,"message":"获取文章失败","data":null}',
    JSON.stringify(r500._p));
  check('5xx 状态码仍正确写出', r500._s === 500);

  // res.req 不存在时（单元测试里的简写 res）不能抛
  let threw = null;
  const beforeBare = captured.length;
  console.error = (...a) => captured.push(a.join(' '));   // 这条也会记日志，接住它免得污染测试输出
  try {
    const bare = { status(c) { this._s = c; return this; }, json() { return this; } };
    fail(bare, 'x', 500);
  } catch (e) { threw = e; }
  console.error = origErr;
  check('降级日志说明是「未知请求」', /未知请求/.test(captured[beforeBare] || ''), captured[beforeBare]);
  check('res 无 req 时不抛异常（降级记「未知请求」）', threw === null, threw && threw.message);

  // 自检：判定确实按状态码分流，不是恒真也不是恒假
  check('自检：4xx 与 5xx 的判定确实不同', before4xx === 1 && captured.length === 4);
}

console.log('\n【静态：全仓没有「手写错误响应缺 data」】');
{
  // 为什么值得扫：`fail()` / `notFound()` 都会给 data，而手写的 `res.status(...).json({code,message})`
  // 曾经有 77 处漏掉 data —— 前端在错误分支读 `res.data.data` 会拿到 undefined，
  // 与「键存在且为 null」在解构默认值/in 判定下行为不同，排查时极易误判成接口结构变了。
  const fs = require('fs');
  const path = require('path');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const offenders = [];
  for (const f of walk(path.join(__dirname, '..', 'src'))) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // 只看单行字面量；`{ code: 1, message, data }`（简写）与带 data 的不算
      // 「有 data」两种写法都要认：`data: null` 与对象简写 `{ code: 1, message, data }`
      if (/{ code: 1, message/.test(line) && !/\bdata\b/.test(line)) {
        offenders.push(`${path.relative(path.join(__dirname, '..'), f)}:${i + 1}`);
      }
    });
  }
  check('没有缺 data 的手写错误响应', offenders.length === 0, offenders.join(' | '));
  check('自检：这条判据能识别缺 data 的字面量', () => {
    const fake = "return res.status(403).json({ code: 1, message: 'x' });";
    return /{ code: 1, message/.test(fake) && !/\bdata\b/.test(fake);
  });
}

console.log(`\nresponseShape 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
