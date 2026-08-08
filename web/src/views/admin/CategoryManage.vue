<template>
  <div class="category-manage">
    <!-- 新建分类 -->
    <div class="create-card card">
      <h3 class="card-title">新建分类</h3>
      <div class="create-row">
        <el-input v-model="newCat.name" placeholder="分类名称 *" maxlength="50" />
        <el-input v-model="newCat.description" placeholder="一句话描述" maxlength="255" />
        <el-color-picker v-model="newCat.color" :predefine="PREDEFINED_COLORS" title="主题色" />
        <el-button type="primary" :loading="creating" @click="create">创建</el-button>
      </div>
    </div>

    <!-- 分类列表 -->
    <div class="table-card card">
      <el-table :data="list" v-loading="loading && !list.length" stripe>
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <div class="name-cell">
              <span class="color-dot" :style="{ background: row.color }"></span>
              <span class="name-text">{{ row.name }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="240" show-overflow-tooltip />
        <el-table-column label="文章数" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.article_count }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="排序" width="120" align="center">
          <template #default="{ row }">
            <el-input-number v-model="row.sort" :min="0" :max="100" size="small" controls-position="right"
              title="越小越靠前（前台展示顺序）" @change="(v) => updateSort(row, v)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 编辑对话框 -->
    <el-dialog v-model="dialogVisible" title="编辑分类" width="min(480px, 92vw)">
      <el-form label-width="70px">
        <el-form-item label="名称">
          <el-input v-model="editForm.name" maxlength="50" />
        </el-form-item>
        <el-form-item label="Slug">
          <el-input v-model="editForm.slug" maxlength="60" placeholder="留空自动生成（仅 a-z0-9-）" />
          <span class="field-tip">用于前台筛选链接 #/articles?category=slug</span>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editForm.description" maxlength="255" />
        </el-form-item>
        <el-form-item label="主题色">
          <el-color-picker v-model="editForm.color" :predefine="PREDEFINED_COLORS" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { categoryApi } from '@/api';

const PREDEFINED_COLORS = ['#e4573d', '#c9900f', '#217a5e', '#2f6fb3', '#c24b5e', '#6d5bb8', '#0f8f8f', '#8b5fb0'];

const list = ref([]);
const loading = ref(false);
const creating = ref(false);
const dialogVisible = ref(false);

const newCat = ref({ name: '', description: '', color: '#e4573d' });
const editForm = ref({});
let editingId = null;

async function load() {
  loading.value = true;
  try {
    list.value = await categoryApi.list();
  } finally {
    loading.value = false;
  }
}

async function create() {
  if (!newCat.value.name.trim()) return ElMessage.warning('请输入分类名称');
  creating.value = true;
  try {
    await categoryApi.create(newCat.value);
    ElMessage.success('分类创建成功');
    newCat.value = { name: '', description: '', color: '#e4573d' };
    load();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    creating.value = false;
  }
}

function openEdit(row) {
  editingId = row.id;
  editForm.value = { name: row.name, slug: row.slug, description: row.description, color: row.color };
  dialogVisible.value = true;
}

/** 行内排序即时保存（sort 0-100，越小越靠前） */
async function updateSort(row, sort) {
  if (sort == null) return;
  try {
    await categoryApi.update(row.id, { sort });
    ElMessage.success('排序已更新');
  } catch (e) {
    load();
  }
}

async function saveEdit() {
  try {
    await categoryApi.update(editingId, editForm.value);
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除分类「${row.name}」吗？该分类下的文章将变为未分类。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await categoryApi.remove(row.id);
    ElMessage.success('删除成功');
    load();
  } catch (e) {
    /* 取消 */
  }
}

onMounted(load);
</script>

<style scoped>
.category-manage {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.create-card {
  padding: 20px 24px;
}

.card-title {
  font-size: 1.05rem;
  font-weight: 700;
  margin-bottom: 16px;
}

.create-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.table-card {
  padding: 8px 16px 16px;
}

.name-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.color-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex-shrink: 0;
}

.name-text {
  font-weight: 600;
}

.field-tip {
  font-size: 0.76rem;
  color: var(--text-3);
  line-height: 1.6;
}

@media (max-width: 640px) {
  .create-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
