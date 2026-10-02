<template>
  <aside class="ai-panel" :class="{ open: props.open }">
    <header class="ai-head">
      <span class="ai-title">AI 助手</span>
      <span v-if="modelName" class="ai-model">{{ modelName }}</span>
      <button class="ai-icon-btn" title="收起" @click="emit('close')">
        <XIcon name="X" :size="15" />
      </button>
    </header>

    <!-- 未配置模型：一键直达设置页 -->
    <div v-if="aiReady === false" class="ai-notice">
      <p class="ai-notice-title">还没配置模型</p>
      <button class="ai-go" @click="goSettings">去配置</button>
    </div>

    <template v-else>
      <div ref="listEl" class="ai-list">
        <div v-if="!messages.length" class="ai-empty">
          <span class="ai-empty-tip">选中一段文字再点「润色选中」，或直接说需求</span>
        </div>

        <template v-for="(m, i) in messages" :key="i">
          <!-- 用户消息 -->
          <div v-if="m.role === 'user'" class="ai-row user">
            <div class="ai-bubble user-bubble">{{ m.content }}</div>
          </div>

          <!-- AI 消息 -->
          <div v-else class="ai-row">
            <div class="ai-bubble ai-bubble-main">
              <div v-if="m.content" class="ai-md" v-html="renderMarkdown(m.content)"></div>
              <span v-if="m.streaming && !m.content" class="ai-typing"></span>

              <!-- 图片卡片 -->
              <div v-if="m.images" class="ai-imgs">
                <div v-if="!m.images.items.length" class="ai-imgs-empty">没搜到合适的图，换个词试试</div>
                <div v-for="(img, j) in m.images.items" :key="j" class="ai-img-card" :class="{ saving: img.saving }">
                  <img :src="img.thumb" :alt="img.title" loading="lazy" referrerpolicy="no-referrer" />
                  <div class="ai-img-meta">
                    <span class="ai-img-title" :title="img.title">{{ img.title }}</span>
                    <span class="ai-img-license">{{ img.license }} · {{ img.creator }}</span>
                  </div>
                  <div class="ai-img-acts">
                    <button class="ai-img-btn" :disabled="img.saving || pending" @click="useAsCover(m, img)">封面</button>
                    <button class="ai-img-btn ghost" :disabled="pending" @click="insertImage(m, img)">插入</button>
                  </div>
                </div>
              </div>

              <!-- 站内文章列表（list_articles 结果） -->
              <div v-if="m.articleList && m.articleList.length" class="ai-arts">
                <button
                  v-for="(a, j) in m.articleList.slice(0, 8)"
                  :key="j"
                  class="ai-art"
                  @click="draft = `读一下《${a.title}》（slug: ${a.slug}）`"
                >
                  <span class="ai-art-title">{{ a.title }}</span>
                  <span class="ai-art-slug">{{ a.slug }}</span>
                </button>
              </div>

              <!-- 已读文章提示（read_article 结果） -->
              <div v-if="m.articleRead" class="ai-read">
                已读《{{ m.articleRead.title }}》
              </div>

              <!-- 已执行的动作 + 撤销 -->
              <span v-if="m.applied && m.applied.length" class="ai-applied">
                <span
                  v-for="(a, j) in m.applied"
                  :key="j"
                  class="ai-applied-tag"
                  :class="{ undone: a.undone }"
                >
                  {{ a.undone ? a.label + '（已撤销）' : a.label }}
                  <button
                    v-if="!a.undone && canUndoTag(m, j)"
                    class="ai-undo"
                    title="撤销这次修改"
                    @click="undoOne(m, j)"
                  >
                    <XIcon name="RotateCcw" :size="10" />
                  </button>
                </span>
              </span>
            </div>
          </div>
        </template>
      </div>

      <!-- 快捷操作（只在文章编辑页出现） -->
      <div v-if="quickActions.length" class="ai-quick">
        <button
          v-for="q in quickActions"
          :key="q.key"
          class="ai-chip"
          :class="{ off: q.disabled }"
          :disabled="q.disabled || pending"
          :title="q.disabled ? '先在正文里选中一段文字' : ''"
          @click="send(q.prompt)"
        >
          {{ q.label }}<span v-if="q.key === 'polish' && hasSelection" class="ai-dot"></span>
        </button>
      </div>

      <footer class="ai-input">
        <textarea
          v-model="draft"
          class="ai-textarea"
          rows="2"
          placeholder="让它写、改、润色、搜图…（Enter 发送）"
          :disabled="pending"
          @keydown.enter.exact.prevent="send()"
        />
        <button v-if="pending" class="ai-send stop" @click="stop">停止</button>
        <button v-else class="ai-send" :disabled="!draft.trim()" @click="send()">
          <XIcon name="Send" :size="14" />
        </button>
      </footer>
    </template>
  </aside>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { signedFetch } from '@/utils/signedFetch';
