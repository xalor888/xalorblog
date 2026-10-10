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
      <el-button @click="load">重置</el-button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { settingsApi } from '@/api';

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

function parseExtra(raw) {
  try {
    const list = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(list)) return [];
    return list
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({ label: String(it.label || ''), url: String(it.url || '') }));
  } catch (e) {
    return [];
  }
}

function addSocial() {
  if (socialExtra.value.length >= 8) return;
  socialExtra.value.push({ label: '', url: '' });
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
    socialExtra.value = parseExtra(data.home_social_extra);
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    loading.value = false;
  }
}

async function save() {
  // 只提交非空的社交项；服务端会再做一次 URL/长度清洗与 8 条上限校验
  const cleaned = socialExtra.value
    .map((it) => ({ label: String(it.label || '').trim(), url: String(it.url || '').trim() }))
    .filter((it) => it.label && it.url);

  saving.value = true;
  try {
    // 日期控件清空后是 null：显式转成空串，语义是「清空」而不是「不修改」
    // （服务端也把 null 当清空处理，这里只是把意图写在调用点）
    await settingsApi.save({
      ...form,
      home_since_date: form.home_since_date || '',
      home_social_extra: JSON.stringify(cleaned),
    });
    ElMessage.success('主页设置已保存');
    socialExtra.value = cleaned;
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
