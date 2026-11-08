# Xalorblog 代码地图（全量通读结果）

> 生成方式：把仓库里**所有**手写源码逐行读完（不含 `node_modules/`、`web/dist/` 构建产物、`reference/` 第三方参考项目），
> 每个分区一份结构化笔记落在 [`docs/code-map/`](code-map/)，本文件是跨分区的合并视图。
> 阅读顺序建议：本文件 → 分区笔记 → 具体文件。

## 1. 这是什么

Vue 3 + Vite + Pinia 前端 与 Express + Knex + MySQL 8 后端组成的**个人站**，一套后端 + 一套后台服务两个域名：

| 入口 | HTML | 路由表 | 内容 |
|---|---|---|---|
| 博客 `blog.xalor.cn` | `web/index.html` → `src/main.js` | `router/index.js` → `routes-site-blog.js` | 文章、归档、标签、分类、评论、留言、书签 |
| 个人主页 `xalor.cn` | `web/home.html` → `src/main-home.js` | `router/home.js` → `routes-site-home.js` | 名片、手记时间线、最近文章、友链/关于预览 |
| 后台（两个域名共用） | — | `router/routes-admin.js` | 内容管理、审核、安全中心、设置、AI 写作助手 |

后台挂在由 `JWT_SECRET` 派生的秘钥路径 `/api/<adminPath>/...` 之下，公共前缀下探测不到任何后台路由。

## 2. 体量

| 目录 | 文件 | 行数 | 说明 |
|---|---:|---:|---|
| `server/src` | 61 | 14,317 | 18 个路由 + 12 个中间件 + 26 个工具 + 迁移/种子 |
| `server/test` | 83 | 14024 | **89 个 `*.test.js`**（78 个在离线链、18 个在集成链，**其中 7 个两条链都跑**；并集 = 88，无孤儿）+ `run.js` + `helpers/` + WAF 语料 + `run-mac.sh` |
| `server/scripts` | 2 | 490 | `bench-read-paths.js`（SQL 基线）+ `e2e-smoke.js`（端到端冒烟） |
| `web/src` | 102 | 33,083 | 35 个视图 + 14 个组件 + 30 个工具 + 5 store + 2 composables + 3 个图片资源（不计行） |
| `web/public` | 15 | 467 | `theme-init.js` / `boot-guard.js` / `anti-debug.js`（不进打包）+ 图标/manifest（8 个二进制不计行） |
| `web/scripts` | 41 | 19,900 | **37 道构建门禁** + `check-doc-numbers.mjs` + `bump-assets.mjs` + `check-theme-parity.mjs` + `lib/sourceText.mjs` + `audit-comment-reliance.mjs`（审计工具，非门禁）+ `audit-flake.mjs`（flaky 检测工具，进 flaky 检测用途，不进 build 链）
+ `test-form-token-fast.mjs`（`test-form-token.mjs` 的快速变体，省略 2.1s 等待用于日常反馈，不进 build 链） |
| **合计** | **290** | **79,957** | 另有 `deploy/`（nginx/systemd/备份）与 `blog.sql` |

> 数字口径：文本按真实行数统计（`.js` / `.mjs` / `.vue` / `.css` / `.html` / `.json` / `.txt` / `.svg` / `.sh`）；
> 二进制（png/webp/jpg）计入**文件数**但不计行数 —— 这解释了为什么 `web/public` 有 15 个文件却只有 467 行。
> 本表在**第 41 轮**首次重算，**第 57 轮**再次重算（+30 文件 / +4,400 行，
> 主要来自本轮新增的离线套件、`e2e-smoke.js`、`httpMethods.js`、`enums.js`、`check-doc-numbers.mjs`）。
> 重算后文件数变少是因为把 `web/public` 之外的统计口径统一到了「有扩展名的源码」，
> 而 `server/test` 从此前按套件数估的行数改成实测。
>
> ⚠ **离线链与集成链不是互斥的**：有 7 个文件（`sanitize` / `feed` / `requestGuard` / `likeGuard` /
> `scrapeGuard` / `contentCrypto` / `browserCrypto`）既在 `npm test` 也在 `npm run test:all` 里 ——
> 它们的主体是纯函数（可离线跑），末尾又带一小段需要服务的断言。
> 所以「53 + 16 = 62」是错的算法（实际是 69 减去 7 个重复）。本表这一行已按并集标注。

依赖面意外地窄：后端 12 个 npm 包（express/knex/mysql2/helmet/jwt/bcrypt/sanitize-html/multer/nodemailer…），
前端 9 个（vue/vue-router/pinia/axios/element-plus/marked/highlight.js/dompurify/lucide）。
没有 TS、没有测试框架、没有 ORM 模型层、没有 CI 配置——**所有门禁都是手写 Node 脚本**。

## 3. 一个请求的旅程

### 3.1 中间件链（`server/src/app.js`，顺序即安全模型）

```
X-Request-Id → gzip → helmet/安全头 → 方法白名单 → Host 校验 → 30s 超时
→ CORS → body 解析(2MB) → 全局限流(120/min) → API no-store/CSP
→ /uploads 静态（⚠ 在 WAF 之前） → WAF(异常评分) → ipGuard(信誉封禁)
→ Fetch-Metadata(写请求) → 闸门：GATE_SKIP / 爬虫 FCrDNS / 票据+签名
→ audit → Referer+时间戳 → 各路由 → 404(与 403 同形) → 错误脱敏
```

### 3.2 三条独立的信任链

| 链 | 凭据 | 覆盖 | 代码 |
|---|---|---|---|
| 票据链 | PoW 换票 → `X-Pass`(ts.jti.sig) + `X-Fp` + `X-Sig`(HMAC) + `X-Timestamp` + `X-Nonce` | 除 8 个白名单前缀外的**所有** `/api` 读写 | `middleware/gate.js`、`web/src/utils/{pow,pass}.js`、`web/src/api/index.js` |
| 表单令牌链 | `/api/anti/seed` → `form_token`(ts.nonce.sig) + 动态蜜罐字段名 | 评论/留言/友链三个公开表单 | `middleware/formToken.js`、`web/src/utils/formToken.js` |
| 身份链 | JWT(jti/iss/aud/fp) + `sessions` 表 + 指纹比对 | `/:adminKey/**` 全部后台接口 | `middleware/auth.js`、`routes/auth.js` |

三者共用 `config.jwt.secret` 派生的密钥 —— **轮换 JWT_SECRET = 同时作废票据、表单令牌、adminPath 与全部会话**。

### 3.3 免票与公开通道（有意开口，需记住）

- `GATE_SKIP`：`/anti`、`/health`、`/rss.xml`、`/sitemap.xml`、`/robots.txt`、`/share/`、`/share-page`、`/home/summary`。
- `/api/home/summary` 是唯一免票读接口，返回**固定白名单**（`routes/home.js` 的 `buildSummary`，单测锁死）。
- 搜索引擎爬虫的 GET 免票，但必须先过反向 DNS 正向确认（fail-closed，`gate.js:470`）。
- `/uploads/*` 挂在 WAF/ipGuard 之前：被封 IP 仍可取图。

### 3.4 内容加密（AES-256-GCM，传输层）

```
密钥 = HMAC-SHA256(ENC_SALT, 票据 | slug 或 "note:<id>")
密文 = base64( iv(12B) | tag(16B) | ciphertext )
```
`routes/articles.js:227`、`routes/notes.js:101` 加密下发；`web/src/api/index.js:141` 用**请求时那张票**（`config._ticket`）解密；
解密失败置 `content_decrypt_failed` 且正文为空。库内正文始终明文 —— 这不是访问控制，只是抬高批量抓取成本。

## 4. 前端两入口

- **共享**：`App.vue`、`styles/*.css`、全部 `utils/`、`stores/`、`api/`、`components/`、`directives/`、`public/*.js`。
- **差异**：仅 `main*.js`、路由表、`siteName`。← 实际已漂移：`main-home.js` 缺 `unhandledrejection` 提示与 `mount` try/catch，
  主页 `home.html` 的骨架没有 `.boot-skeleton` 类，`boot-guard.js` 的 12s 兜底在主页永不触发。
- **首屏策略**：博客等 PoW 票据；主页壳走免票 `/home/summary` 裸 fetch（8s 超时 + 重试入口），手记仍走票据。
- **主题**：两套实现必须逐值一致 —— `public/theme-init.js`（首帧，只写暗色属性 + accent 五变量）与 `stores/theme.js`（挂载后）。
  `scripts/test-theme-init-parity.mjs` 守这条；但它不覆盖 `--el-color-primary*`，而那里正藏着一个 `rgb(NaN)` 缺陷（见 §8.3）。
- **路由守卫**：`router/factory.js` 单点校验 `/:adminKey` 段是否等于服务端秘钥路径，不等则 404 形态；`requiresAuth` 无 token 跳 `/:key/login`。

## 5. 数据模型（`server/src/migrate.js` 建 14 表）

