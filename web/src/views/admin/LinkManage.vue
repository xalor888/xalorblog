<template>
  <div class="link-manage">
    <!-- 筛选 -->
    <div class="toolbar card">
      <el-radio-group v-model="status" @change="load">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="pending">待审核</el-radio-button>
        <el-radio-button value="approved">已通过</el-radio-button>
        <el-radio-button value="rejected">已拒绝</el-radio-button>
      </el-radio-group>
      <el-button size="small" type="success" plain :loading="approving" @click="approveAll">
        <XIcon name="Check" :size="13" /> 全部通过
      </el-button>
    </div>

    <!-- 列表 -->
    <div class="table-card card">
      <el-table :data="list" v-loading="loading && !list.length" stripe @selection-change="onSelectionChange">
        <el-table-column type="selection" width="44" />
        <el-table-column label="网站" min-width="200">
          <template #default="{ row }">
            <div class="site-cell">
              <div class="site-avatar">
                <img v-if="row.avatar" :src="row.avatar" alt="" />
                <span v-else>{{ (row.name || '?').charAt(0).toUpperCase() }}</span>
              </div>
              <div class="site-info">
                <a :href="row.url" target="_blank" rel="noopener" class="site-name">{{ row.name }}</a>
                <span class="site-url">{{ row.url }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="介绍" min-width="180" show-overflow-tooltip />
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="排序" width="80" align="center">
          <template #default="{ row }">
            <el-input-number v-model="row.sort" :min="0" :max="100" size="small" controls-position="right"
              @change="(v) => updateSort(row, v)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'pending'" size="small" link type="success" @click="setStatus(row, 'approved')">通过</el-button>
            <el-button v-if="row.status !== 'rejected'" size="small" link type="warning" @click="setStatus(row, 'rejected')">拒绝</el-button>
            <el-button v-if="row.status === 'rejected' || row.status === 'approved'" size="small" link type="primary" @click="setStatus(row, 'pending')">改待审</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 批量操作 -->
      <div v-if="selection.length" class="batch-bar">
        <span class="batch-count">已选 {{ selection.length }} 条</span>
        <el-button size="small" type="success" :loading="batchLoading" @click="batchSetStatus('approved')">批量通过</el-button>
        <el-button size="small" type="warning" :loading="batchLoading" @click="batchSetStatus('rejected')">批量拒绝</el-button>
        <el-button size="small" type="danger" plain :loading="batchLoading" @click="batchRemove">批量删除</el-button>
        <el-button size="small" link @click="selection = []">取消选择</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { linkApi } from '@/api';
import { useAdminStore } from '@/stores/admin';

const adminStore = useAdminStore();

const list = ref([]);
const loading = ref(false);
const status = ref('all');

function statusText(s) {
  return { pending: '待审核', approved: '已通过', rejected: '已拒绝' }[s] || s;
}

function statusType(s) {
  return { pending: 'warning', approved: 'success', rejected: 'danger' }[s] || 'info';
}

async function load() {
  loading.value = true;
  try {
    list.value = await linkApi.adminList({ status: status.value });
  } finally {
    loading.value = false;
  }
}

async function setStatus(row, s) {
  try {
    await linkApi.updateStatus(row.id, { status: s });
    ElMessage.success('状态已更新');
    adminStore.fetchPending(); // 侧栏待审徽章即时刷新
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

async function updateSort(row, sort) {
  try {
    await linkApi.updateStatus(row.id, { status: row.status, sort });
    ElMessage.success('排序已更新');
  } catch (e) {
    load();
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除友链「${row.name}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await linkApi.remove(row.id);
    ElMessage.success('删除成功');
    load();
  } catch (e) {
    /* 取消 */
  }
}

/** 一键全部通过：全部待审友链直接通过（上限 1000），确认后执行 */
const approving = ref(false);
async function approveAll() {
  if (approving.value) return;
  try {
    await ElMessageBox.confirm('将全部待审核友链一次性通过（上限 1000 条），确定继续吗？', '全部通过', {
      type: 'warning',
      confirmButtonText: '全部通过',
      cancelButtonText: '取消',
    });
  } catch (e) {
    return; /* 取消 */
  }
  approving.value = true;
  try {
    const res = await linkApi.approveAll();
    if (!res.affected) ElMessage.info('当前没有待审核友链');
    else ElMessage.success(res?.message || '已全部通过');
    adminStore.fetchPending();
    load();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    approving.value = false;
  }
}

// ---------- 批量操作 ----------
const selection = ref([]);
const batchLoading = ref(false);

function onSelectionChange(rows) {
  selection.value = rows;
}

async function batchSetStatus(s) {
  batchLoading.value = true;
  try {
    await Promise.all(selection.value.map((row) => linkApi.updateStatus(row.id, { status: s })));
    ElMessage.success(`已${s === 'approved' ? '通过' : '拒绝'} ${selection.value.length} 条友链`);
    selection.value = [];
    load();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    batchLoading.value = false;
  }
}

async function batchRemove() {
  batchLoading.value = true;
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${selection.value.length} 条友链吗？`, '批量删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await linkApi.batchDelete(selection.value.map((r) => r.id));
    ElMessage.success(`已删除 ${selection.value.length} 条友链`);
    selection.value = [];
    load();
  } catch (e) {
    /* 取消 */
  } finally {
    batchLoading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.link-manage {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  padding: 14px 20px;
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

.table-card {
  padding: 8px 16px 16px;
}

.site-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.site-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(135deg, var(--accent), #ec4899);
  color: #fff;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.site-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.site-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.site-name {
  font-weight: 600;
  transition: color 0.2s;
}

.site-name:hover {
  color: var(--accent);
}

.site-url {
  font-size: 0.78rem;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
</style>
