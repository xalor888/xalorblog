<template>
  <div class="login-page">
    <div class="login-card fade-up">
      <div class="login-logo">
        <img src="/logo-256.webp" alt="logo" class="login-logo-img" />
      </div>
      <h1 class="login-title">后台登录</h1>
      <p class="login-sub">请输入账号和密码</p>

      <form @submit.prevent="submit">
        <!-- label 必须用 for 指向 input 的 id。
             原来两个标签都只是「视觉标签」：<label>用户名</label> 后面跟着一个
             没有 id 的 <input>，读屏完全不知道它们是一对。
             更糟的是字段一旦有内容、placeholder 消失，这个框就**彻底没有名字**——
             读屏只会念「编辑框」。 -->
        <div class="field">
          <label class="field-label" for="login-username">用户名</label>
          <div class="input-wrap">
            <XIcon name="User" :size="16" class="input-icon" />
            <input
              id="login-username"
              ref="usernameRef"
              v-model="form.username"
              name="username"
              class="input"
              placeholder="请输入用户名"
              autocomplete="username"
              :aria-invalid="fieldErrors.username ? 'true' : undefined"
              :aria-describedby="fieldErrors.username ? 'login-err-username' : undefined"
              autofocus
            />
          </div>
          <!-- 字段级错误：与 input 用 aria-describedby 关联。
               原来只用 ElMessage.warning 弹一个全局 toast —— 焦点还留在按钮上，
               读屏用户听到「请输入用户名，按钮」但不知道是哪个框要填；
               而视觉用户能看到红字/知道哪一栏空着。 -->
          <p v-if="fieldErrors.username" id="login-err-username" class="field-error" role="alert">
            {{ fieldErrors.username }}
          </p>
        </div>
        <div class="field">
          <label class="field-label" for="login-password">密码</label>
          <div class="input-wrap">
            <XIcon name="Lock" :size="16" class="input-icon" />
            <input
              id="login-password"
              ref="passwordRef"
              v-model="form.password"
              name="password"
              :type="showPass ? 'text' : 'password'"
              class="input"
              placeholder="请输入密码"
              autocomplete="current-password"
              :aria-invalid="fieldErrors.password ? 'true' : undefined"
              :aria-describedby="fieldErrors.password ? 'login-err-password' : undefined"
            />
            <button
              type="button"
              class="pass-toggle"
              :title="showPass ? '隐藏密码' : '显示密码'"
              :aria-label="showPass ? '隐藏密码' : '显示密码'"
              @click="showPass = !showPass"
            >
              <XIcon :name="showPass ? 'EyeOff' : 'Eye'" :size="16" />
            </button>
          </div>
          <p v-if="fieldErrors.password" id="login-err-password" class="field-error" role="alert">
            {{ fieldErrors.password }}
          </p>
        </div>
        <!-- 两步验证：登录接口返回验证码错误时出现 -->
        <transition name="fade-slide">
          <div v-if="needTotp" class="field">
            <label class="field-label" for="login-totp">两步验证码</label>
            <div class="input-wrap">
              <XIcon name="KeyRound" :size="16" class="input-icon" />
              <input
                id="login-totp"
                ref="totpRef"
                v-model="form.totp_code"
                name="totp_code"
                inputmode="numeric"
                maxlength="6"
                class="input"
                placeholder="请输入验证器应用中的 6 位动态码"
                autocomplete="one-time-code"
                :aria-invalid="fieldErrors.totp ? 'true' : undefined"
                :aria-describedby="fieldErrors.totp ? 'login-err-totp' : undefined"
                @input="autoSubmitTotp"
              />
            </div>
            <p v-if="fieldErrors.totp" id="login-err-totp" class="field-error" role="alert">
              {{ fieldErrors.totp }}
            </p>
          </div>
        </transition>
        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? '登录中…' : needTotp ? '验证并登录' : '登 录' }}
        </button>
        <label class="remember-row">
          <input v-model="remember" type="checkbox" class="remember-check" />
          <span>记住用户名</span>
        </label>
      </form>

      <router-link to="/" class="back-home">
        <XIcon name="ArrowLeft" :size="14" /> 返回首页
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, watchEffect, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminPath } from '@/utils/adminPath';
import { getAuthToken } from '@/utils/authSession';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

// 已登录用户访问登录页 → 直达仪表盘（免重复登录；token 有效性由服务端校验兜底）
const safeGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ } };
const safeRemove = (k) => { try { localStorage.removeItem(k); } catch (e) { /* 隐私模式忽略 */ } };

watchEffect(() => {
  document.title = '后台登录 · Xalor的小站';
});
if (getAuthToken()) {
  getAdminPath().then((key) => {
    if (key) router.replace(`/${key}/dashboard`);
  }).catch(() => {});
}

const form = ref({ username: safeGet('xalor_remember_user'), password: '', totp_code: '' });
const showPass = ref(false);
const loading = ref(false);
const needTotp = ref(false);
const remember = ref(!!safeGet('xalor_remember_user'));

// 2FA 输入框出现时自动聚焦（验证器复制动态码即可输入，免手动点击）
watch(needTotp, (v) => {
  if (!v) return;
  nextTick(() => {
    document.querySelector('.field input')?.focus();
  });
});

/** 2FA 验证码输满 6 位自动提交（免手动点击，验证器复制即登录） */
function autoSubmitTotp() {
  if (/^\d{6}$/.test(form.value.totp_code || '') && !loading.value) {
    submit();
  }
}

