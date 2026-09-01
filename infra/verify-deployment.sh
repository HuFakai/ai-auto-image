#!/usr/bin/env bash
# 阶段 0 退出条件：Linux 服务器 Docker 部署实测脚本。
# 在目标服务器（仓库根目录）执行：bash infra/verify-deployment.sh
# 覆盖：构建、启动、健康检查、/data 持久性、镜像无 Chromium/Playwright 断言、内存基准采样。
# 真实生成烟测默认关闭；设置 RUN_GENERATION_SMOKE=1 并提供 VERIFY_COOKIE 后才会调用模型并消耗额度。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
COMPOSE=(docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/docker-compose.yml")

PASS=0
FAIL=0
REPORT="${REPORT:-infra/deployment-report.md}"
APP_PORT="${APP_PORT:-1235}"

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
  "${COMPOSE[@]}" build 2>&1 | tail -2
  "${COMPOSE[@]}" up -d
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
  hits=$("${COMPOSE[@]}" exec -T app \
    sh -c "find / -maxdepth 6 \( -iname '*chromium*' -o -iname '*chrome*' -o -iname '*playwright*' \) -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | head -5" || true)
  if [ -z "$hits" ]; then
    say "PASS  镜像无 Chromium/Playwright"; PASS=$((PASS+1)); echo "- ✅ 镜像内无 Chromium/Playwright" >> "$REPORT"
  else
    say "FAIL  发现浏览器残留：$hits"; FAIL=$((FAIL+1)); echo "- ❌ 镜像内发现：$hits" >> "$REPORT"
  fi
}

authenticated_run_smoke() {
  if [ "${RUN_GENERATION_SMOKE:-0}" != "1" ]; then
    say "跳过真实生成烟测（默认关闭，避免未授权调用模型和消耗额度）"
    echo "- ⏭️ 真实生成烟测已跳过；如需执行，设置 RUN_GENERATION_SMOKE=1 并提供 VERIFY_COOKIE" >> "$REPORT"
    return 0
  fi
  if [ -z "${VERIFY_COOKIE:-}" ]; then
    say "FAIL  RUN_GENERATION_SMOKE=1 时必须提供 VERIFY_COOKIE"
    FAIL=$((FAIL+1)); echo "- ❌ 真实生成烟测缺少 VERIFY_COOKIE" >> "$REPORT"; return 1
  fi
  say "发起一次已授权真实生成烟测（可能消耗模型额度）"
  local run_id
  run_id=$(curl -fsS -X POST "http://127.0.0.1:${APP_PORT}/api/runs" \
    -H "Cookie: ${VERIFY_COOKIE}" \
    -H "content-type: application/json" \
    -d '{"topic":"部署验证：真实生成烟测"}' \
    | sed -nE 's/.*"runId":"([^"]+)".*/\1/p')
  if [ -z "$run_id" ]; then
    say "FAIL  创建运行失败"; FAIL=$((FAIL+1)); echo "- ❌ 创建运行失败" >> "$REPORT"; return 1
  fi
  local status=""
  for _ in $(seq 1 60); do
    status=$(curl -fsS "http://127.0.0.1:${APP_PORT}/api/runs/$run_id" \
      -H "Cookie: ${VERIFY_COOKIE}" | sed -nE 's/.*"status":"([a-z_]+)".*/\1/p')
    [ "$status" = "succeeded" ] && break
    [ "$status" = "failed" ] && break
    sleep 2
  done
  check "真实生成烟测完成（run=$run_id）" test "$status" = "succeeded"
  echo "$run_id" > /tmp/aai-verify-run-id
}

volume_persistence() {
  say "重启容器验证 /data 持久卷"
  "${COMPOSE[@]}" exec -T app \
    sh -c "mkdir -p /data/verify && printf '%s\\n' deployment-verify > /data/verify/marker" >/dev/null
  "${COMPOSE[@]}" restart app >/dev/null
  sleep 8
  check "重启后 /api/health 恢复" curl -fsS "http://127.0.0.1:${APP_PORT}/api/health"
  check "/data 持久卷重启后仍可写入" \
    "${COMPOSE[@]}" exec -T app sh -c "test -s /data/verify/marker"
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
    idle=$(docker stats --no-stream --format "{{.MemUsage}}" "$("${COMPOSE[@]}" ps -q app)" | awk '{print $1}')
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
  await_health || { "${COMPOSE[@]}" logs --tail 50 app; exit 1; }
  no_browser_assertion
  authenticated_run_smoke
  volume_persistence
  memory_baseline

  echo "" >> "$REPORT"
  echo "---" >> "$REPORT"
  echo "总计：$PASS 通过 / $FAIL 失败" >> "$REPORT"
  say "完成：$PASS 通过 / $FAIL 失败；报告：$REPORT"
  [ "$FAIL" -eq 0 ] || exit 1
}

main "$@"
