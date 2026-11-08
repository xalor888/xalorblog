# 部署辅助文件

本目录包含 Xalor 小站的生产部署辅助资源。

## 环境要求

| 组件 | 版本 |
|---|---|
| Node.js | **≥ 20**（开发/测试环境验证于 Node 25；生产建议 LTS 22） |
| MySQL | 8.x（utf8mb4；8.4 验证通过） |
| Nginx | 1.20+（反代 + 静态资源；HTTPS 建议开启 HTTP/2） |

## 文件说明

| 文件 | 用途 |
|---|---|
| `xalor-blog.service` | Linux systemd 服务单元：Node 常驻 + 崩溃自动重启 + 最小权限用户 |
| `backup.sh` | 数据备份脚本：数据库（mysqldump）+ 上传文件 + 配置模板，保留最近 14 份 |
| `nginx.conf.example` | Nginx 静态站点、安全响应头与本机 API 反代示例 |

## backup.sh 用法

```bash
# 可从任意工作目录执行；默认备份到 deploy/backups/
/path/to/xalorblog/deploy/backup.sh

# 指定备份目录
./backup.sh /var/backups/xalor

# 自定义数据库凭据（用隐藏输入避免密码进入 shell 历史）
read -r -s -p '数据库密码: ' DB_PASS && echo
export DB_PASS
DB_USER=root ./backup.sh
unset DB_PASS

# Windows/Git Bash：脚本会自动探测 MySQL 安装路径；
# 若未找到 mysqldump，显式指定：
MYSQLDUMP="/c/Program Files/MySQL/MySQL Server 8.4/bin/mysqldump" ./backup.sh
```

脚本以自身位置定位 `server/uploads` 与 `server/.env.example`，不会依赖调用时的工作目录。
数据库、上传文件或配置模板任一备份失败都会返回非零退出码；输出目录及文件默认仅属主可读。

### 恢复备份

```bash
mysql -u root xalor_blog < /var/backups/xalor/xalor_db_YYYYMMDD_HHMMSS.sql
tar -xzf /var/backups/xalor/xalor_uploads_YYYYMMDD_HHMMSS.tar.gz -C /path/to/xalorblog/server/
```

### 定时备份（Linux cron，每日凌晨 2 点）

```cron
0 2 * * * /path/to/xalorblog/deploy/backup.sh /var/backups/xalor >> /var/log/xalor-backup.log 2>&1
```

## systemd 服务（Linux）

```bash
# 1. 编辑 service 中所有 /path/to/xalorblog 路径，并准备最小写目录
sudo install -d -o www-data -g www-data -m 0700 /path/to/xalorblog/server/uploads
sudo chown root:www-data /path/to/xalorblog/server/.env
sudo chmod 0640 /path/to/xalorblog/server/.env

# 2. 安装、校验并启用
sudo cp xalor-blog.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/xalor-blog.service
sudo systemctl daemon-reload
sudo systemctl enable --now xalor-blog

# 常用管理命令
sudo systemctl status xalor-blog   # 查看状态
sudo journalctl -u xalor-blog -f   # 查看日志
sudo systemctl restart xalor-blog  # 重启
```

> ⚠ 生产环境务必先在 `server/.env` 配置 `JWT_SECRET`（32+ 位随机串）、
> `ALLOWED_HOSTS`、`CORS_ORIGINS`。service 会固定设置
> `NODE_ENV=production`、`LISTEN_HOST=127.0.0.1`、`TRUST_PROXY=loopback`；
> 不要使用 `TRUST_PROXY=1` 或 `true`。
>
> 双站点部署还要多三项：
> - `ALLOWED_HOSTS` **必须同时包含两个域名**（如 `xalor.cn,blog.xalor.cn,localhost,127.0.0.1,::1`）——
>   它同时是 Host 头校验和写请求 Referer/Origin 的白名单，漏填会让其中一个域名整站 403。
> - `CORS_ORIGINS` **必须同时包含两个 https 来源**（如 `https://xalor.cn,https://blog.xalor.cn`）。
>   这一项最容易被当成「同源就不用配」而漏掉：浏览器对**同源 POST/PUT/DELETE 也会带 Origin 头**
>   （只有 GET/HEAD 不带），漏配的表现是页面能看、但该域名下点赞/评论/留言等写操作全部 403
>   「不允许的跨域来源」。回归覆盖见 `server/test/notes.test.js` 的「跨站来源白名单」断言。
> - `HOME_SITE_HOST` 填个人主页域名（如 `xalor.cn`），用于 SEO 路由按域名派发；留空则不派发。
>
> 通行证 jti 会写入 `gate_tickets`。nonce、登录锁定、刮取窗和大部分信誉状态仍在进程内存中。
> 本 service 按单进程运行；不要用 cluster 或多副本，除非先把这些状态外置。
> 生产默认 PoW 20 bit。`ADMIN_PATH` 不要使用 `admin`、`login` 等 WAF 蜜罐路径名。

