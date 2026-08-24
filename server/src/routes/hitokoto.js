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
  try {
    const upstream = await fetch(UPSTREAM, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!upstream.ok) return fail(res, '一言暂时不可用', 502);
    const data = await upstream.json();
    const text = formatQuote(data);
    if (!text) return fail(res, '一言暂时不可用', 502);
    cache = { text, at: Date.now() };
    return ok(res, { hitokoto: text });
  } catch (e) {
    if (cache.text) return ok(res, { hitokoto: cache.text });
    return fail(res, '一言暂时不可用', 502);
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
