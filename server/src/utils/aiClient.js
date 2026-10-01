/**
 * LLM 客户端（OpenAI 兼容协议）
 *
 * 配置优先级：后台设置 > 服务器 .env —— 与 utils/aiModeration 保持同一判据：
 *   api_key/base_url/model 留空即回落 env 的 AI_API_KEY / AI_BASE_URL / AI_MODEL。
 *
 * 能力：
 *   - streamChat()  流式对话，逐块产出文本或工具调用（供 SSE 接口转发）
 *   - chatOnce()    非流式，拿一次性完整回复
 *
 * 安全：baseUrl 强制 https（密钥与正文都不走明文，也杜绝指向内网的 SSRF 链）；
 * 所有请求带超时，客户端断开即中止上游请求（防悬挂连接吃内存）。
 */

'use strict';

const config = require('../config');
const { getAllSettings } = require('./settings');

const FALLBACK_BASE = 'https://api.openai.com/v1';
const FALLBACK_MODEL = 'gpt-4o-mini';
/** 单次请求上限：写作类长文生成留足时间，但不能无限挂 */
const TIMEOUT_MS = 90000;

/** 地址可用性：生产只允许 https（密钥与正文都不走明文，也杜绝指向内网的 SSRF 链）；
 *  非生产额外放行本机 http —— 本地对接本地模型网关（如自建的 OpenAI 兼容网关）调试用。 */
function isUsableBase(url) {
  if (/^https:\/\//i.test(url)) return true;
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url)) {
    return true;
  }
  return false;
}

/** 解析当前生效的模型配置 */
async function getAiConfig() {
  const s = await getAllSettings();
  const apiKey = String(s.ai_api_key || config.ai?.apiKey || '').trim();
  const baseUrl = String(s.ai_base_url || config.ai?.baseUrl || FALLBACK_BASE)
    .trim()
    .replace(/\/+$/, '');
  const model = String(s.ai_model || config.ai?.model || FALLBACK_MODEL).trim();
  return {
    apiKey,
    baseUrl,
    model,
    // 必须同时有 key 且地址可用，才算配置就绪
    ready: !!apiKey && isUsableBase(baseUrl),
  };
}

/** 把上游 SSE 解析成一条条 JSON（跳过空行/注释/坏行） */
async function* parseSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch (e) {
          /* 坏行忽略：上游偶发会插入 keep-alive 文本 */
        }
      }
    }
  } finally {
    // 提前 return（[DONE]）时也要释放上游连接
    try {
      await reader.cancel();
    } catch (e) {
      /* 已关闭 */
    }
  }
}

/**
 * 流式对话
 * @param {object} opts
 * @param {Array}  opts.messages  OpenAI 格式消息数组
 * @param {Array}  [opts.tools]   工具定义（function calling）
 * @param {number} [opts.maxTokens]
 * @param {AbortSignal} [opts.signal] 客户端断开时传入以中止上游
 * @yields {{type:'text',text:string} | {type:'tool',id:string,name:string,args:object} | {type:'usage',usage:object}}
 */
async function* streamChat({ messages, tools = null, maxTokens = 2048, signal = null }) {
  const ai = await getAiConfig();
  if (!ai.ready) {
    const err = new Error('AI 未配置：请在后台「站点设置 → 内容审核 → AI 模型」填写接口地址与 API Key');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }

  const body = {
    model: ai.model,
    messages,
    stream: true,
    temperature: 0.7,
    max_tokens: maxTokens,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`模型接口返回 ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
      err.code = 'AI_UPSTREAM';
      err.status = res.status;
      throw err;
    }
    if (!res.body) {
      const err = new Error('模型接口没有返回流式响应');
      err.code = 'AI_NO_STREAM';
      throw err;
    }

    // 工具调用是分片下发的，按 index 累积后再统一产出
    const toolAcc = new Map();
    let usage = null;

    for await (const chunk of parseSse(res.body)) {
      if (chunk && chunk.usage) usage = chunk.usage;
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = Number.isInteger(tc.index) ? tc.index : 0;
          const cur = toolAcc.get(i) || { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(i, cur);
        }
      }
    }

    for (const cur of toolAcc.values()) {
      if (!cur.name) continue;
      let args = {};
      try {
        args = JSON.parse(cur.args || '{}');
      } catch (e) {
        args = {};
      }
      yield { type: 'tool', id: cur.id || '', name: cur.name, args };
    }
    if (usage) yield { type: 'usage', usage };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 非流式对话：拿一次性完整回复（用于短任务，如生成标题候选） */
async function chatOnce({ messages, maxTokens = 512 }) {
  const ai = await getAiConfig();
  if (!ai.ready) {
    const err = new Error('AI 未配置');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        messages,
        stream: false,
        temperature: 0.7,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`模型接口返回 ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
      err.code = 'AI_UPSTREAM';
      throw err;
    }
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || '');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getAiConfig, streamChat, chatOnce };
