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

## Nginx 反向代理

复制并编辑 `nginx.conf.example`，至少替换域名、`web/dist` 绝对路径，并配置 HTTPS 证书。
示例会让静态前端返回 CSP（含 `frame-ancestors 'none'`）和 `X-Frame-Options: DENY`，
且覆盖客户端传入的转发头，再把真实来源地址/协议传给仅监听 `127.0.0.1:3000` 的后端。

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/xalor-blog.conf
sudo nginx -t
sudo systemctl reload nginx
```

若自定义了 `API_PREFIX`，必须同步修改 Nginx 的 `/api/` location。

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
