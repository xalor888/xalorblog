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
          <input
            ref="nicknameRef"
            v-model="form.nickname"
            class="form-input"
            :class="{ 'is-invalid': fieldErrors.nickname }"
            placeholder="昵称 *"
            maxlength="50"
            autocomplete="nickname"
            aria-label="昵称"
            :aria-invalid="fieldErrors.nickname ? 'true' : undefined"
            :aria-describedby="fieldErrors.nickname ? 'msg-err-nickname' : undefined"
            @input="clearFieldError('nickname')"
            @keydown.enter.prevent="onFieldEnter"
          />
          <input
            v-if="mailNotify"
            v-model="form.email"
            class="form-input"
            type="email"
            placeholder="邮箱（仅用于回复通知，不公开）"
            maxlength="100"
            autocomplete="email"
            aria-label="邮箱"
            @keydown.enter.prevent="onFieldEnter"
          />
        </div>
        <!-- 字段级错误：就地显示并与输入框 aria-describedby 关联。
             只弹 toast 是不够的 —— 读屏用户听到一句提示，却不知道是哪个框错、
             也不知道焦点该往哪去。这里让错误「贴在该改的地方」。 -->
        <p v-if="fieldErrors.nickname" id="msg-err-nickname" class="field-error" role="alert">
          {{ fieldErrors.nickname }}
        </p>
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
          ref="contentRef"
          v-model="form.content"
          class="form-textarea"
          :class="{ 'is-invalid': fieldErrors.content }"
          rows="4"
          maxlength="2000"
          placeholder="写下你的留言…"
          aria-label="留言内容"
          :aria-invalid="fieldErrors.content ? 'true' : undefined"
          :aria-describedby="fieldErrors.content ? 'msg-err-content' : undefined"
          @input="clearFieldError('content')"
          @keydown="onTextareaKeydown"
        ></textarea>
        <p v-if="fieldErrors.content" id="msg-err-content" class="field-error" role="alert">
          {{ fieldErrors.content }}
        </p>
        <div class="form-actions">
          <button class="emoji-toggle" :class="{ active: showEmoji }" :aria-pressed="showEmoji" title="表情" aria-label="表情选择" @click="toggleEmoji">
            <XIcon name="Smile" :size="15" />
          </button>
          <span class="char-count" :class="{ near: form.content.length > 1800 }">{{ form.content.length }}/2000</span>
          <!-- 提交前就说明审核这回事。
               实测：提交前页面**没有任何地方**提到审核 ——
               读者填完、点提交、看到「等待审核后展示」才知道，
               在此之前完全不知道自己的留言不会立刻出现。
               审核开关是站点设置（message_moderation），但公开接口不下发它，
               前端无法提前判断；所以这里用的是**不依赖开关的中性措辞**：
               开启审核时它是准确的预告，未开启时它也不构成误导（「可能」）。 -->
          <span class="review-hint">留言可能需审核后展示</span>
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
import { ref, computed, onMounted, onUnmounted, watch, watchEffect, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import EmojiPicker from '@/components/ui/EmojiPicker.vue';
import { messageApi } from '@/api';
import { getFormTokenInfo, refreshFormToken, getHpField } from '@/utils/formToken';
import { timeAgo } from '@/utils/format';
import { readSessionValue, writeSessionValue } from '@/utils/secureStorage';
import { useSiteStore } from '@/stores/site';

// 浏览器标签页标题

const site = useSiteStore();

// 与其他站点页一致：一次写全 title / description / og:* / canonical。
// 原来这里只手动设了 document.title，
// 于是 og:title 落回站点通用值（缺页面名）、description 也是站点级的那句 ——
// 分享留言板链接时卡片显示的是「Xalor的小站」而不是「留言板」。
watchEffect(() => {
  // document.title 由页面自己写（applyPageMeta 只管 meta 标签，不管 <title>）
  const siteName = site.settings.site_name || 'Xalor的小站';
  document.title = `留言板 · ${siteName}`;
  applyPageMeta({
    title: '留言板',
    description: '有什么想说的，都可以留在这里',
    path: '/messages',
    site: site.settings,
  });
});
const mailNotify = computed(() => !!site.settings.mail_notify);
const messages = ref([]);
const page = ref(1);
const pageSize = 12;
const total = ref(0);
const submitting = ref(false);
const loading = ref(false);
const hasMore = ref(false);
// 昵称可长期记忆；邮箱只保留在当前标签页，旧 localStorage 值会迁移并清理。
let savedName = '';
let savedEmail = '';
try {
  savedName = localStorage.getItem('xalor_mname') || '';
} catch (e) { /* 隐私模式忽略 */ }
savedEmail = readSessionValue('xalor_memail');
const form = ref({ nickname: savedName, email: savedEmail, content: '' });
const hpField = ref(getHpField('/messages'));
// 表情面板折叠（与评论区共用偏好）
const showEmoji = ref((() => {
  try { return localStorage.getItem('xalor_emoji_open') === '1'; } catch (e) { return false; }
})());
function toggleEmoji() {
  showEmoji.value = !showEmoji.value;
  try {
    localStorage.setItem('xalor_emoji_open', showEmoji.value ? '1' : '0');
  } catch (e) { /* 隐私模式忽略 */ }
}

// ---------- 留言草稿本地保存（防误关/刷新丢内容） ----------
import { saveDraft, loadDraft, clearDraft as clearLocalDraft } from '@/utils/localDraft';
import { applyPageMeta } from '@/utils/pageMeta';
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
    // 用局部游标请求，成功后才推进 page：失败时游标不前移，
    // 否则下次"加载更多"会从跳过的页开始，中间一页留言永久丢失
    const next = page.value + 1;
    const res = await messageApi.list({ page: next, pageSize });
    page.value = next;
    messages.value = [...messages.value, ...res.list];
    hasMore.value = messages.value.length < res.pagination.total;
  } catch (e) {
    ElMessage.error('加载失败，请重试');
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

/**
 * 字段级错误。
 *
 * 为什么不是「只弹 toast」：ElMessage 是画面右侧飘一句话，
 * 它不会移动焦点，也不会在字段上留下任何标记。结果键盘/读屏用户
 * 提交之后只知道「有地方错了」，不知道是哪个框 —— 得自己从头摸一遍。
 * 这里的做法：字段上 aria-invalid + 就地错误文字 + aria-describedby 关联，
 * 提交失败时把焦点移到第一个出错的字段。toast 仍然保留（视觉反馈），
 * 但它不再是唯一的信息来源。
 */
const fieldErrors = ref({ nickname: '', content: '' });
const nicknameRef = ref(null);
const contentRef = ref(null);

function clearFieldError(key) {
  if (fieldErrors.value[key]) fieldErrors.value = { ...fieldErrors.value, [key]: '' };
}

/** 把焦点送到第一个出错的字段，并让它被读到 */
function focusFirstError() {
  const refs = { nickname: nicknameRef, content: contentRef };
  for (const key of ['nickname', 'content']) {
    if (!fieldErrors.value[key]) continue;
    const el = refs[key].value;
    if (el && typeof el.focus === 'function') {
      el.focus();
      // 已聚焦的输入框读屏会念出 aria-describedby 指向的错误文字
      return;
    }
  }
}

async function submit() {
  const nickname = form.value.nickname.trim();
  const content = form.value.content.trim();
  const next = { nickname: '', content: '' };
  if (!nickname) next.nickname = '请填写昵称';
  if (!content) next.content = '请填写留言内容（不能只有空格）';
  if (next.nickname || next.content) {
    fieldErrors.value = next;
    // 两件事都要做：toast 给视觉用户，焦点给键盘/读屏用户
    ElMessage.warning(next.nickname || next.content);
    await nextTick();
    focusFirstError();
    return;
  }
  fieldErrors.value = { nickname: '', content: '' };
  submitting.value = true;
  try {
    const { token: formToken, hpField: field } = await getFormTokenInfo('/messages');
    hpField.value = field;
    const res = await messageApi.create(
      {
        nickname,
        email: mailNotify.value ? form.value.email.trim() : '',
        content,
        [field]: form.value[field] || '',
        form_token: formToken,
      },
      { headers: { 'X-Hp-Field': field } }
    );
    // 审核开关打开时：提示"等待审核"而非"成功"（内容暂不显示）
    ElMessage.success(res?.moderated ? '留言已提交，等待审核后展示' : '留言成功');
    // 昵称长期记忆；邮箱仅在当前标签页内自动预填。
    try {
      localStorage.setItem('xalor_mname', nickname);
    } catch (e) { /* 隐私模式忽略 */ }
    writeSessionValue('xalor_memail', form.value.email.trim().slice(0, 100));
    form.value = { nickname, email: form.value.email.trim(), content: '' };
    clearDraft(); // 提交成功，清除本地草稿
    refreshFormToken('/messages');
    page.value = 1;
    await load();
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message || '';
    if (e?.response?.status === 403 && !/疑似机器人|提交过快/.test(msg)) {
      refreshFormToken('/messages');
    }
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
  getFormTokenInfo('/messages').catch(() => {});
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
  color: var(--accent-text);
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
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.form-input:focus,
.form-textarea:focus {
  border-color: var(--accent);
  background: var(--card);
}

/* 键盘聚焦：除了边框变色，再给一圈可见的焦点环。
   只写在这里而不是靠 main.css 的全局规则 —— 组件的 scoped 选择器
   （.form-input[data-v-x]）特指度高于全局 .form-input，全局那条打不过。
   这是本项目反复踩到的同一个坑，见 main.css 里的相关注释。 */
.form-input:focus-visible,
.form-textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
  /* 30px → 36px：表情按钮紧挨着输入框，点偏了会直接聚焦到输入框，
     手感上像「按钮没反应」。36px 是既能点中又不挤占表单行的折中。 */
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
  flex-shrink: 0;
}

.emoji-toggle:hover {
  color: var(--accent-text);
  border-color: var(--accent);
}

.emoji-toggle.active {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 快捷提交提示（桌面端显示） */
.review-hint {
  font-size: 0.76rem;
  color: var(--text-3);
}

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
  border-radius: 999px;
  background: var(--accent-fill);
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
