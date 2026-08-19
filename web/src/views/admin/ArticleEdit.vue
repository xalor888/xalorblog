<template>
  <div class="article-edit">
    <!-- 顶部操作栏 -->
    <div class="editor-topbar card">
      <el-button @click="goBack">
        <template #icon><XIcon name="ArrowLeft" :size="15" /></template>
        返回
      </el-button>
      <span v-if="editingId" class="edit-mode-tag">编辑模式</span>
      <div class="topbar-right">
        <span class="save-hint">Ctrl+S 快速保存</span>
        <el-button @click="saveDraft">保存草稿</el-button>
        <el-button type="primary" @click="publish">发布</el-button>
      </div>
    </div>

    <!-- 基本信息 -->
    <div class="meta-card card">
      <div class="meta-grid">
        <el-form-item label="文章标题 *" class="span-2">
          <el-input v-model="form.title" placeholder="输入文章标题" maxlength="200" show-word-limit size="large" />
        </el-form-item>
        <el-form-item label="访问链接 (slug)">
          <el-input v-model="form.slug" placeholder="留空自动生成" maxlength="220" />
          <span class="slug-preview">/#/article/<b>{{ form.slug || '自动生成' }}</b></span>
        </el-form-item>
        <el-form-item label="所属分类">
          <el-select v-model="form.category_id" placeholder="选择分类" clearable style="width: 100%">
            <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签（回车创建）" class="span-2">
          <el-select
            v-model="form.tags"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入标签后回车"
            style="width: 100%"
          >
            <el-option v-for="t in allTags" :key="t.id" :label="t.name" :value="t.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="封面图片">
          <div class="cover-field">
            <el-input v-model="form.cover" placeholder="封面图片 URL，或点击右侧上传" />
            <el-upload
              :show-file-list="false"
              :http-request="doUpload"
              accept="image/*"
            >
              <el-button :loading="uploading">
                <template #icon><XIcon name="Upload" :size="15" /></template>
                上传
              </el-button>
            </el-upload>
            <div v-if="form.cover" class="cover-preview">
              <img :src="form.cover" alt="封面预览" @error="coverBroken = true" @load="coverBroken = false" />
              <span v-if="coverBroken" class="cover-broken">图片无法加载</span>
              <button class="cover-remove" title="移除封面" @click="removeCover">
                <XIcon name="X" :size="13" />
              </button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="文章摘要">
          <el-input v-model="form.summary" type="textarea" :rows="2" maxlength="500" show-word-limit
            placeholder="留空则自动截取正文前 150 字">
            <template #append>
              <el-button :disabled="!form.content" @click="autoSummary" title="从正文提取前 150 字">自动生成</el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="其他选项">
          <div class="option-row">
            <el-switch v-model="form.is_top" active-text="置顶" />
            <el-switch v-model="form.allow_comment" active-text="允许评论" />
          </div>
        </el-form-item>
        <el-form-item v-if="articleStatus === 'published' || form.published_at" label="发布时间">
          <el-date-picker
            v-model="form.published_at"
            type="datetime"
            value-format="YYYY-MM-DD HH:mm:ss"
            placeholder="默认当前时间，可调整（补发旧文/归档）"
            style="width: 100%"
          />
        </el-form-item>
      </div>
    </div>

    <!-- 编辑器 -->
    <div class="editor-card card">
      <div class="editor-head">
        <button class="mode-btn" :class="{ active: mode === 'write' }" @click="mode = 'write'">编辑</button>
        <button class="mode-btn" :class="{ active: mode === 'preview' }" @click="mode = 'preview'">预览</button>
        <span class="editor-hint">支持 Markdown 语法</span>
        <span v-if="autosavedAt" class="editor-autosave" title="草稿已自动保存到本地浏览器，关闭页面不丢失">
          <XIcon name="Check" :size="13" /> 已自动保存 {{ autosavedAt }}
        </span>
        <span class="editor-stats num">{{ wordCount }} 字 · 约 {{ readingMinutes }} 分钟阅读</span>
      </div>

      <div v-show="mode === 'write'" class="editor-wrap">
        <!-- Markdown 快捷工具栏 -->
        <div class="md-toolbar">
          <button v-for="t in mdTools" :key="t.label" class="md-tool" :title="t.label" @click="insertMd(t)">
            <XIcon :name="t.icon" :size="15" />
          </button>
          <span class="md-sep"></span>
          <button class="md-tool" title="上传图片并插入" :disabled="uploading" @click="$refs.imgInput?.click()">
            <XIcon name="Upload" :size="15" />
          </button>
          <input ref="imgInput" type="file" accept="image/*" class="hidden-file" @change="uploadAndInsert" />
        </div>
        <el-input
          v-model="form.content"
          type="textarea"
          :rows="20"
          resize="none"
          class="md-editor"
          placeholder="在这里用 Markdown 写作…（可直接 Ctrl/Cmd+V 粘贴截图，自动上传插入）"
          @paste="onEditorPaste"
        />
      </div>

      <div v-show="mode === 'preview'" class="preview-wrap">
        <div v-if="form.content" class="markdown-body" v-html="previewHtml"></div>
        <div v-else class="preview-empty">暂无内容</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { articleApi, categoryApi, tagApi, uploadApi } from '@/api';
