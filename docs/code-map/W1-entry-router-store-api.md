# W1 · 入口 / 路由 / 状态 / API 客户端 / public 脚本

23 文件、1933 行，逐行读完（无 >2000 行）。路径省略 `web/`。

### vite.config.js（123 行）
职责：双入口构建、dev/preview 反代、EP 按需、terser。逻辑：`loadEnv` 取前缀/`DEV_HOST`/`ENC_SALT`/`PROXY_TARGET`（非本机目标注入 `Origin`/`Referer`），`define` 固化前缀与盐，`input` 双 html，`/api`+`/uploads` 反代在 server/preview 各写一遍。依赖：两 html。接口：后端须同挂同前缀。风险：`drop_console:true` 剥全部 console。

### index.html（75 行）
职责：博客壳（meta/OG/CSP/骨架/脚本序）。结构：`#app` 内 `.boot-skeleton`+`role=status`；`#float-dock` 在 `#app` 外供 teleport；head 同步 `theme-init.js`、`anti-debug.js`，body 末 `main.js` 后接 `boot-guard.js`（classic 先于 module）。接口：`rel=alternate`→`/api/rss.xml`（硬编码）。UI：`viewport-fit=cover`、`interactive-widget=resizes-content`、不禁缩放；CSP `script-src 'self'`，`connect-src` 放行 `v1.hitokoto.cn`。风险：`?v=` 是 public 脚本唯一缓存键。

### home.html（59 行）
职责：主页壳，换 title/OG/`manifest-home.json`/`main-home.js`。结构：骨架 div **无 class**（仅内联样式）。依赖：三 public 脚本。接口：同样硬编码 `/api/rss.xml`。UI：CSP 与博客逐字同。风险：无 `.boot-skeleton` → `boot-guard` 恒失效。

### .env.example（22 行）
职责：环境变量契约：前缀、可选 `VITE_ENC_SALT`、`VITE_DEV_HOST/ALLOWED_HOSTS`、`VITE_BLOG_URL/HOME_URL`（后两者靠 Vite 原生注入，未进 `define`）。仓库内无 `.env`，全走默认。

### src/main.js（154 行）
职责：博客装配+全局错误提示+挂载兜底+PoW 预热。逻辑：`migrateLegacyKeys/Prefix`、`getAuthToken/getCachedAuthUser` 空跑；`online/offline`→`ElMessage`；`notifyUnexpected` 抑制 401/403 与 `ERR_CANCELED`、4s 一条；`unhandledrejection`+`window.error`(仅带 `e.error`)+`app.config.errorHandler` 三路汇入；`theme.apply()` 先于 mount；`try/catch` 包 `mount`，失败清空 `#app` 手造 `role=alert` 提示+刷新钮；末尾 `ensurePass()`。依赖：`App.vue`、`router`、`stores/theme`、`directives/reveal`、`utils/pass|secureStorage|authSession`、EP 样式。

### src/main-home.js（64 行）
职责：主页装配。逻辑：迁移/预热/网络提示同上；`unhandledrejection` 与 `errorHandler` 仅 `console`；`mount` 无 try/catch、无兜底 UI。依赖同上（换 `router/home`）。接口：注释声明手记需票据、`/home/summary` 免票。风险：兜底全面弱于博客入口。

### src/App.vue（27 行）
职责：根组件。结构：`el-config-provider :locale=zhCn :message={placement:'top-right',offset:72,grouping:true}`、`RouteProgress`、`router-view`+`transition page-fade mode=out-in :duration={220,200}`（显式时长防后台标签页帧冻结）、`onMounted` 调 `initMarkdownInteractions()`（委托一次）。依赖：`element-plus/es/locale/lang/zh-cn`、`RouteProgress.vue`、`utils/markdown`。风险：`offset:72` 与 `api` 的 `96` 不一致。

### src/router/index.js（22 行）
职责：博客表 `[...blogSiteRoutes, ...adminRoutes, blogNotFoundRoute]`，`createAppRouter({siteName:'Xalor的小站', notFoundName:'not-found'})`；顺序即优先级。

### src/router/factory.js（74 行）
职责：共用 router + 唯一守卫（hash）。逻辑：`scrollBehavior` 先 `savedPosition`，否则读 `history.state.scroll`（`top>0` 才用），同 name+path 仅改 query→`false`，余 `{top:0}`；`beforeEach`：无 `adminKey` 只写 title；有则缓存比对，缺/不等→`getAdminPath()`/`refreshAdminPath()` 重取，仍不等→404，`requiresAuth` 无 token→`replace` 到 `/${adminKey}/login`。依赖：`utils/adminPath`（失败返 `''`）、`utils/authSession`。风险：守卫内一次网络 RT。

