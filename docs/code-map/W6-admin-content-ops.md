# W6-admin-content-ops — 后台内容与运营管理

覆盖 `web/src/views/admin/` 下 10 个视图（审核 / 分类 / 友链 / 图片 / 主页设置 / 手记 / 登录）。均为 `<script setup>` 单文件组件，无 props / emits / 具名导出，状态全部在组件内 `ref`。路由见 `web/src/router/routes-admin.js`，除 `Login.vue` 外都挂在 `/:adminKey` 秘钥段下。

**统一契约**：管理调用一律经 `@/api` 的 `adminGet/adminPost/adminPut/adminDelete` 拼成 `/api/<adminKey><path>`，拦截器附加 `X-Pass`（PoW 票据）、`X-Fp`（指纹）、`X-Timestamp`、`X-Nonce`、`X-Sig`（`HMAC(ticket, METHOD|path|ts|sha256(body)|jti|nonce)`）与 `Authorization: Bearer <JWT>`；响应 `{code,data,message}` 被解包，`code!==0` 直接 reject 并 `toastOnce`，故各视图 `catch` 多为空块。CSV 导出走 `@/utils/signedFetch` 裸 fetch（取 Blob + `Content-Disposition`）。

---

### web/src/views/admin/CommentManage.vue（517 行）

- 职责：评论审核台——状态/关键词/AI 标记/文章四维筛选，单条与批量通过、拒绝、AI 复核、删除、导出 CSV。
- 结构：`toolbar`（`el-radio-group` 状态、`el-input` 关键词、`el-checkbox` aiOnly、`el-select` 文章、导出、全部通过）→ `el-table`（选择列、昵称首字母头像、内容含 `parent_nickname` 回复前缀与文章链接、状态 tag、点赞、AI tooltip、IP、时间）→ `batch-bar`（`v-if="selection.length"`）→ `el-pagination`。
- 状态：`list/loading/page/pageSize=10/total/status/keyword/aiOnly/articleId/articleOptions`、`reAiId/approving/exporting/batchLoading`、`selection/tableRef`；`isMobile` 来自单例 `useIsMobile()`，窄屏隐藏点赞/AI/IP/时间列并解掉 `fixed`。
- 逻辑：状态变更后先 `adminStore.fetchPending()` 刷侧栏徽章再 `load()`；`approveAll` 先确认再按 `res.affected` 区分"暂无待审"与成功；`exportCsv` 先 `ensurePass()` 再按当前筛选拼 query，从 `Content-Disposition` 取文件名交 `downloadBlob`（:273-275 注释记录"不要再 `createObjectURL`"的遗留）；`batchRemove` 删空末页回退一页；`clearSelection` 同时清数组与 `tableRef.clearSelection()`（:303-318 长注释解释"只清数组不取消勾选"）。
- 依赖：`XIcon`、`@/api`（`commentApi`、`articleApi`）、`@/stores/admin`、`@/utils/adminPath`、`@/utils/pass`、`@/utils/signedFetch`、`@/utils/format`、`@/composables/useMedia`、`@/utils/download`。
- 接口：`GET /comments/admin/list` → `{list:[{id,nickname,content,status,likes,ip,ai_reason,created_at,parent_nickname,article_title,article_slug}],pagination}`；`PUT /comments/:id/status`；`POST /comments/:id/re-ai` → `{status}`（服务端按 AI 结论改状态并清/写 `ai_reason`）；`POST /comments/batch-status|batch-delete`；`POST /comments/approve-all` → `{affected}`（服务端 `limit(1000)`，不滤 AI）；`DELETE /comments/:id`；`GET /comments/admin/export`。文章下拉来自 `GET /articles/admin/list?pageSize=100&status=all`。
- UI：`el-radio-button`/`el-select(filterable,clearable)`/`el-tooltip`/`el-tag`/`el-table(stripe)`/`el-pagination(background)`；内容列 `min-width:300` 不截断，文章链接单行省略。
- 副作用：每次状态变更多一次 `GET /stats/dashboard`；`load()` 无 `catch`；`Promise.all` 批量复核任一失败即跳 `catch`，已成功条目状态不回显。

