<template>
  <!-- 传送挂到 body：组件本在文章页 main（z-index:1 的层叠上下文）里，
       fixed 浮层会被关进该上下文集内，z-index 再高也压不住外面的回到顶部工具条 -->
  <!-- 按钮并进右下角浮层栈（和点赞/评论/回顶那排按钮同一列，永不互相压住） -->
  <Teleport :to="dockTarget">
    <button v-if="!open" class="ask-fab" type="button" title="问 AI" aria-label="问 AI" @click="toggle">
      <XIcon name="Sparkles" :size="18" />
    </button>
  </Teleport>

  <!-- 面板单独挂 body（覆盖式弹层），底部贴在浮层栈上方 -->
  <Teleport to="body">
    <section v-if="open" class="ask-box" aria-label="就这篇文章提问" :style="{ '--ask-bottom': bottomOffset + 'px' }">
      <header class="ask-head">
        <span class="ask-title">问这篇</span>
        <button class="ask-close" type="button" title="关闭" @click="open = false">
          <XIcon name="X" :size="14" />
        </button>
      </header>

      <div ref="listEl" class="ask-list">
        <!-- 还没问过：给三个一键问题，降低使用门槛 -->
        <div v-if="!messages.length" class="ask-hello">
          <p class="ask-hint">就这篇文章的内容提问</p>
          <div class="ask-suggests">
            <button v-for="s in suggests" :key="s" class="ask-suggest" type="button" @click="send(s)">{{ s }}</button>
          </div>
        </div>

        <div v-for="(m, i) in messages" :key="i" class="ask-row" :class="m.role">
          <div class="ask-wrap">
            <!-- 流式期间渲染纯文本：markdown 是块级元素，会把光标挤到下一行（看着像错位） -->
            <div v-if="m.role === 'assistant'" class="ask-bubble">
              <template v-if="m.streaming"
                ><span class="ask-raw">{{ m.content }}</span
                ><span class="ask-cursor"></span
              ></template>
              <div v-else-if="m.content" class="ask-md" v-html="renderMarkdown(m.content)"></div>
            </div>
            <div v-else class="ask-bubble">{{ m.content }}</div>
            <!-- 回答完成：一键复制 -->
            <button
              v-if="m.role === 'assistant' && !m.streaming && m.content"
              class="ask-copy"
              type="button"
              @click="copyAnswer(m)"
            >
              {{ m.copied ? '已复制' : '复制' }}
            </button>
          </div>
        </div>
      </div>

      <form class="ask-form" @submit.prevent="send()">
        <input v-model="draft" class="ask-field" :disabled="pending" placeholder="输入问题…" maxlength="500" />
        <button class="ask-send" type="submit" :disabled="!draft.trim() || pending">
          <XIcon name="Send" :size="15" />
        </button>
      </form>
    </section>
  </Teleport>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { signedFetch } from '@/utils/signedFetch';
import { ensurePass } from '@/utils/pass';
import { renderMarkdown } from '@/utils/markdown';

const props = defineProps({
  slug: { type: String, required: true },
});

const API_PREFIX = import.meta.env.VITE_API_PREFIX || '/api';

const open = ref(false);
const available = ref(false);
/** 底部偏移：面板抬到浮层栈上方（默认 20） */
const bottomOffset = ref(20);
/** 按钮并进右下角浮层栈；栈不存在时退回 body（避免 Teleport 目标缺失告警） */
const dockTarget = ref('body');
const messages = ref([]); // { role, content, streaming?, copied? }
const draft = ref('');
const pending = ref(false);
const listEl = ref(null);
let controller = null;

const suggests = ['总结一下全文', '核心观点是什么', '列出 3 个要点'];

async function scrollToEnd() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 站点没配模型就不显示入口，避免点了才报错 */
async function checkAvailable() {
  try {
    // 闸门对 /api 全量生效（/ai 不在白名单），所以必须走带票据+签名的请求。
    // 先等 PoW 票据就绪：首次打开页面时挑战可能还没算完，此时直接请求必然 403，
    // 且不重试的话浮窗会一直点不开（表现为「AI 没刷新出来」）。
    await ensurePass();
    const res = await signedFetch(`${API_PREFIX}/ai/status`);
    const json = await res.json();
    available.value = json?.data?.ready === true;
  } catch (e) {
    available.value = false;
  }
}

// 挂载即查；没查到（票据未就绪/网络抖动）每 10s 重试一次，最多 6 次，
// 避免「第一次没查到后来永远不可用」
let retryTimer = null;
function scheduleRetry() {
  let attempts = 0;
  retryTimer = setInterval(async () => {
    if (available.value || attempts >= 6) {
      clearInterval(retryTimer);
      retryTimer = null;
      return;
    }
    attempts += 1;
    await checkAvailable();
  }, 10000);
}

