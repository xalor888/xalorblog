<template>
  <div class="message-manage">
    <!-- 筛选 -->
    <div class="toolbar card">
      <el-radio-group v-model="status" @change="load">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="pending">待审核</el-radio-button>
        <el-radio-button value="approved">已通过</el-radio-button>
        <el-radio-button value="rejected">已拒绝</el-radio-button>
      </el-radio-group>
      <el-checkbox v-model="aiOnly" class="ai-filter" @change="load">仅看 AI 标记</el-checkbox>
      <el-button size="small" plain :loading="exporting" @click="exportCsv">
        <XIcon name="Download" :size="13" /> 导出 CSV
      </el-button>
      <el-button size="small" type="success" plain :loading="approving" @click="approveAll">
        <XIcon name="Check" :size="13" /> 全部通过
      </el-button>
    </div>

    <!-- 列表 -->
    <div class="table-card card">
      <el-table :data="list" v-loading="loading && !list.length" stripe @selection-change="onSelectionChange">
        <el-table-column type="selection" width="44" />
        <el-table-column label="昵称" width="130">
          <template #default="{ row }">
            <div class="user-cell">
              <span class="user-avatar">{{ (row.nickname || '?').charAt(0).toUpperCase() }}</span>
              <span>{{ row.nickname }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="content" label="留言内容" min-width="300" show-overflow-tooltip />
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="AI 标记" width="150">
          <template #default="{ row }">
            <el-tooltip v-if="row.ai_reason" :content="`AI 审核原因：${row.ai_reason}`" placement="top">
              <el-tag type="warning" size="small" effect="light" class="ai-tag">
                <XIcon name="Sparkles" :size="12" /> {{ row.ai_reason.slice(0, 10) }}{{ row.ai_reason.length > 10 ? '…' : '' }}
              </el-tag>
            </el-tooltip>
            <span v-else class="ai-none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="IP" width="130">
          <template #default="{ row }">
            <span class="ip-mono">{{ row.ip || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status !== 'approved'" size="small" link type="success" @click="setStatus(row, 'approved')">通过</el-button>
            <el-button v-if="row.status !== 'rejected'" size="small" link type="warning" @click="setStatus(row, 'rejected')">拒绝</el-button>
            <el-button v-if="row.status === 'rejected'" size="small" link :loading="reAiId === row.id" @click="reAi(row)">AI 复核</el-button>
            <el-button size="small" link type="primary" :title="row.reply ? '修改回复' : '回复留言'" @click="openReply(row)">
              {{ row.reply ? '编辑回复' : '回复' }}
            </el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 批量操作 -->
      <div v-if="selection.length" class="batch-bar">
        <span class="batch-count">已选 {{ selection.length }} 条</span>
        <el-button size="small" type="success" :loading="batchLoading" @click="batchSetStatus('approved')">批量通过</el-button>
        <el-button size="small" type="warning" :loading="batchLoading" @click="batchSetStatus('rejected')">批量拒绝</el-button>
        <el-button size="small" plain :loading="batchLoading" @click="batchReAi">批量 AI 复核</el-button>
        <el-button size="small" type="danger" plain :loading="batchLoading" @click="batchRemove">批量删除</el-button>
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

    <!-- 站长回复弹窗 -->
    <el-dialog v-model="replyDialog" title="回复留言" width="520" :close-on-click-modal="false">
      <p class="reply-tip">回复内容将公开展示在留言下方，同时该留言自动通过审核。</p>
      <el-input
        v-model="replyForm.content"
        type="textarea"
        :rows="5"
        maxlength="2000"
        show-word-limit
        placeholder="写下你的回复…"
      />
      <template #footer>
        <el-button @click="replyDialog = false">取消</el-button>
        <el-button type="primary" :loading="replying" @click="submitReply">发布回复</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { messageApi } from '@/api';
import { useAdminStore } from '@/stores/admin';
import { getCachedAdminPath } from '@/utils/adminPath';
import { ensurePass } from '@/utils/pass';
import { signedFetch } from '@/utils/signedFetch';
import { formatDateTime } from '@/utils/format';

const adminStore = useAdminStore();

const list = ref([]);
const loading = ref(false);
const status = ref('all');
const aiOnly = ref(false);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

function statusText(s) {
  return { pending: '待审核', approved: '已通过', rejected: '已拒绝' }[s] || s;
}

function statusType(s) {
  return { pending: 'warning', approved: 'success', rejected: 'danger' }[s] || 'info';
}

async function load(p = page.value) {
  loading.value = true;
  try {
    const res = await messageApi.adminList({
      page: p,
      pageSize,
      status: status.value,
      ai_only: aiOnly.value ? '1' : undefined,
    });
    list.value = res.list;
    total.value = res.pagination.total;
    page.value = p;
  } finally {
    loading.value = false;
  }
}

async function setStatus(row, s) {
  try {
    await messageApi.updateStatus(row.id, s);
    ElMessage.success('状态已更新');
    adminStore.fetchPending(); // 侧栏待审徽章即时刷新
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

/** AI 复核：重跑审核引擎（误拒恢复） */
const reAiId = ref(null);
async function reAi(row) {
  reAiId.value = row.id;
  try {
    const res = await messageApi.reAi(row.id);
    ElMessage.success(res?.message || 'AI 复核完成');
    adminStore.fetchPending();
    load();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    reAiId.value = null;
  }
}

/** 一键全部通过：全部待审留言直接通过（上限 1000 条），确认后执行 */
const approving = ref(false);
async function approveAll() {
  if (approving.value) return;
  try {
    await ElMessageBox.confirm('将全部待审核留言一次性通过（上限 1000 条），确定继续吗？', '全部通过', {
      type: 'warning',
      confirmButtonText: '全部通过',
      cancelButtonText: '取消',
    });
  } catch (e) {
    return; /* 取消 */
  }
  approving.value = true;
  try {
    const res = await messageApi.approveAll();
    if (!res.affected) ElMessage.info('当前没有待审核留言');
    else ElMessage.success(res?.message || '已全部通过');
    adminStore.fetchPending();
    load(1);
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    approving.value = false;
  }
}

/** 导出留言 CSV：原生 fetch 下载（绕过 JSON 拦截器；尊重当前筛选） */
const exporting = ref(false);
async function exportCsv() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await ensurePass();
    const key = getCachedAdminPath();
    const params = new URLSearchParams();
    if (status.value !== 'all') params.set('status', status.value);
    if (aiOnly.value) params.set('ai_only', '1');
    const qs = params.toString();
    const resp = await signedFetch(`/api/${key}/messages/admin/export${qs ? `?${qs}` : ''}`);
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
    a.download = m ? m[1] : 'messages.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    ElMessage.error('导出失败，请重试');
  } finally {
    exporting.value = false;
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('确定删除这条留言吗？', '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await messageApi.remove(row.id);
    ElMessage.success('删除成功');
    load();
  } catch (e) {
    /* 取消 */
  }
}

// ---------- 站长回复 ----------
const replyDialog = ref(false);
const replyForm = ref({ id: null, content: '' });

function openReply(row) {
  replyForm.value = { id: row.id, content: row.reply || '' };
  replyDialog.value = true;
}

const replying = ref(false);
async function submitReply() {
  if (!replyForm.value.content.trim()) {
    ElMessage.warning('请输入回复内容');
    return;
  }
  replying.value = true;
  try {
    await messageApi.reply(replyForm.value.id, replyForm.value.content.trim());
    ElMessage.success('回复已发布');
    replyDialog.value = false;
    load();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    replying.value = false;
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
    await Promise.all(selection.value.map((row) => messageApi.updateStatus(row.id, s)));
    ElMessage.success(`已${s === 'approved' ? '通过' : '拒绝'} ${selection.value.length} 条留言`);
    selection.value = [];
    load();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    batchLoading.value = false;
  }
}

/** 批量 AI 复核：对选中留言逐条重跑审核引擎（误拒批量恢复） */
async function batchReAi() {
  batchLoading.value = true;
  try {
    await Promise.all(selection.value.map((row) => messageApi.reAi(row.id)));
    ElMessage.success(`已复核 ${selection.value.length} 条留言`);
    adminStore.fetchPending();
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
    await ElMessageBox.confirm(`确定删除选中的 ${selection.value.length} 条留言吗？`, '批量删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await messageApi.batchDelete(selection.value.map((r) => r.id));
    ElMessage.success(`已删除 ${selection.value.length} 条留言`);
    // 当前页被删空后回退一页
    if (list.value.length === selection.value.length && page.value > 1) page.value -= 1;
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
.message-manage {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  padding: 14px 20px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

/* 批量操作栏 */
.pagination-wrap {
  display: flex;
  justify-content: center;
  padding-top: 14px;
}

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

.ip-mono {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-2);
}

.user-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), #ec4899);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  font-weight: 700;
  flex-shrink: 0;
}

.reply-tip {
  font-size: 0.8rem;
  color: var(--text-3);
  margin: -4px 0 12px;
}
</style>