import { renderMarkdown } from '@/utils/markdown';
import { adminHref } from '@/utils/adminPath';
import {
  migrateLegacyPrefix,
  readSessionValue,
  removeStoredValue,
  writeSessionValue,
} from '@/utils/secureStorage';

const route = useRoute();
const router = useRouter();

const editingId = computed(() => route.params.id || null);

function goBack() {
  router.push(adminHref('articles'));
}

/** Markdown 快捷插入工具 */
const mdTools = [
  { label: '加粗', icon: 'Bold', open: '**', close: '**', placeholder: '加粗文字' },
  { label: '斜体', icon: 'Italic', open: '*', close: '*', placeholder: '斜体文字' },
  { label: '行内代码', icon: 'Code', open: '`', close: '`', placeholder: 'code' },
  { label: '标题', icon: 'Heading2', open: '\n## ', close: '', placeholder: '二级标题' },
  { label: '引用', icon: 'Quote', open: '\n> ', close: '', placeholder: '引用内容' },
  { label: '无序列表', icon: 'List', open: '\n- ', close: '', placeholder: '列表项' },
  { label: '有序列表', icon: 'ListOrdered', open: '\n1. ', close: '', placeholder: '有序列表项' },
  { label: '任务列表', icon: 'ListChecks', open: '\n- [ ] ', close: '', placeholder: '待办事项' },
  { label: '链接', icon: 'Link2', open: '[', close: '](https://)', placeholder: '链接文字' },
  { label: '图片', icon: 'Image', open: '![', close: '](https://)', placeholder: '图片描述' },
  { label: '分割线', icon: 'Minus', open: '\n\n---\n\n', close: '', placeholder: '' },
];

/** 在光标处插入 Markdown 片段（无选区时带占位文本并选中） */
function insertMd(tool) {
  const textarea = document.querySelector('.md-editor textarea');
  if (!textarea) return;
  const start = textarea.selectionStart ?? form.value.content.length;
  const end = textarea.selectionEnd ?? start;
  const selected = form.value.content.slice(start, end) || tool.placeholder || '';
  const before = form.value.content.slice(0, start);
  const after = form.value.content.slice(end);
  form.value.content = before + tool.open + selected + tool.close + after;
  // 光标回落到插入内容中间（选中占位文字）
  requestAnimationFrame(() => {
    textarea.focus();
    const s = start + tool.open.length;
    textarea.setSelectionRange(s, s + selected.length);
  });
}

/** 上传图片并插入 Markdown 图片语法 */
async function uploadAndInsert(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  uploading.value = true;
  try {
    const res = await uploadApi.upload(file);
    const textarea = document.querySelector('.md-editor textarea');
    const pos = textarea?.selectionStart ?? form.value.content.length;
    form.value.content =
      form.value.content.slice(0, pos) + `\n![图片](${res.url})\n` + form.value.content.slice(pos);
    ElMessage.success('图片已上传并插入');
  } catch (err) {
    /* 拦截器已提示 */
  } finally {
    uploading.value = false;
  }
}

/** 粘贴图片直接上传插入（截图工作流：Ctrl+V 即传即插） */
async function onEditorPaste(e) {
  const files = e.clipboardData?.files;
  if (!files || !files.length) return;
  const img = [...files].find((f) => f.type.startsWith('image/'));
  if (!img) return;
  e.preventDefault();
  if (uploading.value) {
    ElMessage.warning('已有图片在上传，请稍候');
    return;
  }
  uploading.value = true;
  try {
    const res = await uploadApi.upload(img);
    const textarea = document.querySelector('.md-editor textarea');
    const pos = textarea?.selectionStart ?? form.value.content.length;
    form.value.content =
      form.value.content.slice(0, pos) + `\n![图片](${res.url})\n` + form.value.content.slice(pos);
    ElMessage.success('截图已上传并插入');
  } catch (err) {
    /* 拦截器已提示 */
  } finally {
    uploading.value = false;
  }
}

const mode = ref('write');
const categories = ref([]);
const allTags = ref([]); // 已有标签（下拉选择数据源）
const uploading = ref(false);
// 当前编辑文章的服务端状态（用于发布二次确认：已发布文章直接保存不打扰）
const articleStatus = ref('');
const dirty = ref(false);
const coverBroken = ref(false);

