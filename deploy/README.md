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

## backup.sh 用法

```bash
# 基本用法（备份到 deploy/backups/）
./backup.sh

# 指定备份目录
./backup.sh /var/backups/xalor

# 自定义数据库凭据
DB_USER=root DB_PASS='你的密码' ./backup.sh

# Windows/Git Bash：脚本会自动探测 MySQL 安装路径；
# 若未找到 mysqldump，显式指定：
MYSQLDUMP="/c/Program Files/MySQL/MySQL Server 8.4/bin/mysqldump" ./backup.sh
```

### 恢复备份

```bash
mysql -u root xalor_blog < backups/xalor_db_YYYYMMDD_HHMMSS.sql
tar -xzf backups/xalor_uploads_YYYYMMDD_HHMMSS.tar.gz -C server/
```

### 定时备份（Linux cron，每日凌晨 2 点）

```cron
0 2 * * * /path/to/xalorblog/deploy/backup.sh /var/backups/xalor >> /var/log/xalor-backup.log 2>&1
```

## systemd 服务（Linux）

```bash
# 1. 编辑服务文件中的路径与用户
# 2. 安装并启用
sudo cp xalor-blog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xalor-blog

# 常用管理命令
sudo systemctl status xalor-blog   # 查看状态
sudo journalctl -u xalor-blog -f   # 查看日志
sudo systemctl restart xalor-blog  # 重启
```

> ⚠ 生产环境务必先在 `server/.env` 配置 `JWT_SECRET`（32+ 位随机串）、
> `NODE_ENV=production`、`TRUST_PROXY=1`（Nginx 后）、`ALLOWED_HOSTS`、`CORS_ORIGINS`。
