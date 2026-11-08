# S6 · schema / 迁移 / 种子 / 部署配置

读取范围：9 个文件、合计 1809 行（逐行读完，无抽样）。

---

### server/src/migrate.js（453 行）

**职责**：建表与补列的唯一权威实现 —— 14 张表 `CREATE TABLE` + 老库逐列补丁 + 19 条索引，全部包成「不存在才做」，但**没有版本表**（无 `knex_migrations`、无 up/down、无顺序记录）。

**关键导出**：`migrate()`（唯一）。
- 每张表为 `await db.schema.hasTable(x).then(async (exists) => …)`：不存在建表，存在进补丁分支；`then` 返回 Promise，`await` 保证串行。
- 补丁实际只覆盖：`categories`(`sort`/`updated_at`)、`articles`(`content` 由 `text` 升 `mediumtext`、`allow_copy`)、`comments`(`ai_reason`/`likes`)、`users`(`totp_secret`/`totp_enabled`)、`messages`(`ai_reason`、`reply`+`replied_at`、`ip`)、`ip_bans`(`reason`)、`notes`(七列，收进 `added[]` 后一次打日志)。
- `ensureIndex(table, indexName, columns)`(405-415)：`SHOW INDEX FROM \`table\`` 取 `Key_name`，缺失才 `alterTable().index(...)`；表不存在静默 `return`。全文件唯一的复用抽象。
- 末尾 `require.main === module` 守卫 + `module.exports = { migrate }`。

**依赖**：仅 `./db`（knex 实例）。用到 `db.schema`、`db.fn.now()`、`db.raw`、`columnInfo()`。不 require config → **不校验任何环境变量**。

**表契约**：
- `articles`：`slug(220)` 唯一、`content mediumtext`、`status enum(draft|published)` 默认 **draft**、`is_top`、`views/likes`、`allow_comment`/`allow_copy` 默认 true（单篇覆盖全局 `settings.allow_copy`）、`published_at` 可空、`category_id` 外键 `ON DELETE SET NULL`。
- `comments`：`parent_id` 自引用 `CASCADE`、`status` 默认 **approved**、`ai_reason(120)`、`likes` NOT NULL、`ip(64)`；`links` 默认 **pending**（与评论/留言相反）。
- `sessions`：`jti(64)` **主键**、`fp/ip/ua`、`revoked`、`expires_at` NOT NULL —— JWT 可撤销锚点。
- `gate_tickets`：`jti(32)` 主键、`issued_at bigInteger`、`renews`、`expires_at` 带命名索引；通行证票据**落库**，是闸门里唯一跨重启存活的状态。
- `visits`：`day` date 唯一；`visit_uv`：`unique(day,h)`，`h = sha256(day:ip:fp)` 前 32 位（不留明文 IP）。
- `settings`：`key` 唯一 + `value text`(JSON)；`security_config`：`id varchar(16)` 主键 + `data text` 单行 JSON —— 刻意与 settings 分开，防公开设置接口泄漏 WAF 白名单/阈值。
- `audit_logs`：建表即带 `t.index('created_at')`；`ip_bans`：`ip` 主键、`banned_until`、`ban_count`、`reason`。
- `notes`：`content mediumtext`、`images text`（注释称 JSON 数组、≤9 张）、`excerpt/mood/location`、`likes`、`is_pinned`、`status` 默认 draft。

**副作用 / 失败模式**：
- 成功 `db.destroy()` 退 0；任一 DDL 失败 `console.error('[migrate] 失败:', err.message)` + `destroy` + `exit 1`，**只打 message**，丢 `err.sql` 与出错表名。
- 无事务：DDL 隐式提交，半途失败留**半升级库**（如 `mediumtext` 已转、`allow_copy` 未加），重跑靠幂等续上，但中间态被读到就是 500。
- 无锁：两进程并发跑会撞 `Duplicate key/column name`，直接 exit 1。
- 不建库、不建账号、不写种子行。

---

### server/src/seed.js（523 行）

**职责**：灌最小可运行内容集 + 管理员，且口令策略在 **require 阶段**就硬失败。

