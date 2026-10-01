<template>
  <aside class="ai-panel" :class="{ open: props.open }">
    <header class="ai-head">
      <span class="ai-title">AI 助手</span>
      <span v-if="modelName" class="ai-model">{{ modelName }}</span>
      <button class="ai-icon-btn" title="收起" @click="emit('close')">
        <XIcon name="X" :size="15" />
      </button>
    </header>

    <div ref="listEl" class="ai-list">
      <!-- 未配置模型：给出可操作的指引，而不是让用户对着输入框发呆 -->
      <div v-if="aiReady === false" class="ai-notice">
        <p class="ai-notice-title">还没配置模型</p>
        <p class="ai-notice-body">到「站点设置 → 内容审核 → AI 模型」填上接口地址和 API Key 就能用了。</p>
      </div>

      <template v-else>
        <div v-if="!messages.length" class="ai-empty">
          <div class="ai-suggests">
            <button v-for="s in suggests" :key="s" class="ai-suggest" @click="send(s)">{{ s }}</button>
          </div>
        </div>

        <div v-for="(m, i) in messages" :key="i" class="ai-row" :class="m.role">
          <div class="ai-bubble">
            <span class="ai-text">{{ m.content }}</span>
            <span v-if="m.applied && m.applied.length" class="ai-applied">
              <span v-for="(a, j) in m.applied" :key="j" class="ai-applied-tag">{{ a }}</span>
            </span>
            <span v-if="m.streaming && !m.content" class="ai-typing"></span>
          </div>
        </div>
      </template>
    </div>

    <footer class="ai-input">
      <textarea
        v-model="draft"
        class="ai-textarea"
        rows="2"
        placeholder="让它写文章、改正文、起标题…（Enter 发送）"
        :disabled="aiReady === false"
        @keydown.enter.exact.prevent="send()"
      />
      <button class="ai-send" :disabled="!draft.trim() || pending || aiReady === false" @click="send()">
        <span v-if="pending">生成中</span>
        <span v-else>发送</span>
      </button>
    </footer>
  </aside>
</template>

<script setup>
import { ref, nextTick, onMounted } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { signedFetch } from '@/utils/signedFetch';
import { aiContext, applyAiAction } from '@/utils/aiBridge';
import { getCachedAdminPath } from '@/utils/adminPath';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const API_PREFIX = import.meta.env.VITE_API_PREFIX || '/api';

/** 消息列表：{ role, content, applied?: string[] } */
const messages = ref([]);
const draft = ref('');
const pending = ref(false);
/** null = 还没查；false = 未配置模型（禁用输入并给指引） */
const aiReady = ref(null);
const modelName = ref('');
const listEl = ref(null);
let runner = null;

const suggests = [
  '帮我写一篇新文章',
  '把正文改得更口语一点',
  '起 5 个标题给我挑',
  '给这篇补一个摘要',
];

function adminUrl(seg) {
  const key = getCachedAdminPath();
  return `${API_PREFIX}/${key}${seg}`;
}

async function scrollToEnd() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 查模型可用状态：未配置就把面板切成"只读指引"形态 */
async function checkReady() {
  try {
    const res = await signedFetch(adminUrl('/ai/status'));
    const json = await res.json();
    const d = json?.data || {};
    aiReady.value = d.ready === true;
    modelName.value = d.model || '';
  } catch (e) {
    aiReady.value = false;
  }
}

/** 把 AI 下发的动作应用到当前页面 */
function handleAction(name, args) {
  const label = ACTION_LABELS[name] || name;
  // 返回 null 表示当前页面没注册处理器（比如在仪表盘上让 AI 改正文）
  return applyAiAction(name, args) === null ? `${label}（当前页面不支持）` : label;
}

const ACTION_LABELS = {
  set_title: '已改标题',
  set_content: '已替换正文',
  append_content: '已追加正文',
  set_summary: '已写摘要',
  set_tags: '已设标签',
};

