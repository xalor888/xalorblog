<template>
  <div class="home-settings">
    <div class="card section" v-loading="loading">
      <h3 class="card-title">站点</h3>
      <el-form label-width="110px" label-position="top">
        <el-form-item label="主页站点 URL">
          <el-input v-model="form.home_site_url" placeholder="https://xalor.cn" maxlength="500" />
          <p class="hint">用于主页版 RSS / Sitemap 的链接基址；留空则由请求 Host 推导。</p>
        </el-form-item>
      </el-form>
    </div>

    <div class="card section">
      <h3 class="card-title">名片 Hero</h3>
      <el-form label-position="top">
        <div class="grid-2">
          <el-form-item label="问候语">
            <el-input v-model="form.home_hero_greeting" maxlength="40" placeholder="Hi, I'm" />
          </el-form-item>
          <el-form-item label="身份 / 角色">
            <el-input v-model="form.home_hero_role" maxlength="60" placeholder="如：全栈开发 / 学生" />
          </el-form-item>
        </div>
        <el-form-item label="一句话签名">
          <el-input v-model="form.home_hero_quote" maxlength="120" placeholder="留空则使用站点简介" />
        </el-form-item>
        <div class="grid-2">
          <el-form-item label="在线状态">
            <el-select v-model="form.home_status" style="width: 100%">
              <el-option label="在线" value="online" />
              <el-option label="忙碌" value="busy" />
              <el-option label="离开" value="away" />
              <el-option label="离线" value="offline" />
            </el-select>
          </el-form-item>
          <el-form-item label="站点起始日期">
            <el-date-picker
              v-model="form.home_since_date"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="YYYY-MM-DD"
              style="width: 100%"
            />
            <p class="hint">用于首页「运行 N 天」，留空按 2024-01-01 计算。</p>
          </el-form-item>
        </div>
      </el-form>
    </div>

    <div class="card section">
      <h3 class="card-title">关于卡片</h3>
      <el-form label-position="top">
        <el-form-item label="摘要">
          <el-input
            v-model="form.home_about_excerpt"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="留空则自动取「站点设置 → 关于内容」的纯文本前 200 字"
          />
        </el-form-item>
        <p class="hint">
          「关于」详情页仍在博客站维护（站点设置 → 关于内容）；这里只影响主页上的摘要卡片。
        </p>
      </el-form>
    </div>

    <div class="card section">
      <h3 class="card-title">额外社交链接</h3>
      <p class="hint" style="margin-top: -6px">
        GitHub / 微博 / 邮箱沿用「站点设置」里的配置；这里补充其它平台（最多 8 条）。
      </p>
      <div v-for="(item, i) in socialExtra" :key="i" class="social-row">
        <el-input v-model="item.label" placeholder="名称（如 Bilibili）" maxlength="30" style="max-width: 180px" />
        <el-input v-model="item.url" placeholder="https://…" maxlength="300" />
        <el-button link type="danger" @click="socialExtra.splice(i, 1)">
          <XIcon name="Trash2" :size="14" />
        </el-button>
      </div>
      <el-button v-if="socialExtra.length < 8" size="small" plain @click="addSocial">
        <XIcon name="SquarePen" :size="13" /> 添加一条
      </el-button>
    </div>

    <div class="save-bar">
      <el-button type="primary" :loading="saving" @click="save">保存主页设置</el-button>
      <!-- 原按钮叫「重置」，但它的行为是「丢弃未保存的改动、回到已保存的状态」，
           不是「清空表单」。这个词默认会被读成后者，而它一按就执行、没有确认 ——
           与站点设置页的「放弃修改」也不一致。 -->
      <el-button @click="revertChanges">放弃修改</el-button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onBeforeRouteLeave } from 'vue-router';
import XIcon from '@/components/ui/XIcon.vue';
import { settingsApi } from '@/api';
import {
  normalizeSocialExtra,
  parseSocialExtra,
  SOCIAL_MAX_ITEMS,
} from '@/utils/socialExtra';

const loading = ref(false);
const saving = ref(false);
const socialExtra = ref([]);

const form = reactive({
  home_site_url: '',
  home_hero_greeting: "Hi, I'm",
  home_hero_role: '',
  home_hero_quote: '',
  home_status: 'online',
  home_since_date: '',
  home_about_excerpt: '',
});

// 社交链接的读写归一见 @/utils/socialExtra —— 它和服务端 saveSettings 用同一套规则
// （协议 http(s)、label 必填、8 条上限、长度截断）。两边规则不一致时会出现
// 「保存后列表还在、刷新就没了」，而用户以为自己保存成功了。

/**
 * 未保存修改保护（与 Settings.vue 同一套做法）。
 * 这个页面有 9 个字段 + 可变长的社交链接列表，改完点侧栏就走的话
 * 改动会静默丢失 —— 和站点设置页是同一个坑。
 */
let baseline = '';
const dirty = ref(false);

function setBaseline() {
  baseline = JSON.stringify({ form, extra: socialExtra.value });
  dirty.value = false;
}

