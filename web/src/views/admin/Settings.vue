<template>
  <div class="settings-page">
    <!-- 基本设置 -->
    <div class="setting-card card">
      <h3 class="card-title">基本设置</h3>
      <el-form :model="form" label-width="110px" class="setting-form">
        <el-form-item label="站点名称">
          <el-input v-model="form.site_name" maxlength="50" />
        </el-form-item>
        <el-form-item label="站点描述">
          <el-input v-model="form.site_desc" maxlength="200" />
        </el-form-item>
        <el-form-item label="站点公告">
          <el-input v-model="form.announcement" maxlength="200" placeholder="显示在顶部公告栏" />
        </el-form-item>
        <el-form-item label="页脚文案">
          <el-input v-model="form.footer" maxlength="200" placeholder="例如 © 2026 Xalor的小站（年份自动更新）" />
        </el-form-item>
        <el-form-item label="站点 URL">
          <el-input v-model="form.site_url" placeholder="https://blog.example.com（RSS/Sitemap/分享链接使用，留空自动推导）" />
        </el-form-item>
        <el-form-item label="头像">
          <div class="avatar-field">
            <el-input v-model="form.avatar" placeholder="头像图片 URL" />
            <el-upload :show-file-list="false" :http-request="doUpload" accept="image/*">
              <el-button :loading="uploading">
                <template #icon><XIcon name="Upload" :size="15" /></template>
                上传
              </el-button>
            </el-upload>
            <img
              v-if="form.avatar"
              :src="form.avatar"
              alt="头像预览"
              class="avatar-preview"
              @error="$event.target.style.display = 'none'"
              @load="$event.target.style.display = ''"
            />
          </div>
        </el-form-item>
      </el-form>
    </div>

    <!-- 社交链接 -->
    <div class="setting-card card">
      <h3 class="card-title">社交链接</h3>
      <el-form :model="form" label-width="110px" class="setting-form">
        <el-form-item label="GitHub">
          <el-input v-model="form.social_github" placeholder="https://github.com/你的账号" />
        </el-form-item>
        <el-form-item label="微博">
          <el-input v-model="form.social_weibo" placeholder="https://weibo.com/你的账号" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="form.social_email" placeholder="you@example.com" />
        </el-form-item>
      </el-form>
    </div>

    <!-- 内容审核 -->
    <div class="setting-card card">
      <h3 class="card-title">内容审核</h3>
      <el-form label-width="130px" class="setting-form">
        <el-form-item label="评论审核">
          <el-switch v-model="form.comment_moderation" />
          <span class="switch-tip">开启后新评论默认进入待审，需在后台「评论管理」中通过</span>
        </el-form-item>
        <el-form-item label="留言审核">
          <el-switch v-model="form.message_moderation" />
          <span class="switch-tip">开启后新留言默认进入待审，需在后台「留言管理」中通过</span>
        </el-form-item>
        <el-form-item label="友链审核">
          <el-switch :model-value="true" disabled />
          <span class="switch-tip">友链申请固定进入待审，在「友链管理」中通过</span>
        </el-form-item>
        <el-form-item label="RSS 全文输出">
          <el-switch v-model="form.rss_full_content" />
          <span class="switch-tip">开启输出全文（content:encoded）；关闭则仅输出摘要，引导阅读全文回访站点</span>
        </el-form-item>
        <el-form-item label="版权声明">
          <el-input
            v-model="form.copyright_text"
            type="textarea"
            :rows="2"
            maxlength="300"
            show-word-limit
            placeholder="留空使用默认声明：署名-非商业性使用 4.0 国际 (CC BY-NC 4.0)"
          />
          <span class="switch-tip">显示在文章页版权卡片；仅支持纯文本（自动转义，不解析 HTML）</span>
        </el-form-item>
        <el-form-item label="ICP 备案号">
          <el-input v-model="form.icp" maxlength="50" placeholder="如 京ICP备00000000号（留空不显示）" />
          <span class="switch-tip">显示在页脚底部，用于国内服务器备案信息公示</span>
        </el-form-item>
      </el-form>
    </div>

    <!-- 关于页 -->
    <div class="setting-card card">
      <h3 class="card-title">关于页内容（Markdown）</h3>
      <el-input
        v-model="form.about_content"
        type="textarea"
        :rows="12"
        class="about-editor"
        placeholder="支持 Markdown 语法…"
      />
      <div class="preview-block">
        <span class="preview-label">预览：</span>
        <div class="markdown-body about-preview" v-html="aboutHtml"></div>
      </div>
    </div>

    <!-- 修改密码 -->
    <div class="setting-card card">
      <h3 class="card-title">修改密码</h3>
      <el-form :model="pwdForm" label-width="110px" class="setting-form">
        <el-form-item label="旧密码">
          <el-input v-model="pwdForm.oldPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少 8 位，且不能纯数字或纯字母" />
        </el-form-item>
        <el-form-item>
          <el-button type="warning" :loading="pwdLoading" @click="changePassword">修改密码</el-button>
        </el-form-item>
      </el-form>
    </div>

    <!-- 后台访问信息 -->
    <div class="setting-card card">
      <h3 class="card-title">后台访问信息</h3>
      <div class="admin-path-body">
        <p class="twofa-desc">
          本站后台使用秘钥路径（非固定 <code>/admin</code>），由服务端 <code>JWT_SECRET</code> 派生。
          记下并妥善保管此路径，配合用户名密码（建议开启两步验证）登录。
        </p>
        <div class="admin-path-row">
          <code class="admin-path-value">{{ fullAdminUrl }}</code>
          <el-button size="small" type="primary" plain @click="copyAdminUrl">复制地址</el-button>
        </div>
      </div>
    </div>

    <!-- 两步验证（TOTP） -->
    <div class="setting-card card">
      <h3 class="card-title">两步验证（TOTP）</h3>
      <div class="twofa-body">
        <div v-if="twoFaEnabled" class="twofa-enabled">
          <span class="twofa-badge"><XIcon name="ShieldCheck" :size="15" /> 已启用</span>
          <p class="twofa-desc">
            登录时需额外输入身份验证器中的 6 位动态码，即使密码泄露也无法登录。
          </p>
          <div class="twofa-action">
            <el-input
              v-model="disableCode"
              placeholder="输入当前动态码以关闭"
              maxlength="6"
              class="twofa-code-input"
            />
            <el-button type="danger" plain :loading="twoFaLoading" @click="disableTwoFa">关闭两步验证</el-button>
          </div>
        </div>

        <div v-else-if="twoFaSetupUri" class="twofa-setup">
          <div class="setup-grid">
            <div class="qr-wrap">
              <!-- 无法生成二维码图片，用文本形式展示密钥，用户可手动输入 -->
              <div class="qr-fallback">
                <XIcon name="QrCode" :size="30" />
                <span>密钥</span>
              </div>
              <code class="twofa-secret">{{ twoFaSecret }}</code>
              <el-button size="small" text type="primary" @click="copyTwoFaSecret">复制密钥</el-button>
            </div>
            <div class="setup-tips">
              <p class="tips-title">如何启用：</p>
              <ol class="tips-list">
                <li>打开身份验证器应用（如 Google Authenticator / 微软 Authenticator）</li>
                <li>选择「扫描二维码」或「手动输入密钥」</li>
                <li>将上方密钥手动输入，或直接使用下方链接</li>
                <li>输入应用生成的 6 位动态码完成启用</li>
              </ol>
              <a :href="twoFaSetupUri" target="_blank" rel="noopener" class="otpauth-link">
                <XIcon name="ExternalLink" :size="13" /> 点击添加到验证器
              </a>
            </div>
          </div>
          <div class="twofa-action">
            <el-input
              v-model="setupCode"
              placeholder="输入 6 位动态码完成启用"
              maxlength="6"
              class="twofa-code-input"
            />
            <el-button type="primary" :loading="twoFaLoading" @click="verifyTwoFa">启用两步验证</el-button>
          </div>
        </div>

        <div v-else class="twofa-off">
          <p class="twofa-desc">
            两步验证可为后台登录提供第二道防线：密码 + 动态验证码双重校验。
            建议启用，防止密码泄露导致后台失守。
          </p>
          <el-button type="primary" plain :loading="twoFaLoading" @click="setupTwoFa">
            <template #icon><XIcon name="KeyRound" :size="15" /></template>
            立即开启
          </el-button>
        </div>
      </div>
    </div>

    <!-- 活跃会话 -->
    <div class="setting-card card">
      <h3 class="card-title">
        活跃会话
        <span class="card-hint">共 {{ sessions.length }} 个</span>
      </h3>
      <div class="session-body">
        <div v-if="!sessions.length" class="panel-empty">
          <p>暂无会话记录</p>
        </div>
        <div v-else class="session-list">
          <div v-for="s in sessions" :key="s.jti" class="session-item" :class="{ expired: s.expired || s.revoked }">
            <div class="session-info">
              <div class="session-device">
                <XIcon name="MonitorSmartphone" :size="15" />
                <span>{{ uaSummary(s.ua) }}</span>
                <el-tag v-if="s.current" size="small" type="success" effect="light">当前设备</el-tag>
                <el-tag v-else-if="s.revoked" size="small" type="danger" effect="light">已撤销</el-tag>
                <el-tag v-else-if="s.expired" size="small" type="info" effect="light">已过期</el-tag>
              </div>
              <div class="session-meta">
                <span>IP {{ s.ip || '未知' }}</span>
                <span>登录于 {{ formatTime(s.created_at) }}</span>
                <span>到期 {{ formatTime(s.expires_at) }}</span>
              </div>
            </div>
            <el-button
              v-if="!s.current && !s.revoked && !s.expired"
              size="small"
              type="danger"
              plain
              :loading="revokingJti === s.jti"
              @click="revokeOne(s.jti)"
            >
              踢出
            </el-button>
          </div>
        </div>
        <div v-if="sessions.length > 1" class="session-actions">
          <el-button size="small" type="danger" plain :loading="loggingOutAll" @click="logoutAll">
            注销其他全部设备
          </el-button>
        </div>
      </div>
    </div>

    <!-- 保存与备份 -->
    <div class="save-bar">
      <el-button type="primary" size="large" :loading="saving" @click="save">保存全部设置</el-button>
      <el-button size="large" plain :loading="backupLoading" @click="exportBackup">
        <template #icon><XIcon name="Download" :size="15" /></template>
        导出备份
      </el-button>
      <el-button size="large" plain :loading="backupLoading" @click="$refs.importInput?.click()">
        <template #icon><XIcon name="Upload" :size="15" /></template>
        导入备份
      </el-button>
      <input ref="importInput" type="file" accept="application/json,.json" class="hidden-file" @change="importBackup" />
      <el-button size="large" plain :loading="mailTesting" :title="'校验 SMTP 配置（SMTP_HOST/USER/PASS）并发送测试信'"
        @click="testMail">
        <template #icon><XIcon name="Mail" :size="15" /></template>
        测试通知邮件
      </el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { settingsApi, uploadApi, authApi } from '@/api';
