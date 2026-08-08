<template>
  <div class="messages-page">
    <div class="container narrow">
      <div class="page-head fade-up">
        <p class="eyebrow">GUESTBOOK</p>
        <h1>留言板</h1>
        <p class="lead">有什么想说的，都可以留在这里</p>
      </div>

      <!-- 留言表单 -->
      <div class="msg-form card" v-reveal>
        <div class="form-row">
          <input v-model="form.nickname" class="form-input" placeholder="昵称 *" maxlength="50" autocomplete="nickname" aria-label="昵称"
            @keydown.enter.prevent="onFieldEnter" />
          <input v-model="form.email" class="form-input" type="email" placeholder="邮箱（可选）" maxlength="100" autocomplete="email" aria-label="邮箱"
            @keydown.enter.prevent="onFieldEnter" />
        </div>
        <!-- 随机蜜罐字段：字段名由服务端动态签发 -->
        <input
          v-model="form[hpField]"
          :name="hpField"
          class="hp-field"
          tabindex="-1"
          autocomplete="off"
          aria-hidden="true"
        />
        <transition name="emoji-fade">
          <EmojiPicker v-if="showEmoji" @insert="insertEmoji" />
        </transition>
        <textarea
          v-model="form.content"
          class="form-textarea"
          rows="4"
          maxlength="2000"
          placeholder="写下你的留言…"
          aria-label="留言内容"
          @keydown="onTextareaKeydown"
        ></textarea>
        <div class="form-actions">
          <button class="emoji-toggle" :class="{ active: showEmoji }" :aria-pressed="showEmoji" title="表情" aria-label="表情选择" @click="toggleEmoji">
            <XIcon name="Smile" :size="15" />
          </button>
          <span class="char-count" :class="{ near: form.content.length > 1800 }">{{ form.content.length }}/2000</span>
          <span class="shortcut-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 提交</span>
          <button class="submit-btn" :disabled="submitting" @click="submit">
            {{ submitting ? '发送中…' : '发布留言' }}
          </button>
        </div>
      </div>

      <!-- 留言列表 -->
      <div v-if="messages.length" class="msg-list" v-reveal="'stagger'">
        <div v-for="m in messages" :key="m.id" class="msg-item card fade-up">
          <div class="msg-avatar" :style="{ background: avatarColor(m.nickname) }">
            {{ (m.nickname || '?').charAt(0).toUpperCase() }}
          </div>
          <div class="msg-body">
            <div class="msg-head">
              <span class="msg-nick" :class="{ admin: m.is_admin }">{{ m.nickname }}</span>
              <span v-if="m.is_admin" class="admin-badge" title="博主"><XIcon name="Crown" :size="12" /></span>
              <span class="msg-time">{{ timeAgo(m.created_at) }}</span>
            </div>
            <p class="msg-content">{{ m.content }}</p>
            <!-- 站长回复 -->
            <div v-if="m.reply" class="msg-reply">
              <div class="msg-reply-head">
                <XIcon name="Crown" :size="13" />
                <span class="msg-reply-nick">站长回复</span>
                <span class="msg-reply-time" :title="m.replied_at">{{ timeAgo(m.replied_at) }}</span>
              </div>
              <p class="msg-reply-content">{{ m.reply }}</p>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="icon-wrap"><XIcon name="MessageCircleHeart" :size="30" /></div>
        <p>还没有留言，来做第一位访客吧</p>
      </div>

      <!-- 加载更多 -->
      <div v-if="hasMore" class="more-wrap">
        <button class="more-btn" :disabled="loading" @click="loadMore">
          {{ loading ? '加载中…' : `加载更多（还有 ${Math.max(0, total - messages.length)} 条）` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, watchEffect } from 'vue';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import EmojiPicker from '@/components/ui/EmojiPicker.vue';
import { messageApi } from '@/api';
import { getFormTokenInfo, refreshFormToken, getHpField } from '@/utils/formToken';
import { timeAgo } from '@/utils/format';

// 浏览器标签页标题
watchEffect(() => {
  document.title = '留言板';
});

const messages = ref([]);
const page = ref(1);
const pageSize = 12;
const total = ref(0);
const submitting = ref(false);
const loading = ref(false);
const hasMore = ref(false);
// 访客信息本地记忆（仅本机存储，避免每次重复输入）
let savedName = '';
let savedEmail = '';
try {
  savedName = localStorage.getItem('xalor_mname') || '';
  savedEmail = localStorage.getItem('xalor_memail') || '';
} catch (e) { /* 隐私模式忽略 */ }
const form = ref({ nickname: savedName, email: savedEmail, content: '' });
const hpField = ref(getHpField('/messages'));
// 表情面板折叠（与评论区共用偏好）
const showEmoji = ref(localStorage.getItem('xalor_emoji_open') === '1');
function toggleEmoji() {
  showEmoji.value = !showEmoji.value;
  try {
    localStorage.setItem('xalor_emoji_open', showEmoji.value ? '1' : '0');
  } catch (e) { /* 隐私模式忽略 */ }
}

// ---------- 留言草稿本地保存（防误关/刷新丢内容） ----------
import { saveDraft, loadDraft, clearDraft as clearLocalDraft } from '@/utils/localDraft';
const DRAFT_KEY = 'xalor_mdraft';
let draftTimer = null;

// 恢复上次未提交的草稿（24 小时内且内容非空才恢复，直接填充不打扰）
const restored = loadDraft(DRAFT_KEY);
if (restored) {
  form.value.content = restored;
  setTimeout(() => ElMessage.info('已恢复上次未提交的留言草稿'), 400);
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    saveDraft(DRAFT_KEY, form.value.content);
  }, 800);
}