watch(
  [form, socialExtra],
  () => {
    if (!baseline) return;
    dirty.value = JSON.stringify({ form, extra: socialExtra.value }) !== baseline;
  },
  { deep: true }
);

onBeforeRouteLeave(async () => {
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm(
      '主页设置还有尚未保存的修改，离开将丢失本次更改，是否确定离开？',
      '未保存提示',
      { confirmButtonText: '确定离开', cancelButtonText: '继续编辑', type: 'warning' }
    );
    return true;
  } catch (e) {
    return false;
  }
});

function onBeforeUnload(e) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = '';
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

function addSocial() {
  if (socialExtra.value.length >= SOCIAL_MAX_ITEMS) return;
  socialExtra.value.push({ label: '', url: '' });
}

/**
 * 放弃未保存的修改（原来这个按钮叫「重置」，语义容易被读成「清空表单」）。
 * 与站点设置页保持一致：无改动时短路、有改动时确认、复用已有的 dirty/baseline。
 */
async function revertChanges() {
  if (!dirty.value) {
    ElMessage.info('当前没有未保存的修改');
    return;
  }
  try {
    await ElMessageBox.confirm(
      '将丢弃所有未保存的修改，恢复到上次保存的主页设置。继续？',
      '放弃修改',
      { type: 'warning', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑' }
    );
  } catch (e) {
    return;
  }
  await load();
  ElMessage.success('已恢复为上次保存的设置');
}

async function load() {
  loading.value = true;
  try {
    const data = await settingsApi.get();
    form.home_site_url = data.home_site_url || '';
    form.home_hero_greeting = data.home_hero_greeting ?? "Hi, I'm";
    form.home_hero_role = data.home_hero_role || '';
    form.home_hero_quote = data.home_hero_quote || '';
    form.home_status = data.home_status || 'online';
    form.home_since_date = data.home_since_date || '';
    form.home_about_excerpt = data.home_about_excerpt || '';
    socialExtra.value = parseSocialExtra(data.home_social_extra);
    // 记录基线：之后任何差异才算「未保存」。放在这里而不是 watch 里，
    // 是为了避免「刚打开就提示未保存」。
    setBaseline();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    loading.value = false;
  }
}

async function save() {
  // 与服务端同规则清洗（协议白名单 / label 必填 / 8 条上限 / 长度截断）。
  // 关键是**先在前端算出一份和服务端一致的结果**再提交：
  // 原来前端只过滤空值，服务端还会因协议不在白名单而丢弃 ——
  // 于是「保存后列表还在、刷新就没了」，用户以为自己成功了。
  const { list: cleaned, dropped } = normalizeSocialExtra(socialExtra.value);

  saving.value = true;
  try {
    // 日期控件清空后是 null：显式转成空串，语义是「清空」而不是「不修改」
    // （服务端也把 null 当清空处理，这里只是把意图写在调用点）
    const saved = await settingsApi.save({
      ...form,
      home_since_date: form.home_since_date || '',
      home_social_extra: JSON.stringify(cleaned),
    });
    // 服务端会清洗/过滤社交项，所以先同步回本地（cleaned），
    // 再记录基线 —— 顺序不能反：拿「保存前的表单」当基线，
    // 服务端的清洗差异会立刻被判定成新的未保存修改。
    socialExtra.value = cleaned;
    setBaseline();
    if (saved && Array.isArray(saved.rejected) && saved.rejected.length) {
      ElMessage.warning({
        message: `已保存，但 ${saved.rejected.length} 个字段未通过校验、保持原值：${saved.rejected.map((r) => r.key).join('、')}`,
        duration: 6000,
        showClose: true,
      });
    } else if (dropped > 0) {
      // 社交项被本地清洗掉了（空 label / 非 http(s) / 超出 8 条）：
      // 明确说出来，而不是让用户刷新后发现少了几条
      ElMessage.warning({
        message: `主页设置已保存，但社交链接有 ${dropped} 项未通过校验（需要填写名称且链接以 http(s) 开头，最多 ${SOCIAL_MAX_ITEMS} 条），已忽略`,
        duration: 6000,
        showClose: true,
      });
      socialExtra.value = cleaned;
    } else {
      ElMessage.success('主页设置已保存');
    }
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.home-settings { max-width: 780px; display: flex; flex-direction: column; gap: 14px; }
.section { padding: 16px 18px; }
.card-title { margin: 0 0 12px; font-size: 15px; font-weight: 650; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.hint { margin: 4px 0 0; font-size: 12.5px; color: var(--text-3); line-height: 1.6; }
.social-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.save-bar {
  display: flex;
  gap: 8px;
  position: sticky;
  bottom: 0;
  padding: 12px 0;
  background: linear-gradient(to top, var(--bg) 60%, transparent);
}
@media (max-width: 700px) {
  .grid-2 { grid-template-columns: 1fr; }
  .social-row { flex-wrap: wrap; }
}
</style>
