<template>
  <div class="comment-section">
    <h3 class="comment-title">
      评论
      <span class="count">{{ total }}</span>
      <!-- 排序切换：仅影响根评论顺序，回复始终按时间正序保持对话连贯 -->
      <span v-if="total > 1" class="comment-sort">
        <button
          class="cs-btn"
          :class="{ active: sortOrder === 'asc' }"
          :aria-pressed="sortOrder === 'asc'"
          @click="setSort('asc')"
        >最早</button>
        <button
          class="cs-btn"
          :class="{ active: sortOrder === 'desc' }"
          :aria-pressed="sortOrder === 'desc'"
          @click="setSort('desc')"
        >最新</button>
      </span>
    </h3>

    <!-- 评论表单 -->
    <div class="comment-form card">
      <div class="form-row">
        <input v-model="form.nickname" class="form-input" placeholder="昵称 *" maxlength="50" autocomplete="nickname" aria-label="昵称"
          @keydown.enter.prevent="onFieldEnter" />
        <input v-model="form.email" class="form-input" type="email" placeholder="邮箱（仅用于回复通知，不公开）" maxlength="100" autocomplete="email" aria-label="邮箱"
          @keydown.enter.prevent="onFieldEnter" />
      </div>
      <input v-model="form.website" class="form-input" placeholder="网站 / 博客（可选）" maxlength="200" autocomplete="url" aria-label="网站"
        @keydown.enter.prevent="onFieldEnter" />
      <!-- 随机蜜罐字段：字段名由服务端动态签发，人类不可见，机器人无法预知 -->
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
      <!-- 回复上下文：展示父评论摘要，确认回复对象（点击可跳回父评论） -->
      <div v-if="replyingTo" class="reply-context">
        <XIcon name="CornerUpRight" :size="14" />
        <button class="rc-context-link" title="跳回父评论" @click="jumpToParent">
          <span class="rc-context-nick">@{{ replyingTo.nickname }}：</span>
          <span class="rc-context-text">{{ String(replyingTo.content || '').slice(0, 60) }}{{ replyingTo.content && replyingTo.content.length > 60 ? '…' : '' }}</span>
        </button>
        <button class="rc-context-cancel" title="取消回复" aria-label="取消回复" @click="cancelReply">
          <XIcon name="X" :size="13" />
        </button>
      </div>
      <textarea
        ref="formTextarea"
        v-model="form.content"
        class="form-textarea"
        rows="4"
        maxlength="2000"
        :placeholder="replyingTo ? `回复 @${replyingTo.nickname}：` : '写下你的评论…'"
        aria-label="评论内容"
        @keydown="onTextareaKeydown"
      ></textarea>
      <div class="form-actions">
        <button class="emoji-toggle" :class="{ active: showEmoji }" :aria-pressed="showEmoji" title="表情" aria-label="表情选择" @click="toggleEmoji">
          <XIcon name="Smile" :size="15" />
        </button>
        <span v-if="replyingTo" class="reply-target" @click="cancelReply">
          回复 @{{ replyingTo.nickname }} <XIcon name="X" :size="13" />
        </span>
        <span class="char-count" :class="{ near: form.content.length > 1800 }">{{ form.content.length }}/2000</span>
        <span class="shortcut-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 提交</span>
        <button class="submit-btn" :disabled="submitting" @click="submit">
          {{ submitting ? '发送中…' : '发表评论' }}
        </button>
      </div>
    </div>

    <!-- 评论列表 -->
    <div v-if="loading" class="comment-loading">
      <span class="cl-dot"></span><span class="cl-dot"></span><span class="cl-dot"></span>
      <p>正在加载评论…</p>
    </div>
    <div v-else-if="loadFailed" class="comment-load-failed">
      <p>评论加载失败</p>
      <button class="more-replies-btn" @click="load">重试</button>
    </div>
    <div v-else-if="comments.length" class="comment-list">
      <CommentItem
        v-for="(c, idx) in visibleComments"
        :key="c.id"
        :comment="c"
        :depth="0"
        :floor="idx + 1"
        :highlight-id="flashId"
        @reply="startReply"
      />
      <div v-if="visibleComments.length < comments.length" class="comment-more">
        <button class="more-replies-btn" @click="showAll = true">
          展开剩余 {{ comments.length - visibleComments.length }} 条评论
        </button>
      </div>
    </div>
    <div v-else class="comment-empty">
      <XIcon name="MessagesSquare" :size="26" />
      <p>还没有评论，来发表第一条吧</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import EmojiPicker from '@/components/ui/EmojiPicker.vue';