import { ensurePass } from '@/utils/pass';
import { renderMarkdown } from '@/utils/markdown';
import { aiContext, aiSelection, applyAiAction, undoAiLast, aiUndoTopId } from '@/utils/aiBridge';
import { getCachedAdminPath, adminHref } from '@/utils/adminPath';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const router = useRouter();
const API_PREFIX = import.meta.env.VITE_API_PREFIX || '/api';

/**
 * 消息形态：
 *  - 用户：{ role:'user', content }
 *  - AI：{ role:'assistant', content, applied:[{label,undone}], images, articleList,
 *          articleRead, tool_calls:[], tool_results:[], streaming }
 * tool_calls / tool_results 不渲染，只用于把工具执行结果回传给模型（下一轮它能"看到"）。
 */
const messages = ref([]);
const draft = ref('');
const pending = ref(false);
/** null = 还没查；false = 未配置模型 */
const aiReady = ref(null);
const modelName = ref('');
const listEl = ref(null);
let controller = null;
/** 单次用户指令内最多几个「工具→继续」回合，防止死循环烧 token */
const MAX_ROUNDS = 4;

const hasSelection = computed(() => !!aiSelection.value?.text);

const quickActions = computed(() => {
  if (aiContext.value?.type !== 'article') return [];
  return [
    {
      key: 'polish',
      label: '润色选中',
      disabled: !hasSelection.value,
      prompt: '润色我选中的这段文本：保持原意、提升表达、去掉废话，然后调用 replace_selection 替换它。',
    },
    { key: 'continue', label: '续写', prompt: '基于文章现有内容和语气自然续写 2-3 段，调用 append_content 追加。' },
    {
      key: 'titles',
      label: '起标题',
      prompt: '给这篇文章起 5 个标题候选，各配一句理由，然后用 set_title 应用你最推荐的那个。',
    },
    { key: 'summary', label: '摘要', prompt: '给这篇文章写一段 80-120 字的摘要，调用 set_summary 应用。' },
    { key: 'tags', label: '标签', prompt: '优先从已有标签里选，给这篇文章设 2-5 个标签，调用 set_tags 应用。' },
    { key: 'cover', label: '搜封面', prompt: '根据文章主题选合适的英文关键词，调用 search_images 帮我搜封面图。' },
  ];
});

function adminUrl(seg) {
  return `${API_PREFIX}/${getCachedAdminPath()}${seg}`;
}

async function scrollToEnd() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function goSettings() {
  router.push(adminHref('settings'));
}

let readyTimer = null;
async function checkReady() {
  try {
    // 等 PoW 票据就绪再查：后台刚打开时挑战可能还没算完，直接查必然 403，
    // 且面板只在打开时查这一次 —— 不重试就会一直显示「未配置」。
    await ensurePass();
    const res = await signedFetch(adminUrl('/ai/status'));
    const json = await res.json();
    const d = json?.data || {};
    aiReady.value = d.ready === true;
    modelName.value = d.model || '';
    if (readyTimer) {
      clearInterval(readyTimer);
      readyTimer = null;
    }
  } catch (e) {
    aiReady.value = false;
    // 失败（票据/网络抖动）每 6s 重试，最多 5 次 —— 仍失败才落定「未配置」
    if (!readyTimer) {
      let attempts = 0;
      readyTimer = setInterval(async () => {
        attempts += 1;
        if (attempts > 5 || aiReady.value === true) {
          clearInterval(readyTimer);
          readyTimer = null;
          return;
        }
        await checkReady();
      }, 6000);
    }
  }
}

/** 发给服务端的上下文：页面上下文 + 当前选区（润色要让模型知道选中了什么） */
function currentContext() {
  const ctx = { ...(aiContext.value || {}) };
  if (aiSelection.value?.text) ctx.selection = aiSelection.value.text;
  return ctx;
}

