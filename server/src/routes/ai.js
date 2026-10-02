/**
 * 公开 AI 接口：博客页面 Agent（读者问答）
 *
 * 定位：读者在文章页就这篇文章提问，AI 只根据**这一篇**的内容回答。
 * 三条硬约束（这块直接暴露给访客，比管理端危险得多）：
 *   1. 只读 —— AI 拿不到任何写能力，上下文里只有这一篇文章；
 *   2. 限流 —— 每次问答都烧 token，按 IP 限次 + 限制同一 IP 并发，防刷爆账单；
 *   3. 不许编 —— 文章里没有的信息必须直说没有，避免被当成站方发言。
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

function buildSystemPrompt(article) {
  const raw = String(article.content || '');
  const body = raw.length > MAX_ARTICLE_CHARS ? `${raw.slice(0, MAX_ARTICLE_CHARS)}\n\n（正文过长，以上为节选）` : raw;
  return [
    '你是「Xalor的小站」这篇文章的阅读助手，回答读者关于这篇文章的问题。',
    '',
    '规则：',
    '- 只依据下面这篇《' + (article.title || '') + '》的内容回答。',
    '- 文章里没有写到的信息，直接说「文章里没有提到」，不要凭常识补、不要编。',
    '- 回答用中文、口语、简短：一般两三句话讲完，最多一小段。',
    '- 可以用简单的 Markdown（**加粗**、短列表、行内代码）；涉及代码用代码块。',
    '- 不要复述整篇文章，不要小标题式长篇大论，不要「希望对你有帮助」这类客套话。',
    '- 与文章完全无关的问题（写代码、查资料、闲聊），一句话说明你只能聊这篇的内容。',
    '',
    '文章正文（Markdown）：',
    body,
  ].join('\n');
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

    const payload = [
      { role: 'system', content: buildSystemPrompt(article) },
      ...trimHistory(req.body?.history),
      { role: 'user', content: question },
    ];

    for await (const ev of streamChat({ messages: payload, maxTokens: 800, signal: ac.signal })) {
      if (ev.type === 'text') send({ type: 'text', text: ev.text });
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
