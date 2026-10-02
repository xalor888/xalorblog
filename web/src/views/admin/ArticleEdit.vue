<template>
  <div class="article-edit">
    <!-- 顶栏：吸顶玻璃条 -->
    <header class="ed-topbar">
      <div class="ed-topbar-left">
        <button class="ed-icon-btn" title="返回文章列表" @click="goBack">
          <XIcon name="ArrowLeft" :size="16" />
        </button>
        <span class="ed-mode-tag">{{ editingId ? '编辑文章' : '写文章' }}</span>
      </div>
      <div class="ed-topbar-right">
        <span v-if="autosavedAt" class="ed-autosave">
          <XIcon name="Check" :size="12" /> 已自动保存 {{ autosavedAt }}
        </span>
        <el-button :loading="savingDraft" @click="saveDraft">保存草稿</el-button>
        <el-button type="primary" :loading="publishing" @click="publish">发布</el-button>
      </div>
    </header>

    <div class="ed-body">
      <!-- 左栏：标题 + 正文 -->
      <main class="ed-main">
        <input
          v-model="form.title"
          class="ed-title"
          type="text"
          maxlength="200"
          placeholder="输入文章标题…"
        />
        <div class="ed-slug">
          <span class="ed-slug-prefix">/#/article/</span>
          <input
            v-model="form.slug"
            class="ed-slug-input"
            type="text"
            maxlength="220"
            placeholder="留空自动生成"
          />
        </div>

        <section class="ed-editor">
          <div class="ed-toolbar">
            <button class="ed-tab" :class="{ active: mode === 'write' }" @click="mode = 'write'">编辑</button>
            <button class="ed-tab" :class="{ active: mode === 'preview' }" @click="mode = 'preview'">预览</button>
            <span class="ed-toolbar-gap"></span>
            <div class="md-toolbar">
              <button
                v-for="t in mdTools"
                :key="t.label"
                class="md-tool"
                :title="t.label"
                @click="insertMd(t)"
              >
                <XIcon :name="t.icon" :size="15" />
              </button>
              <span class="md-sep"></span>
              <button class="md-tool" title="上传图片并插入" :disabled="uploading" @click="$refs.imgInput?.click()">
                <XIcon name="Upload" :size="15" />
              </button>
              <input ref="imgInput" type="file" accept="image/*" class="hidden-file" @change="uploadAndInsert" />
            </div>
            <span class="ed-stats num">{{ wordCount }} 字 · 约 {{ readingMinutes }} 分钟</span>
          </div>

          <div v-show="mode === 'write'" class="ed-editor-body">
            <el-input
              v-model="form.content"
              type="textarea"
              :rows="22"
              resize="none"
              class="md-editor"
              placeholder="用 Markdown 写作，Ctrl+V 可粘贴截图"
              @paste="onEditorPaste"
            />
          </div>

          <div v-show="mode === 'preview'" class="ed-preview">
            <div v-if="form.content" class="markdown-body" v-html="previewHtml"></div>
            <div v-else class="preview-empty">暂无内容</div>
          </div>
        </section>
      </main>

      <!-- 右栏：设置面板 -->
      <aside class="ed-side">
        <section class="ed-panel">
          <h4 class="ed-panel-title">发布</h4>
          <div class="ed-field">
            <label class="ed-label">发布时间</label>
            <el-date-picker
              v-if="articleStatus === 'published' || form.published_at"
              v-model="form.published_at"
              type="datetime"
              value-format="YYYY-MM-DD HH:mm:ss"
              placeholder="默认当前时间"
              style="width: 100%"
            />
          </div>
        </section>

        <section class="ed-panel">
          <h4 class="ed-panel-title">归类</h4>
          <div class="ed-field">
            <label class="ed-label">分类</label>
            <el-select v-model="form.category_id" placeholder="选择分类" clearable style="width: 100%">
              <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
          </div>
          <div class="ed-field">
            <label class="ed-label">标签</label>
            <el-select
              v-model="form.tags"
              multiple
              filterable
              allow-create
              default-first-option
              placeholder="输入后回车创建"
              style="width: 100%"
            >
              <el-option v-for="t in allTags" :key="t.id" :label="t.name" :value="t.name" />
            </el-select>
          </div>
        </section>

        <section class="ed-panel">
          <h4 class="ed-panel-title">封面</h4>
          <div class="cover-field">
            <el-input v-model="form.cover" placeholder="图片 URL，或点右侧上传" />
            <el-upload :show-file-list="false" :http-request="doUpload" accept="image/*">
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
        </section>

        <section class="ed-panel">
          <h4 class="ed-panel-title">摘要</h4>
          <div class="summary-field">
            <el-input
              v-model="form.summary"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="留空则自动截取正文前 150 字"
            />
            <el-button
              size="small"
              plain
              class="auto-summary-btn"
              :disabled="!form.content"
              title="从正文提取前 150 字"
              @click="autoSummary"
            >
              自动生成
            </el-button>
          </div>
        </section>

        <section class="ed-panel">
          <h4 class="ed-panel-title">选项</h4>
          <div class="ed-switches">
            <el-switch v-model="form.is_top" active-text="置顶" />
            <el-switch v-model="form.allow_comment" active-text="允许评论" />
            <el-switch v-model="form.allow_copy" active-text="允许复制" />
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, watchEffect, nextTick } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { articleApi, categoryApi, tagApi, uploadApi } from '@/api';
import { renderMarkdown } from '@/utils/markdown';
import { adminHref } from '@/utils/adminPath';
import { setAiContext, setAiApplier, setAiSelection, pushAiUndo, resetAiBridge, aiSelection as aiSelectionRef } from '@/utils/aiBridge';
import {
  migrateLegacyPrefix,
  readSessionValue,
  removeStoredValue,
  writeSessionValue,
} from '@/utils/secureStorage';