| 表 | 关键约定 |
|---|---|
| `users` | bcrypt(12)、`role`、`totp_secret/totp_enabled` |
| `sessions` | `jti` 主键、`fp/ip/ua`、`revoked`、`expires_at` —— JWT 可撤销的锚点，每用户上限 20 |
| `articles` | `slug` 唯一、`content mediumtext`、`status∈{draft,published}` 默认 **draft**、`allow_comment/allow_copy` |
| `article_tags` | `unique(article_id,tag_id)`，两侧 CASCADE |
| `categories` / `tags` | 各自 `name/slug` 双唯一 |
| `comments` | 自引用 `parent_id`、`status∈{pending,approved,rejected}` 默认 **approved**、`ai_reason`、`ip` |
| `messages` | 同上 + `reply/replied_at`、`ip` |
| `links` | 默认 **pending**（与评论/留言默认不同） |
| `notes` | `content mediumtext`、`images`(JSON)、`excerpt`、`mood/location`、`is_pinned` |
| `settings` | `key` 唯一 + `value`(JSON 字符串)；白名单 = `DEFAULT_SETTINGS` 的键 |
| `security_config` | 单行 JSON；**刻意独立于 settings**，避免 WAF 白名单随公开接口外泄 |
| `audit_logs` | 管理员操作 + `SEC-EVENT *` 安全事件 + `AUTH *` 登录事件 |
| `ip_bans` | `ip` 主键、`banned_until`、`ban_count`（IPv6 聚合到 /64） |
| `gate_tickets` | 票据 `jti` 落库，重启不丢票（唯一跨重启存活的闸门状态） |
| `visits` / `visit_uv` | 按本地日期聚合；UV 存 `sha256(day:ip:fp)` 前 32 位，不落明文 IP |

## 6. 运行 / 构建 / 测试

```bash
# 首次
mysql < blog.sql                      # 建库建账号（改占位密码）
cp server/.env.example server/.env    # DB_PASSWORD / JWT_SECRET / ENC_SALT / ALLOWED_HOSTS
cd server && npm i && npm run migrate && npm run seed && npm run dev

# 前端
cd web && npm i && npm run dev        # 127.0.0.1:5173，/api 反代到 3000

# 门禁（都很长，且是发版前置）
cd server && npm test                 # 57 个离线套件 + waf-fuzz --assert（零外部依赖）
cd server && npm run test:all         # test/run.js 的 16 个（含 9 个必须 DB 的集成套件）
cd web    && npm run build            # 先跑 20 道静态门禁 → vite 双入口构建
```

### 测试分层（为什么要分两条链）

| 链 | 内容 | 依赖 | 为什么这样分 |
|---|---|---|---|
| `npm test` | 46 个 `*.test.js` + `waf-fuzz --assert` | **无**（纯函数 / 源码契约 / 规则断言，DB 全部用 `require.cache` 注入替身） | 最快、最稳，改一处红一条。这一层能在没有 MySQL 的机器上跑 |
| `npm run test:all` | `test/run.js` 硬编码的 16 个 | 本机 MySQL + 可重启的 API | 真实链路：登录 → 票据 → 写库 → 封禁。**会清库**，别在有数据的机器上跑 |

**孤儿检测**：磁盘上存在但两条链都没登记的 `*.test.js` 会被拦下并把退出码置 1 ——
防止「写了个集成测试、跑了一次绿了、忘了登记，于是它再也不会跑」。
`test/run.js` 里原本就有一份（`warnOrphanSuites`），但它只在 `npm run test:all` 里调用，
而那条命令会清库、实际上从不运行；**第 39 轮把同一套判据搬进离线链**（`test/orphanSuites.test.js`），
现在每次 `npm test` 都查，还多查两件事：注册表里有没有指向已删除文件的条目、离线链有没有重复注册。

### 36 道 web 门禁
顺序即执行顺序（`check-disk-space` 在最前 —— 磁盘满时先给出清晰诊断；
`test-gate-integrity` 紧随其后，它是元门禁）：

```
check-disk-space → test-gate-integrity → check-doc-numbers → bump-assets --check → check-theme-parity → check-script-order → test-script-order → test-mobile-baseline
→ test-reading-prefs → test-word-stats → test-contrast-tokens → test-theme-init-parity
→ test-focus-visible → test-vhtml-safety → test-anti-debug → test-copy-guard → test-secure-storage → test-form-token → test-admin-path → test-signed-fetch → test-format → test-request-signature → test-ai-bridge → test-use-media → test-focus-trap-coverage → test-focus-trap-api → test-derived-tokens → test-a11y-interactive → test-lifecycle-cleanup
→ test-markdown-cache → test-error-states → test-social-extra → test-dead-code
→ test-message-box-style → test-heading-order → test-icon-buttons → test-form-errors
```

`npm run test:scripts` 跑**同一批 36 道**（去掉末尾的 `vite build`），
两者的漂移由 `test-gate-integrity` 钉住 —— 它原先只串了 8 道却叫「测试所有脚本」。

**每道都带自检**：先证明规则能抓到真问题，再用它审代码 —— 一道不会红的门禁没有价值
（这条判据由元门禁检查：没有自检的会被列出来，能让 build 变红的才算数）。

### 断言可信度的两层保障
本项目有一类反复出现的缺陷：**断言匹配到了注释**，于是要么假红（注释里写了「不要这么写」），
要么假绿（注释里复述了实现，而真实代码早已改掉）。

- `web/scripts/lib/sourceText.mjs` / `server/test/helpers/sourceText.js`：
  `stripCommentLines()` 按 `inBlock` 上下文剥注释（**不是**「`*` 开头就删」—— 那会把 CSS 的 `* {` 吃掉）
- web 侧 `okNote()` 显式标注「这条断言有意依赖注释」，`npm run audit:comments` 可一次性复查
- server 侧用「原文 + 剥注释」双变量：`adminRaw` 给检查注释的断言，`adminSrc` 给结构断言

⚠ 三个陷阱：`config.js` 在 **require 期**就对 `DB_PASSWORD` 硬失败（离线套件也需要它）；
`seed.js` 在 require 期就校验 `SEED_ADMIN_PASSWORD`；`migrate` 不会被启动流程自动调用 —— 忘跑也能 listen 过探活，第一条业务 SQL 才 500。

## 7. 部署边界

- `deploy/nginx.conf.example` 只有 `listen 80`，无 TLS 块；`ALLOWED_HOSTS`/`CORS_ORIGINS`/`HOME_SITE_HOST` 必须按双域名逐条配，否则全站 403 或两站串味。
- `TRUST_PROXY=loopback` 的正确性**依赖** nginx 用 `proxy_set_header X-Forwarded-For $remote_addr`（覆盖而非追加）；改成 `$proxy_add_x_forwarded_for` 就等于允许客户端伪造 IP，绕过 `ip_bans` 与信誉分。
- 所有限流/票据/信誉/去重状态都在**进程内存**（只有封禁、票据、审计落库），systemd 必须单进程；`pm2 cluster` 会让限流与票据语义按进程分裂。
- `nginx-realip-esa.conf` 的 `set_real_ip_from` 默认全注释，"复制即上线"正好是最危险档位（把封禁打在回源节点上，一个访客即可让整节点 403）。

## 8. 跨模块的结构性发现

以下是 21 份分区笔记里反复出现、需要按"主题"而非"文件"处理的模式。逐条的具体行号见各分区笔记。

### 8.1 注释与代码不符（最高频，约 60 处）
仓库注释质量很高（记录了 TDZ、axios 二次序列化、`Vary` 覆盖、EP 遮罩样式等真实坑），但存在成规模的反向漂移：
`gate.js` 头注释称"票据与 IP 绑定"（实际签名不含 IP，`ip` 形参从未使用）；
`requestGuard.js` 注释 ±5 分钟、代码 30 分钟；`formToken.js` 头注释称签名含 ip；
`db.js` 把 `-LOCAL_FILES` 注释成"拒绝除零/严格模式"；`admin.js` 声称"没有 publish 工具"却有 `publish`；
`ArticleEdit.vue` 注释断言"编辑器与详情页字数口径一致"，代码恰好相反；`stats.js` 里一条**已修复**的缺陷注释还留着（作者自己记了"差点照它去修不存在的 bug"）。
→ 建议：改代码时把注释当断言复核，或直接删掉复述实现的注释。

### 8.2 「静默失败」是默认姿态
- 前端：`decryptContent` 吞异常返回 `''`（正文空白）；`applyEncSalt` 静默拒绝；`getAdminPath` 失败返回空串；`writeSessionValue` 返回值被丢弃仍显示"已自动保存"。
- 后端：`notifyMail` 全链路 `.catch(() => resolve(false))`（SMTP 认证失败与"没配 SMTP"无法区分）；`/security/audit` 把 DB 异常伪装成空数组；`ipGuard.flushPersist` 失败回填后 `slice(-100)`，旧批次直接丢（取证数据静默损失）。
- UI：`Dashboard` 取数失败仍渲染"防护状态 稳定 / 已拦截 0"；`AiPanel` 把 403 渲染成"尚未配置模型"；`ArticleList` 的 `randomArticle` 失败无任何提示。
→ 建议：给"失败"与"零值"设计可区分的 UI 状态（骨架/错误态/空态三分），后端关键静默 catch 至少计数。

