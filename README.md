# Xalor 的小站

Vue 3 + Express + MySQL 的前后端分离个人博客。

## 结构

| 目录 | 作用 |
|---|---|
| `web/` | Vue 3 + Vite + Pinia 前台与后台 SPA（hash 路由） |
| `server/` | Express API（Knex / MySQL 8） |
| `deploy/` | systemd、Nginx 示例、备份脚本 |

生产部署步骤见 [`deploy/README.md`](deploy/README.md)。

## 本地开发

需要 Node.js ≥ 20、MySQL 8、JDK 无关。先按 `blog.sql` 建库（替换密码占位值），再：

```bash
cp server/.env.example server/.env   # 填写 DB_PASSWORD、JWT_SECRET
cd server && npm install && npm run migrate && npm run seed && npm run dev

cd web && npm install && npm run dev
```

前端开发服默认 `127.0.0.1:5173`，把 `/api` 和 `/uploads` 反代到 `127.0.0.1:3000`。

## 测试

```bash
cd server
npm test          # 不启服务的单元套件（sanitize / feed / requestGuard / likeGuard）
npm run test:all  # 需本机 MySQL 与已启动 API；Windows 路径见 test/run.js
```

## 安全边界（不要过度解读）

这是自托管个人站能做到的采集成本抬升，**不是** Cloudflare Bot Manager。

- **读接口也要签名**。持有 `X-Pass` 不够，GET 必须带 `X-Sig` + 一次性 nonce。
- **文章详情** AES-GCM，密钥 = HMAC(盐, 票据|slug)。抓包一篇不能解开另一篇。库内正文仍是明文。
- **短时刮取窗**：同一 IP+指纹 45 秒内超过 12 篇不同文章（或 24 次详情）返回 429 并计信誉。
- **RSS 默认摘要**；分享页只用摘要做 OG，不再查正文。后台打开「RSS 全文」后订阅器仍可直接拿全文。
- **通行证 jti 落库**（`gate_tickets`），重启后未过期票仍可用。登录锁定、nonce、刮取窗、信誉分仍主要在内存；systemd 按**单进程**设计。
- 生产默认 PoW **20 bit**（可用 `POW_DIFFICULTY` 调整）。开发默认 16，避免本机卡顿。
- `ADMIN_PATH` 不要设成 WAF 蜜罐名（如 `admin`）。
- 未捕获异常会退出进程，由 systemd `Restart=always` 拉起。

探活：`GET /api/health/live`（不查库）、`GET /api/health/ready`（查库，失败 503）。旧路径 `/api/health` 仍可用。
