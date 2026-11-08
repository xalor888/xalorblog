# W5 · 后台：站点设置 / 安全中心 / 后台外壳 / 审计日志

> 分区范围：`web/src/views/admin/` 下 4 个视图，逐行读完（1205 / 904 / 586 / 264 行，无跳读、无跳段）。
> 共同前提（四文件都吃这一套）：后台请求走 `adminUrl()` 拼的 `/api/<adminKey>/...`（`web/src/api/index.js:237-264`），头里带 `Authorization: Bearer <JWT>`、`X-Pass: <PoW 票据>`、`X-Fp: <指纹>`、`X-Timestamp`、`X-Nonce`、`X-Sig`；`X-Sig = HMAC-SHA256(ticket, "METHOD|path|ts|sha256(JSON body)|jti|nonce")`，`path` 是剥掉 `VITE_API_PREFIX`（默认 `/api`）后的路径（`web/src/api/index.js:18-91`、`web/src/utils/signedFetch.js:42-68`）。响应信封 `{code, message, data}`，拦截器把 `data` 直接返回、错误统一 toast（同文案 4s 去重）。纯下载类接口（settings/audit 导出）绕开 axios，用 `signedFetch` + `downloadBlob`。

---

### web/src/views/admin/Settings.vue（1205 行）

**职责**：站点设置的唯一编辑入口——站点元信息、社交链接、评论/AI 审核与模型参数、阅读策略、关于页 Markdown、改密、后台秘钥地址展示、TOTP 两步验证、活跃会话管理、设置导入导出与测试邮件。

**结构 / 状态**：无 props / emits，整页一个 `ref` 大对象 `form`（服务端 `/settings` 全量回填，含 `site_name/site_desc/announcement/footer/site_url/og_image/avatar/social_*/comment_moderation/message_moderation/ai_*/websearch_*/rss_full_content/copyright_text/icp/allow_copy/about_content` 等 ~37 键），另有 `pwdForm`、`sessions`、`revokingJti`、`loggingOutAll`、`saving|uploading|reverting|backupLoading|mailTesting|pwdLoading|twoFaLoading`、TOTP 侧 `twoFaEnabled|twoFaSetupUri|twoFaSecret|setupCode|disableCode`、`adminPathVal`。`dirty` 不是逐字段 watch，而是 JSON 基线比较：`baseline`（模块级 `let`）+ `setBaseline()` + `watch(form, …, {deep:true})`。计算属性：`isMobile`（`useIsMobile()` 单例 820px）、`aboutHtml`（`renderMarkdown`）、`fullAdminUrl`、`websearchReady`。

**实际逻辑**：载入走 `settingsApi.get()` → `setBaseline()` → `authApi.twoFaStatus()` → `loadSessions()`。保存前只校验 `site_url`（协议前缀 + 禁 query/hash，注释明确要求与服务端 `saveSettings` 判据一致）；`settingsApi.save()` 成功后清空两个密钥输入框 → 失效 `site` store 并 `fetchSettings()` → **再** `setBaseline()`（顺序有讲究：清密钥本身也是一次 form 变更）。TOTP 三条路径：`setup`（先 `ElMessageBox.prompt` 收当前密码 → 拿 `secret/uri`，无二维码图片，只给密钥文本 + `otpauth://` 链接）、`verify`、`disable`；启用/关闭/改密都走 `requireFreshLogin()`（`auth.clearSession()` + 跳 `/<adminKey>/login`，因为服务端会立刻撤销当前令牌）。会话：`loadSessions()` 本地补 `expired`；`revokeOne(jti)` 单飞锁；`logoutAll()` 二次确认。导入/导出与测试邮件各自独立 try/catch。

**项目内依赖**：`@/components/ui/XIcon.vue`；`@/api`（settingsApi / uploadApi / authApi）；`@/utils/markdown`（`renderMarkdown`）；`@/utils/format`（`formatDateTime`）；`@/utils/adminPath`（`getCachedAdminPath` / `getAdminPath`）；`@/utils/pass`（`ensurePass`）；`@/utils/signedFetch`；`@/utils/download`（`downloadBlob`）；`@/stores/auth`、`@/stores/site`；`@/composables/useMedia`；`vue-router` 的 `onBeforeRouteLeave`。