### 8.3 同一逻辑多份实现（漂移已发生）
| 逻辑 | 副本 | 已知分叉 |
|---|---|---|
| 请求签名 | `api/index.js` 与 `utils/signedFetch.js` 逐行重复 | `signedFetch` 无超时、不重试、恒发 `Bearer ` 空凭据 |
| CSV 转义 / 状态中文 | `admin.js` 三份 `esc()`、两份 `statusZh` | — |
| 剪贴板兜底 | `AskAi.vue`、`CommentItem.vue` | 未抽 `utils/clipboard` |
| 焦点陷阱 / modal 规范 | SearchModal、ImageLightbox、ShortcutHelp、AskAi | ShortcutHelp 绑在面板上、AskAi 无 `aria-modal` |
| head/meta 写入 | `utils/pageMeta.js` 与 `ArticleDetail.vue` 自建一套 | 详情页缺 `og:site_name`，默认图一处 `.png` 一处 `.webp` |
| 主题色数学 | `theme.js`、`theme-init.js`、`main.css` | 三者字面量必须同值（`0.24/0.28/0.4/0.82`）；`--el-color-primary-light-*` 在深色下算出 `rgb(NaN)` 被丢弃 |
| 占位符名单 | `requestGuard` 与 `antiSpam/aiModeration` 两套词库 | 权重不同、改一处不同步 |
| `pruneStale` | `Bookmarks.vue` 与 `History.vue` 逐字重复 | — |

### 8.4 状态一致性靠"约定"维持
`ArticleEdit` 的 `form.status` 与服务端 `articleStatus` 两套（编辑已发布文章时上报恒为 `draft`）；
`Dashboard` 今日 PV 从 `trend` 末位推导，忽略服务端专备的 `today_visit`；
`ArticleManage` 的 `selection` 副本与 `el-table` 内部选中集两套（批量动作只清副本，复选框仍勾着）；
`ArticleList` 的 `filterKey` 必须是字符串、`load()` 里的 `router.replace` 必须写 `page` —— 两条隐性契约。
`CommentSection` 的 `DRAFT_KEY` 改成函数才避免"切文章写到新文章键里"，仍有一半调用点没跟上。

### 8.5 全内存态的部署假设
`likeGuard` / `viewGuard` / `uvSeen` / `pvGuard` / `loginFails` / `totpReplay` / `issuedJti` / `puzzles` / `usedNonces` / `fpIpTracker` / `crawlerVerifyCache` / `feed` 缓存 / `summaryCache` / `readingCache` / `securitySettings.cache` / `formToken.USED` / `scrapeGuard.buckets` —— 共 17 处进程内状态。
只有 `ip_bans`、`gate_tickets`、`session` 三处落库。**单进程是隐含契约，不是优化选择**。

### 8.6 安全上"看起来有、实际没有"的地方
- 指纹（`X-Fp`）是客户端可写头：票据与 JWT 都绑它，强度等同"令牌 + 一个约定头"；把它当强绑定会高估威胁模型。
- `safeUrl` 的 IPv4 保留段判断**整块不可达**（前面 `/^[\d.]+$/` 已把所有 IP 字面量判死），与注释"按段过滤"不符。
- `cleanMarkdown` 用 `allowedTags:false + allowVulnerableTags:true`，`onclick=`/`javascript:` 原样入库，安全全押在前端 DOMPurify；一旦开 `rss_full_content` 或任何旁路渲染就是存储型 XSS。
- `admin.js` 的导入路径**绕过** `cleanMarkdown`（`content` 只校验长度），备份恢复是最现实的 XSS 入口。
- SVG 上传只枚举 5 个 `on*` 事件，`onfocus/onclick/onmouseover` 可通过校验。
- `safeCover` 只认 `/uploads/<单段名>`，而 AI 转存图是 `/uploads/ai/<name>` —— 用 AI 图当封面会被静默置空，孤儿清理也扫不到该目录。
- `stripExif.js` 的 `FF00` 分支少走一字节，导致含填充字节的 JPEG **整份回退**、EXIF 原样保留且无告警。
- `ownerBadge` 只按昵称判定"博主"，访客填管理员昵称即可拿到徽标（展示性标识，别当权限）。
- WAF 规则 `XSS-04`/`XSS-24` 的 `[^>]*` 无上界，可跨 3488 分块边界构造漏检；蜜罐项 `/api/admin`、`/api/login` 在默认前缀下永不可达。

### 8.7 端口与耗尽面
- 连接池 `max=10`：已认证请求固定 3 次 DB 往返（`hasTable` + `sessions` + `users`）；后台仪表盘一次性 `Promise.all` 18 条查询且无缓存。
- `puzzles`(5000)/`usedNonces`(8000)/`issuedJti`(20000)/`USED`(3000) 饱和后统一 **fail-closed**：刷这些全局池可以拒掉正常用户的 PoW 结果与签名请求。
- `/archive` 一次拉全部已发布文章；`notes` 列表把 `mediumtext` 全查出来只为生成摘要；`slugify` 在 14 处取全表 slug；`collectReferencedUploads` 每次扫全部正文列。
- `App.js` 用 `zlib.gzipSync` 同步压缩最大 2MB JSON；`admin.js` 上传路径 `readFileSync` 整文件两次、`statSync`/`unlinkSync` 全同步。
- `test-focus-visible.mjs`(3510 行) 串行 `readFileSync` 100+ 文件（含跨包读 `server/`），CI 里是纯阻塞。

### 8.8 可访问性：投入真实，但规范性分裂
三个模态做全了（`aria-modal` + 焦点陷阱 + 关闭还焦），AskAi 面板完全没进这套规范，ShortcutHelp 的焦点约束因绑错元素而不成立。
`reveal` 指令默认 `opacity:0`，指令失败即整块内容不可见；`main.css` 的交错延迟只写到 `nth-child(8)`。
`test-mobile-baseline.mjs:281` 的 `||` 兜底让"打开时焦点移进面板"这条断言恒真；`test-focus-visible.mjs:446` 有恒真表达式。

### 8.9 测试的真实覆盖
- 有判定力：`requestGuard`（`sigVerified` 旁路）、`allowWords`（相邻性语义）、`readingStats`（前后端对齐）、`homeSummary`（白名单深扫）、两套 crypto（命名空间隔离）。
- 近似永真：`sanitize.test.js:94`（断言的是 Promise）、`likeGuard.test.js:28`（根本没传 fp）、`security.test.js:41/202`、`lockout.test.js:60`。
- 锁排版而非行为：`cacheInvalidation.test.js`、`routeEdgeCases.test.js`、大量 `test-focus-visible` 条目（其中 `:1342` 直接匹配注释文字）。
- `run.js` 全链路 `catch` 吞错、退出码恒 0、`waitServer` 不校验状态码 → 这套 harness 适合人看，不适合 CI 判红绿；`waf-fuzz.js` 两条链路都不在。

### 8.10 后台/前台交互层的一批具体缺陷（可直接开单）
- `MessageManage.vue:5`、`LinkManage.vue:5`：`@change="load"` 把 radio/checkbox 的新值当页码，`page` 变成 `'pending'`/`true`，分页器失真（`CommentManage.vue:6` 的 `load(1)` 才是对的）。
- `CommentManage.vue:344`：批量 AI 复核对评论**无确认、无"待审将公开"提示**，且 `Promise.all` 并发 N 次 AI 调用；同一动作在留言页有确认+计数。
- `comment approve-all` 不跳过带 `ai_reason` 的条目（`admin.js:1113`），而 `message approve-all` 会跳过（`admin.js:1380`）—— 两套审核语义分叉。
- `Login.vue:166`：靠正则匹配服务端**文案**决定是否展开 TOTP 第二步，任何含"验证码"的失败（限流/风控）都会误开，服务端改字即失效。
- `CategoryManage.vue:70` 注释称已改 `:model-value` + `requestClose()`，代码仍是 `v-model` 且无 `requestClose` —— Esc 直接关窗绕过未保存确认。
- `NoteEdit.vue` 全文无本地草稿兜底（`ArticleEdit.vue:336` 有），长文本刷新即丢；`files.slice(0, room)` 静默丢弃超出名额的图片。
- `HomeSettings.vue:232`：保存成功提示"已保存"，但非法值在服务端被 `continue` 静默丢弃，前端不重读 —— 用户以为生效。
- `Layout.vue:196/214/256`、`index.html:8`、`home.html:8`：RSS 链接**五处硬编码** `/api/rss.xml`，改 `VITE_API_PREFIX` 即全失效。
- `Messages.vue:355` 的 `submit()` 缺 `if (submitting.value) return`，`Ctrl+Enter` 连按重复 POST；`Links.vue` 整页没有 `<form>`，`type=url/email` 原生校验与 Enter 提交永远不触发。
- `Links.vue:23`：友链头像 `src` 来自申请人填的任意 URL 且无 `referrerpolicy`，访客打开友链页即向第三方域名发请求（可作统计探针）。
- `Admin/ArticleManage.vue:21`：「未分类」`value=0` 被 `|| undefined` 折叠，选它实际返回全部文章（后端支持 `'0'`）。

## 9. 建议的下一步（按 ROI）

