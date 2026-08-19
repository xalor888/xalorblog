<template>
  <div class="comment-item" :class="{ child: depth > 0 }">
    <div class="comment-card" :class="{ highlighted: isHighlighted }" :id="'comment-' + comment.id" :data-id="comment.id">
      <div class="avatar" :style="{ background: avatarColor }" @click="$emit('reply', comment)">
        <span>{{ initial }}</span>
      </div>

      <div class="comment-body">
        <div class="comment-head">
          <span v-if="floor && depth === 0" class="floor-num">#{{ floor }}</span>
          <span class="nickname" :class="{ admin: comment.is_admin }">{{ comment.nickname }}</span>
          <span v-if="comment.is_admin" class="admin-badge" title="博主"><XIcon name="Crown" :size="12" /></span>
          <a v-if="comment.website" :href="comment.website" target="_blank" rel="noopener nofollow" class="web" :title="comment.website">
            <XIcon name="Globe" :size="13" />
          </a>
          <span class="time" :title="'复制评论链接'" @click="copyCommentLink">{{ timeAgo(comment.created_at) }}</span>
        </div>

        <p class="comment-content">
          <span v-if="replyToName" class="at">@{{ replyToName }}：</span>
          {{ comment.content }}
        </p>

        <div class="comment-actions">
          <button
            class="like-btn"
            :class="{ liked }"
            :disabled="liking"
            :title="liked ? '已点赞' : '点赞这条评论'"
            @click="likeComment"
          >
            <XIcon name="Heart" :size="13" :fill="liked" /> {{ comment.likes || 0 }}
          </button>
          <button class="reply-btn" @click="$emit('reply', comment)">
            <XIcon name="MessageSquare" :size="13" /> 回复
          </button>
        </div>

        <div v-if="comment.children && comment.children.length" class="children">
          <!-- 深层（≥3 层）默认折叠，防长楼撑爆页面；信息不丢，可展开 -->
          <transition name="children-fade">
            <template v-if="depth < 2 || expanded">
              <CommentItem
                v-for="child in comment.children"
                :key="child.id"
                :comment="child"
                :depth="depth + 1"
                :reply-to-name="comment.nickname"
                :highlight-id="highlightId"
                @reply="$emit('reply', $event)"
              />
            </template>
          </transition>
          <button v-if="depth >= 2 && !expanded" class="expand-btn" :aria-expanded="expanded" @click="expanded = true">
            <XIcon name="MessageSquare" :size="12" /> 展开 {{ comment.children.length }} 条回复
          </button>
          <button v-else-if="depth >= 2 && expanded" class="expand-btn" :aria-expanded="expanded" @click="expanded = false">
            <XIcon name="Minus" :size="12" /> 收起回复
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { commentApi } from '@/api';
import { timeAgo } from '@/utils/format';

const props = defineProps({
  comment: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  replyToName: { type: String, default: '' },
  highlightId: { type: Number, default: null },
  floor: { type: Number, default: 0 },
});

defineEmits(['reply']);

// 深层子树折叠状态（≥3 层默认收起，直达链接定位时自动展开）
const expanded = ref(false);

function containsId(list, id) {
  if (!list) return false;
  return list.some((c) => c.id === id || containsId(c.children, id));
}

// 目标评论在本节点子树内 → 立即展开（供直达链接逐层穿透到深层回复）
watch(
  () => props.highlightId,
  (id) => {
    if (id && (id === props.comment.id || containsId(props.comment.children, id))) {
      expanded.value = true;
    }
  },
  { immediate: true }
);

const isHighlighted = computed(() => props.highlightId === props.comment.id);

const initial = computed(() => (props.comment.nickname || '?').charAt(0).toUpperCase());

/** 评论点赞：本地记忆（同设备只能赞一次）+ 乐观更新 */
const liked = ref(false);
const liking = ref(false);

// 初始化点赞状态：本地记忆或同页面已点赞过的评论
try {
  liked.value = localStorage.getItem(`xalor_clike_${props.comment.id}`) === '1';
} catch (e) { /* 隐私模式忽略 */ }