**接口约定**：`GET /settings`（公开读，服务端剔除 `ai_api_key`/`websearch_api_key`，并附 `ai_llm_ready`、`websearch_ready`、`mail_notify`、`server_tz_offset_min`）；`PUT <adminKey>/settings` 收整个 form 对象，服务端只认 `ALLOWED_KEYS` 白名单，越界/非法值 `continue` 静默丢弃但整体仍返回成功；`GET <adminKey>/settings/export` 直接 `res.send(JSON)`（不是信封），**已剔除两个密钥与 `ai_system_prompt`**；`POST <adminKey>/settings/import` 收 JSON 对象，白名单 + 长度钳制（`about_content` 50000、其余 5000），返回 `已导入 N 项设置`；`POST <adminKey>/settings/test-mail` 返回 `{recipient}`；`PUT /auth/password` → `{relogin_required:true}`；`GET /auth/sessions` → `jti/fp/ip/ua/revoked/expires_at/created_at/current`；`DELETE /auth/sessions/:jti`；`POST /auth/logout-all`；`GET|POST /auth/2fa/{status,setup,verify,disable}`；`POST <adminKey>/upload`（FormData）→ `{url}`。

**UI / 交互**：Element Plus 用了 `el-form`/`el-form-item`（`label-position` 随 `isMobile` 切 top/right）、`el-input`（含 `type=password` + `show-password`、textarea + `show-word-limit`、`maxlength`）、`el-switch`、`el-select`（AI 预设、温度档位）、`el-upload`（`:http-request` 自管上传，`:show-file-list=false`）、`el-tag`（会话状态）、`el-button`（loading）。自研：玻璃分卡布局、`border-left` 强调条标题、头像预览（`@error` 隐藏 / `@load` 恢复）、Markdown 预览块（`v-html` + `max-height` 滚动）、`save-bar` 四按钮 + 隐藏 `<input type=file>`、`user-select:all` 的密钥/后台地址代码块、`color-mix` 状态徽标；`@media (max-width:820px)` 把 AI 双列压成单列。

**副作用与失败模式**：`window` 上挂 `beforeunload`（卸载移除）；`onBeforeRouteLeave` 拦未保存修改；保存会写 `site` store 并把 `loaded` 置 false（下次 `init()` 会连带重拉 stats/reading）；`navigator.clipboard` 不可用时退化到 `document.execCommand('copy')`。失败面：`settingsApi.get()` 无 catch，失败后 2FA 与会话加载全被跳过；导出/导入失败各弹一次 toast 且与拦截器提示重复；服务端对多数键的静默丢弃不会回显。

---

### web/src/views/admin/SecurityManage.vue（904 行）

**职责**：安全运营面板——反爬票据状态、拦截计数、攻击类型分布、实时事件流、封禁 IP 表（可解封）、管理员操作审计（近 100 条）、登录会话（撤销/退出其他设备），以及 WAF/信誉参数的可视化配置与规则 dry-run 测试器。

**结构 / 状态**：无 props/emits。只读侧 `stats`（`banned/events/event_total/type_counts`）、`events`（computed）、`sessions`、`auditLogs`、`passValid`、`loadError`、`isMobile`；配置侧 `cfg`（服务端 `config` 的可编辑副本，`groups`/`weights` 用默认值补齐）、`rulesByGroup`、`cfgDirty`、`savingCfg`；测试器 `testText/testResult/testLoading`。`TYPE_LABELS` 9 种事件类型映射，`GROUP_LABELS` 6 个规则组。

**实际逻辑**：`refresh()` 用 `Promise.all([securityApi.overview(), authApi.sessions(), securityApi.audit()])` 一次拉三份，任一失败即整块记 `loadError`。`loadConfig()` 拉 `{config, rules}`，把 `rules` 按 `group` 分桶喂给「禁用单条规则」下拉的分组选项，并复位 `cfgDirty`；`resetCfg()` 就是重拉（放弃修改）。`saveCfg()` 二次确认「保存后立即对全站生效」→ `PUT /security/config` → 成功后重拉。`runTest()` 把文本交 `securityApi.testRule`（base64 上送，绕开全局 WAF body 扫描），结果只按 `hits[]` 渲染标签。CSV 导出两份独立实现（事件/审计），都做了 Excel 公式注入防护（`^[=+\-@\t\r]` 前缀单引号）与 `\ufeff` BOM，判定与后端 `admin.js:1723-1729` 同款。`timeAgo()` 只到「分钟」档，`formatRemain()` 按秒拆分局。挂载时 `setInterval(5s)` 轮询 + `visibilitychange` 回调，卸载清理。