import { renderMarkdown } from '@/utils/markdown';
import { getCachedAdminPath, getAdminPath } from '@/utils/adminPath';
import { getTicket } from '@/utils/pass';
import { getFingerprint } from '@/utils/fingerprint';
import { useSiteStore } from '@/stores/site';

const form = ref({});
const saving = ref(false);
const uploading = ref(false);

const pwdForm = ref({ oldPassword: '', newPassword: '' });
const pwdLoading = ref(false);

// 两步验证状态
const twoFaEnabled = ref(false);
const twoFaSetupUri = ref('');
const twoFaSecret = ref('');
const setupCode = ref('');
const disableCode = ref('');
const twoFaLoading = ref(false);

const aboutHtml = computed(() => renderMarkdown(form.value.about_content || ''));

// 活跃会话管理
const sessions = ref([]);
const revokingJti = ref('');
const loggingOutAll = ref(false);

/** UA 摘要：提取系统 + 浏览器（保持轻量，不引解析库） */
function uaSummary(ua) {
  const s = String(ua || '');
  const os = (s.match(/\(([^)]*)\)/) || [])[1]?.split(';')[0]?.trim() || '';
  const browser = (s.match(/(Chrome|Firefox|Safari|Edg\/|Edge|Opera|OPR)\/?\s*[\d.]+/) || [])[1]?.replace('Edg', 'Edge') || '';
  return [os, browser].filter(Boolean).join(' · ') || '未知设备';
}