const route = useRoute();
const router = useRouter();

const editingId = computed(() => route.params.id || null);

watchEffect(() => {
  const mode = editingId.value ? '编辑文章' : '写文章';
  const title = form.value.title ? `${form.value.title} · ${mode}` : mode;
  document.title = `${title} · 管理后台`;
});

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
const savingDraft = ref(false);
const publishing = ref(false);
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
  allow_copy: true,
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

onBeforeRouteLeave(async () => {
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm('当前文章有尚未保存的修改，离开将丢失本次更改，是否确定离开？', '未保存提示', {
      confirmButtonText: '确定离开',
      cancelButtonText: '继续编辑',
      type: 'warning',
    });
    return true;
  } catch (e) {
    return false;
  }
});

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
    allow_copy: form.value.allow_copy,
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
  savingDraft.value = true;
  try {
    await save({ status: 'draft' });
  } finally {
    savingDraft.value = false;
  }
}

async function publish({ skipConfirm = false } = {}) {
  // 新建或草稿状态下发布：二次确认（误点发布会直接对访客可见）
  // skipConfirm：AI 助手代为发布时跳过弹窗 —— 用户对 AI 说「发布」本身就是确认
  if (!skipConfirm && articleStatus.value !== 'published') {
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
  publishing.value = true;
  try {
    await save({ status: 'published' });
  } finally {
    publishing.value = false;
  }
}

onMounted(async () => {
  // 分类列表失败不阻塞编辑器打开（下拉可空，保存时服务端会校验）
  categoryApi
    .list()
    .then((res) => (categories.value = res || []))
    .catch(() => ElMessage.error('分类列表加载失败'));
  // 已有标签数据源：下拉可筛选选择（allow-create 仍支持输入新标签）
  tagApi.list().then((res) => (allTags.value = res || [])).catch(() => {});

  if (editingId.value) {
    // 加载失败必须显式终止：否则表单保持全空，管理员可能误以为文章内容丢失
    let article;
    try {
      article = await articleApi.adminDetail(editingId.value);
    } catch (e) {
      ElMessage.error('文章加载失败，请刷新重试');
      return;
    }
    if (article.content_decrypt_failed) {
      ElMessage.error('正文安全解密失败，请重新获取通行证或刷新');
      return;
    }
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
      allow_copy: article.allow_copy !== false,
      published_at: article.published_at || '',
    });
    clearDraft();
  } else {
    restoreDraft();
  }
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('keydown', onEditorKeydown);
  // AI 面板要用「当前选中的文本」做润色：selectionchange 对 textarea 同样触发
  document.addEventListener('selectionchange', syncAiSelection);
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('keydown', onEditorKeydown);
  document.removeEventListener('selectionchange', syncAiSelection);
  // 关键：卸载时清掉待触发的自动保存定时器。
  // 否则 2 秒防抖窗口内离开编辑页，旧实例的回调会在卸载后触发，
  // 且 DRAFT_KEY() 延迟求值会读到已指向新文章的 editingId，
  // 把旧文章内容写入新文章的草稿键（下次新建/编辑时弹出错误的恢复草稿提示）
  clearTimeout(autosaveTimer);
  resetAiBridge();
});
/* ---------- AI 写作助手桥接 ----------
   把当前正在编辑的文章交给 AI 面板当上下文，并接收 AI 改好的内容直接写进表单。
   只有「改内容」的动作，没有发布 —— 发布永远由人点。
   所有正文/标题/摘要/标签的改动都先压撤销快照，面板上可一键撤销。 */