function clearDraft() {
  clearTimeout(draftTimer);
  clearLocalDraft(DRAFT_KEY);
}

watch(
  () => form.value.content,
  () => scheduleDraftSave()
);

function insertEmoji(emoji) {
  // 光标处插入（与评论区同模式）；textarea 不可用时回退追加
  const textarea = document.querySelector('.msg-form textarea');
  if (textarea) {
    const start = textarea.selectionStart ?? form.value.content.length;
    const end = textarea.selectionEnd ?? start;
    form.value.content =
      form.value.content.slice(0, start) + emoji + form.value.content.slice(end);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  } else {
    form.value.content += emoji;
  }
}

// 昵称哈希 → 渐变配色（与评论区头像风格一致）
function avatarColor(nickname) {
  const s = nickname || '?';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const palettes = [
    ['#e8634a', '#f2b84b'],
    ['#5b8def', '#8e6cf0'],
    ['#3ecf8e', '#2bb3c0'],
    ['#f07bae', '#e8634a'],
    ['#4aa8f2', '#2bb3c0'],
    ['#c07df0', '#8e6cf0'],
  ];
  const [a, b] = palettes[h % palettes.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

async function load() {
  const res = await messageApi.list({ page: page.value, pageSize });
  messages.value = res.list;
  total.value = res.pagination.total;
  hasMore.value = messages.value.length < total.value;
}

async function loadMore() {
  loading.value = true;
  try {
    page.value += 1;
    const res = await messageApi.list({ page: page.value, pageSize });
    messages.value = [...messages.value, ...res.list];
    hasMore.value = messages.value.length < res.pagination.total;
  } finally {
    loading.value = false;
  }
}

/** 昵称/邮箱输入框 Enter：顺移焦点到正文（快速填表流程） */
function onFieldEnter() {
  document.querySelector('.msg-form textarea')?.focus();
}

/** Ctrl/Cmd + Enter 快捷提交（与评论区一致） */
function onTextareaKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    submit();
  }
}

async function submit() {
  const nickname = form.value.nickname.trim();
  const content = form.value.content.trim();
  if (!nickname) return ElMessage.warning('请填写昵称');
  if (!content) return ElMessage.warning('请填写留言内容');
  submitting.value = true;
  try {
    const { token: formToken, hpField: field } = await getFormTokenInfo('/messages');
    hpField.value = field;
    const res = await messageApi.create(
      {
        nickname,
        email: form.value.email.trim(),
        content,
        [field]: form.value[field] || '',
        form_token: formToken,
      },
      { headers: { 'X-Hp-Field': field } }
    );
    // 审核开关打开时：提示"等待审核"而非"成功"（内容暂不显示）
    ElMessage.success(res?.moderated ? '留言已提交，等待审核后展示' : '留言成功');
    // 记住访客信息，清空内容（下次免输入）
    try {
      localStorage.setItem('xalor_mname', nickname);
      localStorage.setItem('xalor_memail', form.value.email.trim());
    } catch (e) { /* 隐私模式忽略 */ }
    form.value = { nickname, email: form.value.email.trim(), content: '' };
    clearDraft(); // 提交成功，清除本地草稿
    refreshFormToken('/messages');
    page.value = 1;
    await load();
  } catch (e) {
    if (e?.response?.status === 403) refreshFormToken('/messages');
  } finally {
    submitting.value = false;
  }
}