1. **修 4 个真缺陷**：`theme.js` 深色 `--el-color-primary-light-*` 的 `rgb(NaN)`；`stripExif` 的 `FF00` 分支；`admin.js` 导入路径补 `cleanMarkdown`；`safeCover` 支持 `/uploads/ai/`。
2. **把"失败"与"零值"分开**：`Dashboard`/`AiPanel`/`ArticleList` 三处错误的 UI 语义；后端 `notifyMail`/`ipGuard.flushPersist`/`/security/audit` 至少留一条可观测信号。
3. **收敛双实现**：签名（`api` vs `signedFetch`）、clipboard、焦点陷阱、meta 写入、主题色数学，各抽一份。
4. **给 `securitySettings.reload()` 加失败重试**：现在一次 DB 抖动即把默认值固化，且 `saveConfig` 会拿它当 base 覆盖库里的白名单/词库/阈值。
5. **让测试能判红绿**：`run.js` 退出码、`waitServer` 校验状态码、5 处近似永真断言重写、把 `waf-fuzz.js` 纳入门禁。
6. **文档与代码对齐**：优先 `gate.js`（IP 绑定）、`requestGuard.js`（时间窗）、`db.js`（sql_mode）、`ArticleEdit.vue`（字数口径）。

## 10. 分区笔记索引

| 分区 | 覆盖 | 文件 |
|---|---|---|
| S1 | 服务端骨架、config/db/server、10 个中间件中的 6 个 | [S1-core-and-authmw.md](code-map/S1-core-and-authmw.md) |
| S2 | IP 信誉、请求守卫、反刮取、WAF 引擎与规则 | [S2-reputation-and-waf.md](code-map/S2-reputation-and-waf.md) |
| S3 | `admin.js`（2,770 行 / 74 接口 / AI 工具集） | [S3-admin-routes.md](code-map/S3-admin-routes.md) |
| S4 | 17 个公共 API 路由 | [S4-public-routes.md](code-map/S4-public-routes.md) |
| S5 | 18 个服务端工具（加密/设置/AI/邮件/清洗/TOTP） | [S5-server-utils.md](code-map/S5-server-utils.md) |
| S6 | schema / migrate / seed / blog.sql / deploy / .gitignore | [S6-schema-migrate-seed-deploy.md](code-map/S6-schema-migrate-seed-deploy.md) |
| S7 | 24 个测试套件 | [S7-server-tests.md](code-map/S7-server-tests.md) |
| S8 | 测试执行器与协议仿真客户端 | [S8-test-harness.md](code-map/S8-test-harness.md) |
| W1 | 双入口、vite、router、stores、api、public 三脚本 | [W1-entry-router-store-api.md](code-map/W1-entry-router-store-api.md) |
| W2 | 安全/凭证工具（pass/pow/crypto/fingerprint/…） | [W2-web-utils-security.md](code-map/W2-web-utils-security.md) |
| W3 | 内容工具（markdown/highlight/wordStats/pageMeta/…） | [W3-web-utils-content.md](code-map/W3-web-utils-content.md) |
| W4 | 后台：文章编辑/管理、仪表盘、AI 面板 | [W4-admin-article-dashboard.md](code-map/W4-admin-article-dashboard.md) |
| W5 | 后台：设置、安全中心、布局、审计 | [W5-admin-settings-security.md](code-map/W5-admin-settings-security.md) |
| W6 | 后台：评论/留言/分类/标签/友链/图片/手记/登录 | [W6-admin-content-ops.md](code-map/W6-admin-content-ops.md) |
| W7 | 博客：文章详情、文章列表 | [W7-site-article.md](code-map/W7-site-article.md) |
| W8 | 博客：Layout、首页、留言板、友链 | [W8-site-layout-home.md](code-map/W8-site-layout-home.md) |
| W9 | 博客次要页 + 个人主页 5 页 | [W9-site-misc-and-home.md](code-map/W9-site-misc-and-home.md) |
| W10 | 16 个共享组件 + composable + 指令 | [W10-components.md](code-map/W10-components.md) |
| W11 | `main.css` / `markdown.css` / `list-page.css` | [W11-styles.md](code-map/W11-styles.md) |
| W12 | 8 个构建期自检脚本 | [W12-build-guards.md](code-map/W12-build-guards.md) |
| W13 | `test-focus-visible.mjs`（3,510 行 / ~145 组断言） | [W13-focus-visible.md](code-map/W13-focus-visible.md) |

---

## 11. 修复批次：2026-11-01

按 §9 的 ROI 清单执行。**原则**：每修一处，要么补一条能失败的断言，要么写清为什么不补。
所有数字都是本机实跑输出，不是估计。

### 11.1 已修

| # | 缺陷（原状） | 位置 | 修法 | 守卫 |
|---|---|---|---|---|
| 1 | 深色主题下 `--el-color-primary-light-*` 算出 `rgb(NaN,…)` 被浏览器丢弃，EP 色阶退回默认蓝 | `web/src/stores/theme.js:98` | 新增 `parseColor` 同时认 `#rrggbb` 与 `rgb()`；系数不变 | `test-theme-init-parity.mjs` 重写为「两侧真执行 + 20 组×12 变量逐字符比对 + 4 条反恒真自检」 |
| 2 | 首屏不写 EP 变量，浅色首帧默认蓝、挂载后跳色 | `web/public/theme-init.js` | 补齐 7 个 `--el-color-primary*`（与 store 同公式）；`?v=` 递增到 `20261101` | 同上（parity 覆盖 12 个变量） |
| 3 | 备份导入绕过 `cleanMarkdown`（存储型 XSS 通道） | `server/src/routes/admin.js:526` | 导入与创建/更新同等清洗，清洗后为空则跳过 | `test/importSanitize.test.js`（25 项） |
| 4 | `FF00` 分支少跳一字节 → 含填充字节的 JPEG 整份回退，EXIF 静默保留 | `server/src/utils/stripExif.js:27` | `i += 2` | `test/stripExif.test.js`（17 项；把修复回退成 `i+=1` 会红 7 条） |
| 5 | `safeUrl` 的 IPv4 保留段判断整块不可达 | `server/src/utils/sanitize.js` | 删死代码，策略明确为「IP 字面量一律拒绝」并写明理由 | `test/sanitize.test.js` +10 条（含公网 `8.8.8.8`） |
| 6 | `safeCover` 只认单段 `/uploads/<name>` → AI 转存图当封面被静默置空 | `server/src/utils/sanitize.js` | 新增 `safeUploadRel`（1-2 段、拒绝 `.`/`..`） | `test/uploads.test.js`（33 项） |
| 7 | 上传引用扫描/列表/清理/删除都只看顶层，`/uploads/ai/` 不可见、不可删、被误判孤儿 | `server/src/routes/admin.js`、新增 `server/src/utils/uploads.js` | 统一 `listUploadFiles`/`resolveUploadPath`；新增 `DELETE /uploads/*`；`imagesApi.remove` 逐段编码 | 同上 |
| 8 | `cleanMarkdown` 用 `slice` 截断会劈开代理对 | `server/src/utils/sanitize.js:136` | 改 `sliceSafe` | 现有 sanitize 套件 |
| 9 | `parseImages` 数组分支不过滤，`cover`/`image_count` 可能来自非字符串 | `server/src/utils/notes.js:17` | 两条入口同一套过滤 + 上限 | `test-focus-visible`（脏值降级断言已放宽为语义匹配） |
| 10 | `securitySettings.reload()` 失败即固化默认值；`saveConfig` 拿它当 base 覆盖库配置 | `server/src/utils/securitySettings.js` | 失败退避 30s 重试、`loaded` 只在成功时置位；保存前**读库权威行**再合并，读失败抛错 | `test/securitySettings.test.js`（21 项，零 DB） |
| 11 | `/security/audit` 把 DB 异常伪装成「没有日志」 | `server/src/routes/admin.js:2011` | `console.error` + `fail(...,503)` | 前端 `SecurityManage` 已有 `loadError` 面板 |
| 12 | 发信失败完全不可观测 | `server/src/utils/notifyMail.js` | 三分类日志（未配置 debug×1 / 收件人非法 warn×1 / 发送失败 warn），不打印收件人与正文 | — |
| 13 | 攻击事件落库失败时旧批次被新流量挤掉；失败后不再重试 | `server/src/middleware/ipGuard.js:117` | 失败批次回队首、`PERSIST_QUEUE_MAX=500`、失败重排 60s | — |
| 14 | 持久化封禁一次加载失败即整个进程不再加载 | `server/src/middleware/ipGuard.js:176` | `dbLoaded` 只在成功时置位 | — |
| 15 | 票据注释称「与 IP 绑定」，实现不含 IP；`puzzles` 存了不校验的 `ip`；`issueTicket` 有未使用形参 | `server/src/middleware/gate.js` | 删未使用形参/字段，注释改为准确描述并解释「为什么不绑 IP」 | `test/requestGuard.test.js`（27 项） |
| 16 | `requestGuard` 注释 ±5 分钟、实现 30 分钟；且该层在生产路径几乎不生效 | `server/src/middleware/requestGuard.js` | 注释改正并写明「主防线是票据+签名」 | — |
| 17 | `db.js` 把 `-LOCAL_FILES` 注释成「严格模式」 | `server/src/db.js` | 注释与代码对齐 | — |
| 18 | 指纹缺失时签发必然失效的 JWT | `server/src/middleware/auth.js` | `FP_INVALID` 前置失败；`routes/auth.js` 返回 400 | — |
| 19 | 编辑器 `form.status` 恒 `draft`（AI 上下文错误）；字数/时长与详情页口径相反；草稿看不到发布时间 | `web/src/views/admin/ArticleEdit.vue` | 同步 status、去掉 `raw:true`、发布时间始终可见、删死 import | `test-focus-visible` 相关断言 |
| 20 | 签名两份实现已分叉 | `web/src/utils/requestSignature.js`（新）、`api/index.js`、`signedFetch.js` | 唯一实现；`signedFetch` 补 15s 超时与空凭据处理 | 11 组逐字符一致性自检（旧实现 / 新实现 / 服务端参照） |
| 21 | 剪贴板兜底两份 | `web/src/utils/clipboard.js`（新）+ 两个组件 | 抽 `copyText` | 行为自检 11 项 |
| 22 | `twitter:image` 被相对 `cover` 覆盖；默认分享图 `.webp`/`.png` 分叉 | `web/src/views/site/ArticleDetail.vue` | 删覆盖、统一 `/og-image.png`、删两处死代码 | `test-focus-visible` |
| 23 | 取数失败渲染成 0 / 「稳定」/「尚未配置模型」 | `Dashboard.vue`、`AiPanel.vue`、`ArticleList.vue` | `loadError`/`securityError` 分块、`aiState` 四态、404 与网络错误分流 | 静态门禁 + build |
| 24 | 前后端阅读时长口径不一致（服务端单 350 vs 前端 cn/350+en/250），且测试把「必须不一致」写成契约 | `server/src/routes/stats.js`、`web/scripts/test-word-stats.mjs` | 服务端改 `cn/350+en/250`；断言改为**双向防回退** | `readingStats.test.js` 61 项 + `test-word-stats` 67 项 |
| 25 | 集成测试器吞错、退出码恒 0、按端口误杀开发者进程、fd 泄漏 | `server/test/run.js` | `EnvError` + `process.exitCode`、`/health/ready` 校验状态码、只杀自 spawn 的 pid、`closeSync`、清库走 `DB_*` | 5 种红/绿场景实测 |
| 26 | 5 处近似永真的「安全回归」断言 | `likeGuard` / `security` / `lockout` | 注入时钟测三边界、精确状态码、第 6 次 429 + 秒数区间 | 破坏版实测会红 |
| 27 | `client.js` 的 `get()` 三目写反且零调用 | `server/test/client.js` | 删除并留注释；抽 `TEST_ORIGIN` | — |

