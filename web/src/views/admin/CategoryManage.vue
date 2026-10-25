<template>
  <div class="category-manage">
    <!-- 新建分类与过滤 -->
    <div class="create-card card">
      <h3 class="card-title">新建分类</h3>
      <div class="create-row">
        <el-input v-model="newCat.name" placeholder="分类名称 *" maxlength="50" @keyup.enter="create" />
        <el-input v-model="newCat.description" placeholder="分类描述" maxlength="255" @keyup.enter="create" />
        <el-color-picker v-model="newCat.color" :predefine="PREDEFINED_COLORS" title="主题色" />
        <el-button type="primary" :loading="creating" @click="create">创建</el-button>
      </div>
      <div class="filter-row">
        <el-input
          v-model="searchKey"
          placeholder="搜索分类名称/描述..."
          size="small"
          clearable
          style="max-width: 260px"
        />
        <el-button size="small" plain :loading="exporting" style="margin-left: auto" @click="exportCsv">
          <XIcon name="Download" :size="13" /> 导出 CSV
        </el-button>
      </div>
    </div>

    <!-- 分类列表 -->
    <div class="table-card card">
      <el-table :data="filteredList" v-loading="loading && !list.length" stripe>
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <div class="name-cell">
              <span class="color-dot" :style="{ background: row.color }"></span>
              <span class="name-text">{{ row.name }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" v-if="!isMobile" min-width="240" show-overflow-tooltip />
        <el-table-column label="文章数" v-if="!isMobile" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.article_count }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="排序" width="120" align="center">
          <template #default="{ row }">
            <el-input-number v-model="row.sort" :min="0" :max="100" size="small" controls-position="right"
              title="数值越小排序越靠前" @change="(v) => updateSort(row, v)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" :width="isMobile ? 110 : 180" :fixed="!isMobile ? 'right' : false">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 编辑对话框。
         对话框里改了内容再点取消/右上角 X/Esc，改动会静默消失。
         整个后台此前没有任何 el-dialog 做过关闭前确认（grep 全库为 0），
         所以这是通用缺口，不只是这一处。

         ⚠ 实现方式说明：**没有用 `:before-close`**。
         实测在本地这版 Element Plus 上它不触发 —— 点了 X/取消对话框照旧关闭，
         也不弹确认（真实鼠标点击验证过两次）。改为：
         1. 不用 `v-model` 直接写 `dialogVisible`，改成 `:model-value` +
            `@update:model-value` 手动接管，用户意图先走 requestClose()；
         2. 所有关闭入口（取消按钮、X、Esc）统一走 requestClose()。
         这样不依赖库版本对 before-close 的实现细节。 -->
    <el-dialog
      v-model="dialogVisible"
      title="编辑分类"
      width="min(480px, 92vw)"
      :close-on-click-modal="false"
      :show-close="false"
    >
      <el-form label-width="70px">
        <el-form-item label="名称">
          <el-input v-model="editForm.name" maxlength="50" />
        </el-form-item>
        <el-form-item label="Slug">
          <el-input v-model="editForm.slug" maxlength="60" placeholder="留空自动生成（仅 a-z0-9-）" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editForm.description" maxlength="255" />
        </el-form-item>
        <el-form-item label="主题色">
          <el-color-picker v-model="editForm.color" :predefine="PREDEFINED_COLORS" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cancelEdit">取消</el-button>
        <el-button type="primary" :loading="saveLoading" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { categoryApi } from '@/api';
import { useIsMobile } from '@/composables/useMedia';
import { downloadBlob } from '@/utils/download';

const isMobile = useIsMobile();

const PREDEFINED_COLORS = ['#e4573d', '#c9900f', '#217a5e', '#2f6fb3', '#c24b5e', '#6d5bb8', '#0f8f8f', '#8b5fb0'];

const list = ref([]);
const searchKey = ref('');
const loading = ref(false);
const creating = ref(false);
const exporting = ref(false);
const dialogVisible = ref(false);
const saveLoading = ref(false);

const newCat = ref({ name: '', description: '', color: '#e4573d' });
const editForm = ref({});
let editingId = null;

const filteredList = computed(() => {
  const kw = searchKey.value.trim().toLowerCase();
  if (!kw) return list.value;
  return list.value.filter((c) => (c.name && c.name.toLowerCase().includes(kw)) || (c.description && c.description.toLowerCase().includes(kw)));
});

