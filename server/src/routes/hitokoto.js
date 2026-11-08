const express = require('express');
const { ok, fail } = require('../utils/response');

const router = express.Router();

const UPSTREAM = 'https://v1.hitokoto.cn/?encode=json&charset=utf-8';
let cache = { text: '', at: 0 };
const CACHE_MS = 8000;

function formatQuote(data) {
  const quote = String(data?.hitokoto || '').trim();
  if (!quote) return '';
  const from = String(data.from || '').trim();
  return (from ? `${quote} —— ${from}` : quote).slice(0, 120);
}

router.get('/', async (req, res) => {
  if (cache.text && Date.now() - cache.at < CACHE_MS) {
    return ok(res, { hitokoto: cache.text });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  /**
   * 降级出口：**有缓存就给缓存，没有才 502**。
   *
   * 修的是一个不对称：原来只有 `catch` 分支会回落到缓存，而「上游返回非 2xx」直接 502 ——
   * 上游限流/维护时最常见的就是 5xx，于是首页那句引言会**在明明有缓存的情况下变空**。
   * 现在三条失败路径（非 2xx / 空内容 / 抛异常）都走同一个出口。
   */
  const degrade = () => (cache.text ? ok(res, { hitokoto: cache.text }) : fail(res, '一言暂时不可用', 502));

  try {
    const upstream = await fetch(UPSTREAM, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!upstream.ok) return degrade();
    const data = await upstream.json();
    const text = formatQuote(data);
    if (!text) return degrade();
    cache = { text, at: Date.now() };
    return ok(res, { hitokoto: text });
  } catch (e) {
    return degrade();
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