const form = ref({
  title: '',
  slug: '',
  category_id: null,
  tags: [],
  cover: '',
  summary: '',
  content: '',
  is_top: false,
  allow_comment: true,
  status: 'draft',
  published_at: '',
});

// ---------- 本地自动保存（防误关丢稿） ----------
const DRAFT_KEY = () => `xalor_draft_${editingId.value || 'new'}`;
migrateLegacyPrefix('xalor_draft_');
let autosaveTimer = null;
// 最近一次自动保存时间（编辑头部显示，确认草稿已落盘）
const autosavedAt = ref('');
// 程序赋值（加载/恢复草稿）期间抑制自动保存，避免未编辑也标记为已修改
let suppressWatch = false;

function scheduleAutosave() {
  if (suppressWatch) return;
  dirty.value = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    writeSessionValue(DRAFT_KEY(), JSON.stringify(form.value));
    autosavedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }, 2000);
}

/** 程序性替换表单值（不触发「已修改」标记） */
async function assignForm(next) {
  suppressWatch = true;
  form.value = { ...form.value, ...next };
  await nextTick();
  suppressWatch = false;
}

function clearDraft() {
  dirty.value = false;
  clearTimeout(autosaveTimer);
  removeStoredValue(DRAFT_KEY());
}

function restoreDraft() {
  try {
    const raw = readSessionValue(DRAFT_KEY());
    if (!raw) return;
    const saved = JSON.parse(raw);
    // 新文章或有内容的草稿才提示恢复
    if (!saved || !saved.content) return;
    ElMessageBox.confirm('检测到未保存的草稿，是否恢复？', '本地草稿', {
      confirmButtonText: '恢复',
      cancelButtonText: '丢弃',
      type: 'info',
    })
      .then(async () => {
        await assignForm(saved);
        ElMessage.success('草稿已恢复');
      })
      .catch(() => clearDraft());
  } catch (e) { /* 忽略 */ }
}

function onBeforeUnload(e) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = '';
}

const previewHtml = computed(() => renderMarkdown(form.value.content));

/** 自动生成摘要：剥离 Markdown 语法后截取前 150 字（已填则不覆盖） */
function autoSummary() {
  const md = form.value.content || '';
  if (!md.trim()) return;
  const plain = md
    .replace(/```[\s\S]*?```/g, ' ') // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
    .replace(/[#>*_`~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) {
    ElMessage.warning('正文中没有可提取的文本');
    return;
  }
  const summary = plain.slice(0, 150);
  if (form.value.summary && form.value.summary.trim()) {
    form.value.summary = summary;
    ElMessage.success('已用正文内容更新摘要');
  } else {
    form.value.summary = summary;
    ElMessage.success('摘要已生成');
  }
}

// 实时字数统计（中英文混合）
const wordCount = computed(() => {
  const c = form.value.content || '';
  const cn = (c.match(/[\u4e00-\u9fa5]/g) || []).length;
  const en = (c.match(/[a-zA-Z0-9]+/g) || []).length;
  return cn + en;
});

const readingMinutes = computed(() => Math.max(1, Math.ceil(wordCount.value / 300)));

async function doUpload({ file }) {
  uploading.value = true;
  try {
    const res = await uploadApi.upload(file);
    form.value.cover = res.url;
    ElMessage.success('封面上传成功');
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    uploading.value = false;
  }
}

/** 移除封面（预览图右上角 ×；保存后生效） */
function removeCover() {
  form.value.cover = '';
  coverBroken.value = false;
}

async function save(data) {
  if (!form.value.title.trim()) {
    ElMessage.warning('请填写标题');
    return false;
  }
  if (!form.value.content.trim()) {
    ElMessage.warning('请填写正文');
    return false;
  }
  const payload = {
    ...data,
    title: form.value.title.trim(),
    slug: form.value.slug || undefined,
    category_id: form.value.category_id || null,
    tags: form.value.tags,
    cover: form.value.cover,
    summary: form.value.summary,
    content: form.value.content,
    is_top: form.value.is_top,
    allow_comment: form.value.allow_comment,
    published_at: form.value.published_at || undefined,
  };
  try {
    if (editingId.value) {
      await articleApi.update(editingId.value, payload);
    } else {
      await articleApi.create(payload);
    }
    clearDraft();
    ElMessage.success(data.status === 'published' ? '文章已发布' : '草稿已保存');
    router.push(adminHref('articles'));
    return true;
  } catch (e) {
    return false;
  }
}

async function saveDraft() {
  await save({ status: 'draft' });
}

async function publish() {
  // 新建或草稿状态下发布：二次确认（误点发布会直接对访客可见）
  if (articleStatus.value !== 'published') {
    try {
      await ElMessageBox.confirm('发布后文章将对访客可见，确定发布吗？', '发布确认', {
        type: 'warning',
        confirmButtonText: '发布',
        cancelButtonText: '再检查一下',
      });
    } catch (e) {
      return; // 取消发布
    }
  }
  await save({ status: 'published' });
}

onMounted(async () => {
  const cats = await categoryApi.list();
  categories.value = cats;
  // 已有标签数据源：下拉可筛选选择（allow-create 仍支持输入新标签）
  tagApi.list().then((res) => (allTags.value = res || [])).catch(() => {});

  if (editingId.value) {
    const article = await articleApi.adminDetail(editingId.value);
    articleStatus.value = article.status || '';
    await assignForm({
      title: article.title || '',
      slug: article.slug || '',
      category_id: article.category_id || null,
      tags: article.tags || [],
      cover: article.cover || '',
      summary: article.summary || '',
      content: article.content || '',
      is_top: !!article.is_top,
      allow_comment: article.allow_comment !== false,
      published_at: article.published_at || '',
    });
    clearDraft();
  } else {
    restoreDraft();
  }
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('keydown', onEditorKeydown);
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('keydown', onEditorKeydown);
  // 关键：卸载时清掉待触发的自动保存定时器。
  // 否则 2 秒防抖窗口内离开编辑页，旧实例的回调会在卸载后触发，
  // 且 DRAFT_KEY() 延迟求值会读到已指向新文章的 editingId，
  // 把旧文章内容写入新文章的草稿键（下次新建/编辑时弹出错误的恢复草稿提示）
  clearTimeout(autosaveTimer);
});

/** 编辑器快捷键：Ctrl+S 保存草稿（编辑中不触发浏览器默认保存） */
function onEditorKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveDraft();
  }
}