### src/router/home.js（20 行）
职责：主页表 `[...homeSiteRoutes, ...adminRoutes, homeNotFoundRoute]`，`siteName:'Xalor'`、`notFoundName:'home-not-found'`。

### src/router/routes-site-blog.js（32 行）
职责：博客前台+404。结构：`/`→`views/site/Layout.vue`，children `home`/`articles`/`article/:slug`/`archive`/`tags`/`about`/`links`/`messages`/`bookmarks`/`history` 全懒加载；404=`/:pathMatch(.*)*` 复用同 Layout，子路由名 `not-found`。

### src/router/routes-site-home.js（22 行）
职责：主页前台+404。结构：`/`→`views/home/Layout.vue`，children `home-index`（无 title）、`home-notes`、`home-note-detail`（`notes/:id`，后两者 `meta.title:'手记'`）；404 名 `home-not-found`，同样复用 Layout。

### src/router/routes-admin.js（42 行）
职责：两域共用后台，全懒加载。结构：`/:adminKey/login`(`admin-login`)；`/:adminKey`→`views/admin/Layout.vue`(`requiresAuth`)，空路径函数式 `redirect` 到 dashboard，children：dashboard、articles(+new、:id/edit)、notes(+new、:id/edit)、home-settings、categories、tags、comments、links、messages、images、security、audit、settings。

### src/stores/auth.js（65 行）
职责：会话状态。逻辑：`token/user` 取自 `getAuthToken()/getCachedAuthUser()`，`isLoggedIn=!!token`；`login` 写 ref+`setAuthSession`；`logout` **先** `await authApi.logout()`，失败 `revoked=false`，`finally` 里 `clearAdminDrafts()`→`clearSession()`→`useAdminStore().$reset?.()`；`fetchMe` 异常吞掉仍返旧 `user`。接口：`/auth/login`(`{token,user}`)、`/auth/me`、`/auth/logout`，带 `Bearer`。风险：`$reset` 无效。

### src/stores/theme.js（196 行）
职责：主题三态+8 色强调色→CSS 变量。逻辑：`mode` 读 `xalor_theme` 兜底 `auto`；`isDark=dark||(auto&&系统深)`；`accent` 严格正则否则 `#e4573d`；`apply()` 写 `data-theme`、`--accent`(深混白.28)、`--accent-soft`(深向`#12110f`混.82)、`--accent-deep`、`--accent-text`、`--accent-fill`(恒 `shade .24`)、`--el-color-primary` 与 `light-3/5/7/8/9`、`meta[theme-color]`；`withTransition` 优先 `startViewTransition`，`reduced-motion` 直切，否则 450ms 过渡；`toggleTheme` auto→light→dark；`watchEffect(apply)`+`matchMedia`。依赖：无。风险：`mq` 不注销；深色 EP 色阶算坏。

### src/stores/home.js（29 行）
职责：主页摘要缓存。逻辑：`load(force)` 有值直返，否则 `fetchHomeSummary()`，异常只置 `failed`，`finally` 复位 `loading`。接口：`GET /api/home/summary`（免票）。风险：无取消，卸载后仍写 store。

### src/stores/admin.js（27 行）
职责：待审角标。逻辑：`fetchPending` 先 `await getAdminPath()` 再 `statsApi.dashboard()`，`data.pending` 兜零；`totalPending()` 普通函数。接口：`GET /api/<adminKey>/stats/dashboard`。风险：异常吞掉且不置 `loaded`，「0 条」与「失败」不可辨。

### src/stores/site.js（73 行）
职责：设置/访问统计/阅读统计三份缓存。逻辑：`fetchSettings` 后 `setServerTzOffset(settings.server_tz_offset_min)`；`fetchStats` 以 `Number(...)||0` 收窄 6 指标、失败留旧值；`fetchReading` 独立 `ref(null)`，失败保持 null 让 UI 整块不渲染；`init()` 用 `loaded` 幂等+`Promise.all`。接口：`GET /settings`、`/stats/summary`、`/stats/reading`。