function formatTime(t) {
  if (!t) return '—';
  const d = new Date(String(t).includes('T') ? t : String(t).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadSessions() {
  try {
    const list = await authApi.sessions();
    const now = Date.now();
    sessions.value = list.map((s) => ({
      ...s,
      expired: !s.revoked && new Date(s.expires_at).getTime() < now,
    }));
  } catch (e) {
    /* 拦截器已提示 */
  }
}

async function revokeOne(jti) {
  revokingJti.value = jti;
  try {
    await authApi.revokeSession(jti);
    ElMessage.success('已踢出该设备');
    await loadSessions();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    revokingJti.value = '';
  }
}

async function logoutAll() {
  try {
    await ElMessageBox.confirm('将退出当前账号在其他所有设备上的登录，确定继续？', '退出其他设备', {
      type: 'warning',
      confirmButtonText: '退出',
      cancelButtonText: '取消',
    });
  } catch (e) {
    return; /* 用户取消 */
  }
  loggingOutAll.value = true;
  try {
    await authApi.logoutAll();
    ElMessage.success('已注销其他全部设备');
    await loadSessions();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    loggingOutAll.value = false;
  }
}

// 后台访问信息
const adminPathVal = ref(getCachedAdminPath());
const fullAdminUrl = computed(() => {
  if (!adminPathVal.value) return '';
  return `${window.location.origin}${window.location.pathname}#/${adminPathVal.value}`;
});

async function copyAdminUrl() {
  if (!adminPathVal.value) {
    adminPathVal.value = await getAdminPath();
  }
  const url = fullAdminUrl.value;
  if (!url) return ElMessage.warning('后台路径尚未加载，请稍后重试');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  ElMessage.success('后台地址已复制');
}

/** 复制两步验证密钥到剪贴板 */
async function copyTwoFaSecret() {
  if (!twoFaSecret.value) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(twoFaSecret.value);
  } else {
    const ta = document.createElement('textarea');
    ta.value = twoFaSecret.value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  ElMessage.success('密钥已复制');
}

/** 生成两步验证密钥 */
async function setupTwoFa() {
  let password = '';
  try {
    const prompt = await ElMessageBox.prompt('请输入当前登录密码，用于确认开启两步验证', '安全确认', {
      inputType: 'password',
      inputPlaceholder: '当前登录密码',
      confirmButtonText: '确认',
      cancelButtonText: '取消',
    });
    password = String(prompt.value || '');
  } catch (e) {
    return; // 用户取消
  }
  if (!password) return ElMessage.warning('请输入当前登录密码');

  twoFaLoading.value = true;
  try {
    const res = await authApi.twoFaSetup(password);
    twoFaSecret.value = res.secret;
    twoFaSetupUri.value = res.uri;
    ElMessage.success('密钥已生成，请在验证器应用中添加');
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    twoFaLoading.value = false;
  }
}

/** 输入动态码完成启用 */
async function verifyTwoFa() {
  if (!/^\d{6}$/.test(setupCode.value)) return ElMessage.warning('请输入 6 位动态码');
  twoFaLoading.value = true;
  try {
    await authApi.twoFaVerify(setupCode.value);
    twoFaEnabled.value = true;
    twoFaSetupUri.value = '';
    twoFaSecret.value = '';
    setupCode.value = '';
    ElMessage.success('两步验证已启用');
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    twoFaLoading.value = false;
  }
}

/** 输入动态码关闭两步验证 */
async function disableTwoFa() {
  if (!/^\d{6}$/.test(disableCode.value)) return ElMessage.warning('请输入 6 位动态码');
  twoFaLoading.value = true;
  try {
    await authApi.twoFaDisable(disableCode.value);
    twoFaEnabled.value = false;
    disableCode.value = '';
    ElMessage.success('两步验证已关闭');
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    twoFaLoading.value = false;
  }
}

async function doUpload({ file }) {
  uploading.value = true;
  try {
    const res = await uploadApi.upload(file);
    form.value.avatar = res.url;
    ElMessage.success('头像上传成功');
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    uploading.value = false;
  }
}

async function save() {
  // site_url 格式校验：影响 RSS/Sitemap/分享页链接，非法值直接拦截
  if (form.value.site_url && !/^https?:\/\//i.test(String(form.value.site_url).trim())) {
    return ElMessage.warning('站点 URL 需以 http:// 或 https:// 开头');
  }
  saving.value = true;
  try {
    await settingsApi.save(form.value);
    // 前台站点数据有 60s 缓存：保存后主动失效并刷新，前台立即生效
    const site = useSiteStore();
    site.loaded = false;
    await site.fetchSettings();
    ElMessage.success('设置已保存');
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    saving.value = false;
  }
}

/** 导出设置备份（JSON 下载，原生 fetch 绕过拦截器） */
const backupLoading = ref(false);
async function exportBackup() {
  if (backupLoading.value) return;
  backupLoading.value = true;
  try {
    const key = getCachedAdminPath();
    const resp = await fetch(`/api/${key}/settings/export`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem('xalor_token')}`,
        'X-Pass': getTicket(),
        'X-Fp': await getFingerprint(),
      },
    });
    if (!resp.ok) {
      ElMessage.error('导出失败，请重试');
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'settings-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    ElMessage.error('导出失败，请重试');
  } finally {
    backupLoading.value = false;
  }
}

/** 测试通知邮件：校验 SMTP 配置并发送测试信（仅校验与发送，不改任何设置） */
const mailTesting = ref(false);
async function testMail() {
  if (mailTesting.value) return;
  mailTesting.value = true;
  try {
    const res = await settingsApi.testMail();
    ElMessage.success(res?.message || '测试邮件已发送');
  } catch (e) {
    /* 拦截器已提示（未配置 SMTP 或发送失败均给出明确原因） */
  } finally {
    mailTesting.value = false;
  }
}

/** 导入设置备份（JSON 文件 → 白名单校验入库 → 刷新表单） */
async function importBackup(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await settingsApi.importBackup(data);
    ElMessage.success(res?.message || '导入成功');
    // 重新拉取设置并刷新站点缓存
    form.value = await settingsApi.get();
    const site = useSiteStore();
    site.loaded = false;
    await site.fetchSettings();
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '导入失败，请检查备份文件');
  }
}

async function changePassword() {
  if (!pwdForm.value.oldPassword) return ElMessage.warning('请输入旧密码');
  if (!pwdForm.value.newPassword || pwdForm.value.newPassword.length < 8) {
    return ElMessage.warning('新密码至少 8 位');
  }
  pwdLoading.value = true;
  try {
    await authApi.changePassword(pwdForm.value);
    ElMessage.success('密码修改成功，下次登录请使用新密码');
    pwdForm.value = { oldPassword: '', newPassword: '' };
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    pwdLoading.value = false;
  }
}

onMounted(async () => {
  form.value = await settingsApi.get();
  // 加载两步验证状态
  try {
    const st = await authApi.twoFaStatus();
    twoFaEnabled.value = st.enabled === true;
  } catch (e) {
    /* 忽略 */
  }
  loadSessions();
});
</script>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 860px;
}

.setting-card {
  padding: 24px 28px;
}

.card-title {
  font-size: 1.05rem;
  font-weight: 700;
  margin-bottom: 20px;
  padding-left: 12px;
  border-left: 4px solid var(--accent);
  border-radius: 2px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}

/* 活跃会话面板 */
.session-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.2));
  border-radius: 10px;
  background: var(--bg-soft);
}

.session-item.expired {
  opacity: 0.55;
}

.session-device {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
}

.session-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}

.session-actions {
  padding-top: 2px;
}

.setting-form {
  max-width: 560px;
}

/* 头像预览（加载失败自动隐藏） */
.avatar-preview {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--border);
  flex-shrink: 0;
}

.avatar-field {
  display: flex;
  gap: 10px;
  width: 100%;
  flex-wrap: wrap;
}

.about-editor :deep(textarea) {
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 0.92rem;
  line-height: 1.7;
}

.preview-block {
  margin-top: 16px;
  border-top: 1px dashed var(--border);
  padding-top: 16px;
}

.preview-label {
  font-size: 0.85rem;
  color: var(--text-3);
  margin-bottom: 8px;
  display: block;
}

.about-preview {
  max-height: 320px;
  overflow-y: auto;
  padding: 16px;
  background: var(--bg);
  border-radius: 10px;
}

.save-bar {
  text-align: center;
  padding: 8px 0 24px;
}

/* ============ 两步验证 ============ */
.twofa-body {
  max-width: 640px;
}

.twofa-desc {
  color: var(--text-2);
  font-size: 0.9rem;
  line-height: 1.8;
  margin-bottom: 14px;
}

.twofa-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, #217a5e 12%, transparent);
  color: #217a5e;
  font-size: 0.82rem;
  font-weight: 700;
  margin-bottom: 12px;
}

.twofa-action {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.twofa-code-input {
  width: 220px;
}

.setup-grid {
  display: flex;
  gap: 22px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  background: var(--bg);
}

.qr-fallback {
  width: 96px;
  height: 96px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 0.72rem;
}

.twofa-secret {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  background: var(--bg-soft);
  padding: 6px 10px;
  border-radius: 6px;
  word-break: break-all;
  user-select: all;
}

.setup-tips {
  flex: 1;
  min-width: 240px;
}

.tips-title {
  font-weight: 650;
  margin-bottom: 8px;
}

.tips-list {
  padding-left: 20px;
  color: var(--text-2);
  font-size: 0.88rem;
  line-height: 2;
}

.otpauth-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 10px;
  color: var(--accent);
  font-size: 0.88rem;
}

.otpauth-link:hover {
  text-decoration: underline;
}

/* 审核开关说明文字 */
.switch-tip {
  margin-left: 10px;
  color: var(--text-3);
  font-size: 0.8rem;
}

/* 后台访问信息 */
.admin-path-body {
  max-width: 640px;
}

.admin-path-body code {
  font-family: var(--font-mono);
  font-size: 0.86em;
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 5px;
}

.admin-path-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.admin-path-value {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  background: var(--bg-soft);
  border: 1px dashed var(--border);
  padding: 8px 14px;
  border-radius: 8px;
  word-break: break-all;
  user-select: all;
  color: var(--text-2);
}

/* 隐藏文件输入（导入备份） */
.hidden-file {
  display: none;
}

</style>