**项目内依赖**：`@/components/ui/XIcon.vue`；`@/api`（securityApi / authApi）；`@/utils/format`（`formatDateTime`）；`@/composables/useMedia`；`@/utils/download`；`vue-router` 的 `onBeforeRouteLeave`。

**接口约定**：`GET <adminKey>/security` → `{banned:[{ip,remain(秒),strikes,banCount,reason}], events:[{t(ms),type,ip,path,detail,persisted?}], event_total, type_counts, pass_valid, server_time}`；`GET /security/audit` → 直接是数组（近 100 条 `id/username/action/detail/ip/created_at`），失败也返回 `ok([])`；`POST /security/unban {ip}`（服务端 `net.isIP` 校验）；`GET /security/config` → `{config, rules}`；`PUT /security/config` 强校验 `disabledRules` 必须是已知规则 ID、`trustedIps` 必须是 IP/CIDR、词库必须是数组，数值区间在 `securitySettings.js` 内收敛；`POST /security/test` 收 `{text_b64}`（≤6000 base64、解码后 ≤4000 字）→ `{hits:[{id,group,scope,note,sev,score}], blocked, score, threshold}`；会话三接口同 Settings.vue。

**UI / 交互**：`el-table`（封禁/审计/会话三张，`size="small"`、窄屏 `v-if="!isMobile"` 裁列、`show-overflow-tooltip`）、`el-tag`（会话状态、测试命中）、`el-switch`、`el-input-number`（带 min/max）、`el-select`（multiple + filterable + allow-create 做 IP/词库标签输入，`el-option-group` 做规则分组）、`el-input` textarea、`el-button`(link/plain/loading)、`el-message-box` 三次确认。自研：4 张状态卡（`color-mix` 图标底色）、事件流用 flex 行 + `max-height:360px` 滚动、事件类型徽标按对比度调深前景（注释记录 2.46/4.01/4.42:1 的实测值）、`panel-hint.dirty` 提示未保存。

**副作用与失败模式**：5s 定时器 + `visibilitychange` 监听（切回前台立即刷新）；`document.hidden` 时跳过轮询。失败面：三接口任一失败即 `loadError`，但 `loadConfig()` 的失败被完全吞掉（面板整块 `v-if="cfg"` 消失）；撤销/解封/批量退出的 catch 同时吞「用户取消」与「接口报错」；`saveCfg` 的错误自己再弹一次（`e.response.data.message`），与拦截器重复。

---

### web/src/views/admin/Layout.vue（586 行）

**职责**：后台外壳——侧栏导航 + 待审角标、顶栏（折叠/标题/用户/主题/强调色/AI 入口）、内容区 `<router-view>` 过渡、全局快捷键帮助与 AI 抽屉的挂载点，并负责退出登录与 `document.title` 联动。

**结构 / 状态**：无 props/emits；`collapsed`（读写 `localStorage['xalor_admin_side']`）、`mobileOpen`、`aiOpen`、`accentOpen`；`menus` 是硬编码 15 项（`{path,title,icon,group?}`，分组为 个人主页 / 博客 / 系统）；`currentTitle = route.meta.title || '管理后台'`；`sideToggleTitle` 三态文案。子组件 `<ShortcutHelp />`、`<AiPanel :open="aiOpen" @close>`，按 `:key="route.path"` 强制重建页面组件。

**实际逻辑**：`toggleSide()` 在 `isMobile` 时切抽屉、否则切折叠；`watch(() => route.path)` 关抽屉；`watchEffect` 写 `document.title = "<title> · 管理后台"`。`badgeFor(item)` 按 `admin.pending` 的 comments/links/messages 出数字；`admin.fetchPending()` 在 setup 与每次路由变化各触发一次。`logout()` 调 `auth.logout()`（先等服务端撤销再清本地），`revoked === false` 时提示「服务端会话撤销失败，请到安全中心撤销旧会话」，随后 `router.push(adminHref('login'))`。

