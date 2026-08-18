#!/bin/bash
# macOS 版测试运行器：逐套件清库 + 重启服务（等端口释放，防串状态）
MYSQL=/opt/homebrew/opt/mysql/bin/mysql
cd "$(dirname "$0")/.." || exit 1
reset_db() {
  $MYSQL -u root xalor_blog -e "DELETE FROM ip_bans; UPDATE users SET totp_secret = NULL, totp_enabled = false; DELETE FROM comments WHERE ip = '::1'; DELETE FROM messages WHERE ip = '::1';" 2>/dev/null
}
port_free() {
  ! lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1
}
restart_server() {
  pkill -f "node src/server.js" 2>/dev/null
  for i in $(seq 1 20); do port_free && break; sleep 0.5; done
  port_free || { echo "端口 3000 未释放"; return 1; }
  (nohup node src/server.js > /tmp/blog-server.log 2>&1 &)
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" -H "User-Agent: Mozilla/5.0 test" http://localhost:3000/api/health 2>/dev/null)
    echo "$code" | grep -qE "200|403" && return 0
    sleep 0.5
  done
  echo "服务启动超时"; tail -5 /tmp/blog-server.log; return 1
}
SUITES="${@:-admin.test.js 2fa.test.js session.test.js lockout.test.js journey.test.js waf.test.js requestGuard.test.js likeGuard.test.js security.test.js}"
PASS=0; FAIL=0; FAILED=""
for s in $SUITES; do
  reset_db
  restart_server || exit 1
  echo "========== $s =========="
  if node test/$s; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED="$FAILED $s"; fi
done
echo ""
echo "===== 总计: $PASS 通过, $FAIL 失败 ====="
[ -n "$FAILED" ] && echo "失败套件:$FAILED"
