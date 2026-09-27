#!/bin/bash
# macOS 版测试运行器：逐套件清库 + 重启服务（等端口释放，防串状态）
MYSQL=${MYSQL_BIN:-$(command -v mysql || echo /opt/homebrew/opt/mysql/bin/mysql)}
cd "$(dirname "$0")/.." || exit 1
reset_db() {
  # 与 run.js 的 RESET_SQL 保持一致：
  # - links：journey 套件每次申请同一个 https://example.com，links.js 的
  #   「防重复申请」会拦下上一次遗留的 pending 记录（400），必须一并清掉
  # - ip_bans / totp / 本机留言：防跨套件污染（详见 run.js 注释）
  $MYSQL -u root xalor_blog -e "DELETE FROM ip_bans; UPDATE users SET totp_secret = NULL, totp_enabled = false; DELETE FROM comments WHERE ip IN ('::1', '127.0.0.1', '::ffff:127.0.0.1'); DELETE FROM messages WHERE ip IN ('::1', '127.0.0.1', '::ffff:127.0.0.1'); DELETE FROM links WHERE url = 'https://example.com';" 2>/dev/null
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
SUITES="${@:-admin.test.js 2fa.test.js session.test.js lockout.test.js journey.test.js waf.test.js falsePositive.test.js requestGuard.test.js likeGuard.test.js sanitize.test.js feed.test.js scrapeGuard.test.js contentCrypto.test.js security.test.js}"
PASS=0; FAIL=0; FAILED=""
for s in $SUITES; do
  reset_db
  restart_server || exit 1
  echo "========== $s =========="
  if node test/$s; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED="$FAILED $s"; fi
done
echo ""
echo "===== 总计: $PASS 通过, $FAIL 失败 ====="
# 收尾清理：security 套件会把 127.0.0.1 持久化封禁进 ip_bans（15 分钟），
# 不清会导致测试结束后本地站整站 403，且封禁在 DB、重启服务也无法恢复。
# 顺带清掉 2FA 残留与本机测试留言，把环境还原到可直接 npm run dev 的状态。
reset_db
restart_server || echo "[cleanup] 服务重启失败，请手动启动: npm run dev"
echo "[cleanup] 已清空 ip_bans / 2FA 残留 / 测试留言并重启服务"
if [ -n "$FAILED" ]; then
  echo "失败套件:$FAILED"
  exit 1
fi
exit 0