**项目内依赖**：`@/components/ui/XIcon.vue`、`@/components/ui/ShortcutHelp.vue`、`./AiPanel.vue`；`@/stores/auth`、`@/stores/theme`（含 `THEME_COLORS`）、`@/stores/admin`；`@/utils/adminPath`（`adminHref`）；`@/composables/useMedia`；`element-plus`（`ElMessage`）。

**接口约定**：本身不发请求；通过 `adminStore.fetchPending()` 间接打 `GET <adminKey>/stats/dashboard`（取 `data.pending`），通过 `auth.logout()` 打 `POST /auth/logout`。`adminHref(seg)` 在秘钥路径未加载时返回 `/_/<seg>` 占位。

**UI / 交互**：`<transition name="fade">` 遮罩 + `.page-fade`（`mode="out-in"`）；`h1.header-title`（注释记录：18 个后台页原来只有登录页有 h1，改一处覆盖 17 页——纯语义修复，字号仍 0.98rem）；侧栏液态玻璃（`--lg-sheen/--lg-surface/--lg-blur`）+ 双光斑背景；折叠态 64px 只留图标、`title` 兜底；`accent-pop` 4×N 色板浮层（mouseenter/mouseleave + 点击 toggle）；`@media(min-width:1600px)` 内容限宽 1480 居中；`@media(max-width:820px)` 侧栏转 `translateX(-105%)` off-canvas，并用 `display:inline-flex !important` 覆盖 `v-show`，让徽标与文字在手机上重新可见。

**副作用与失败模式**：写 `localStorage`、改 `document.title`（卸载不还原）、每路由一次 `fetchPending`。失败面：`adminHref` 未加载时导航落到 `/_/...` 占位路由；`logout()` 无 try，`auth.logout()` 内部已兜住异常故不会抛。

---

### web/src/views/admin/AuditManage.vue（264 行）

**职责**：审计日志的独立检索页——关键词搜索 + 分页浏览、CSV 全量（近 1000 条）导出、清空日志。

**结构 / 状态**：`list/loading/clearing/page(1)/pageSize(20 常量)/total/keyword/exporting/isMobile`；`methodClass(action)` 由 `action` 首词映射 `get/post/put/del/auth` 五色。

**实际逻辑**：`load(p)` 组 `{page, pageSize, keyword}` 调 `auditApi.list`，写回 `list`、`pagination.total`、`page`；搜索框 `@keyup.enter` 与 `@clear` 都触发 `load(1)`。`clearLogs()` 二次确认（文案写明「清空动作本身也会被记录」，与后端 `AUDIT_CLEAR` 留痕一致）→ `auditApi.clear()`（`DELETE` + body `{confirm:true}`）→ `load(1)`。`exportCsv()` 走 `ensurePass()` → `signedFetch('/api/<key>/audit/export?keyword=…')` → `blob` → 从 `Content-Disposition` 正则取文件名（取不到回退 `audit.csv`）。

**项目内依赖**：`@/components/ui/XIcon.vue`；`@/api`（auditApi）；`@/utils/format`（`formatDateTime`）；`@/utils/adminPath`（`getCachedAdminPath`）；`@/utils/pass`（`ensurePass`）；`@/utils/signedFetch`；`@/utils/download`；`@/composables/useMedia`；`@element-plus/icons-vue`（`Search` 作 `:prefix-icon`）。

**接口约定**：`GET <adminKey>/audit/logs?page&pageSize&keyword` → `{list[], pagination:{page,pageSize,total}}`（`pageSize` 服务端夹到 1-100、`page` 夹到 1-10000，`keyword` 截 50 字并 `escapeLike`）；`DELETE <adminKey>/audit/logs`，body 必须 `{confirm:true}` 否则 400；`GET <adminKey>/audit/export?keyword` 返回 `text/csv; charset=utf-8` 附件 `audit-YYYY-MM-DD.csv`（最近 1000 条，服务端已做同样公式注入防护）。