**加载期逻辑（13-25 行）**：`TEST_ADMIN_PASSWORD='admin123'` 仅 `NODE_ENV==='test'` 可用；否则必须 `SEED_ADMIN_PASSWORD`。弱口令判据：`length<12` / `^\d+$` / `^[a-zA-Z]+$` / 黑名单 `['admin123','12345678','password','password1','passw0rd']`（小写比较）。违反即 `console.error` + `process.exit(1)` —— 任何 `require('./seed')` 都会在缺变量时杀进程。

**`seed()` 执行序**：`users` → `categories` → `tags` → `articles`(+`article_tags`) → `comments`(+parent 回填) → `links` → `messages` → `settings` → `visits`(仅 test)。
- **管理员**：无 `admin` 则 `bcrypt.hash(pwd, 12)` 插入；已有且**现存密码 == `admin123`** 且非 test 时，先 `hasTable('sessions')`，缺表 `throw`；否则单事务内 `update users.password` + `update sessions.revoked=true`，目的是一次性消灭「密码换了旧 JWT 仍有效」的窗口。
- **分类**：`where('slug')` 命中则**覆写** `description`/`color`（唯二被 seed 改写的既有数据）；维护 `catIds[slug]` 与 `catIdByName[name]` 双索引，供文章按中文名取 id。
- **标签**：`slug = name.toLowerCase()`，命中不改。
- **文章**：缺才插；附带随机 `published_at`（近 20 天内）、`views=50..549`、`likes=0..59`；已存在**只修 `category_id`**，正文/摘要永不更新。标签关联 `insert(...).catch(()=>{})`。
- **评论**：整表 `count` 为 0 才灌（`ip='127.0.0.1'`），第二轮按 `article_id+nickname+content` 定位并 `update({parent_id})`。`links`/`messages` 同样以 `count===0` 为闸门。
- **设置**：遍历 `DEFAULT_SETTINGS`，`insert({key,value:JSON.stringify(v)}).onConflict('key').ignore()` —— 只补缺。
- **visits**：仅 test 写 14 天，`onConflict('day').merge({pv: db.raw('visits.pv + ?',[pv]), …})`，**累加**。

**依赖**：`bcryptjs`、`./db`、`./config`（只用于结尾打印 `config.adminPath`）、`./utils/settings`(DEFAULT_SETTINGS)、`./utils/datetime`(`localDateStr`/`localDateTimeStr`，按 `SITE_TZ` 出 `YYYY-MM-DD` 与 `YYYY-MM-DD HH:mm:ss`)。

**数据**：4 分类(tech/life/reading/product + 各自 color)、10 标签、6 篇已发布文章(仅首篇 `is_top`)、3 友链(`sort` 10/9/8)、3 评论(第 2 条 `parent:0`)、2 留言。

**失败模式**：任一 insert 抛错冒泡到入口 catch → 打印整个 error + `destroy` + `exit 1`；**无事务包裹**，已写部分保留。`comments` 回填与 `article_tags` 的 `.catch` 是两处「失败不可见」。

---

### blog.sql（60 行）

**职责**：MySQL 侧一次性 bootstrap —— 建库 `xalor_blog`(utf8mb4/utf8mb4_unicode_ci) + 建 `'xalor'@'localhost'` 并授权；**不建表**（交给 migrate）。

**实现**：`SET @xalor_db_password='__REPLACE_WITH_A_STRONG_RANDOM_PASSWORD__'`(17 行) 是唯一人工替换点。`provision_xalor_app_user(IN requested_password VARCHAR(255))`（`SQL SECURITY INVOKER`，`DELIMITER //`）做校验：`NULL`、`LEFT(pwd,15)='__REPLACE_WITH_'`、`CHAR_LENGTH<20`、`REGEXP '^[[:alnum:]]{1,19}$'` 任一命中即 `SIGNAL SQLSTATE '45000'`。随后 `PREPARE/EXECUTE` 执行 `CREATE USER IF NOT EXISTS` + 无条件 `ALTER USER … IDENTIFIED BY`（重跑对齐密码）+ `GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES ON xalor_blog.*`。收尾 `CALL` → `DROP PROCEDURE` → `DELIMITER ;` → 变量置 NULL。

