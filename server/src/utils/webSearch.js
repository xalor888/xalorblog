/**
 * 网页搜索适配器（Tavily）
 *
 * 设计要点：
 *   - API Key 存后台设置（websearch_api_key），留空回落服务器 .env 的 WEBSEARCH_API_KEY；
 *   - 9 秒超时 + 60 秒同词缓存（AI 一轮对话可能多次触发同一查询）；
 *   - 结果归一化为 { title, url, snippet }，截断防超长内容挤爆工具消息；
 *   - 只做一次出站 HTTPS 请求，不拼接任何用户可控 URL（无 SSRF 面）。
 */

'use strict';

const config = require('../config');

const TIMEOUT_MS = 9000;
const CACHE_TTL = 60 * 1000;
const CACHE_MAX = 200;

/** query -> { at, results } */
const cache = new Map();

/**
 * 网页搜索
 * @param {string} query 搜索关键词
 * @param {object} [opts]
 * @param {string} [opts.apiKey] Tavily API Key（后台设置优先，留空回落 env）
 * @param {number} [opts.maxResults] 返回条数（默认 5，上限 10）
 * @returns {Promise<{ok: boolean, results: Array<{title,url,snippet}>, error?: string, cached?: boolean}>}
 */
async function searchWeb(query, { apiKey = '', maxResults = 5 } = {}) {
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return { ok: false, error: '搜索词为空', results: [] };

  const key = String(apiKey || '').trim() || String(config.websearch?.apiKey || '').trim();
  if (!key) return { ok: false, error: '未配置网页搜索 API Key', results: [] };

  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return { ok: true, results: hit.results, cached: true };
  }

  const n = Math.min(Math.max(Number(maxResults) || 5, 1), 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // api_key 走 body（Tavily 官方参数），同时带 Bearer 兼容其网关鉴权
      body: JSON.stringify({
        api_key: key,
        query: q,
        max_results: n,
        search_depth: 'basic',
        include_answer: false,
        include_images: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let error = `搜索接口返回 ${res.status}${detail ? `：${detail.slice(0, 120)}` : ''}`;
      if (res.status === 401 || res.status === 403) error = '搜索 API Key 无效或已过期';
      else if (res.status === 432) error = '搜索配额已用尽';
      return { ok: false, error, results: [] };
    }
    const data = await res.json().catch(() => null);
    const results = (Array.isArray(data?.results) ? data.results : [])
      .slice(0, n)
      .map((r) => ({
        title: String(r?.title || '').slice(0, 200),
        url: String(r?.url || '').slice(0, 500),
        snippet: String(r?.content || '').replace(/\s+/g, ' ').slice(0, 400),
      }))
      .filter((r) => r.title && r.url);
    cache.set(q, { at: Date.now(), results });
    if (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '搜索超时' : '搜索请求失败', results: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { searchWeb };
