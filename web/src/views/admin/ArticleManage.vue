<template>
  <div class="article-manage">
    <!-- 工具栏 -->
    <div class="toolbar card">
      <div class="toolbar-left">
        <el-input
          v-model="keyword"
          placeholder="搜索文章标题…"
          clearable
          :prefix-icon="Search"
          class="search-input"
          @keyup.enter="load(1)"
          @clear="load(1)"
        />
        <el-select v-model="status" class="status-select" @change="load(1)">
          <el-option label="全部状态" value="all" />
          <el-option label="已发布" value="published" />
          <el-option label="草稿" value="draft" />
        </el-select>
        <el-select v-model="categoryId" class="status-select" placeholder="全部分类" clearable @change="load(1)">
          <el-option label="未分类" :value="0" />
          <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-select v-model="sortBy" class="status-select" @change="load(1)">
          <el-option label="按创建时间" value="latest" />
          <el-option label="按最近更新" value="updated" />
          <el-option label="按浏览量" value="views" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <el-button plain :loading="exporting" @click="exportBackup">
          <template #icon><XIcon name="Download" :size="15" /></template>
          导出备份
        </el-button>
        <el-button plain :loading="importing" @click="pickImport">
          <template #icon><XIcon name="Upload" :size="15" /></template>
          导入备份
        </el-button>
        <input ref="importInput" type="file" accept=".json,application/json" class="hidden-input" @change="onImportFile" />
        <el-button type="primary" @click="goNew">
          <template #icon><XIcon name="SquarePen" :size="15" /></template>
          写文章
        </el-button>
      </div>
    </div>

    <!-- 文章表格 -->
    <div class="table-card card">
      <el-table :data="list" v-loading="loading && !list.length" stripe @selection-change="onSelectionChange">
        <el-table-column type="selection" width="44" />
        <el-table-column label="封面" width="64" align="center">
          <template #default="{ row }">
            <div
              v-if="row.cover"
              class="thumb"
              :style="{ backgroundImage: `url(${row.cover})` }"
              :title="'查看：' + row.title"
              @click="gotoArticle(row)"
            ></div>
            <div v-else class="thumb thumb-empty"><XIcon name="ImageOff" :size="16" /></div>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="280">
          <template #default="{ row }">
            <div class="title-cell">
              <span class="title-text">{{ row.title }}</span>
              <el-tag v-if="row.is_top" size="small" type="danger" effect="light" class="tag">置顶</el-tag>
              <el-tag v-if="row.status === 'draft'" size="small" type="info" effect="plain" class="tag">草稿</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="110">
          <template #default="{ row }">
            <span v-if="row.category_name" class="cat-cell">{{ row.category_name }}</span>
            <span v-else class="muted">未分类</span>
          </template>
        </el-table-column>
        <el-table-column prop="views" label="阅读" width="80" align="center" />
        <el-table-column prop="likes" label="点赞" width="80" align="center" />
        <el-table-column label="评论" width="80" align="center">
          <template #default="{ row }">{{ row.comment_count }}</template>
        </el-table-column>
        <el-table-column label="发布时间" width="150">
          <template #default="{ row }">
            {{ row.published_at ? formatDate(row.published_at) : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="150">
          <template #default="{ row }">
            <span :class="{ 'upd-stale': row.updated_at && row.published_at && String(row.updated_at).slice(0, 10) > String(row.published_at).slice(0, 10) }">
              {{ row.updated_at ? formatDate(row.updated_at) : '—' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="edit(row)">编辑</el-button>
            <el-button v-if="row.status === 'draft'" size="small" link type="success" @click="publish(row)">发布</el-button>
            <el-button size="small" link type="warning" :title="row.is_top ? '取消置顶' : '置顶'" @click="toggleTop(row)">
              {{ row.is_top ? '取消置顶' : '置顶' }}
            </el-button>
            <el-button size="small" link :loading="duplicatingId === row.id" :title="'复制为新草稿'" @click="duplicate(row)">复制</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 批量操作 -->
      <div v-if="selection.length" class="batch-bar">
        <span class="batch-count">已选 {{ selection.length }} 篇</span>
        <el-button size="small" type="success" @click="batchPublish">批量发布</el-button>
        <el-button size="small" type="warning" plain @click="batchAddTag">添加标签</el-button>
        <el-button size="small" plain @click="batchSetCategory">设置分类</el-button>
        <el-button size="small" plain @click="batchRemoveCategory">移出分类</el-button>
        <el-button size="small" plain @click="batchTop">批量置顶</el-button>
        <el-button size="small" plain @click="batchUntop">取消置顶</el-button>
        <el-button size="small" type="danger" plain @click="batchRemove">批量删除</el-button>
        <el-button size="small" link @click="selection = []">取消选择</el-button>
      </div>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="total, prev, pager, next"
          background
          @current-change="(p) => load(p)"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import XIcon from '@/components/ui/XIcon.vue';
import { articleApi, categoryApi } from '@/api';
import { formatDate } from '@/utils/format';
import { adminHref } from '@/utils/adminPath';
import { getCachedAdminPath } from '@/utils/adminPath';
import { getTicket, ensurePass } from '@/utils/pass';
import { getFingerprint } from '@/utils/fingerprint';
import { getAuthToken } from '@/utils/authSession';

const router = useRouter();

const list = ref([]);
const loading = ref(false);
const page = ref(1);
const pageSize = 10;
const total = ref(0);
const keyword = ref('');
const status = ref('all');
const categoryId = ref(null);
const sortBy = ref('latest');
const categories = ref([]);

async function load(p = page.value) {
  loading.value = true;
  try {
    const res = await articleApi.adminList({
      page: p,
      pageSize,
      keyword: keyword.value || undefined,
      status: status.value,
      category_id: categoryId.value || undefined,
      sort: sortBy.value,
    });
    list.value = res.list;
    total.value = res.pagination.total;
    page.value = p;
  } finally {
    loading.value = false;
  }
}

function edit(row) {
  router.push(adminHref(`articles/${row.id}/edit`));
}

function goNew() {
  router.push(adminHref('articles/new'));
}

/** 全量文章备份导出：原生 fetch 下载 JSON（绕过 JSON 拦截器直接落盘） */
const exporting = ref(false);
async function exportBackup() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await ensurePass();
    const key = getCachedAdminPath();
    const resp = await fetch(`/api/${key}/articles/admin/export`, {
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
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
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    a.download = m ? m[1] : 'articles-backup.json';
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success('备份已导出');
  } catch (e) {
    ElMessage.error('导出失败，请重试');
  } finally {
    exporting.value = false;
  }
}

/** 备份导入：解析 JSON → 校验格式 → 按 300 篇/片分片提交（低于 WAF 体积与数组上限） */
const importing = ref(false);
const importInput = ref(null);
function pickImport() {
  importInput.value?.click();
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!/\.json$/i.test(file.name)) {
    ElMessage.warning('请选择 .json 备份文件');
    return;
  }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    ElMessage.error('备份文件解析失败，请检查文件完整性');
    return;
  }
  if (!data || data.meta?.type !== 'articles-backup' || !Array.isArray(data.articles)) {
    ElMessage.error('不是有效的 Xalorblog 文章备份');
    return;
  }
  const total = data.articles.length;
  if (!total) {
    ElMessage.warning('备份中没有文章');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将合并导入 ${total} 篇文章。已存在（按 slug 匹配）的自动跳过、不覆盖，确定继续吗？`,
      '导入备份',
      { type: 'warning', confirmButtonText: '导入', cancelButtonText: '取消' }
    );
  } catch (err) {
    return; /* 用户取消 */
  }
  importing.value = true;
  let imported = 0;
  let skipped = 0;
  try {
    const CHUNK = 300;
    for (let i = 0; i < total; i += CHUNK) {
      const res = await articleApi.importBackup(data.articles.slice(i, i + CHUNK));
      imported += res.imported;
      skipped += res.skipped;
    }
    ElMessage.success(`导入完成：新增 ${imported} 篇，跳过 ${skipped} 篇`);
    load(1);
  } catch (err) {
    /* 拦截器已提示 */
  } finally {
    importing.value = false;
  }
}

/** 点击封面跳转前台文章 */
function gotoArticle(row) {
  if (row.status === 'published' && row.slug) {
    window.open(`${location.origin}${location.pathname}#/article/${row.slug}`, '_blank');
  }
}

async function publish(row) {
  try {
    await articleApi.update(row.id, { status: 'published' });
    ElMessage.success('已发布');
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

/** 行内快捷置顶/取消置顶（免进编辑页） */
async function toggleTop(row) {
  try {
    const action = row.is_top ? 'untop' : 'top';
    await articleApi.batchUpdate([row.id], action);
    row.is_top = !row.is_top;
    ElMessage.success(row.is_top ? '已置顶' : '已取消置顶');
  } catch (e) {
    /* 拦截器已提示 */
  }
}

/** 复制为新草稿：克隆正文/标签/分类，阅读点赞归零，直接进入编辑页 */
const duplicatingId = ref(null);
async function duplicate(row) {
  if (duplicatingId.value) return;
  duplicatingId.value = row.id;
  try {
    const res = await articleApi.duplicate(row.id);
    ElMessage.success(res?.message || '已复制为新草稿');
    router.push(adminHref(`articles/${res.id}/edit`));
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    duplicatingId.value = null;
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除《${row.title}》吗？此操作不可恢复。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await articleApi.remove(row.id);
    ElMessage.success('删除成功');
    if (list.value.length === 1 && page.value > 1) page.value -= 1;
    load();
  } catch (e) {
    /* 取消 */
  }
}

// ---------- 批量操作 ----------
const selection = ref([]);

function onSelectionChange(rows) {
  selection.value = rows;
}

async function batchPublish() {
  try {
    const drafts = selection.value.filter((r) => r.status === 'draft');
    if (!drafts.length) return ElMessage.warning('所选文章均已发布');
    await articleApi.batchUpdate(drafts.map((r) => r.id), 'publish');
    ElMessage.success(`已发布 ${drafts.length} 篇文章`);
    selection.value = [];
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

/** 批量置顶（服务端 top action，幂等） */
async function batchTop() {
  const count = selection.value.length;
  if (!count) return ElMessage.warning('请先选择文章');
  try {
    await articleApi.batchUpdate(selection.value.map((r) => r.id), 'top');
    ElMessage.success(`已置顶 ${count} 篇文章`);
    selection.value = [];
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

/** 批量取消置顶 */
async function batchUntop() {
  const count = selection.value.length;
  if (!count) return ElMessage.warning('请先选择文章');
  try {
    await articleApi.batchUpdate(selection.value.map((r) => r.id), 'untop');
    ElMessage.success(`已取消置顶 ${count} 篇文章`);
    selection.value = [];
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

/** 批量设置分类：弹窗选择已有分类 */
async function batchSetCategory() {
  const count = selection.value.length;
  if (!count) return ElMessage.warning('请先选择文章');
  if (!categories.value.length) return ElMessage.warning('暂无分类，请先创建分类');
  try {
    const { value } = await ElMessageBox.prompt('为选中的文章设置分类', '设置分类', {
      inputPlaceholder: '输入分类名称（从现有分类中选择）',
      inputValidator: (v) => (v && v.trim() ? true : '请输入分类名称'),
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
    const cat = categories.value.find((c) => c.name === value.trim());
    if (!cat) return ElMessage.warning('分类不存在，请从现有分类中选择');
    await articleApi.batchUpdate(
      selection.value.map((r) => r.id),
      'set-category',
      { categoryId: cat.id }
    );
    ElMessage.success(`已将 ${count} 篇文章设置为「${cat.name}」`);
    selection.value = [];
    load();
  } catch (e) {
    /* 取消 */
  }
}

/** 批量移出分类（置为未分类） */
async function batchRemoveCategory() {
  const count = selection.value.length;
  if (!count) return ElMessage.warning('请先选择文章');
  try {
    await ElMessageBox.confirm(`确定将选中的 ${count} 篇文章移出分类吗？`, '移出分类', {
      type: 'warning',
      confirmButtonText: '移出',
      cancelButtonText: '取消',
    });
    await articleApi.batchUpdate(
      selection.value.map((r) => r.id),
      'set-category',
      { categoryId: 0 }
    );
    ElMessage.success(`已将 ${count} 篇文章移出分类`);
    selection.value = [];
    load();
  } catch (e) {
    /* 取消 */
  }
}

/** 批量添加标签：输入标签名，为选中文章统一追加 */
async function batchAddTag() {
  const count = selection.value.length;
  if (!count) return ElMessage.warning('请先选择文章');
  try {
    const { value } = await ElMessageBox.prompt('为选中的文章统一添加标签（已存在的自动忽略）', '添加标签', {
      inputPlaceholder: '输入标签名，如：Vue',
      inputValidator: (v) => (v && v.trim() ? true : '请输入标签名'),
      confirmButtonText: '添加',
      cancelButtonText: '取消',
    });
    const name = value.trim();
    await articleApi.batchUpdate(
      selection.value.map((r) => r.id),
      'add-tag',
      { tagName: name }
    );
    ElMessage.success(`已为 ${count} 篇文章添加标签「${name}」`);
    selection.value = [];
    load();
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(e?.message || '操作失败');
  }
}

async function batchRemove() {
  const count = selection.value.length;
  if (!count) return ElMessage.warning('请先选择文章');
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${count} 篇文章吗？此操作不可恢复。`, '批量删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await articleApi.batchDelete(selection.value.map((r) => r.id));
    ElMessage.success(`已删除 ${count} 篇文章`);
    selection.value = [];
    // 边界场景：当前页被删空后回退一页，避免停留在空页
    if (list.value.length === count && page.value > 1) page.value -= 1;
    load();
  } catch (e) {
    /* 取消 */
  }
}

onMounted(async () => {
  // 分类筛选项加载
  try {
    categories.value = await categoryApi.list();
  } catch (e) { /* 拦截器已提示 */ }
  load(1);
});
</script>

<style scoped>
.article-manage {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  gap: 12px;
}

.toolbar-left {
  display: flex;
  gap: 12px;
  flex: 1;
}

.toolbar-right {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.hidden-input {
  display: none;
}

.search-input {
  max-width: 300px;
}

/* 批量操作栏 */
.batch-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 14px;
  margin-top: 8px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: var(--radius-sm);
}

.batch-count {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--accent-deep);
  margin-right: 6px;
}

.status-select {
  width: 130px;
}

.table-card {
  padding: 8px 16px 16px;
}

.title-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 封面缩略图 */
.thumb {
  width: 44px;
  height: 32px;
  border-radius: 6px;
  background-size: cover;
  background-position: center;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.thumb-empty {
  background: var(--bg-soft);
  color: var(--text-3);
  cursor: default;
}

.thumb:hover {
  transform: scale(1.15);
  box-shadow: var(--shadow-1);
}

.title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 340px;
}

.tag {
  flex-shrink: 0;
}

.cat-cell {
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 0.82rem;
}

.muted {
  color: var(--text-3);
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  padding: 16px 0 8px;
}

@media (max-width: 700px) {
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .toolbar-left {
    flex-direction: column;
  }
  .toolbar-right {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .search-input {
    max-width: none;
  }
}
</style>