**契约**：权限集**不含 DROP / CREATE TEMPORARY TABLES / EXECUTE / FILE**，但含 migrate 必需的 `CREATE/ALTER/INDEX/REFERENCES`；库名与 `.env.example`、`backup.sh` 默认值一致。

**副作用**：`SIGNAL 45000` 使账号未被创建（mysql 客户端仍继续跑后续语句）；明文密码进 `general_log` 与 `performance_schema.events_statements_history`（末尾只清变量，清不掉日志）。

---

### server/.env.example（107 行）

**职责**：环境变量权威说明 + `backup.sh` 唯一备份的「配置」。真正生效的只有 12 行：`LISTEN_HOST=127.0.0.1`、`PORT=3000`、`API_PREFIX=/api`、`JWT_SECRET=`(空)、`JWT_EXPIRES_IN=2h`、`DB_HOST=127.0.0.1`、`DB_PORT=3306`、`DB_USER=xalor`、`DB_PASSWORD=`(空)、`DB_NAME=xalor_blog`、`ALLOWED_HOSTS=localhost,127.0.0.1,::1`、`TRUST_PROXY=loopback`。

**变量与阈值**：
- 反代：`LISTEN_HOST` 默认回环（防绕过 Nginx 直连）、`TRUST_PROXY=loopback`，注释明令禁止 `true`/跳数 `1`。
- 会话：`JWT_SECRET` 生产需 ≥32 位，未设则开发随机生成、重启全量掉线；`JWT_EXPIRES_IN` 只示 `2h/7d`。
- 双域名三件套：`ALLOWED_HOSTS`（Host 校验 **兼** 写请求 Referer/Origin 白名单）、`CORS_ORIGINS`（注释的 `https://xalor.cn,https://blog.xalor.cn`，并解释「同源写请求也带 Origin」）、`HOME_SITE_HOST`（SEO 路由按 Host 派发 robots/sitemap/rss）。
- 安全：`ADMIN_PATH`（默认由 JWT_SECRET 派生 12 位）、`ENC_SALT`（默认 `xalor-content-v1`，改盐使旧密文不可解）、`POW_DIFFICULTY=20`/`POW_DIFFICULTY_MAX=24`（开发默认 16）、`TRUSTED_IPS`（支持 CIDR，白名单不记信誉分、不自动封禁）。
- 通知/审核：`SMTP_*`+`NOTIFY_EMAIL`+`SMTP_REQUIRE_TLS=1`（禁明文会话）；`AI_MODERATION`、`AI_API_KEY`、`AI_BASE_URL`（仅 https）、`AI_MODEL=gpt-4o-mini`、`AI_REJECT_SCORE=60`、`AI_PENDING_SCORE=30`。
- 尾注：通行证 jti 落库、nonce/锁定/刮取窗/信誉在内存 → **只能单进程**；探活 `GET /api/health/live`、`GET /api/health/ready`。

---

### deploy/README.md（283 行）

**职责**：部署运行手册 —— 版本要求、文件清单、备份/恢复、systemd、Nginx 双站、ESA 接入清单与自检、首次 DB 账号/管理员、anti-debug v3→v4 与回滚。可按验收清单读。