### 11.2 验证矩阵（本机实跑）

```
cd server && npm test          → 19 套件 / 670 项 / 0 失败 / exit 0
  sanitize 77 · stripExif 17 · securitySettings 21 · feed 6 · requestGuard 27
  likeGuard 12 · scrapeGuard 18 · contentCrypto 6 · notesCrypto 9 · homeSummary 29
  browserCrypto 2 · moderationPolicy 22 · allowWords 14 · waf-fixtures 260
  readingStats 61 · cacheInvalidation 18 · routeEdgeCases 13 · importSanitize 25 · uploads 33

cd web && npm run build        → 门禁全绿 + vite build exit 0
  check-script-order 94 文件 · theme-init-parity 48/0（含反恒真自检）
  contrast-tokens 54/0 · mobile-baseline 43/0 · reading-prefs 90/0
  word-stats 67/0 · focus-visible 867/0
```

**反向验证**（证明断言不是摆设）：`stripExif` 改回 `i+=1` → 7 条红；`theme-init` 的 light-7 系数 `0.8→0.81` → 2 条红（八个主题色全红）；签名 11 组比对全部 IDENTICAL；`run.js` 在套件失败 / 清库失败 / 服务 503 / 端口被占四种场景下均 exit 1。

### 11.3 明确未做（附理由，不是遗漏）

- **`npm run test:all` 未执行**：`run.js` 会清空 `xalor_blog` 的 `comments/messages/links/notes/ip_bans` 并重启服务，属破坏性操作，需要你本人在确认数据可清时运行。
- **焦点陷阱/模态规范未收敛**（SearchModal / ImageLightbox / ShortcutHelp / AskAi 四份实现）：跨 4 个组件、无浏览器级测试，改动收益低于回归风险。
- **`utils/pageMeta.js` 与 `ArticleDetail.vue` 的两套 head 写入未合并**：只修了具体缺陷（twitter:image、默认图）。整体收敛要动 2,496 行的视图，建议配 Playwright 快照后单独做。
- **`waf-fuzz.js` 未纳入门禁**：它输出的是「放行明细」而非断言，且直调中间件绕过了限流与信誉累积。下一步应给它加 `--assert` 模式（按载荷类别设拦截率下限）再接入。
- **`main.css` 里 EP 色阶字面量与 JS 公式两个主题都对不上**：内联变量优先，运行时正确；但「用户没选过强调色」时首帧用 CSS 值、挂载后跳一次。修它要同时改 `main.css`，且三套系数（EP 0.3/0.5/0.7/0.8/0.9、store 0.55/0.7/0.85/0.9/0.95、css ≈0.21/0.4/0.6/0.7/0.88）需要先定一套口径。
- **`NotFound.vue:71` 的空 `catch`**、**`published_at` 清空/`slug` 清空后重新生成**（需前后端契约一起改）、**`site_url` 配成无协议域名时 `ArticleDetail.abs` 不加 scheme**、**`web/public/og-image.webp` 已无引用可删**：都已记录，均属独立小项。

### 11.4 工作树说明（重要）

本轮开始时工作树里已有 **37 个未提交修改**（`app.js`、`waf.js`、`ai.js`、`articles.js`、`feed.js`、`share.js`、`settings.js`、`Settings.vue`、`Messages.vue`、`Links.vue`、`SearchModal.vue`、`wordStats.js`、`main.css` 等），来自之前的会话。本轮的改动叠加在其上，`git diff` 无法区分归属 —— 审查时请以本文件 §11.1 的表格为准，而不是 `git diff --stat` 的文件列表。本轮未执行任何 git 提交。

---

## 12. 第二轮修复（2026-11-01 晚）：风控分级 + 首帧一致性 + 收敛

### 12.1 已修

| # | 缺陷 | 位置 | 修法 | 守卫 |
|---|---|---|---|---|
| 1 | **登录失败第 4 次就被 IP 信誉封禁抢先成 403**，`429 + 剩余秒数`（可恢复、可解释）永远来不及出现；家庭/办公出口几个人各错一次会互相封禁 | `server/src/routes/auth.js` | 分级：1-4 次 401 不记分；第 5 次 401 + 记一次分；锁定期内 429 不记分；每 4 个锁定周期（20 次）才升级封禁。`recordFail` 返回是否跨阈值，`reserveLoginAttempt` 透出 `ipReachedLock` | 新增 `loginLockPolicy.test.js`（16 项，离线）+ `lockout.test.js` 第 6 段（固定 IP 第 6 次必须 429 不是 403） |
| 2 | EP 色阶三套系数并存；无自定义强调色的用户首帧吃 CSS 字面量、挂载后跳色 | `web/src/styles/main.css`、`web/public/theme-init.js` | CSS 14 个字面量改为默认色 `#e4573d` 按 `theme.js` 公式算出的值；`theme-init` **无条件**写 7 个 `--el-color-primary*` | parity 新增 22 条（含 14 条逐值比对，期望值由真跑 `apply()` 得出，容差 0） |
| 3 | `--accent*` 五个变量在无自定义色时不写 → 深色首帧 40% 混白、挂载后 28%（同类残余跳变） | `web/public/theme-init.js` | 五个变量一并改为无条件写，与 `apply()` 逐值相同 | parity 断言由「不越权写」翻转为「必须写且同值」 |
| 4 | 四份模态焦点实现，ShortcutHelp 的 `@keydown.tab` 绑在面板上实际失效、AskAi 完全没有 `aria-modal`/Esc/焦点陷阱 | 新增 `web/src/composables/useFocusTrap.js`；4 个组件改用 | 打开记录并移入焦点、document 级 Tab 首尾循环、Esc 关闭、关闭还焦（`returnFocusTo` 支持图片元素） | `test-focus-visible`（887 条）+ `test-mobile-baseline` |
| 5 | `ArticleDetail` 自建一套 head 写入（缺 `og:site_name`），与 `pageMeta` 重复；`og:url` 与 `canonical` 混用同一变量 | `web/src/utils/pageMeta.js`、`ArticleDetail.vue` | `pageMeta` 补 `jsonLd`（固定 id 复用、`<`→`\u003c`、`clearPageJsonLd`）、拆开 `og:url` 与 `canonical`、`absoluteUrl` 对裸域名补 `https://`；视图改为单次 `applyPageMeta` | `test-focus-visible` 的 SEO 合同断言 |
| 6 | `published_at` 清空、`slug` 清空后重新生成都不生效（前端 `|| undefined` 把空值丢掉，后端只在字段存在时改） | `server/src/routes/admin.js`、`web/src/views/admin/ArticleEdit.vue` | 抽出纯函数 `resolveArticlePatch(body, current, opts)`：`hasOwnProperty` 区分「没传」与「显式 null/空串」；`published_at: null` → 置 NULL，`slug: ''` → 按标题重生成并保证唯一；前端按「清空/保持」分别传 `null`/`''`/`undefined`，保存后回填新值 | 新增 `articlePatchContract.test.js`（51 项） |
| 7 | `waf-fuzz.js` 输出的是统计而非断言，口径还与实现相反（把「按设计放行」算成绕过、`Math.random` 不可复现、固定假 IP 让信誉分累积） | `server/test/waf-fuzz.js` | 新增 `--assert`：确定性 PRNG、样本级 IP 隔离（1338 个唯一假 IP）、类别级判定（每类至少一个变体被拦 + 良性语料零拦截）、命中载荷计数；不达标 exit 1 | 已接入 `npm test`（`node test/waf-fuzz.js --assert`） |
| 8 | `markdown.js` 第三份剪贴板实现；`NotFound` 的空 `catch`；已无引用的 `og-image.webp` | `utils/markdown.js`、`utils/clipboard.js`、`views/site/NotFound.vue`、`public/` | 代码块复制按钮改调 `copyText`（兜底合并为更完整那份：保留焦点 + 1px 固定定位）；NotFound 区分 404（info）与请求失败（error）并走 `silent`；删除 74KB 的 `og-image.webp` | `test-reading-prefs` / `test-focus-visible` 断言重定向到唯一实现 |

