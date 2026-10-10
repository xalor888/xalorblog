<template>
  <div class="note-manage">
    <div class="card toolbar">
      <div class="toolbar-row">
        <el-input
          v-model="query.keyword"
          placeholder="搜索手记内容…"
          size="default"
          clearable
          style="max-width: 260px"
          @keyup.enter="reload"
          @clear="reload"
        />
        <el-select v-model="query.status" style="width: 130px" @change="reload">
          <el-option label="全部状态" value="all" />
          <el-option label="已发布" value="published" />
          <el-option label="草稿" value="draft" />
        </el-select>
        <el-select v-model="query.sort" style="width: 150px" @change="reload">
          <el-option label="最新在前" value="latest" />
          <el-option label="最早在前" value="oldest" />
        </el-select>
        <div class="toolbar-spacer"></div>
        <router-link :to="adminHref('notes/new')">
          <el-button type="primary"><XIcon name="SquarePen" :size="14" /> 写手记</el-button>
        </router-link>
      </div>

      <div v-if="selection.length" class="batch-row">
        <span class="batch-count">已选 {{ selection.length }} 条</span>
        <el-button size="small" @click="batch('publish')">发布</el-button>
        <el-button size="small" @click="batch('draft')">转草稿</el-button>
        <el-button size="small" @click="batch('pin')">置顶</el-button>
        <el-button size="small" @click="batch('unpin')">取消置顶</el-button>
        <el-button size="small" type="danger" plain @click="batchDelete">删除</el-button>
      </div>
    </div>

    <div class="card table-card">
      <el-table
        :data="list"
        v-loading="loading"
        stripe
        @selection-change="(rows) => (selection = rows)"
      >
        <el-table-column type="selection" width="44" />
        <el-table-column label="内容" min-width="260">
          <template #default="{ row }">
            <div class="content-cell">
              <span v-if="row.is_pinned" class="pin-tag" title="置顶"><XIcon name="Pin" :size="12" /></span>
              <span class="excerpt">{{ row.excerpt || '（无内容）' }}</span>
              <span v-if="row.image_count" class="img-tag"><XIcon name="Image" :size="11" />{{ row.image_count }}</span>
            </div>
            <div v-if="row.mood || row.location" class="sub-line">
              <span v-if="row.mood">{{ row.mood }}</span>
              <span v-if="row.location">{{ row.location }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'published' ? 'success' : 'info'" effect="plain">
              {{ row.status === 'published' ? '已发布' : '草稿' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="点赞" prop="likes" width="80" align="center" v-if="!isMobile" />
        <el-table-column label="时间" width="160" v-if="!isMobile">
          <template #default="{ row }">{{ formatDateTime(row.published_at || row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" :width="isMobile ? 110 : 170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" :disabled="busyId === row.id" @click="togglePin(row)">
              {{ row.is_pinned ? '取消置顶' : '置顶' }}
            </el-button>
            <el-button size="small" link type="primary" @click="edit(row)">编辑</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          layout="prev, pager, next, total"
          :total="pagination.total"
          :page-size="pagination.pageSize"
          :current-page="pagination.page"
          @current-change="changePage"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { noteApi } from '@/api';
import { adminHref } from '@/utils/adminPath';
import { formatDateTime } from '@/utils/format';
import { useIsMobile } from '@/composables/useMedia';

const router = useRouter();
const isMobile = useIsMobile();

const list = ref([]);
const loading = ref(false);
const selection = ref([]);
const busyId = ref(null);
const query = reactive({ keyword: '', status: 'all', sort: 'latest' });
const pagination = reactive({ page: 1, pageSize: 10, total: 0 });

async function load() {
  loading.value = true;
  try {
    const data = await noteApi.adminList({
      page: pagination.page,
      pageSize: pagination.pageSize,
      keyword: query.keyword.trim() || undefined,
      status: query.status,
      sort: query.sort,
    });
    list.value = data?.list || [];
    Object.assign(pagination, { total: data?.pagination?.total || 0 });
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    loading.value = false;
  }
}

function reload() {
  pagination.page = 1;
  load();
}

function changePage(p) {
  pagination.page = p;
  load();
}

function edit(row) {
  router.push(adminHref(`notes/${row.id}/edit`));
}

async function togglePin(row) {
  busyId.value = row.id;
  try {
    await noteApi.batchUpdate([row.id], row.is_pinned ? 'unpin' : 'pin');
    row.is_pinned = !row.is_pinned;
    ElMessage.success(row.is_pinned ? '已置顶' : '已取消置顶');
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    busyId.value = null;
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('删除后不可恢复，确定删除这条手记？', '删除确认', { type: 'warning' });
  } catch (e) {
    return;
  }
  try {
    await noteApi.remove(row.id);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

async function batch(action) {
  const ids = selection.value.map((r) => r.id);
  if (!ids.length) return;
  try {
    await noteApi.batchUpdate(ids, action);
    ElMessage.success('操作完成');
    selection.value = []; // 见 batchDelete 的说明
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

async function batchDelete() {
  const ids = selection.value.map((r) => r.id);
  if (!ids.length) return;
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${ids.length} 条手记？`, '批量删除', { type: 'warning' });
  } catch (e) {
    return;
  }
  try {
    await noteApi.batchDelete(ids);
    ElMessage.success('已删除');
    // 必须清空选择：load() 会用全新行对象替换列表，旧 selection 变成悬空引用，
    // 不清的话「已选 N 条」常驻，再点删除会拿旧 id 重复提交
    selection.value = [];
    load();
  } catch (e) {
    /* 拦截器已提示 */
  }
}

onMounted(load);
</script>

<style scoped>
.note-manage { display: flex; flex-direction: column; gap: 14px; }
.toolbar { padding: 14px 16px; }
.toolbar-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.toolbar-spacer { flex: 1; }
.batch-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.batch-count { font-size: 13px; color: var(--text-2); margin-right: 4px; }
.table-card { padding: 6px 6px 12px; }
.content-cell { display: flex; align-items: center; gap: 6px; }
.excerpt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.pin-tag { color: var(--accent); display: inline-flex; flex-shrink: 0; }
.img-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-soft);
  color: var(--text-3);
  font-size: 11px;
  flex-shrink: 0;
}
.sub-line {
  display: flex;
  gap: 10px;
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
  /* 心情/地点是自由文本（上限 40/80 字）：不带空格的长串会顶出单元格，
     与上面的摘要行一样做单行截断，而不是让它溢出/换行把行高撑乱 */
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.pager { display: flex; justify-content: flex-end; padding: 12px 10px 2px; }
</style>