/** 把编辑器里的实时选区同步给 AI 面板（「润色选中」就靠它） */
function syncAiSelection() {
  const ta = document.querySelector('.md-editor textarea');
  if (!ta || document.activeElement !== ta) return;
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  if (end > start) {
    setAiSelection({ text: String(form.value.content || '').slice(start, end), start, end });
  } else {
    setAiSelection(null);
  }
}

/** applier 内取选区快照（润色/替换选区用） */
function aiSelectionBridge() {
  return aiSelectionRef && aiSelectionRef.value ? { ...aiSelectionRef.value } : null;
}

/** 内容快照：改前压栈，供面板撤销 */
function snap(label, field) {
  const old = form.value[field];
  pushAiUndo(label, () => {
    form.value[field] = old;
  });
}

watch(
  // 用轻量签名做依赖：正文可能上万字，每次输入都做深比较太亏
  () =>
    [
      form.value.title,
      form.value.summary,
      form.value.category_id,
      form.value.cover,
      form.value.slug,
      form.value.status,
      (form.value.tags || []).join(','),
      String(form.value.content || '').length,
    ].join(''),
  () => {
    setAiContext({
      type: 'article', // 面板据此显示写作快捷操作
      title: form.value.title,
      slug: form.value.slug,
      status: form.value.status,
      cover: form.value.cover,
      content: String(form.value.content || '').slice(0, 8000),
      summary: form.value.summary,
      tags: form.value.tags || [],
      category: (categories.value || []).find((c) => c.id === form.value.category_id)?.name || '',
      categories: categories.value || [],
    });
  },
  { immediate: true }
);

setAiApplier(async (name, args) => {
  switch (name) {
    case 'set_title': {
      if (!args.title) return null;
      snap('已改标题', 'title');
      form.value.title = String(args.title).slice(0, 200);
      return '已改标题';
    }
    case 'set_content': {
      if (typeof args.markdown !== 'string' || !args.markdown.trim()) return null;
      snap('已替换正文', 'content');
      form.value.content = args.markdown;
      return '已替换正文';
    }
    case 'append_content': {
      if (typeof args.markdown !== 'string' || !args.markdown.trim()) return null;
      snap('已追加正文', 'content');
      const cur = String(form.value.content || '').replace(/\s+$/, '');
      form.value.content = cur ? `${cur}\n\n${args.markdown}` : args.markdown;
      return '已追加正文';
    }
    case 'replace_selection': {
      if (typeof args.markdown !== 'string') return null;
      const content = String(form.value.content || '');
      const sel = aiSelectionBridge();
      if (!sel) return null; // 没有可用选区（或选区已被改没）
      let start = -1;
      if (content.slice(sel.start, sel.end) === sel.text) start = sel.start;
      else {
        const idx = content.indexOf(sel.text);
        if (idx !== -1) start = idx; // 偏移失效但原文还在：按内容找
      }
      if (start === -1) return null;
      snap('已替换选中文本', 'content');
      const end = start + sel.text.length;
      form.value.content = content.slice(0, start) + args.markdown + content.slice(end);
      return '已替换选中文本';
    }
    case 'insert_at_cursor': {
      if (typeof args.markdown !== 'string' || !args.markdown.trim()) return null;
      const content = String(form.value.content || '');
      const ta = document.querySelector('.md-editor textarea');
      const pos = ta && document.activeElement === ta ? ta.selectionStart ?? content.length : content.length;
      snap('已在光标处插入', 'content');
      form.value.content = content.slice(0, pos) + args.markdown + content.slice(pos);
      return '已在光标处插入';
    }
    case 'set_summary': {
      if (!args.summary) return null;
      snap('已写摘要', 'summary');
      form.value.summary = String(args.summary).slice(0, 500);
      return '已写摘要';
    }
    case 'set_tags': {
      if (!Array.isArray(args.tags)) return null;
      snap('已设标签', 'tags');
      form.value.tags = args.tags.map(String).filter(Boolean).slice(0, 10);
      return '已设标签';
    }
    case 'set_category': {
      const catName = String(args.category || '').trim();
      const cat = (categories.value || []).find((c) => c.name === catName);
      if (!cat || form.value.category_id === cat.id) return null; // 分类必须已存在
      const old = form.value.category_id;
      pushAiUndo(`已设分类：${cat.name}`, () => {
        form.value.category_id = old;
      });
      form.value.category_id = cat.id;
      return `已设分类：${cat.name}`;
    }
    case 'set_cover': {
      const url = String(args.url || '').trim();
      // 只接受 https 外链或本站转存路径
      if (!/^https:\/\//i.test(url) && !url.startsWith('/uploads/')) return null;
      const old = form.value.cover;
      pushAiUndo('已设封面', () => {
        form.value.cover = old;
      });
      form.value.cover = url;
      return '已设封面';
    }
    case 'set_options': {
      const o = args || {};
      const changed = [];
      if (typeof o.is_top === 'boolean' && o.is_top !== form.value.is_top) {
        form.value.is_top = o.is_top;
        changed.push('置顶');
      }
      if (typeof o.allow_comment === 'boolean' && o.allow_comment !== form.value.allow_comment) {
        form.value.allow_comment = o.allow_comment;
        changed.push('评论');
      }
      if (typeof o.allow_copy === 'boolean' && o.allow_copy !== form.value.allow_copy) {
        form.value.allow_copy = o.allow_copy;
        changed.push('复制');
      }
      if (o.publish_time && String(o.publish_time).slice(0, 20) !== String(form.value.published_at || '')) {
        form.value.published_at = String(o.publish_time).slice(0, 20);
        changed.push('发布时间');
      }
      return changed.length ? `已调整：${changed.join('、')}` : null;
    }
    case 'save_draft': {
      // 保存草稿（不是发布）：沿用页面自己的保存逻辑（校验/提示/本地草稿清理都在里面）
      if (savingDraft.value || publishing.value) return null;
      await saveDraft();
      return '已保存草稿';
    }
    case 'publish': {
      // 发布（用户明确要求时）：跳过确认弹窗，复用页面发布逻辑（含校验/导航）
      if (savingDraft.value || publishing.value) return null;
      const okPublished = await publish({ skipConfirm: true });
      return okPublished === false ? null : '已发布';
    }
    case 'set_slug': {
      const slug = String(args.slug || '').trim().slice(0, 200);
      if (!slug) return null;
      snap('已改链接地址', 'slug');
      form.value.slug = slug;
      return '已改链接地址';
    }
    default:
      return null; // 未识别的动作 → 面板提示「当前页面不支持」
  }
});

/** 编辑器快捷键：Ctrl+S 保存草稿，Ctrl+Enter 发布 */
function onEditorKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!savingDraft.value && !publishing.value) saveDraft();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!savingDraft.value && !publishing.value) publish();
  }
}