/** 组装完整历史（含工具调用与结果），供下一轮请求 */
function buildHistory() {
  const out = [];
  for (const m of messages.value) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      } else if (m.content) {
        out.push({ role: 'assistant', content: m.content });
      }
      if (Array.isArray(m.tool_results) && m.tool_results.length) out.push(...m.tool_results);
    }
  }
  return out;
}

async function apiJson(url, opts = {}) {
  const res = await signedFetch(url, opts);
  const json = await res.json().catch(() => null);
  return json || {};
}

/** 执行一个工具动作：写表单走页面 applier；检索类打服务端接口并回传结果给模型 */
async function handleTool(ev, reply) {
  const id = String(ev.id || `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
  const name = String(ev.name || '');
  const args = ev.args || {};
  const call = { id, type: 'function', function: { name, arguments: ev.raw || JSON.stringify(args) } };
  let result;

  if (name === 'search_images') {
    const q = String(args.query || '').trim().slice(0, 80);
    const json = q ? await apiJson(`${adminUrl('/ai/images')}?q=${encodeURIComponent(q)}`) : {};
    const items = Array.isArray(json.data?.images) ? json.data.images : [];
    reply.images = { query: q, items: items.map((x) => ({ ...x, saving: false })) };
    result = items.length
      ? { images: items.slice(0, 6).map((i) => ({ url: i.url, title: i.title, license: i.license })) }
      : { images: [], note: '没有搜到结果，建议更换更简单的英文关键词' };
  } else if (name === 'list_articles') {
    const kw = String(args.keyword || '').trim();
    const json = await apiJson(`${adminUrl('/ai/articles')}?keyword=${encodeURIComponent(kw)}&limit=10`);
    reply.articleList = Array.isArray(json.data?.articles) ? json.data.articles : [];
    result = { articles: reply.articleList.map((a) => ({ title: a.title, slug: a.slug, status: a.status })) };
  } else if (name === 'read_article') {
    const slug = String(args.slug || '').trim();
    const json = slug ? await apiJson(`${adminUrl('/ai/article')}?slug=${encodeURIComponent(slug)}`) : {};
    reply.articleRead = json.data || null;
    result = json.data || { error: '文章不存在' };
  } else if (name === 'list_comments') {
    const json = await apiJson(adminUrl('/ai/comments'));
    result = { comments: Array.isArray(json.data?.comments) ? json.data.comments : [] };
  } else if (name === 'list_messages') {
    const json = await apiJson(adminUrl('/ai/messages'));
    result = { messages: Array.isArray(json.data?.messages) ? json.data.messages : [] };
  } else if (name === 'link_article') {
    // 链接文字缺省时读文章标题，再借 insert_at_cursor 插入（快照由它压）
    const slug = String(args.slug || '').trim();
    let text = String(args.text || '').trim();
    if (!text) {
      const json = await apiJson(`${adminUrl('/ai/article')}?slug=${encodeURIComponent(slug)}`);
      text = json.data?.title || slug;
    }
    const applied = await applyAiAction('insert_at_cursor', { markdown: `[${text}](#/article/${slug})` });
    if (applied) reply.applied.push({ label: `已插入链接：${text.slice(0, 16)}`, snapshotId: applied.snapshotId, undone: false });
    result = { ok: !!applied, label: applied ? '已插入站内链接' : '当前页面不支持' };
  } else {
    // 写操作：交给当前页面执行（撤销快照在页面 applier 里压，save_draft 无快照=不可撤销）
    const applied = await applyAiAction(name, args);
    if (applied) reply.applied.push({ label: applied.label, snapshotId: applied.snapshotId, undone: false });
    result = { ok: !!applied, label: applied ? applied.label : '当前页面不支持这个操作' };
  }

  reply.tool_calls.push(call);
  reply.tool_results.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result).slice(0, 8000) });
}

/** 读一轮 SSE：文本流式入气泡；action 即时执行并记录（供下一轮回传） */
async function streamOnce(reply) {
  try {
    const res = await signedFetch(adminUrl('/ai/chat'), {
      method: 'POST',
      body: { messages: buildHistory(), context: currentContext() },
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      reply.content = res.status === 403 ? '会话已失效，刷新页面后重试' : '请求失败，请稍后重试';
      return false;
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
          await handleTool(ev, reply);
          scrollToEnd();
        } else if (ev.type === 'error') {
          reply.content = reply.content || ev.message || '生成失败';
          return false;
        }
      }
    }
    if (!reply.content && !reply.applied.length && !reply.images && !reply.articleList && !reply.articleRead) {
      reply.content = '（没有返回内容）';
    }
    return true;
  } catch (e) {
    if (!reply.content) reply.content = '生成中断';
    return false;
  }
}