**硬要求**：
- Node ≥20（验证 25，生产建议 LTS 22）、MySQL 8.x(8.4 验证)、Nginx 1.20+（HTTPS 建议 HTTP/2）。
- 脚本按**自身位置**定位 `server/uploads`、`server/.env.example`，不依赖 cwd（与 `backup.sh:12-16` 一致）。
- 双站：两个 server 块共用 `web/dist`，博客域兜底 `/index.html`、主页域 `/home.html`；`/api/`、`/uploads/`、`robots.txt|sitemap.xml|rss.xml|health` 抽在 `nginx-locations.inc` 被两块 `include`；`proxy_set_header Host $host` 必须保留。
- 上线自检 4 条 curl：主页域 `/` 出 home.html、`/robots.txt` 含「Xalor 的个人主页」、主页 sitemap 含 `#/notes` 且博客域不含。
- ESA 三点：`set_real_ip_from` 必须填（否则封的是回源节点）、源站禁直连（安全组优先，`X-Origin-Verify` 校验失败 `444` 兜底）、回源网段进 `TRUSTED_IPS`。缓存表：`/api/*`、`/home.html` 不缓存，`/assets/*` 长缓存，`/uploads/*`、`theme-init.js`、`anti-debug.js` 遵循源站，缓存键必须保留全部查询串（`?v=` 换版本）。
- 首次 DB 账号：`cp blog.sql` → `chmod 0600` → 替换占位 → `mysql -u root <`；首次管理员：`npm run migrate` 后 `read -r -s` 导出 `SEED_ADMIN_PASSWORD` 再 `npm run seed`，用完 `unset`。
- anti-debug v4 判据：移动端/iPad 桌面外壳**只**看元素尺寸探针；桌面端 `outerHeight-innerHeight > 320px` 或 `debugger` 计时 `> 150ms`，且需连续 2 个周期（≈2.4s）才触发；`localStorage['xalor_dev_mode']='1'` 可整体关闭；回滚只认 `deploy/backup/anti-debug.v3-20261018.js`，**不许**从 `HEAD` 取（否则是静默失败），`?v=` 必须换新号。

**引用对象**（均已存在）：`xalor-blog.service`、`backup.sh`、`nginx.conf.example`、`nginx-locations.inc`、`nginx-realip-esa.conf`、`backup/anti-debug.v3-20261018.js`、`server/test/notes.test.js`、`web/scripts/test-anti-debug.mjs`。

---

### deploy/nginx.conf.example（118 行）

**职责**：双入口生产反代示例 —— 两个 `listen 80` server 块（`blog.` / `xalor.`），同一 `root .../web/dist`，`index` 与 SPA 兜底不同。

**结构**：前 44 行注释（ESA 要点 + 双站说明，不参与解析）；53 行 `include ...nginx-realip-esa.conf` 在**两个 server 块之外**（假定 http 上下文）。每块设 `server_tokens off`、`client_max_body_size 6m`、四条安全头，并 `include nginx-locations.inc`。CSP 具体值：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://v1.hitokoto.cn; font-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`（`script-src` 无 `unsafe-inline` → 所有脚本必须外链）。两个 `location = /index.html` / `= /home.html` 各自把 `Cache-Control: no-store` **和四条安全头再写一遍**（location 级 `add_header` 会清空继承）。兜底 `try_files $uri $uri/ /index.html`（主页域为 `/home.html`）。

**缺失（决定它只是示例）**：无 `ssl_certificate`/443/HSTS、无 `gzip`、无 `error_page`、无 `proxy_intercept_errors`；`include` 用绝对占位路径，未替换即 `nginx -t` 失败。

---

### deploy/nginx-realip-esa.conf（90 行）

**职责**：ESA 回源的真实 IP 还原 + 接入自检日志，写法上「留空即不生效」以保证向后兼容。

**真正生效的 5 条**：全部 `set_real_ip_from` **被注释**（38-40 行占位，默认不生效）；`real_ip_header X-Forwarded-For;`(45)、`real_ip_recursive on;`(49)（递归剥离 `"访客IP, ESA节点"`，取第一个不受信地址）；`log_format xalor_esa '$remote_addr … peer="$realip_remote_addr" xff="$http_x_forwarded_for" host="$host" cache="$upstream_cache_status"';`(56-59) + `access_log /var/log/nginx/xalor-access.log xalor_esa buffer=32k flush=5s;`(60)。

**契约**：`$remote_addr` = 应用看到的 `req.ip`；它与 `$realip_remote_addr` 相等即「没生效」。74-84 行给三条验收（IP 还原、`X-Pass/X-Sig/X-Nonce/X-Timestamp/X-Fp/X-Hp-Field` 透传、`Content-Encoding` 单层且 `/api/health/live` 不缓存）。回滚只需 ESA 侧改回解析。

---

### deploy/backup.sh（111 行）