### 12.2 验证矩阵（实跑）

```
cd server && npm test
  19 个 *.test.js 套件 / 458 项断言 / 0 失败
  + waf-fuzz --assert：1326 变体 / 6 个类别全部 PASS / 良性语料 0 拦截
  exit 0

cd web && npm run build
  script-order 95 文件 · mobile-baseline 43 · reading-prefs · word-stats 67
  contrast-tokens 54 · theme-init-parity 70 · focus-visible 887
  vite build ✓ 7.62s   exit 0
```

**反向验证（本轮新增 3 条）**
- 把 `report` 改回「每次失败都计分」→ 固定 IP 第 5 次即 403，`lockout` 第 6 段 **5 条红**、exit 1；
- 把 `main.css` 亮色 `light-7` 的十六进制改错一位 → parity **2 条红**、exit 1；
- 把 `waf-fuzz --assert` 表里某类最低命中改成不可能值 → exit 1 并指出该类。
- 另外：`loginLockPolicy.test.js` 写完后**立刻抓到了我自己的一个真 bug**（`recordFail` 忘了 `return reachedLock`，导致 `ipReachedLock` 恒 undefined）—— 这条测试的价值已经自证。

### 12.3 明确未做（仍是决策项，不是遗漏）

- **深色 `--el-color-primary-light-9` 对页底只有 1.12:1**：现在 CSS 与 JS 是「一致地低」。要改得动 `theme.js` 的 0.9 系数（会让 EP 的 plain 按钮底/表头底更明显），属视觉决策，未擅自改。
- **深色 `--el-color-primary-dark-2` 与 primary 几乎同色**（`#e76b54` vs `#e76850`，语义上 dark-2 本该更暗）：主题公式的既有效果，同样属设计决策。
- **`npm run test:all` 仍未执行**：会清 `ip_bans`、重置 `users.totp_*`、删本机测试评论/留言/手链、并重启服务。改造后的运行器能正确返回退出码，请在确认数据可清时自行运行。
- **`main.css` 里其余「过渡/间距」类魔法数与 `--z-*` 裸值**（W11 记录的那些）本轮未动，它们不影响功能正确性。

### 12.4 工作树说明

工作树里仍有前序会话留下的未提交改动，本轮改动叠加其上。审查请以 §11.1 与 §12.1 的表格为准；本轮依旧没有任何 git 提交（删掉的 `og-image.webp` 也只在工作区，索引已复位）。

### 12.5 收尾补丁（同日，评审报告驱动的 4 项）

| 缺陷 | 位置 | 修法 |
|---|---|---|
| 新建文章的 **POST /articles 忽略 body.published_at** —— 同一表单，新建填的发布时间被静默丢弃、编辑才生效 | `server/src/routes/admin.js` | 与 PUT 同口径：合法的显式时间优先；`null`/`''` **不覆盖**默认（发布→当前时间、草稿→NULL），非法日期显式 400 |
| 清空发布时间后详情页日期栏渲染成空洞 | `ArticleDetail.vue:108` | `formatDate(x) || '未标注日期'`（写「未发布」会误导：文章已发布，只是没标注日期） |
| 清空发布时间后 JSON-LD 出现 `"datePublished": null`（`JSON.stringify` 只丢 `undefined`，不丢 `null`），Google 会判整条结构化数据不合法 | `ArticleDetail.vue` 的 `buildJsonLd` | 日期字段改为条件赋值：没有值就不写这个键 |
| 剪贴板断言仍钉在 `markdown.js`（实现合并后指向已不存在的代码）；「状态走白名单」断言钉死局部变量名 | `test-reading-prefs.mjs`、`test-focus-visible.mjs` | 断言重定向到唯一实现 `utils/clipboard.js`；变量名耦合改为语义匹配（抽纯函数后入参是 `src.status`，锁局部变量名会让合理重构变红） |

补丁后：`server npm test` 458 项 + waf-fuzz 全绿；`web build` 7 道门禁全绿（parity 70 / focus-visible 887 / contrast 54 / mobile 43 / word-stats 67 / script-order 95）+ 构建 18.48s。

### 12.6 一个必须记录的 WAF 设计缺口（由断言模式暴露，未擅自改）

`waf-fuzz --assert` 现在会打印一份「已知规则缺口」清单：**12 条攻击载荷、17 个变体 100% 放行**，原因全是「只命中单条规则、分数 3~4，低于阈值 5」：

| 规则 | 载荷 | 分数 |
|---|---|---|
| SQL-22 | `admin'--`（经典登录绕过） | 3 |
| XSS-23 | `javascript:alert(1)` 及两个编码变体 | 3 |
| CMD-01 / CMD-02 | `id` 反引号形式 / `$()` 形式 | 4 |
| SSRF-09 | `file:///etc/passwd`、`gopher://127.0.0.1:6379/_INFO` | 4 |
| SSRF-11 | `http://[::ffff:127.0.0.1]/` | 4 |
| MSC-07 | `%{#_memberAccess}` | 4 |
| MSC-CRLF | 响应头注入、请求行注入 | 4 |

后果：单发一条 header 注入、单发一个 `javascript:` URI、单发一次 `file://` 探测，都够不到阈值，必然放行。

**为什么没有直接提权**：这几条在技术博客里是合法内容（讲 SQL 注入会写 `admin'--`、shell 教程会写命令替换、安全文章会写 `file://`）。把它们提到 critical 会让「正文讨论安全」被自己的 WAF 拦下 —— 这正是当前「异常评分 + 保守阈值」的设计理由。两条可选路径，都属生产决策：

1. **按字段区分严重度**：同一规则在 `query` / `header` 里算 critical（单发即拦），在 `body` 里维持 warning（允许技术讨论）。改动最小、误杀最低，但需要给规则加「位置维度」。
2. **下调 `anomalyThreshold` 5 → 4**：一行配置，但所有 error 级规则单发即拦，正文里的命令替换、`file://` 示例会被 403。

---

## 13. 第三～五轮修复（2026-11-02）：从「补测试」到「结构性加固」

前两轮（§11 §12）以「改代码」为主。这一批的重心转成**先钉住行为，再改**——
因为修的过程中反复撞到同一类问题：**故障被显示成正常**。

### 13.1 这一类 bug 出现了 5 次，形态几乎一样

| 位置 | 表现形式 |
|---|---|
| `NotFound.randomArticle` | 空 `catch` → 点按钮什么也没发生 |
| `ArticleList.load` / `Messages` / `Links` | 请求失败显示「还没有文章，来写第一篇吧」 |
| `admin` store 的 `fetchPending` | 空 `catch` → 侧栏待审角标消失，管理员以为没有待审 |
| `saveSettings` | 校验不过静默 `continue` → 后台提示「已保存」而值没变 |
| `home_social_extra` | 前端只过滤空值、服务端按协议白名单丢弃 → 保存后列表还在、刷新就没了 |

共同点：**catch 里的状态变量保持初始值，而初始值恰好等于「空数据」的合法状态**。
新增第 11 道门禁 `test-error-states.mjs` 专查这一类（加载函数必须有可观察的失败标志、
标志必须真被模板用上、代码里不许有空 catch）。

### 13.2 只在特定环境下错的，本地永远测不出来

- **`localDateStr(null)` 返回 `1970-01-01`**：`Intl.formatToParts` 把 `null` 当成时间戳 0。
  而 `published_at` 在「导入备份」路径上确实允许为 NULL。改成抛 `TypeError`。
- **UTC 服务器上 30 分钟查重静默失效**：`created_at` 由数据库会话时区生成，
  而比较值来自固定的 `Asia/Shanghai`；`db.js` 还读**进程**时区。本机 +08:00 所以看不出来。
  改成两边都由 `siteTimezoneOffset()` 从 `SITE_TZ` 推导。
  断言用**子进程换 TZ**（`TZ=UTC` / `America/New_York` / …）证明不依赖部署环境 ——
  这是唯一能证明这件事的写法。
- **`::ffff:192.168.1.1` 绕过 SSRF 判定**：`new URL()` 会规范化 hostname 成
  `[::ffff:c0a8:101]`（前导零被省略），按「去掉冒号后必须 8 位」解析会得到 7 位而漏判。
  只在**线上路径**（走 URL 解析）出现，直接传字面量反而判对。

### 13.3 新增的模块

