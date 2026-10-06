/**
 * 公开 AI 接口：博客页面 Agent（读者问答）
 *
 * 定位：读者在文章页就这篇文章提问，AI 以**这一篇**为主、可检索站内其他文章，
 * 联网搜索按后台开关提供。
 * 三条硬约束（这块直接暴露给访客，比管理端危险得多）：
 *   1. 只读 —— AI 拿不到任何写能力，工具仅限站内检索/网页搜索，且全部服务端执行；
 *   2. 限流 —— 每次问答都烧 token，按 IP 限次 + 限制同一 IP 并发 + 工具轮数封顶；
 *   3. 不许编 —— 工具查不到就直说没有，避免被当成站方发言。
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { streamChat } = require('../utils/aiClient');

const router = express.Router();

/** 每 IP 每小时 20 次问答：正常读者读一篇文章不会问这么多，脚本刷不动 */
const askLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '提问次数已达上限，请稍后再试' },
});

/** 同一 IP 同时只允许一个问答在进行：并发刷会同时烧多份 token */
const inflight = new Map(); // ip -> count
const MAX_INFLIGHT_PER_IP = 1;

/** 正文最多喂给模型的长度（字符），防超长文章把 token 打满 */
const MAX_ARTICLE_CHARS = 8000;
/** 历史轮数上限 */
const MAX_HISTORY = 6;
/** 工具轮数上限：一轮问答最多检索两次，防循环烧 token */
const MAX_TOOL_ROUNDS = 2;

/** 工具结果消息截断（字符） */
const MAX_TOOL_RESULT_CHARS = 4000;

/** 读者侧可用工具（只读）：站内检索始终可用，网页搜索按后台开关注入 */
const TOOL_SITE_SEARCH = {
  type: 'function',
  function: {
    name: 'search_site_articles',
    description: '检索本站已发布的其他文章（标题/摘要匹配）。当读者的问题超出本文内容、或想知道站内是否有相关文章时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
      },
      required: ['query'],
    },
  },
};
const TOOL_WEB_SEARCH = {
  type: 'function',
  function: {
    name: 'search_web',
    description: '联网搜索公开网页。仅当读者明确询问文章之外的事实/资讯/较新的信息且站内无法回答时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
  },
};

function buildSystemPrompt(article, { webSearch = false } = {}) {
  const raw = String(article.content || '');
  const body = raw.length > MAX_ARTICLE_CHARS ? `${raw.slice(0, MAX_ARTICLE_CHARS)}\n\n（正文过长，以上为节选）` : raw;
  return [
    '你是「Xalor的小站」这篇文章的阅读助手，回答读者关于这篇文章的问题。',
    '',
    '规则：',
    '- 优先只依据下面这篇《' + (article.title || '') + '》的内容回答。',
    '- 文章里没有写到的信息：可先用工具检索站内其他文章或联网查询；',
    webSearch
      ? '  可用工具有两个：search_site_articles（站内检索）和 search_web（联网搜索）。'
      : '  可用工具只有一个：search_site_articles（站内检索）；联网搜索未开启，不要假装查过网页。',
    '- 引用工具结果时向读者说明信息来自站内其他文章或网络，不要混充成本文内容。',
    '- 工具仍无法回答时，直接说没有相关信息，不要凭常识补、不要编。',
    '- 回答用中文、口语、简短：一般两三句话讲完，最多一小段。',
    '- 可以用简单的 Markdown（**加粗**、短列表、行内代码）；涉及代码用代码块。',
    '- 不要复述整篇文章，不要小标题式长篇大论，不要「希望对你有帮助」这类客套话。',
    '',
    '文章正文（Markdown）：',
    body,
  ].join('\n');
}