import CommentItem from './CommentItem.vue';
import { commentApi } from '@/api';
import { getFormTokenInfo, refreshFormToken, getHpField } from '@/utils/formToken';
import { readSessionValue, writeSessionValue } from '@/utils/secureStorage';

const props = defineProps({
  articleId: { type: Number, required: true },
  /** 直达链接定位的评论 id（如 ?comment=12），加载后自动滚动并高亮 */
  initialHighlight: { type: [Number, String], default: null },
});

const comments = ref([]);
const total = ref(0);
const submitting = ref(false);
const replyingTo = ref(null);
const flashId = ref(null);
const showAll = ref(false);
const loadFailed = ref(false);
const loading = ref(false);
const INITIAL_COUNT = 5;
// 评论排序：asc=最早在前（默认）/ desc=最新在前（记忆偏好）
const sortOrder = ref(localStorage.getItem('xalor_csort') || 'asc');
function setSort(order) {
  if (sortOrder.value === order) return;
  sortOrder.value = order;
  localStorage.setItem('xalor_csort', order);
  load();
}
// 昵称可长期记忆；邮箱只保留在当前标签页，旧 localStorage 值会迁移并清理。
let savedName = '';
let savedEmail = '';
try {
  savedName = localStorage.getItem('xalor_cname') || '';
} catch (e) { /* 隐私模式忽略 */ }
savedEmail = readSessionValue('xalor_cemail');
const form = ref({ nickname: savedName, email: savedEmail, website: '', content: '' });
const formTextarea = ref(null);
const hpField = ref(getHpField('/comments'));
// 表情面板折叠（默认收起，表单更紧凑；点开常用后常开）
const showEmoji = ref(localStorage.getItem('xalor_emoji_open') === '1');
function toggleEmoji() {
  showEmoji.value = !showEmoji.value;
  try {
    localStorage.setItem('xalor_emoji_open', showEmoji.value ? '1' : '0');
  } catch (e) { /* 隐私模式忽略 */ }
}

// ---------- 评论草稿本地保存（防误关/刷新丢长评论） ----------
import { saveDraft, loadDraft, clearDraft as clearLocalDraft } from '@/utils/localDraft';
const DRAFT_KEY = () => `xalor_cdraft_${props.articleId}`;
let draftTimer = null;

// 恢复上次未提交的草稿（24 小时内且内容非空才恢复，直接填充不打扰）
const restored = loadDraft(DRAFT_KEY());
if (restored) {
  form.value.content = restored;
  setTimeout(() => ElMessage.info('已恢复上次未提交的评论草稿'), 400);
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    saveDraft(DRAFT_KEY(), form.value.content);
  }, 800);
}

function clearDraft() {
  clearTimeout(draftTimer);
  clearLocalDraft(DRAFT_KEY());
}

watch(
  () => form.value.content,
  () => scheduleDraftSave()
);

const visibleComments = computed(() => (showAll.value ? comments.value : comments.value.slice(0, INITIAL_COUNT)));

let flashTimer = null;