/** 发送一条消息并流式接收回复 */
async function send(text) {
  const content = String(text ?? draft.value ?? '').trim();
  if (!content || pending.value) return;

  messages.value.push({ role: 'user', content });
  draft.value = '';
  pending.value = true;

  const reply = { role: 'assistant', content: '', applied: [], streaming: true };
  messages.value.push(reply);
  await scrollToEnd();

  const controller = new AbortController();
  runner = controller;

  try {
    const history = messages.value
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await signedFetch(adminUrl('/ai/chat'), {
      method: 'POST',
      body: { messages: history, context: aiContext.value || {} },
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      reply.content = res.status === 403 ? '会话已失效，刷新页面后重试' : '请求失败，请稍后重试';
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev = null;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch (e) {
          continue;
        }
        if (ev.type === 'text') {
          reply.content += ev.text;
          scrollToEnd();
        } else if (ev.type === 'action') {
          const label = handleAction(ev.name, ev.args || {});
          if (label) reply.applied.push(label);
          scrollToEnd();
        } else if (ev.type === 'error') {
          reply.content = reply.content || ev.message || '生成失败';
        }
      }
    }
    if (!reply.content && !reply.applied.length) reply.content = '（没有返回内容）';
  } catch (e) {
    if (!reply.content) reply.content = '生成中断，请重试';
  } finally {
    reply.streaming = false;
    pending.value = false;
    runner = null;
    scrollToEnd();
  }
}

onMounted(checkReady);

/** 供父组件在切换页面时清空对话（可选） */
defineExpose({
  reset() {
    if (runner) runner.abort();
    messages.value = [];
    pending.value = false;
  },
});
</script>

<style scoped>
.ai-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-modal);
  width: min(420px, 92vw);
  display: flex;
  flex-direction: column;
  background: var(--card);
  border-left: 1px solid var(--border);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.12);
  transform: translateX(101%);
  transition: transform 0.26s var(--ease);
}

.ai-panel.open {
  transform: none;
}

.ai-head {
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
}

.ai-title {
  font-size: 0.92rem;
  font-weight: 600;
}

.ai-model {
  font-size: 0.72rem;
  color: var(--text-3);
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--bg-soft);
}

.ai-icon-btn {
  margin-left: auto;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--text-2);
  transition: all var(--dur) var(--ease);
}

.ai-icon-btn:hover {
  color: var(--text);
  background: var(--bg-soft);
}

.ai-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-notice {
  margin: auto;
  padding: 18px;
  text-align: center;
}

.ai-notice-title {
  margin: 0 0 6px;
  font-size: 0.9rem;
  font-weight: 600;
}

.ai-notice-body {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.7;
  color: var(--text-3);
}

.ai-empty {
  margin: auto 0;
}

.ai-suggests {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-suggest {
  text-align: left;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.84rem;
  transition: all var(--dur) var(--ease);
}

.ai-suggest:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.ai-row {
  display: flex;
}

.ai-row.user {
  justify-content: flex-end;
}

.ai-bubble {
  max-width: 88%;
  padding: 9px 12px;
  border-radius: 12px;
  font-size: 0.86rem;
  line-height: 1.72;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-row.user .ai-bubble {
  background: var(--accent);
  color: #fff;
}

.ai-row.assistant .ai-bubble {
  background: var(--bg-soft);
  color: var(--text);
}

.ai-applied {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ai-applied-tag {
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.ai-typing {
  display: inline-block;
  width: 6px;
  height: 14px;
  vertical-align: middle;
  background: var(--text-3);
  animation: ai-blink 1s steps(2, start) infinite;
}

@keyframes ai-blink {
  to {
    visibility: hidden;
  }
}

.ai-input {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
}

.ai-textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  font-family: inherit;
  font-size: 0.86rem;
  line-height: 1.6;
  outline: none;
}

.ai-textarea:focus {
  border-color: var(--accent);
}

.ai-send {
  flex-shrink: 0;
  align-self: flex-end;
  padding: 8px 16px;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-size: 0.84rem;
  font-weight: 600;
  transition: opacity var(--dur) var(--ease);
}

.ai-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
