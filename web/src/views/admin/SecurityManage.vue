<template>
  <div class="security-manage">
    <!-- 安全状态卡片 -->
    <div class="sec-cards">
      <div class="sec-card">
        <div class="sec-card-icon shield">
          <XIcon name="ShieldCheck" :size="20" />
        </div>
        <div>
          <p class="sc-label">反爬闸门</p>
          <p class="sc-value" :class="{ ok: passValid }">{{ passValid ? '通行证有效' : '票据异常' }}</p>
        </div>
      </div>
      <div class="sec-card">
        <div class="sec-card-icon warn">
          <XIcon name="ShieldAlert" :size="20" />
        </div>
        <div>
          <p class="sc-label">已拦截攻击</p>
          <p class="sc-value">{{ stats.event_total || 0 }} 次</p>
        </div>
      </div>
      <div class="sec-card">
        <div class="sec-card-icon ban">
          <XIcon name="Ban" :size="20" />
        </div>
        <div>
          <p class="sc-label">封禁中的 IP</p>
          <p class="sc-value">{{ (stats.banned || []).length }} 个</p>
        </div>
      </div>
      <div class="sec-card">
        <div class="sec-card-icon key">
          <XIcon name="KeyRound" :size="20" />
        </div>
        <div>
          <p class="sc-label">活跃会话</p>
          <p class="sc-value">{{ sessions.length }} 个</p>
        </div>
      </div>
    </div>

    <!-- 攻击类型分布 -->
    <div v-if="Object.keys(stats.type_counts || {}).length" class="panel">
      <div class="panel-head">
        <h3 class="panel-title"><XIcon name="BarChart3" :size="16" /> 攻击类型分布</h3>
        <span class="panel-hint">全部历史拦截事件</span>
      </div>
      <div class="type-grid">
        <div v-for="(cnt, type) in stats.type_counts" :key="type" class="type-cell" :class="'tc-' + typeClass(type)">
          <span class="tc-label">{{ typeLabel(type) }}</span>
          <span class="tc-count num">{{ cnt }}</span>
        </div>
      </div>
    </div>

    <!-- 攻击事件日志 -->
    <div class="panel">
      <div class="panel-head">
        <h3 class="panel-title"><XIcon name="Activity" :size="16" /> 攻击拦截日志</h3>
        <span class="panel-hint">每 5 秒自动刷新 · 最近 50 条</span>
        <button class="export-btn" title="导出 CSV" @click="exportCsv">
          <XIcon name="Download" :size="14" /> 导出
        </button>
      </div>
      <div v-if="!events.length" class="panel-empty">
        <XIcon name="ShieldCheck" :size="26" />
        <p>暂无攻击记录，安全状态良好</p>
      </div>
      <div v-else class="event-list">
        <div v-for="(e, i) in events" :key="i" class="event-row">
          <span class="event-type" :class="typeClass(e.type)">{{ typeLabel(e.type) }}</span>
          <span class="event-ip num">{{ e.ip }}</span>
          <span class="event-path">{{ e.path }}</span>
          <span class="event-detail">{{ e.detail }}</span>
          <span class="event-time">{{ timeAgo(e.t) }}</span>
        </div>
      </div>
    </div>

    <!-- 封禁列表 -->
    <div class="panel">
      <div class="panel-head">
        <h3 class="panel-title"><XIcon name="Ban" :size="16" /> 封禁中的 IP</h3>
        <span v-if="(stats.banned || []).length" class="panel-hint">封禁期满自动解除</span>
      </div>
      <div v-if="!(stats.banned || []).length" class="panel-empty">
        <XIcon name="Smile" :size="26" />
        <p>当前没有封禁的 IP</p>
      </div>
      <el-table v-else :data="stats.banned" size="small" class="sec-table">
        <el-table-column prop="ip" label="IP 地址" width="140" />
        <el-table-column prop="reason" label="封禁原因" min-width="200" show-overflow-tooltip />
        <el-table-column label="累计违规" width="90">
          <template #default="{ row }">{{ row.strikes }} 次</template>
        </el-table-column>
        <el-table-column label="封禁轮次" width="90">
          <template #default="{ row }">{{ row.banCount }} 轮</template>
        </el-table-column>
        <el-table-column label="剩余时间" width="120">
          <template #default="{ row }">{{ formatRemain(row.remain) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" align="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="unbanIp(row.ip)">解封</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 管理员操作审计 -->
    <div class="panel">
      <div class="panel-head">
        <h3 class="panel-title"><XIcon name="History" :size="16" /> 管理员操作审计</h3>
        <span class="panel-hint">最近 100 条 · 谁在何时做了什么</span>
        <button class="export-btn" title="导出 CSV" @click="exportAuditCsv">
          <XIcon name="Download" :size="14" /> 导出
        </button>
      </div>
      <div v-if="!auditLogs.length" class="panel-empty">
        <XIcon name="FileClock" :size="26" />
        <p>暂无审计记录</p>
      </div>
      <el-table v-else :data="auditLogs" size="small" class="sec-table">
        <el-table-column prop="username" label="操作者" width="100" />
        <el-table-column prop="action" label="操作" min-width="200" />
        <el-table-column prop="detail" label="摘要" min-width="180" show-overflow-tooltip />
        <el-table-column prop="ip" label="IP" width="130" />
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 登录会话 -->
    <div class="panel">
      <div class="panel-head">
        <h3 class="panel-title"><XIcon name="MonitorSmartphone" :size="16" /> 登录会话</h3>
        <div class="panel-actions">
          <span class="panel-hint">令牌绑定设备指纹，跨设备无效</span>
          <el-button v-if="sessions.filter((s) => !s.current).length" size="small" type="danger" plain @click="logoutAll">
            退出其他设备
          </el-button>
        </div>
      </div>
      <div v-if="!sessions.length" class="panel-empty">
        <XIcon name="MonitorOff" :size="26" />
        <p>暂无会话记录</p>
      </div>
      <el-table v-else :data="sessions" size="small" class="sec-table">
        <el-table-column label="设备指纹" min-width="180">
          <template #default="{ row }">
            <span class="fp mono">{{ row.fp || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="IP" width="140">
          <template #default="{ row }">{{ row.ip || '—' }}</template>
        </el-table-column>
        <el-table-column label="登录时间" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.current" type="success" size="small" effect="light">当前设备</el-tag>
            <el-tag v-else-if="row.revoked" type="info" size="small" effect="plain">已撤销</el-tag>
            <el-tag v-else type="warning" size="small" effect="plain">在线</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="right">
          <template #default="{ row }">
            <el-button v-if="!row.current && !row.revoked" type="danger" size="small" plain @click="revoke(row.jti)">
              撤销
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import { securityApi, authApi } from '@/api';

const stats = ref({ banned: [], events: [], event_total: 0 });
const sessions = ref([]);
const auditLogs = ref([]);
const passValid = ref(false);

let timer = null;

const TYPE_LABELS = {
  waf: 'WAF 拦截',
  rate: '高频请求',
  auth: '认证失败',
  ban: '自动封禁',
  honeypot: '蜜罐命中',
  spam: '垃圾提交',
  unban: '手动解封',
  scan: '扫描行为',
};

function typeLabel(type) {
  return TYPE_LABELS[type] || type || '事件';
}

function typeClass(type) {
  if (type === 'waf' || type === 'scan') return 't-waf';
  if (type === 'auth') return 't-auth';
  if (type === 'ban' || type === 'honeypot') return 't-ban';
  if (type === 'spam') return 't-spam';
  return 't-rate';
}

/** 导出攻击事件为 CSV（含表头，UTF-8 BOM 兼容 Excel） */
function exportCsv() {
  if (!events.value.length) return ElMessage.info('暂无攻击记录可导出');
  // Excel 公式注入防护：= + - @ 制表符/回车开头的值前缀单引号（path/detail 可为攻击者可控文本）
  const esc = (s) => {
    const str = String(s ?? '');
    const safe = /^[=+\-@\t\r]/.test(str.trimStart()) ? `'${str}` : str;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = [
    ['时间', '类型', 'IP', '路径', '详情'].map(esc).join(','),
    ...events.value.map((e) =>
      [new Date(e.t).toLocaleString('zh-CN'), typeLabel(e.type), e.ip, e.path, e.detail].map(esc).join(',')
    ),
  ];
  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `security-events-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 导出管理员操作审计为 CSV（时间/用户/操作/详情/IP） */
function exportAuditCsv() {
  if (!auditLogs.value.length) return ElMessage.info('暂无审计记录可导出');
  // 与 exportCsv 同款公式注入防护
  const esc = (s) => {
    const str = String(s ?? '');
    const safe = /^[=+\-@\t\r]/.test(str.trimStart()) ? `'${str}` : str;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = [
    ['时间', '用户', '操作', '详情', 'IP'].map(esc).join(','),
    ...auditLogs.value.map((a) =>
      [new Date(a.created_at).toLocaleString('zh-CN'), a.username, a.action, a.detail, a.ip].map(esc).join(',')
    ),
  ];
  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url;
  el.download = `security-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  el.click();
  URL.revokeObjectURL(url);
}

async function refresh() {
  try {
    const [sec, sess, audit] = await Promise.all([
      securityApi.overview(),
      authApi.sessions(),
      securityApi.audit(),
    ]);
    stats.value = sec;
    sessions.value = sess;
    auditLogs.value = audit;
    passValid.value = sec.pass_valid === true;
  } catch (e) {
    /* 拦截器已提示 */
  }
}

function timeAgo(t) {
  const diff = Math.max(0, Date.now() - t);
  if (diff < 1000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  return `${Math.floor(diff / 60000)} 分钟前`;
}

function formatRemain(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(String(ts).replace(' ', 'T'));
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function revoke(jti) {
  try {
    await ElMessageBox.confirm('撤销后该设备将立即退出登录，确定继续？', '撤销会话', {
      type: 'warning',
      confirmButtonText: '撤销',
      cancelButtonText: '取消',
    });
    await authApi.revokeSession(jti);
    ElMessage.success('会话已撤销');
    refresh();
  } catch (e) {
    /* 取消或失败 */
  }
}

async function unbanIp(ip) {
  try {
    await ElMessageBox.confirm(`确定解封 IP「${ip}」吗？`, '解封确认', {
      type: 'warning',
      confirmButtonText: '解封',
      cancelButtonText: '取消',
    });
    await securityApi.unban(ip);
    ElMessage.success('已解封');
    refresh();
  } catch (e) {
    /* 取消或失败 */
  }
}

async function logoutAll() {
  try {
    await ElMessageBox.confirm('将退出当前账号在其他所有设备上的登录，确定继续？', '退出其他设备', {
      type: 'warning',
      confirmButtonText: '退出',
      cancelButtonText: '取消',
    });
    await authApi.logoutAll();
    ElMessage.success('其他设备已全部退出');
    refresh();
  } catch (e) {
    /* 取消或失败 */
  }
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 5000);
});

onUnmounted(() => {
  clearInterval(timer);
});
</script>

<style scoped>
.security-manage {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ============ 状态卡片 ============ */
.sec-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}

.sec-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
}

.sec-card-icon {
  width: 42px;
  height: 42px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sec-card-icon.shield { background: color-mix(in srgb, #217a5e 12%, transparent); color: #217a5e; }
.sec-card-icon.warn { background: color-mix(in srgb, #c9900f 12%, transparent); color: #c9900f; }
.sec-card-icon.ban { background: color-mix(in srgb, #c24b5e 12%, transparent); color: #c24b5e; }
.sec-card-icon.key { background: color-mix(in srgb, #2f6fb3 12%, transparent); color: #2f6fb3; }

.sc-label {
  font-size: 0.76rem;
  color: var(--text-3);
  letter-spacing: 0.06em;
  margin-bottom: 4px;
}

.sc-value {
  font-size: 1.15rem;
  font-weight: 750;
}

.sc-value.ok {
  color: #217a5e;
}

/* ============ 面板 ============ */
.panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  padding: 22px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 12px;
  flex-wrap: wrap;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.panel-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 1rem;
  font-weight: 700;
}

.panel-hint {
  font-size: 0.76rem;
  color: var(--text-3);
}

.export-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.78rem;
  transition: all var(--dur) var(--ease);
}

.export-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 34px 0;
  color: var(--text-3);
  font-size: 0.9rem;
}

/* ============ 攻击类型分布 ============ */
.type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
}

.type-cell {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
}

.tc-label {
  font-size: 0.82rem;
  color: var(--text-2);
}

.tc-count {
  font-size: 1.2rem;
  font-weight: 750;
}

.tc-t-waf { color: #c24b5e; }
.tc-t-auth { color: #c9900f; }
.tc-t-ban { color: #c24b5e; }
.tc-t-rate { color: #2f6fb3; }
.tc-t-spam { color: #6d5bb8; }
.tc-t-honeypot { color: #c24b5e; }

/* ============ 事件日志 ============ */
.event-list {
  display: flex;
  flex-direction: column;
  max-height: 360px;
  overflow-y: auto;
}

.event-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 4px;
  border-bottom: 1px dashed var(--border);
  font-size: 0.86rem;
}

.event-row:last-child {
  border-bottom: none;
}

.event-type {
  flex-shrink: 0;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 2px 9px;
  border-radius: 5px;
}

.t-waf { background: color-mix(in srgb, #c24b5e 12%, transparent); color: #c24b5e; }
.t-auth { background: color-mix(in srgb, #c9900f 14%, transparent); color: #c9900f; }
.t-ban { background: color-mix(in srgb, #c24b5e 16%, transparent); color: #c24b5e; }
.t-rate { background: color-mix(in srgb, #2f6fb3 12%, transparent); color: #2f6fb3; }
.t-spam { background: color-mix(in srgb, #6d5bb8 12%, transparent); color: #6d5bb8; }

.event-ip {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.82rem;
}

.event-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.event-detail {
  color: var(--text-3);
  font-size: 0.78rem;
  flex-shrink: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-time {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 0.76rem;
}

/* ============ 表格 ============ */
.sec-table {
  width: 100%;
}

.fp.mono {
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--text-2);
  word-break: break-all;
}
</style>