// 表单变化 → 防抖自动保存
watch(form, scheduleAutosave, { deep: true });
</script>

<style scoped>
/* ============================================================
   写作台
   —— 与前台同一套液态玻璃（--sg-*），两栏布局：左边写，右边设置
   ============================================================ */
.article-edit {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 48px;
}

/* ---------------- 顶栏（吸顶玻璃条） ---------------- */
.ed-topbar {
  position: sticky;
  top: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-radius: 18px;
  background: var(--sg-sheen), var(--sg-tint), var(--sg-surface);
  border: 1px solid var(--sg-edge);
  box-shadow: var(--sg-shadow), var(--sg-inner);
  backdrop-filter: var(--sg-blur-soft);
  -webkit-backdrop-filter: var(--sg-blur-soft);
}

.ed-topbar-left,
.ed-topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ed-icon-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--text-2);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.ed-icon-btn:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.ed-mode-tag {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--text-2);
}

.ed-kbd,
.ed-autosave {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.74rem;
  color: var(--text-3);
  white-space: nowrap;
}

/* ---------------- 两栏骨架 ---------------- */
.ed-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  gap: 20px;
  align-items: start;
}

.ed-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* ---------------- 标题与 slug ---------------- */
.ed-title {
  width: 100%;
  padding: 8px 4px;
  font-family: inherit;
  font-size: clamp(1.5rem, 3.2vw, 2rem);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--text);
  background: transparent;
  border: none;
  border-bottom: 1px solid transparent;
  outline: none;
  transition: border-color var(--dur) var(--ease);
}

.ed-title::placeholder {
  color: var(--text-3);
  opacity: 0.55;
}