### src/api/index.js（426 行）
职责：唯一 axios 实例（票据/指纹/JWT/签名/解密/错误分流）+全端点。逻辑：请求拦截 `await ensurePass()`→`X-Fp`/`X-Pass`/`_ticket`/`_rawData`(普通对象 body，防重签哈希翻倍)/`Authorization`；`X-Sig=HMAC(ticket,"METHOD|path(去query)|ts|sha256(body)|jti|nonce")`，`jti=ticket.split('.')[1]`；响应 `code!==0`→`toastOnce`+reject，`content_enc` 用 `_ticket` 解密并置 `content_decrypt_failed`，否则补 `message` 返 `data`；401 清 store+跳 `#/<key>/login`，403 通行证→`forceRefresh` 后 `restoreRawBody` 重试一次，404 旧秘钥→`refreshAdminPath` 换 URL 重试，429/403+`retry-after` 用 warning，`recentToasts` 4s 去重。
导出：`authApi`(sessions/2fa)、`articleApi`(slug/random/archive/neighbors/related/like+admin CRUD/batch/duplicate/import)、`categoryApi`、`tagApi`(merge)、`commentApi`(re-ai/export)、`linkApi`、`messageApi`(reply)、`hitokotoApi`(silent)、`statsApi`(record/summary/reading/dashboard)、`settingsApi`(export/import/test-mail)、`securityApi`(test 用 `text_b64` 绕 WAF body 扫描)、`auditApi.clear`(DELETE body)、`uploadApi`(FormData)、`imagesApi`、`noteApi`。依赖：`utils/pass|fingerprint|crypto|adminPath|authSession`。UI：`ElMessage(showClose,offset:96)`、`config.silent`。风险：`adminUrl` 缺缓存即 reject。

### src/api/homePublic.js（45 行）
职责：主页摘要免票裸 `fetch`。逻辑：`BASE=VITE_API_PREFIX||'/api'`；自建 `AbortController`+8s 超时（`DOMException('timeout','TimeoutError')`），合并外部 `signal`（已 abort 立即 abort，否则一次性监听）；非 2xx 抛 `HTTP <status>`，`code!==0` 抛 message；`finally` 清 timer 与监听。接口：`GET /api/home/summary`→`{code:0,data}`。

### public/theme-init.js（56 行）
职责：CSS 前同步对齐主题防闪白。逻辑：IIFE+try；`saved==='dark'||(saved!=='light'&&系统深)` 才写 `data-theme`；校验 accent 后自算 `--accent`(混白.28)、`--accent-deep`(深.4/浅`shade .28`)、`--accent-text`、`--accent-fill`(恒.24)、`--accent-soft`(深`c*.18+18*.82`)。依赖：无（复制数学，靠 `scripts/test-theme-init-parity.mjs` 钉住）。风险：不写 `--el-color-primary*`。

### public/boot-guard.js（51 行）
职责：12s 启动超时兜底（覆盖 import 链断裂/非 ESM）。逻辑：`#app` 内仍有 `.boot-skeleton` 才清空并造 `role=alert` 提示+刷新钮，否则视为已挂载返回。依赖：与 `index.html` 类名硬耦合。风险：主页因类名缺失不触发。

### public/anti-debug.js（229 行）
职责：客户端反调试 v4。逻辑：`xalor_dev_mode==='1'` 直退；`IS_MOBILE`（UA-CH→UA 正则含 `EdgA/`、`EdgiOS/`→`MacIntel&&maxTouchPoints>1`）；三判据：元素探针（120×90↔121×91 读两次 `offsetWidth/Height`）、窗口差（仅桌面 320px）、`debugger` 计时（仅桌面 150ms）；1200ms 轮询、`document.hidden` 跳过、连续 2 次才 `triggerAntiDebug()`（无限 debugger 0ms 自循环+`#__x_shield__` 全屏层+横幅），`strikes===0` 时 `releaseShield()` 摘层并 `clearTimeout`；捕获阶段拦 F12、Ctrl+Shift+I/J/C/K、Ctrl+U、非输入区 Ctrl+S（输入区与 Ctrl+P 放行）；静默 `console.log/info/warn/debug/trace`（error 保留）；覆写 `window.eval`。依赖：注释指向 `src/utils/copyGuard.js`（复制/右键按开关）。UI：遮蔽层 `z-index:2147483647`、硬编码浅色。风险：每 1.2s 强制 layout。

## 观察

路径省略 `web/`。