**职责**：`set -euo pipefail` + `umask 077` 的三合一备份 —— 全库 dump、`server/uploads` 打包、`.env.example` 复制，各保留最近 14 份。

**实现**：路径全经 `pwd -P` 规范化（`SCRIPT_DIR`→`PROJECT_DIR`→`SERVER_DIR/UPLOAD_DIR/ENV_EXAMPLE`）；备份目录取 `$1`，默认 `deploy/backups/`，`mkdir -p` + `chmod 700`。变量 `DB_USER=root`/`DB_PASS`/`DB_NAME=xalor_blog`；`MYSQLDUMP` 按「环境变量 → PATH → `/opt/homebrew/bin` → `/c/Program Files/MySQL/MySQL Server 8.4/bin` → `/usr/bin` → `/usr/local/bin`」探测，找不到 `exit 1`。密码 `export MYSQL_PWD`。dump 参数 `--single-transaction --no-tablespaces --routines --triggers`，注释解释 `--no-tablespaces` 是为了让最小权限账号零告警（否则 MySQL 8 要 `PROCESS`）。任一失败 `rm -f` 半成品 + `exit 1`（不留截断的可恢复文件）。`prune_old(prefix,suffix)`：glob → `LC_ALL=C sort -r` → 第 15 份起删，三个前缀各一次。收尾打印目录、时间戳与恢复命令。

**失败模式**：任一环节 `exit 1` 会**中断后续环节**（DB 失败则不备份 uploads）；`sort -r` 依赖时间戳字典序；`--single-transaction` 仅对 InnoDB 有效；日志只到 stdout/stderr。

---

### .gitignore（64 行）

**职责**：单仓（web/ + server/ + deploy/ + docs/）的统一忽略规则，核心矛盾是「密钥与运行时数据不入库，但 `deploy/backup/` 的回滚快照必须入库」。

**分组**：密钥 `.env`/`.env.*`/`*.env.local`/`*.env.*.local` + `!**/.env.example`（`server/.env.example` 因此可入库）；运行时 `server/uploads/`、`server/test-run.log`、`server/run*.out`、`*.log`、`CHANGELOG.md`、`deploy/backups/`（复数=数据备份）、`mysql/`；回滚快照 `!deploy/backup/` + `!deploy/backup/**`（单数）；构建 `node_modules/`、`web/dist/`、`coverage/`、`.nyc_output/`、`.eslintcache`、`.vite/`、`gui-test-screenshots/`；编辑器/系统 `.vscode/.idea/*.swp/*~/*.bak/*.orig/*.rej/.DS_Store/Thumbs.db/Desktop.ini/ehthumbs.db/~$*`；本地杂物 `reference/`、`.zcode/`、`.v2c/`、`.video_agent/`、`.workbuddy/`、`image.jpg`、`.autofix.log`。

**契约**：`deploy/backup/anti-debug.v3-20261018.js` 必须能被 clone 到（README:268 的回滚依赖它），所以否定规则是功能性的。

---

## 观察