### web/src/views/admin/MessageManage.vue（527 行）

- 职责：留言审核 + 站长回复，另含"封禁来源 IP"。
- 结构：过滤区（状态/aiOnly/关键词/导出/全部通过）→ 表格（昵称、内容 `show-overflow-tooltip`、状态、AI、IP、时间、操作：通过/拒绝/复核/回复/删除/封禁）→ 批量栏 → 分页（`pageSize=20`）→ 回复 `el-dialog`（`min(520px,92vw)`、textarea 2000 字、footer 有"清空回复"）。
- 状态：`list/loading/status/aiOnly/keyword/page/pageSize/total`、`replyDialog/replyForm{id,content,hasExisting}/replying`、`reAiId/approving/exporting/batchLoading`、`selection/tableRef`。
- 逻辑：`submitReply` 先校验空串；`clearReply` 用 `reply(id,'')` 走服务端"清空"分支（同时置空 `replied_at`）；`banIp` 先判 `row.ip`，确认文案写"默认 30 天、安全中心可解封"，调用 `securityApi.ban(ip)` 不传 `minutes` 由服务端默认；`batchReAi` 比评论页多一层确认 + 待审/已拒计数 + "判定通过会立即公开"警告，并按返回 `status` 汇总三类结果。
- 依赖：同评论页，另加 `securityApi`。
- 接口：`GET /messages/admin/list` → `{list（`select *`，含 `reply/replied_at`）,pagination}`；`PUT /messages/:id/status`；`PUT /messages/:id/reply {reply}`（非空会顺带把 `status` 置 `approved` 并发通知邮件）；`POST /messages/batch-status|batch-delete`；`POST /messages/approve-all` → `{affected,skipped}`（跳过 `ai_reason` 非空）；`POST /messages/:id/re-ai`；`GET /messages/admin/export`；`POST /security/ban`。
- UI：封禁按钮窄屏隐藏；操作列宽 140/320；`el-dialog` 关闭点击遮罩禁用。
- 副作用：回复触发服务端异步发信（前端无感）；封禁成功不刷新列表；`@change="load"` 见观察 1。

### web/src/views/admin/CategoryManage.vue（338 行）

- 职责：分类的增、行内排序、编辑、删除 + 本地搜索与 CSV 导出。
- 结构：`create-card`（名称/描述/`el-color-picker` 8 色预设/创建；filter-row 搜索+导出）→ `el-table`（色点+名称、描述、`article_count` tag、`el-input-number` 排序、编辑/删除）→ 编辑 `el-dialog`（名称/Slug/描述/主题色，`:show-close="false"`、遮罩不关闭）。
- 状态：`list/searchKey/loading/creating/exporting/dialogVisible/saveLoading`、`newCat`、`editForm`、`filteredList`（名称+描述小写包含）、`editSnapshot`（打开时 `name\0slug\0description`，`let` 非 ref）。
- 逻辑：`create` 有 `creating` 重入保护（注释承认只建 1 条是数据库唯一约束兜的）；`dialogDirty()` 只比文本不比 `color`（色值会被 `el-color-picker` 规范化）；`cancelEdit()` 脏则确认；`updateSort` 失败 `load()` 回滚；`remove` 把 `article_count` 写进问句；`exportCsv` 自带引号转义 + `^[=+\-@\t\r]` 前缀 `'` 的公式注入防护，`\uFEFF` BOM 保证 Excel 中文。
- 依赖：`XIcon`、`categoryApi`、`useIsMobile`、`downloadBlob`。
- 接口：`GET /categories`（公开，`sort asc,id asc`，返回含 `article_count`）；`POST /categories`；`PUT /categories/:id`（空名拒绝、`color` 非 `#rrggbb` 回退、`slug` 经 `slugify` 去重、`sort` 严格 0–100 整数）；`DELETE /categories/:id`（事务解绑后删）。
- UI：`el-form` + `el-input-number(controls-position="right")`；≤640px 创建行改纵排；色点行内 `background`。
- 副作用：`load()` 无 `catch`；`updateSort` 失败静默回滚；`saveEdit` 全量提交。关闭路径见观察 2。