/** 工具执行（服务端执行，不信任任何客户端回传的工具结果） */
async function execAskTool(name, args, settings) {
  if (name === 'search_site_articles') {
    const q = String(args?.query || '').trim().slice(0, 100);
    if (!q) return { ok: false, note: '缺少检索词' };
    const like = `%${q}%`;
    const rows = await db('articles')
      .where('status', 'published')
      .andWhere((b) => b.where('title', 'like', like).orWhere('summary', 'like', like))
      .orderBy('created_at', 'desc')
      .limit(5)
      .select('title', 'slug', 'summary', 'created_at');
    return {
      ok: true,
      results: rows.map((r) => ({
        title: r.title,
        slug: r.slug,
        summary: String(r.summary || '').slice(0, 120),
        date: r.created_at,
      })),
    };
  }
  if (name === 'search_web') {
    if (settings.websearch_enabled !== true) return { ok: false, note: '本站未开启联网搜索' };
    const { searchWeb } = require('../utils/webSearch');
    const r = await searchWeb(args?.query, { apiKey: settings.websearch_api_key });
    return r.ok ? { ok: true, results: r.results } : { ok: false, note: r.error || '搜索失败' };
  }
  return { ok: false, note: '未知工具' };
}

/** 只保留最近的读者提问/回答，单条截断 */
function trimHistory(history) {
  const list = Array.isArray(history) ? history : [];
  return list
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) }));
}

/** 读者就当前文章提问（SSE 流式） */
router.post('/ask', askLimiter, async (req, res) => {
  const ip = req.ip || 'unknown';
  const running = inflight.get(ip) || 0;
  if (running >= MAX_INFLIGHT_PER_IP) {
    return res.status(429).json({ code: 1, message: '上一个问题还没答完，稍等一下' });
  }
  inflight.set(ip, running + 1);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      /* 连接已断 */
    }
  };
  const release = () => {
    const n = (inflight.get(ip) || 1) - 1;
    if (n <= 0) inflight.delete(ip);
    else inflight.set(ip, n);
  };

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const slug = String(req.body?.slug || '').slice(0, 220);
    const question = String(req.body?.question || '').trim().slice(0, 500);
    if (!slug || !question) {
      send({ type: 'error', message: '缺少文章或问题' });
      return res.end();
    }

    const article = await db('articles')
      .where('slug', slug)
      .where('status', 'published')
      .first('title', 'content');
    if (!article) {
      send({ type: 'error', message: '文章不存在' });
      return res.end();
    }

    const { getAllSettings } = require('../utils/settings');
    const settings = await getAllSettings();
    const webSearchOn = settings.websearch_enabled === true;
    const tools = webSearchOn ? [TOOL_SITE_SEARCH, TOOL_WEB_SEARCH] : [TOOL_SITE_SEARCH];

    const messages = [
      { role: 'system', content: buildSystemPrompt(article, { webSearch: webSearchOn }) },
      ...trimHistory(req.body?.history),
      { role: 'user', content: question },
    ];

    // 工具循环：模型可检索后作答；工具全部服务端执行，结果不落前端
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const toolCalls = [];
      for await (const ev of streamChat({ messages, tools, maxTokens: 800, signal: ac.signal })) {
        if (ev.type === 'text') send({ type: 'text', text: ev.text });
        else if (ev.type === 'tool') toolCalls.push(ev);
      }
      if (!toolCalls.length || round === MAX_TOOL_ROUNDS) break;

      // 以原始参数串回放 assistant.tool_calls（协议要求与模型产出一致）
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.raw },
        })),
      });
      for (const t of toolCalls) {
        send({ type: 'status', text: t.name === 'search_web' ? '正在搜索网页…' : '正在检索站内文章…' });
        let result;
        try {
          result = await execAskTool(t.name, t.args, settings);
        } catch (e) {
          result = { ok: false, note: '工具执行失败' };
        }
        messages.push({
          role: 'tool',
          tool_call_id: t.id,
          content: JSON.stringify(result).slice(0, MAX_TOOL_RESULT_CHARS),
        });
      }
    }
    send({ type: 'done' });
  } catch (e) {
    // 未配置模型时给出可读提示，而不是把原始错误抛给访客
    const msg = e.code === 'AI_NOT_CONFIGURED' ? '本站还没开启 AI 问答' : '回答失败，请稍后再试';
    send({ type: 'error', message: msg });
  } finally {
    release();
    res.end();
  }
});

/** 前台据此决定是否显示「问 AI」入口（未配模型时不显示，避免点了报错） */
router.get('/status', async (req, res) => {
  const { getAiConfig } = require('../utils/aiClient');
  const ai = await getAiConfig().catch(() => ({ ready: false }));
  return res.json({ code: 0, message: 'ok', data: { ready: ai.ready === true } });
});

module.exports = router;