## Nginx 反向代理

复制并编辑 `nginx.conf.example`，至少替换域名、`web/dist` 绝对路径，并配置 HTTPS 证书。
示例会让静态前端返回 CSP（含 `frame-ancestors 'none'`）和 `X-Frame-Options: DENY`，
且覆盖客户端传入的转发头，再把真实来源地址/协议传给仅监听 `127.0.0.1:3000` 的后端。

示例是**两个 server 块**，共用一份前端产物（Vite 双入口）与一个后端：

| 域名 | 根文件 | 兜底 |
|---|---|---|
| 博客域 | `web/dist/index.html` | `try_files $uri $uri/ /index.html` |
| 个人主页域 | `web/dist/home.html` | `try_files $uri $uri/ /home.html` |

`/api/`、`/uploads/` 与 `robots.txt|sitemap.xml|rss.xml|health` 三段反代抽在
`nginx-locations.inc` 里，两个 server 块 `include` 同一份，避免代理头漂移。
**`proxy_set_header Host $host` 必须保留** —— 后端按 Host 派发主页版/博客版的 SEO 路由。

### ⚠ `include` 的位置决定它有没有生效

两份 include 文件的**上下文（context）不一样**，放错位置不会报错，只会静默失效：

| 文件 | 必须放在 | 放错会怎样 |
|---|---|---|
| `nginx-locations.inc` | **`server { }` 块内**（每台 server 各一次） | 放在 `http { }` 里 → nginx 直接报 `location directive is not allowed here` 启动失败（这种还算好的） |
| `nginx-realip-esa.conf` | **`http { }` 块内**（`server` 之外，全局一次） | 放进 `server { }` 里 → `set_real_ip_from` 只对该虚拟主机生效；更常见的是 `include` 被放在某个 server 内而另一个 server 没放，于是**一个域还原了真实 IP、另一个没有**，表现为「博客站封禁正常、主页站一封就全站 403」 |