### web/src/views/admin/LinkManage.vue（365 行）

- 职责：友链审核（待审/通过/拒绝/改回待审）+ 行内排序 + 批量 + CSV 导出。
- 结构：过滤区（状态/关键词/全部通过/导出）→ `el-table`（选择列、站点头像或首字母 + 名称外链 `rel="noopener noreferrer"` + url、介绍、状态、排序、操作四按钮）→ 批量栏，**无分页**。
- 状态：`list/loading/status/keyword/approving/exporting/selection/tableRef/batchLoading`、`isMobile`。
- 逻辑：`list.value = await linkApi.adminList(...)`（服务端回数组）；`setStatus` 后 `fetchPending()` + 重载；`updateSort` 复用 `updateStatus(id,{status:row.status,sort})`；`approveAll` 按 `affected` 分支提示；`exportCsv` 手写 `esc()`（`trimStart` 判公式前缀）。
- 依赖：`XIcon`、`linkApi`、`@/stores/admin`、`useIsMobile`、`downloadBlob`。
- 接口：`GET /links/admin/list` → 数组（`sort asc, created_at desc`）；`PUT /links/:id/status {status?,sort?}`（`sort` 钳制 0–100 取整，两者皆空报"无更新内容"）；`POST /links/batch-status`（≤500）、`batch-delete`；`DELETE /links/:id`；`POST /links/approve-all`。
- UI：`el-tag`/`el-input-number`；url 单行省略 200px；窄屏操作列 130px 塞四按钮。
- 副作用：全量渲染无虚拟滚动；排序失败回滚无提示。

### web/src/views/admin/ImageManage.vue（361 行）

- 职责：上传目录可视化——网格预览、引用标记、单文件删除、孤儿清理、Markdown 链接复制。
- 结构：`page-head`（统计 + 搜索 + 上传按钮 + 隐藏 file input + 清理）→ 加载占位/`el-empty`/`.image-grid`（缩略图 + 引用徽章 + 名称 + 体积时间 + 复制/删除）→ 本地分页（>60 才出现）→ `el-dialog` 灯箱预览（`append-to-body`）。
- 状态：`files/searchKey/loading/cleaning/uploading/previewOpen/previewName`、`PAGE_SIZE=60`、`imgPage`、`filteredFiles`（文件名小写包含）、`visibleFiles`（slice）。
- 逻辑：`load()` 用 promise 链，把结果规整为 `{...f, used:!!f.used}`（:122-124 注释记录"拦截器已解包，`res.data` 恒 undefined"）；`uploadOne` 取第 0 个文件后立刻清 `input.value` 以支持重选，失败读 `err.response.data.message`；`copyUrl` 生成 `![图片](/uploads/<name>)`，优先 `clipboard`，降级 `textarea + execCommand`；`remove/cleanupOrphans` 用 `confirm().then()` 链并在 `catch` 过滤 `'cancel'|'close'`。
- 依赖：`XIcon`、`imagesApi`、`uploadApi`、`formatDateTime`。
- 接口：`GET /uploads/list` → `[{name,size,mtime,used}]`（服务端 `mtime desc` 硬截 500，`used` 来自 `collectReferencedUploads()`）；`DELETE /uploads/:filename`（文件名正则 + 穿越校验 + 引用保护，被引用返回 400）；`POST /uploads/cleanup-orphans`（保 24h 内新文件）；`POST /upload`（FormData，随机重命名 + magic bytes/EXIF）→ `{url,filename}`。
- UI：CSS Grid `auto-fill minmax(150px,1fr)`、`aspect-ratio:1/1`、`loading="lazy"`；徽章用硬编码 `rgba(64,158,255)`/`rgba(103,194,58)`；操作按钮默认 `opacity:0`。
- 副作用：`load()` 每次把 `imgPage` 复位为 1（删/传后跳回首页）；预览 `img` 的 `src` 未做 `encodeURIComponent`（依赖服务端安全文件名）。

