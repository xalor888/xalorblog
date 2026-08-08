<template>
  <div class="login-page">
    <div class="login-card fade-up">
      <div class="login-logo">
        <img src="/logo.png" alt="logo" class="login-logo-img" />
      </div>
      <h1 class="login-title">Xalor 的小站 · 管理后台</h1>
      <p class="login-sub">登录以管理你的博客</p>

      <form @submit.prevent="submit">
        <div class="field">
          <label class="field-label">用户名</label>
          <div class="input-wrap">
            <XIcon name="User" :size="16" class="input-icon" />
            <input v-model="form.username" class="input" placeholder="请输入用户名" autocomplete="username" autofocus />
          </div>
        </div>
        <div class="field">
          <label class="field-label">密码</label>
          <div class="input-wrap">
            <XIcon name="Lock" :size="16" class="input-icon" />
            <input
              v-model="form.password"
              :type="showPass ? 'text' : 'password'"
              class="input"
              placeholder="请输入密码"
              autocomplete="current-password"
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
        </div>
        <!-- 两步验证：登录接口返回验证码错误时出现 -->
        <transition name="fade-slide">
          <div v-if="needTotp" class="field">
            <label class="field-label">两步验证码</label>
            <div class="input-wrap">
              <XIcon name="KeyRound" :size="16" class="input-icon" />
              <input
                v-model="form.totp_code"
                inputmode="numeric"
                maxlength="6"
                class="input"
                placeholder="请输入验证器应用中的 6 位动态码"
                autocomplete="one-time-code"
                @input="autoSubmitTotp"
              />
            </div>
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
        <XIcon name="ArrowLeft" :size="14" /> 返回前台
      </router-link>
    </div>

    <p class="login-foot">Powered by Vue 3 · Express · MySQL</p>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminPath } from '@/utils/adminPath';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

// 已登录用户访问登录页 → 直达仪表盘（免重复登录；token 有效性由服务端校验兜底）
if (localStorage.getItem('xalor_token')) {
  getAdminPath().then((key) => {
    if (key) router.replace(`/${key}/dashboard`);
  }).catch(() => {});
}

const form = ref({ username: localStorage.getItem('xalor_remember_user') || '', password: '', totp_code: '' });
const showPass = ref(false);
const loading = ref(false);
const needTotp = ref(false);
const remember = ref(!!localStorage.getItem('xalor_remember_user'));

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

async function submit() {
  if (!form.value.username.trim()) return ElMessage.warning('请输入用户名');
  if (!form.value.password) return ElMessage.warning('请输入密码');
  if (needTotp.value && !/^\d{6}$/.test(form.value.totp_code || '')) {
    return ElMessage.warning('请输入 6 位两步验证码');
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
      localStorage.setItem('xalor_remember_user', form.value.username.trim());
    } else {
      localStorage.removeItem('xalor_remember_user');
    }
    if (data.is_default_pwd) {
      ElMessage.warning('当前仍在使用初始密码 admin123，请尽快修改！');
    } else {
      ElMessage.success('欢迎回来！');
    }
    // 确保秘钥路径已加载，再跳转仪表盘
    const key = await getAdminPath();
    router.push(key ? `/${key}/dashboard` : route.path);
  } catch (e) {
    // 两步验证错误 → 显示验证码输入框
    if (/两步验证|验证码/.test(e.message || '')) {
      needTotp.value = true;
      form.value.totp_code = '';
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
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 44px 42px;
  box-shadow: var(--shadow-2);
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
  color: var(--accent);
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
  background: var(--accent);
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
  color: var(--accent);
}

.login-foot {
  position: relative;
  margin-top: 24px;
  color: var(--text-3);
  font-size: 0.78rem;
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
