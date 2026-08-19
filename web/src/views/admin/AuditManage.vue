<template>
  <div class="audit-manage">
    <!-- 工具栏 -->
    <div class="toolbar card">
      <div class="toolbar-left">
        <el-input
          v-model="keyword"
          placeholder="搜索操作者 / 操作 / 详情 / IP…"
          clearable
          :prefix-icon="Search"
          class="search-input"
          @keyup.enter="load(1)"
          @clear="load(1)"
        />
        <el-button @click="load(1)">搜索</el-button>
      </div>
      <div class="toolbar-right">
        <span class="hint">日志保留 90 天，超出自动清理</span>
        <el-button plain :loading="exporting" @click="exportCsv">
          <XIcon name="Download" :size="14" /> 导出 CSV
        </el-button>
        <el-button type="danger" plain :loading="clearing" @click="clearLogs">清空日志</el-button>
      </div>
    </div>

    <!-- 日志表格 -->
    <div class="table-card card">
      <el-table :data="list" v-loading="loading && !list.length" stripe>
        <el-table-column prop="id" label="ID" width="70" align="center" />
        <el-table-column label="操作者" width="140">
          <template #default="{ row }">
            <span class="op-user">{{ row.username || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="260">
          <template #default="{ row }">
            <span class="op-method" :class="methodClass(row.action)">{{ row.action.split(' ')[0] }}</span>
            <span class="op-path">{{ row.action.replace(/^\w+\s/, '') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.detail || '—' }}</template>
        </el-table-column>
        <el-table-column prop="ip" label="IP" width="130" show-overflow-tooltip />
        <el-table-column label="设备指纹" width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="muted">{{ row.fp ? row.fp.slice(0, 16) + '…' : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
        </el-table-column>
      </el-table>

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
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { auditApi } from '@/api';
import { formatDateTime } from '@/utils/format';
import { getCachedAdminPath } from '@/utils/adminPath';
import { getTicket, ensurePass } from '@/utils/pass';
import { getFingerprint } from '@/utils/fingerprint';
import { getAuthToken } from '@/utils/authSession';

const list = ref([]);
const loading = ref(false);
const clearing = ref(false);
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const keyword = ref('');

async function load(p = page.value) {
  loading.value = true;
  try {
    const res = await auditApi.list({
      page: p,
      pageSize,
      keyword: keyword.value.trim() || undefined,
    });
    list.value = res.list;
    total.value = res.pagination.total;
    page.value = p;
  } finally {
    loading.value = false;
  }
}

/** 方法着色：GET=绿 / POST=蓝 / PUT=橙 / DELETE=红 */
function methodClass(action) {
  const m = String(action || '').split(' ')[0];
  return {
    get: m === 'GET',
    post: m === 'POST',
    put: m === 'PUT',
    del: m === 'DELETE',
  }[m.toLowerCase()] || '';
}

async function clearLogs() {
  try {
    await ElMessageBox.confirm(
      '确定清空全部审计日志吗？此操作不可恢复，且清空动作本身也会被记录。',
      '清空审计日志',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' }
    );
  } catch (e) {
    return;
  }
  clearing.value = true;
  try {
    await auditApi.clear();
    ElMessage.success('审计日志已清空');
    load(1);
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    clearing.value = false;
  }
}

/** 导出审计 CSV：原生 fetch 下载（尊重当前关键词筛选） */
const exporting = ref(false);
async function exportCsv() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await ensurePass();
    const key = getCachedAdminPath();
    const params = new URLSearchParams();
    if (keyword.value.trim()) params.set('keyword', keyword.value.trim());
    const qs = params.toString();
    const resp = await fetch(`/api/${key}/audit/export${qs ? `?${qs}` : ''}`, {
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
    a.download = m ? m[1] : 'audit.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    ElMessage.error('导出失败，请重试');
  } finally {
    exporting.value = false;
  }
}

onMounted(() => load());
</script>

<style scoped>
.audit-manage {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
}

.toolbar-left {
  display: flex;
  gap: 10px;
  flex: 1;
}

.search-input {
  max-width: 320px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.hint {
  font-size: 0.78rem;
  color: var(--text-3);
}

.op-user {
  font-weight: 600;
}

.op-method {
  display: inline-block;
  min-width: 46px;
  text-align: center;
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 0.74rem;
  font-weight: 700;
  margin-right: 8px;
}

.op-method.get {
  background: color-mix(in srgb, #217a5e 14%, transparent);
  color: #217a5e;
}

.op-method.post {
  background: color-mix(in srgb, #2f6fb3 14%, transparent);
  color: #2f6fb3;
}

.op-method.put {
  background: color-mix(in srgb, #c9900f 14%, transparent);
  color: #c9900f;
}

.op-method.del {
  background: color-mix(in srgb, #c24b5e 14%, transparent);
  color: #c24b5e;
}

.op-path {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.82rem;
}

.muted {
  color: var(--text-3);
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  padding: 14px 16px;
}
</style>