/**
 * 字段级错误（与 Messages / CommentSection 同一套做法）。
 *
 * 原来三个空值检查都只弹一个全局 ElMessage.warning —— 焦点还留在提交按钮上，
 * 读屏用户听到「请输入用户名，按钮」，不知道是哪个输入框要填；
 * 视觉用户至少能看出哪一栏空着，读屏用户不能。
 * 现在：错误文字就近显示 + aria-invalid + aria-describedby 关联 + 聚焦第一个出错字段。
 */
const fieldErrors = ref({ username: '', password: '', totp: '' });
const usernameRef = ref(null);
const passwordRef = ref(null);
const totpRef = ref(null);

/** 清掉指定字段的错误（用户一开始改就把红字撤掉，避免边改边被念） */
function clearFieldError(name) {
  if (fieldErrors.value[name]) fieldErrors.value = { ...fieldErrors.value, [name]: '' };
}

/** 校验三个必填项；返回第一个出错字段的 ref（null 表示全部通过） */
function validate() {
  const next = { username: '', password: '', totp: '' };
  if (!form.value.username.trim()) next.username = '请输入用户名';
  if (!form.value.password) next.password = '请输入密码';
  if (needTotp.value && !/^\d{6}$/.test(form.value.totp_code || '')) {
    next.totp = '请输入 6 位动态验证码';
  }
  fieldErrors.value = next;
  if (next.username) return usernameRef.value;
  if (next.password) return passwordRef.value;
  if (next.totp) return totpRef.value;
  return null;
}

async function submit() {
  const firstBad = validate();
  if (firstBad) {
    // 把焦点送到第一个出错的框：读屏会念出 aria-describedby 指向的错误文字
    firstBad.focus?.();
    return undefined;
  }
  loading.value = true;
  try {
    const data = await auth.login({
      username: form.value.username.trim(),
      password: form.value.password,
      totp_code: needTotp.value ? form.value.totp_code : undefined,
    });
    // 记住用户名（下次登录自动填充）
    if (remember.value) {
      safeSet('xalor_remember_user', form.value.username.trim());
    } else {
      safeRemove('xalor_remember_user');
    }
    if (data.is_default_pwd) {
      ElMessage.warning('当前仍在使用初始密码，请尽快修改');
    } else {
      ElMessage.success('欢迎回来');
    }
    // 确保秘钥路径已加载，再跳转仪表盘
    const key = await getAdminPath();
    router.push(key ? `/${key}/dashboard` : route.path);
  } catch (e) {
    // 两步验证错误 → 显示验证码输入框
    if (/两步验证|验证码/.test(e.message || '')) {
      needTotp.value = true;
      form.value.totp_code = '';
      // 让字段级错误说清楚要做什么，而不是只留一个 toast
      fieldErrors.value = { username: '', password: '', totp: e.message || '两步验证码不正确' };
    }
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  padding: 20px;
  position: relative;
}

/* 背景：纸感的暖色光晕（非渐变大图） */
.login-page::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(46% 40% at 12% 8%, var(--accent-soft) 0%, transparent 60%),
    radial-gradient(40% 36% at 88% 86%, rgba(201, 144, 15, 0.08) 0%, transparent 55%);
  pointer-events: none;
}

.login-card {
  position: relative;
  width: min(400px, 100%);
  background: color-mix(in srgb, var(--card) 92%, transparent);
  border: 1px solid var(--border);
  border-radius: 24px;
  padding: 44px 42px;
  box-shadow: var(--shadow-2);
  backdrop-filter: blur(18px);
}

/* 极限窄屏（≤400px）：收紧内边距，保证输入框可用宽度 */
@media (max-width: 400px) {
  .login-card {
    padding: 32px 24px;
  }
  .login-page {
    padding: 14px;
  }
}

.login-logo {
  margin-bottom: 18px;
  display: flex;
  justify-content: center;
}

.login-logo-img {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  object-fit: cover;
  box-shadow: var(--shadow-1);
}

.login-title {
  font-size: 1.2rem;
  font-weight: 750;
  margin-bottom: 4px;
  letter-spacing: -0.01em;
}

.login-sub {
  color: var(--text-3);
  font-size: 0.86rem;
  margin-bottom: 28px;
}

.field {
  margin-bottom: 18px;
}

.field-label {
  display: block;
  font-size: 0.82rem;
  color: var(--text-2);
  margin-bottom: 7px;
  font-weight: 550;
}

.input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.input-icon {
  position: absolute;
  left: 13px;
  color: var(--text-3);
  pointer-events: none;
}

/* 密码可见性切换 */
.pass-toggle {
  position: absolute;
  right: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: var(--text-3);
  transition: all var(--dur) var(--ease);
}

.pass-toggle:hover {
  color: var(--accent-text);
  background: var(--accent-soft);
}

.input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 11px 13px 11px 38px;
  font-size: 0.92rem;
  color: var(--text);
  background: var(--bg);
  outline: none;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.input:focus {
  border-color: var(--accent);
  background: var(--card);
}

.login-btn {
  width: 100%;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--accent-fill);
  color: #fff;
  font-size: 0.95rem;
  font-weight: 650;
  margin-top: 6px;
  transition: all var(--dur) var(--ease);
}

.login-btn:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 30%, transparent);
}

.login-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.back-home {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 20px;
  color: var(--text-3);
  font-size: 0.84rem;
  transition: color var(--dur) var(--ease);
}

.back-home:hover {
  color: var(--accent-text);
}

/* 两步验证输入框入场动画 */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 0.25s var(--ease), transform 0.25s var(--ease);
}

.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 记住用户名 */
.remember-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  font-size: 0.8rem;
  color: var(--text-3);
  cursor: pointer;
  user-select: none;
}

.remember-check {
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  cursor: pointer;
}
</style>