.ed-title:focus {
  border-bottom-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.ed-slug {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  font-size: 0.8rem;
  color: var(--text-3);
}

.ed-slug-input {
  flex: 1;
  min-width: 0;
  padding: 2px 0;
  font: inherit;
  color: var(--text-2);
  background: transparent;
  border: none;
  outline: none;
  transition: color var(--dur) var(--ease);
}

.ed-slug-input:focus {
  color: var(--text);
}

.ed-slug-input::placeholder {
  color: var(--text-3);
  opacity: 0.7;
}

/* ---------------- 编辑器 ---------------- */
.ed-editor {
  border-radius: 18px;
  overflow: hidden;
  background: var(--sg-sheen), var(--sg-tint), var(--sg-surface);
  border: 1px solid var(--sg-edge);
  box-shadow: var(--sg-shadow), var(--sg-inner);
  backdrop-filter: var(--sg-blur-soft);
  -webkit-backdrop-filter: var(--sg-blur-soft);
}

.ed-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sg-edge);
}

.ed-tab {
  padding: 5px 15px;
  border-radius: 999px;
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--text-2);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.ed-tab:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 7%, transparent);
}

.ed-tab.active {
  color: #fff;
  background: var(--accent);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--accent) 38%, transparent);
}

.ed-toolbar-gap {
  flex: 1;
  min-width: 8px;
}

.md-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}

.md-tool {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--text-2);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.md-tool:hover:not(:disabled) {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 13%, transparent);
}

.md-tool:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.md-sep {
  width: 1px;
  height: 18px;
  margin: 0 6px;
  background: var(--sg-edge);
}

.ed-stats {
  font-size: 0.74rem;
  color: var(--text-3);
  white-space: nowrap;
}

.num {
  font-variant-numeric: tabular-nums;
}

/* 正文输入：去掉 EP 的边框与白底，直接"长"在玻璃上 */
.ed-editor :deep(.md-editor .el-textarea__inner) {
  min-height: 52vh !important;
  padding: 18px 20px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.94rem;
  line-height: 1.85;
  color: var(--text);
  background: transparent;
  border: none;
  box-shadow: none;
}

.ed-editor :deep(.md-editor .el-textarea__inner::placeholder) {
  color: var(--text-3);
  opacity: 0.65;
}

.ed-preview {
  min-height: 52vh;
  padding: 22px 24px;
}

.preview-empty {
  padding: 60px 0;
  text-align: center;
  color: var(--text-3);
}

.hidden-file {
  display: none;
}

/* ---------------- 右栏面板 ---------------- */
.ed-side {
  position: sticky;
  top: 82px; /* 顶栏高度 + 间距 */
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: calc(100vh - 104px);
  overflow-y: auto;
  padding-right: 4px;
  /* 细滚动条，别在玻璃卡片旁杵一根粗灰条 */
  scrollbar-width: thin;
}

.ed-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 18px;
  background: var(--sg-sheen), var(--sg-tint), var(--sg-surface);
  border: 1px solid var(--sg-edge);
  box-shadow: var(--sg-shadow), var(--sg-inner);
  backdrop-filter: var(--sg-blur-soft);
  -webkit-backdrop-filter: var(--sg-blur-soft);
}

.ed-panel-title {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.ed-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ed-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-2);
}

.ed-switches {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* EP 输入类控件在玻璃上的适配：去掉白底与描边 */
.ed-side :deep(.el-input__wrapper),
.ed-side :deep(.el-select__wrapper),
.ed-side :deep(.el-textarea__inner) {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  box-shadow: none;
  border-radius: 10px;
}

.ed-side :deep(.el-input__wrapper.is-focus),
.ed-side :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}

/* ---------------- 封面上传 ---------------- */
.cover-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cover-preview {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--sg-edge);
}

.cover-preview img {
  display: block;
  width: 100%;
  height: auto;
}

.cover-broken {
  display: block;
  padding: 8px;
  font-size: 0.76rem;
  text-align: center;
  color: var(--text-3);
}

.cover-remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  transition: background var(--dur) var(--ease);
}

.cover-remove:hover {
  background: var(--accent);
}

/* ---------------- 摘要 ---------------- */
.summary-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.summary-field :deep(.el-textarea) {
  width: 100%;
}

/* ---------------- 窄屏：合并为单栏 ---------------- */
@media (max-width: 1180px) {
  .ed-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .ed-side {
    position: static;
    max-height: none;
    overflow: visible;
  }
}

@media (max-width: 720px) {
  .ed-kbd {
    display: none;
  }

  .ed-topbar-right {
    width: 100%;
    justify-content: flex-end;
  }

  .ed-editor :deep(.md-editor .el-textarea__inner) {
    min-height: 44vh !important;
    padding: 14px 16px;
  }

  .ed-preview {
    min-height: 44vh;
    padding: 16px;
  }
}
</style>
