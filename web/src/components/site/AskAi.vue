<template>
  <div class="ask-ai">
    <button v-if="!open" class="ask-fab" type="button" title="问 AI" aria-label="问 AI" @click="toggle">
      <XIcon name="Sparkles" :size="18" />
    </button>

    <section v-else class="ask-box" aria-label="就这篇文章提问">
      <header class="ask-head">
        <span class="ask-title">问这篇</span>
        <button class="ask-close" type="button" title="关闭" @click="open = false">
          <XIcon name="X" :size="14" />
        </button>
      </header>

      <div ref="listEl" class="ask-list">
        <p v-if="!messages.length" class="ask-hint">就这篇文章的内容提问，比如「这篇讲了什么」「第二步为什么这么做」。</p>
        <div v-for="(m, i) in messages" :key="i" class="ask-row" :class="m.role">
          <div class="ask-bubble">{{ m.content }}<span v-if="m.streaming" class="ask-cursor"></span></div>
        </div>
      </div>

      <form class="ask-form" @submit.prevent="send()">
        <input v-model="draft" class="ask-field" :disabled="pending" placeholder="输入问题…" maxlength="500" />
        <button class="ask-send" type="submit" :disabled="!draft.trim() || pending">
          <XIcon name="Send" :size="15" />
        </button>
      </form>
    </section>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { signedFetch } from '@/utils/signedFetch';

const props = defineProps({
  slug: { type: String, required: true },
});

const API_PREFIX = import.meta.env.VITE_API_PREFIX || '/api';

const open = ref(false);
const available = ref(false);
const messages = ref([]); // { role, content, streaming? }
const draft = ref('');
const pending = ref(false);
const listEl = ref(null);
let controller = null;

async function scrollToEnd() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 站点没配模型就不显示入口，避免点了才报错 */
async function checkAvailable() {
  try {
    // 闸门对 /api 全量生效（/ai 不在白名单），所以必须走带票据+签名的请求
    const res = await signedFetch(`${API_PREFIX}/ai/status`);
    const json = await res.json();
    available.value = json?.data?.ready === true;
  } catch (e) {
    available.value = false;
  }
}

function toggle() {
  if (!available.value) return;
  open.value = true;
}

async function send() {
  const question = draft.value.trim();
  if (!question || pending.value) return;
  draft.value = '';
  messages.value.push({ role: 'user', content: question });
  const reply = { role: 'assistant', content: '', streaming: true };
  messages.value.push(reply);
  pending.value = true;
  await scrollToEnd();

  controller = new AbortController();
  try {
    const history = messages.value.filter((m) => !m.streaming && m.content).slice(-6);
    const res = await signedFetch(`${API_PREFIX}/ai/ask`, {
      method: 'POST',
      body: { slug: props.slug, question, history },
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (res.status === 429) {
      reply.content = '问得有点频繁，歇一会儿再问。';
      return;
    }
    if (!res.ok || !res.body) {
      reply.content = '暂时问不了，稍后再试。';
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
        } else if (ev.type === 'error') {
          reply.content = reply.content || ev.message || '回答失败';
        }
      }
    }
    if (!reply.content) reply.content = '（没有返回内容）';
  } catch (e) {
    if (!reply.content) reply.content = '连接中断，请重试。';
  } finally {
    reply.streaming = false;
    pending.value = false;
    controller = null;
    scrollToEnd();
  }
}

onMounted(checkAvailable);
</script>

<style scoped>
.ask-ai {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: var(--z-float);
}

.ask-fab {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  background: var(--sg-sheen), var(--sg-tint), var(--sg-surface);
  border: 1px solid var(--sg-edge);
  box-shadow: var(--sg-shadow), var(--sg-inner);
  backdrop-filter: var(--sg-blur-soft);
  -webkit-backdrop-filter: var(--sg-blur-soft);
  transition: transform var(--dur) var(--ease);
}

.ask-fab:hover {
  transform: translateY(-2px);
}

.ask-box {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: min(360px, calc(100vw - 40px));
  max-height: min(520px, calc(100vh - 40px));
  display: flex;
  flex-direction: column;
  border-radius: 18px;
  overflow: hidden;
  background: var(--sg-sheen), var(--sg-tint), var(--sg-surface);
  border: 1px solid var(--sg-edge);
  box-shadow: var(--sg-shadow), var(--sg-inner);
  backdrop-filter: var(--sg-blur);
  -webkit-backdrop-filter: var(--sg-blur);
}

.ask-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--sg-edge);
}

.ask-title {
  font-size: 0.84rem;
  font-weight: 600;
}

.ask-close {
  margin-left: auto;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--text-3);
  transition: all var(--dur) var(--ease);
}

.ask-close:hover {
  color: #fff;
  background: var(--accent);
}

.ask-list {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ask-hint {
  margin: auto 0;
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--text-3);
}

.ask-row {
  display: flex;
}

.ask-row.user {
  justify-content: flex-end;
}

.ask-bubble {
  max-width: 88%;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: 0.84rem;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.ask-row.user .ask-bubble {
  background: var(--accent);
  color: #fff;
}

.ask-row.assistant .ask-bubble {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.ask-cursor {
  display: inline-block;
  width: 5px;
  height: 13px;
  margin-left: 2px;
  vertical-align: middle;
  background: currentColor;
  opacity: 0.5;
  animation: ask-blink 1s steps(2, start) infinite;
}

@keyframes ask-blink {
  to {
    visibility: hidden;
  }
}

.ask-form {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--sg-edge);
}

.ask-field {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 10px;
  border: 1px solid var(--sg-edge);
  background: color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text);
  font: inherit;
  font-size: 0.84rem;
  outline: none;
}

.ask-field:focus {
  border-color: var(--accent);
}

.ask-send {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: #fff;
}

.ask-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .ask-ai,
  .ask-box {
    right: 12px;
    bottom: 12px;
  }
}
</style>