### web/src/views/admin/HomeSettings.vue（272 行）

- 职责：个人主页运营配置——站点 URL、Hero 文案、在线状态、起始日期、关于摘要、额外社交链接（≤8）。
- 结构：四个 `card section` + `save-bar`（保存 / 放弃修改，`position:sticky`）；社交项 `v-for` 行（label + url + 删除），不足 8 条时有"添加一条"。
- 状态：`form`（`reactive`，7 个 `home_*`）、`socialExtra`、`loading/saving`、`baseline`（`let`，JSON 串）、`dirty`。
- 逻辑：`parseExtra` 对 `home_social_extra` 做 parse + 类型过滤 + 字符串化，异常回 `[]`；`watch([form,socialExtra],{deep:true})` 逐次 `JSON.stringify` 比对 `baseline`；`setBaseline()` 只在 `load` 末尾与 `save` 成功后调用（注释解释"放 watch 里会一打开就提示未保存"）；`onBeforeRouteLeave` + `beforeunload` 双保护；`save` 先 trim/滤空社交项，提交 `{...form, home_since_date: form.home_since_date || '', home_social_extra: JSON.stringify(cleaned)}`，成功后**先**同步 `socialExtra=cleaned` 再 `setBaseline()`（顺序反了清洗差异会被判成新改动）；`revertChanges` 走 `await load()`。
- 依赖：`XIcon`、`settingsApi`、`onBeforeRouteLeave`。
- 接口：`GET /settings`（公开读）；`PUT /settings`（白名单键：`home_site_url` 需 http(s) 且无 query/hash、`home_status` 枚举、`home_since_date` 严格 `YYYY-MM-DD`、`home_social_extra` 逐项 safeUrl + label≤30 + ≤8 后重序列化；非法值 `continue` 丢弃而不报错）。
- UI：`el-form(label-position="top")`/`el-select`/`el-date-picker(value-format="YYYY-MM-DD")`；`.grid-2` ≤700px 单列；`hint` 承载"留空由 Host 推导""留空按 2024-01-01"等约定。
- 副作用：无客户端校验，服务端静默丢键时仍提示成功；放弃修改依赖网络。

### web/src/views/admin/NoteEdit.vue（392 行）

- 职责：手记写作/编辑——Markdown 写作与预览、九宫格图（≤9）、心情/地点、摘要、置顶，草稿与发布两个出口。
- 结构：`editor-head`（标题 + `charCount/20000`）→ 自研 `md-editor`（`.md-tabs` 写作/预览按钮 + `.note-textarea` 或 `v-html` 预览）→ 图片九宫格（`<label class="image-add">` 包 hidden `input[multiple]`）→ `meta-row`（心情 + 6 个 `MOODS` chip、地点）→ 摘要 → `el-switch` 置顶 → `actions`（取消/存草稿/发布·更新）。
- 状态：`form{content,images,excerpt,mood,location,is_pinned,status}`、`mode`、`uploading/savingDraft/publishing`、`dirty`、`suppressWatch`（`let`，非响应式）、`isEdit`、`charCount`（UTF-16 码元）、`previewHtml`。
- 逻辑：`watch(form,{deep:true})` 必须写在 `form` 之后（:121-122 注释记录 TDZ 会让 setup 抛错、页面静默空白）；`onPick` 串行上传、逐张校验类型与 5MB、单张失败只累加 `failed`、`res.url` 入数组；`save` 用 `suppressWatch` 包住 `form.status` 赋值 + `await nextTick()` 后再清 `dirty`（:192-207 注释详述 deep watch 的 `flush:'pre'` 会让复位后的回调重置脏标记，导致路由守卫误判"未保存"）；`beforeunload` + `onBeforeRouteLeave` 双保护；编辑态回填同样用 `suppressWatch` 包裹并在 `nextTick` 后清脏。
- 依赖：`XIcon`、`noteApi`、`uploadApi`、`adminHref`、`@/utils/markdown`（`renderMarkdown`、`addImgAttrs`）。
- 接口：`GET /notes/admin/:id` → 行数据 + `content`（AES-GCM 密文，`content_enc/content_key`，拦截器用请求时票据解密）；`POST /notes` → `{id}`（`cleanMarkdown(content,20000)`、`excerpt` 空则 `buildExcerpt`、图片最多 9）；`PUT /notes/:id`（patch 语义，首次发布才补 `published_at`）；上传复用 `POST /upload`。
- UI：预览 HTML 已经 `DOMPurify.sanitize`（`renderMarkdown` 内），`addImgAttrs` 在净化后补 `loading/decoding/aria-label`；`.spin` 在 `prefers-reduced-motion` 下停用；`.meta-row` ≤700px 单列。
- 副作用：`dirty` 完全依赖 watch，任何绕过 watch 的赋值都会失准；上传无进度；无本地草案。