判断方法：`nginx -T | grep -n "real_ip_module\|set_real_ip_from"` 看它是否出现在**所有** server 之前。
自检命令见 C 节。

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/xalor.conf
sudo cp nginx-locations.inc /path/to/xalorblog/deploy/    # 保持 include 路径与之一致
sudo nginx -t
sudo systemctl reload nginx
```

若自定义了 `API_PREFIX`，必须同步修改 `nginx-locations.inc` 的 `/api/` location。

上线后自检：

```bash
curl -sI https://xalor.cn/ | head -1            # 主页域应返回 home.html 的内容（200）
curl -s  https://xalor.cn/robots.txt | head -3  # 应含「Xalor 的个人主页」
curl -s  https://xalor.cn/sitemap.xml | grep -c '#/notes'   # 应 > 0
curl -s  https://blog.xalor.cn/sitemap.xml | grep -c '#/notes'  # 应为 0
```


## 前置 CDN / 边缘加速（以阿里云 ESA 为例）

站点安全（PoW 通行证、请求签名、限流、IP 信誉封禁）全部在应用层自建，不依赖任何厂商；
Cloudflare、阿里云 ESA/DCDN、腾讯 EdgeOne 都可替换。接入前请先看 `nginx.conf.example`
顶部的要点，其中两条不配会「整片打死」：

### A. 源站侧（本仓库，两步）

**1. 还原真实客户端 IP —— `deploy/nginx-realip-esa.conf`**

`nginx.conf.example` 已在 http 上下文 `include` 了它。需要你做的只是把 ESA 控制台的
「回源 IP 段」逐段填进 `set_real_ip_from`（文件内有占位行）。**没填 = 不生效**（站点不会
坏，但会造成下面的误伤），所以接完必须做 C 节验证。

不还原会怎样：Nginx 的对端是 ESA 回源节点，而本应用的票据绑定、限流、刮取窗、点赞防刷、
信誉分与自动封禁全部以 `req.ip` 为维度 —— 结果是一个访客的垃圾提交会封掉**整个回源节点**，
该节点后面所有访客全站 403。

**2. 源站禁止直连 —— 安全组优先，校验头兜底**

`set_real_ip_from` 只信任所列网段，所以直连源站无法伪造 XFF；但源站 IP 一旦暴露，
攻击者绕过 ESA 直连就能跳过边缘 WAF/CC，而应用层基于 IP 的防护只作用在他自己的连接上。

- 首选：云安全组入方向 `80/443` 只放行 ESA 回源网段，`22` 只放行你的办公/跳板 IP。
- 兜底：无法改安全组时，用 `nginx-locations.inc` 顶部的「源站校验头」（默认注释）——
  让 ESA 回源时追加 `X-Origin-Verify`，Nginx 校验失败直接 `444`。

**3. 把 ESA 回源网段加进应用白名单**

安全中心 → WAF 防护设置（或 `.env` 的 `TRUSTED_IPS`，支持 CIDR）。白名单 IP **不记信誉分、
不会被自动封禁** —— ESA 自身的健康检查与漏洞扫描也会回源，不加白名单有可能把边缘节点
打成封禁，进而整片 403。

### B. ESA 控制台配置清单

| 项 | 配置 |
|---|---|
| 加速域名 | `xalor.cn` 与 `blog.xalor.cn` 都要（可分别建站点） |
| 源站 / 回源 Host | **必须保持为加速的域名本身**（ESA 默认即如此）。应用按 Host 派发 SEO 路由并校验 `ALLOWED_HOSTS`，被改写会 403 |
| 回源协议 | 推荐 HTTPS 回源（回源证书用你自己的；用 HTTP 回源时应用不会下发 HSTS） |
| 缓存：`/api/*` | **不缓存**（含 SSE 的 `/api/ai/ask`；带 `\.well-known` 也别缓存） |
| 缓存：`/sitemap.xml` `/rss.xml` `/robots.txt` `/health*` | **不缓存**（内容按 Host 派发，且源站已有 30s 缓存） |
| 缓存：`/index.html` `/home.html` `/` | **不缓存**（部署即生效） |
| 缓存：`/assets/*` | 长缓存（文件名带内容哈希，可 1 年 + immutable） |
| 缓存：`/uploads/*`、`/theme-init.js`、`/anti-debug.js` | **遵循源站**（应用已下发 `Cache-Control`；`?v=` 换版本靠源站头） |
| 全局缓存策略 | 默认选「遵循源站缓存头」。应用已为每类资源下发正确的 `Cache-Control`，比在边缘手写一堆规则更不容易漏 |
| 缓存键 | **必须保留全部查询串**，否则 `/theme-init.js?v=`、`/anti-debug.js?v=` 换版本失效，老访客继续跑旧脚本 |
| 压缩 | 源站已 gzip。开智能压缩后确认响应只有**一层** `Content-Encoding`（见 C-3） |
| 请求头透传 | 必须原样透传 `X-Pass` `X-Sig` `X-Nonce` `X-Timestamp` `X-Fp` `X-Hp-Field`；响应向不得吞掉 `X-Request-Id`、`Vary` |
| WAF / CC / Bot | 先「观察模式」跑 24h 再加拦截；把 `/api/` 从激进规则排除（应用层已有异常评分 WAF + 闸门签名，两层同时拦会难以排障） |
| 备案 | 中国大陆加速要求域名已完成 ICP 备案 |

### C. 接完的自检（三条，缺一不可）

```bash
# 1) 真实 IP 是否还原：观察自检日志的 remote_addr 与 peer
#    peer 是 ESA 节点、remote_addr 是你的访客 IP → 生效
#    两者相同且都是 ESA 段 → 网段没填对
tail -f /var/log/nginx/xalor-access.log

# 2) 自定义头是否透传（不通 = 通行证+签名链路失效，站点会一直加载失败）
cd server && TEST_BASE=https://<你的域名> node test/run.js journey.test.js

# 3) 压缩单层 + 动态不缓存
curl -sI -H 'Accept-Encoding: gzip' https://<你的域名>/assets/<带哈希的 js> | grep -ci content-encoding   # 期望 1
curl -sI https://<你的域名>/api/health/live | grep -i 'x-cache\|age'                                     # 期望不缓存
```

### D. 回滚

`nginx-realip-esa.conf` 是向后兼容的：网段留空不生效、请求不来自受信网段不生效。
所以回滚只需在 ESA 侧把域名解析指回源站（或暂停加速），**源站 nginx 一行都不用改**，
行为自动回到接入前。

容器中确需监听所有接口时，可设置 `LISTEN_HOST=0.0.0.0`，但必须用宿主机防火墙或容器网络
禁止客户端直连 3000 端口，并把 `TRUST_PROXY` 写成专用反代网络的真实 CIDR，例如
`TRUST_PROXY=172.30.0.0/24`（按实际网络替换）。仍禁止使用代理跳数 `1` 或 `true`。

## 首次数据库账号

`blog.sql` 不再包含可直接使用的固定密码。复制为不入库的本地文件，替换显式占位值后再执行：

```bash
cp /path/to/xalorblog/blog.sql /root/xalor-blog-bootstrap.sql
chmod 0600 /root/xalor-blog-bootstrap.sql
# 用编辑器把 __REPLACE_WITH_A_STRONG_RANDOM_PASSWORD__ 替换为至少 20 位强随机密码
mysql -u root < /root/xalor-blog-bootstrap.sql
```

占位值未替换或密码过弱时，SQL 会以 `SIGNAL` 拒绝创建/更新账号。随后把同一密码安全地写入
`server/.env` 的 `DB_PASSWORD`；不要提交或共享替换后的 SQL 副本。

## 首次管理员

除自动化测试的 `NODE_ENV=test` 外，seed 必须显式获得强 `SEED_ADMIN_PASSWORD`。建议只为
本次命令临时导出，不要把管理员密码写进命令行或长期保存在部署环境：

```bash
cd /path/to/xalorblog/server
npm run migrate
read -r -s -p '初始管理员密码: ' SEED_ADMIN_PASSWORD && echo
export SEED_ADMIN_PASSWORD
npm run seed
unset SEED_ADMIN_PASSWORD
```

若旧数据库仍是公开测试密码，seed 会在同一事务中替换密码并撤销该管理员的全部旧会话；
日志不会打印默认密码或新密码。

## 反调试脚本（`web/public/anti-debug.js`）的移动端兼容

v3 把「`outerHeight - innerHeight` 差值」与「`debugger` 计时」当作 DevTools 证据。手机浏览器
（尤其 Edge Android / Edge iOS）的地址栏与工具栏会让这两个量天然超阈值，结果正常用户被全屏
遮蔽层判成「打开了开发者工具」，整站不可用。

v4（2026-10-18）的判据：

| 端 | 窗口尺寸差 | debugger 计时 | 元素尺寸探针 | 触发条件 |
|---|---|---|---|---|
| 移动端（UA 含 `Mobile`/`EdgA/`/`EdgiOS/`，或 UA-CH `mobile`） | 不参与 | 不参与 | 参与 | 连续 2 个检测周期（约 2.4s）命中 |
| **iPadOS 13+「请求桌面网站」**（UA 是 `Macintosh` 外壳、Safari 无 UA-CH） | 不参与 | 不参与 | 参与 | 同上；靠 `platform === 'MacIntel' && maxTouchPoints > 1` 识别 |
| 桌面端 | 阈值 320px（`>320` 才触发） | 阈值 150ms（`>150` 才触发） | 参与 | 连续 2 个周期命中 |

单个周期抖动不再触发；关闭 DevTools 后自动恢复；`localStorage['xalor_dev_mode']='1'` 仍可整体关闭。

**验证**（无需真机，`node:vm` 造最小 DOM）：

```bash
cd web && node scripts/test-anti-debug.mjs
# 期望 14/14：Edge Android/iOS、iPad 桌面外壳、Android 平板放行；
# 桌面 400px 差、321px 边界、151ms、元素异常（含移动端）仍触发；320px/149ms 不触发；dev_mode 可关。
# 同一个脚本可以拿来对旧版本做对比：
#   node scripts/test-anti-debug.mjs deploy/backup/anti-debug.v3-20261018.js   → 8/14（v3 的 6 项失败）
```

**回滚**：改回 v3 并重新构建（`?v=` 版本号必须一起换，否则老访客继续跑缓存里的脚本）。

v3 原文**已随仓库提交**在 `deploy/backup/anti-debug.v3-20261018.js`（6 KB，sha256 与当时的
生产版本一致），所以**从仓库 clone 出来的部署目录也能直接回滚**：

```bash
# 在仓库根目录执行
cp deploy/backup/anti-debug.v3-20261018.js web/public/anti-debug.js
sed -i '' 's/anti-debug.js?v=[0-9a-z]*/anti-debug.js?v=20261018d/' web/index.html web/home.html
cd web && npm run build
```

> **不要**从 `HEAD` 里取脚本当回滚源：一旦 v4 提交入库，`HEAD` 指向的就是 v4，那样做会"成功地"
> 把 v4 再写一遍 —— 看着执行了、其实什么都没回滚，是**静默失败**。回滚只认 `deploy/backup/`
> 下的版本化文件（本仓库已入库）。

注意 `?v=` 用**新的**版本号（示例里是 `20261018d`），不要复用已经发出去的 `20261018a/c`：
浏览器缓存以 URL 为准，复用旧号等于让部分访客继续跑缓存里的脚本。
