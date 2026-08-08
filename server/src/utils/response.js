/** 统一 API 响应格式 */
function ok(res, data = null, message = 'ok') {
  return res.json({ code: 0, message, data });
}

function fail(res, message = '请求失败', status = 400, data = null) {
  return res.status(status).json({ code: 1, message, data });
}

function notFound(res, message = '资源不存在') {
  return res.status(404).json({ code: 1, message });
}

module.exports = { ok, fail, notFound };