### web/src/views/admin/NoteManage.vue（271 行）

- 职责：手记列表——关键词/状态/排序筛选、置顶切换、编辑跳转、单条与批量（发布/转草稿/置顶/取消置顶/删除）。
- 结构：`toolbar`（搜索 + 状态 `el-select` + 排序 `el-select` + `router-link` 写手记；`batch-row` 在选择非空时出现）→ `el-table`（选择列、置顶 Pin + `excerpt` 省略 + 图片数徽章 + mood/location 副行、状态 tag、点赞、时间、操作）→ `el-pagination`。
- 状态：`list/loading/selection/busyId`、`query{keyword,status,sort}`、`pagination{page,pageSize:10,total}`、`isMobile`。
- 逻辑：`load` 显式传参并 `Object.assign(pagination,{total})`；`reload` 复位页码；`togglePin` 用 `batchUpdate([id], 'pin'|'unpin')` 后本地翻转 `row.is_pinned`（不重载），`busyId` 只禁用置顶按钮；`remove` 用 `content` 去空白前 40 字做确认引述；`batch(action)` 与服务端四种 action 对齐，清选择后重载。
- 依赖：`XIcon`、`noteApi`、`adminHref`、`formatDateTime`、`useIsMobile`。
- 接口：`GET /notes/admin/list` → `{list:[noteSummary + content],pagination}`（`latest` 按 `is_pinned desc, created_at desc`，`oldest` 按创建升序）；`POST /notes/batch-update {ids,action}`（≤500，`publish` 事务补 `published_at`）；`POST /notes/batch-delete`；`DELETE /notes/:id`。
- UI：副行用 `min-width:0 + nowrap + ellipsis` 防自由文本顶破单元格；无 CSV 导出（与其他管理页不同）。
- 副作用：批量后未调 `tableRef.clearSelection()`；删空末页不回退。

### web/src/views/admin/Login.vue（378 行）

- 职责：后台登录——账密 + 可选 TOTP 第二步、记住用户名、已登录直达仪表盘、密码可见性切换。
- 结构：原生 `<form @submit.prevent>` + 两个 `.field`（`label[for]` 配 `input[id]`，`autocomplete` 分别为 `username`/`current-password`/`one-time-code`）+ `transition` 包裹的 TOTP 字段 + 提交按钮 + 记住用户名 + 返回首页。**不用 Element Plus 表单组件**，仅 `ElMessage`。
- 状态：`form{username,password,totp_code}`、`showPass/loading/needTotp/remember`；`safeGet/safeSet/safeRemove` 包住 `localStorage`（隐私模式降级）。setup 顶层 `watchEffect` 设标题。
- 逻辑：`getAuthToken()` 存在即 `getAdminPath().then(key => router.replace('/'+key+'/dashboard'))`；`watch(needTotp)` 在下一 tick 聚焦；`autoSubmitTotp` 对 6 位数字自动 `submit()`（靠 `loading` 防重）；`submit` 逐项校验 → `auth.login`（Pinia 内 `setAuthSession` 写 sessionStorage）→ 按 `remember` 写/删 `xalor_remember_user` → `is_default_pwd` 警告初始密码 → `await getAdminPath()` 后跳转；`catch` 用 `/两步验证|验证码/` 判断是否展开 TOTP。
- 依赖：`XIcon`、`@/stores/auth`、`@/utils/adminPath`、`@/utils/authSession`。
- 接口：`POST /auth/login {username,password,totp_code?}` → `{token,user,is_default_pwd}`；失败 401 + `message`（TOTP 场景为"两步验证码错误"）；登录页同样要过票据/签名闸门。
- UI：`100dvh` + 径向渐变光晕；≤400px 收紧内边距；密码切换按钮带 `aria-label` + `title`；`.fade-slide` 入场动画（未做 reduced-motion 降级）。
- 副作用：`getAdminPath()` 失败静默停在登录页；过期 token 会先跳仪表盘再被 401 拦回。