// 表单变化 → 防抖自动保存
watch(form, scheduleAutosave, { deep: true });
</script>

<style scoped>
.article-edit {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 顶栏 */
.editor-topbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 20px;
  position: sticky;
  top: 64px;
  z-index: 30;
}

.edit-mode-tag {
  font-size: 0.85rem;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 3px 12px;
  border-radius: 999px;
}

.topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.save-hint {
  font-size: 0.78rem;
  color: var(--text-3);
  margin-right: 4px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.save-hint::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.7;
}

/* 元信息 */
.meta-card {
  padding: 24px;
}

.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 20px;
}

.span-2 {
  grid-column: span 2;
}

/* slug 实时预览 */
.slug-preview {
  display: block;
  margin-top: 6px;
  font-size: 0.78rem;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}

.slug-preview b {
  color: var(--accent);
  font-weight: 600;
}

.cover-field {
  display: flex;
  gap: 10px;
  width: 100%;
  flex-wrap: wrap;
}

/* 封面实时预览 */
.cover-preview {
  width: 120px;
  height: 68px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid var(--border);
  background: var(--bg-soft);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-broken {
  font-size: 0.72rem;
  color: var(--text-3);
}

/* 封面移除按钮（右上角） */
.cover-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}

.cover-remove:hover {
  background: #c24b5e;
}

.option-row {
  display: flex;
  gap: 24px;
}

/* 编辑器 */
.editor-card {
  padding: 0 24px 24px;
}

/* Markdown 快捷工具栏 */
.md-toolbar {
  display: flex;
  gap: 2px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.md-tool {
  width: 32px;
  height: 32px;
  border-radius: 7px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
}

.md-tool:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.md-tool:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.md-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 6px;
}

.hidden-file {
  display: none;
}

.editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}

.mode-btn {
  padding: 7px 20px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-weight: 600;
  transition: all 0.2s;
}

.mode-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.editor-hint {
  margin-left: auto;
  font-size: 0.8rem;
  color: var(--text-3);
}

/* 自动保存指示 */
.editor-autosave {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.76rem;
  color: #217a5e;
  background: color-mix(in srgb, #217a5e 10%, transparent);
  padding: 3px 10px;
  border-radius: 999px;
}

.editor-stats {
  font-size: 0.8rem;
  color: var(--text-2);
  background: var(--bg-soft);
  padding: 4px 12px;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
}

.editor-wrap {
  display: flex;
  gap: 16px;
}

.md-editor :deep(textarea) {
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  font-size: 0.95rem;
  line-height: 1.8;
}

.preview-wrap {
  min-height: 400px;
  padding: 8px 4px;
}

.preview-empty {
  color: var(--text-3);
  text-align: center;
  padding: 80px 0;
}

@media (max-width: 800px) {
  .meta-grid {
    grid-template-columns: 1fr;
  }
  .span-2 {
    grid-column: span 1;
  }
  .editor-wrap {
    flex-direction: column;
  }
  /* 窄屏：隐藏保存提示文字，压缩工具条间距 */
  .save-hint {
    display: none;
  }
  .md-toolbar {
    flex-wrap: wrap;
  }
}
</style>
