<template>
  <div class="links-page">
    <div class="container narrow">
      <div class="page-head fade-up">
        <p class="eyebrow">FRIENDS</p>
        <h1>友情链接</h1>
        <p class="lead">交换链接，一起成长</p>
      </div>

      <!-- 友链列表 -->
      <div v-if="links.length" class="link-grid" v-reveal="'stagger'">
        <a v-for="l in links" :key="l.id" :href="l.url" target="_blank" rel="noopener nofollow" class="link-card card fade-up">
          <div class="link-avatar" :style="{ background: avatarColor(l.name) }">
            <img v-if="l.avatar && !failedAvatars.has(l.id)" :src="l.avatar" :alt="l.name" @error="failedAvatars.add(l.id)" />
            <span v-if="!l.avatar || failedAvatars.has(l.id)">{{ (l.name || '?').charAt(0).toUpperCase() }}</span>
          </div>
          <div class="link-info">
            <span class="link-name">{{ l.name }}</span>
            <span class="link-desc">{{ l.description || l.url }}</span>
          </div>
          <span class="link-go"><XIcon name="ArrowUpRight" :size="15" /></span>
        </a>
      </div>
      <div v-else class="empty-state">
        <div class="icon-wrap"><XIcon name="Link2" :size="30" /></div>
        <p>还没有友链，来申请第一个吧</p>
      </div>

      <!-- 申请表单 -->
      <div class="apply-card card fade-up">
        <h3 class="apply-title">申请友链</h3>
        <p class="apply-tip">请先添加本站链接，再提交申请，审核通过后展示。</p>
        <div class="apply-grid">
          <div class="field">
            <label class="field-label">网站名称 *</label>
            <input v-model="form.name" class="field-input" maxlength="80" placeholder="你的网站名称" />
          </div>
          <div class="field">
            <label class="field-label">网站地址 *</label>
            <input v-model="form.url" class="field-input" type="url" maxlength="300" placeholder="https://example.com" autocomplete="url" />
          </div>
          <div class="field">
            <label class="field-label">网站图标 URL</label>
            <input v-model="form.avatar" class="field-input" type="url" maxlength="500" placeholder="https://…/icon.png" />
          </div>
          <div class="field">
            <label class="field-label">联系邮箱</label>
            <input v-model="form.email" class="field-input" type="email" maxlength="100" placeholder="用于审核反馈" autocomplete="email" />
          </div>
        </div>
        <div class="field">
          <label class="field-label">一句话介绍</label>
          <input v-model="form.description" class="field-input" maxlength="200" placeholder="简单介绍你的网站" />
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
        <div class="apply-actions">
          <button class="apply-btn" :disabled="submitting" @click="submit">
            {{ submitting ? '提交中…' : '提交申请' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watchEffect } from 'vue';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { linkApi } from '@/api';
import { getFormTokenInfo, refreshFormToken, getHpField } from '@/utils/formToken';

// 浏览器标签页标题
watchEffect(() => {
  document.title = '友情链接';
});

const links = ref([]);
const submitting = ref(false);
const failedAvatars = ref(new Set());
const form = ref({ name: '', url: '', avatar: '', email: '', description: '' });
const hpField = ref(getHpField('/links'));

// 昵称哈希 → 渐变配色（无头像兜底）
function avatarColor(name) {
  const s = name || '?';
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
  links.value = await linkApi.list();
}

async function submit() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写网站名称');
  if (!form.value.url.trim()) return ElMessage.warning('请填写网站地址');
  submitting.value = true;
  try {
    const { token: formToken, hpField: field } = await getFormTokenInfo('/links');
    hpField.value = field;
    await linkApi.apply(
      {
        ...form.value,
        [field]: form.value[field] || '',
        form_token: formToken,
      },
      { headers: { 'X-Hp-Field': field } }
    );
    ElMessage.success('申请已提交，等待审核 😊');
    form.value = { name: '', url: '', avatar: '', email: '', description: '' };
    refreshFormToken('/links');
  } catch (e) {
    if (e?.response?.status === 403) refreshFormToken('/links');
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.links-page {
  padding-bottom: 60px;
}

.narrow {
  max-width: 760px;
}

.page-head .eyebrow {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--accent);
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* 友链 */
.link-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 44px;
}

.link-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  transition: all var(--dur) var(--ease);
}

.link-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-2);
  transform: translateY(-4px) scale(1.01);
}

.link-avatar {
  width: 50px;
  height: 50px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  font-size: 1.2rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.link-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.link-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.link-name {
  font-weight: 650;
  font-size: 0.96rem;
  transition: color var(--dur) var(--ease);
}

.link-card:hover .link-name {
  color: var(--accent);
}

.link-desc {
  font-size: 0.8rem;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-go {
  color: var(--text-3);
  opacity: 0;
  transform: translate(-4px, 4px);
  transition: all var(--dur) var(--ease);
  flex-shrink: 0;
}

.link-card:hover .link-go {
  opacity: 1;
  transform: none;
  color: var(--accent);
}

/* 申请表单 */
.apply-card {
  padding: 28px 30px;
}

.apply-title {
  font-size: 1.15rem;
  font-weight: 750;
  margin-bottom: 4px;
}

.apply-tip {
  color: var(--text-3);
  font-size: 0.85rem;
  margin-bottom: 22px;
}

.apply-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 14px;
}

.field {
  margin-bottom: 14px;
}

.field-label {
  display: block;
  font-size: 0.82rem;
  color: var(--text-2);
  margin-bottom: 6px;
  font-weight: 550;
}

.field-input {
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

.field-input:focus {
  border-color: var(--accent);
  background: var(--card);
}

.apply-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
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

.apply-btn {
  padding: 10px 30px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-size: 0.9rem;
  font-weight: 600;
  transition: all var(--dur) var(--ease);
}

.apply-btn:hover:not(:disabled) {
  opacity: 0.88;
  transform: translateY(-1px);
}

.apply-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .link-grid {
    grid-template-columns: 1fr;
  }
  .apply-grid {
    grid-template-columns: 1fr;
  }
}
</style>