/** 立即落盘当前草稿（路由卸载 / 浏览器关闭前统一调用） */
function flushDraft() {
  clearTimeout(draftTimer);
  saveDraft(DRAFT_KEY, form.value.content);
}

onMounted(() => {
  load();
  // 浏览器关闭/刷新前落盘（beforeunload 场景 watch 防抖可能来不及）
  window.addEventListener('beforeunload', flushDraft);
});

onUnmounted(() => {
  // 立即落盘未完成的草稿（防卸载丢失防抖窗口内的输入）
  flushDraft();
  window.removeEventListener('beforeunload', flushDraft);
});
</script>

<style scoped>
.messages-page {
  padding-bottom: 60px;
}

.narrow {
  max-width: 720px;
}

.page-head .eyebrow {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--accent);
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* 表单 */
.msg-form {
  padding: 22px 24px;
  margin-bottom: 36px;
}

.form-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.form-input,
.form-textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 9px 13px;
  font-size: 0.9rem;
  color: var(--text);
  background: var(--bg);
  outline: none;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.form-input:focus,
.form-textarea:focus {
  border-color: var(--accent);
  background: var(--card);
}

.form-textarea {
  resize: vertical;
  line-height: 1.7;
  margin-bottom: 12px;
}

.form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
}

.char-count {
  margin-right: auto;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  transition: color 0.2s;
}

.char-count.near {
  color: var(--danger, #e5484d);
}

/* 表情面板淡入 */
.emoji-fade-enter-active {
  transition: opacity 0.18s var(--ease);
}

.emoji-fade-enter-from {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .emoji-fade-enter-active {
    transition: none;
  }
}

/* 表情开关按钮（与评论区一致） */
.emoji-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
  flex-shrink: 0;
}

.emoji-toggle:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.emoji-toggle.active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 快捷提交提示（桌面端显示） */
.shortcut-hint {
  font-size: 0.74rem;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.shortcut-hint kbd {
  font-family: inherit;
  font-size: 0.7rem;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg-soft);
  color: var(--text-2);
}

@media (hover: none) {
  .shortcut-hint {
    display: none;
  }
}

/* honeypot 隐藏字段 */
.hp-field {
  position: absolute;
  left: -9999px;
  top: -9999px;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.submit-btn {
  padding: 9px 28px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-size: 0.9rem;
  font-weight: 600;
  transition: all var(--dur) var(--ease);
}

.submit-btn:hover:not(:disabled) {
  opacity: 0.88;
  transform: translateY(-1px);
}

.submit-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 列表 */
.msg-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.msg-item {
  display: flex;
  gap: 14px;
  padding: 18px 22px;
}

.msg-avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.msg-body {
  flex: 1;
  min-width: 0;
}

.msg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.msg-nick {
  font-weight: 650;
  font-size: 0.92rem;
}

.msg-nick.admin {
  color: var(--accent-deep);
  font-weight: 700;
}

.admin-badge {
  display: inline-flex;
  align-items: center;
  color: #d4a017;
  filter: drop-shadow(0 1px 2px rgba(212, 160, 23, 0.4));
}

[data-theme='dark'] .admin-badge {
  color: #f0c33c;
}

.msg-time {
  font-size: 0.76rem;
  color: var(--text-3);
}

.msg-content {
  font-size: 0.92rem;
  line-height: 1.8;
  word-break: break-word;
  white-space: pre-wrap; /* 保留留言中的换行 */
}

/* 站长回复 */
.msg-reply {
  margin-top: 14px;
  padding: 12px 16px;
  border-radius: 10px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
}

.msg-reply-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent-deep, var(--accent));
}

.msg-reply-nick {
  font-size: 0.8rem;
  font-weight: 700;
}

.msg-reply-time {
  font-size: 0.72rem;
  color: var(--text-3);
  margin-left: auto;
}

.msg-reply-content {
  margin-top: 6px;
  font-size: 0.88rem;
  line-height: 1.75;
  word-break: break-word;
  white-space: pre-wrap;
}

/* 加载更多 */
.more-wrap {
  display: flex;
  justify-content: center;
  margin-top: 32px;
}

.more-btn {
  padding: 10px 32px;
  border-radius: 999px;
  border: 1px solid var(--text);
  font-size: 0.9rem;
  font-weight: 600;
  transition: all var(--dur) var(--ease);
}

.more-btn:hover:not(:disabled) {
  background: var(--text);
  color: var(--bg);
}

.more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 560px) {
  .form-row {
    flex-direction: column;
    gap: 12px;
  }
}
</style>
