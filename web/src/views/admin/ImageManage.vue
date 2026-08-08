<template>
  <div class="image-manage">
    <div class="page-head">
      <div>
        <h2>图片管理</h2>
        <p class="sub">共 {{ files.length }} 个上传文件 · 被引用的图片禁止直接删除</p>
      </div>
      <div class="head-actions">
        <el-button type="primary" :loading="uploading" @click="$refs.uploadInput?.click()">
          <XIcon name="Upload" :size="14" /> 上传图片
        </el-button>
        <input ref="uploadInput" type="file" accept="image/*" class="hidden-file" @change="uploadOne" />
        <el-button type="danger" plain :loading="cleaning" @click="cleanupOrphans">
          <XIcon name="RefreshCw" :size="14" /> 清理孤儿文件
        </el-button>
      </div>
    </div>

    <div v-if="loading" v-loading="true" class="loading-block"></div>

    <el-empty v-else-if="!files.length" description="还没有上传过图片" />

    <div v-else class="image-grid">
      <div v-for="f in visibleFiles" :key="f.name" class="image-cell">
        <div class="thumb">
          <img :src="`/uploads/${f.name}`" :alt="f.name" loading="lazy" @click="preview(f.name)" />
          <span v-if="f.used" class="used-badge">引用中</span>
          <span v-else class="free-badge">未引用</span>
        </div>
        <div class="cell-info">
          <p class="fname" :title="f.name">{{ f.name }}</p>
          <p class="fmeta">{{ formatSize(f.size) }} · {{ formatTime(f.mtime) }}</p>
        </div>
        <div class="cell-actions">
          <el-button size="small" plain title="复制图片 URL" @click="copyUrl(f.name)">
            <XIcon name="Copy" :size="13" />
          </el-button>
          <el-button class="del-btn" size="small" type="danger" plain :disabled="f.used" @click="remove(f.name)">
            <XIcon name="Trash2" :size="13" />
          </el-button>
        </div>
      </div>
    </div>

    <!-- 本地分页：500 条上限下避免一次性渲染全部 DOM -->
    <div v-if="files.length > PAGE_SIZE" class="img-pagination">
      <el-pagination
        v-model:current-page="imgPage"
        :page-size="PAGE_SIZE"
        :total="files.length"
        layout="prev, pager, next"
        background
        small
      />
    </div>

    <!-- 预览灯箱 -->
    <el-dialog v-model="previewOpen" :title="previewName" width="min(92vw, 720px)" append-to-body>
      <img :src="`/uploads/${previewName}`" class="preview-img" :alt="previewName" />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { imagesApi, uploadApi } from '@/api';

const files = ref([]);
const loading = ref(false);
const cleaning = ref(false);
const uploading = ref(false);
const previewOpen = ref(false);
const previewName = ref('');

// 本地分页（每页 60，超出才显示分页器）
const PAGE_SIZE = 60;
const imgPage = ref(1);
const visibleFiles = computed(() => files.value.slice((imgPage.value - 1) * PAGE_SIZE, imgPage.value * PAGE_SIZE));

/** 页面上传：上传成功后刷新列表（服务端随机重命名 + magic bytes/EXIF 校验） */
async function uploadOne(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // 同文件可重复选择
  if (!file) return;
  uploading.value = true;
  try {
    const res = await uploadApi.upload(file);
    ElMessage.success('上传成功');
    load();
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '上传失败');
  } finally {
    uploading.value = false;
  }
}

/** 引用信息由后端 collectReferencedUploads 返回（used 标记），本页直接消费 */
function load() {
  loading.value = true;
  imgPage.value = 1; // 列表变化后回到第一页
  imagesApi
    .list()
    .then((res) => {
      files.value = (res.data || []).map((f) => ({ ...f, used: false }));
    })
    .catch(() => ElMessage.error('加载图片列表失败'))
    .finally(() => (loading.value = false));
}

function preview(name) {
  previewName.value = name;
  previewOpen.value = true;
}

/** 复制图片 URL（markdown 友好：![]() 可直接粘贴进编辑器） */
async function copyUrl(name) {
  const url = `/uploads/${name}`;
  const markdown = `![图片](${url})`;
  const done = () => ElMessage.success('图片 Markdown 已复制');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(markdown);
      done();
    } else {
      const ta = document.createElement('textarea');
      ta.value = markdown;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    }
  } catch (e) {
    ElMessage.error('复制失败');
  }
}

function remove(name) {
  ElMessageBox.confirm(`确定删除 ${name} 吗？此操作不可恢复。`, '删除图片', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消',
  })
    .then(() => imagesApi.remove(name))
    .then(() => {
      ElMessage.success('已删除');
      load();
    })
    .catch((e) => {
      if (e !== 'cancel' && e !== 'close') ElMessage.error(e?.message || '删除失败');
    });
}

function cleanupOrphans() {
  ElMessageBox.confirm('将删除未被任何文章/设置引用的图片（保留 24 小时内新上传的），继续？', '清理孤儿文件', {
    type: 'warning',
    confirmButtonText: '清理',
    cancelButtonText: '取消',
  })
    .then(() => {
      cleaning.value = true;
      return imagesApi.cleanupOrphans();
    })
    .then((res) => {
      ElMessage.success(res?.message || '清理完成');
      load();
    })
    .catch((e) => {
      if (e !== 'cancel' && e !== 'close') ElMessage.error(e?.message || '清理失败');
    })
    .finally(() => (cleaning.value = false));
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

onMounted(load);
</script>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 20px;
  gap: 12px;
  flex-wrap: wrap;
}

.page-head h2 {
  font-size: 1.3rem;
  font-weight: 800;
  margin-bottom: 4px;
}

.sub {
  color: var(--text-2);
  font-size: 0.85rem;
}

.loading-block {
  min-height: 200px;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
}

.image-cell {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.image-cell:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-1);
}

.thumb {
  position: relative;
  aspect-ratio: 1 / 1;
  background: var(--bg-soft);
  cursor: zoom-in;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.used-badge,
.free-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  font-size: 0.68rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  color: #fff;
}

.used-badge {
  background: rgba(64, 158, 255, 0.85);
}

.free-badge {
  background: rgba(103, 194, 58, 0.85);
}

.cell-info {
  padding: 8px 10px 10px;
}

.fname {
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 3px;
}

.fmeta {
  font-size: 0.7rem;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.del-btn {
  position: absolute;
  right: 8px;
  bottom: 8px;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}

.image-cell:hover .del-btn {
  opacity: 1;
}

/* 操作按钮组（复制链接 + 删除） */
.cell-actions {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  gap: 6px;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}

.image-cell:hover .cell-actions {
  opacity: 1;
}

.cell-actions .del-btn {
  position: static;
  opacity: 1;
}

.preview-img {
  width: 100%;
  border-radius: 8px;
}

@media (max-width: 640px) {
  .del-btn {
    opacity: 1;
  }
}

.hidden-file {
  display: none;
}

/* 本地分页 */
.img-pagination {
  display: flex;
  justify-content: center;
  margin-top: 22px;
}

</style>