### web/src/views/admin/TagManage.vue（246 行）

- 职责：标签创建、合并（A 的文章关联转到 B 后删 A）、删除 + 本地搜索 + CSV 导出。
- 结构：`create-card`（**原生** `input` + `button`，回车创建；filter-row 搜索 + 导出）→ `el-table`（`# name`、`article_count` 徽章、合并/删除）。
- 状态：`list/searchKey/loading/creating/exporting/newName`、`filteredList`。
- 逻辑：`create` 有 `creating` 保护 + 空名 warning（注释记录原实现是静默 return）；`remove` 把 `article_count` 写进问句；`mergeTag` 用 `ElMessageBox.prompt`（带 `inputValidator`）取目标名，本地按 `id !== row.id && name.toLowerCase()` 查找，找不到先 warning 不发请求，再 `tagApi.merge(from,to)`；`exportCsv` 与分类页同一套 `esc` + BOM。
- 依赖：`XIcon`、`tagApi`、`downloadBlob`。
- 接口：`GET /tags`（`article_count desc`，返回 `id/name/slug/article_count`）；`POST /tags {name}`（重名报"标签已存在"，slug 由 `slugify` 生成）；`DELETE /tags/:id`（事务清 `article_tags` 后删）；`POST /tags/merge {from_id,to_id}`（事务：迁移关联 `onConflict().ignore()` → 删源 → 回"已将「A」合并至「B」"）。
- UI：`max-width:720px`；创建区原生控件与其他页 `el-input` 风格不一致；操作列 `fixed="right"`。
- 副作用：`mergeTag` 整段一个 `try/catch`，服务端失败与用户取消同分支；`load()` 无 `catch`。

---

## 观察