function toggle() {
  if (!available.value) return;
  open.value = true;
}

/** 复制一条回答（不用全局弹层，按钮自身变「已复制」就够） */
async function copyAnswer(m) {
  const text = String(m.content || '').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 旧浏览器降级
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  m.copied = true;
  setTimeout(() => {
    m.copied = false;
  }, 1600);
}

/** 发问：preset 来自一键问题按钮；不传则取输入框内容（表单提交） */
async function send(preset) {
  const question = String(preset ?? draft.value ?? '').trim();
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

/** 面板贴在右下角浮层栈上方：栈里按钮数量不固定，所以量实际高度而不是写死数值 */
function syncBottom() {
  const dock = document.querySelector('#float-dock') || document.querySelector('.side-tools');
  if (!dock) {
    bottomOffset.value = 20;
    return;
  }
  const cs = getComputedStyle(dock);
  const gap = parseFloat(cs.bottom) || 20;
  bottomOffset.value = Math.round(gap + dock.getBoundingClientRect().height + 12);
}

onMounted(() => {
  if (document.querySelector('#float-dock')) dockTarget.value = '#float-dock';
  syncBottom();
  window.addEventListener('resize', syncBottom);
  checkAvailable().then(() => {
    if (!available.value) scheduleRetry();
  });
});

onUnmounted(() => {
  window.removeEventListener('resize', syncBottom);
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
});
</script>

<style scoped>
/* 按钮已 teleport 进 #float-dock（与那排按钮同列），尺寸与它们对齐 */
.ask-fab {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
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
  /* 同列贴在工具条上方展开，不压住那排按钮 */
  bottom: var(--ask-bottom, 20px);
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
  margin: 0 0 10px;
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--text-3);
}

.ask-hello {
  margin: auto 0;
}

/* 一键问题 */
.ask-suggests {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.ask-suggest {
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--sg-edge);
  background: color-mix(in srgb, var(--text) 4%, transparent);
  color: var(--text-2);
  font-size: 0.82rem;
  text-align: left;
  transition: all var(--dur) var(--ease);
}

.ask-suggest:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.ask-row {
  display: flex;
}

.ask-row.user {
  justify-content: flex-end;
}

/* 气泡 + 复制按钮 的容器 */
.ask-wrap {
  position: relative;
  max-width: 88%;
}

.ask-bubble {
  padding: 8px 11px;
  border-radius: 12px;
  font-size: 0.84rem;
  line-height: 1.7;
  word-break: break-word;
}

.ask-row.user .ask-bubble {
  background: var(--accent);
  color: #fff;
  white-space: pre-wrap;
}

.ask-row.assistant .ask-bubble {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

/* 回答里的 Markdown */
.ask-md :deep(p) {
  margin: 0 0 5px;
}

.ask-md :deep(p:last-child) {
  margin-bottom: 0;
}

.ask-md :deep(ul),
.ask-md :deep(ol) {
  margin: 4px 0;
  padding-left: 17px;
}

.ask-md :deep(li) {
  margin: 2px 0;
}

.ask-md :deep(code) {
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  font-size: 0.82em;
}

.ask-md :deep(pre) {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 9px;
  overflow-x: auto;
  background: color-mix(in srgb, var(--text) 10%, transparent);
}

.ask-md :deep(pre code) {
  padding: 0;
  background: none;
}

/* 复制按钮：贴在气泡右下角外侧，不抢内容位置 */
.ask-copy {
  position: absolute;
  right: 0;
  bottom: -22px;
  font-size: 0.7rem;
  color: var(--text-3);
  padding: 1px 4px;
  border-radius: 5px;
  transition: color var(--dur) var(--ease);
}

.ask-copy:hover {
  color: var(--accent);
}

.ask-row.assistant {
  margin-bottom: 16px;
}

/* 打字光标：紧跟文本末尾的内联光标（早先钉在气泡右下角，看着就是「错位」） */
.ask-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 3px;
  vertical-align: text-bottom;
  background: var(--accent);
  opacity: 0.85;
  animation: ask-blink 1s steps(2, start) infinite;
}

/* 流式期间的纯文本：保留换行，等生成完再整体渲染成 Markdown */
.ask-raw {
  white-space: pre-wrap;
  word-break: break-word;
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
  .ask-box {
    right: 12px;
    width: calc(100vw - 24px);
  }
}
</style>