**UI / 交互**：`el-input`（`clearable` + 前缀图标）、`el-button`（`plain`/`danger`/`loading`）、`el-table`（`stripe`、`v-loading` 仅空列表时显示）；操作列把 `"GET /x"` 拆成方法徽标 + 等宽字体路径；设备指纹只显示前 16 字符 + 省略号（`show-overflow-tooltip`）；`el-pagination`（`layout="total, prev, pager, next"`、`background`、固定 20 条无 page-size）；窄屏 `v-if="!isMobile"` 隐藏 ID/详情/IP/指纹/时间。

**副作用与失败模式**：仅 DOM 下载与分页状态；无定时器、无存储写入。失败面：`load()` 无 catch（`res.list` 缺失会抛 TypeError，`loading` 复位但列表停在旧值）；导出失败统一「导出失败，请重试」，与服务端具体原因无关。

---

## 观察

1. `web/src/views/admin/Settings.vue:25` — 提示文案里写了 Markdown 星号（`**必须是绝对 URL 或站内绝对路径**`），模板不做 Markdown 渲染，页面上会原样显示星号。
2. `web/src/views/admin/Settings.vue:145` — 「友链审核」是 `:model-value="true"` + `disabled` 的恒真开关，服务端也没有对应键，读起来像可配置项、实际不可改也无从说明。
3. `web/src/views/admin/Settings.vue:346-354` — 导入按钮绑定 `backupLoading`，但 `importBackup()` 从不置它：导入全程无 loading、可被连点重复导入，且与导出共用同一标志。
4. `web/src/views/admin/Settings.vue:90-98, 454-460` — `applyPreset` 只处理命中分支，`el-select` 被 clearable 清空时传入空值直接 `return`，`presetPick` 不变 → 清空操作看起来无效。
5. `web/src/views/admin/Settings.vue:497` — UA 正则把 `Chrome` 排在 `Edg/`/`Edge` 之前，Edge 的 UA 同时含 `Chrome/`，会话设备一律摘要成 Chrome。
6. `web/src/views/admin/Settings.vue:511` — `new Date(s.expires_at)` 按浏览器时区解析无时区后缀的服务器时间；项目已有 `format.js:23` 的 `parseServerTime` + `server_tz_offset_min`，此处绕过，跨时区管理员会看到错误的「已过期」。
7. `web/src/views/admin/Settings.vue:758-759` — 保存后无条件清空 AI/搜索 Key 输入框；服务端对长度 <8、纯 `*` 掩码等值 `continue` 丢弃（`server/src/utils/settings.js:214-231`）却仍返回「设置已保存」，用户既看不到报错也看不到残留值。
8. `web/src/views/admin/Settings.vue:756-769` — 保存后不重新 GET，服务端对 `avatar`/`social_*`/`ai_base_url`/`ai_max_tokens` 等的静默丢弃与归一化都不回显；`731-736` 的注释只把 `site_url` 一个键的这类失败提前拦住了。
9. `web/src/views/admin/Settings.vue:785` — 导出把前缀写死成 `/api/${key}/settings/export`，而其余请求走 `VITE_API_PREFIX`（`signedFetch` 的 `sigPath` 也按该前缀剥）；前缀改掉时路由与签名路径会同时错，`key` 为空时还会拼出 `/api//settings/export`。
10. `web/src/views/admin/Settings.vue:831` — 错误提示与拦截器的 `toastOnce` 重复：失败时先由拦截器弹一次，再被这里的 `ElMessage.error` 弹一次。
11. `web/src/views/admin/Settings.vue:853` — `onMounted` 里 `await settingsApi.get()` 无 try，一旦失败，后面 2FA 状态与 `loadSessions()` 全部不执行，页面停在空表单。
12. `web/src/views/admin/Settings.vue:1126, 1142-1146` — `.ai-scope` 在模板中不存在；`.field-hint` 的 `grid-column: 1 / -1` 位于非 grid 容器内，两条都是死样式。
13. `web/src/api/index.js:375` — `settingsApi.exportBackup` 全库无引用（本页改用 `signedFetch`），死代码。
14. `web/src/views/admin/Settings.vue:202` — placeholder 承诺「至少 8 位，且不能纯数字或纯字母」，前端只查长度；≤72 字节、常见密码、含用户名三条只能等服务端 400（`server/src/routes/auth.js:30-41`）。
15. `web/src/views/admin/Settings.vue:296-337` 与 `SecurityManage.vue:137-177` — 同一套「会话列表 + 单条撤销 + 退出全部设备」实现两遍，行为还不一致（前者本地补 `expired`，后者没有），后续改动要改两处。
16. `web/src/views/admin/SecurityManage.vue:546-548` — 5 秒轮询 3 个接口，`/security` 每次要跑两条 `audit_logs` 聚合查询（`server/src/middleware/ipGuard.js:447-464`），后台标签页常开时是最重的持续性开销。
17. `web/src/views/admin/SecurityManage.vue:74` — 事件列表 `:key="i"` 且每 5 秒整表替换，索引当键会让行 DOM 错位复用（文本、徽标瞬时串行）。
18. `web/src/views/admin/SecurityManage.vue:374-379` — `timeAgo` 只有秒/分两档，1 小时前显示「60 分钟前」，一天前显示「1440 分钟前」，事件流里读不出量级。
19. `web/src/views/admin/SecurityManage.vue:166` — 非 current 且非 revoked 一律标「在线」，但 `listSessions` 不过滤过期（`server/src/middleware/auth.js:194-201`），过期会话被当作在线；对照 `Settings.vue:511` 反而算过。
20. `web/src/views/admin/SecurityManage.vue:477-479` — `loadConfig` 的失败被完全吞掉，模板 `v-if="cfg"` 让整块 WAF 面板消失：用户看到的是「没有这个功能」而不是「加载失败」，且没有重试入口（`loadError` 只覆盖 `refresh`）。
21. `web/src/views/admin/SecurityManage.vue:521-533` — 只拦路由离开，没有 `beforeunload`：改完 WAF 参数刷新或关标签页即静默丢失（`Settings.vue:432-438` 有这道守卫）。
22. `web/src/views/admin/SecurityManage.vue:482-484` — 「放弃修改」直接 `loadConfig()`，无二次确认（`Settings.vue:701-725` 有），一次误点即回滚全站防护参数。
23. `web/src/views/admin/SecurityManage.vue:24-26` — 「已拦截攻击」是近 7 天窗口的计数（DB 7 天 + 未落库内存合成，`ipGuard.js:409-484`），卡片没写口径；且 `unban` 被归并进 `ban`，手动解封也被算成「攻击」。
24. `web/src/views/admin/SecurityManage.vue:306-312, 720` — `typeClass('waf-mon')` 落到 `t-rate`，监控态与限流同色；`.tc-t-honeypot` 永远不会被拼出（honeypot 映射成 `t-ban`），是死规则。
25. `web/src/views/admin/SecurityManage.vue:318-341` — `esc()` 完全相同的实现写了两份，与 CommentManage / MessageManage 同款，应上提为公共 CSV 工具。
26. `web/src/views/admin/SecurityManage.vue:196-217` — 开关/数值行的文字是与控件并列的 `span`，没有 `label for` / `aria-labelledby`，`el-switch` 的 `role=switch` 没有可访问名，读屏只念「开关」。
27. `web/src/views/admin/SecurityManage.vue:258-265` — 测试接口返回 `blocked/score/threshold`（`server/src/routes/admin.js:2073-2095`），界面只渲染 `hits`，看不到「离拦截还差几分」，dry-run 的诊断价值打了折。
28. `web/src/views/admin/SecurityManage.vue:192-235` — 服务端默认配置里的 `paranoiaLevel`(1-3) 与 `anomalyThreshold`(3-20)（`server/src/utils/securitySettings.js:26-31`）没有任何控件，误杀调优只能改库。
29. `web/src/views/admin/Layout.vue:41` — 「退出登录」是无 `href` 的 `<a @click>`，不进 Tab 序列、无 `role=button`，键盘用户无法登出。
30. `web/src/views/admin/Layout.vue:549-563` — 抽屉靠 `transform: translateX(-105%)` 隐藏，DOM 仍在且可聚焦：关闭态下 Tab 会走进不可见菜单；遮罩是纯 `div @click`，无 Esc、无 `role`，也不在打开时把焦点移入抽屉。
31. `web/src/views/admin/Layout.vue:74-80` — 主题切换按钮只有 `title`，没有 `aria-label`，图标 svg 无文本，可访问名只剩 title 兜底；同类「强调色」按钮（`83`）相同。
32. `web/src/views/admin/Layout.vue:82-99` — 强调色浮层靠 `mouseenter/mouseleave` + 按钮 toggle，没有 outside-click 与 Esc；触屏上点开后只能再点一次圆点才关。
33. `web/src/views/admin/Layout.vue:206-212` — 登出用 `router.push` 而非 `replace`，浏览器后退会回到需要鉴权的后台页，再由 401 逻辑弹回登录页。
34. `web/src/views/admin/Layout.vue:154-170` 对比 `web/src/router/routes-admin.js:22-41` — 菜单硬编码 15 项、路由 18 项：`articles/:id/edit`、`notes/:id/edit` 无菜单项，且它们是兄弟记录、`router-link` 的 active 判定不跨记录，编辑态侧栏很可能整列无高亮（静态推断，未在浏览器验证）。
35. `web/src/views/admin/Layout.vue:203-204` — `fetchPending()` 在 setup 与每次 `route.path` 变化各打一次 `stats/dashboard`，与 SecurityManage 的 5s 轮询叠加成后台的固定背景流量。
36. `web/src/views/admin/AuditManage.vue:157-159` — 注释在解释「这两行」（`document.createElement('a')` / `createObjectURL`），但本文件早已没有这两行，是迁到 `downloadBlob` 后遗留的说明，读者会去找不存在的代码。
37. `web/src/views/admin/AuditManage.vue:90-104` — `load()` 只有 try/finally，`res.list` 缺失时抛 TypeError 成为未处理 rejection；`loading` 复位了但列表停在旧数据，也没有错误态。
38. `web/src/views/admin/AuditManage.vue:205-208` — `.hint` 类无任何使用者，死样式。
39. `web/src/views/admin/AuditManage.vue:142-168` — 导出固定取近 1000 条（`server/src/routes/admin.js:1707-1741`）且只带当前关键词，按钮与提示都没写这个上限，容易被当成「导出全部」。
40. `web/src/views/admin/AuditManage.vue:28-51` — 窄屏隐藏 ID/详情/IP/设备指纹/时间，只剩「操作者 + 操作」，手机上是唯一能把「谁」和「什么时候、从哪来」对上号的信息被裁掉了，审计场景基本不可用。