| 文件 | 作用 |
|---|---|
| `server/src/utils/netGuard.js` | 私有/保留 IP 字面量判定（纯函数、**不做 DNS**）。`isUsableBase` 与 `saveSettings` 共用 |
| `server/src/utils/indexAnalysis.js` | `classifyRedundantIndex` 从 `migrate.js` 拆出，纯函数测试不再需要 `DB_PASSWORD` |
| `server/src/utils/etag.js` | 弱比较（`W/` 前缀、逗号列表、`*`） |
| `server/src/middleware/compress.js` | brotli + gzip 协商（异步 zlib、q 值、`q=0` 拒绝） |
| `server/scripts/bench-read-paths.js` | `npm run bench`：SQL 条数 + 耗时基线 + EXPLAIN 索引验证 |
| `web/src/utils/socialExtra.js` | 社交链接读写归一，规则与服务端一致 |
| `web/scripts/lib/sourceText.mjs` | 断言用的剥注释工具（带 11 条自检） |

### 13.4 结构性加固（不是修 bug，是让同类 bug 不可能再发生）

- **公开设置接口的密钥剔除**：从「逐键解构两个已知键」改成**按名字模式过滤**。
  逐键解构的致命处是：加一个新密钥字段忘了改那一行 → 泄漏，且**没有任何断言会红**。
- **`test/run.js` 的孤儿检测**：新增集成测试忘了登记 → 报警并置退出码 1（原来会永远不执行）。
- **第 13 道门禁 `test-dead-code.mjs`**：只报「定义但从未被引用」，
  **不报"导出但没人用"**（那是模块 API 面）。
- **`JSON_VALUE_KEYS`**：结构化设置按单编码落库，避免 `JSON.stringify` 两次
  （原来 `home_social_extra` 落库是双编码，靠两个消费方各自再 `parse` 一次兜住）。

### 13.5 量化（此前从未做过）

`npm run bench` 的基线（articles=6 / notes=1）：

| 路径 | 冷 SQL | 热 SQL |
|---|---|---|
| `GET /api/articles/archive` | 1 | **0** |
| `GET /api/home/summary` | 4 | **0** |
| `GET /api/notes?page=1` | 2 | 2（分页数据不该缓存，正确） |

EXPLAIN 验证删冗余索引没把查询打成全表扫描：
slug 查询 `type=const + articles_slug_unique`、归档与列表都 `Backward index scan`（无需 filesort）。

### 13.6 「需人工决策」的（2026-11-08 已全部处理，见 §15）

原清单：WAF 单发高危载荷、色情词权重、深色两处对比度、`share-page` 空壳页、
3 条疑似冗余索引、手记 `Using filesort`、`https` 指向内网。

现状：前五项已落地并各有测试钉住；`share-page` 早在第 46 轮补成真实内容页；
冗余索引只剩 `migrate.js` 里几条「需逐个人工确认」的（未被删除）。

### 13.7 文档复核（本轮顺手做的）

- **§2 体量与 §6 测试段落已按实际重算**（原文写「15 个离线套件 / 8 个静态门禁」，
  实际是 46 个 `*.test.js` + `waf-fuzz --assert` / 13 道门禁）。
  数字只统计 `.js`/`.vue`/`.mjs`，`web/public` 不含二进制图标 —— 口径写在表下。
- **路径引用复核**：从全文提取 137 个 `` ` `` 包裹的路径形态，逐个 `statSync`，
  没有指向不存在文件的「当前状态」陈述。
  两个命中经人工确认为正常：`web/src/utils/{pow,pass}.js` 是 glob 简写；
  `og-image.webp` 出现在 §11 的**历史记录**里（「已无引用可删」），不是当前断言。
  → 没有把这条做成门禁：判据（「当前存在」vs「历史记录」）无法自动区分，误报会把门禁变成噪音。

### 13.8 工作树状态（截至本轮）

```
git status --short
  51 个未跟踪（docs/ + 本轮新增的测试/工具/门禁脚本）
  87 个已修改
   1 个已删除（web/public/og-image.webp，74KB，无引用）
   0 个 staged
