#!/usr/bin/env bash
# 启动一个一次性的本地 MySQL 探针实例，供 notesSortIndex.test.js 跑 EXPLAIN。
#
# 为什么需要它：生产库的账号只有 SELECT/INSERT/UPDATE/DELETE/CREATE/INDEX/ALTER，
# **没有 CREATE TEMPORARY TABLE 与 DROP 权限** —— 而 EXPLAIN 对照实验需要建表。
# 两个 xalor_blog_audit* 库虽然有 ALL PRIVILEGES，但它们**根本不存在**（历史授权残留）。
#
# 所以：另起一个独立的 mysqld 实例，datadir 在 /tmp，测完整个删掉。
# 生产库全程只读，不碰。
#
# 用法：
#   scripts/probe-mysql.sh start   # 起实例，打印 socket 路径
#   scripts/probe-mysql.sh stop    # 停实例并清理 datadir
set -euo pipefail

DIR="${PROBE_MYSQL_DIR:-/tmp/mysqld_probe}"
SOCK="$DIR/mysql.sock"
PORT="${PROBE_MYSQL_PORT:-13399}"
MYSQLD="${MYSQLD_BIN:-/opt/homebrew/bin/mysqld}"
MYSQL="${MYSQL_BIN:-/opt/homebrew/bin/mysql}"
BASEDIR="${MYSQL_BASEDIR:-/opt/homebrew/opt/mysql}"

case "${1:-start}" in
  start)
    if [ -S "$SOCK" ] && "$MYSQL" --socket="$SOCK" -u root -e "SELECT 1;" >/dev/null 2>&1; then
      echo "$SOCK"; exit 0
    fi
    rm -rf "$DIR"; mkdir -p "$DIR/data"
    "$MYSQLD" --initialize-insecure --datadir="$DIR/data" --basedir="$BASEDIR" >/dev/null 2>&1
    "$MYSQLD" --datadir="$DIR/data" --socket="$SOCK" --port="$PORT" \
      --basedir="$BASEDIR" --log-error="$DIR/server.log" >/dev/null 2>&1 &
    for _ in $(seq 1 30); do
      if "$MYSQL" --socket="$SOCK" -u root -e "SELECT 1;" >/dev/null 2>&1; then
        echo "$SOCK"; exit 0
      fi
      sleep 1
    done
    echo "探针 MySQL 启动失败，见 $DIR/server.log" >&2; exit 1
    ;;
  stop)
    if [ -S "$SOCK" ]; then
      "$MYSQL" --socket="$SOCK" -u root -e "SHUTDOWN;" >/dev/null 2>&1 || true
    fi
    pkill -f "datadir=$DIR/data" >/dev/null 2>&1 || true
    rm -rf "$DIR"
    echo "已停止并清理 $DIR"
    ;;
  *) echo "用法: $0 {start|stop}" >&2; exit 1 ;;
esac
