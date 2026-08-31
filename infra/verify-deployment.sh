#!/usr/bin/env bash
# 阶段 0 退出条件：Linux 服务器 Docker 部署实测脚本。
# 在目标服务器（仓库根目录）执行：bash infra/verify-deployment.sh
# 覆盖：构建、启动、健康检查、重启持久性、镜像无 Chromium/Playwright 断言、内存基准采样。
set -uo pipefail

PASS=0
FAIL=0
REPORT="${REPORT:-infra/deployment-report.md}"
APP_PORT="${PORT:-1235}"

say() { echo "[verify] $*"; }
check() { # check <名称> <命令...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    say "PASS  $name"; PASS=$((PASS+1)); echo "- ✅ $name" >> "$REPORT"
  else
    say "FAIL  $name"; FAIL=$((FAIL+1)); echo "- ❌ $name" >> "$REPORT"
  fi
}

init_report() {
  cat > "$REPORT" <<EOF
# Docker 部署验证报告

- 日期：$(date '+%F %T')
- 主机：$(hostname)（$(uname -m)，$(nproc) vCPU / $(free -m | awk '/Mem:/{print $2}') MB RAM）

## 断言结果
EOF
}

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    say "docker 不可用，请在安装并启动 Docker 后重试"; exit 1
  fi
}

build_and_up() {
  say "构建镜像（多阶段，首次约 3-8 分钟）"
  docker compose -f infra/docker-compose.yml build 2>&1 | tail -2
  docker compose -f infra/docker-compose.yml up -d
}

await_health() {
  say "等待健康检查（最多 90s）"
  for _ in $(seq 1 45); do
    if curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
      say "PASS  /api/health 就绪"; PASS=$((PASS+1)); echo "- ✅ /api/health 就绪" >> "$REPORT"
      return 0
    fi
    sleep 2
  done
  say "FAIL  健康检查超时"; FAIL=$((FAIL+1)); echo "- ❌ /api/health 超时" >> "$REPORT"
  return 1
}

no_browser_assertion() {
  say "断言镜像内无 Chromium / Playwright"
  local hits
  hits=$(docker compose -f infra/docker-compose.yml exec app \
    sh -c "find / -maxdepth 6 \( -iname '*chromium*' -o -iname '*chrome*' -o -iname '*playwright*' \) -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | head -5" || true)
  if [ -z "$hits" ]; then
    say "PASS  镜像无 Chromium/Playwright"; PASS=$((PASS+1)); echo "- ✅ 镜像内无 Chromium/Playwright" >> "$REPORT"
  else
    say "FAIL  发现浏览器残留：$hits"; FAIL=$((FAIL+1)); echo "- ❌ 镜像内发现：$hits" >> "$REPORT"
  fi
}

mock_run_end_to_end() {
  say "发起一次 Mock 生成（不产生费用）"
  local run_id
  run_id=$(curl -fsS -X POST "http://127.0.0.1:${APP_PORT}/api/runs" \
    -H "content-type: application/json" \
    -d '{"topic":"部署验证：重启持久性","requestedImageConcurrency":1}' \
    | sed -E 's/.*"runId":"([^"]+)".*/\1/')
  if [ -z "$run_id" ]; then
    say "FAIL  创建运行失败"; FAIL=$((FAIL+1)); echo "- ❌ 创建运行失败" >> "$REPORT"; return 1
  fi
  for _ in $(seq 1 60); do
    local status
    status=$(curl -fsS "http://127.0.0.1:${APP_PORT}/api/runs/$run_id" | sed -E 's/.*"status":"([a-z_]+)".*/\1/')
    [ "$status" = "succeeded" ] && break
    [ "$status" = "failed" ] && break
    sleep 2
  done
  check "Mock 运行完成（run=$run_id）" test "$status" = "succeeded"
  echo "$run_id" > /tmp/aai-verify-run-id
}

restart_persistence() {
  say "重启容器验证持久性"
  docker compose -f infra/docker-compose.yml restart app >/dev/null
  sleep 8
  check "重启后 /api/health 恢复" curl -fsS "http://127.0.0.1:${APP_PORT}/api/health"
  local run_id
  run_id=$(cat /tmp/aai-verify-run-id 2>/dev/null || echo "")
  if [ -n "$run_id" ]; then
    check "重启后历史运行仍在（$run_id）" \
      curl -fsS "http://127.0.0.1:${APP_PORT}/api/runs/$run_id"
  fi
  local asset_count
  asset_count=$(docker compose -f infra/docker-compose.yml exec app sh -c "ls /data/assets/runs 2>/dev/null | wc -l" | tr -d '[:space:]')
  check "持久卷资产仍在（$asset_count 个 run 目录）" test "$asset_count" -ge 1
}

memory_baseline() {
  say "内存基准采样（docker stats --no-stream）"
  {
    echo ""
    echo "## 内存基准"
    echo ""
    echo "| 采样点 | 内存用量 |"
    echo "|---|---|"
    local idle
    idle=$(docker stats --no-stream --format "{{.MemUsage}}" "$(docker compose -f infra/docker-compose.yml ps -q app)" | awk '{print $1}')
    echo "| 空闲（目标 ≤250MB） | $idle |"
  } >> "$REPORT"
  say "空闲内存已记录（见报告）。单页合成峰值请保持本脚本运行并另开终端执行："
  say "  watch -n 1 'docker stats --no-stream --format \"{{.MemUsage}}\" \$(docker compose ps -q app)'"
  say "  同时在浏览器发起一次生成；峰值目标 ≤700MB，手动记入报告。"
}

main() {
  init_report
  require_docker
  build_and_up
  await_health || { docker compose -f infra/docker-compose.yml logs --tail 50 app; exit 1; }
  no_browser_assertion
  mock_run_end_to_end
  restart_persistence
  memory_baseline

  echo "" >> "$REPORT"
  echo "---" >> "$REPORT"
  echo "总计：$PASS 通过 / $FAIL 失败" >> "$REPORT"
  say "完成：$PASS 通过 / $FAIL 失败；报告：$REPORT"
  [ "$FAIL" -eq 0 ] || exit 1
}

main "$@"