1. `migrate.js:430` — `idx_sessions_jti` 建在 `jti` 上，而 `jti` 在 203 行已是主键；主键即聚簇索引，同列二级索引只增写放大，没有读收益。
2. `migrate.js:417-438` — 成串重复索引：`idx_articles_slug`(slug 已 unique, 54)、`idx_visits_day`(day 已 unique, 239)、`idx_visit_uv_day`(unique(day,h) 左前缀已覆盖, 330)、`idx_audit_logs_created`(建表时 228 已建同列)。后者更糟：`ensureIndex` 只比对索引**名**，老库会并存两条同列索引。
3. `migrate.js:265-276` — `replied_at` 被绑在 `if (!cols.reply)` 内，且 `cols` 只读一次不刷新；历史库若有 `reply` 无 `replied_at`，该列**永远**补不上，留言回复查列即 Unknown column。
4. `migrate.js:72-84、370-400` — 补丁覆盖不全：`articles` 不补 `is_top/views/likes/allow_comment/published_at/summary/cover/status`，`notes` 不检查 `status/content/created_at/updated_at`。跨两版本升级会停在建索引之前，且错误只有 `err.message`，看不出缺哪列。
5. `migrate.js:73-77` — `alter mediumtext` 无 online DDL 提示，大表上等于全表拷 + 元数据锁，迁移窗口内写请求被卡；注释只说「已升级」。
6. `migrate.js:443-453` — `module.exports = { migrate }` 是死代码：`server/src` 内无 `require('./migrate')`，`server.js` 启动不迁移，`package.json` 只有 `"migrate"` 脚本。结果**忘跑 migrate 也能 listen 过探活**，第一条业务 SQL 才 500 —— 比启动即失败更难排查。
7. `migrate.js:112、256` — `comments.status`/`messages.status` 的 DB 默认是 `approved`，审核开关全在应用层 settings；任何绕过 app 的写入（seed/运维 SQL/导入）默认对外可见，「安全默认值放错层」。
8. `seed.js:406-408` — 生产也灌随机 `published_at`（近 20 天）、`views`(50-549)、`likes`(0-59)，与 489-501 行「生产只记真实 /stats/record，不再灌随机数把仪表盘画歪」直接矛盾：访问统计守住了，阅读/点赞没有。
9. `seed.js:414` — `insert(...).catch(()=>{})` 静默吞掉 `article_tags` 的全部失败；seed 仍打印「文章 6 篇就绪」，而标签页/归档可能静默缺数据。
10. `seed.js:447-455` — 楼中楼靠 `article_id+nickname+content` 三元组回填：同文同昵称同内容的两条评论会被改成同一 `parent_id`；`commentRows[c.parent]` 又假设下标与插入顺序严格对应，任一跳过就指错楼层。
11. `seed.js:382` — `slug: name.toLowerCase()`：中文标签的 slug 就是中文原文（未 URL 化）；`'Vue'` 与将来 `'vue'` 撞 `slug` 唯一键，这条 insert 无 catch，整个 seed 退出。
12. `seed.js:17-25` 对照 `blog.sql:26-27` — 两套口令策略数量级不一致：管理员 ≥12 位且非纯数字/纯字母，DB 账号 ≥20 位且只拦「短+纯字母数字」。20 位全小写能过 SQL 却过不了 seed，`Passw0rd!!!1` 两处都能过 —— 都无熵/字典判定。
13. `seed.js:333-337` — 首次建 admin 不检查 `sessions`，只有「替换默认密码」分支(345-348)做了 `hasTable` 前置与可读报错；未迁移时首装拿到的是 MySQL `ER_NO_SUCH_TABLE` 而非「请先 npm run migrate」。
14. `seed.js:480-485` — `.onConflict('key').ignore()` 使「改 `DEFAULT_SETTINGS` 默认值」对已有库**永不生效**（含 `og_image`、`site_url` 这类默认值即功能的键），只有删行才生效。
15. `seed.js:489-497` — 测试环境 `visits` 用 `merge` + `visits.pv + ?` **累加**，同一测试库反复 seed 把 14 天曲线越叠越高；同文件其余表全是「存在即跳过」，仅此一处非幂等。
16. `seed.js` 全文 — 不灌 `notes`，而 `migrate.js:348-350` 把 notes 定义为「个人主页的短文时间线」→ 主页入口首装空时间线，`deploy/README.md:126` 的 `grep -c '#/notes'` 自检在首装环境必为 0。
17. `blog.sql:25-27` — 强度判定 `CHAR_LENGTH<20 OR REGEXP '^[[:alnum:]]{1,19}$'`：20 位以上纯数字/纯小写字母照样通过，与 17 行注释「强随机密码」不符（只校验长度）。
18. `blog.sql:17、32-46、59-60` — 明文密码先给用户变量再拼进 `PREPARE`；末尾只把会话变量置 NULL，`general_log` 与 `events_statements_history`（若开）会长期留两份明文。
19. `blog.sql:33、41、49` 对照 `.env.example:26` — 账号固定 `'xalor'@'localhost'`，而 `DB_HOST=127.0.0.1` 是 TCP 语义；开 `skip_name_resolve` 时 127.0.0.1 不匹配 `'localhost'`，报 `Access denied for user 'xalor'@'127.0.0.1'` —— 两处默认值互相矛盾，且报错里的账号名看起来是对的。
20. `.env.example:36` — 唯一未注释的是单机白名单 `ALLOWED_HOSTS=localhost,127.0.0.1,::1`，双域名示例(35)被注释。`cp .env.example .env` 上线会让**两个真实域名都 403**；README:83 有文字警告，但默认值本身是错的（文档兜代码）。
21. `.env.example:55` 对照 `nginx-locations.inc:38` — `TRUST_PROXY=loopback` 的正确性依赖覆盖式 `proxy_set_header X-Forwarded-For $remote_addr`。若按常见教程改成 `$proxy_add_x_forwarded_for`（追加），配合 loopback 信任，任意客户端可伪造 XFF 冒充 IP，绕过 `ip_bans` 与信誉分；这条耦合没写在任何一处。
22. `.env.example:14` — `JWT_SECRET=` 为空且注释称「开发模式自动生成」，生产漏配只**静默降级**（多进程/重启即全量掉线），无启动期硬失败；`DB_PASSWORD` 空、`SEED_ADMIN_PASSWORD` 注释同属一类。
23. `nginx-realip-esa.conf:37-49` — 全部 `set_real_ip_from` 默认注释，「复制即上线」的默认状态正好是最危险档：一个访客的垃圾提交封掉整个回源节点，该节点后所有访客 403。文件前两节写「必须」，却没有 fail-fast（例如检测 `$realip_remote_addr == $remote_addr` 打专用告警日志）。
24. `nginx-realip-esa.conf:56-60` — `log_format`/`access_log` 无条件生效，与站点自身 access_log 双写，且把客户端**可伪造**的 `xff="$http_x_forwarded_for"` 原样落盘；运维照此 grep 做封禁会封到伪造值。
25. `nginx.conf.example:53` 对照 `README.md:113` — 示例把 include 放在 server 块之外（假定 http 上下文），README 的安装路径却是复制到 `sites-available`（http 内片段）。照 README 安装而 include 留在顶层，`log_format` 就落在 http 之外，`nginx -t` 报 `"log_format" directive is not allowed here`，整站起不来；文件 62-64 行承认该约束却没改安装路径。
26. `nginx.conf.example:65、77、98、109` — 同一份 400+ 字符 CSP 复制 4 遍（两块 + 两个精确 location），且**必须**复制（location 级 `add_header` 清空继承）。任一次策略收紧要改 4 处，漂移风险高，注释未说明为何重复。
27. `nginx.conf.example` 全文 — 只有 `listen 80`，无 TLS/443/HSTS/gzip/`error_page`；而 README:97 要求配证书、ESA 章节与 `X-Forwarded-Proto` 语义都假定 TLS 已终止。示例不可直接上线，也没有一行说明 TLS 该加在哪。
28. `nginx.conf.example:75-85` 对照 `107-117` — 主页域缺 `location = /index.html`（博客域有 `= /index.html`）：`xalor.cn/index.html` 会落到 `location /` 返回**博客入口**并丢掉 `no-store` —— 双入口串味 + 部署后看到旧页。
29. `README.md:172、196` 对照 `nginx-locations.inc:46` — 文档反复要求「`/health*` 不缓存」，include 的正则却是 `^/(robots\.txt|sitemap\.xml|rss\.xml|health)$`，只匹配裸 `/health`；真实探活是 `/api/health/live`、`/api/health/ready`（`.env.example:107`），落在 `^~ /api/` 里。文档与实现不一致，边缘按前缀缓存健康检查时这条规则挡不住。
30. `backup.sh:24-26` — `DB_USER/DB_PASS/DB_NAME` 只读环境变量（默认 root/空/`xalor_blog`），**不读 `server/.env`**。真实部署改了库名或改 `xalor` 账号后，不带环境变量执行会以 root 空密码连默认库：在「库存在但非生产库」的机器上静默备份错库并返回 0。
31. `backup.sh:46-49` — 注释称「避免出现在进程列表/日志」，`MYSQL_PWD` 确实不进 argv，但仍出现在 `/proc/<pid>/environ` 并被 mysqldump 子进程继承；`--defaults-extra-file`(0600 临时文件) 才是完整做法，注释过度承诺。
32. `backup.sh:88-104` — `prune_old` 用 `sort -r` 排序而 `STAMP` 只到秒：同一秒两次执行写同名文件（后者覆盖前者），保留策略只看到 1 份；`"$prefix"*"$suffix"` 也会匹配 `xalor_db_….sql.extra` 类非本脚本产物。
33. `backup.sh:110-111` 对照 `README.md:47-48` — 成功提示只教 `mysql -u $DB_USER $DB_NAME < dump`（README 更直接用 `-u root`），生产账号有密码时恢复会失败；而唯一备份的配置是 `.env.example`（不含 `JWT_SECRET`/`DB_PASSWORD`/SMTP），恢复后必须另有一份密钥备份 —— README 的「恢复备份」小节没写这条。
34. `.gitignore:21-22` — `!deploy/backup/` + `!deploy/backup/**` 当前是惰性规则（无父规则忽略 `deploy/`）；注释声称防「将来有人加 `deploy/` 宽规则」，但真加了 `deploy/` 后 git 不会 descend 进被忽略的父目录，必须同时有 `!deploy/` 才生效。回滚文件的可入库性因此只靠「现在没人写宽规则」。
35. `.gitignore:16` — `CHANGELOG.md` 被忽略，与 README:268 建立的「仓库即回滚源、历史版本必须入库」取向冲突：回滚靠 `deploy/backup/` 的版本化文件，产生这些版本的变更记录不入库。
36. `.gitignore:5-7、63-64` — 规则重叠：`.env.*` 已覆盖 `*.env.local`/`.env.*.local`，`*.log` 已覆盖 `.autofix.log`；同时 `image.jpg` 这种**具体文件名**进 ignore，说明有工具往仓库根写文件，属「用忽略规则擦地」。