1. `home.html:46`+`public/boot-guard.js:21` — 骨架 div 无 `.boot-skeleton`，12s 兜底在主页永不触发，`main-home.js:61` 也无可视兜底。
2. `src/stores/theme.js:98,103-107,175-182` — `brightBase` 是 `rgb(...)` 又进 `mix()`，`parseHex` 得 `NaN`，深色 `--el-color-primary-light-*` 出 `rgb(NaN, NaN, NaN)` 被丢弃，EP 深色色阶退回默认。
3. `public/anti-debug.js:206-207` vs `vite.config.js:95-97` — 注释称生产保留 `console.error`，实际 `drop_console:true` 全剥，`main.js` 兜底日志无输出。
4. `public/anti-debug.js:99,121,148-151` — terser 默认 `drop_debugger`：检测 3 恒 false，`infiniteDebug` 退化 0ms 定时器自循环，只有 `releaseShield()` 能停。
5. `src/main-home.js:54-61` vs `src/main.js:101-104,123-151` — 双入口漂移：主页 `errorHandler` 只 console、无 `unhandledrejection` 提示、`mount` 无 try/catch。
6. `src/stores/auth.js:39-40` — `$reset?.()` 在 setup store 上是 `noop`（生产）/抛错（开发，被空 catch 吞），登出后 `admin.pending` 不清零。
7. `src/api/index.js:237-264` — `adminUrl()` 只读缓存、缺失即 reject；`stores/admin.js:13` 却先 `await getAdminPath()`，策略不一 → 首次后台请求可能必失败。
8. `src/api/index.js:135-138`+`main.js:66-74` — 业务错误 reject 裸 `Error`（无 `status`），绕过 401/403 抑制，再弹「页面遇到了一点问题」，与 `toastOnce` 双 toast。
9. `src/api/index.js:17-28` — 签名不含 query，`page`/`status`/`days` 可被改写而不破坏 `X-Sig`，GET 的 body 哈希恒为 `{}`。
10. `src/api/index.js:397-403,77-79` — `FormData` 有 `append` 故不存 `_rawData`，签名按 `JSON.stringify(FormData)==='{}'` 算，与 multipart 字节无关。
11. `src/router/factory.js:61,64` — `{name:notFoundName}` 未带 `pathMatch`，父路由 `/:pathMatch(.*)*` 为可选段，可能解析回 `/`：本该 404 却静默回首页（需实测）。
12. `src/router/factory.js:35-38` — `history.state.scroll` 不区分前进/后退，push 新页若 state 带 `{top>0}` 会从中途开始。
13. `src/stores/theme.js:152,159,162`+`main.js:108` — `watchEffect(apply)`/`apply()`/`withTransition(apply)` 三处触发同函数，首屏算两遍全色。
14. `src/api/index.js:141-156` — 只解密 `data` 顶层 `content_enc`；列表若在 `items[].content_enc` 加密则不解密也不置 `_failed`，正文空白无告警。
15. `public/anti-debug.js:216,222-228` — 覆写 `window.eval` 用 `console.warn` 提示，该渠道已被 `209-220` 置空，提示永不出现；依赖 `eval` 的库静默失败。
16. `index.html:8`、`home.html:8` — RSS 硬编码 `/api/rss.xml`，与 `vite.config.js:13` 可配前缀脱钩，改前缀后订阅失效。
17. `public/theme-init.js` 全文 — 只写 accent 五变量、不写 `--el-color-primary*`，首屏 EP 按钮/链接仍默认蓝，挂载后跳色。

## 小结

1. 启动层：vite 双 input+两份 HTML+两份 `main`，差异本应只有路由与站名，实际在错误兜底、骨架类名已漂移。
2. 安全边界三处：`factory.js` 的 `adminKey` 守卫、`api/index.js` 的票据+HMAC+解密、`public/` 三脚本；前者权威，后者纯客户端且被 terser 部分废掉。
3. 契约统一：同一 axios 实例承载 `{code,message,data}`、`X-Fp/X-Pass/X-Timestamp/X-Sig/X-Nonce/Authorization` 与拦截器内解密；`/home/summary` 是唯一免票裸 fetch。
4. 后台可达性是缓存链：`getAdminPath`→localStorage→守卫比对→401 跳登录/404 刷路径重试，任一环失效即静默 404 或空壳。
5. 主题两套并行实现，一致性靠 `scripts/test-theme-init-parity.mjs` 常量表，但表不覆盖 `--el-color-primary*`，正是 NaN 缺陷藏身处。
6. 边界：不含视图组件、样式与 `utils/*` 内部实现；PoW/指纹/加解密/格式化只按调用点记录。