1. `web/src/views/admin/MessageManage.vue:5`、`:11`、`web/src/views/admin/LinkManage.vue:5` —— `@change="load"` 收到的是 radio/checkbox 的新值，被当成 `load(p)` 的页码，于是 `page.value` 变成 `'pending'`/`true`，分页器 `current-page` 失真；`CommentManage.vue:6` 写 `load(1)` 才是对的。
2. `web/src/views/admin/CategoryManage.vue:70-76` 与 `:58-69` 的注释矛盾：注释称已改为 `:model-value` + `@update:model-value` 手动接管、所有关闭入口走 `requestClose()`，代码仍是 `v-model`、全文件无 `requestClose`；`close-on-press-escape` 默认开，按 Esc 直接关窗绕过 `cancelEdit()`（:193）的未保存确认。
3. `web/src/views/admin/Login.vue:128` —— `document.querySelector('.field input')` 命中的是第一个 `.field` 里的用户名框，不是 `#login-totp`；"2FA 出现时自动聚焦验证码"的注释与行为不符。
4. `web/src/views/admin/Login.vue:166-171` —— 靠正则匹配服务端文案决定是否展开 TOTP：任何含"验证码"的失败（限流/风控）都会误开第二步，且首轮真实错误降级成 toast；服务端改字即失效。
5. `web/src/views/admin/Login.vue:112-116` —— 有 token 就跳仪表盘、不校验有效性，过期 token 会闪一次仪表盘再被 401 打回；`getAdminPath()` 失败无提示。
6. `web/src/views/admin/ImageManage.vue:87-96` —— 搜索只改 `filteredFiles`，`imgPage` 不重置；停在第 N 页再搜索且命中不足 `(N-1)*60` 时网格为空，被误读成"没有这张图"（`load()` 在 :118 复位了页码，搜索路径漏了）。
7. `web/src/views/admin/ImageManage.vue:320-337`、`:344-348` —— 操作容器 `.cell-actions` 默认 `opacity:0`、仅 hover 显形；媒体查询只把子元素 `.del-btn` 设为 1，父容器仍为 0，≤640px 触摸设备上复制/删除不可见。另 `.del-btn` 在 :307-317 留着被 `.cell-actions .del-btn{position:static}` 覆盖的旧规则。
8. `web/src/views/admin/ImageManage.vue:33`、`:42-47` —— 缩略图靠 `<img @click>` 预览，无 `tabindex`/`role`/`keydown`，键盘不可达；两个图标按钮只有 `title` 无 `aria-label`。叠加第 7 条，聚焦时按钮不可见。
9. `web/src/views/admin/ImageManage.vue:116-128` —— 服务端 `/uploads/list` 硬截 500 条（`server/src/routes/admin.js:1897`），页面无截断提示；第 500 张之后既看不到也删不掉。
10. `web/src/views/admin/CommentManage.vue:344-357` —— 批量 AI 复核无确认、无"待审将被公开"警告，`Promise.all` 并发 N 次 AI 调用；同一动作在 `MessageManage.vue:363-375` 有确认 + 计数 + 风险文案。评论页误点即可按 AI 结论直接公开待审评论。
11. `web/src/views/admin/CommentManage.vue:226-251` —— "全部通过"与留言页语义不同：`/comments/approve-all`（`server/src/routes/admin.js:1113-1125`）不跳过 `ai_reason` 非空条目，`/messages/approve-all`（:1380-1404）会跳过；评论页确认文案也没提示带 AI 标记的会被一起通过。
12. `web/src/views/admin/CommentManage.vue:267`、`web/src/views/admin/MessageManage.vue:238` —— 导出 URL 硬编码 `/api/${key}/...` 忽略 `VITE_API_PREFIX`，而 `signedFetch` 的签名 path 按 `API_PREFIX` 剥离（`web/src/utils/signedFetch.js:41-47`）；前缀一改就同时 404 + 签名不匹配，只显示"导出失败，请重试"。
13. `web/src/views/admin/CommentManage.vue:190-197` —— 文章筛选下拉只取 `pageSize:100`（服务端上限即 100，`server/src/routes/admin.js:43`）的第一页，文章超过 100 篇时更早的文章无法参与筛选。
14. `web/src/views/admin/CommentManage.vue:32`、`:35`、`web/src/views/admin/MessageManage.vue:22`、`:25` —— 使用 `.export-btn`，另有 `.ai-tag`/`.ai-none`（:79-83 / :50-54），这些类在各自 scoped 样式里都没有定义（`.export-btn` 只在 `SecurityManage.vue:659` 的 scoped 块），属空引用类名。
15. `web/src/views/admin/LinkManage.vue:128-135` —— 排序复用 `PUT /links/:id/status` 并回传 `status: row.status`；该行状态若已在别处变更，改排序会把页面里的陈旧状态整 patch 写回，审核结果被静默回滚。
16. `web/src/views/admin/CategoryManage.vue:221-233` —— `saveEdit` 全量提交含 `slug`；用户清空 Slug（placeholder 写"留空自动生成"）时服务端按名称重生 slug（`server/src/routes/admin.js:860-864`），对外分类 URL 改变、前台链接失效，前端无提示也无法回滚。
17. `web/src/views/admin/HomeSettings.vue:232-236` —— 保存成功即提示"已保存"，但非法值（`home_site_url` 带 query/hash、`home_status` 越界、社交项 URL 非法）在服务端被 `continue` 静默丢弃（`server/src/utils/settings.js:157-186`），前端不重读，用户以为生效。
18. `web/src/views/admin/HomeSettings.vue:196` —— "放弃修改"实现为 `await load()` 重新拉接口而非回滚本地 `baseline`：离线/失败时无法放弃，且会连带覆盖成服务端当前值。
19. `web/src/views/admin/NoteEdit.vue:175-183` 与 `:63-70` —— payload 恒带 `excerpt`（可能空串），服务端 `if (excerpt !== undefined) patch.excerpt = cleanText(excerpt,500)`（`server/src/routes/admin.js:707`）会覆盖自动摘要，只有创建分支有 `buildExcerpt` 兜底；"留空则自动取正文前 200 字"在编辑场景不成立。
20. `web/src/views/admin/NoteEdit.vue:146` —— `files.slice(0, room)` 静默丢弃超出名额的图片，只有上传失败才提示（:167）；一次选 12 张、剩 3 个空位时另外 9 张毫无反馈。
21. `web/src/views/admin/NoteEdit.vue` 全文 —— 无 `localStorage` 草案兜底（对比 `ArticleEdit.vue:336` 的 `xalor_draft_`，且 `authSession.js:55` 登出时清理该前缀），长文本刷新即丢，与文章编辑页可靠性不对等。
22. `web/src/views/admin/NoteManage.vue:71` —— 操作列 `fixed="right"` 写死未按 `isMobile` 解除（其他页写作 `:fixed="!isMobile ? 'right' : false"`），窄屏固定列遮内容，且 110px 塞三个 link 按钮必然换行。
23. `web/src/views/admin/NoteManage.vue:199-217` —— 批量删除后不回退页码（删空末页停在空白页），且缺 `tableRef.clearSelection()`（`CommentManage.vue:303-318` 有长注释说明为何需要），内部选中态与 `selection` 可能短暂不一致。
24. `web/src/views/admin/TagManage.vue:125-149` —— `mergeTag` 含 `await tagApi.merge` 的整段都在 `catch { /* 取消 */ }` 内，服务端 404/500 与用户取消同分支，除拦截器 toast 外无从区分。
25. `web/src/views/admin/TagManage.vue:151-167`、`web/src/views/admin/CategoryManage.vue:256-272` —— 导出用 `filteredList` 但空判断用 `list`：搜索命中 0 条时仍导出只有表头的 CSV 并提示"已导出"。