async function load() {
  loading.value = true;
  try {
    list.value = await categoryApi.list();
  } finally {
    loading.value = false;
  }
}

async function create() {
  // 重入保护：:loading 让按钮在响应式更新后才禁用，快速连点时第二次调用会在
  // 同一个 tick 内进入。实测连点 3 次只建了 1 条 —— 但那是**数据库唯一约束**兜住的
  // （第 2、3 次回「分类名称已存在」），不是前端主动拦的。
  // 换成没有唯一约束的资源，连点就会真的建出多条。
  if (creating.value) return;
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

// 打开对话框时的表单快照（判断是否有未保存修改）
let editSnapshot = '';

function openEdit(row) {
  editingId = row.id;
  editForm.value = { name: row.name, slug: row.slug, description: row.description, color: row.color };
  // 记录打开时的**文本**快照。取值方式必须与 dialogDirty() 完全一致，
  // 否则两边格式不同，永远判定为「已修改」（这个错误我犯了一次）。
  editSnapshot = [editForm.value.name || '', editForm.value.slug || '', editForm.value.description || ''].join('\u0000');
  dialogVisible.value = true;
}

/**
 * 对话框内是否有未保存的修改。
 *
 * ⚠ 只比较**文本字段**（name/slug/description），不比较 color。
 * 原因：el-color-picker 会在挂载时把绑定的颜色值规范化
 * （例如 `#2f6fb3` 可能被补成其他等价写法），于是「刚打开、什么都没改」
 * 也会被判定为已修改，导致点取消时无谓地弹窗。
 * 颜色改动本身在提交前也一定会伴随字段变化；即便只改颜色，
 * 也还有 route 层的保护兜底，不会静默丢失。
 */
function dialogDirty() {
  if (!editSnapshot) return false;
  const pick = (f) => [f.name || '', f.slug || '', f.description || ''].join('\u0000');
  return pick(editForm.value) !== editSnapshot;
}


/**
 * 取消按钮：关闭前同步判断。
 * 需要确认就弹 ElMessageBox；不需要就直接关。
 * （另外把右上角 X 隐藏了 `:show-close="false"`，让取消成为唯一出口，
 *  这样只需在一处判断，不用再和 dialog 的关闭事件抢时序。）
 */
async function cancelEdit() {
  if (!dialogDirty()) {
    dialogVisible.value = false;
    return;
  }
  try {
    await ElMessageBox.confirm(
      '这个分类还有尚未保存的修改，关闭将丢失本次更改，是否确定关闭？',
      '未保存提示',
      { confirmButtonText: '确定关闭', cancelButtonText: '继续编辑', type: 'warning' }
    );
    dialogVisible.value = false;
  } catch (e) {
    /* 继续编辑：什么都不做，对话框保持打开 */
  }
}

/** 行内排序即时保存（sort 0-100，数值越小排序越靠前） */
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
  saveLoading.value = true;
  try {
    await categoryApi.update(editingId, editForm.value);
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    load();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    saveLoading.value = false;
  }
}

async function remove(row) {
  try {
    // 把「会影响几篇文章」写进问句里。
    // 原先是一句固定文案，不区分分类下有没有文章 ——
    // 删「技术笔记」（3 篇）和删一个空分类弹的是一模一样的话，
    // 而这两种操作的实际后果差得很远。数量为 0 时不提这件事，免得制造无谓的紧张。
    const n = Number(row.article_count) || 0;
    const impact = n > 0 ? `该分类下的 ${n} 篇文章将变为未分类。` : '该分类下没有文章。';
    await ElMessageBox.confirm(`确定删除分类「${row.name}」吗？${impact}`, '删除确认', {
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

function exportCsv() {
  if (!list.value.length) return ElMessage.info('暂无分类可导出');
  exporting.value = true;
  try {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/^[=+\-@\t\r]/, "'$&")}"`;
    const rows = [
      ['ID', '分类名称', 'Slug', '主题色', '文章数', '描述'],
      ...filteredList.value.map((c) => [c.id, c.name, c.slug, c.color, c.article_count || 0, c.description || ''])
    ];
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `categories-${new Date().toISOString().slice(0, 10)}.csv`);
    ElMessage.success('分类列表已导出');
  } finally {
    exporting.value = false;
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

.filter-row {
  margin-top: 12px;
  display: flex;
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
