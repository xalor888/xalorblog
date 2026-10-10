<template>
  <div class="note-edit">
    <div class="card editor-card">
      <div class="editor-head">
        <h3 class="card-title">{{ isEdit ? '编辑手记' : '写手记' }}</h3>
        <span class="char-count" :title="`正文 ${charCount} 字`">{{ charCount }} / 20000</span>
      </div>

      <div class="md-editor">
        <div class="md-tabs">
          <button :class="{ active: mode === 'write' }" @click="mode = 'write'">写作</button>
          <button :class="{ active: mode === 'preview' }" @click="mode = 'preview'">预览</button>
          <span class="md-hint">支持 Markdown</span>
        </div>

        <textarea
          v-if="mode === 'write'"
          v-model="form.content"
          class="note-textarea"
          placeholder="此刻在想什么？"
          maxlength="20000"
        ></textarea>
        <div v-else class="markdown-body preview" v-html="previewHtml"></div>
      </div>

      <!-- 图片九宫格（最多 9 张） -->
      <div class="images-block">
        <div class="images-head">
          <span class="block-label">图片</span>
          <span class="images-count">{{ form.images.length }} / {{ MAX_IMAGES }}</span>
        </div>
        <div class="image-grid">
          <div v-for="(src, i) in form.images" :key="src + i" class="image-cell">
            <img :src="src" alt="" />
            <button class="image-remove" title="移除" @click="removeImage(i)"><XIcon name="X" :size="12" /></button>
          </div>
          <label v-if="form.images.length < MAX_IMAGES" class="image-add" :class="{ uploading }">
            <input type="file" accept="image/*" multiple hidden @change="onPick" />
            <XIcon :name="uploading ? 'RefreshCw' : 'Upload'" :size="16" :class="{ spin: uploading }" />
            <span>{{ uploading ? '上传中' : '添加图片' }}</span>
          </label>
        </div>
      </div>

      <!-- 心情 / 地点 -->
      <div class="meta-row">
        <div class="meta-field">
          <label>心情</label>
          <el-input v-model="form.mood" maxlength="40" placeholder="如：开心 / 平静" />
          <div class="mood-quick">
            <button v-for="m in MOODS" :key="m" type="button" @click="form.mood = m">{{ m }}</button>
          </div>
        </div>
        <div class="meta-field">
          <label>地点</label>
          <el-input v-model="form.location" maxlength="80" placeholder="如：家里 / 公司" />
        </div>
      </div>

      <!-- 摘要 -->
      <div class="field-block">
        <label>摘要（可选）</label>
        <el-input
          v-model="form.excerpt"
          type="textarea"
          :rows="2"
          maxlength="500"
          show-word-limit
          placeholder="留空则自动取正文前 200 字；列表与 RSS 使用它"
        />
      </div>

      <div class="switch-row">
        <el-switch v-model="form.is_pinned" active-text="置顶" inline-prompt />
        <span class="switch-note">置顶的手记会排在时间线最前</span>
      </div>

      <div class="actions">
        <el-button @click="goBack">取消</el-button>
        <el-button :loading="savingDraft" @click="save('draft')">存草稿</el-button>
        <el-button type="primary" :loading="publishing" @click="save('published')">
          {{ form.status === 'published' ? '更新' : '发布' }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { noteApi, uploadApi } from '@/api';
import { adminHref } from '@/utils/adminPath';
import { renderMarkdown, addImgAttrs } from '@/utils/markdown';

const MAX_IMAGES = 9;
const MOODS = ['开心', '平静', '疲惫', '期待', 'emo', '充实'];

const route = useRoute();
const router = useRouter();

const isEdit = computed(() => !!route.params.id);
const mode = ref('write');
const uploading = ref(false);
const savingDraft = ref(false);
const publishing = ref(false);
const form = reactive({
  content: '',
  images: [],
  excerpt: '',
  mood: '',
  location: '',
  is_pinned: false,
  status: 'draft',
});

// 未保存标记：deep watch 覆盖正文/图片/心情/地点/摘要/置顶全部字段，
// 加载已有手记期间用 suppressWatch 抑制（否则一进编辑页就算「有改动」）。
// ⚠ watch 必须写在 form 声明之后 —— 放在前面会命中 TDZ（const 暂时性死区），
// setup 抛 ReferenceError 而组件静默渲染为空（构建不会报错，只有真跑页面才发现）。
const dirty = ref(false);
let suppressWatch = false;
watch(form, () => {
  if (!suppressWatch) dirty.value = true;
}, { deep: true });

const charCount = computed(() => (form.content || '').length);
const previewHtml = computed(() => addImgAttrs(renderMarkdown(form.content || '')));

function removeImage(i) {
  form.images.splice(i, 1);
}

async function onPick(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const room = MAX_IMAGES - form.images.length;
  if (room <= 0) return;
  uploading.value = true;
  let failed = 0;
  try {
    // 串行上传：避免并发打满上传限流（每 IP 每分钟有独立配额）
    for (const file of files.slice(0, room)) {
      if (!file.type.startsWith('image/')) {
        ElMessage.warning('仅支持图片文件');
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        ElMessage.warning(`${file.name} 超过 5MB，已跳过`);
        continue;
      }
      // 每张图各自兜底：单张被拒（格式/大小/magic bytes 校验）不能让后面选的图
      // 一起消失 —— 否则用户一次选 5 张、第 2 张失败，后 3 张静默不传
      try {
        const res = await uploadApi.upload(file);
        if (res?.url) form.images.push(res.url);
      } catch (err) {
        failed += 1;
      }
    }
  } finally {
    uploading.value = false;
  }
  if (failed) ElMessage.warning(`${failed} 张图片上传失败，已跳过`);
}

async function save(status) {
  if (!form.content.trim()) {
    ElMessage.warning('手记内容不能为空');
    return;
  }
  const payload = {
    content: form.content,
    images: form.images,
    excerpt: form.excerpt,
    mood: form.mood,
    location: form.location,
    is_pinned: form.is_pinned,
    status,
  };
  if (status === 'draft') savingDraft.value = true;
  else publishing.value = true;
  try {
    if (isEdit.value) {
      await noteApi.update(route.params.id, payload);
    } else {
      await noteApi.create(payload);
    }
    form.status = status === 'published' ? 'published' : form.status;
    dirty.value = false;
    ElMessage.success(status === 'published' ? '已发布' : '草稿已保存');
    router.push(adminHref('notes'));
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    savingDraft.value = false;
    publishing.value = false;
  }
}

function goBack() {
  router.push(adminHref('notes'));
}

/** 浏览器级离开保护（刷新/关标签）：与 ArticleEdit 保持一致 */
function onBeforeUnload(e) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = '';
}