let loadSeq = 0; // 请求序号：文章快速切换时丢弃过期响应（防旧文章评论覆盖新文章）
async function load() {
  const my = ++loadSeq;
  loading.value = true;
  loadFailed.value = false;
  try {
    const tree = await commentApi.list(props.articleId, sortOrder.value);
    if (my !== loadSeq) return; // 已有更新的加载请求，丢弃本次响应
    comments.value = tree;
    total.value = countAll(tree);
    showAll.value = false;
    // 直达链接定位：展开到目标评论并滚动高亮
    const target = Number(props.initialHighlight);
    if (target) {
      const depth = findDepth(tree, target);
      if (depth >= 0) showAll.value = true;
      flashId.value = target;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashId.value = null;
      }, 3000);
      await nextTick();
      const el = document.querySelector(`.comment-card[data-id="${target}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (e) {
    if (my !== loadSeq) return;
    loadFailed.value = true;
  } finally {
    if (my === loadSeq) loading.value = false;
  }
}

/** 查找评论所在层级（0=顶层），不存在返回 -1 */
function findDepth(list, id) {
  for (const c of list) {
    if (c.id === id) return 0;
    const d = findDepth(c.children || [], id);
    if (d >= 0) return d + 1;
  }
  return -1;
}

function countAll(list) {
  return list.reduce((sum, c) => sum + 1 + countAll(c.children || []), 0);
}

function startReply(comment) {
  replyingTo.value = comment;
  // 目标评论闪烁高亮，提示正在回复谁
  flashId.value = comment.id;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashId.value = null;
  }, 2200);
  const el = document.querySelector('.comment-form');
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // 自动聚焦输入框（回复意图明确，省去手动点击）
  nextTick(() => formTextarea.value?.focus());
}

/** 跳回父评论：滚动定位并高亮（上下文直达） */
function jumpToParent() {
  const el = document.querySelector(`#comment-${replyingTo.value?.id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashId.value = replyingTo.value.id;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashId.value = null;
  }, 2200);
}

function cancelReply() {
  replyingTo.value = null;
}

function insertEmoji(emoji) {
  // 光标处插入（与正文编辑器同模式）；textarea 不可用时回退追加
  const textarea = formTextarea.value;
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

/** 昵称/邮箱输入框 Enter：顺移焦点到正文（快速填表流程） */
function onFieldEnter() {
  formTextarea.value?.focus();
}

/** Ctrl/Cmd + Enter 快捷提交评论（桌面端输入体验） */
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
  if (!content) return ElMessage.warning('请填写评论内容');
  submitting.value = true;
  try {
    const { token: formToken, hpField: field } = await getFormTokenInfo('/comments');
    hpField.value = field;
    const created = await commentApi.create(
      {
        article_id: props.articleId,
        parent_id: replyingTo.value?.id || null,
        nickname,
        email: form.value.email.trim(),
        website: form.value.website.trim(),
        content,
        [field]: form.value[field] || '',
        form_token: formToken,
      },
      { headers: { 'X-Hp-Field': field } }
    );
    // 审核开关打开时：提示"等待审核"而非"成功"（内容暂不显示）
    ElMessage.success(created?.moderated ? '评论已提交，等待审核后展示' : '评论成功');
    // 昵称长期记忆；邮箱仅在当前标签页内自动预填。
    try {
      if (form.value.nickname.trim()) localStorage.setItem('xalor_cname', form.value.nickname.trim().slice(0, 50));
    } catch (e) { /* 隐私模式忽略 */ }
    writeSessionValue('xalor_cemail', form.value.email.trim().slice(0, 100));
    form.value.content = '';
    clearDraft(); // 提交成功，清除本地草稿
    if (!replyingTo.value) {
      form.value.nickname = '';
      form.value.email = '';
      form.value.website = '';
    }
    replyingTo.value = null;
    refreshFormToken('/comments'); // 令牌已消费，下次重新获取
    await load();
    await scrollToNewComment(created?.id); // 用服务端返回的新评论 id 精确定位（回复场景不错位）
  } catch (e) {
    if (e?.response?.status === 403) refreshFormToken('/comments'); // 令牌问题，刷新后重试
  } finally {
    submitting.value = false;
  }
}

