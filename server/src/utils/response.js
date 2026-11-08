/** 统一 API 响应格式 */
function ok(res, data = null, message = 'ok') {
  return res.json({ code: 0, message, data });
}

/**
 * 统一失败响应。**5xx 一律留痕**。
 *
 * 为什么在这里记：全项目有 **104 处** `catch (e) { return fail(res, 'XXX失败', 500) }`，
 * 只有 9 处自己调了 `console.error`。也就是说线上真出 5xx 时，
 * 服务端日志里什么都没有 —— 只知道用户收到了「获取文章失败」，
 * 不知道是 SQL 报错、连接断了还是代码 bug。排查只能靠猜。
 *
 * 在 `fail()` 里按状态码分流是一处改动覆盖这 104 个出口：
 *   - `status >= 500` → 服务端问题，必须留痕（带接口方法+路径，能直接定位入口）；
 *   - `< 500` → 是「用户请求不合法」或「资源不存在」，这是预期结果，
 *     记 error 只会把真正的故障淹没在噪音里；
 *   - `status === 404` 走 notFound()，同样不记。
 *
 * 注意这里拿不到异常对象（`fail` 只收到业务文案），所以记的是「哪条路失败」而不是堆栈。
 * 需要堆栈的地方仍然要自己 `console.error(e)` —— 但至少不会再出现「整个接口一声不响」。
 */
function fail(res, message = '请求失败', status = 400, data = null) {
  if (status >= 500) {
    const where = res && res.req ? `${res.req.method} ${res.req.originalUrl || res.req.url || ''}` : '(未知请求)';
    console.error(`[api ${status}] ${where} — ${message}`);
  }
  return res.status(status).json({ code: 1, message, data });
}

/** 404 也保持 {code,message,data} 同形。
 *  原来这里少了 data 键，前端在 404 分支读 res.data.xxx 会拿到 undefined，
 *  而 ok/fail 恒给 null —— 「缺键」与「值为 null」在 `in`/解构默认值下行为不同，
 *  排查时很容易误判成"接口返回结构变了"。 */
function notFound(res, message = '资源不存在') {
  return res.status(404).json({ code: 1, message, data: null });
}

module.exports = { ok, fail, notFound };
