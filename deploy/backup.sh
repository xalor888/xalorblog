#!/usr/bin/env bash
# Xalor 小站数据备份脚本：数据库 + 上传文件 + 站点配置
# 用法：./backup.sh [备份目录]（默认脚本同目录的 backups/，保留最近 14 份）
# 环境变量：
#   MYSQLDUMP - mysqldump 可执行文件路径（自动探测常见位置，也可显式指定）
#   DB_USER / DB_PASS / DB_NAME - 数据库账号（默认 root / 空密码 / xalor_blog）
set -euo pipefail

# 备份文件可能包含全量业务数据，默认仅属主可读写
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SERVER_DIR="$PROJECT_DIR/server"
UPLOAD_DIR="$SERVER_DIR/uploads"
ENV_EXAMPLE="$SERVER_DIR/.env.example"

# 默认路径和项目输入路径都规范化为绝对路径，脚本可从任意工作目录执行。
BACKUP_DIR_INPUT="${1:-$SCRIPT_DIR/backups}"
mkdir -p "$BACKUP_DIR_INPUT"
BACKUP_DIR="$(cd "$BACKUP_DIR_INPUT" && pwd -P)"
chmod 700 "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
# 数据库凭据：环境变量优先；未提供时**从 server/.env 读取**（只读 DB_* 三项）。
#
# 为什么要读 .env：这个脚本运行的机器上，正确凭据已经在 server/.env 里了。
# 不读的话用户必须记得手动传三个变量 —— 忘了 DB_USER 就会用 root 去连，
# 报一个「Access denied」，看起来像密码错了，实际是用户名错了。
# 只读 DB_HOST/DB_USER/DB_PASSWORD/DB_NAME 四个键，不 source 整个文件
# （source 会执行文件里的任意 shell 代码，而 .env 是纯数据）。
read_env_key() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  # 去掉行首空白、取 KEY=VALUE、剥掉可选的成对引号；忽略注释与空行
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" \
    | tail -n 1 \
    | sed 's/^["'"'"']//; s/["'"'"']$//'
}
SERVER_ENV="$SERVER_DIR/.env"
DB_USER="${DB_USER:-$(read_env_key DB_USER "$SERVER_ENV")}"
DB_PASS="${DB_PASS:-$(read_env_key DB_PASSWORD "$SERVER_ENV")}"
DB_NAME="${DB_NAME:-$(read_env_key DB_NAME "$SERVER_ENV")}"
# 兜底：.env 里也没有时才用默认值（root/空密码 是 mysqldump 的本地默认）
DB_USER="${DB_USER:-root}"
DB_NAME="${DB_NAME:-xalor_blog}"
DB_HOST_FROM_ENV="$(read_env_key DB_HOST "$SERVER_ENV")"
# 非 localhost 时 mysqldump 需要 -h，否则会去连本地 socket
DB_HOST_ARG=()
if [ -n "$DB_HOST_FROM_ENV" ] && [ "$DB_HOST_FROM_ENV" != "localhost" ] && [ "$DB_HOST_FROM_ENV" != "127.0.0.1" ]; then
  DB_HOST_ARG=(-h "$DB_HOST_FROM_ENV")
fi

# 探测 mysqldump（环境变量 → PATH → 常见安装位置）
MYSQLDUMP="${MYSQLDUMP:-}"
if [ -z "$MYSQLDUMP" ]; then
  for cand in mysqldump \
    "/opt/homebrew/bin/mysqldump" \
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
DB_BACKUP="$BACKUP_DIR/xalor_db_$STAMP.sql"
if ! "$MYSQLDUMP" -u "$DB_USER" "${DB_HOST_ARG[@]}" --single-transaction --no-tablespaces --routines --triggers "$DB_NAME" \
  > "$DB_BACKUP"; then
  rm -f "$DB_BACKUP"
  echo "✗ 数据库备份失败（请检查 mysqldump 凭据）" >&2
  exit 1
fi

# 上传文件
if [ -d "$UPLOAD_DIR" ]; then
  UPLOAD_BACKUP="$BACKUP_DIR/xalor_uploads_$STAMP.tar.gz"
  if ! tar -czf "$UPLOAD_BACKUP" -C "$SERVER_DIR" uploads; then
    rm -f "$UPLOAD_BACKUP"
    echo "✗ 上传文件打包失败" >&2
    exit 1
  fi
else
  echo "ℹ 上传目录不存在，跳过 uploads 备份：$UPLOAD_DIR"
fi

# 站点设置（含 env 中的密钥配置说明，不含密钥本身）
if [ ! -f "$ENV_EXAMPLE" ]; then
  echo "✗ 配置模板不存在：$ENV_EXAMPLE" >&2
  exit 1
fi
ENV_BACKUP="$BACKUP_DIR/env_example_$STAMP.txt"
if ! cp "$ENV_EXAMPLE" "$ENV_BACKUP"; then
  echo "✗ 配置模板备份失败：$ENV_EXAMPLE" >&2
  exit 1
fi
chmod 600 "$ENV_BACKUP"

# 保留最近 14 份
prune_old() {
  local prefix="$1"
  local suffix="$2"
  local index=0
  local file
  while IFS= read -r file; do
    index=$((index + 1))
    if (( index > 14 )); then
      rm -f "$file"
    fi
  done < <(
    for file in "$BACKUP_DIR"/"$prefix"*"$suffix"; do
      [ -e "$file" ] || continue
      printf '%s\n' "$file"
    done | LC_ALL=C sort -r
  )
}

prune_old 'xalor_db_' '.sql'
prune_old 'xalor_uploads_' '.tar.gz'
prune_old 'env_example_' '.txt'

echo "✓ 备份完成：${BACKUP_DIR}（${STAMP}）"
echo "  恢复：mysql -u $DB_USER $DB_NAME < $DB_BACKUP"