```

**全部改动未提交**，索引干净。审查请以 §11.1 / §12.1 / §13.1–13.5 的表格为准 ——
`git diff --stat` 的文件列表无法区分是哪一批改的。

新增文件按用途分三类：
- **测试**：`server/test/` 下 25 个 `*.test.js`（`archiveCache` / `authGate` / `netGuard` /
  `timeContract` / `publicSettings` / `crawlerVerify` / `wafRules` …）
- **工具**：`server/src/utils/{netGuard,indexAnalysis,etag}.js`、
  `server/src/middleware/compress.js`、`server/scripts/bench-read-paths.js`、
  `web/src/utils/socialExtra.js`、`web/scripts/lib/sourceText.mjs`
- **门禁**：`web/scripts/test-{a11y-interactive,lifecycle-cleanup,markdown-cache,error-states,social-extra,dead-code}.mjs`

---

## 14. 附录：本次自主优化新增的文件（第 1–42 轮）

> 上面各章是第 1–5 轮读代码时写的笔记。这一节补上是**之后 37 轮自主优化**新增的东西 —— 
> 它们在正文里没有对应章节，但理解当前状态需要知道它们存在。
> 共 **87 个未跟踪文件**（本仓库从无 git 提交，所以全部显示为 `??`）。

### 14.1 `server/src`（6 个新模块）

| 文件 | 解决什么 |
|---|---|
| `utils/asyncGuard.js` | Express 4 **不会**捕获 async handler 的 rejection。`asyncGuard(fn)` 把 sync throw 与 thenable reject 都转给 `next(e)` —— 否则一个 await 里的异常会让请求**永久挂起**（客户端超时，服务端无日志） |
| `utils/netGuard.js` | `isPrivateHost/isPrivateUrl/stripBrackets` —— SSRF 白名单判据（只认 IP 字面量，**不做 DNS 解析**，避免用解析结果判断带来的 TOCTOU） |
| `utils/etag.js` | `weakCompare` / `etagMatches` —— nginx/CDN 会把强 ETag 改写成 `W/"..."`，严格相等会永远 304 不命中 |
| `utils/indexAnalysis.js` | `classifyRedundantIndex` —— 判定「前缀重复的索引」，用于迁移时安全删除冗余索引 |
| `utils/uploads.js` | `resolveUploadPath` / `listUploadFiles` / **`extractUploadRefs`**（第 71 轮从 `admin.js` 抽出，纯函数，可离线测） |
| `middleware/compress.js` | `createGzipMiddleware` —— 异步 zlib，避免同步压缩阻塞事件循环 |

### 14.2 `server/test`（39 个新文件：38 个离线套件 + `helpers/`）

离线链现在是 **51 个套件**（`npm test` 串行跑，零 DB 零端口）。按**防的是什么**分类：

| 类别 | 套件 |
|---|---|
| 信任链与鉴权 | `authGate` `crawlerVerify` `hostAndTime` `loginLockPolicy` `publicSettings` `securitySettings` `settingsStore` |
| 入参清洗 | `allowWords` `importSanitize` `moderationScore` `sanitize` `stripExif` `slugUnique` |
| 缓存与性能 | `archiveCache` `dashboardCache` `notesListPerf` `gzipMiddleware` `etagMatch` `redundantIndex` |
| 响应契约 | `responseShape` `routeEdgeCases` `articlePatchContract` `asyncGuard` |
| 外部依赖 | `aiBaseUrl` `aiConfig` `webSearch` `netGuard` |
| 时间与格式 | `timeContract` `sitemapDate` |
| 上传 | `uploads` `uploadSingleRead` `uploadRefs` |
| 顺序与结构 | `middlewareOrder` `wafRules` `antiBotAudit` `saveConfigFail` `shareEscape` |
| **断言工具自身** | `sourceText`（剥注释工具的自检）、`orphanSuites`（孤儿检测） |

`test/helpers/sourceText.js` 值得单独说：它是 `stripCommentLines()` 的 server 侧实现，
与 `web/scripts/lib/sourceText.mjs` 同判据（按 `inBlock` 上下文剥，**不是**「`*` 开头就删」）。
存在的理由：本项目有 104 处「`catch (e) { return fail(res, ..., 500) }`」这类结构断言，
注释里复述实现会让它们假绿。

### 14.3 `web/scripts`（13 个：11 道新门禁 + 1 工具 + 1 lib）

第 6 节列的门禁里，**这 11 道是本次新增的**（写这段时全站 20 道，现在是 21 道）：

```
test-script-order        check-script-order 的自检（证明它的规则能抓到真问题）
test-mobile-baseline     视口缩放禁令、触摸目标、16px 输入字号
test-reading-prefs       阅读偏好（字号/行距/主题）的持久化与降级
test-word-stats          纯函数：字数/阅读时长估算
test-contrast-tokens     WCAG 对比度（含深浅两套 token 的对称性）
test-theme-init-parity   首屏防闪的主题初始化与运行时一致
test-anti-debug          vm 沙箱：调试器检测不能误伤正常用户
test-a11y-interactive    globSync('**/*.vue')：非原生元素带 @click 必须有 role+tabindex+键盘
test-lifecycle-cleanup   事件监听/定时器/observer 的成对清理
test-markdown-cache      渲染缓存 LRU 语义 + 流式期间不渲染 Markdown
test-error-states        故障不能显示成空态（catch 里必须有可观察的失败标志）
test-social-extra        社交链接两端（前台/后台）一致性
test-dead-code           导出但无人引用的死代码
test-message-box-style   Element Plus message-box 样式进入正确入口
test-heading-order       h1→h2→h3 不跳级
test-icon-buttons        纯图标按钮必须有 aria-label
test-form-errors         表单错误的三件套（aria-invalid/aria-describedby/role=alert）
test-gate-integrity      **元门禁**：每道门禁能让 build 变红、在链里、文档清单一致
```

`lib/sourceText.mjs` 是剥注释工具（web 侧）；
`audit-comment-reliance.mjs` 是**审计工具不是门禁**（`audit-*` 前缀，不进 build 链）——
`check-flake.mjs`/`test-form-token-fast.mjs` 同理：**flaky 检测工具**，跑 N 次验证稳定性，但不直接参与构建。
它把某个门禁临时换成「剥注释版」跑一遍，报告哪些断言依赖注释。

### 14.4 `web/src`（4 个）

| 文件 | 解决什么 |
|---|---|
| `composables/useFocusTrap.js` | 弹层的焦点陷阱：Tab 循环、Esc 关闭、关闭后还焦到触发元素 |
| `utils/clipboard.js` | `navigator.clipboard` 在非 HTTPS / 旧浏览器的降级（`execCommand` 兜底） |
| `utils/requestSignature.js` | 写请求签名（与 server 侧 `timestampRequired` 对偶） |
| `utils/socialExtra.js` | 社交链接的规范化（前后台共用，避免两处规则漂移） |

### 14.5 `docs/`

- `docs/CODE_MAP.md`（本文件）+ `docs/code-map/` 下 **21 篇分区笔记**

### 14.6 读这份文档的正确顺序（更新版）

1. **本文件 §1–§9** —— 架构与请求旅程，仍然准确
2. **本节** —— 正文没覆盖的新文件
3. `code-map/` 分区笔记 —— 逐文件细节（但只到第 5 轮）

---

## 15. 2026-11-08 攻坚：五项决策落地 + 真库闭环

### 15.1 五项决策（都有可执行断言，不是散文）

| 项 | 改了什么 | 钉住它的测试 |
|---|---|---|
| WAF 单发高危载荷 | **扫描面加权**：`query/path/header ×1.25`，`body ×1` —— 单发 `error`(4) 在网络面 = 5 达阈值即拦，正文仍是 4 放行。另把 `SQL-22`（引号接注释）与 `XSS-23`（裸伪协议）从 warning 提到 error | `wafThreshold.test.js`【F】、`wafBodyGuard.test.js`、`waf-fuzz --assert`（缺口预算 12 → **0**） |
| 色情词权重 | `25 → 30`（与辱骂词同档），单发即进待审；**不加**硬拦表（避免技术讨论被拒收） | `moderationWeights.test.js`、`moderationScore.test.js` |
| 主题派生色 | 阶梯系数重调（浅 `.40/.55/.66/.72/.78`、深 `.30/.50/.66/.72/.78`），`dark-2` 改为向页底压暗；`light-9` 实测浅 **1.24:1** / 深 **1.34:1** | `test-derived-tokens.mjs`（36 条，含 main.css 兜底值逐字节比对）、`test-theme-init-parity.mjs`、`check-theme-parity.mjs` |
| schema enum | `migrate.js` 5 处 `t.enum` 改为 `[...ARTICLE_STATUS]` / `[...REVIEW_STATUS]` 派生 | `schemaEnumSync.test.js`（断言「全部派生，写回字面量即红」）、`enums.test.js` |
| 手记 filesort | 新增覆盖索引 `(status, is_pinned, published_at, id)`；实测 EXPLAIN 变为 `Covering index lookup ... (reverse)`，filesort 消失 | `notesSortIndex.test.js`（含探针 MySQL 的 EXPLAIN 对照：旧索引 / `(status,id)` / 覆盖索引） |

### 15.2 WAF 实测数字（1326 变体）

| 指标 | 改前 | 改后 |
|---|---|---|
| 拦截 / 放行 | 848 / 478 | **1223 / 103** |
| 已知缺口（分数不到阈值） | 12 条 | **0 条** |
| 良性语料误杀 | 0 | **0** |

正文护栏单独成测：`content`/`title`/`summary` 等自由文本字段对全部规则组豁免（零命中），
非豁免正文字段（`nickname`/`website`）单发 4 分 < 5 放行；同样字符串进 `query`/`header` 即达标。

### 15.3 真库闭环（此前 7 天唯一的验证空白）

- **护栏**：`test/run.js` 在 `DB_NAME` 不以 `_scratch` 结尾时**拒绝执行**（这些套件会 DELETE 真实行）。
- **结果**：`xalor_blog_scratch` 上 `migrate → seed → 17 个套件` 全绿（含新增 `writePath.test.js`）。
- **写路径**：文章发布 → 列表/详情立刻可见；评论 待审 → 批准 → 前台可见；手记发布 → 主页列表与
  **摘要缓存**立刻反映（`note_count` 递增）；同 IP 重复点赞 429。
- **摘要缓存**：`admin.js` 加统一钩子 —— 任何成功的写请求（方法 + 状态码判定）自动清 `/api/home/summary`，
  取代「十几个写点逐个手写失效」的漏点模式。
- **备份演练**：`mysqldump` 生产库 → 恢复进 `xalor_blog_scratch2` → **17 张表行数逐表一致**
  （`audit_logs` 26,220 行）。

### 15.4 新增门禁

| 门禁 | 防什么 |
|---|---|
| `adminAuthz.test.js`（9 条） | 后台路由必须全部排在 `authRequired` + 角色闸之后；新增路由若写到守卫上面，立刻红 |
| `wafBodyGuard.test.js`（13 条） | 「技术文章能发布」与「单发载荷被拦」两件事同时成立 |
| `writePath.test.js`（20 条，集成链） | 写入 → 缓存失效 → 前台可见这条链路 |

### 15.5 计数现状

离线套件 **78**、集成套件 **18**、构建门禁 **37**、`*.test.js` **89**。

### 15.6 2026-11-08 第二轮（继续深挖）

| 项 | 结论 / 改动 | 防线 |
|---|---|---|
| Q7 冗余索引 | `sessions.idx_sessions_jti`（被 PRIMARY 完全覆盖）、`visits.idx_visits_day`（被 `visits_day_unique` 覆盖）、`visit_uv.idx_visit_uv_day`（被 `(day,h)` **左前缀**覆盖）—— 三条都可删。更糟的是 `migrate.js` 一直在**新建**它们 | `redundantIndex.test.js`（含左前缀三例）、`migrateRun.test.js`（新库不得有这三条 + 覆盖索引列序） |
| 基线成了门禁 | `bench-read-paths.js` 增加 BUDGET（冷/热 SQL 与体积）与 `--assert`；未登记用例即失败 | `npm run bench:assert`、`benchExplains.test.js` |
| 基线的 SQL 是假的 | 手记那条 EXPLAIN 用的是 `order by id desc`（站点从不执行的语句），连续十几轮误报 filesort | `benchExplains.test.js` 校验 EXPLAIN 与路由排序键同形 |
| SSRF 闸门可绕 | `2130706433` / `127.1` / `0x7f.0.0.1` / `0177.0.0.1` 全部被判成公网（URL 会归一化成 127.0.0.1） | `netGuard.test.js`【G】六种写法 + 公网对照 |
| 出站跟随重定向 | 保存时校验过 base URL，但 `fetch` 默认 follow：公网地址 302 到 `169.254.169.254` 即可打内网 | `aiClient`×2 与 `aiModeration` 改 `redirect:'error'`；`outboundFetch.test.js` 枚举全部 7 处出站请求 |
| `hitokoto` 降级不对称 | 只有 `catch` 回落缓存，上游非 2xx 直接 502 —— 有缓存也把引言丢掉 | `hitokoto.test.js`（12 条，含移位时钟触发过期缓存） |
| `seed.js` 零测试 | 弱口令拒跑、口令哈希、二次运行幂等、不动既有内容 | `seedSafety.test.js`（18 条，探针 MySQL，无探针显式跳过） |
| 备份脚本 | 保留 14 份的策略此前没验 | `backupFailure.test.js` 增至 23 条（造 17 份旧备份，断言删最旧 4 份） |
| `asyncGuard` 扫描器 | 500 字符窗口会误报；更糟：注释里出现 `try {` 会被当成有保护 | 窗口 1200 + 剥注释 + 注释欺骗自检 |
| 429 无退避信息 | 10 处 429 都没给 `Retry-After`，客户端只能立刻重试（越重试越限流） | `retryAfter()` + 10 处接线；`retryAfter.test.js` |
| 上传总量无上限 | 单文件 5MB 管不住「一直传」；磁盘满后备份报「凭据错误」、整站 500 | `checkUploadQuota` / `dirSizeBytes` + 507 拒绝并删文件；`uploadQuota.test.js` |
| `audit_logs` 无保留策略 | 两周 26,220 行，只随运行时长增长（后台分页/备份/导出越来越慢） | `scripts/prune-old-data.js`（默认 dry-run、`--apply` 需显式放行）；`dataLifecycle.test.js` |

计数：离线套件 **78**、集成套件 **18**、构建门禁 **37**、`*.test.js` **89**。