## 小结

- 位置：这 10 个视图构成后台的"内容与运营"半边（审核队列、分类/标签字典、友链、上传目录、主页运营参数、手记生产与列表、登录），全部挂在 `/:adminKey` 秘钥段、依赖 JWT + 票据 + 指纹 + HMAC 四重校验；不含文章编辑、安全中心与站点设置。
- 共同模式：列表页统一"过滤条 → `el-table` → 选择态批量栏 → `el-pagination`"，脏态/重入/空选择全靠手写标志位；服务端分页（评论/留言/手记）与本地过滤分页（分类/标签/图片/友链）混用，是页码类 bug 的集中来源。
- 契约面：写操作都是 patch 语义的后台端点，白名单清洗与钳制在服务端；前端多处把这种"静默丢弃"当成成功（主页设置、分类 slug、摘要），产生"提示保存成功但值没变"的一类问题。
- 风控面：审核页是 AI 结论的最后闸门，评论与留言两个页面对"一键通过 / 批量复核"的风险处理完全不对称（留言有确认与 AI 跳过，评论没有），是本区最应优先统一的一处。
- 可靠性/可达性薄弱点集中在图片页（hover-only 操作、键盘不可达、搜索不重置页码、500 条上限无提示）与手记页（无本地草案、超量图片静默丢弃），都是日常运营会真实踩到的路径。
- 代码卫生：多处注释记录了历史修复（`clearSelection`、`suppressWatch`、`downloadBlob`），但 `CategoryManage` 的对话框注释已与实现脱节，另有空引用类名与 `ImageManage` 的重复 `.del-btn` 规则，说明该区迁移过但未收尾。