async function likeComment() {
  if (liked.value || liking.value) return;
  liking.value = true;
  // 乐观更新：先加一，失败回滚
  props.comment.likes = (props.comment.likes || 0) + 1;
  liked.value = true;
  try {
    const res = await commentApi.like(props.comment.id);
    if (res && typeof res.likes === 'number') props.comment.likes = res.likes;
    try {
      localStorage.setItem(`xalor_clike_${props.comment.id}`, '1');
    } catch (e) { /* 隐私模式忽略 */ }
  } catch (e) {
    // 失败回滚
    props.comment.likes = Math.max(0, (props.comment.likes || 1) - 1);
    liked.value = false;
  } finally {
    liking.value = false;
  }
}

/** 复制本条评论的直达链接（hash 路由下用 query 定位评论） */
async function copyCommentLink() {
  const url = `${location.origin}${location.pathname}${location.hash.split('?')[0]}?comment=${props.comment.id}`;
  const done = () => ElMessage.success('评论链接已复制');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      done();
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    }
  } catch (e) {
    ElMessage.error('复制失败，请手动复制地址栏链接');
  }
}

// 昵称哈希 → 渐变配色（无头像时）
const avatarColor = computed(() => {
  const s = props.comment.nickname || '?';
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
});

</script>

<style scoped>
.comment-item.child {
  margin-top: 14px;
}

.comment-card {
  display: flex;
  gap: 14px;
}

/* 被回复时闪烁高亮 */
.comment-card.highlighted {
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin: -10px -12px;
  animation: flashHighlight 2.2s var(--ease-out);
}

@keyframes flashHighlight {
  0% { background: var(--accent-soft); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent); }
  55% { background: var(--accent-soft); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent); }
  100% { background: transparent; box-shadow: 0 0 0 0 transparent; }
}

/* 头像 */
.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.95rem;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

/* 内容 */
.comment-body {
  flex: 1;
  min-width: 0;
}

.comment-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.nickname {
  font-weight: 650;
  font-size: 0.92rem;
  color: var(--text);
}

.nickname.admin {
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

.floor-num {
  font-family: var(--font-serif, Georgia, serif);
  font-size: 0.76rem;
  font-weight: 700;
  color: var(--text-3);
  background: var(--bg-soft);
  padding: 1px 8px;
  border-radius: 5px;
  font-variant-numeric: tabular-nums;
}

.web {
  color: var(--text-3);
  display: inline-flex;
  transition: color var(--dur) var(--ease);
}

.web:hover {
  color: var(--accent);
}

.time {
  font-size: 0.76rem;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}

.time:hover {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}

.comment-content {
  margin: 5px 0;
  font-size: 0.92rem;
  line-height: 1.8;
  color: var(--text);
  word-break: break-word;
  white-space: pre-wrap; /* 保留评论中的换行（多行评论不被折叠成一行） */
}

.at {
  color: var(--accent);
  font-weight: 600;
}

.comment-actions {
  margin-bottom: 2px;
}

.reply-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 6px;
  color: var(--text-3);
  font-size: 0.8rem;
  transition: all var(--dur) var(--ease);
}

.reply-btn:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 评论点赞：未点赞灰色，已点赞强调色 */
.like-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 6px;
  color: var(--text-3);
  font-size: 0.8rem;
  transition: all var(--dur) var(--ease);
}

.like-btn:hover:not(:disabled) {
  color: var(--accent);
  background: var(--accent-soft);
}

.like-btn.liked {
  color: var(--accent);
}

.like-btn:disabled {
  cursor: default;
  opacity: 0.85;
}

/* 楼中楼 */
.children {
  margin-top: 12px;
  padding: 14px 14px 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

/* 深层回复展开/收起 */
.expand-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0 10px;
  padding: 5px 14px;
  border: 1px dashed var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}

.expand-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

/* 展开/收起淡入 */
.children-fade-enter-active {
  transition: opacity 0.2s var(--ease);
}

.children-fade-enter-from {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .children-fade-enter-active {
    transition: none;
  }
}
</style>
