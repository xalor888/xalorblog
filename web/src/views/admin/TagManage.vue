<template>
  <div class="tag-manage">
    <!-- 新建标签与搜索 -->
    <div class="create-card card">
      <div class="create-row">
        <input
          v-model="newName"
          class="create-input"
          placeholder="输入标签名称，回车创建"
          maxlength="50"
          @keyup.enter="create"
        />
        <button class="create-btn" :disabled="creating || !newName.trim()" @click="create">
          创建标签
        </button>
      </div>
      <div class="filter-row">
        <el-input
          v-model="searchKey"
          placeholder="搜索标签..."
          size="small"
          clearable
          style="max-width: 260px"
        />
        <el-button size="small" plain :loading="exporting" style="margin-left: auto" @click="exportCsv">
          <XIcon name="Download" :size="13" /> 导出 CSV
        </el-button>
      </div>
    </div>

    <!-- 标签列表 -->
    <div class="table-card card">
      <el-table :data="filteredList" v-loading="loading && !list.length" stripe>
        <el-table-column label="标签" min-width="200">
          <template #default="{ row }">
            <span class="tag-name"># {{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="文章数" width="120" align="center">
          <template #default="{ row }">
            <span class="count-badge">{{ row.article_count }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="mergeTag(row)">合并</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { tagApi } from '@/api';
import { downloadBlob } from '@/utils/download';

const list = ref([]);
const searchKey = ref('');
const loading = ref(false);
const creating = ref(false);
const exporting = ref(false);
const newName = ref('');

const filteredList = computed(() => {
  const kw = searchKey.value.trim().toLowerCase();
  if (!kw) return list.value;
  return list.value.filter((t) => t.name.toLowerCase().includes(kw));
});

async function load() {
  loading.value = true;
  try {
    list.value = await tagApi.list();
  } finally {
    loading.value = false;
  }
}

async function create() {
  // 原来这里 `if (!name) return;` —— **什么都不说就返回**，
  // 用户点了「创建」看到毫无反应，不知道是没生效还是没填名字。
  // 与 CategoryManage 的「请输入分类名称」保持一致。
  if (creating.value) return;
  const name = newName.value.trim();
  if (!name) return ElMessage.warning('请输入标签名称');
  creating.value = true;
  try {
    await tagApi.create({ name });
    ElMessage.success('标签创建成功');
    newName.value = '';
    load();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    creating.value = false;
  }
}

async function remove(row) {
  try {
    // 与分类删除保持同一套写法：把「影响几篇文章」写进问句。
    // 原先只说「文章的标签关联将同步移除」，不区分这个标签挂着 0 篇还是 3 篇 ——
    // 两种情况后果不同，而提示一模一样。
    const n = Number(row.article_count) || 0;
    const impact = n > 0 ? `该标签将从 ${n} 篇文章上移除。` : '当前没有文章使用这个标签。';
    await ElMessageBox.confirm(
      `确定删除标签「${row.name}」吗？${impact}`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
    await tagApi.remove(row.id);
    ElMessage.success('删除成功');
    load();
  } catch (e) {
    /* 取消 */
  }
}

/** 合并标签：输入目标标签名（须为已有标签），本标签的文章关联转移后删除 */
async function mergeTag(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `将「${row.name}」合并到哪个标签？输入目标标签名（须为已有标签），` +
        '合并后本标签将被删除，其文章自动归入目标标签。',
      '合并标签',
      {
        inputPlaceholder: '目标标签名',
        inputValidator: (v) => (v && v.trim() ? true : '请输入目标标签名'),
        confirmButtonText: '合并',
        cancelButtonText: '取消',
      }
    );
    const targetName = value.trim().toLowerCase();
    const target = list.value.find((t) => t.id !== row.id && t.name.toLowerCase() === targetName);
    if (!target) {
      return ElMessage.warning('目标标签不存在，请从现有标签中选择');
    }
    await tagApi.merge(row.id, target.id);
    ElMessage.success(`已将「${row.name}」合并至「${target.name}」`);
    load();
  } catch (e) {
    /* 取消 */
  }
}

function exportCsv() {
  if (!list.value.length) return ElMessage.info('暂无标签可导出');
  exporting.value = true;
  try {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/^[=+\-@\t\r]/, "'$&")}"`;
    const rows = [
      ['ID', '标签名称', 'Slug', '关联文章数'],
      ...filteredList.value.map((t) => [t.id, t.name, t.slug, t.article_count || 0])
    ];
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `tags-${new Date().toISOString().slice(0, 10)}.csv`);
    ElMessage.success('标签列表已导出');
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.tag-manage {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
}

.create-card {
  padding: 20px 24px;
}

.create-row {
  display: flex;
  gap: 12px;
}

.create-input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 9px 14px;
  font-size: 0.92rem;
  color: var(--text);
  background: var(--bg);
  outline: none;
  transition: border-color var(--dur) var(--ease);
}

.create-input:focus {
  border-color: var(--accent);
}

.create-btn {
  padding: 9px 24px;
  border-radius: var(--radius-sm);
  background: var(--accent-fill);
  color: #fff;
  font-size: 0.9rem;
  font-weight: 600;
  transition: all var(--dur) var(--ease);
}

.create-btn:hover:not(:disabled) {
  opacity: 0.88;
}

.create-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.filter-row {
  margin-top: 12px;
  display: flex;
}

.table-card {
  padding: 8px 16px 16px;
}

.tag-name {
  font-weight: 600;
  color: var(--accent-text);
}

.count-badge {
  font-size: 0.85rem;
  font-weight: 650;
  color: var(--text-2);
  background: var(--bg-soft);
  padding: 2px 12px;
  border-radius: 999px;
}
</style>