/** 提交成功后：展开列表、滚动到新评论并高亮 */
async function scrollToNewComment(newId) {
  // 新评论可能在子回复中：全树查找目标节点
  const target = findComment(comments.value, newId);
  const lastRoot = comments.value[comments.value.length - 1];
  const anchor = target || lastRoot;
  if (!anchor) return;
  // 若被折叠则自动展开
  if (comments.value.length > INITIAL_COUNT) showAll.value = true;
  flashId.value = anchor.id;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashId.value = null;
  }, 2400);
  await nextTick();
  const el = document.querySelector(`.comment-card[data-id="${anchor.id}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 在评论树中查找指定 id 的评论节点 */
function findComment(list, id) {
  if (!id) return null;
  for (const c of list) {
    if (c.id === id) return c;
    const found = findComment(c.children || [], id);
    if (found) return found;
  }
  return null;
}

/** 立即落盘当前草稿（路由卸载 / 浏览器关闭前统一调用） */
function flushDraft() {
  clearTimeout(draftTimer);
  saveDraft(DRAFT_KEY(), form.value.content);
}

onMounted(() => {
  load();
  // 浏览器关闭/刷新前落盘（beforeunload 场景 watch 防抖可能来不及）
  window.addEventListener('beforeunload', flushDraft);
});

onUnmounted(() => {
  // 清理高亮闪烁定时器，防组件卸载后回调泄漏
  clearTimeout(flashTimer);
  // 立即落盘未完成的草稿（防卸载丢失防抖窗口内的输入）
  flushDraft();
  window.removeEventListener('beforeunload', flushDraft);
});

// 文章切换（上一篇/下一篇等）：文章 id 或直达评论变化时重新加载并定位
watch(
  () => [props.articleId, props.initialHighlight],
  () => {
    // 组件复用（未卸载）时刷新评论列表，保证新文章的评论与直达高亮生效
    load();
  }
);
</script>

<style scoped>
.comment-section {
  margin-top: 48px;
}

.comment-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 1.15rem;
  font-weight: 750;
  margin-bottom: 22px;
  letter-spacing: -0.01em;
}

.count {
  font-size: 0.78rem;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 10px;
  border-radius: 999px;
  font-weight: 650;
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

/* 表情开关按钮 */
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

/* 回复上下文：父评论摘要确认 */
.reply-context {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 8px 12px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: 0.82rem;
}

.rc-context-nick {
  color: var(--accent);
  font-weight: 650;
  flex-shrink: 0;
}

.rc-context-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-context-link {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}

.rc-context-link:hover .rc-context-text {
  color: var(--accent);
}

.rc-context-cancel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: auto;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--dur) var(--ease);
}

.rc-context-cancel:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 评论排序切换 */
.comment-sort {
  display: inline-flex;
  gap: 3px;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-soft);
}

.cs-btn {
  padding: 3px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  font-size: 0.76rem;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}

.cs-btn:hover {
  color: var(--accent);
}

.cs-btn.active {
  background: var(--card);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}

/* 表单 */
.comment-form {
  padding: 20px 22px;
  margin-bottom: 32px;
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
  margin-bottom: 12px;
}

.form-input:focus,
.form-textarea:focus {
  border-color: var(--accent);
  background: var(--card);
}

.form-input {
  margin-bottom: 0;
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

.form-textarea {
  resize: vertical;
  line-height: 1.7;
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

/* 快捷提交提示（桌面端显示，触屏无键盘隐藏） */
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

.reply-target {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.84rem;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease);
}

.reply-target:hover {
  opacity: 0.8;
}

.submit-btn {
  padding: 9px 26px;
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
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 30%, transparent);
}

.submit-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 列表 */
.comment-loading {
  text-align: center;
  padding: 36px 0;
  color: var(--text-3);
  font-size: 0.9rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.comment-loading p {
  margin: 0;
}

.cl-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  animation: clPulse 1.2s ease-in-out infinite;
}

.cl-dot:nth-child(2) { animation-delay: 0.15s; }
.cl-dot:nth-child(3) { animation-delay: 0.3s; }

@keyframes clPulse {
  0%, 100% { opacity: 0.25; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}

.comment-load-failed {
  text-align: center;
  padding: 36px 0;
  color: var(--text-3);
  font-size: 0.9rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.comment-load-failed .more-replies-btn {
  margin: 0;
}

.comment-empty {
  text-align: center;
  padding: 48px 0;
  color: var(--text-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.comment-empty p {
  font-size: 0.9rem;
}

/* 展开更多评论 */
.comment-more {
  text-align: center;
  margin-top: 16px;
}

.more-replies-btn {
  padding: 8px 24px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.86rem;
  transition: all var(--dur) var(--ease);
}

.more-replies-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

@media (max-width: 560px) {
  .form-row {
    flex-direction: column;
    gap: 12px;
  }
}
</style>