/** 一次用户指令 = 最多 MAX_ROUNDS 轮「模型→工具→回传→继续」 */
async function runTurn() {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = {
      role: 'assistant',
      content: '',
      applied: [],
      images: null,
      articleList: null,
      articleRead: null,
      tool_calls: [],
      tool_results: [],
      streaming: true,
    };
    messages.value.push(reply);
    await scrollToEnd();

    const cont = await streamOnce(reply);
    reply.streaming = false;
    await scrollToEnd();
    // 中断/出错，或模型没有再调用工具 → 本轮指令结束
    if (!cont || !reply.tool_results.length) return;
    // 有工具结果 → 历史里已带 role:'tool'，下一轮模型看着结果继续
  }
}

async function send(text) {
  const content = String(text ?? draft.value ?? '').trim();
  if (!content || pending.value) return;

  messages.value.push({ role: 'user', content });
  draft.value = '';
  pending.value = true;
  controller = new AbortController();
  try {
    await runTurn();
  } finally {
    pending.value = false;
    controller = null;
    scrollToEnd();
  }
}

function stop() {
  if (controller) controller.abort();
}

/* ---------- 图片卡片操作 ---------- */

/** 设为封面：先把缩略图转存到本站（外链封面会随源站失效，且 Wikimedia 原图常超 5MB），再写进表单 */
async function useAsCover(msg, img) {
  if (img.saving) return;
  img.saving = true;
  try {
    const json = await apiJson(adminUrl('/ai/save-image'), { method: 'POST', body: { url: img.thumb || img.url } });
    const local = json?.data?.path;
    if (json?.code !== 0 || !local) {
      ElMessage.error(json?.message || '转存失败');
      return;
    }
    const applied = await applyAiAction('set_cover', { url: local });
    if (applied) {
      msg.applied.push({ label: applied.label, snapshotId: applied.snapshotId, undone: false });
      ElMessage.success('已设为封面');
    } else {
      ElMessage.warning('当前页面不能设封面，去文章编辑页操作');
    }
  } finally {
    img.saving = false;
  }
}

/** 插入正文：Markdown 图片语法插到光标处 */
async function insertImage(msg, img) {
  const applied = await applyAiAction('insert_at_cursor', { markdown: `\n![${img.title}](${img.url})\n` });
  if (applied) {
    msg.applied.push({ label: applied.label, snapshotId: applied.snapshotId, undone: false });
    ElMessage.success('已插入正文');
  } else {
    ElMessage.warning('当前页面不能插图，去文章编辑页操作');
  }
}

/* ---------- 撤销：只有栈顶快照对应的标签显示撤销钮（防止撤销错位） ---------- */

function canUndoTag(msg, j) {
  const tag = msg.applied[j];
  if (tag.undone || !tag.snapshotId) return false;
  return tag.snapshotId === aiUndoTopId();
}

function undoOne(msg, j) {
  const label = undoAiLast();
  if (label) {
    msg.applied[j].undone = true;
    ElMessage.success(`已撤销：${label}`);
  }
}

onMounted(checkReady);

onUnmounted(() => {
  if (readyTimer) {
    clearInterval(readyTimer);
    readyTimer = null;
  }
});

