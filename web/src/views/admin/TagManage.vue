<template>
  <div class="tag-manage">
    <!-- 新建标签 -->
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
    </div>

    <!-- 标签列表 -->
    <div class="table-card card">
      <el-table :data="list" v-loading="loading && !list.length" stripe>
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
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { tagApi } from '@/api';

const list = ref([]);
const loading = ref(false);
const creating = ref(false);
const newName = ref('');

async function load() {
  loading.value = true;
  try {
    list.value = await tagApi.list();
  } finally {
    loading.value = false;
  }
}

async function create() {
  const name = newName.value.trim();
  if (!name) return;
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
    await ElMessageBox.confirm(
      `确定删除标签「${row.name}」吗？文章的标签关联将同步移除。`,
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
    const targetName = value.trim();
    const target = list.value.find((t) => t.id !== row.id && t.name === targetName);
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
  background: var(--accent);
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

.table-card {
  padding: 8px 16px 16px;
}

.tag-name {
  font-weight: 600;
  color: var(--accent);
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
