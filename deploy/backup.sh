#!/usr/bin/env bash
# Xalor 小站数据备份脚本：数据库 + 上传文件 + 站点配置
# 用法：./backup.sh [备份目录]（默认 ./backups，保留最近 14 份）
# 环境变量：
#   MYSQLDUMP - mysqldump 可执行文件路径（自动探测常见位置，也可显式指定）
#   DB_USER / DB_PASS - 数据库账号（默认 root 空密码）
set -euo pipefail

# 备份文件可能包含全量业务数据，默认仅属主可读写
umask 077

BACKUP_DIR="${1:-$(dirname "$0")/backups}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
DB_USER="${DB_USER:-root}"
DB_PASS="${DB_PASS:-}"

# 探测 mysqldump（环境变量 → PATH → 常见安装位置）
MYSQLDUMP="${MYSQLDUMP:-}"
if [ -z "$MYSQLDUMP" ]; then
  for cand in mysqldump \
    "/c/Program Files/MySQL/MySQL Server 8.4/bin/mysqldump" \
    "/usr/bin/mysqldump" "/usr/local/bin/mysqldump"; do
    if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then
      MYSQLDUMP="$cand"
      break
    fi
  done
fi
if [ -z "$MYSQLDUMP" ]; then
  echo "✗ 未找到 mysqldump，请设置 MYSQLDUMP 环境变量指定路径" >&2
  exit 1
fi

# 通过环境变量传密码，避免出现在进程列表/日志中
if [ -n "$DB_PASS" ]; then
  export MYSQL_PWD="$DB_PASS"
fi

# 数据库（含 ip_bans / sessions / 全部业务数据）
# --no-tablespaces：MySQL 8 的 mysqldump 默认尝试导出表空间元数据，
# 需要 PROCESS 权限，普通业务账号会报 Access denied 警告（数据本身不受影响）——
# 博客数据无需表空间信息，显式跳过使备份对最小权限账号零告警
"$MYSQLDUMP" -u "$DB_USER" --single-transaction --no-tablespaces --routines --triggers xalor_blog \
  > "$BACKUP_DIR/xalor_db_$STAMP.sql" \
  || { echo "✗ 数据库备份失败（请检查 mysqldump 凭据）" >&2; exit 1; }

# 上传文件
if [ -d "server/uploads" ]; then
  tar -czf "$BACKUP_DIR/xalor_uploads_$STAMP.tar.gz" -C server uploads 2>/dev/null \
    || { echo "✗ 上传文件打包失败（Windows 无 tar 可忽略此步）" >&2; }
fi

# 站点设置（含 env 中的密钥配置说明，不含密钥本身）
cp server/.env.example "$BACKUP_DIR/env_example_$STAMP.txt" 2>/dev/null || true

# 保留最近 14 份
ls -1t "$BACKUP_DIR"/xalor_db_*.sql 2>/dev/null | tail -n +15 | xargs -r rm -f 2>/dev/null || true
ls -1t "$BACKUP_DIR"/xalor_uploads_*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f 2>/dev/null || true

echo "✓ 备份完成：$BACKUP_DIR（$STAMP）"
echo "  恢复：mysql -u $DB_USER xalor_blog < xalor_db_$STAMP.sql"