defineExpose({
  reset() {
    if (controller) controller.abort();
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
  width: min(440px, 94vw);
  display: flex;
  flex-direction: column;
  /* 面板本身也是一块液态玻璃，而不是实色板 */
  background: var(--lg-sheen), var(--lg-surface-pop);
  border-left: 1px solid var(--lg-edge);
  box-shadow: var(--lg-shadow), var(--lg-inner);
  backdrop-filter: var(--lg-blur);
  -webkit-backdrop-filter: var(--lg-blur);
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
  border-bottom: 1px solid var(--lg-edge);
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

/* ---------- 未配置模型 ---------- */
.ai-notice {
  margin: auto;
  padding: 18px;
  text-align: center;
}

.ai-notice-title {
  margin: 0 0 12px;
  font-size: 0.9rem;
  font-weight: 600;
}

.ai-go {
  padding: 7px 22px;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
}

/* ---------- 消息区 ---------- */
.ai-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-empty {
  margin: auto 0;
  text-align: center;
}

.ai-empty-tip {
  font-size: 0.8rem;
  color: var(--text-3);
}

.ai-row {
  display: flex;
}

.ai-row.user {
  justify-content: flex-end;
}

.ai-bubble {
  max-width: 92%;
  padding: 9px 12px;
  border-radius: 12px;
  font-size: 0.86rem;
  line-height: 1.7;
  word-break: break-word;
}

.user-bubble {
  background: var(--accent);
  color: #fff;
  white-space: pre-wrap;
}

.ai-bubble-main {
  /* AI 气泡：玻璃面上的「磨砂块」，靠高一点的反差立在面板上 */
  background: color-mix(in srgb, var(--card) 70%, transparent);
  color: var(--text);
  min-width: 40px;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--lg-edge) 60%, transparent);
}

/* AI 回复的 Markdown 渲染 */
.ai-md :deep(p) {
  margin: 0 0 6px;
}

.ai-md :deep(p:last-child) {
  margin-bottom: 0;
}

.ai-md :deep(ul),
.ai-md :deep(ol) {
  margin: 4px 0;
  padding-left: 18px;
}

.ai-md :deep(li) {
  margin: 2px 0;
}

.ai-md :deep(code) {
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  font-size: 0.82em;
}

.ai-md :deep(pre) {
  margin: 6px 0;
  padding: 9px 11px;
  border-radius: 9px;
  overflow-x: auto;
  background: color-mix(in srgb, var(--text) 9%, transparent);
}

.ai-md :deep(pre code) {
  padding: 0;
  background: none;
}

.ai-md :deep(strong) {
  font-weight: 600;
}

.ai-md :deep(a) {
  color: var(--accent);
}

/* ---------- 图片卡片 ---------- */
.ai-imgs {
  margin-top: 8px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.ai-imgs-empty {
  grid-column: 1 / -1;
  font-size: 0.8rem;
  color: var(--text-3);
}

.ai-img-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--card);
  display: flex;
  flex-direction: column;
}

.ai-img-card img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  display: block;
  background: var(--bg-soft);
}

.ai-img-card.saving {
  opacity: 0.55;
}

.ai-img-meta {
  padding: 5px 7px 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.ai-img-title {
  font-size: 0.72rem;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-img-license {
  font-size: 0.66rem;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-img-acts {
  display: flex;
  gap: 6px;
  padding: 6px 7px 7px;
}

.ai-img-btn {
  flex: 1;
  padding: 4px 0;
  border-radius: 7px;
  font-size: 0.74rem;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}

.ai-img-btn.ghost {
  background: var(--bg-soft);
  color: var(--text-2);
  font-weight: 500;
}

.ai-img-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- 站内文章列表 ---------- */
.ai-arts {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ai-art {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 8px;
  border: 1px solid var(--border);
  text-align: left;
  transition: all var(--dur) var(--ease);
}

.ai-art:hover {
  border-color: var(--accent);
}

.ai-art-title {
  font-size: 0.78rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-art-slug {
  flex-shrink: 0;
  font-size: 0.68rem;
  color: var(--text-3);
  max-width: 110px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-read {
  margin-top: 8px;
  font-size: 0.76rem;
  color: var(--text-3);
  padding: 5px 9px;
  border-radius: 8px;
  border: 1px dashed var(--border);
}

/* ---------- 已执行动作 + 撤销 ---------- */
.ai-applied {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ai-applied-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.ai-applied-tag.undone {
  background: var(--bg-soft);
  color: var(--text-3);
  text-decoration: line-through;
}

.ai-undo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  color: inherit;
  opacity: 0.75;
}

.ai-undo:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
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

/* ---------- 快捷操作 ---------- */
.ai-quick {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 14px 0;
}

.ai-chip {
  position: relative;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.78rem;
  transition: all var(--dur) var(--ease);
}

.ai-chip:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.ai-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ai-chip.off {
  opacity: 0.45;
}

.ai-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

/* ---------- 输入区 ---------- */
.ai-input {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 12px 14px;
  border-top: 1px solid var(--lg-edge);
}

.ai-textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--lg-edge);
  background: color-mix(in srgb, var(--card) 72%, transparent);
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
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: #fff;
  font-size: 0.8rem;
  font-weight: 600;
  transition: opacity var(--dur) var(--ease);
}

.ai-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ai-send.stop {
  width: auto;
  padding: 0 14px;
  background: var(--bg-soft);
  color: var(--text-2);
}
</style>