## 小结

- 这四个文件构成后台的「治理面」：`Settings.vue` 管内容与 AI 相关的全局开关，`SecurityManage.vue` 管反爬/封禁/WAF 参数，`AuditManage.vue` 管事后追责，`Layout.vue` 是把它们串起来的唯一外壳（`routes-admin.js` 里 16 个子路由全部挂在它下面，`:key="route.path"` 决定页面重建语义）。
- 权限模型在外壳一层收口：Layout 只负责展示与登出，真正拦截在路由守卫与 `authRequired`；两张高权限页（设置、安全）没有页面级二次校验，改密/2FA 后的强制重登（`requireFreshLogin`）是唯一会让令牌立即失效的路径。
- 设置的写入语义是「白名单 + 静默丢弃」，前端只在 `site_url` 一个键上复制了服务端判据；其余键的失败对用户不可见，这是这一区最系统性的缺陷面（`Settings.vue:727-775` vs `server/src/utils/settings.js:137-260`）。
- 未保存修改的守卫强度不一致：`Settings.vue` 有路由拦截 + `beforeunload` + 显式「放弃修改」，`SecurityManage.vue` 只有路由拦截且无确认回滚，`AuditManage.vue` 无状态可丢——同一后台里三套行为，用户无法形成稳定预期。
- 安全中心是唯一带轮询的页面，其开销全部落在服务端聚合查询上；它同时是「配置中心」与「监控面板」，两个职责耦合在同一个 5s 心跳里，任何一次配置保存失败都会和监控刷新混在同一条错误通道里。
- 可访问性投入集中在 Layout（`h1` 语义、`aria-label`、折叠按钮）与事件徽标对比度上，但 off-canvas 抽屉的可聚焦隐藏、无 `href` 的登出链接、以及表单控件的 label 关联仍是明显缺口——都是低成本可修的形态。
