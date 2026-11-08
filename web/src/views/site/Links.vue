<template>
  <div class="links-page">
    <div class="container narrow">
      <div class="page-head fade-up">
        <p class="eyebrow">FRIENDS</p>
        <h1>友情链接</h1>
        <p class="lead">交换链接，一起成长</p>
      </div>

      <!-- 友链列表 -->
      <SkeletonList v-if="listLoading && !links.length" :count="3" />
      <!-- 加载失败要区别于「还没有友链」：一个该检查网络，一个该去申请。
           原来 load() 没有 try/catch，请求一失败 links 就是空数组，
           页面显示「还没有友链，来申请第一个吧」—— 等于把接口故障说成内容为空。 -->
      <div v-else-if="listFailed" class="empty-state list-error" role="alert">
        <div class="icon-wrap"><XIcon name="ShieldAlert" :size="30" /></div>
        <p>友链加载失败，可能是网络波动或服务暂时不可用</p>
        <button class="retry-btn" @click="load">重试</button>
      </div>
      <div v-else-if="links.length" class="link-grid" v-reveal="'stagger'">
        <a v-for="l in links" :key="l.id" :href="l.url" target="_blank" rel="noopener noreferrer nofollow" class="link-card card fade-up">
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

      <!-- 申请表单。
           用 <form> 而不是 <div>：原生 <form> 才有「回车提交」与浏览器内置校验
           （type="url" 的格式提示、required 的必填提示）。原来是一堆裸 input 套 div，
           键盘用户按回车什么也不会发生，移动端也失去 autocomplete 的联想。 -->
      <form class="apply-card card fade-up" @submit.prevent="submit">
        <!-- h2 而不是 h3：本页 h1 是「友情链接」，中间没有分区标题，
             用 h3 会造成 h1→h3 跳级（实测本页跳级就是这一处）。
             样式走 .apply-title 类，不依赖标签名。 -->
        <h2 class="apply-title">申请友链</h2>
        <p class="apply-tip">请先添加本站链接，再提交申请，审核通过后展示。</p>
        <div class="apply-grid">
          <div class="field">
            <label class="field-label" for="link-name">网站名称 *</label>
            <input id="link-name" v-model="form.name" class="field-input" maxlength="80" placeholder="你的网站名称" required />
          </div>
          <div class="field">
            <label class="field-label" for="link-url">网站地址 *</label>
            <input id="link-url" v-model="form.url" class="field-input" type="url" maxlength="300" placeholder="https://example.com" autocomplete="url" required />
          </div>
          <div class="field">
            <label class="field-label" for="link-avatar">网站图标 URL</label>
            <input id="link-avatar" v-model="form.avatar" class="field-input" type="url" maxlength="500" placeholder="https://…/icon.png" />
          </div>
          <div v-if="mailNotify" class="field">
            <label class="field-label" for="link-email">联系邮箱</label>
            <input id="link-email" v-model="form.email" class="field-input" type="email" maxlength="100" placeholder="用于审核反馈" autocomplete="email" />
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="link-desc">一句话介绍</label>
          <input id="link-desc" v-model="form.description" class="field-input" maxlength="200" placeholder="简单介绍你的网站" />
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
          <button type="submit" class="apply-btn" :disabled="submitting">
            {{ submitting ? '提交中…' : '提交申请' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import SkeletonList from '@/components/ui/SkeletonList.vue';
import { linkApi } from '@/api';
import { getFormTokenInfo, refreshFormToken, getHpField } from '@/utils/formToken';
import { useSiteStore } from '@/stores/site';
import { applyPageMeta } from '@/utils/pageMeta';

// 浏览器标签页标题

const site = useSiteStore();

watchEffect(() => {
  const siteName = site.settings.site_name || 'Xalor的小站';
  const pageTitle = '友情链接';
  document.title = `${pageTitle} · ${siteName}`;
  // 元信息与标题同源设置：canonical / og:url / og:image 缺一都会让分享卡片降级

  applyPageMeta({ title: pageTitle, description: '友链与申请方式', path: '/links', site });
});
const mailNotify = computed(() => !!site.settings.mail_notify);
const links = ref([]);
const submitting = ref(false);
const listLoading = ref(false);
const listFailed = ref(false);
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
  // 必须自己兜住：onMounted 里是裸调用 load()，拦截器 reject 出来没人接 ——
  // 首屏就是一次未处理的 Promise rejection，而 links 仍是 []，
  // 模板落到空态显示「还没有友链，来申请第一个吧」，且没有重试入口。
  listLoading.value = true;
  listFailed.value = false;
  try {
    links.value = await linkApi.list();
  } catch (e) {
    listFailed.value = true; // toast 由拦截器统一弹，这里只负责页面内失败态
  } finally {
    listLoading.value = false;
  }
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
        email: mailNotify.value ? form.value.email : '',
        [field]: form.value[field] || '',
        form_token: formToken,
      },
      { headers: { 'X-Hp-Field': field } }
    );
    ElMessage.success('申请已提交，等待审核 😊');
    form.value = { name: '', url: '', avatar: '', email: '', description: '' };
    refreshFormToken('/links');
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message || '';
    if (e?.response?.status === 403 && !/疑似机器人|提交过快/.test(msg)) {
      refreshFormToken('/links');
    }
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  load();
  getFormTokenInfo('/links').catch(() => {});
});
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
  color: var(--accent-text);
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
  /* 友链名称由访客申请时填写，超长英文/URL 会撑破卡片 */
  overflow-wrap: anywhere;

  font-weight: 650;
  font-size: 0.96rem;
  transition: color var(--dur) var(--ease);
}

.link-card:hover .link-name {
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  background: var(--accent-fill);
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

/* 加载失败态的重试按钮：.retry-btn 的完整样式在 ArticleList 的 scoped 块里，
   这里引用不到，所以本组件自带一份最小实现。 */
.list-error .retry-btn {
  margin-top: 16px;
  min-height: 40px;
  padding: 8px 28px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--accent-fill);
  color: #fff;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease);
}

.list-error .retry-btn:hover {
  opacity: 0.88;
}

.list-error .retry-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