/** 路由内离开保护：手记是长文本，误点导航直接丢失代价很高 */
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm('当前手记有尚未保存的修改，离开将丢失本次更改，是否确定离开？', '未保存提示', {
      confirmButtonText: '确定离开',
      cancelButtonText: '继续编辑',
      type: 'warning',
    });
    return true;
  } catch (e) {
    return false;
  }
});

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload);
  if (!isEdit.value) return;
  suppressWatch = true;
  try {
    const data = await noteApi.adminDetail(route.params.id);
    form.content = data.content || '';
    form.images = Array.isArray(data.images) ? data.images : [];
    form.excerpt = data.excerpt || '';
    form.mood = data.mood || '';
    form.location = data.location || '';
    form.is_pinned = !!data.is_pinned;
    form.status = data.status || 'draft';
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    await nextTick();
    suppressWatch = false;
    dirty.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<style scoped>
.note-edit { max-width: 860px; }
.editor-card { padding: 16px 18px 18px; }
.editor-head { display: flex; align-items: center; justify-content: space-between; }
.card-title { margin: 0 0 12px; font-size: 15px; font-weight: 650; }
.char-count { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }

.md-editor { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.md-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg-soft);
  border-bottom: 1px solid var(--border);
}
.md-tabs button {
  padding: 4px 12px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
  cursor: pointer;
}
.md-tabs button.active { background: var(--card); color: var(--accent-deep); font-weight: 600; }
.md-hint { margin-left: auto; font-size: 12px; color: var(--text-3); }

.note-textarea {
  width: 100%;
  min-height: 240px;
  padding: 14px;
  border: none;
  outline: none;
  resize: vertical;
  background: var(--card);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14.5px;
  line-height: 1.8;
}
.preview { min-height: 240px; padding: 14px; background: var(--card); }

.images-block { margin-top: 16px; }
.images-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.block-label { font-size: 13.5px; font-weight: 600; }
.images-count { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}
.image-cell, .image-add {
  position: relative;
  aspect-ratio: 1 / 1;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-soft);
}
.image-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.image-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
}
.image-add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border-style: dashed;
  color: var(--text-3);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.image-add:hover { color: var(--accent-deep); border-color: var(--accent); }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.meta-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 18px;
}
.meta-field label, .field-block label { display: block; margin-bottom: 6px; font-size: 13.5px; font-weight: 600; }
.mood-quick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.mood-quick button {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--text-3);
  font-size: 12px;
  cursor: pointer;
}
.mood-quick button:hover { color: var(--accent-deep); border-color: var(--accent); }
.field-block { margin-top: 16px; }
.switch-row { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
.switch-note { font-size: 12.5px; color: var(--text-3); }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

@media (max-width: 700px) {
  .meta-row { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
}
</style>
