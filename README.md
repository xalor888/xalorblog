# Xalor 的小站

Vue 3 + Express + MySQL 的前后端分离站点。**一套后端 + 一套后台，服务两个前端入口**：

| 站点 | 入口 | 内容 |
|---|---|---|
| 个人主页 `xalor.cn` | `web/home.html` | 名片、手记（朋友圈式短文时间线）、最近文章、友链与关于预览 |
| 博客 `blog.xalor.cn` | `web/index.html` | 文章、归档、标签、分类、评论、留言、书签 |

## 结构

| 目录 | 作用 |
|---|---|
| `web/` | Vue 3 + Vite + Pinia：双入口多页（`index.html` / `home.html`），共享组件、主题、API 客户端与反爬逻辑 |
| `server/` | Express API（Knex / MySQL 8），两个域名共用 |
| `deploy/` | systemd、Nginx 示例（双 server 块 + 共用反代片段）、备份脚本 |

生产部署步骤见 [`deploy/README.md`](deploy/README.md)。

**后台只有一套**：仍挂在由 `JWT_SECRET` 派生的秘钥路径 `/:adminKey` 下，两个域名都能进；
侧边栏按「个人主页 / 博客 / 系统」分组（手记管理、主页设置在本仓库新增）。

## 本地开发

需要 Node.js ≥ 20、MySQL 8、JDK 无关。先按 `blog.sql` 建库（替换密码占位值），再：

```bash
cp server/.env.example server/.env   # 填写 DB_PASSWORD、JWT_SECRET
cd server && npm install && npm run migrate && npm run seed && npm run dev

cd web && npm install && npm run dev
```

前端开发服默认 `127.0.0.1:5173`，把 `/api` 和 `/uploads` 反代到 `127.0.0.1:3000`：

- 博客入口：<http://127.0.0.1:5173/>
- 个人主页入口：<http://127.0.0.1:5173/home.html>

双站互链（导航里的「文章/友链/关于」与「主页」）由 `VITE_BLOG_URL` / `VITE_HOME_URL`
配置，本地联调可在 `web/.env` 里指向本机端口，见 `web/.env.example`。

## 测试

```bash
cd server
npm test          # 不启服务的单元套件（sanitize / feed / requestGuard / likeGuard / notesCrypto / homeSummary）
npm run test:all  # 需本机 MySQL 与已启动 API；Windows 路径见 test/run.js
```

`npm run test:all` 里含 `notes.test.js`：未持票访问手记被闸门拒、列表不出正文、
详情按 `note:<id>` 分发密钥可解、点赞窗口 429、免票主页摘要字段白名单、
SEO 路由按 Host 派发（需 `.env` 配好 `HOME_SITE_HOST` 与 `ALLOWED_HOSTS`，否则该组断言自动跳过）。

```bash
cd web && npm run build   # 双入口构建，产出 dist/index.html 与 dist/home.html
```

前端构建前会先跑 `npm run check:script-order`（`web/scripts/check-script-order.mjs`）：
检查「顶层语句引用了后面才声明的 `const`/`let`/`class`」。这类问题 **构建期不报错**，
只在运行时抛 `ReferenceError`（TDZ），且组件在 setup 抛错时整页会**静默渲染为空** ——
表现和「路由没匹配上」一样，极难排查。本项目已真实踩过一次。
该脚本会剥离注释与字符串以降低误报，并排除会变量提升的 `function`/`var`（提前引用合法）。

## 安全边界（不要过度解读）

这是自托管个人站能做到的采集成本抬升，**不是** Cloudflare Bot Manager。

- **应用层 WAF 是异常评分制**（`server/src/middleware/waf.js` + 规则数据 `waf-rules.js`，方法论对齐 OWASP CRS）：
  命中按严重度加权（critical=5 / error=4 / warning=3），请求总分 ≥ 阈值（默认 5，安全中心可调）才 403；
  低分命中只记 `waf-mon` 监控事件，不拦也不计信誉分。规则按误杀风险分偏执等级 pl1/pl2/pl3
  （`paranoiaLevel` 控制启用上限），技术讨论常见形态（`eval(`/`alert(`/`order by`/模板字符串）不误拦。
  规则与语料绑定演进：`test/waf/fixtures/` 里每条规则有必命中样本 + 良性语料（含历史误杀回归），
  改规则先跑 `node test/waf-fixtures.test.js`。
- **读接口也要签名**。持有 `X-Pass` 不够，GET 必须带 `X-Sig` + 一次性 nonce。
- **文章详情 / 手记详情** AES-GCM，密钥 = HMAC(盐, 票据|slug 或 note:<id>)。抓包一篇不能解开另一篇。库内正文仍是明文。
- **手记与文章同级防护**：列表只出摘要，正文只在详情接口以密文下发；点赞复用同一套 IP 维度防刷。
- **短时刮取窗**：同一 IP+指纹 45 秒内超过 12 篇不同文章（或 24 次详情）返回 429 并计信誉。
- **RSS 默认摘要**；分享页只用摘要做 OG，不再查正文。后台打开「RSS 全文」后订阅器仍可直接拿全文。
- **通行证 jti 落库**（`gate_tickets`），重启后未过期票仍可用。登录锁定、nonce、刮取窗、信誉分仍主要在内存；systemd 按**单进程**设计。
- 生产默认 PoW **20 bit**（可用 `POW_DIFFICULTY` 调整）。开发默认 16，避免本机卡顿。
- `ADMIN_PATH` 不要设成 WAF 蜜罐名（如 `admin`）。
- 未捕获异常会退出进程，由 systemd `Restart=always` 拉起。

- **`GET /api/home/summary` 是唯一有意放行的免票读接口**：只服务主页首屏（名片/关于摘要/友链预览/最近文章标题），
  字段为固定白名单（`server/src/routes/home.js` 的 `buildSummary`，单测 `test/homeSummary.test.js` 锁死），
  不含任何密钥、不含手记正文；仍走 WAF、IP 信誉闸门、antiBot 与独立限流。
- SEO 路由（`/robots.txt`、`/sitemap.xml`、`/rss.xml`）按请求 **Host** 派发：主页域出主页版（手记摘要），
  博客域保持博客版；由 `HOME_SITE_HOST` 控制，留空则不派发。

探活：`GET /api/health/live`（不查库）、`GET /api/health/ready`（查库，失败 503）。旧路径 `/api/health` 仍可用。