## 小结

1. 这 9 个文件是一条「一次性 bootstrap 链」：`blog.sql`(建库建账号) → `migrate.js`(建表/补列/索引) → `seed.js`(管理员+示例) → `.env` → nginx 双站 → `backup.sh`。链上没有任何一环由代码强制串起（无启动期迁移、无配置校验），正确性全靠 README 的执行顺序。
2. 表结构是应用语义的下游而非上游：`status` 默认 `approved`、`published_at` 可空、`settings` 存 JSON、`security_config` 独立成表 —— 都为让路由层少写判断，代价是任何直接写库的路径都绕过审核与状态机。
3. 幂等性质量参差：`migrate.js` 的幂等只到「表/列/索引是否存在」，跨版本补丁有明确盲区（`messages.replied_at`、`articles` 多数列）；`seed.js` 多数是「存在即跳过」，但 `visits` 累加、`categories` 会覆写 `description/color`。
4. 安全边界被下沉到配置与运维：`JWT_SECRET`/`DB_PASSWORD` 空值只降级不报错，`SEED_ADMIN_PASSWORD` 与 `blog.sql` 占位符是仅有的两处硬失败，DB 账号权限收得窄（无 DROP/FILE）。因此「配置漏配」是比代码漏洞更现实的失陷路径。
5. 双域名是贯穿本分区的隐性契约：`ALLOWED_HOSTS`（Host + Origin 白名单）、`CORS_ORIGINS`、`HOME_SITE_HOST`、两个 server 块的 `index`/`try_files`、SEO 的 `#/notes` 分流；任一处单域名化都表现为「页面能看、写操作 403」或「主页被博客内容顶掉」。
6. 边缘/CDN 接入成本被低估：realip 默认不生效、示例只有 80 端口，而限流/票据/信誉全以 `req.ip` 为维度 —— 三者叠加使「先接 CDN 再补配置」等于把封禁打在回源节点上。本分区最需要自动化（启动自检、`nginx -t` 前置、备份校验）的位置，目前全靠文档纪律。
